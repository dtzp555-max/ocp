# OCP — Open Claude Proxy

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

## Installation

OCP has two roles: **Server** (runs the proxy, needs Claude CLI) and **Client** (connects to a server, zero dependencies).

```
┌─ Server (always-on device) ─────────────────────────────┐
│  Mac mini / NAS / Raspberry Pi / Desktop                │
│  Claude CLI + OCP server → bound to 0.0.0.0:3456       │
└───────────────────────┬─────────────────────────────────┘
                        │ LAN
    ┌───────────────────┼───────────────────┐
    ▼                   ▼                   ▼
 Laptop             Phone/Tablet        Pi / Server
 (client)           (browser)           (client)
```

---

### Server Setup

> **Recommended:** Install OCP on a device that stays powered on — Mac mini, NAS, Raspberry Pi, or a desktop that doesn't sleep. This ensures all clients always have access.

**Prerequisites:**
- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated (`claude auth login`)

```bash
# 1. Clone and run setup
git clone https://github.com/dtzp555-max/ocp.git
cd ocp
node setup.mjs
```

The setup script will:
1. Verify Claude CLI is installed and authenticated
2. Start the proxy on port 3456
3. Install auto-start (launchd on macOS, systemd on Linux)
4. Symlink `ocp` to `/usr/local/bin` for CLI access

**Single-machine use** — just set your IDE to use the proxy:
```bash
export OPENAI_BASE_URL=http://127.0.0.1:3456/v1
```

**LAN mode** — share with other devices on your network:
```bash
# Enable LAN access with per-user auth (recommended)
node setup.mjs --bind 0.0.0.0 --auth-mode multi
```

Then create API keys for each person/device:
```bash
export OCP_ADMIN_KEY=your-secret-admin-key

ocp keys add wife-laptop
#  ✓ Key created for "wife-laptop"
#    API Key: ocp_xDYzOB9ZKYzn...
#    Copy this key now — you won't see it again.

ocp keys add son-ipad
ocp keys add pi-server
```

Run `ocp lan` to see your IP and ready-to-share instructions.

**Verify:**
```bash
curl http://127.0.0.1:3456/v1/models
# Returns: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4
```

---

### Client Setup

> Clients do **not** need to install Node.js, Claude CLI, or the OCP repo. Only `curl` and `python3` are required (pre-installed on most Linux/Mac systems).

**One-command setup** — download the lightweight `ocp-connect` script:

```bash
curl -fsSL https://raw.githubusercontent.com/dtzp555-max/ocp/main/ocp-connect -o ocp-connect
chmod +x ocp-connect
./ocp-connect <server-ip>
```

