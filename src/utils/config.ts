import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import crypto from 'crypto';
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

export function loadDefaultApiKeyFromEnvOrSystem(): string {
  if (process.env.COMMANDCODE_API_KEY) {
    return process.env.COMMANDCODE_API_KEY.trim();
  }

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
    const sysKey = loadDefaultApiKeyFromEnvOrSystem();
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
    logger.error(`[CONFIG] Error saving config.json: ${err.message}`);
  }
}

export function getGatewayRunning(): boolean {
  return (globalThis as any).__GATEWAY_RUNNING__ !== false;
}

export function setGatewayRunning(running: boolean): void {
  (globalThis as any).__GATEWAY_RUNNING__ = running;
}

export function getActiveAccount(): AccountInfo | undefined {
  const config = loadConfig();
  return config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
}

export function getActiveApiKey(): string {
  const acc = getActiveAccount();
  return acc?.apiKey || loadDefaultApiKeyFromEnvOrSystem();
}

export function setActiveAccount(accountId: string): void {
  const config = loadConfig();
  const target = config.accounts.find(a => a.id === accountId);
  if (target) {
    saveConfigFile({ activeAccountId: accountId });
    logger.info(`[AUTH] Switched active account to: ${target.name} (${target.id})`);
  }
}

export function setRotationMode(mode: 'manual' | 'auto-quota'): void {
  saveConfigFile({ rotationMode: mode });
  logger.info(`[AUTH] Changed key rotation mode to: ${mode}`);
}

export async function checkAndRotateAccountsOnQuota(): Promise<void> {
  const config = loadConfig();
  if (config.rotationMode !== 'auto-quota' || config.accounts.length <= 1) {
    return;
  }

  const currentAcc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];
  if (!currentAcc || !currentAcc.apiKey) return;

  try {
    const stats = await fetchLiveUsageStats(currentAcc.apiKey, config.ccApiBase, config.ccVersion);
    const fhLimit = stats.credits?.windowLimits?.fiveHour;
    if (fhLimit && fhLimit.cap > 0) {
      const usageRatio = fhLimit.used / fhLimit.cap;
      logger.info(`[AUTO-QUOTA] Current active account '${currentAcc.name}' 5-Hour quota: ${(usageRatio * 100).toFixed(1)}% (${fhLimit.used.toFixed(2)} / ${fhLimit.cap.toFixed(2)})`);

      if (usageRatio >= 0.90) {
        logger.warn(`[AUTO-QUOTA] 5-Hour quota for '${currentAcc.name}' exceeded 90% threshold! Searching for alternate account...`);

        for (const altAcc of config.accounts) {
          if (altAcc.id !== currentAcc.id && altAcc.apiKey) {
            try {
              const altStats = await fetchLiveUsageStats(altAcc.apiKey, config.ccApiBase, config.ccVersion);
              const altFh = altStats.credits?.windowLimits?.fiveHour;
              const altRatio = (altFh && altFh.cap > 0) ? (altFh.used / altFh.cap) : 0;

              if (altRatio < 0.90) {
                logger.info(`[AUTO-QUOTA] Auto-switching active account to '${altAcc.name}' (${altAcc.id}) [Quota: ${(altRatio * 100).toFixed(1)}%]`);
                setActiveAccount(altAcc.id);
                return;
              }
            } catch {}
          }
        }
        logger.warn(`[AUTO-QUOTA] All registered accounts have exceeded 90% 5-Hour quota threshold.`);
      }
    }
  } catch (err: any) {
    logger.error(`[AUTO-QUOTA] Failed to check quota for auto-rotation: ${err.message}`);
  }
}

