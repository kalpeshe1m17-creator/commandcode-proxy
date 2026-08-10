import Fastify from 'fastify';
import { loadConfig, openBrowser, getActiveApiKey } from './utils/config.js';
import { fetchUpstreamModels } from './utils/models.js';
import { logger } from './utils/logger.js';
import { chatRoutes } from './routes/chat.js';
import { messagesRoutes } from './routes/messages.js';
import { modelsRoutes } from './routes/models.js';
import { dashboardRoutes } from './routes/dashboard.js';
process.on('uncaughtException', (err) => {
    logger.error(`[CRITICAL] Uncaught Exception: ${err.message}`);
    console.error('\n[ERROR] CommandCode Proxy v3 encountered a critical error:');
    console.error(err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
    logger.error(`[CRITICAL] Unhandled Rejection: ${reason?.message || reason}`);
});
const config = loadConfig();
const fastify = Fastify({
    logger: false,
    trustProxy: true,
});
const start = async () => {
    try {
        await fastify.register(dashboardRoutes);
        await fastify.register(chatRoutes);
        await fastify.register(messagesRoutes);
        await fastify.register(modelsRoutes);
        fastify.get('/health', async () => {
            return { status: 'ok', version: '3.0.0', time: new Date().toISOString() };
        });
        logger.info('[BOOT] Initializing CommandCode Proxy v3...');
        const activeApiKey = getActiveApiKey();
        if (activeApiKey) {
            fetchUpstreamModels(activeApiKey, config.ccVersion).catch(err => {
                logger.warn(`[BOOT] Model fetch background warning: ${err.message}`);
            });
        }
        await fastify.listen({ port: config.port, host: '0.0.0.0' });
        const dashboardUrl = `http://localhost:${config.port}/`;
        console.log('\n=============================================================');
        console.log('  ⚡ CommandCode OpenAI Proxy v3 is ACTIVE');
        console.log(`  🌐 Controller GUI:          ${dashboardUrl}`);
        console.log(`  🤖 OpenAI Chat Completions: ${dashboardUrl}v1/chat/completions`);
        console.log(`  💬 Anthropic Messages:     ${dashboardUrl}v1/messages`);
        console.log('=============================================================\n');
        logger.info(`[SERVER] CommandCode Proxy v3 running on ${dashboardUrl}`);
        if (process.env.NODE_ENV !== 'test' && !process.env.NO_OPEN_BROWSER) {
            openBrowser(dashboardUrl);
        }
    }
    catch (err) {
        logger.error(`[SERVER] Error starting server: ${err.message}`);
        console.error(`\n[SERVER] Startup error: ${err.message}`);
    }
};
start();
