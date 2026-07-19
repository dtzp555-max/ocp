Part of [OCP](../README.md) — full troubleshooting manual. The README keeps a slim version with the most common issues and the one-time bootstrap quirks; everything else lives here.

# Troubleshooting

The simplest path: ask your AI.

  Paste this prompt:

  ```
  Run `ocp doctor` and follow its `next_action`. Tell me if you hit
  anything that needs human input.
  ```

The doctor produces a JSON `next_action` with `ai_executable[]` (commands
the agent runs verbatim) and `human_required[]` (steps that need you,
typically just OAuth).

## Manual debugging

### Setup fails with "claude: command not found"

`setup.mjs` requires the Claude CLI to be on `PATH`. Install it via the [official guide](https://docs.anthropic.com/en/docs/claude-cli), confirm with `which claude`, then run `claude auth login` before re-running `node setup.mjs`.

### Setup fails with "EADDRINUSE: port 3456 already in use"

Something else is already bound to port 3456 — usually an old OCP instance. Check what:

```bash
lsof -nP -iTCP:3456 -sTCP:LISTEN
```

If it's an old OCP process, stop it before re-running setup:

```bash
launchctl bootout gui/$(id -u)/dev.ocp.proxy            # macOS launchd
systemctl --user stop ocp-proxy                         # Linux systemd (installed as a --user unit)
```

(There is no `ocp stop` subcommand — the proxy runs as a service, so stopping it goes through the service manager above. `ocp restart` exists for the bounce case.)

### Setup fails with "node: command not found" or version error

OCP requires Node.js 22.5+. Install:

```bash
brew install node          # macOS
# Linux: see https://nodejs.org/en/download for current install commands
```

Confirm with `node --version` (should be ≥ v22.5).

### Requests fail or agents stuck

```bash
# Clear sessions and restart
ocp clear
ocp restart

# If using OpenClaw gateway
openclaw gateway restart
```

### Env var change (e.g. `CLAUDE_BIND`, `CLAUDE_CODE_OAUTH_TOKEN`) doesn't take effect after restart

On **macOS**, `ocp restart` does a full `launchctl bootout` + `bootstrap` of the agent, which **re-reads the plist `EnvironmentVariables`** — so an env change you made (in `~/Library/LaunchAgents/dev.ocp.proxy.plist`) actually takes effect:

```bash
ocp restart
```

This is deliberate: the older `launchctl kickstart -k` only re-execs the process and **reuses launchd's cached environment**, so plist env edits would be silently ignored. If you ever restart the agent by hand, use bootout+bootstrap, not `kickstart -k`:

```bash
launchctl bootout   gui/$(id -u)/dev.ocp.proxy 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ocp.proxy.plist
```

Verify the new value reached the running process:

```bash
ps -E -p "$(launchctl print gui/$(id -u)/dev.ocp.proxy 2>/dev/null | awk '/pid =/{print $3}')" | tr ' ' '\n' | grep CLAUDE_
```

On **Linux**, `systemctl --user restart` already re-reads the unit's `EnvironmentFile`, so no special handling is needed.

### Usage shows "unknown"

Usually caused by an expired Claude CLI session. Fix:
```bash
claude auth login
ocp restart
```

### Startup log warns "OpenClaw registry out of sync"

On boot, OCP compares OpenClaw's registered models against [`models.json`](../models.json) and warns if they drift. Cause: someone (or an OpenClaw upgrade) modified `~/.openclaw/openclaw.json` and removed entries OCP expects. Fix:

```bash
node ~/ocp/scripts/sync-openclaw.mjs
```

This is read-only at startup; the warning never blocks the gateway from running.

### A TUI session vanished right after upgrading OCP

If you ran a pre-3.21.1 OCP instance and a post-3.21.1 instance on the same host at the same time during an upgrade, the new instance's one-time boot reap can, once, kill an old-format (`ocp-tui-<8hex>`) live TUI session belonging to the still-running old instance — restart the affected session (`ocp restart` or re-run your TUI turn) and it will come back under the new instance's port-scoped naming.

### OpenClaw shows old models after `ocp update` (v3.10→v3.11 only)

One-time bootstrap quirk for the v3.10.0 → v3.11.0 jump only — the running shell had the old `cmd_update` cached. Run once manually:

```bash
node ~/ocp/scripts/sync-openclaw.mjs
openclaw gateway restart   # so OpenClaw re-reads the config
```

Future `ocp update` invocations sync automatically.

<a id="tui-401"></a>
### TUI-mode returns a permanent `Please run /login` 401 (re-login doesn't stick)

A long-running TUI-mode host can get stuck returning a permanent 401 (`Please run /login · API Error: 401`) that re-login cannot fix.

**Root cause (two layers):** interactive `claude` **prefers `~/.claude/.credentials.json` over the `CLAUDE_CODE_OAUTH_TOKEN` env var** (this is *unlike* the `-p` path, where the env token wins). So (a) a stale/corrupt `credentials.json` **shadows** the env token — passing the token is not enough on its own; and (b) when claude does use `credentials.json`, its single-use OAuth refresh token can be corrupted (ending up an empty string) by the per-request spawn + `kill-session` teardown racing claude's token rotation. Re-login writes a fresh token, but the next spawn re-corrupts it. Proven live on PI231: *env token passed + broken `credentials.json` present → 401; env token passed + `credentials.json` moved aside → works.*

**Fix:** set `CLAUDE_CODE_OAUTH_TOKEN` on the OCP host and leave `OCP_TUI_HOME` **unset**. OCP then runs the TUI `claude` in a **credential-isolated home** (`$HOME/.ocp-tui/home`) that has **no `credentials.json`** at all, so the env token is the only credential (authoritative — nothing shadows it) and claude never runs the refresh path (so the single-use token can't be corrupted). Then restart — on systemd `daemon-reload`, on launchd `bootout`+`bootstrap`; `kickstart -k` does **not** reload env. Verify the env reached the process and the boot log shows the isolated home:

```bash
# Linux (systemd): confirm the token is in the service env
tr '\0' '\n' < /proc/$(pgrep -f server.mjs | head -1)/environ | grep CLAUDE_CODE_OAUTH_TOKEN
# Boot log should read: TUI-mode: ON home=$HOME/.ocp-tui/home ... auth=env-token (credential-isolated home — no credentials.json)
```

> If you previously set `OCP_TUI_HOME` to the real home (or any home that contains a `credentials.json`), **unset it** so the credential-isolated default takes effect — otherwise the shadowing `credentials.json` remains in play.

See [Subscription-pool (TUI) mode](tui-mode.md#subscription-pool-tui-mode) and ADR 0007 PR-C / PR-D amendments.
