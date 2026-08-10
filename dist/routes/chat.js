import { CommandCodeAdapter } from '../adapters/commandcode/adapter.js';
import { sendToCC } from '../adapters/commandcode/upstream.js';
import { getActiveApiKey, getGatewayRunning } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { createInterface } from 'readline';
export async function chatRoutes(fastify) {
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
        const body = req.body;
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
            const upstreamStream = await sendToCC(translated, apiKey);
            if (body.stream) {
                reply.raw.setHeader('Content-Type', 'text/event-stream');
                reply.raw.setHeader('Cache-Control', 'no-cache');
                reply.raw.setHeader('Connection', 'keep-alive');
                const state = adapter.createStreamEncoderState();
                const initialChunks = adapter.encodeOpenAIChunk({ type: 'start' }, state, modelName);
                for (const c of initialChunks)
                    reply.raw.write(c);
                const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
                rl.on('line', (line) => {
                    const trimmed = line.trim();
                    if (!trimmed)
                        return;
                    let jsonStr = trimmed;
                    if (trimmed.startsWith('data:')) {
                        jsonStr = trimmed.slice(5).trim();
                    }
                    if (jsonStr === '[DONE]') {
                        return;
                    }
                    try {
                        const event = JSON.parse(jsonStr);
                        const chunks = adapter.encodeOpenAIChunk(event, state, modelName);
                        for (const c of chunks) {
                            reply.raw.write(c);
                        }
                    }
                    catch (err) {
                        logger.warn(`[CHAT] Error parsing event line: ${err.message}`);
                    }
                });
                rl.on('close', () => {
                    if (!state.sawFinish) {
                        const finishChunks = adapter.encodeOpenAIChunk({ type: 'finish', finishReason: 'stop' }, state, modelName);
                        for (const c of finishChunks)
                            reply.raw.write(c);
                    }
                    reply.raw.end();
                });
                upstreamStream.on('error', (err) => {
                    logger.error(`[CHAT] Upstream stream error: ${err.message}`);
                    reply.raw.end();
                });
                return reply;
            }
            else {
                let fullText = '';
                let reasoningContent = '';
                const toolCallsMap = new Map();
                let finishReason = 'stop';
                const rl = createInterface({ input: upstreamStream, crlfDelay: Infinity });
                for await (const line of rl) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    let jsonStr = trimmed;
                    if (trimmed.startsWith('data:'))
                        jsonStr = trimmed.slice(5).trim();
                    if (jsonStr === '[DONE]')
                        continue;
                    try {
                        const event = JSON.parse(jsonStr);
                        if (event.type === 'text-delta' && event.text)
                            fullText += event.text;
                        if (event.type === 'reasoning-delta' && event.text)
                            reasoningContent += event.text;
                        if (event.type === 'tool-call-delta' || event.type === 'tool-call') {
                            const tcId = event.toolCallId || 'call_1';
                            toolCallsMap.set(tcId, {
                                id: tcId,
                                type: 'function',
                                function: {
                                    name: event.toolName || event.name || 'tool',
                                    arguments: typeof event.arguments === 'string' ? event.arguments : JSON.stringify(event.input || {}),
                                },
                            });
                        }
                        if (event.type === 'finish') {
                            if (event.finishReason)
                                finishReason = event.finishReason;
                        }
                    }
                    catch { }
                }
                const choiceMessage = {
                    role: 'assistant',
                    content: fullText || null,
                };
                if (reasoningContent)
                    choiceMessage.reasoning_content = reasoningContent;
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
        }
        catch (err) {
            logger.error(`[CHAT] Request failed: ${err.message}`);
            return reply.status(502).send({
                error: {
                    message: `Upstream processing error: ${err.message}`,
                    type: 'upstream_error',
                    code: 502,
                },
            });
        }
    });
}
