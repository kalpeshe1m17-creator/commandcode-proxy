import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { GatewayConfig, GatewayConfigFile, AccountInfo } from '../types/index.js';
import { logger } from './logger.js';

function getProjectRootDir(): string {
  if (process.execPath.toLowerCase().includes('commandcode-proxy-v3') || (process as any).pkg) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

export const CONFIG_FILE_PATH = path.join(getProjectRootDir(), 'config.json');
const ENV_FILE_PATH = path.join(getProjectRootDir(), '.env');

const DEFAULT_ENDPOINTS: Record<string, string> = {
  chatCompletions: '/v1/chat/completions',
  messages: '/v1/messages',
  models: '/v1/models',
  health: '/health',
};

let gatewayRunning = true;

export function getGatewayRunning(): boolean {
  return gatewayRunning;
}

export function setGatewayRunning(state: boolean): void {
  gatewayRunning = state;
}

export function getCliAuthKey(): string {
  try {
    const authFile = path.join(os.homedir(), '.commandcode', 'auth.json');
    if (fs.existsSync(authFile)) {
      const content = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      if (content.apiKey || content.token) {
        return content.apiKey || content.token;
      }
    }
  } catch (err: any) {
    logger.warn(`[CONFIG] Could not read ~/.commandcode/auth.json: ${err.message}`);
  }
  return '';
}

export function loadConfig(): GatewayConfig {
  let fileConfig: Partial<GatewayConfigFile> = {};
  if (fs.existsSync(CONFIG_FILE_PATH)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
    } catch (err: any) {
      logger.error(`[CONFIG] Error reading config.json: ${err.message}`);
    }
  }

  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  const port = envPort || fileConfig.port || 9090;

  const ccApiBase = process.env.COMMANDCODE_API_BASE || fileConfig.upstream?.apiBase || 'https://api.commandcode.ai';
  const ccVersion = process.env.COMMANDCODE_VERSION || fileConfig.upstream?.ccVersion || '1.4.1';
  const rotationMode = process.env.ROTATION_MODE || fileConfig.rotationMode || 'manual';
  const permissionMode = fileConfig.permissionMode || 'auto-accept';

  let accounts: AccountInfo[] = fileConfig.accounts || [];

  if (accounts.length === 0) {
    const sysKey = getCliAuthKey() || process.env.COMMANDCODE_API_KEY || '';
    if (sysKey) {
      accounts.push({
        id: 'acc_default',
        name: 'Default System Account',
        apiKey: sysKey,
        addedAt: new Date().toISOString(),
      });
    }
  }

  let activeAccountId = fileConfig.activeAccountId || (accounts.length > 0 ? accounts[0].id : '');

  if (activeAccountId && !accounts.some(a => a.id === activeAccountId) && accounts.length > 0) {
    activeAccountId = accounts[0].id;
  }

  return {
    port,
    ccApiBase,
    ccVersion,
    rotationMode,
    permissionMode,
    activeAccountId,
    accounts,
    upstreamTimeoutMs: fileConfig.upstream?.timeoutMs || 600000,
    idleTimeoutMs: fileConfig.upstream?.idleTimeoutMs || 120000,
    endpoints: { ...DEFAULT_ENDPOINTS, ...fileConfig.endpoints },
  };
}

export function saveConfigFile(updates: Partial<GatewayConfigFile>): void {
  try {
    let current: Partial<GatewayConfigFile> = {};
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      try {
        current = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
      } catch {}
    }

    const updated: GatewayConfigFile = {
      port: updates.port ?? current.port ?? 9090,
      activeAccountId: updates.activeAccountId ?? current.activeAccountId ?? '',
      rotationMode: updates.rotationMode ?? current.rotationMode ?? 'manual',
      permissionMode: updates.permissionMode ?? current.permissionMode ?? 'auto-accept',
      accounts: updates.accounts ?? current.accounts ?? [],
      upstream: {
        apiBase: updates.upstream?.apiBase ?? current.upstream?.apiBase ?? 'https://api.commandcode.ai',
        ccVersion: updates.upstream?.ccVersion ?? current.upstream?.ccVersion ?? '1.4.1',
        timeoutMs: updates.upstream?.timeoutMs ?? current.upstream?.timeoutMs ?? 600000,
        idleTimeoutMs: updates.upstream?.idleTimeoutMs ?? current.upstream?.idleTimeoutMs ?? 120000,
      },
      endpoints: { ...DEFAULT_ENDPOINTS, ...current.endpoints, ...updates.endpoints },
    };

    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(updated, null, 2), 'utf-8');

    const safeAccs = updated.accounts || [];
    const activeAcc = safeAccs.find(a => a.id === updated.activeAccountId);
    if (activeAcc && activeAcc.apiKey) {
      syncEnvFile(safeAccs, activeAcc.apiKey);
    }
  } catch (err: any) {
    logger.error(`[CONFIG] Failed to save config.json: ${err.message}`);
  }
}

