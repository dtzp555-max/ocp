Part of [OCP](../README.md) — LAN & multi-user: server setup, client connect, API-key management, per-key quotas, anonymous access, and the deployment/security model (including the honest limits of sharing).

# LAN & multi-user

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

## Server Setup

> **Recommended:** Install OCP on a device that stays powered on — Mac mini, NAS, Raspberry Pi, or a desktop that doesn't sleep. This ensures all clients always have access.

**Prerequisites:**
- macOS or Linux (Windows is not supported — `setup.mjs` installs launchd / systemd auto-start)
- Node.js 22.5+ (Node 23+ recommended — `node:sqlite` is fully stable without flags from 23.0; on 22.5–22.x it works behind `--experimental-sqlite`)
- `git`
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) — install and authenticate:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude auth login   # prints a URL + code — open URL on any browser, sign in, paste code back
  ```
  Headless servers (Pi / NAS / VPS without a desktop browser): see [Headless install notes](#headless-install-notes) below.

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

After install the `ocp` CLI lives at `~/ocp/ocp`. To put it on your PATH, either symlink it manually (`ln -sf ~/ocp/ocp ~/.local/bin/ocp` if `~/.local/bin` is on your PATH, or `sudo ln -sf ~/ocp/ocp /usr/local/bin/ocp` for a system-wide symlink) or add an alias (`alias ocp=~/ocp/ocp`). Otherwise invoke it as `~/ocp/ocp <subcommand>`. The rest of this document assumes `ocp` is on your PATH.

> **Cloud/Linux servers:** If `ocp: command not found` after a cloud install, the binary isn't in PATH. Full path in that layout: `~/.openclaw/projects/ocp/ocp`

**Single-machine use** — just set your IDE to use the proxy:
```bash
export OPENAI_BASE_URL=http://127.0.0.1:3456/v1
```

**LAN mode** — reach OCP from your own devices on the network (Claude Pro/Max are per-user accounts — see [Sharing with family / a team — honest limits](#deployment-model--security-read-this) before extending access to other people):
```bash
# Enable LAN access with per-user auth (recommended)
node setup.mjs --bind 0.0.0.0 --auth-mode multi
```

Then create API keys for each person/device:
```bash
# Generate a strong admin key (one-time — save it for later key management):
export OCP_ADMIN_KEY=$(openssl rand -base64 32)
# Add the same export line to ~/.zshrc or ~/.bashrc so it persists.

ocp keys add wife-laptop
#  ✓ Key created for "wife-laptop"
#    API Key: ocp_example12345abcde...
#    Copy this key now — you won't see it again.

ocp keys add son-ipad
ocp keys add pi-server
```

Run `ocp lan` to see your IP and ready-to-share instructions.

**Verify:**
```bash
curl http://127.0.0.1:3456/v1/models
# Returns: claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5-20251001
```

### Headless install notes

OCP is designed for always-on devices that often don't have a desktop browser — Mac mini, NAS, Raspberry Pi, cloud VPS. The Claude CLI auth flow still works headless:

**Option 1 — interactive OAuth over SSH (one-shot).** `claude auth login` prints a URL + 8-digit code. Open the URL on **any** device with a browser (your laptop, phone), sign in to your Anthropic account, and paste the code back into the SSH session. No browser needed on the server itself.

**Option 2 — long-lived token (auth once, no re-prompts).**

```bash
claude setup-token   # subscription-backed long-lived token
```

Same Claude subscription as Option 1; the token is stored in Claude CLI's normal config location. Useful when you'd rather not redo the OAuth flow when sessions expire.

If `claude auth login` errors out with something like `cannot open browser`, you've hit the same case — fall back to either option above.

## AI-assisted install prompts

If you've got Claude Code, Cursor, or any other AI coding assistant on this machine, you can copy-paste one of these prompts and let the AI walk through the install for you. Each prompt pins the AI to the right README section, names the verification step, and forbids silent retries — so you stay in the loop.

**Single-machine use** — install OCP for IDEs on this same machine only:

```text
I want to install OCP on this machine to use my Claude Pro/Max subscription
as an OpenAI-compatible API for local IDEs.

Please follow https://github.com/dtzp555-max/ocp/blob/main/README.md
§Quickstart (single-machine install):

1. Verify prerequisites: macOS or Linux, Node.js 22.5+, git, Claude CLI
   installed and logged in (`claude auth status`). Install missing pieces
   using my system's package manager.
2. git clone the repo, cd in, and run `node setup.mjs`.
3. Verify with `curl http://127.0.0.1:3456/v1/models` (should list 6 models).
4. Add `export OPENAI_BASE_URL=http://127.0.0.1:3456/v1` to my shell rc.
5. Tell me to reload my shell and try a tool like Cline / Continue / Cursor.

