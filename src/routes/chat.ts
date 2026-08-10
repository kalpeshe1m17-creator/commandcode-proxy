import { FastifyInstance } from 'fastify';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC, isAbortError } from '../adapters/commandcode/upstream.js';
import { OpenAIChatRequest, CCEvent } from '../types/index.js';
import { getActiveApiKey, getGatewayRunning } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { createInterface } from 'readline';

export async function chatRoutes(fastify: FastifyInstance) {
  const adapter = new CommandCodeAdapter();

  fastify.post('/v1/chat/completions', async (req, reply) => {
    if (!getGatewayRunning()) {
      return reply.status(503).send({
        error: {
          message: 'CommandCode Gateway Engine is currently PAUSED. Please enable it on the dashboard.',
          type: 'service_unavailable',
          code: 503,
        },
      });
    }

    const body = req.body as OpenAIChatRequest;
    if (!body || !body.messages) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request: messages field is required',
          type: 'invalid_request_error',
          code: 400,
        },
      });
    }

    const apiKey = getActiveApiKey();
    if (!apiKey) {
      return reply.status(401).send({
        error: {
          message: 'No active Command Code API Key found. Please add an account or API key in the gateway dashboard.',
          type: 'invalid_request_error',
          code: 401,
        },
      });
    }

    // Harden TCP socket for long multi-minute reasoning sessions
    req.raw.setTimeout(0);
    if (req.raw.socket) {
      req.raw.socket.setTimeout(0);
      req.raw.socket.setKeepAlive(true, 10000);
      req.raw.socket.setNoDelay(true);
    }

    const startTime = Date.now();
    const abortController = new AbortController();

    // Cancel upstream ONLY if client prematurely disconnects before response is finished (v2 pattern)
    req.raw.on('close', () => {
      if (!reply.raw.writableEnded && req.raw.destroyed && !req.raw.complete) {
        abortController.abort();
      }
    });

    const translated = adapter.translateOpenAIRequest(body);
    const modelName = translated.params.model;

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, apiKey, abortController.signal);
      } catch (err: any) {
        // Silently drop client-cancelled requests
        if (isAbortError(err) || (err as any)?.isAbort) {
          return reply.raw.end();
        }
        if (body.stream) {
          reply.raw.setHeader('Content-Type', 'text/event-stream');
          reply.raw.setHeader('Cache-Control', 'no-cache');
          reply.raw.setHeader('Connection', 'keep-alive');

          const state = adapter.createStreamEncoderState();
          const errChunks = adapter.encodeOpenAIChunk(
            { type: 'error', error: { message: err.message || 'Upstream service error' } },
            state,
            modelName
          );
          for (const c of errChunks) reply.raw.write(c);
          const finishChunks = adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state, modelName);
          for (const c of finishChunks) reply.raw.write(c);
          return reply.raw.end();
        } else {
          return reply.status(502).send({
            error: { message: `Upstream connection error: ${err.message}`, type: 'upstream_error', code: 502 },
          });
        }
      }

      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-Accel-Buffering', 'no');

        const state = adapter.createStreamEncoderState();
        const initialChunks = adapter.encodeOpenAIChunk({ type: 'start' }, state, modelName);
        for (const c of initialChunks) reply.raw.write(c);

        // SSE Keep-Alive Ping every 15s to prevent Cloudflare/Proxy timeout drops
        const pingInterval = setInterval(() => {
          if (!reply.raw.writableEnded) {
            reply.raw.write(':\n\n');
          }
        }, 15000);

        const cleanupPings = () => {
          clearInterval(pingInterval);
        };

        const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });

        rl.on('line', (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;

          let jsonStr = trimmed;
          if (trimmed.startsWith('data:')) {
            jsonStr = trimmed.slice(5).trim();
          }
          if (jsonStr === '[DONE]') {
            return;
          }

          try {
            const event: CCEvent = JSON.parse(jsonStr);
            const chunks = adapter.encodeOpenAIChunk(event, state, modelName);
            for (const c of chunks) {
              reply.raw.write(c);
            }
          } catch (err: any) {
            logger.warn(`[CHAT] Error parsing event line: ${err.message}`);
          }
        });

        rl.on('close', () => {
          cleanupPings();
          if (!state.sawFinish) {
            const finishChunks = adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state, modelName);
            for (const c of finishChunks) reply.raw.write(c);
          }
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          logger.info(`[OUTPUT] Model: ${modelName} | Status: 200 OK | Duration: ${duration}s`);
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          // Silently swallow AbortErrors — these are normal client cancellations
          if (isAbortError(err) || (err as any)?.isAbort) {
            cleanupPings();
            reply.raw.end();
            return;
          }
          cleanupPings();
          logger.error(`[OUTPUT] Model: ${modelName} | Upstream Stream Error: ${err.message}`);
          if (!state.sawFinish) {
            const finishChunks = adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state, modelName);
            for (const c of finishChunks) reply.raw.write(c);
          }
          reply.raw.end();
        });

        return reply;
      } else {
        let fullText = '';
        let reasoningContent = '';
        const toolCallsMap = new Map<string, any>();
        let finishReason = 'stop';

        const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });

        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let jsonStr = trimmed;
          if (trimmed.startsWith('data:')) jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const event: CCEvent = JSON.parse(jsonStr);
            if (event.type === 'error' && event.error && event.error.message && event.error.message !== 'unknown') {
              fullText += `\n[Upstream Error: ${event.error.message}]\n`;
            }
            if (event.type === 'text-delta') {
              const txt = event.text || event.data?.text;
              if (txt) fullText += txt;
            }
            if (event.type === 'reasoning-delta') {
              const txt = event.text || event.data?.text;
              if (txt) reasoningContent += txt;
            }
            if (event.type === 'tool-call-delta' || event.type === 'tool-call') {
              const tcId = (event.data?.toolCallId as string) || (event.toolCallId as string) || 'call_1';
              const name = (event.data?.toolName as string) || (event.toolName as string) || (event.data?.name as string) || (event.name as string) || 'tool';
              const input = event.data?.input || event.input || event.data?.arguments || event.arguments;
              toolCallsMap.set(tcId, {
                id: tcId,
                type: 'function',
                function: {
                  name,
                  arguments: typeof input === 'string' ? input : JSON.stringify(input || {}),
                },
              });
            }
            if (event.type === 'finish' || event.type === 'finish-step') {
              if (event.finishReason || event.data?.finishReason) {
                finishReason = event.finishReason || event.data?.finishReason;
              }
            }
          } catch {}
        }

        const choiceMessage: any = {
          role: 'assistant',
          content: fullText || null,
        };

        if (reasoningContent) choiceMessage.reasoning_content = reasoningContent;
        if (toolCallsMap.size > 0) {
          choiceMessage.tool_calls = Array.from(toolCallsMap.values());
          finishReason = 'tool_calls';
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`[OUTPUT] Model: ${modelName} | Status: 200 OK | Duration: ${duration}s`);

        return reply.send({
          id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            {
              index: 0,
              message: choiceMessage,
              finish_reason: finishReason,
            },
          ],
        });
      }
    } catch (err: any) {
      if (isAbortError(err) || (err as any)?.isAbort) {
        return reply.raw.end();
      }
      logger.error(`[CHAT] Fatal request error: ${err.message}`);
      return reply.status(502).send({
        error: { message: `Internal proxy error: ${err.message}`, type: 'internal_error', code: 502 },
      });
    }
  });
}
