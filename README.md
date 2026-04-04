# OCP — Open Claude Proxy

> **Status: Stable (v3.3.1)** — Feature-complete. Bug fixes only.

> **Already paying for Claude Pro/Max? Use your subscription as an OpenAI-compatible API — $0 extra cost.**

OCP turns your Claude Pro/Max subscription into a standard OpenAI-compatible API on localhost. Any tool that speaks the OpenAI protocol can use it — no separate API key, no extra billing.

```
Cline          ──┐
OpenCode       ───┤
Aider          ───┼──→ OCP :3456 ──→ Claude CLI ──→ Your subscription
Continue.dev   ───┤
OpenClaw       ───┘
```

One proxy. Multiple IDEs. All models. **$0 API cost.**

## Supported Tools

Any tool that accepts `OPENAI_BASE_URL` works with OCP:

| Tool | Configuration |
|------|--------------|
| **Cline** | Settings → `OPENAI_BASE_URL=http://127.0.0.1:3456/v1` |
| **OpenCode** | `OPENAI_BASE_URL=http://127.0.0.1:3456/v1` |
| **Aider** | `aider --openai-api-base http://127.0.0.1:3456/v1` |
| **Continue.dev** | config.json → `apiBase: "http://127.0.0.1:3456/v1"` |
| **OpenClaw** | `setup.mjs` auto-configures |
| **Any OpenAI client** | Set base URL to `http://127.0.0.1:3456/v1` |

## Quick Start

```bash
git clone https://github.com/dtzp555-max/ocp.git
cd ocp
node setup.mjs
```

The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Start the proxy on port 3456
3. Install auto-start (launchd on macOS, systemd on Linux)

Then point your IDE to the proxy:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3456/v1
```

### Verify

```bash
curl http://127.0.0.1:3456/v1/models
# Returns: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4
```

## Built-in Usage Monitoring

Check your subscription usage from the terminal:

```
$ ocp usage
Plan Usage Limits
─────────────────────────────────────
  Current session       21% used
                      Resets in 3h 12m  (Tue, Mar 28, 10:00 PM)

  Weekly (all models)   45% used
                      Resets in 4d 2h  (Tue, Mar 31, 12:00 AM)

  Extra usage         off

Model Stats
Model          Req   OK  Er  AvgT  MaxT  AvgP  MaxP
──────────────────────────────────────────────────────
opus             5    5   0   32s   87s   42K   43K
sonnet          18   18   0   20s   45s   36K   56K
Total           23

Proxy: up 6h 32m | 23 reqs | 0 err | 0 timeout
```

### All Commands

```
ocp usage              Plan usage limits & model stats
ocp status             Quick overview
ocp health             Proxy diagnostics
ocp settings           View tunable settings
ocp settings <k> <v>   Update a setting at runtime
ocp logs [N] [level]   Recent logs (default: 20, error)
ocp models             Available models
ocp sessions           Active sessions
ocp clear              Clear all sessions
ocp restart            Restart proxy
ocp restart gateway    Restart gateway
ocp update             Update to latest version
ocp update --check     Check for updates without applying
ocp --help             Command reference
```

### Install the CLI

```bash
# Symlink to PATH (recommended)
sudo ln -sf $(pwd)/ocp /usr/local/bin/ocp

# Verify
ocp --help
```

> **Cloud/Linux servers:** If `ocp: command not found`, the binary isn't in PATH. Full path: `~/.openclaw/projects/ocp/ocp`

### Self-Update

```bash
# Check if a new version is available
ocp update --check

# Pull latest, sync plugin, restart proxy — one command
ocp update
```

### Runtime Settings (No Restart Needed)

```
$ ocp settings maxPromptChars 200000
✓ maxPromptChars = 200000

$ ocp settings maxConcurrent 4
✓ maxConcurrent = 4
```

## How It Works

```
Your IDE → OCP (localhost:3456) → claude -p CLI → Anthropic (via subscription)
```

OCP translates OpenAI-compatible `/v1/chat/completions` requests into `claude -p` CLI calls. Anthropic sees normal Claude Code usage — no API billing, no separate key needed.

## Available Models

| Model ID | Notes |
|----------|-------|
| `claude-opus-4-6` | Most capable, slower |
| `claude-sonnet-4-6` | Good balance of speed/quality |
| `claude-haiku-4` | Fastest, lightweight |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completion (streaming + non-streaming) |
| `/health` | GET | Comprehensive health check |
| `/usage` | GET | Plan usage limits + per-model stats |
| `/status` | GET | Combined overview (usage + health) |
| `/settings` | GET/PATCH | View or update settings at runtime |
| `/logs` | GET | Recent log entries (`?n=20&level=error`) |
| `/sessions` | GET/DELETE | List or clear active sessions |

## OpenClaw Integration

OCP was originally built for [OpenClaw](https://github.com/openclaw/openclaw) and includes deep integration:

- **`setup.mjs`** auto-configures the `claude-local` provider in `openclaw.json`
- **Gateway plugin** registers `/ocp` as a native slash command in Telegram/Discord
- **Multi-agent** — 8 concurrent requests sharing one subscription
- **No conflicts** — uses neutral service names (`dev.ocp.proxy` / `ocp-proxy`) that don't trigger OpenClaw's gateway-like service detection

### Install the Gateway Plugin

```bash
cp -r ocp-plugin/ ~/.openclaw/extensions/ocp/
```

Add to `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "allow": ["ocp"],
    "entries": { "ocp": { "enabled": true } }
  }
}
```

Restart: `openclaw gateway restart`

## Troubleshooting

### Requests fail with exit 143 / SIGTERM after ~60 seconds

**Symptom:** Claude returns errors or stops responding after about 60 seconds, especially during tool use (Bash, Read, etc.).

**Cause:** OpenClaw's gateway has a default `idleTimeoutSeconds` of 60 seconds. When Claude calls tools, the token stream pauses while the tool executes — if that takes longer than 60s, the gateway kills the connection.

**Fix:** `setup.mjs` (v3.2.1+) sets this automatically. If you installed an older version, add this to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "llm": {
        "idleTimeoutSeconds": 0
      }
    }
  }
}
```

Then restart: `openclaw gateway restart`

### Agents stuck in "typing" but never respond

Usually caused by stuck sessions from previous timeout errors. Fix:

```bash
# Clear all sessions
ocp clear

# Restart both services
ocp restart
openclaw gateway restart
```

If that doesn't help, manually clear the session store:
```bash
# Find and reset stuck Telegram sessions
cat ~/.openclaw/agents/main/sessions/sessions.json
# Remove entries with "telegram" channel, then restart gateway
```

## Upgrading from v3.0.x

If you installed OCP before v3.1.0, the auto-start service used names that OpenClaw's gateway detected as conflicting (`ai.openclaw.proxy` on macOS, `openclaw-proxy` on Linux). Running `node setup.mjs` or `ocp update` will automatically migrate to the new neutral names.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `600000` | Request timeout (ms, default: 10 min) |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes |
| `CLAUDE_MAX_PROMPT_CHARS` | `150000` | Prompt truncation limit (chars) |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry (ms, default: 1 hour) |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass all permission checks |
| `PROXY_API_KEY` | *(unset)* | Bearer token for API authentication |

## Security

- **Localhost only** — binds to `127.0.0.1`, not exposed to the network
- **Bearer token auth (optional)** — set `PROXY_API_KEY` to require auth
- **No API keys needed** — authentication goes through Claude CLI's OAuth session
- **Auto-start** — launchd (macOS) / systemd (Linux)

## License

MIT
