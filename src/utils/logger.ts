export interface MemoryLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 200;
const memoryLogs: MemoryLogEntry[] = [];

export function addMemoryLog(level: 'info' | 'warn' | 'error', message: string): void {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  memoryLogs.push({ timestamp, level, message });
  if (memoryLogs.length > MAX_LOGS) {
    memoryLogs.shift();
  }
}

export function getMemoryLogs(): MemoryLogEntry[] {
  return [...memoryLogs];
}

export function clearMemoryLogs(): void {
  memoryLogs.length = 0;
}

export const logger = {
  info: (msg: string) => {
    console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] INFO: ${msg}`);
    addMemoryLog('info', msg);
  },
  warn: (msg: string) => {
    console.warn(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] WARN: ${msg}`);
    addMemoryLog('warn', msg);
  },
  error: (msg: string) => {
    console.error(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ERROR: ${msg}`);
    addMemoryLog('error', msg);
  },
};
