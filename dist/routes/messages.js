import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC } from '../adapters/commandcode/upstream.js';
import { getActiveApiKey, getGatewayRunning } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { createInterface } from 'readline';
export async function messagesRoutes(fastify) {
    const adapter = new CommandCodeAdapter();
    fastify.post('/v1/messages', async (req, reply) => {
        if (!getGatewayRunning()) {
            return reply.status(503).send({
                error: { message: 'Gateway PAUSED', type: 'service_unavailable' },
            });
        }
        const body = req.body;
        const apiKey = getActiveApiKey();
        if (!apiKey) {
            return reply.status(401).send({ error: { message: 'No API Key' } });
        }
        req.raw.setTimeout(0);
        const translated = adapter.translateAnthropicRequest(body);
        const modelName = translated.params.model;
        try {
            const upstreamStream = await sendToCC(translated, apiKey);
            if (body.stream) {
                reply.raw.setHeader('Content-Type', 'text/event-stream');
                reply.raw.setHeader('Cache-Control', 'no-cache');
                reply.raw.setHeader('Connection', 'keep-alive');
                reply.raw.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', content: [], model: modelName, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
                const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
                rl.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]')
                        return;
                    let jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
                    try {
                        const event = JSON.parse(jsonStr);
                        if (event.type === 'text-delta' && event.text) {
                            reply.raw.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.text } })}\n\n`);
                        }
                    }
                    catch { }
                });
                rl.on('close', () => {
                    reply.raw.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                    reply.raw.end();
                });
                return reply;
            }
            else {
                let fullText = '';
                const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
                for await (const line of rl) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]')
                        continue;
                    let jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
                    try {
                        const event = JSON.parse(jsonStr);
                        if (event.type === 'text-delta' && event.text)
                            fullText += event.text;
                    }
                    catch { }
                }
                return reply.send({
                    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'text', text: fullText }],
                    model: modelName,
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 0, output_tokens: 0 },
                });
            }
        }
        catch (err) {
            logger.error(`[MESSAGES] Request failed: ${err.message}`);
            return reply.status(502).send({ error: { message: err.message } });
        }
    });
}