export async function loginNewAccount(apiKey: string, name?: string): Promise<AccountInfo> {
  const config = loadConfig();
  const cleanKey = apiKey.trim();

  const existing = config.accounts.find(a => a.apiKey === cleanKey);
  if (existing) {
    setActiveAccount(existing.id);
    return existing;
  }

  const profileStats = await fetchLiveUsageStats(cleanKey, config.ccApiBase, config.ccVersion);
  const who = profileStats.whoami?.user;

  const id = `acc_${crypto.randomBytes(4).toString('hex')}`;
  const accName = name || (who ? (who.name || who.userName ? `Command Code (${who.name || who.userName})` : undefined) : undefined) || `Account (${cleanKey.slice(-4)})`;

  const newAcc: AccountInfo = {
    id,
    name: accName,
    apiKey: cleanKey,
    userName: who?.userName,
    email: who?.email,
    userId: who?.id,
    addedAt: new Date().toISOString(),
  };

  const updatedAccounts = [...config.accounts, newAcc];
  saveConfigFile({
    accounts: updatedAccounts,
    activeAccountId: id,
  });

  logger.info(`[AUTH] Registered new account: ${accName} (${id})`);
  return newAcc;
}

export async function startBrowserLoginFlow(port = 5959): Promise<AccountInfo> {
  const config = loadConfig();
  const stateToken = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const callbackUrl = `http://localhost:${port}/callback`;

  const authUrl = `https://commandcode.ai/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const origin = req.headers.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
        if (reqUrl.pathname === '/callback') {
          let apiKey = reqUrl.searchParams.get('token') || reqUrl.searchParams.get('apiKey') || reqUrl.searchParams.get('key') || '';

          if (!apiKey && req.method === 'POST') {
            let bodyStr = '';
            req.on('data', chunk => { bodyStr += chunk; });
            await new Promise(r => req.on('end', r));
            try {
              const parsed = JSON.parse(bodyStr);
              apiKey = parsed.token || parsed.apiKey || parsed.key || '';
            } catch {}
          }

          if (apiKey) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head><title>CommandCode Auth Success</title></head>
                <body style="font-family: system-ui, sans-serif; background: #090d16; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                  <div style="text-align: center; background: #111827; padding: 2.5rem; border-radius: 1rem; border: 1px solid #1f2937; max-width: 400px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
                    <div style="font-size: 3rem; margin-bottom: 1rem;">⚡</div>
                    <h2 style="margin: 0 0 0.5rem 0; color: #6366f1;">Authentication Successful!</h2>
                    <p style="color: #9ca3af; font-size: 0.875rem; line-height: 1.5;">Your Command Code account has been added to the Proxy Gateway.</p>
                    <p style="color: #10b981; font-size: 0.75rem; margin-top: 1.5rem;">You can now close this tab and return to the controller.</p>
                  </div>
                  <script>setTimeout(() => window.close(), 3000);</script>
                </body>
              </html>
            `);

            try {
              const newAcc = await loginNewAccount(apiKey);
              server.close();
              resolve(newAcc);
            } catch (err: any) {
              server.close();
              reject(err);
            }
            return;
          }
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Auth error: ${err.message}`);
        server.close();
        reject(err);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    server.listen(port, () => {
      logger.info(`[AUTH] Browser login flow started. Opening URL: ${authUrl}`);
      openBrowser(authUrl);
    });

    server.on('error', (err) => {
      logger.error(`[AUTH] Callback server error: ${err.message}`);
      reject(err);
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Browser login timed out after 3 minutes.'));
    }, 180000);
  });
}

export function logoutAccount(accountId: string): boolean {
  const config = loadConfig();
  const updatedAccounts = config.accounts.filter(a => a.id !== accountId);
  let newActiveId = config.activeAccountId;

  if (newActiveId === accountId) {
    newActiveId = updatedAccounts.length > 0 ? updatedAccounts[0].id : '';
  }

  saveConfigFile({
    accounts: updatedAccounts,
    activeAccountId: newActiveId,
  });

  logger.info(`[AUTH] Removed account '${accountId}'`);
  return true;
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

export function openBrowser(url: string): void {
  const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${startCmd} ${url}`, (err) => {
    if (err) logger.warn(`[BROWSER] Could not auto-open browser URL: ${err.message}`);
  });
}