**Zero-config** — when the server admin has set `PROXY_ANONYMOUS_KEY` (see [Anonymous Access](#anonymous-access-optional) below), just pass the server IP and nothing else. `ocp-connect` reads the anonymous key from `/health` and uses it automatically:

```bash
./ocp-connect <server-ip>
```

If the server requires a key, pass it with `--key`:
```bash
./ocp-connect <server-ip> --key <your-api-key>
```

Or as a one-liner (no file saved):
```bash
curl -fsSL https://raw.githubusercontent.com/dtzp555-max/ocp/main/ocp-connect | bash -s -- <server-ip>
```

Example:
```
$ ./ocp-connect 192.168.1.100

OCP Connect v1.3.0
─────────────────────────────────────
  Remote: http://192.168.1.100:3456

  Checking connectivity...
  ✓ Connected

  Remote OCP v3.8.0  (auth: multi)

  ⓘ Using server-advertised anonymous key: ocp_publ...n_v1
    (set by admin via PROXY_ANONYMOUS_KEY; see issue #12 §14 Path A)

  Testing API access...
  ✓ API accessible (3 models available)

  Shell config:
    ✓ .bashrc
    ✓ .zshrc
    OPENAI_BASE_URL=http://192.168.1.100:3456/v1

  System-level (launchctl):
    ✓ OPENAI_BASE_URL set for GUI apps and daemons

  IDE Configuration
  ─────────────────────────────────────
  Detected: OpenClaw (~/.openclaw/openclaw.json)

  Configure OpenClaw to use this OCP? [Y/n] y
  Provider name (models show as <name>/model-id) [ocp]: ocp

  How should OCP models be configured?
    1) Primary — use OCP by default, keep existing models as backup
    2) Backup  — keep current primary, add OCP as additional option

  Choice [1]: 1

  Writing OpenClaw config...
    ✓ Per-agent auth profile seeded (2):
      • ~/.openclaw/agents/main/agent/auth-profiles.json
      • ~/.openclaw/agents/macbook_bot/agent/auth-profiles.json
  ✓ OpenClaw configured
    Provider: ocp
    Models:
      • ocp/claude-opus-4-6
      • ocp/claude-sonnet-4-6
      • ocp/claude-haiku-4-5-20251001
    Priority: PRIMARY (default model)

    Restart OpenClaw to apply: openclaw gateway restart

  Running smoke test...
  ✓ Smoke test passed: OK
    Note: smoke test only verifies OCP is reachable and the key is valid.
    It does not verify your IDE/agent end-to-end. To verify OpenClaw works,
    restart it (`openclaw gateway restart`) and send a test message to your bot.

  Done. Reload your shell to apply:
    source ~/.zshrc
```

The script automatically:
- Writes env vars to all relevant shell rc files (`.bashrc`, `.zshrc`)
- Sets system-level env vars (`launchctl setenv` on macOS, `environment.d` on Linux)
- **Auto-discovers anonymous key** from `/health.anonymousKey` when no `--key` given (v1.3.0+, requires server v3.8.0+)
- Configures OpenClaw automatically (including per-agent `auth-profiles.json` for multi-agent setups)
- Detects Cline, Continue.dev, Cursor, and opencode, and prints setup hints (manual configuration required for these IDEs)

On macOS, `launchctl setenv` vars reset on reboot — re-run `ocp-connect` after restart.

**Manual setup** — if you prefer not to use the script:
```bash
export OPENAI_BASE_URL=http://<server-ip>:3456/v1
export OPENAI_API_KEY=ocp_<your-key>
```
Add these lines to `~/.bashrc` or `~/.zshrc` to persist across sessions.

---

### Monitoring (Server-side)

```bash
# Per-key usage stats
ocp usage --by-key
#  Key                  Reqs   OK  Err  Avg Time
#  wife-laptop             5    5    0      8.0s
#  son-ipad                3    3    0      6.2s

# Manage keys
ocp keys              # List all keys
ocp keys revoke son-ipad   # Revoke a key
```

**Web Dashboard:** Open `http://<server-ip>:3456/dashboard` in any browser for real-time monitoring — per-key usage, request history, plan utilization, and system health.

![OCP Dashboard](docs/images/dashboard.png)

### Auth Modes

| Mode | Env | Use Case |
|------|-----|----------|
| `none` | `CLAUDE_AUTH_MODE=none` | Trusted home network, no auth needed |
| `shared` | `CLAUDE_AUTH_MODE=shared` + `PROXY_API_KEY=xxx` | Everyone shares one key |
| `multi` | `CLAUDE_AUTH_MODE=multi` + `OCP_ADMIN_KEY=xxx` | Per-person keys with usage tracking (recommended) |

### Anonymous Access (optional)

In `multi` mode, the admin can designate a single well-known "anonymous" key that bypasses `validateKey()` and grants public read/write access. This is useful for letting LAN users (or clients like OpenClaw multi-agent setups) connect without individual per-user keys.

**Enable**:

```bash
export PROXY_ANONYMOUS_KEY=ocp_public_anon   # or any string of your choice
ocp start                                    # or however you start the server
```

**Client side**: the anonymous key value is exposed via `GET /health` as the field `anonymousKey` (null when not set). Clients like `ocp-connect` can auto-discover and use it, so the end user doesn't need to get a personal key from the admin.

**Security note**: setting this env var is an **opt-in** to public access — anyone who can reach your OCP endpoint can use it, up to any rate limits you configure. Don't enable this on internet-exposed OCP instances without additional protection.

**Not a secret**: because `/health` is an unauthenticated endpoint, the anonymous key is **publicly readable** by anyone who can reach the server. That is intentional — the key exists so clients can self-configure without out-of-band coordination. Treat it as a convenience handle, not as an access credential.

### Per-Key Quota (Budget Control)

Prevent any single user from exhausting your subscription. Set daily, weekly, or monthly request limits per API key:

```bash
# Set a daily limit of 50 requests for a key
curl -X PATCH http://127.0.0.1:3456/api/keys/wife-laptop/quota \
  -H "Authorization: Bearer $OCP_ADMIN_KEY" \
  -d '{"daily": 50}'

# Set multiple limits at once
curl -X PATCH http://127.0.0.1:3456/api/keys/son-ipad/quota \
  -H "Authorization: Bearer $OCP_ADMIN_KEY" \
  -d '{"daily": 20, "weekly": 100}'

# Check current quota + usage
curl http://127.0.0.1:3456/api/keys/wife-laptop/quota
# → { "daily": { "limit": 50, "used": 12 }, "weekly": { "limit": null, "used": 34 }, ... }

# Remove a limit (set to null)
curl -X PATCH http://127.0.0.1:3456/api/keys/wife-laptop/quota \
  -d '{"daily": null}'
```

When a key exceeds its quota, OCP returns HTTP 429 with a structured error:
```json
{
  "error": {
    "message": "Quota exceeded: 50/50 requests (daily). Resets 6h 12m.",
    "type": "quota_exceeded",
    "quota": { "period": "daily", "limit": 50, "used": 50, "resetsIn": "6h 12m" }
  }
}
```

- `null` = unlimited (default for all keys)
- Only successful requests count toward quota
- Admin and anonymous users are never subject to quotas
- PATCH is a partial update — omitted fields are left unchanged

### Important Notes

- All users share your Claude Pro/Max **rate limits** (5h session + 7d weekly)
- `ocp usage` shows how much quota remains
- Keys are stored in `~/.ocp/ocp.db` (SQLite, zero external dependencies)
- Admin key is required for key management API endpoints
- The dashboard (`/dashboard`) and health check (`/health`) are always public

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
ocp usage --by-key     Per-key usage breakdown (LAN mode)
ocp status             Quick overview
ocp health             Proxy diagnostics
ocp keys               List all API keys (multi mode)
ocp keys add <name>    Create a new API key
ocp keys revoke <name> Revoke an API key
ocp connect <ip>       One-command LAN client setup
ocp lan                Show LAN connection info & IP
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

## Response Cache

OCP can cache responses to avoid redundant Claude CLI calls for identical prompts. This is useful during development when the same prompt is sent repeatedly.

**Enable** by setting `CLAUDE_CACHE_TTL` (in milliseconds):

```bash
# Cache responses for 5 minutes
export CLAUDE_CACHE_TTL=300000

# Or update at runtime (no restart)
ocp settings cacheTTL 300000
```

**How it works:**
- Cache key = SHA-256 of `model` + `messages` + `temperature` + `max_tokens` + `top_p`
- Cache hits return instantly — no Claude CLI process spawned
- Works for both streaming and non-streaming requests
- Multi-turn conversations (with `session_id`) are never cached
- Expired entries are cleaned up automatically every 10 minutes

**Management:**
```bash
# View cache stats
curl http://127.0.0.1:3456/cache/stats
# → { "entries": 42, "totalHits": 156, "sizeBytes": 284000 }

# Clear all cached responses
curl -X DELETE http://127.0.0.1:3456/cache

# Disable cache at runtime
ocp settings cacheTTL 0
```

Cache is **disabled by default** (`CLAUDE_CACHE_TTL=0`). All data is stored locally in `~/.ocp/ocp.db`.

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
| `claude-haiku-4-5-20251001` | Fastest, lightweight |

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
| `/dashboard` | GET | Web dashboard (always public) |
| `/api/keys` | GET/POST | List or create API keys (admin only) |
| `/api/keys/:id` | DELETE | Revoke an API key (admin only) |
| `/api/keys/:id/quota` | GET/PATCH | View or set per-key quota (admin only) |
| `/api/usage` | GET | Per-key usage stats (`?since=&until=&hours=&limit=`) |
| `/cache/stats` | GET | Cache statistics (admin only) |
| `/cache` | DELETE | Clear response cache (admin only) |

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

### Telegram / Discord Usage

After installing the gateway plugin, use `/ocp` slash commands in your chat:

```
/ocp status        — Quick overview
/ocp usage         — Plan usage limits & model stats
/ocp models        — Available models
/ocp health        — Proxy diagnostics
/ocp keys          — List all API keys (multi mode)
/ocp keys add <name>   — Create a new key
/ocp keys revoke <name> — Revoke a key
```

> **Note:** Terminal CLI uses `ocp <command>`, Telegram/Discord uses `/ocp <command>`.

## Troubleshooting

### Requests fail or agents stuck

```bash
# Clear sessions and restart
ocp clear
ocp restart

# If using OpenClaw gateway
openclaw gateway restart
```

### Usage shows "unknown"

Usually caused by an expired Claude CLI session. Fix:
```bash
claude auth login
ocp restart
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port |
| `CLAUDE_BIND` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `CLAUDE_AUTH_MODE` | `none` | Auth mode: `none`, `shared`, or `multi` |
| `OCP_ADMIN_KEY` | *(unset)* | Admin key for key management (multi mode) |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `600000` | Request timeout (ms, default: 10 min) |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes |
| `CLAUDE_MAX_PROMPT_CHARS` | `150000` | Prompt truncation limit (chars) |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry (ms, default: 1 hour) |
| `CLAUDE_CACHE_TTL` | `0` | Response cache TTL (ms, 0 = disabled). Set to e.g. `300000` for 5-min cache |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass all permission checks |
| `CLAUDE_NO_CONTEXT` | `false` | Suppress CLAUDE.md and auto-memory injection (pure API mode) |
| `PROXY_API_KEY` | *(unset)* | Bearer token for shared-mode authentication |
| `PROXY_ANONYMOUS_KEY` | *(unset)* | Well-known anonymous key allowlist (multi mode). When set, this exact string bypasses `validateKey()` and grants public access. Exposed via `/health.anonymousKey` so clients auto-discover. See [Anonymous Access](#anonymous-access-optional). |

## Security

- **Localhost by default** — binds to `127.0.0.1`; set `CLAUDE_BIND=0.0.0.0` to enable LAN access
- **3-tier auth** — `none` (trusted network), `shared` (single key), `multi` (per-user keys with usage tracking)
- **Timing-safe key comparison** — prevents timing attacks on API keys and admin keys
- **Admin-only key management** — creating, listing, and revoking keys requires the admin key
- **Public endpoints** — `/health` and `/dashboard` are always accessible without auth
- **No API keys needed** — authentication goes through Claude CLI's OAuth session
- **Keys stored locally** — `~/.ocp/ocp.db` (SQLite), never sent to external services
- **Auto-start** — launchd (macOS) / systemd (Linux)

## License

MIT
