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

## Quick Install

```bash
# Clone
git clone https://github.com/dtzp555-max/openclaw-claude-proxy.git
cd openclaw-claude-proxy

# Auto-configure OpenClaw + start proxy
node setup.mjs
```

That's it. The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Add `claude-local` provider to `openclaw.json`
3. Add auth profiles to all agents
4. Start the proxy

Then set your preferred Claude model as default:
```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-opus-4-6"
openclaw gateway restart
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
  "authHeader": false,
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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | `claude` | Path to claude binary |
| `CLAUDE_TIMEOUT` | `120000` | Request timeout (ms) |

## API Endpoints

- `GET /v1/models` — List available models
- `POST /v1/chat/completions` — Chat completion (streaming + non-streaming)
- `GET /health` — Health check

## Auto-start on Login (macOS)

Add to your `~/.zshrc`:
```bash
bash ~/.openclaw/projects/claude-proxy/start.sh 2>/dev/null
```

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
- The `🔑` field in `/status` may show the dummy auth key — this is normal
- Each request spawns a `claude -p` process; concurrent requests are supported
- The proxy must run on the same machine as the Claude CLI (uses local OAuth)
- The same Claude account can be used on multiple machines (shared usage quota)

## License

MIT
