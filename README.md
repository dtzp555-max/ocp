# openclaw-claude-proxy

> **Already paying for Claude Pro/Max? Use it as your OpenClaw model provider — $0 extra API cost.**

A lightweight, zero-dependency proxy that lets [OpenClaw](https://github.com/openclaw/openclaw) agents talk to Claude through your existing subscription. One command to set up, one file to run.

**Why?**
- **$0 API cost** — uses your Claude Pro/Max subscription, not pay-per-token API
- **Zero dependencies** — single Node.js file, no `npm install`
- **One command setup** — `node setup.mjs` handles everything
- **OpenAI-compatible** — standard `/v1/chat/completions` endpoint
- **All Claude models** — Opus 4.6, Sonnet 4.6, Haiku 4
- **Streaming support** — real-time SSE responses

## How it works

```
OpenClaw Gateway → proxy (localhost:3456) → claude -p CLI → Anthropic (via OAuth)
```

The proxy translates OpenAI-compatible `/v1/chat/completions` requests into `claude -p` CLI calls. Anthropic sees normal Claude Code usage under your subscription — no API billing, no separate key.

## Prerequisites

- **Node.js** ≥ 18
- **Claude CLI** installed and authenticated (`claude login`)
- **OpenClaw** installed

## Quick Start (Node.js)

```bash
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# Auto-configure OpenClaw + start proxy + install auto-start
node setup.mjs
```

That's it. The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Add `claude-local` provider to `openclaw.json`
3. Add auth profiles to all agents
4. Start the proxy
5. Install auto-start on login (launchd on macOS, systemd on Linux)

Then set your preferred Claude model as default:
```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Security

- **Localhost only** — the proxy binds to `127.0.0.1` and is not exposed to the internet or your local network
- **Bearer token auth (optional)** — set `PROXY_API_KEY` to require a Bearer token on all requests (except `/health`). When unset, auth is disabled for backwards compatibility
- **No API keys for Claude** — authentication to Anthropic goes through Claude CLI's OAuth session, no Anthropic credentials are stored in the proxy
- **Auto-start via launchd/systemd** — `node setup.mjs` installs a user-level launch agent (macOS) or systemd user service (Linux) so the proxy starts automatically on login
- **Remove auto-start** at any time:

```bash
node uninstall.mjs
```

## Manual Install

### 1. Start the proxy

```bash
node server.mjs
# or in background:
bash start.sh
```

### 2. Configure OpenClaw

Add to `~/.openclaw/openclaw.json` under `models.providers`:

```json
"claude-local": {
  "baseUrl": "http://127.0.0.1:3456/v1",
  "api": "openai-completions",
  "apiKey": "<your PROXY_API_KEY, or omit if auth disabled>",
  "models": [
    {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "reasoning": true,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 16384
    },
    {
      "id": "claude-haiku-4",
      "name": "Claude Haiku 4",
      "reasoning": false,
      "input": ["text"],
      "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "contextWindow": 200000,
      "maxTokens": 8192
    }
  ]
}
```

### 3. Set as default model

```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
```

## Available Models

| Model ID | Claude CLI model | Notes |
|----------|-----------------|-------|
| `claude-opus-4-6` | opus | Most capable, slower |
| `claude-sonnet-4-6` | sonnet | Good balance of speed/quality |
| `claude-haiku-4` | haiku | Fastest, lightweight |

## Authentication

The proxy supports optional Bearer token authentication via the `PROXY_API_KEY` environment variable.

**When `PROXY_API_KEY` is set**, all requests (except `GET /health`) must include a valid `Authorization: Bearer <token>` header. Requests with a missing or invalid token receive a `401 Unauthorized` response.

**When `PROXY_API_KEY` is not set**, authentication is disabled and all requests are accepted (backwards compatible with v1.6.x and earlier).

```bash
# Start with auth enabled
PROXY_API_KEY=my-secret-token node server.mjs

# Configure OpenClaw provider with the matching key
# In openclaw.json, set apiKey under the claude-local provider:
"claude-local": {
  "baseUrl": "http://127.0.0.1:3456/v1",
  "api": "openai-completions",
  "apiKey": "my-secret-token",
  ...
}
```

The proxy logs auth status on startup: `Auth: enabled (PROXY_API_KEY set)` or `Auth: disabled (no PROXY_API_KEY)`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | `claude` | Path to claude binary |
| `CLAUDE_TIMEOUT` | `120000` | Request timeout (ms) |
| `PROXY_API_KEY` | *(unset)* | Bearer token for API authentication; when unset, auth is disabled |

## API Endpoints

- `GET /v1/models` — List available models
- `POST /v1/chat/completions` — Chat completion (streaming + non-streaming)
- `GET /health` — Health check

## Server / Advanced: Docker

For server deployments or if you prefer Docker:

```bash
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git
cd openclaw-claude-proxy
cp .env.example .env   # add your CLAUDE_SESSION_TOKEN / CLAUDE_COOKIES
docker compose up -d
```

Or as a single command if you already have a `.env` ready:

```bash
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git && cd openclaw-claude-proxy && docker compose up -d
```

Health check: `curl http://localhost:3456/health`

## Recovery after OpenClaw upgrade

OpenClaw upgrades (`npm update -g openclaw`) **do not overwrite** the user config at `~/.openclaw/openclaw.json`. However, if the claude-local models stop working after an upgrade, follow these steps:

### Quick diagnosis

```bash
# 1. Check if proxy is running
curl http://127.0.0.1:3456/health
# Expected: {"status":"ok"}

# 2. Verify Claude CLI works
claude -p "hello" --model sonnet --output-format text
# Expected: text response

# 3. Verify OpenClaw config
cat ~/.openclaw/openclaw.json | grep -A3 claude-local
```

### Common issues and fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent doesn't reply, no proxy logs | Gateway didn't load claude-local provider | Check `models.providers.claude-local` in `openclaw.json` |
| Proxy reports `exit 1` | Claude CLI not logged in or token expired | Run `claude login` to re-authenticate |
| `🔑 unknown` in `/status` | Normal — no API key, using OAuth | Does not affect functionality, safe to ignore |
| `/status` shows Context 0% | Messages not reaching proxy (SSE format issue) | Ensure proxy is latest version with streaming support |
| Gateway reports `invalid api type` | OpenClaw renamed API type in new version | Check `api` field is still valid (e.g., `openai-completions`) |
| Proxy startup `EADDRINUSE` | Port 3456 already in use | `lsof -i :3456` to find and kill the old process |

### One-command recovery

```bash
cd ~/.openclaw/projects/claude-proxy   # or wherever you cloned it
git pull                                # pull latest version
node setup.mjs                          # reconfigure OpenClaw + start proxy
openclaw gateway restart
```

### Pre-upgrade backup (recommended)

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak
```

## Notes

- Cost shows as $0 because billing goes through your Claude subscription
- The `🔑` field in `/status` shows the configured auth key (or `unknown` if auth is disabled) — this is normal
- Each request spawns a `claude -p` process; concurrent requests are supported
- The proxy must run on the same machine as the Claude CLI (uses local OAuth)
- The same Claude account can be used on multiple machines (shared usage quota)

## License

MIT
