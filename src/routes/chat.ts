import { FastifyInstance } from 'fastify';
import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC } from '../adapters/commandcode/upstream.js';
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

    req.raw.setTimeout(0);

    const translated = adapter.translateOpenAIRequest(body);
    const modelName = translated.params.model;

    try {
      let upstreamStream: any;
      try {
        upstreamStream = await sendToCC(translated, apiKey);
      } catch (err: any) {
        logger.error(`[CHAT] Upstream fetch failed: ${err.message}`);

        if (body.stream) {
          reply.raw.setHeader('Content-Type', 'text/event-stream');
          reply.raw.setHeader('Cache-Control', 'no-cache');
          reply.raw.setHeader('Connection', 'keep-alive');

          const state = adapter.createStreamEncoderState();
          const errChunks = adapter.encodeOpenAIChunk(
            { type: 'error', error: { message: err.message } },
            state,
            modelName
          );
          for (const c of errChunks) reply.raw.write(c);

          const finishChunks = adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state, modelName);
          for (const c of finishChunks) reply.raw.write(c);
          return reply.raw.end();
        } else {
          return reply.status(502).send({
            error: {
              message: `Upstream connection error: ${err.message}`,
              type: 'upstream_error',
              code: 502,
            },
          });
        }
      }

      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');

        const state = adapter.createStreamEncoderState();
        const initialChunks = adapter.encodeOpenAIChunk({ type: 'start' }, state, modelName);
        for (const c of initialChunks) reply.raw.write(c);

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
          if (!state.sawFinish) {
            const finishChunks = adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state, modelName);
            for (const c of finishChunks) reply.raw.write(c);
          }
          reply.raw.end();
        });

        upstreamStream.on('error', (err: any) => {
          logger.error(`[CHAT] Upstream stream error: ${err.message}`);
          const errChunks = adapter.encodeOpenAIChunk({ type: 'error', error: { message: err.message } }, state, modelName);
          for (const c of errChunks) reply.raw.write(c);
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
            if (event.type === 'error' && event.error) {
              fullText += `\n[Upstream Error: ${event.error.message || JSON.stringify(event.error)}]\n`;
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
      logger.error(`[CHAT] Fatal request error: ${err.message}`);
      return reply.status(502).send({
        error: {
          message: `Internal proxy error: ${err.message}`,
          type: 'internal_error',
          code: 502,
        },
      });
    }
  });
}
