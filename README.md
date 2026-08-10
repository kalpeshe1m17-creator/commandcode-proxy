# ⚡ CommandCode OpenAI Proxy Gateway v3.0

> **Reverse-engineered, high-performance OpenAI Chat Completions & Anthropic Messages API gateway for [Command Code AI](https://commandcode.ai).**  
> Drop-in replacement for any OpenAI-compatible AI client — Cursor, Continue, Roo Code, Aider, OpenWebUI, Hermes, and more.

---

## 🌟 Key Features

| Feature | Details |
| :--- | :--- |
| ⚡ **Official CLI Wire Protocol** | Reverse-engineered from `cli.mjs` — exact payload schema, headers, and event decoder |
| 🛡️ **Hardcoded Auto-Accept Mode** | `permissionMode: "auto-accept"` — no model ever stops for permission prompts |
| 🧠 **8-Level Reasoning Engine** | Maps `none/minimal/low/medium/high/xhigh/max/ultra` per official per-model capability table from CLI source |
| 🔄 **Multi-Account OAuth** | Browser OAuth login + manual API key + 30-min auto-quota switcher (≥90% 5-Hour limit) |
| 📊 **Live Credits Dashboard** | Real-time 5-Hour / Weekly / Monthly window limits from `/alpha/billing/credits` |
| 🚀 **Zero-Error Stream Termination** | No `[Upstream Error: ...]` bleed — clean `finish_reason: stop` + `[DONE]` always |
| 🔌 **Long-Session Safe** | TCP `setKeepAlive`, 15s SSE heartbeat ping, `X-Accel-Buffering: no`, zero socket timeouts |
| 🌐 **52+ Model Catalog** | Auto-fetched at startup with vendor prefix resolution (`anthropic:laguna-s-2.1-free` → `poolside/laguna-s-2.1-free`) |
| ❌ **Abort Protection** | Upstream cancelled only on genuine premature disconnect (`destroyed && !complete`) — never on normal completion |

---

## 🔌 API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | OpenAI Chat Completions (streaming + non-streaming) |
| `/v1/messages` | `POST` | Anthropic Messages API compatibility |
| `/v1/models` | `GET` | OpenAI-compatible model list |
| `/v1/models/:id` | `GET` | Single model lookup |
| `/` | `GET` | Web Controller GUI Dashboard |
| `/api/status` | `GET` | Gateway status + active account |
| `/api/accounts` | `GET` | Registered accounts |
| `/api/usage/aggregate` | `GET` | Live quota & usage analytics |
| `/health` | `GET` | Health check |

---

## 🧠 Reasoning Effort Mapping

Official per-model effort capability table reverse-engineered from `cli.mjs` (`Vo`, `tr` constants):

| Client Input | `gpt-5.6-luna / claude-sonnet-5` | `deepseek-v4-pro` | `gemini-3.6-flash` |
| :---: | :---: | :---: | :---: |
| `none` / `minimal` / `low` | `low` | `high` | `low` |
| `medium` | `medium` | `high` | `medium` |
| `high` | `high` | `high` | `high` |
| `xhigh` | `xhigh` | `high` | `high` |
| `max` / `ultra` | `max` | `max` | `high` |

Supports all 8 Hermes thinking levels (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`) and Anthropic `thinking.budget_tokens`.

---

## 🚀 Quick Start

### Option 1 — Windows Standalone Executable (Recommended)

Download `commandcode-proxy-v3.exe` from the [**Releases**](../../releases) page and run it:

```cmd
commandcode-proxy-v3.exe
```

The proxy opens `http://localhost:9090` automatically. Add your Command Code API key or log in via OAuth browser flow in the GUI.

### Option 2 — Run from Source

```bash
git clone https://github.com/kalpeshe1m17-creator/commandcode-proxy-v3.git
cd commandcode-proxy-v3
npm install
npm run dev
```

### Option 3 — Production build

```bash
npm run build      # TypeScript compile
npm run build:exe  # esbuild bundle → dist/bundle.cjs
npm test           # Run unit tests
```

---

## ⚙️ Configure Your AI Client

Point any OpenAI-compatible client to:

```
Base URL:  http://localhost:9090/v1
API Key:   any-string   (proxy handles auth)
```

**Cursor**: Settings → Models → OpenAI API Key → `any-key` → Base URL → `http://localhost:9090/v1`  
**Continue**: `config.json` → `"apiBase": "http://localhost:9090/v1"`  
**Hermes**: `~/.hermes/config.yaml` → `base_url: http://localhost:9090/v1`  
**OpenWebUI**: Admin → Connections → OpenAI API → `http://localhost:9090/v1`  

---

## 📂 Project Structure

```
commandcode-proxy-v3/
├── src/
│   ├── adapters/commandcode/
│   │   ├── adapter.ts        # OpenAI/Anthropic → CC wire protocol translator
│   │   └── upstream.ts       # fetch() wrapper with abort + logging
│   ├── routes/
│   │   ├── chat.ts           # POST /v1/chat/completions
│   │   ├── messages.ts       # POST /v1/messages (Anthropic)
│   │   ├── models.ts         # GET /v1/models
│   │   └── dashboard.ts      # Controller GUI + API endpoints
│   ├── utils/
│   │   ├── config.ts         # Config, accounts, OAuth, quota rotation
│   │   ├── models.ts         # Model catalog fetch + cache
│   │   └── logger.ts         # Timestamped console logger
│   ├── types/index.ts        # Full TypeScript type definitions
│   └── index.ts              # Fastify server entrypoint
├── tests/
│   └── gateway.test.ts       # Vitest unit tests
└── build/
    └── commandcode-proxy-v3.exe  # Windows launcher (from Releases)
```

---

## 🔒 Security & Privacy

- `config.json` (API keys, account tokens) is **gitignored** — never committed
- `models.json` (model cache) is **gitignored**
- `.env` files are **gitignored**
- All authentication is stored locally on your machine only

---

## 📋 Changelog

### v3.0.0
- Full reverse-engineering of official `cli.mjs` wire protocol
- Official reasoning effort model capability map (`Vo`/`tr` constants)
- Hardcoded `permissionMode: "auto-accept"` — no permission prompts ever
- 8-level Hermes thinking option mapping (`ultra` → `max`)
- Long-session TCP keep-alive + 15s SSE heartbeat
- Abort guard: only cancels on genuine premature disconnect
- Clean `[INPUT]` / `[OUTPUT]` log format
- Full Anthropic Messages API: `thinking_delta`, `tool_use` blocks, `message_delta`
- Fixed tool-call wire fields: `h.toolName`, `h.toolCallId`, `h.input ?? h.args` (no `data` wrapper)
- `finishReason` normalization: `tool-calls` → `tool_calls`, `length` → `length`

---

## 📜 License

MIT License. See [LICENSE](LICENSE) for details.
