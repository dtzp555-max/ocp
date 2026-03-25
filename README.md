# OCP — OpenClaw Control Plane

> **Status: Stable (v3.0.0)** — Feature-complete. Bug fixes only, no new development planned.

> **Already paying for Claude Pro/Max? Use it as your OpenClaw model provider — $0 extra API cost.**

A lightweight, zero-dependency proxy that lets [OpenClaw](https://github.com/openclaw/openclaw) agents talk to Claude through your existing subscription. One command to set up, one file to run. Built-in plan usage monitoring, runtime settings, and a CLI.

## What's New in v3.0.0

### `/ocp` — Your Proxy Command Center

Full management interface available from Telegram, Discord, or any terminal.

```
$ ocp usage
Plan Usage Limits
─────────────────────────────────────
  Current session       3% used
                      Resets in 4h 32m  (Tue, Mar 24, 10:00 PM)

  Weekly (all models)   3% used
                      Resets in 6d 6h  (Tue, Mar 31, 12:00 AM)

  Extra usage         off

Model Stats
Model          Req   OK  Er  AvgT  MaxT  AvgP  MaxP
──────────────────────────────────────────────────────
haiku            1    1   0    6s    6s     0K    0K
opus             2    2   0   20s   26s   42K   43K
sonnet           2    2   0   24s   24s   41K   41K
Total            5

Proxy: up 0h 37m | 5 reqs | 0 err | 0 timeout
```

**All commands:**

```
$ ocp --help
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
```

In **Telegram/Discord**, use `/ocp usage`, `/ocp settings`, etc. — registered as a native slash command via the OCP gateway plugin.

### Runtime Settings (No Restart Needed)

```
$ ocp settings
OCP Settings
─────────────────────────────────────
  timeout                300000 ms      Overall request timeout
  firstByteTimeout        90000 ms      Base first-byte timeout
  maxConcurrent               8         Max concurrent claude processes
  sessionTTL            3600000 ms      Session idle expiry
  maxPromptChars         150000 chars   Prompt truncation limit

Timeout Tiers (first-byte):
  opus     base=150000ms  perChar=0.0005
  sonnet   base=120000ms  perChar=0.0005
  haiku    base= 45000ms  perChar=0.0001
```

Change any setting live:

```
$ ocp settings maxPromptChars 200000
✓ maxPromptChars = 200000

$ ocp settings maxConcurrent 999
✗ maxConcurrent: value 999 out of range [1, 32]
```

### Circuit Breaker Removed

The v2.5.0 circuit breaker has been **removed entirely**. It was designed for direct API connections but caused cascading failures in the CLI-proxy architecture — once API got briefly slow, the breaker blocked ALL agents for 120s+, making the problem worse. With CLI spawning, timeouts are transient and don't benefit from back-off.

### Prompt Truncation Guard

New safety valve prevents runaway context from conversation history accumulation (a recurring issue where prompts balloon from 40K to 400K+ chars).

- Default limit: **150K characters** (configurable via `maxPromptChars`)
- When exceeded: keeps system messages + as many recent messages as fit
- Logs `prompt_truncated` events for monitoring

### Increased Timeouts

| Model | Old Base | New Base | Per 100K chars |
|-------|----------|----------|----------------|
| Opus | 90s | **150s** | +50s |
| Sonnet | 60s | **120s** | +50s |
| Haiku | 30s | **45s** | +10s |

---

## How It Works

```
OpenClaw Gateway → proxy (localhost:3456) → claude -p CLI → Anthropic (via OAuth)
```

The proxy translates OpenAI-compatible `/v1/chat/completions` requests into `claude -p` CLI calls. Anthropic sees normal Claude Code usage under your subscription — no API billing, no separate key.

## Quick Start

```bash
git clone https://github.com/dtzp555-max/ocp.git
cd ocp

# Auto-configure OpenClaw + start proxy + install auto-start
node setup.mjs
```

The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Add `claude-local` provider to `openclaw.json`
3. Start the proxy and install auto-start (launchd on macOS, systemd on Linux)

Then set your preferred model:
```bash
openclaw config set agents.defaults.model.primary "claude-local/claude-sonnet-4-6"
openclaw gateway restart
```

### Install the CLI

The `ocp` command is included in the repo but **not automatically added to PATH**. You need to do one of:

```bash
# Option 1: symlink to PATH (recommended)
sudo ln -sf ~/.openclaw/projects/ocp/ocp /usr/local/bin/ocp

# Option 2: from the repo directory
cd ~/.openclaw/projects/ocp   # or wherever you cloned it
ln -sf $(pwd)/ocp /usr/local/bin/ocp

# Option 3: add to PATH in your shell profile
echo 'export PATH="$HOME/.openclaw/projects/ocp:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify: `ocp --help`

> **Common issue on cloud/Linux servers:** If you get `ocp: command not found`, the repo was cloned but the binary isn't in PATH. Use one of the options above. The full path is typically `~/.openclaw/projects/ocp/ocp`.

### Install the Gateway Plugin (for Telegram/Discord)

Copy the plugin to the OpenClaw extensions directory:

```bash
cp -r ocp-plugin/ ~/.openclaw/extensions/ocp/
# Or into the bundled extensions:
cp -r ocp-plugin/ /opt/homebrew/lib/node_modules/openclaw/dist/extensions/ocp/
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

Restart the gateway: `openclaw gateway restart`

### Upgrading from v2.x (skill-based /ocp)

If you previously used the skill-based `/ocp` command (via `skills/ocp/SKILL.md`), remove it to avoid conflicts:

```bash
# Remove the old skill
rm -rf ~/.openclaw/workspace/main/skills/ocp

# Restart gateway
launchctl kickstart -k gui/501/ai.openclaw.gateway  # macOS
# or: systemctl --user restart openclaw-gateway       # Linux
```

**Why?** The old skill routed `/ocp` to the agent as a prompt (slow, costs tokens). The new plugin handles commands directly in the gateway (instant, free). If both exist, the skill takes priority and you get "Unknown skill" errors.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completion (streaming + non-streaming) |
| `/health` | GET | Comprehensive health check |
| `/usage` | GET | Plan usage limits + per-model stats |
| `/status` | GET | Combined overview (usage + health) |
| `/settings` | GET | View tunable settings |
| `/settings` | PATCH | Update settings at runtime |
| `/logs` | GET | Recent log entries (`?n=20&level=error`) |
| `/sessions` | GET | List active sessions |
| `/sessions` | DELETE | Clear all sessions |

## Available Models

| Model ID | Claude CLI Model | Notes |
|----------|-----------------|-------|
| `claude-opus-4-6` | claude-opus-4-6 | Most capable, slower |
| `claude-sonnet-4-6` | claude-sonnet-4-6 | Good balance of speed/quality |
| `claude-haiku-4` | claude-haiku-4-5-20251001 | Fastest, lightweight |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `300000` | Overall request timeout (ms) |
| `CLAUDE_FIRST_BYTE_TIMEOUT` | `90000` | Base first-byte timeout (ms) |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes |
| `CLAUDE_MAX_PROMPT_CHARS` | `150000` | Prompt truncation limit (chars) |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry (ms, default: 1 hour) |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass all permission checks |
| `CLAUDE_SYSTEM_PROMPT` | *(empty)* | System prompt appended to all requests |
| `CLAUDE_MCP_CONFIG` | *(empty)* | Path to MCP server config JSON |
| `PROXY_API_KEY` | *(unset)* | Bearer token for API authentication |

## Session Management

Multi-turn conversations use `--resume` to avoid resending full history on every request.

Include a `session_id` field in the request body or `X-Session-Id` header:

```json
{
  "model": "claude-sonnet-4-6",
  "session_id": "conv-abc-123",
  "messages": [
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi!"},
    {"role": "user", "content": "What did I just say?"}
  ]
}
```

Sessions expire after 1 hour of inactivity (configurable via `CLAUDE_SESSION_TTL`).

## Security

- **Localhost only** — binds to `127.0.0.1`, not exposed to the network
- **Bearer token auth (optional)** — set `PROXY_API_KEY` to require auth on all requests except `/health`
- **No API keys** — authentication to Anthropic goes through Claude CLI's OAuth session
- **Auto-start** — launchd (macOS) / systemd (Linux) via `node setup.mjs`
- **Remove auto-start**: `node uninstall.mjs`

## Architecture

| | v1.x (pool) | v2.0+ (on-demand) |
|---|---|---|
| Process lifecycle | Pre-spawn idle workers | Spawn per request |
| Crash handling | Backoff spiral | No crash loops |
| Session support | None | `--resume` with tracking |
| Tool access | 6 hardcoded | Configurable, expanded |
| Prompt guard | None | Truncation at 150K chars |
| Monitoring | Basic `/health` | `/usage`, `/status`, `/settings`, `/logs` |
| CLI | None | `ocp` command |
| Gateway plugin | None | `/ocp` slash command |

## Coexistence with Claude Code

OCP and Claude Code interactive mode are completely independent:

| | OCP (this proxy) | Claude Code |
|---|---|---|
| Protocol | HTTP (localhost:3456) | MCP (in-process) |
| Process model | Per-request spawn | Persistent session |
| Lifecycle | Daemon (auto-start) | Requires terminal |
| Use case | Automated agent work | Human-in-the-loop |

Both run on the same machine simultaneously. No shared state, no port conflicts.

## Recovery After OpenClaw Upgrade

```bash
cd ~/.openclaw/projects/claude-proxy
git pull
node setup.mjs
openclaw gateway restart
```

## Changelog

### v3.0.0 (2026-03-24)
- **`/ocp` CLI** — full management from terminal (`ocp usage`, `ocp settings`, etc.)
- **`/ocp` gateway plugin** — native slash command in Telegram/Discord
- **Plan usage monitoring** — real-time session/weekly limits via Anthropic API rate-limit headers
- **Per-model stats** — request count, avg/max elapsed time, avg/max prompt size
- **Runtime settings** — `PATCH /settings` to tune timeouts, concurrency, prompt limits without restart
- **Prompt truncation** — auto-truncate prompts exceeding 150K chars to prevent timeout cascades
- **Circuit breaker removed** — caused more harm than good in CLI-proxy architecture
- **Timeout increases** — Opus 150s, Sonnet 120s, Haiku 45s (base first-byte)
- **New endpoints** — `/usage`, `/status`, `/settings`, `/logs`

### v2.5.0 (2026-03-22)
- Sliding-window circuit breaker (replaced consecutive-count)
- Graduated backoff, multi-probe half-open
- Increased default timeouts for large agent prompts

### v2.0.0
- On-demand spawning (replaced pool architecture)
- Session management with `--resume`
- Full tool access, system prompt, MCP config support

## License

MIT
