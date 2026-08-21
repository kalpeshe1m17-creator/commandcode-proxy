import { FastifyInstance } from 'fastify';
import { logger } from '../utils/logger.js';
import {
  loadConfig,
  getGatewayRunning,
  setGatewayRunning,
  loginNewAccount,
  startBrowserLoginFlow,
  logoutAccount,
  setActiveAccount,
  setRotationMode,
  fetchLiveUsageStats,
  getActiveApiKey,
} from '../utils/config.js';
import { getCachedModels } from '../utils/models.js';

const startTimestamp = Date.now();

/** Escape HTML — every dynamic value rendered into the SPA must pass through this. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function dashboardRoutes(fastify: FastifyInstance) {
  // CORS ONLY for the public API surface (/v1/*). Admin /api/* routes get no
  // CORS headers, so a random webpage in your browser cannot drive them.
  fastify.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/') || req.url === '/health') {
      reply.header('Access-Control-Allow-Origin', '*');
    }
  });
  fastify.options('/v1/*', async (_req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version')
      .status(204)
      .send();
  });

  fastify.get('/api/status', async () => {
    const config = loadConfig();
    const uptimeSec = Math.floor((Date.now() - startTimestamp) / 1000);
    const hrs = Math.floor(uptimeSec / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const secs = uptimeSec % 60;
    const activeAcc = config.accounts.find(a => a.id === config.activeAccountId) || config.accounts[0];

    return {
      status: 'active',
      running: getGatewayRunning(),
      uptime: `${hrs}h ${mins}m ${secs}s`,
      port: config.port,
      host: config.host,
      apiBase: config.ccApiBase,
      cliVersion: config.ccVersion,
      rotationMode: config.rotationMode,
      activeAccountId: config.activeAccountId || activeAcc?.id || '',
      activeAccountName: activeAcc?.name || 'None',
      accountsCount: config.accounts.length,
      hasApiKey: !!getActiveApiKey(),
      modelsCount: getCachedModels().length,
      authRequired: !!process.env.PROXY_API_KEY,
    };
  });

  fastify.post('/api/gateway/toggle', async (req: any) => {
    const body = req.body || {};
    if (body.running !== undefined) {
      setGatewayRunning(body.running);
      logger.info(`[DASHBOARD] Gateway engine toggled: ${body.running ? 'STARTED' : 'STOPPED'}`);
    }
    return { status: 'success', running: getGatewayRunning() };
  });

  fastify.get('/api/logs', async () => ({ logs: logger.getLogs() }));

  fastify.post('/api/logs/clear', async () => {
    logger.clearLogs();
    logger.info('[DASHBOARD] Log console cleared.');
    return { status: 'success' };
  });

  fastify.get('/api/accounts', async () => {
    const config = loadConfig();
    const safeAccounts = config.accounts.map(a => ({
      id: a.id,
      name: a.name,
      userName: a.userName,
      email: a.email,
      addedAt: a.addedAt,
      apiKeyMasked: a.apiKey ? `${a.apiKey.slice(0, 8)}...${a.apiKey.slice(-4)}` : 'None',
      isActive: a.id === config.activeAccountId,
    }));
    return {
      activeAccountId: config.activeAccountId,
      rotationMode: config.rotationMode,
      accounts: safeAccounts,
    };
  });

  fastify.post('/api/accounts/active', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    setActiveAccount(accountId);
    return { status: 'success', activeAccountId: accountId };
  });

  fastify.post('/api/accounts/delete', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    logoutAccount(accountId);
    return { status: 'success' };
  });

  fastify.post('/api/accounts/rotation', async (req: any, reply) => {
    const { rotationMode } = req.body || {};
    if (rotationMode !== 'manual' && rotationMode !== 'auto-quota') {
      return reply.status(400).send({ error: 'rotationMode must be manual|auto-quota' });
    }
    setRotationMode(rotationMode);
    return { status: 'success', rotationMode };
  });

  fastify.post('/api/auth/manual-login', async (req: any, reply) => {
    const { apiKey, name } = req.body || {};
    if (!apiKey) return reply.status(400).send({ error: 'API key is required' });
    try {
      const acc = await loginNewAccount(String(apiKey), name ? String(name).slice(0, 60) : undefined);
      return { status: 'success', account: acc };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.post('/api/auth/browser-login', async (_req, reply) => {
    try {
      logger.info('[DASHBOARD] Triggering CLI Browser OAuth Login flow...');
      const newAcc = await startBrowserLoginFlow(5959);
      return { status: 'success', account: newAcc };
    } catch (err: any) {
      logger.error(`[DASHBOARD] Browser Login flow error: ${err.message}`);
      return reply.status(500).send({ error: err.message });
    }
  });

  fastify.get('/api/usage/aggregate', async () => {
    const config = loadConfig();
    const targetAccounts =
      config.accounts.length > 0
        ? config.accounts
        : [{ id: 'acc_default', name: 'Default System Account', apiKey: getActiveApiKey() }];

    const results = await Promise.all(
      targetAccounts.map(async (acc: any) => {
        const stats = await fetchLiveUsageStats(acc.apiKey, config.ccApiBase, config.ccVersion);
        const who = stats.whoami?.user;
        return {
          account: {
            id: acc.id,
            name: acc.name || (who ? who.name || who.userName : 'Default System Account'),
            userName: acc.userName || who?.userName || 'system_user',
            email: acc.email || who?.email || 'System Auth Key',
            isActive: acc.id === config.activeAccountId || targetAccounts.length === 1,
            apiKeyMasked: acc.apiKey ? `${acc.apiKey.slice(0, 8)}...${acc.apiKey.slice(-4)}` : 'None',
          },
          ...stats,
        };
      })
    );
    return { accountsUsage: results };
  });

  // ─── Dashboard SPA ──────────────────────────────────────────────────────────

  fastify.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html');
    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CommandCode Proxy Controller v4</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}.tab-btn.active{border-bottom:2px solid #6366f1;color:#818cf8;font-weight:600}</style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">

<header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-50">
  <div class="flex items-center space-x-3">
    <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20"><i class="fa-solid fa-bolt text-lg"></i></div>
    <div>
      <h1 class="font-bold text-lg leading-tight text-white flex items-center gap-2">CommandCode Proxy <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">v4</span></h1>
      <p class="text-xs text-slate-400">OpenAI Chat &amp; Anthropic Messages Compatibility Hub</p>
    </div>
  </div>
  <div class="flex items-center space-x-4">
    <div class="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs">
      <span id="statusDot" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
      <span id="statusText" class="font-medium text-slate-300">Checking...</span>
    </div>
    <button onclick="toggleEngine()" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition shadow-md shadow-emerald-600/20"><i class="fa-solid fa-power-off"></i> <span id="toggleBtnText">Toggle</span></button>
  </div>
</header>

<nav class="border-b border-slate-800 bg-slate-900/40 px-6 flex space-x-8 text-sm text-slate-400">
  <button onclick="switchTab('overview')" id="tab-overview" class="tab-btn active py-3 flex items-center gap-2"><i class="fa-solid fa-gauge-high"></i> Overview</button>
  <button onclick="switchTab('accounts')" id="tab-accounts" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-users-gear"></i> Accounts &amp; Auth</button>
  <button onclick="switchTab('usage')" id="tab-usage" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-chart-pie"></i> Usage &amp; Credits</button>
  <button onclick="switchTab('models')" id="tab-models" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-cubes"></i> Models</button>
  <button onclick="switchTab('logs')" id="tab-logs" class="tab-btn py-3 flex items-center gap-2"><i class="fa-solid fa-terminal"></i> Live Logs</button>
</nav>

<main class="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">

<section id="content-overview" class="space-y-6">
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Gateway Server</p><h3 id="statPort" class="text-xl font-bold text-white mt-1">Port :9090</h3><p id="statUptime" class="text-xs text-indigo-400 mt-2">Uptime: 0s</p></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Active Account</p><h3 id="statAccount" class="text-xl font-bold text-white mt-1">None</h3><p id="statAccountsCount" class="text-xs text-slate-400 mt-2">0 accounts registered</p></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Security</p><h3 id="statBind" class="text-xl font-bold text-emerald-400 mt-1">127.0.0.1</h3><p id="statAuth" class="text-xs text-slate-400 mt-2">API auth: off</p></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Available Models</p><h3 id="statModels" class="text-xl font-bold text-white mt-1">0</h3><p class="text-xs text-emerald-400 mt-2"><i class="fa-solid fa-check"></i> Ready for completions</p></div>
  </div>
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
    <h2 class="text-md font-semibold text-white mb-4 flex items-center gap-2"><i class="fa-solid fa-link text-indigo-400"></i> Enabled API Endpoints</h2>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg"><span class="text-xs font-bold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">POST</span><span class="font-mono text-sm text-slate-200 ml-2">/v1/chat/completions</span><p class="text-xs text-slate-400 mt-2">OpenAI Chat Completions — tools, vision, reasoning</p></div>
      <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg"><span class="text-xs font-bold px-2 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">POST</span><span class="font-mono text-sm text-slate-200 ml-2">/v1/messages</span><p class="text-xs text-slate-400 mt-2">Anthropic Messages — tool_use, thinking blocks</p></div>
      <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg"><span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">GET</span><span class="font-mono text-sm text-slate-200 ml-2">/v1/models</span><p class="text-xs text-slate-400 mt-2">Live Upstream Model Catalog</p></div>
    </div>
  </div>
</section>

<section id="content-accounts" class="space-y-6 hidden">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-bold text-white">Multi-Account Management</h2>
      <p class="text-xs text-slate-400">Log in with Command Code CLI Browser Auth or paste an API Key</p>
    </div>
    <div class="flex space-x-3">
      <button onclick="startBrowserLogin()" id="browserAuthBtn" class="px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-lg text-xs font-semibold flex items-center gap-2 shadow-lg shadow-indigo-600/20"><i class="fa-solid fa-globe"></i> Login via Browser (OAuth)</button>
      <button onclick="showLoginModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-2 border border-slate-700"><i class="fa-solid fa-key"></i> Manual Key Entry</button>
    </div>
  </div>
  <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex items-center justify-between">
    <div>
      <h3 class="text-sm font-semibold text-white">Account Key Rotation Strategy</h3>
      <p class="text-xs text-slate-400">Auto-quota checks the 5-Hour window every 30 minutes and switches at &ge;90%</p>
    </div>
    <select id="rotationSelect" onchange="changeRotationMode(this.value)" class="bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold">
      <option value="manual">Manual Selection</option>
      <option value="auto-quota">Auto Quota Protection (30m check)</option>
    </select>
  </div>
  <div id="accountsGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
</section>

<section id="content-usage" class="space-y-6 hidden">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-lg font-bold text-white">Live Usage &amp; Quotas</h2>
      <p class="text-xs text-slate-400">Real-time credit balances and window limits per account</p>
    </div>
    <select id="usageAccountSelect" onchange="renderUsageForAccount(this.value)" class="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold"></select>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Monthly Credits</p><h3 id="creditMonthly" class="text-2xl font-extrabold text-emerald-400 mt-1">$0.00</h3></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Purchased</p><h3 id="creditPurchased" class="text-2xl font-extrabold text-indigo-400 mt-1">$0.00</h3></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Free Credits</p><h3 id="creditFree" class="text-2xl font-extrabold text-cyan-400 mt-1">$0.00</h3></div>
    <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl"><p class="text-xs text-slate-400 font-medium">Total Cost</p><h3 id="creditTotalCost" class="text-2xl font-extrabold text-purple-400 mt-1">$0.00</h3></div>
  </div>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
    <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between"><h3 class="font-bold text-sm text-white"><i class="fa-solid fa-clock text-indigo-400"></i> 5-Hour Window</h3><span id="window5hText" class="text-xs font-semibold text-slate-300">$0.00 / $0.00</span></div>
      <div class="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800"><div id="window5hBar" class="bg-indigo-500 h-2.5 rounded-full transition-all duration-500" style="width:0%"></div></div>
      <p id="window5hReset" class="text-[11px] text-slate-400 text-right">Resets in: --</p>
    </div>
    <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between"><h3 class="font-bold text-sm text-white"><i class="fa-solid fa-calendar-week text-violet-400"></i> Weekly Window</h3><span id="windowWeeklyText" class="text-xs font-semibold text-slate-300">$0.00 / $0.00</span></div>
      <div class="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800"><div id="windowWeeklyBar" class="bg-violet-500 h-2.5 rounded-full transition-all duration-500" style="width:0%"></div></div>
      <p id="windowWeeklyReset" class="text-[11px] text-slate-400 text-right">Resets in: --</p>
    </div>
  </div>
</section>

<section id="content-models" class="space-y-4 hidden">
  <div class="flex items-center justify-between">
    <div><h2 class="text-lg font-bold text-white">Live Upstream Models</h2><p class="text-xs text-slate-400">Fetched from Command Code API</p></div>
    <button onclick="loadModels(true)" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1.5"><i class="fa-solid fa-rotate"></i> Fetch Live Models</button>
  </div>
  <div id="modelsList" class="grid grid-cols-1 md:grid-cols-3 gap-3"></div>
</section>

<section id="content-logs" class="space-y-4 hidden">
  <div class="flex items-center justify-between">
    <h2 class="text-lg font-bold text-white">Gateway Event Console</h2>
    <div class="flex items-center space-x-2">
      <button onclick="clearLogs()" class="px-3 py-1.5 bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition"><i class="fa-solid fa-trash-can"></i> Clear Logs</button>
      <button onclick="loadLogs()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition"><i class="fa-solid fa-rotate"></i> Refresh Logs</button>
    </div>
  </div>
  <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 h-[500px] overflow-y-auto space-y-1" id="logsBox"><p class="text-slate-500">Initializing log console...</p></div>
</section>

</main>

<div id="loginModal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center hidden">
  <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 max-w-md w-full shadow-2xl space-y-4">
    <h3 class="text-base font-bold text-white flex items-center gap-2"><i class="fa-solid fa-key text-indigo-400"></i> Add Command Code API Key</h3>
    <div class="space-y-3">
      <div><label class="text-xs text-slate-300 block mb-1">Account Nickname (Optional)</label><input type="text" id="loginNickname" placeholder="e.g. Work Account" class="w-full bg-slate-950 border border-slate-700 text-xs rounded-lg p-2.5 text-white outline-none focus:border-indigo-500"></div>
      <div><label class="text-xs text-slate-300 block mb-1">Command Code API Key</label><input type="password" id="loginApiKey" placeholder="user_..." class="w-full bg-slate-950 border border-slate-700 text-xs rounded-lg p-2.5 text-white outline-none focus:border-indigo-500"></div>
      <div id="loginError" class="text-xs text-rose-400 hidden"></div>
    </div>
    <div class="flex justify-end space-x-2 pt-2">
      <button onclick="hideLoginModal()" class="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg text-xs font-medium">Cancel</button>
      <button onclick="submitLogin()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold">Log In &amp; Save</button>
    </div>
  </div>
</div>

<script>
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
let currentTab = 'overview';
let selectedUsageAccountId = '';
let globalUsageCache = [];

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('content-' + tab).classList.remove('hidden');
  currentTab = tab;
  if (tab === 'accounts') loadAccounts();
  if (tab === 'usage') loadUsageInit();
  if (tab === 'models') loadModels(false);
  if (tab === 'logs') loadLogs();
}

async function fetchStatus() {
  try {
    const data = await (await fetch('/api/status')).json();
    const dot = document.getElementById('statusDot'), txt = document.getElementById('statusText'), btn = document.getElementById('toggleBtnText');
    if (data.running) { dot.className='w-2.5 h-2.5 rounded-full bg-emerald-500'; txt.innerText='Engine Active'; txt.className='font-medium text-emerald-400'; btn.innerText='Stop Engine'; }
    else { dot.className='w-2.5 h-2.5 rounded-full bg-rose-500'; txt.innerText='Engine Stopped'; txt.className='font-medium text-rose-400'; btn.innerText='Start Engine'; }
    document.getElementById('statPort').innerText = 'Port :' + data.port;
    document.getElementById('statUptime').innerText = 'Uptime: ' + data.uptime;
    document.getElementById('statAccount').innerText = data.activeAccountName || 'None';
    document.getElementById('statAccountsCount').innerText = data.accountsCount + ' accounts registered';
    document.getElementById('statBind').innerText = data.host === '0.0.0.0' ? '0.0.0.0 (LAN!)' : data.host;
    document.getElementById('statAuth').innerText = 'API auth: ' + (data.authRequired ? 'ON' : 'off');
    document.getElementById('statModels').innerText = data.modelsCount;
    document.getElementById('rotationSelect').value = data.rotationMode;
  } catch {}
}

async function toggleEngine() {
  const data = await (await fetch('/api/status')).json();
  await fetch('/api/gateway/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ running: !data.running }) });
  fetchStatus();
}

async function startBrowserLogin() {
  const btn = document.getElementById('browserAuthBtn');
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Waiting for browser auth...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/browser-login', { method:'POST' });
    const data = await res.json();
    if (res.ok && data.status === 'success') { alert('Logged in: ' + data.account.name); loadAccounts(); fetchStatus(); }
    else alert('Browser login error: ' + (data.error || 'Failed'));
  } catch (e) { alert('Browser login error: ' + e.message); }
  finally { btn.innerHTML = original; btn.disabled = false; }
}

function showLoginModal(){ document.getElementById('loginModal').classList.remove('hidden'); }
function hideLoginModal(){ document.getElementById('loginModal').classList.add('hidden'); }

async function submitLogin() {
  const apiKey = document.getElementById('loginApiKey').value.trim();
  const name = document.getElementById('loginNickname').value.trim();
  const errEl = document.getElementById('loginError');
  if (!apiKey) { errEl.innerText='API key cannot be empty'; errEl.classList.remove('hidden'); return; }
  const res = await fetch('/api/auth/manual-login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ apiKey, name }) });
  const data = await res.json();
  if (res.ok && data.status === 'success') { hideLoginModal(); document.getElementById('loginApiKey').value=''; loadAccounts(); fetchStatus(); }
  else { errEl.innerText = data.error || 'Failed to login'; errEl.classList.remove('hidden'); }
}

async function loadAccounts() {
  const data = await (await fetch('/api/accounts')).json();
  const grid = document.getElementById('accountsGrid');
  grid.innerHTML = data.accounts.map(acc =>
    '<div class="bg-slate-900 border ' + (acc.isActive ? 'border-indigo-500 shadow-lg shadow-indigo-500/10' : 'border-slate-800') + ' p-5 rounded-xl space-y-3">' +
      '<div class="flex items-center justify-between">' +
        '<div class="flex items-center space-x-3">' +
          '<div class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-xs">' + esc((acc.name||'?').charAt(0).toUpperCase()) + '</div>' +
          '<div><h4 class="font-bold text-sm text-white flex items-center gap-2">' + esc(acc.name) +
          (acc.isActive ? ' <span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">Active</span>' : '') +
          '</h4><p class="text-xs text-slate-400">' + esc(acc.userName ? '@'+acc.userName : (acc.email || 'API Key')) + '</p></div>' +
        '</div>' +
        '<div class="flex items-center space-x-2">' +
          (!acc.isActive ? '<button onclick="setActiveAcc(\\'' + esc(acc.id) + '\\')" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-indigo-400 rounded-lg border border-slate-700">Set Active</button>' : '') +
          '<button onclick="deleteAcc(\\'' + esc(acc.id) + '\\')" class="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"><i class="fa-solid fa-trash-can text-xs"></i></button>' +
        '</div>' +
      '</div>' +
      '<div class="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">' +
        '<span>Key: <code class="font-mono text-slate-300">' + esc(acc.apiKeyMasked) + '</code></span>' +
        '<span>Added: ' + esc(new Date(acc.addedAt).toLocaleDateString()) + '</span>' +
      '</div>' +
    '</div>'
  ).join('');
}

async function setActiveAcc(id){ await fetch('/api/accounts/active',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:id})}); loadAccounts(); fetchStatus(); }
async function deleteAcc(id){ if(!confirm('Remove this account?'))return; await fetch('/api/accounts/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:id})}); loadAccounts(); fetchStatus(); }
async function changeRotationMode(mode){ await fetch('/api/accounts/rotation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rotationMode:mode})}); fetchStatus(); }

async function loadUsageInit() {
  const data = await (await fetch('/api/usage/aggregate')).json();
  globalUsageCache = data.accountsUsage || [];
  const select = document.getElementById('usageAccountSelect');
  select.innerHTML = globalUsageCache.map(u => '<option value="' + esc(u.account.id) + '">' + esc(u.account.name) + ' (' + esc(u.account.apiKeyMasked) + ')' + (u.account.isActive?' [Active]':'') + '</option>').join('');
  if (!selectedUsageAccountId && globalUsageCache.length > 0) selectedUsageAccountId = globalUsageCache[0].account.id;
  select.value = selectedUsageAccountId;
  renderUsageForAccount(selectedUsageAccountId);
}

function renderUsageForAccount(accId) {
  selectedUsageAccountId = accId;
  const t = globalUsageCache.find(u => u.account.id === accId) || globalUsageCache[0];
  if (!t) return;
  const credits = t.credits?.credits || {};
  document.getElementById('creditMonthly').innerText = '$' + (credits.monthlyCredits||0).toFixed(2);
  document.getElementById('creditPurchased').innerText = '$' + (credits.purchasedCredits||0).toFixed(2);
  document.getElementById('creditFree').innerText = '$' + (credits.freeCredits||0).toFixed(2);
  document.getElementById('creditTotalCost').innerText = '$' + (t.summary?.totalCost||0).toFixed(2);

  const w5h = t.credits?.windowLimits?.fiveHour;
  if (w5h) {
    document.getElementById('window5hText').innerText = '$' + w5h.used.toFixed(2) + ' / $' + w5h.cap.toFixed(2);
    const ratio = w5h.cap > 0 ? (w5h.used/w5h.cap)*100 : 0;
    const bar = document.getElementById('window5hBar');
    bar.style.width = Math.min(100,ratio)+'%';
    bar.className = ratio>=90?'bg-rose-500 h-2.5 rounded-full':ratio>=70?'bg-amber-500 h-2.5 rounded-full':'bg-indigo-500 h-2.5 rounded-full';
    const mins = w5h.resetAt ? Math.max(0,Math.ceil((w5h.resetAt-Date.now())/60000)) : 0;
    document.getElementById('window5hReset').innerText = 'Resets in: '+mins+' mins';
  }
  const wk = t.credits?.windowLimits?.weekly;
  if (wk) {
    document.getElementById('windowWeeklyText').innerText = '$' + wk.used.toFixed(2) + ' / $' + wk.cap.toFixed(2);
    const ratio = wk.cap > 0 ? (wk.used/wk.cap)*100 : 0;
    const bar = document.getElementById('windowWeeklyBar');
    bar.style.width = Math.min(100,ratio)+'%';
    bar.className = ratio>=90?'bg-rose-500 h-2.5 rounded-full':'bg-violet-500 h-2.5 rounded-full';
    const hrs = wk.resetAt ? Math.max(0,Math.ceil((wk.resetAt-Date.now())/3600000)) : 0;
    document.getElementById('windowWeeklyReset').innerText = 'Resets in: '+hrs+' hours';
  }
}

async function loadModels(force) {
  if (force) { await fetch('/v1/models/refresh', { method:'POST' }).catch(()=>{}); }
  const data = await (await fetch('/v1/models')).json();
  const c = document.getElementById('modelsList');
  c.innerHTML = (data.data||[]).map(m =>
    '<div class="p-3 bg-slate-900 border border-slate-800 rounded-lg flex items-center justify-between">' +
    '<div><p class="font-bold text-xs text-white">' + esc(m.id) + '</p><p class="text-[11px] text-slate-400 mt-1">Provider: ' + esc(m.owned_by) + '</p></div>' +
    '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">Active</span></div>'
  ).join('');
}

async function loadLogs() {
  const data = await (await fetch('/api/logs')).json();
  const box = document.getElementById('logsBox');
  box.innerHTML = data.logs.map(l => {
    const lc = l.level==='error'?'text-rose-400':l.level==='warn'?'text-amber-400':'text-slate-300';
    return '<p class="'+lc+' font-mono text-[11px] py-0.5 break-all"><span class="text-slate-500">['+esc(l.timestamp)+']</span> '+esc(l.message)+'</p>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function clearLogs(){ await fetch('/api/logs/clear',{method:'POST'}); loadLogs(); }

fetchStatus();
setInterval(fetchStatus, 5000);
</script>
</body>
</html>`;
  });
}
