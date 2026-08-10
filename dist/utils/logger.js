const MAX_LOGS = 200;
const memoryLogs = [];
export function addMemoryLog(level, message) {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    memoryLogs.push({ timestamp, level, message });
    if (memoryLogs.length > MAX_LOGS) {
        memoryLogs.shift();
    }
}
export function getMemoryLogs() {
    return [...memoryLogs];
}
export function clearMemoryLogs() {
    memoryLogs.length = 0;
}
export const logger = {
    info: (msg) => {
        console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] INFO: ${msg}`);
        addMemoryLog('info', msg);
    },
    warn: (msg) => {
        console.warn(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] WARN: ${msg}`);
        addMemoryLog('warn', msg);
    },
    error: (msg) => {
        console.error(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ERROR: ${msg}`);
        addMemoryLog('error', msg);
    },
};
