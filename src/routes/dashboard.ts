import { FastifyInstance } from 'fastify';
import { getMemoryLogs, clearMemoryLogs, logger } from '../utils/logger.js';
import {
  loadConfig,
  getGatewayRunning,
  setGatewayRunning,
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
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
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
        <p class="text-xs text-slate-400">Enterprise OpenAI Chat & Anthropic Messages Gateway</p>
      </div>
    </div>

    <div class="flex items-center space-x-4">
      <div id="statusBadge" class="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs">
        <span id="statusDot" class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
        <span id="statusText" class="font-medium text-emerald-400">Engine Active</span>
      </div>
    </div>
  </header>

  <!-- Navigation Tabs -->
  <nav class="border-b border-slate-800 bg-slate-900/40 px-6 flex space-x-8 text-sm text-slate-400">
    <button onclick="switchTab('overview')" id="tab-overview" class="tab-btn active py-3 flex items-center gap-2">
      <i class="fa-solid fa-gauge-high"></i> Overview
    </button>
    <button onclick="switchTab('settings')" id="tab-settings" class="tab-btn py-3 flex items-center gap-2">
      <i class="fa-solid fa-sliders"></i> Permissions & Settings
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

    <!-- OVERVIEW TAB -->
    <section id="content-overview" class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Gateway Server</p>
          <h3 id="statPort" class="text-xl font-bold text-white mt-1">Port :9090</h3>
          <p id="statUptime" class="text-xs text-indigo-400 mt-2">Uptime: 0s</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Active Account</p>
          <h3 id="statAccount" class="text-xl font-bold text-white mt-1">System Account</h3>
          <p id="statAccountsCount" class="text-xs text-slate-400 mt-2">1 account registered</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Permission Mode</p>
          <h3 id="statPermissionMode" class="text-xl font-bold text-emerald-400 mt-1 uppercase">AUTO-ACCEPT</h3>
          <p class="text-xs text-slate-400 mt-2">Tool auto-approval mode</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 p-5 rounded-xl">
          <p class="text-xs text-slate-400 font-medium">Available Models</p>
          <h3 id="statModels" class="text-xl font-bold text-white mt-1">52</h3>
          <p class="text-xs text-emerald-400 mt-2"><i class="fa-solid fa-check"></i> Ready for completions</p>
        </div>
      </div>
    </section>

    <!-- SETTINGS TAB -->
    <section id="content-settings" class="space-y-6 hidden">
      <div class="bg-slate-900 border border-slate-800 p-6 rounded-xl space-y-4">
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i class="fa-solid fa-shield-halved text-indigo-400"></i> Tool Permission Mode
        </h2>
        <p class="text-xs text-slate-400">Select how agent tool execution calls (file writes, terminal execution, search) are authorized</p>
        
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div onclick="selectPermission('auto-accept')" id="card-auto-accept" class="p-4 bg-slate-950 border-2 border-indigo-500 rounded-xl cursor-pointer hover:border-indigo-400 transition">
            <h4 class="font-bold text-indigo-400 text-sm">⚡ Auto Accept</h4>
            <p class="text-xs text-slate-400 mt-1">Auto-approves all tool execution requests without stopping for prompts. Recommended for Coding Agents.</p>
          </div>
          <div onclick="selectPermission('standard')" id="card-standard" class="p-4 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <h4 class="font-bold text-slate-200 text-sm">🛡️ Standard</h4>
            <p class="text-xs text-slate-400 mt-1">Standard interactive execution mode. Prompts for terminal commands and write actions.</p>
          </div>
          <div onclick="selectPermission('plan')" id="card-plan" class="p-4 bg-slate-950 border border-slate-800 rounded-xl cursor-pointer hover:border-slate-700 transition">
            <h4 class="font-bold text-amber-400 text-sm">📝 Planning Only</h4>
            <p class="text-xs text-slate-400 mt-1">Read-only safe inspection mode. Prevents destructive file modifications and shell execution.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- MODELS TAB -->
    <section id="content-models" class="space-y-4 hidden">
      <div id="modelsList" class="grid grid-cols-1 md:grid-cols-3 gap-3"></div>
    </section>

    <!-- LOGS TAB -->
    <section id="content-logs" class="space-y-4 hidden">
      <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 h-96 overflow-y-auto space-y-1" id="logsBox">
        <p class="text-slate-500">Initializing log console...</p>
      </div>
    </section>
  </main>

  <script>
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('main > section').forEach(s => s.classList.add('hidden'));
      document.getElementById('tab-' + tab).classList.add('active');
      document.getElementById('content-' + tab).classList.remove('hidden');
      if (tab === 'models') loadModels();
      if (tab === 'logs') loadLogs();
    }

    async function fetchStatus() {
      const res = await fetch('/api/status');
      const data = await res.json();
      document.getElementById('statPort').innerText = 'Port :' + data.port;
      document.getElementById('statUptime').innerText = 'Uptime: ' + data.uptime;
      document.getElementById('statAccount').innerText = data.activeAccountName;
      document.getElementById('statPermissionMode').innerText = (data.permissionMode || 'auto-accept').toUpperCase();
      document.getElementById('statModels').innerText = data.modelsCount;
    }

    async function selectPermission(mode) {
      await fetch('/api/config/permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionMode: mode })
      });
      fetchStatus();
    }

    async function loadModels() {
      const res = await fetch('/v1/models');
      const data = await res.json();
      const container = document.getElementById('modelsList');
      container.innerHTML = data.data.map(m => \`
        <div class="p-3 bg-slate-900 border border-slate-800 rounded-lg">
          <p class="font-bold text-xs text-white">\${m.id}</p>
          <p class="text-[11px] text-slate-400 mt-1">Provider: \${m.owned_by}</p>
        </div>
      \`).join('');
    }

    async function loadLogs() {
      const res = await fetch('/api/logs');
      const data = await res.json();
      const box = document.getElementById('logsBox');
      box.innerHTML = data.logs.map(l => \`
        <p class="\${l.level === 'error' ? 'text-rose-400' : l.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}">
          [\${l.timestamp}] \${l.message}
        </p>
      \`).join('');
    }

    fetchStatus();
  </script>
</body>
</html>`;
  });
}
