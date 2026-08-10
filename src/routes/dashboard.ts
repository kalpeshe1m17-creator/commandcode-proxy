import { FastifyInstance } from 'fastify';
import { getMemoryLogs, clearMemoryLogs, logger } from '../utils/logger.js';
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
  saveConfigFile,
} from '../utils/config.js';
import { getCachedModels } from '../utils/models.js';

const startTimestamp = Date.now();

export async function dashboardRoutes(fastify: FastifyInstance) {
  // CORS Preflight Handler for Web / Client Applications
  fastify.options('*', async (req, reply) => {
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-api-key, anthropic-version')
      .status(204)
      .send();
  });

  // Hook to append CORS headers to all responses
  fastify.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });

  // Status endpoint
  fastify.get('/api/status', async (req, reply) => {
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
      apiBase: config.ccApiBase,
      cliVersion: config.ccVersion,
      rotationMode: config.rotationMode,
      permissionMode: config.permissionMode || 'auto-accept',
      activeAccountId: config.activeAccountId || activeAcc?.id || 'acc_default',
      activeAccountName: activeAcc?.name || 'Default System Account',
      activeAccountUserName: activeAcc?.userName || 'System User',
      accountsCount: config.accounts.length,
      hasApiKey: !!getActiveApiKey(),
      modelsCount: getCachedModels().length,
      endpoints: config.endpoints,
    };
  });

  // Toggle gateway engine state
  fastify.post('/api/gateway/toggle', async (req: any, reply) => {
    const body = req.body || {};
    if (body.running !== undefined) {
      setGatewayRunning(body.running);
      logger.info(`[DASHBOARD] Gateway engine toggled: ${body.running ? 'STARTED' : 'STOPPED'}`);
    }
    return { status: 'success', running: getGatewayRunning() };
  });

  // Update permission mode endpoint
  fastify.post('/api/config/permission-mode', async (req: any, reply) => {
    const { permissionMode } = req.body || {};
    if (permissionMode) {
      saveConfigFile({ permissionMode });
      logger.info(`[DASHBOARD] Permission Mode updated to '${permissionMode}'`);
      return { status: 'success', permissionMode };
    }
    return reply.status(400).send({ error: 'Missing permissionMode parameter' });
  });

  // Logs endpoint
  fastify.get('/api/logs', async (req, reply) => {
    return { logs: getMemoryLogs() };
  });

  // Clear memory logs endpoint
  fastify.post('/api/logs/clear', async (req, reply) => {
    clearMemoryLogs();
    logger.info(`[DASHBOARD] Memory log console cleared.`);
    return { status: 'success' };
  });

  // Accounts list endpoint
  fastify.get('/api/accounts', async (req, reply) => {
    const config = loadConfig();
    const safeAccounts = config.accounts.map(a => ({
      id: a.id,
      name: a.name,
      userName: a.userName,
      email: a.email,
      userId: a.userId,
      addedAt: a.addedAt,
      apiKeyMasked: a.apiKey ? `${a.apiKey.slice(0, 8)}...${a.apiKey.slice(-4)}` : 'None',
      isActive: a.id === config.activeAccountId,
    }));
    return {
      activeAccountId: config.activeAccountId,
      rotationMode: config.rotationMode,
      permissionMode: config.permissionMode || 'auto-accept',
      accounts: safeAccounts,
    };
  });

  // Set active account endpoint
  fastify.post('/api/accounts/active', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    setActiveAccount(accountId);
    return { status: 'success', activeAccountId: accountId };
  });

  // Remove account endpoint
  fastify.post('/api/accounts/delete', async (req: any, reply) => {
    const { accountId } = req.body || {};
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    logoutAccount(accountId);
    return { status: 'success' };
  });

  // Set rotation mode endpoint
  fastify.post('/api/accounts/rotation', async (req: any, reply) => {
    const { rotationMode } = req.body || {};
    if (!rotationMode) return reply.status(400).send({ error: 'rotationMode required' });
    setRotationMode(rotationMode);
    return { status: 'success', rotationMode };
  });

  // Add account via API Key endpoint
  fastify.post('/api/auth/manual-login', async (req: any, reply) => {
    const { apiKey, name } = req.body || {};
    if (!apiKey) return reply.status(400).send({ error: 'API key is required' });
    try {
      const acc = await loginNewAccount(apiKey, name);
      return { status: 'success', account: acc };
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  // Trigger CLI Browser Login (OAuth) endpoint
  fastify.post('/api/auth/browser-login', async (req, reply) => {
    try {
      logger.info(`[DASHBOARD] Triggering CLI Browser OAuth Login flow...`);
      const newAcc = await startBrowserLoginFlow(5959);
      return { status: 'success', account: newAcc };
    } catch (err: any) {
      logger.error(`[DASHBOARD] Browser Login flow error: ${err.message}`);
      return reply.status(500).send({ error: err.message });
    }
  });

  // Aggregated Credits & Usage Stats endpoint
  fastify.get('/api/usage/aggregate', async (req, reply) => {
    const config = loadConfig();
    const targetAccounts = config.accounts.length > 0 ? config.accounts : [{
      id: 'acc_default',
      name: 'Default System Account',
      apiKey: getActiveApiKey(),
    }];

    const results = await Promise.all(targetAccounts.map(async (acc: any) => {
      const stats = await fetchLiveUsageStats(acc.apiKey, config.ccApiBase, config.ccVersion);
      const who = stats.whoami?.user;
      return {
        account: {
          id: acc.id,
          name: acc.name || (who ? (who.name || who.userName) : 'Default System Account'),
          userName: acc.userName || who?.userName || 'system_user',
          email: acc.email || who?.email || 'System Auth Key',
          isActive: acc.id === config.activeAccountId || targetAccounts.length === 1,
          apiKeyMasked: acc.apiKey ? `${acc.apiKey.slice(0, 8)}...${acc.apiKey.slice(-4)}` : 'None',
        },
        ...stats,
      };
    }));
    return { accountsUsage: results };
  });

  // Main Single-Page HTML Dashboard UI
  fastify.get('/', async (req, reply) => {
    reply.header('Content-Type', 'text/html');
    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CommandCode OpenAI Proxy Controller v3.0</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwindcss.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: { 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' }
          }
        }
      }
    }
  </script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; }
    .tab-btn.active { border-bottom: 2px solid #6366f1; color: #818cf8; font-weight: 600; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex flex-col">

  <!-- Top Navbar -->
  <header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-50">
    <div class="flex items-center space-x-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
        <i class="fa-solid fa-bolt text-lg"></i>
      </div>
      <div>
        <h1 class="font-bold text-lg leading-tight text-white flex items-center gap-2">
          CommandCode OpenAI Proxy
          <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">v3.0</span>
        </h1>
        <p class="text-xs text-slate-400">OpenAI Chat & Anthropic Messages Compatibility Hub</p>
      </div>
    </div>

    <!-- Engine Control Status Pill -->
    <div class="flex items-center space-x-4">
      <div id="statusBadge" class="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs">
        <span id="statusDot" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
        <span id="statusText" class="font-medium text-slate-300">Checking...</span>
      </div>

      <button id="toggleEngineBtn" onclick="toggleEngine()" class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition flex items-center gap-1.5 shadow-md shadow-emerald-600/20">
        <i class="fa-solid fa-power-off"></i> <span id="toggleBtnText">Toggle</span>
      </button>
    </div>
  </header>

  <!-- Navigation Tabs -->
  <nav class="border-b border-slate-800 bg-slate-900/40 px-6 flex space-x-8 text-sm text-slate-400">
    <button onclick="switchTab('overview')" id="tab-overview" class="tab-btn active py-3 flex items-center gap-2">
      <i class="fa-solid fa-gauge-high"></i> Overview
    </button>
    <button onclick="switchTab('accounts')" id="tab-accounts" class="tab-btn py-3 flex items-center gap-2">
      <i class="fa-solid fa-users-gear"></i> Accounts & Auth
    </button>
    <button onclick="switchTab('usage')" id="tab-usage" class="tab-btn py-3 flex items-center gap-2">
      <i class="fa-solid fa-chart-pie"></i> Usage & Credits
    </button>
    <button onclick="switchTab('models')" id="tab-models" class="tab-btn py-3 flex items-center gap-2">
      <i class="fa-solid fa-cubes"></i> Models Catalog
    </button>
    <button onclick="switchTab('logs')" id="tab-logs" class="tab-btn py-3 flex items-center gap-2">
      <i class="fa-solid fa-terminal"></i> Live Logs
    </button>
  </nav>

  <!-- Main Content Container -->
  <main class="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">

    <!-- TAB 1: OVERVIEW -->
    <section id="content-overview" class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Gateway Server</p>
          <h3 id="statPort" class="text-xl font-bold text-white mt-1">Port :9090</h3>
          <p id="statUptime" class="text-xs text-indigo-400 mt-2">Uptime: 0s</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Active Account</p>
          <h3 id="statAccount" class="text-xl font-bold text-white mt-1">None</h3>
          <p id="statAccountsCount" class="text-xs text-slate-400 mt-2">0 accounts registered</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Permission Mode</p>
          <h3 id="statPermission" class="text-xl font-bold text-emerald-400 mt-1 uppercase">AUTO-ACCEPT</h3>
          <p class="text-xs text-slate-400 mt-2">Tool auto-approval mode</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Available Models</p>
          <h3 id="statModels" class="text-xl font-bold text-white mt-1">0</h3>
          <p class="text-xs text-emerald-400 mt-2"><i class="fa-solid fa-check"></i> Ready for completions</p>
        </div>
      </div>

      <!-- Quick Endpoints Box -->
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h2 class="text-md font-semibold text-white mb-4 flex items-center gap-2">
          <i class="fa-solid fa-link text-indigo-400"></i> Enabled API Endpoints
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg">
            <span class="text-xs font-bold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">POST</span>
            <span class="font-mono text-sm text-slate-200 ml-2">/v1/chat/completions</span>
            <p class="text-xs text-slate-400 mt-2">OpenAI Chat Completions API with Tool Calling & Reasoning</p>
          </div>
          <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg">
            <span class="text-xs font-bold px-2 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20">POST</span>
            <span class="font-mono text-sm text-slate-200 ml-2">/v1/messages</span>
            <p class="text-xs text-slate-400 mt-2">Anthropic Messages API compatibility layer</p>
          </div>
          <div class="p-4 bg-slate-950/60 border border-slate-800 rounded-lg">
            <span class="text-xs font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">GET</span>
            <span class="font-mono text-sm text-slate-200 ml-2">/v1/models</span>
            <p class="text-xs text-slate-400 mt-2">Live Upstream Model Catalog</p>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: ACCOUNTS & AUTH -->
    <section id="content-accounts" class="space-y-6 hidden">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold text-white">Multi-Account Management</h2>
          <p class="text-xs text-slate-400">Log in with Command Code CLI Browser Auth or API Key</p>
        </div>
        <div class="flex space-x-3">
          <button onclick="startBrowserLogin()" id="browserAuthBtn" class="px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-lg text-xs font-semibold flex items-center gap-2 shadow-lg shadow-indigo-600/20">
            <i class="fa-solid fa-globe"></i> Login via Browser (OAuth)
          </button>
          <button onclick="showLoginModal()" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-2 border border-slate-700">
            <i class="fa-solid fa-key"></i> Manual Key Entry
          </button>
        </div>
      </div>

      <!-- Key Rotation Mode Controls -->
      <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-white">Account Key Rotation Strategy</h3>
          <p class="text-xs text-slate-400">Choose how the gateway selects API keys for incoming requests</p>
        </div>
        <select id="rotationSelect" onchange="changeRotationMode(this.value)" class="bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold">
          <option value="manual">Manual Selection (Use Selected Active Account Only)</option>
          <option value="auto-quota">Auto Quota Protection (Check 5-Hour Quota every 30m & Auto-Switch if &gt;= 90%)</option>
        </select>
      </div>

      <!-- Tool Execution Permission Mode Controls -->
      <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-white flex items-center gap-2">
            <i class="fa-solid fa-shield-halved text-indigo-400"></i> Tool Execution Permission Mode
          </h3>
          <p class="text-xs text-slate-400">Control how tool execution requests (file edits, terminal commands) are authorized</p>
        </div>
        <select id="permissionSelect" onchange="changePermissionMode(this.value)" class="bg-slate-950 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold">
          <option value="auto-accept">⚡ Auto Accept (Auto-approve all tool calls without pausing - Recommended for Agents)</option>
          <option value="standard">Standard Default (Prompt for terminal & write commands)</option>
          <option value="plan">📝 Planning Only (Read-only safe inspection mode)</option>
          <option value="bypass">Bypass (Bypass client-side tool checks)</option>
        </select>
      </div>

      <!-- Accounts Grid -->
      <div id="accountsGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Rendered dynamically -->
      </div>
    </section>

    <!-- TAB 3: USAGE & CREDITS -->
    <section id="content-usage" class="space-y-6 hidden">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold text-white">Live Usage & Quotas</h2>
          <p class="text-xs text-slate-400">Real-time credit balances, 5-Hour window limits, and token metrics</p>
        </div>
        <select id="usageAccountSelect" onchange="renderUsageForAccount(this.value)" class="bg-slate-900 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 outline-none font-semibold">
          <!-- Populated dynamically -->
        </select>
      </div>

      <!-- Credits Overview Grid -->
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Monthly Credits Balance</p>
          <h3 id="creditMonthly" class="text-2xl font-extrabold text-emerald-400 mt-1">$0.00</h3>
          <p class="text-xs text-slate-400 mt-2">Active subscription plan credits</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Purchased / On-Demand</p>
          <h3 id="creditPurchased" class="text-2xl font-extrabold text-indigo-400 mt-1">$0.00</h3>
          <p class="text-xs text-slate-400 mt-2">Extra purchased balance</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Free Credits</p>
          <h3 id="creditFree" class="text-2xl font-extrabold text-cyan-400 mt-1">$0.00</h3>
          <p class="text-xs text-slate-400 mt-2">Promotional credits</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Total Cost Incurred</p>
          <h3 id="creditTotalCost" class="text-2xl font-extrabold text-purple-400 mt-1">$0.00</h3>
          <p class="text-xs text-slate-400 mt-2">Lifetime usage cost</p>
        </div>
      </div>

      <!-- Window Rate Limit Progress Bars -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- 5-Hour Window Limit -->
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="font-bold text-sm text-white flex items-center gap-2">
              <i class="fa-solid fa-clock text-indigo-400"></i> 5-Hour Window Limit
            </h3>
            <span id="window5hText" class="text-xs font-semibold text-slate-300">$0.00 / $0.00</span>
          </div>
          <div class="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
            <div id="window5hBar" class="bg-indigo-500 h-2.5 rounded-full transition-all duration-500" style="width: 0%"></div>
          </div>
          <p id="window5hReset" class="text-[11px] text-slate-400 text-right">Resets in: --</p>
        </div>

        <!-- Weekly Window Limit -->
        <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="font-bold text-sm text-white flex items-center gap-2">
              <i class="fa-solid fa-calendar-week text-violet-400"></i> Weekly Window Limit
            </h3>
            <span id="windowWeeklyText" class="text-xs font-semibold text-slate-300">$0.00 / $0.00</span>
          </div>
          <div class="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
            <div id="windowWeeklyBar" class="bg-violet-500 h-2.5 rounded-full transition-all duration-500" style="width: 0%"></div>
          </div>
          <p id="windowWeeklyReset" class="text-[11px] text-slate-400 text-right">Resets in: --</p>
        </div>
      </div>
    </section>

    <!-- TAB 4: MODELS CATALOG -->
    <section id="content-models" class="space-y-4 hidden">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold text-white">Live Upstream Models</h2>
          <p class="text-xs text-slate-400">Live model catalog fetched directly from Command Code API</p>
        </div>
        <button onclick="loadModels()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1.5">
          <i class="fa-solid fa-rotate"></i> Fetch Live Models
        </button>
      </div>
      <div id="modelsList" class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <!-- Rendered dynamically -->
      </div>
    </section>

    <!-- TAB 5: LIVE LOGS -->
    <section id="content-logs" class="space-y-4 hidden">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-bold text-white">Gateway Event Console</h2>
        <div class="flex items-center space-x-2">
          <button onclick="clearLogs()" class="px-3 py-1.5 bg-slate-800 hover:bg-rose-900/60 text-slate-300 hover:text-rose-200 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition">
            <i class="fa-solid fa-trash-can"></i> Clear Logs
          </button>
          <button onclick="loadLogs()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg flex items-center gap-1.5 border border-slate-700 transition">
            <i class="fa-solid fa-rotate"></i> Refresh Logs
          </button>
        </div>
      </div>
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 h-[500px] overflow-y-auto space-y-1" id="logsBox">
        <p class="text-slate-500">Initializing log console...</p>
      </div>
    </section>

  </main>

  <!-- Login Modal -->
  <div id="loginModal" class="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center hidden">
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-6 max-w-md w-full shadow-2xl space-y-4">
      <h3 class="text-base font-bold text-white flex items-center gap-2">
        <i class="fa-solid fa-key text-indigo-400"></i> Add Command Code API Key
      </h3>
      <p class="text-xs text-slate-400">Paste your API key from Command Code studio or auth config.</p>
      
      <div class="space-y-3">
        <div>
          <label class="text-xs text-slate-300 block mb-1">Account Nickname (Optional)</label>
          <input type="text" id="loginNickname" placeholder="e.g. Work Account" class="w-full bg-slate-950 border border-slate-700 text-xs rounded-lg p-2.5 text-white outline-none focus:border-indigo-500">
        </div>
        <div>
          <label class="text-xs text-slate-300 block mb-1">Command Code API Key</label>
          <input type="password" id="loginApiKey" placeholder="user_4Vnw3A..." class="w-full bg-slate-950 border border-slate-700 text-xs rounded-lg p-2.5 text-white outline-none focus:border-indigo-500">
        </div>
        <div id="loginError" class="text-xs text-rose-400 hidden"></div>
      </div>

      <div class="flex justify-end space-x-2 pt-2">
        <button onclick="hideLoginModal()" class="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg text-xs font-medium">Cancel</button>
        <button onclick="submitLogin()" id="submitLoginBtn" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold">Log In & Save</button>
      </div>
    </div>
  </div>

  <!-- JavaScript SPA Logic -->
  <script>
    let currentTab = 'overview';
    let selectedUsageAccountId = '';
    let globalUsageCache = [];

    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('main > section').forEach(sec => sec.classList.add('hidden'));

      document.getElementById('tab-' + tab).classList.add('active');
      document.getElementById('content-' + tab).classList.remove('hidden');
      currentTab = tab;

      if (tab === 'accounts') loadAccounts();
      if (tab === 'usage') loadUsageInit();
      if (tab === 'models') loadModels();
      if (tab === 'logs') loadLogs();
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();

        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const toggleBtnText = document.getElementById('toggleBtnText');

        if (data.running) {
          statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-md shadow-emerald-500/50';
          statusText.innerText = 'Engine Active';
          statusText.className = 'font-medium text-emerald-400';
          toggleBtnText.innerText = 'Stop Engine';
        } else {
          statusDot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 shadow-md shadow-rose-500/50';
          statusText.innerText = 'Engine Stopped';
          statusText.className = 'font-medium text-rose-400';
          toggleBtnText.innerText = 'Start Engine';
        }

        document.getElementById('statPort').innerText = 'Port :' + data.port;
        document.getElementById('statUptime').innerText = 'Uptime: ' + data.uptime;
        document.getElementById('statAccount').innerText = data.activeAccountName || 'None';
        document.getElementById('statAccountsCount').innerText = data.accountsCount + ' accounts registered';
        document.getElementById('statPermission').innerText = (data.permissionMode || 'auto-accept').toUpperCase();
        document.getElementById('statModels').innerText = data.modelsCount;
        document.getElementById('rotationSelect').value = data.rotationMode;
        if (document.getElementById('permissionSelect')) {
          document.getElementById('permissionSelect').value = data.permissionMode || 'auto-accept';
        }

      } catch (err) {
        console.error('Failed to fetch status:', err);
      }
    }

    async function changePermissionMode(mode) {
      await fetch('/api/config/permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionMode: mode })
      });
      fetchStatus();
    }

    async function toggleEngine() {
      const res = await fetch('/api/status');
      const data = await res.json();
      await fetch('/api/gateway/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running: !data.running })
      });
      fetchStatus();
    }

    async function startBrowserLogin() {
      const btn = document.getElementById('browserAuthBtn');
      const originalText = btn.innerHTML;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Waiting for browser auth...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/auth/browser-login', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.status === 'success') {
          alert('Successfully logged in account: ' + data.account.name);
          loadAccounts();
          fetchStatus();
        } else {
          alert('Browser login error: ' + (data.error || 'Failed'));
        }
      } catch (err) {
        alert('Browser login error: ' + err.message);
      } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
      }
    }

    function showLoginModal() {
      document.getElementById('loginModal').classList.remove('hidden');
    }

    function hideLoginModal() {
      document.getElementById('loginModal').classList.add('hidden');
    }

    async function submitLogin() {
      const apiKey = document.getElementById('loginApiKey').value.trim();
      const name = document.getElementById('loginNickname').value.trim();

      if (!apiKey) {
        document.getElementById('loginError').innerText = 'API key cannot be empty';
        document.getElementById('loginError').classList.remove('hidden');
        return;
      }

      const res = await fetch('/api/auth/manual-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, name })
      });
      const data = await res.json();
      if (res.ok && data.status === 'success') {
        hideLoginModal();
        document.getElementById('loginApiKey').value = '';
        loadAccounts();
        fetchStatus();
      } else {
        document.getElementById('loginError').innerText = data.error || 'Failed to login';
        document.getElementById('loginError').classList.remove('hidden');
      }
    }

    async function loadAccounts() {
      const res = await fetch('/api/accounts');
      const data = await res.json();
      const grid = document.getElementById('accountsGrid');

      grid.innerHTML = data.accounts.map(acc => \`
        <div class="bg-slate-900 border \${acc.isActive ? 'border-indigo-500 shadow-lg shadow-indigo-500/10' : 'border-slate-800'} p-5 rounded-xl space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold text-xs">
                \${acc.name.charAt(0).toUpperCase()}
              </div>
              <div>
                <h4 class="font-bold text-sm text-white flex items-center gap-2">
                  \${acc.name}
                  \${acc.isActive ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-semibold border border-emerald-500/20">Active</span>' : ''}
                </h4>
                <p class="text-xs text-slate-400">\${acc.userName ? '@' + acc.userName : (acc.email || 'API Key')}</p>
              </div>
            </div>

            <div class="flex items-center space-x-2">
              \${!acc.isActive ? \`<button onclick="setActiveAcc('\${acc.id}')" class="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-indigo-400 rounded-lg border border-slate-700">Set Active</button>\` : ''}
              <button onclick="deleteAcc('\${acc.id}')" class="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition"><i class="fa-solid fa-trash-can text-xs"></i></button>
            </div>
          </div>

          <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>Key: <code class="font-mono text-slate-300">\${acc.apiKeyMasked}</code></span>
            <span>Added: \${new Date(acc.addedAt).toLocaleDateString()}</span>
          </div>
        </div>
      \`).join('');
    }

    async function setActiveAcc(id) {
      await fetch('/api/accounts/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id })
      });
      loadAccounts();
      fetchStatus();
    }

    async function deleteAcc(id) {
      if (!confirm('Are you sure you want to remove this account?')) return;
      await fetch('/api/accounts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: id })
      });
      loadAccounts();
      fetchStatus();
    }

    async function changeRotationMode(mode) {
      await fetch('/api/accounts/rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rotationMode: mode })
      });
      fetchStatus();
    }

    async function loadUsageInit() {
      const res = await fetch('/api/usage/aggregate');
      const data = await res.json();
      globalUsageCache = data.accountsUsage || [];

      const select = document.getElementById('usageAccountSelect');
      select.innerHTML = globalUsageCache.map(u => \`
        <option value="\${u.account.id}">\${u.account.name} (\${u.account.apiKeyMasked}) \${u.account.isActive ? '[Active]' : ''}</option>
      \`).join('');

      if (!selectedUsageAccountId && globalUsageCache.length > 0) {
        selectedUsageAccountId = globalUsageCache[0].account.id;
      }
      select.value = selectedUsageAccountId;
      renderUsageForAccount(selectedUsageAccountId);
    }

    function renderUsageForAccount(accId) {
      selectedUsageAccountId = accId;
      const target = globalUsageCache.find(u => u.account.id === accId) || globalUsageCache[0];
      if (!target) return;

      const credits = target.credits?.credits || {};
      document.getElementById('creditMonthly').innerText = '$' + (credits.monthlyCredits || 0).toFixed(2);
      document.getElementById('creditPurchased').innerText = '$' + (credits.purchasedCredits || 0).toFixed(2);
      document.getElementById('creditFree').innerText = '$' + (credits.freeCredits || 0).toFixed(2);
      document.getElementById('creditTotalCost').innerText = '$' + (target.summary?.totalCost || 0).toFixed(2);

      const w5h = target.credits?.windowLimits?.fiveHour;
      if (w5h) {
        document.getElementById('window5hText').innerText = '$' + w5h.used.toFixed(2) + ' / $' + w5h.cap.toFixed(2);
        const ratio = w5h.cap > 0 ? (w5h.used / w5h.cap) * 100 : 0;
        const bar = document.getElementById('window5hBar');
        bar.style.width = Math.min(100, ratio) + '%';
        bar.className = ratio >= 90 ? 'bg-rose-500 h-2.5 rounded-full' : ratio >= 70 ? 'bg-amber-500 h-2.5 rounded-full' : 'bg-indigo-500 h-2.5 rounded-full';
        
        const resetMinutes = w5h.resetAt ? Math.max(0, Math.ceil((w5h.resetAt - Date.now()) / 60000)) : 0;
        document.getElementById('window5hReset').innerText = 'Resets in: ' + resetMinutes + ' mins';
      }

      const wWk = target.credits?.windowLimits?.weekly;
      if (wWk) {
        document.getElementById('windowWeeklyText').innerText = '$' + wWk.used.toFixed(2) + ' / $' + wWk.cap.toFixed(2);
        const ratio = wWk.cap > 0 ? (wWk.used / wWk.cap) * 100 : 0;
        const bar = document.getElementById('windowWeeklyBar');
        bar.style.width = Math.min(100, ratio) + '%';
        bar.className = ratio >= 90 ? 'bg-rose-500 h-2.5 rounded-full' : 'bg-violet-500 h-2.5 rounded-full';
        
        const resetHours = wWk.resetAt ? Math.max(0, Math.ceil((wWk.resetAt - Date.now()) / 3600000)) : 0;
        document.getElementById('windowWeeklyReset').innerText = 'Resets in: ' + resetHours + ' hours';
      }
    }

    async function loadModels() {
      const res = await fetch('/v1/models');
      const data = await res.json();
      const container = document.getElementById('modelsList');
      container.innerHTML = data.data.map(m => \`
        <div class="p-3 bg-slate-900 border border-slate-800 rounded-lg flex items-center justify-between">
          <div>
            <p class="font-bold text-xs text-white">\${m.id}</p>
            <p class="text-[11px] text-slate-400 mt-1">Provider: \${m.owned_by}</p>
          </div>
          <span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">Active</span>
        </div>
      \`).join('');
    }

    async function loadLogs() {
      const res = await fetch('/api/logs');
      const data = await res.json();
      const box = document.getElementById('logsBox');
      box.innerHTML = data.logs.map(l => \`
        <p class="\${l.level === 'error' ? 'text-rose-400' : l.level === 'warn' ? 'text-amber-400' : 'text-slate-300'} font-mono">
          [\${l.timestamp}] \${l.message}
        </p>
      \`).join('');
      box.scrollTop = box.scrollHeight;
    }

    async function clearLogs() {
      await fetch('/api/logs/clear', { method: 'POST' });
      loadLogs();
    }

    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;
  });
}
