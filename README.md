# OCP — Open Claude Proxy

> **Status: Stable (v3.6.0)** — Feature-complete. Bug fixes only.

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

OCP Connect
─────────────────────────────────────
  Remote: http://192.168.1.100:3456

  Checking connectivity...
  ✓ Connected

  Remote OCP v3.6.0  (auth: multi)

  Server allows anonymous access — no key needed.

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

  ✓ OpenClaw configured
    Provider: ocp
    Models:
      • ocp/claude-opus-4-6
      • ocp/claude-sonnet-4-6
      • ocp/claude-haiku-4
    Priority: PRIMARY (default model)

    Restart OpenClaw to apply: openclaw gateway restart

  Running smoke test...
  ✓ Smoke test passed: OK

  Done. Reload your shell to apply:
    source ~/.zshrc
```

The script automatically:
- Writes env vars to all relevant shell rc files (`.bashrc`, `.zshrc`)
- Sets system-level env vars (`launchctl setenv` on macOS, `environment.d` on Linux)
- Detects and configures IDEs (OpenClaw, Cline, Continue.dev, Cursor)

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
| `/dashboard` | GET | Web dashboard (always public) |
| `/api/keys` | GET/POST | List or create API keys (admin only) |
| `/api/keys/:id` | DELETE | Revoke an API key (admin only) |
| `/api/usage` | GET | Per-key usage stats (`?since=&until=&hours=&limit=`) |

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
| `CLAUDE_BIND` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `CLAUDE_AUTH_MODE` | `none` | Auth mode: `none`, `shared`, or `multi` |
| `OCP_ADMIN_KEY` | *(unset)* | Admin key for key management (multi mode) |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `600000` | Request timeout (ms, default: 10 min) |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes |
| `CLAUDE_MAX_PROMPT_CHARS` | `150000` | Prompt truncation limit (chars) |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry (ms, default: 1 hour) |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass all permission checks |
| `CLAUDE_NO_CONTEXT` | `false` | Suppress CLAUDE.md and auto-memory injection (pure API mode) |
| `PROXY_API_KEY` | *(unset)* | Bearer token for shared-mode authentication |

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