Before each step, tell me what you'll run and wait for confirmation.
On any error, diagnose first — don't auto-retry.
```

**LAN mode (server)** — install OCP as a server so your own devices on the LAN can reach it (Claude Pro/Max are per-user accounts — review Anthropic's Usage Policy before extending access to other people):

```text
I want to install OCP on this device as a LAN server so my own devices on the
network can reach my Claude Pro/Max subscription through a local
OpenAI-compatible endpoint.

Please follow https://github.com/dtzp555-max/ocp/blob/main/docs/lan-mode.md
"Server Setup" → "LAN mode" path:

1. Verify prerequisites: macOS or Linux (Windows not supported), Node.js
   22.5+, git, Claude CLI installed and authenticated.
2. Generate a strong admin key with `openssl rand -base64 32`. Save it —
   I'll need it to manage per-user keys later.
3. git clone https://github.com/dtzp555-max/ocp.git && cd ocp
4. Run `node setup.mjs --bind 0.0.0.0 --auth-mode multi`.
5. Add OCP_ADMIN_KEY to my shell rc (~/.zshrc or ~/.bashrc).
6. Run `ocp lan` to show me the LAN IP and connect command.
7. Optionally create example keys: `ocp keys add laptop`, `ocp keys add tablet`.
8. Verify: `curl http://127.0.0.1:3456/v1/models` returns 6 models.

Tell me each step before running it. On error, diagnose before retrying.
```

**Client connect** — configure this device to use an existing OCP server on your LAN:

```text
There's an OCP server at <SERVER_IP> on my LAN. Configure this machine to
use it for any local IDEs (Cursor, Cline, Continue.dev, OpenCode, OpenClaw).

Server IP: <SERVER_IP>
API key (leave blank if the server has anonymous mode enabled): <OPTIONAL_KEY>

Please follow https://github.com/dtzp555-max/ocp/blob/main/docs/lan-mode.md
"Client Setup" path:

1. Download ocp-connect:
     curl -fsSL https://raw.githubusercontent.com/dtzp555-max/ocp/main/ocp-connect -o ocp-connect
     chmod +x ocp-connect
2. Run `./ocp-connect <SERVER_IP>` (add `--key <KEY>` if you have one).
3. Follow any IDE-specific manual hints it prints.
4. Verify: `curl http://<SERVER_IP>:3456/v1/models` returns 6 models.
5. Tell me to reload my shell + restart any IDE that was already running.

