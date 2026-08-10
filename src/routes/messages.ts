import { FastifyInstance } from 'fastify';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError } from '../adapters/commandcode/upstream.js';
import { AnthropicRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { createInterface } from 'readline';
import crypto from 'node:crypto';

export async function messagesRoutes(fastify: FastifyInstance) {
  const adapter = new CommandCodeAdapter();

  fastify.post('/v1/messages', async (req, reply) => {
    if (!getGatewayRunning()) {
      return reply.status(503).send({
        error: { message: 'Gateway PAUSED', type: 'service_unavailable' },
      });
    }

    const body = req.body as AnthropicRequest;
    const apiKey = getActiveApiKey();
    if (!apiKey) {
      return reply.status(401).send({ error: { message: 'No API Key' } });
    }

    // Harden TCP socket for long multi-minute reasoning sessions
    req.raw.setTimeout(0);
    if (req.raw.socket) {
      req.raw.socket.setTimeout(0);
      req.raw.socket.setKeepAlive(true, 10000);
      req.raw.socket.setNoDelay(true);
    }

    // Cancel upstream ONLY if client prematurely disconnects before response is finished (v2 pattern)
    const abortController = new AbortController();
    req.raw.on('close', () => {
      if (!reply.raw.writableEnded && req.raw.destroyed && !req.raw.complete) {
        abortController.abort();
      }
    });

    const startTime = Date.now();
    const translated = adapter.translateAnthropicRequest(body);
    const modelName = translated.params.model;
    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, apiKey, abortController.signal);
      } catch (err: any) {
        if (isAbortError(err) || (err as any)?.isAbort) return reply.raw.end();
        return reply.status(502).send({ error: { message: err.message, type: 'upstream_error' } });
      }

      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');

        reply.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: modelName, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        reply.raw.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);

        // SSE keep-alive ping every 15s to prevent proxy/CDN timeout drops
        const pingInterval = setInterval(() => {
          if (!reply.raw.writableEnded) reply.raw.write(':\n\n');
        }, 15000);

        const cleanupPings = () => clearInterval(pingInterval);

        let textBlockOpen = true;
        let thinkingBlockOpen = false;
        let toolBlockIndex = 0;

        const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });

        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') return;
          const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;

          try {
            const event: CCEvent = JSON.parse(jsonStr);

            if (event.type === 'text-delta') {
              const text = event.text || event.data?.text;
              if (text) {
                reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
              }
            }

            if (event.type === 'reasoning-delta') {
              const text = event.text || event.data?.text;
              if (text) {
                if (!thinkingBlockOpen) {
                  thinkingBlockOpen = true;
                  reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } })}\n\n`);
                }
                reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: text } })}\n\n`);
              }
            }

            if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
              const toolCallId = (event.data?.toolCallId as string) || (event.toolCallId as string) || `toolu_${crypto.randomUUID().slice(0, 8)}`;
              const toolName = (event.data?.toolName as string) || (event.toolName as string) || 'tool';
              const input = event.data?.input || event.input || {};
              reply.raw.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 2 + toolBlockIndex, content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} } })}\n\n`);
              reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 2 + toolBlockIndex, delta: { type: 'input_json_delta', partial_json: typeof input === 'string' ? input : JSON.stringify(input) } })}\n\n`);
              reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 2 + toolBlockIndex })}\n\n`);
              toolBlockIndex++;
            }
          } catch {}
        });

        rl.on('close', () => {
          cleanupPings();
          if (textBlockOpen) {
            reply.raw.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          }
          const stopReason = toolBlockIndex > 0 ? 'tool_use' : 'end_turn';
          reply.raw.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          logger.info(`[OUTPUT] Model: ${modelName} | Status: 200 OK | Duration: ${duration}s`);
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          if (isAbortError(err) || (err as any)?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[MESSAGES] Upstream stream error: ${err.message}`);
          reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          reply.raw.end();
        });

        return reply;
      } else {
        let fullText = '';
        let reasoningText = '';
        const toolCalls: any[] = [];
        const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });

        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
          try {
            const event: CCEvent = JSON.parse(jsonStr);
            if (event.type === 'text-delta') {
              const txt = event.text || event.data?.text;
              if (txt) fullText += txt;
            }
            if (event.type === 'reasoning-delta') {
              const txt = event.text || event.data?.text;
              if (txt) reasoningText += txt;
            }
            if (event.type === 'tool-call' || event.type === 'tool-call-delta') {
              const toolCallId = (event.data?.toolCallId as string) || (event.toolCallId as string) || `toolu_${crypto.randomUUID().slice(0, 8)}`;
              const toolName = (event.data?.toolName as string) || (event.toolName as string) || 'tool';
              const input = event.data?.input || event.input || {};
              toolCalls.push({ type: 'tool_use', id: toolCallId, name: toolName, input });
            }
          } catch {}
        }

        const content: any[] = [];
        if (reasoningText) content.push({ type: 'thinking', thinking: reasoningText });
        if (fullText) content.push({ type: 'text', text: fullText });
        if (toolCalls.length > 0) content.push(...toolCalls);
        if (content.length === 0) content.push({ type: 'text', text: '' });

        const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`[OUTPUT] Model: ${modelName} | Status: 200 OK | Duration: ${duration}s`);

        return reply.send({
          id: msgId,
          type: 'message',
          role: 'assistant',
          content,
          model: modelName,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }
    } catch (err: any) {
      logger.error(`[MESSAGES] Request failed: ${err.message}`);
      return reply.status(502).send({ error: { message: err.message } });
    }
  });
}