export function syncEnvFile(accounts: AccountInfo[], activeApiKey: string): void {
  try {
    const envLines = [
      `COMMANDCODE_API_KEY=${activeApiKey}`,
      `COMMANDCODE_API_BASE=https://api.commandcode.ai`,
      `COMMANDCODE_VERSION=1.4.1`,
      `ACCOUNTS_COUNT=${accounts.length}`,
      `UPDATED_AT=${new Date().toISOString()}`,
    ];
    fs.writeFileSync(ENV_FILE_PATH, envLines.join('\n'), 'utf-8');
  } catch (err: any) {
    logger.warn(`[CONFIG] Could not sync .env file: ${err.message}`);
  }
}

export function getActiveApiKey(): string {
  const config = loadConfig();
  if (config.accounts.length > 0) {
    const active = config.accounts.find(a => a.id === config.activeAccountId);
    if (active && active.apiKey) return active.apiKey;
    if (config.accounts[0].apiKey) return config.accounts[0].apiKey;
  }
  return getCliAuthKey();
}

export function setActiveAccount(accountId: string): boolean {
  const config = loadConfig();
  const acc = config.accounts.find(a => a.id === accountId);
  if (!acc) return false;

  saveConfigFile({ activeAccountId: accountId });
  logger.info(`[CONFIG] Active account switched to '${acc.name}' (${acc.id})`);
  return true;
}

export function setRotationMode(mode: string): void {
  saveConfigFile({ rotationMode: mode });
  logger.info(`[CONFIG] Rotation strategy set to '${mode}'`);
}

export async function fetchLiveUsageStats(apiKey: string, ccApiBase: string, ccVersion: string): Promise<any> {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'cli',
    'x-cli-environment': 'cli',
    'x-command-code-version': ccVersion,
  };

  const results: any = { whoami: null, credits: null, summary: null };

  try {
    const resWho = await fetch(`${ccApiBase}/whoami`, { headers });
    if (resWho.ok) results.whoami = await resWho.json();
  } catch {}

  try {
    const resCred = await fetch(`${ccApiBase}/credits`, { headers });
    if (resCred.ok) results.credits = await resCred.json();
  } catch {}

  try {
    const resSum = await fetch(`${ccApiBase}/usage/summary`, { headers });
    if (resSum.ok) results.summary = await resSum.json();
  } catch {}

  return results;
}

export async function checkAndRotateAccountsOnQuota(): Promise<void> {
  const config = loadConfig();
  if (config.rotationMode !== 'auto-quota') return;
  if (config.accounts.length <= 1) return;

  const currentAccIndex = config.accounts.findIndex(a => a.id === config.activeAccountId);
  const activeAcc = currentAccIndex !== -1 ? config.accounts[currentAccIndex] : config.accounts[0];

  if (!activeAcc.apiKey) return;

  try {
    const stats = await fetchLiveUsageStats(activeAcc.apiKey, config.ccApiBase, config.ccVersion);
    const window5h = stats?.credits?.windowLimits?.fiveHour;
    if (window5h) {
      const usageRatio = window5h.cap > 0 ? (window5h.used / window5h.cap) : 0;
      if (window5h.exceeded || usageRatio >= 0.90) {
        logger.warn(`[AUTO-QUOTA] Account '${activeAcc.name}' 5-Hour usage is at ${(usageRatio * 100).toFixed(1)}%. Triggering account rotation...`);
        const nextIndex = (currentAccIndex + 1) % config.accounts.length;
        const nextAcc = config.accounts[nextIndex];
        setActiveAccount(nextAcc.id);
        logger.info(`[AUTO-QUOTA] Rotated active account to '${nextAcc.name}' (${nextAcc.id})`);
      }
    }
  } catch (err: any) {
    logger.warn(`[AUTO-QUOTA] Error checking 5-Hour quota: ${err.message}`);
  }
}

export function openBrowser(url: string): void {
  const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${startCmd} ${url}`, (err) => {
    if (err) logger.warn(`[BROWSER] Could not auto-open browser URL: ${err.message}`);
  });
}