Don't auto-retry on error. Tell me the failure mode first.
```

## Client Setup

> Clients do **not** need to install Node.js, Claude CLI, or the OCP repo. Only `curl` and `python3` are required (pre-installed on most Linux/Mac systems).
>
> **Find the server's LAN IP** by running `ocp lan` on the server machine — it prints both the IP and a ready-to-share connect command.

**One-command setup** — download the lightweight `ocp-connect` script:

```bash
curl -fsSL https://raw.githubusercontent.com/dtzp555-max/ocp/main/ocp-connect -o ocp-connect
chmod +x ocp-connect
./ocp-connect <server-ip>
```

**Zero-config** — when the server admin has set `PROXY_ANONYMOUS_KEY` *and* opted in with `PROXY_ADVERTISE_ANON_KEY=1` (see [Anonymous Access](#anonymous-access-optional) below), just pass the server IP and nothing else. `ocp-connect` reads the anonymous key from `/health` and uses it automatically. Without the opt-in, `/health` does not expose the key (issue #109); pass `--key` or rely on anonymous access instead:

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

  Remote OCP v3.11.0  (auth: multi)

  ⓘ Using server-advertised anonymous key: ocp_publ...n_v1
    (set by admin via PROXY_ANONYMOUS_KEY; see issue #12 §14 Path A)

  Testing API access...
  ✓ API accessible (6 models available)

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
      • ocp/claude-opus-4-8
      • ocp/claude-opus-4-7
      • ocp/claude-opus-4-6
      • ocp/claude-sonnet-5
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
- **Auto-discovers anonymous key** from `/health.anonymousKey` when no `--key` given (v1.3.0+, requires server v3.10.0+; server must also set `PROXY_ADVERTISE_ANON_KEY=1` — see [Anonymous Access](#anonymous-access-optional))
- Configures OpenClaw automatically (including per-agent `auth-profiles.json` for multi-agent setups)
- Detects Cline, Continue.dev, Cursor, and opencode, and prints setup hints (manual configuration required for these IDEs)

On macOS, `launchctl setenv` vars reset on reboot — re-run `ocp-connect` after restart.

**Manual setup** — if you prefer not to use the script:
```bash
export OPENAI_BASE_URL=http://<server-ip>:3456/v1
export OPENAI_API_KEY=ocp_<your-key>
```
Add these lines to `~/.bashrc` or `~/.zshrc` to persist across sessions.

## Monitoring (Server-side)

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

![OCP Dashboard](images/dashboard.png)

## Auth Modes

| Mode | Env | Use Case |
|------|-----|----------|
| `none` | `CLAUDE_AUTH_MODE=none` | Trusted home network, no auth needed |
| `shared` | `CLAUDE_AUTH_MODE=shared` + `PROXY_API_KEY=xxx` | Everyone shares one key |
| `multi` | `CLAUDE_AUTH_MODE=multi` + `OCP_ADMIN_KEY=xxx` | Per-person keys for usage tracking + quotas (trusted users only — see Deployment model below) |

> **Usage scope (v3.14.0+):** `/api/usage` returns the caller's own rows by default. Admin callers must pass `?all=true` to retrieve data for all keys; doing so emits an audit log line.

## Deployment model & security (read this)

**What OCP is built for today: single-user, multi-IDE.** Run OCP as a server on one machine and point all of *your own* IDEs/devices at it — one Claude Pro/Max subscription, used everywhere. This is the primary, solid use case.

**Sharing with family / a team — honest limits.** You *can* share OCP on a LAN, but be clear about what the auth modes do and don't give you:

- The per-key modes (`shared` / `multi`) give per-key **usage tracking, quotas, and cache separation** — useful for seeing who used what and capping budgets.
- They do **not** give a **security isolation boundary**. The spawned `claude` runs with the **operator's filesystem access** and is *not* sandboxed per key. **Only share with people you fully trust, on a trusted network.**
- For simple trusted family sharing, the easiest setup is a single shared **anonymous key** (see [Anonymous Access](#anonymous-access-optional)) — no per-person separation, same trust assumption.
- **Account terms and ToS — read before sharing with others.** Claude Pro/Max are *per-user* accounts. Pooling a single subscription across **multiple distinct people** may violate Anthropic's Consumer Terms of Service and risk account suspension by the abuse classifier. The defensible framing is **"one person, your own devices"** — sharing with friends or a team is not. OCP does not change your account terms, and whether any particular sharing setup complies with the ToS is the account holder's responsibility. Review Anthropic's Usage Policy before extending access to other people.

**Real per-user isolation (sandboxed, multi-tenant-safe) is planned for after 2026-06-15** — per-key ephemeral home + tool lockdown + an OS sandbox. Until then, treat a multi-user OCP as a *trusted-group convenience*, not a security boundary. (This is also why `CLAUDE_TUI_MODE` is single-user-only — see [Subscription-pool (TUI) mode](tui-mode.md#subscription-pool-tui-mode).)

## Anonymous Access (optional)

In `multi` mode, the admin can designate a single well-known "anonymous" key that bypasses `validateKey()` and grants public read/write access. This is useful for letting LAN users (or clients like OpenClaw multi-agent setups) connect without individual per-user keys.

**Enable**:

The anonymous key is wired into the service unit (launchd plist on macOS, systemd unit on Linux) at install time. Export `PROXY_ANONYMOUS_KEY` in your shell before running `setup.mjs`, and `setup.mjs` will write it into the service unit env so the auto-started proxy picks it up:

```bash
export PROXY_ANONYMOUS_KEY=ocp_public_anon   # or any string of your choice
node setup.mjs --bind 0.0.0.0 --auth-mode multi
```

If OCP is already installed without it, re-export the env var and re-run `node setup.mjs` (the installer is idempotent — it refreshes the service unit). Then `ocp restart` so the running proxy picks up the new env. Setting `PROXY_ANONYMOUS_KEY` only in your interactive shell **does not** affect the auto-started proxy — the service unit is the source of truth for its environment.

**Client side**: the anonymous key value is exposed via `GET /health` as the field `anonymousKey` (null when not set) **only to localhost callers** or when the admin has also set `PROXY_ADVERTISE_ANON_KEY=1` (default off — see issue #109). With that opt-in, clients like `ocp-connect` can auto-discover and use it, so the end user doesn't need to get a personal key from the admin.

**Security note**: setting this env var is an **opt-in** to public access — anyone who can reach your OCP endpoint can use it, up to any rate limits you configure. Don't enable this on internet-exposed OCP instances without additional protection.

**Not a secret**: because `/health` is an unauthenticated endpoint, the anonymous key is **publicly readable** by anyone who can reach the server. That is intentional — the key exists so clients can self-configure without out-of-band coordination. Treat it as a convenience handle, not as an access credential.

## Per-Key Quota (Budget Control)

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

> **Note:** quotas are best-effort. Under concurrent bursts a key can exceed its cap by up to the server's max-concurrency (default 8), and cache hits are not counted toward quota. They cap budgets for cooperative family use, not adversarial abuse.

## Important Notes

- All users share your Claude Pro/Max **rate limits** (5h session + 7d weekly)
- `ocp usage` shows how much quota remains
- Keys are stored in `~/.ocp/ocp.db` (SQLite, zero external dependencies)
- Admin key is required for key management API endpoints
- The dashboard (`/dashboard`) and health check (`/health`) are always public
- File modes for `~/.ocp` (0700), `admin-key` + `ocp.db` (0600) are auto-tightened at server startup as of v3.14.0
