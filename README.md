# ⚡ CommandCode OpenAI Proxy Gateway v3.0

An enterprise-grade, high-performance OpenAI Chat Completions & Anthropic Messages API gateway reverse-engineered from the official Command Code CLI wire protocol (`cli.mjs`).

Built with **Fastify**, **TypeScript**, and **esbuild**, this proxy allows any OpenAI-compatible AI client, coding agent, or IDE (Cursor, Continue, Roo Code, Aider, OpenWebUI, etc.) to seamlessly interact with Command Code's multi-provider AI model catalog.

---

## 🌟 Key Features

- ⚡ **Reverse-Engineered Official CLI Protocol**: Fully aligned with Command Code CLI `/alpha/generate` payload schema, headers (`x-session-id`, `x-project-slug`, `x-cli-environment`), and tool definition converters.
- 🛡️ **Hardcoded Auto-Accept Mode**: Pre-configured to `"auto-accept"` wire permission mode so autonomous coding agents and sub-agents run unattended without stopping for permission prompts.
- 🧠 **7-Level Reasoning Engine**: Native support for DeepSeek, Grok, Qwen, GLM, Laguna, and Claude reasoning models (`reasoning_content`), Anthropic `thinking` budgets, and real-time `<think>...</think>` tag extraction.
- 🔄 **Multi-Account OAuth & Auto-Quota Protection**:
  - Built-in OAuth browser login flow (`https://commandcode.ai/studio/auth/cli`).
  - Automatic 30-minute background quota monitoring.
  - Auto-switches active accounts when a account's 5-Hour quota reaches $\ge 90\%$.
- 📊 **Real-Time Credits & Window Limit Meters**: Live dashboard displaying 5-Hour window limits, Weekly window limits, Monthly credits, and lifetime token consumption across all registered accounts.
- 🚀 **Zero-Empty-Stream Error Diagnostics**: Eliminates blank streaming tokens in IDEs by propagating upstream error diagnostics (such as plan restrictions or server errors) directly into the SSE stream.
- 🌐 **52+ Dynamic Model Catalog**: Automatic startup fetching and persistence (`models.json`) of Command Code's model catalog with vendor prefix resolution (`anthropic:laguna-s-2.1-free` $\rightarrow$ `poolside/laguna-s-2.1-free`).

---

## 🔌 API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `POST /v1/chat/completions` | `POST` | Standard OpenAI Chat Completions API (Streaming & Non-Streaming) |
| `POST /v1/messages` | `POST` | Anthropic Messages API compatibility layer |
| `GET /v1/models` | `GET` | OpenAI-compatible Model List API |
| `GET /` | `GET` | Web Controller GUI Dashboard |
| `GET /api/status` | `GET` | Gateway Server Status & Account Statistics |
| `GET /api/accounts` | `GET` | Registered Multi-Account List |
| `GET /api/usage/aggregate` | `GET` | Live Quota & Usage Analytics |

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **Command Code Account / API Key**: Obtain via Command Code CLI or Studio.

### 2. Installation & Running from Source
```bash
# Clone the repository
git clone https://github.com/kalpeshe1m17-creator/commandcode-proxy-v3.git
cd commandcode-proxy-v3

# Install dependencies
npm install

# Run in development mode
npm run dev

# Run unit tests
npm test
```

### 3. Running Standalone Windows Executable
You can run the pre-compiled, self-contained binary on Windows without needing Node.js installed:
```cmd
.\build\commandcode-proxy-v3.exe
```

---

## ⚙️ Configuration

The server automatically loads configuration from `config.json` in the root directory:

```json
{
  "port": 9090,
  "activeAccountId": "acc_default",
  "rotationMode": "manual",
  "permissionMode": "auto-accept",
  "accounts": [
    {
      "id": "acc_default",
      "name": "Default System Account",
      "apiKey": "user_..."
    }
  ]
}
```

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for details.
