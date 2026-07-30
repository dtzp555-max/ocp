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

<a id="restart-target-refusal"></a>
### `ocp update` (or `--rollback`) refuses to restart instead of restarting

Starting with [issue #215](https://github.com/dtzp555-max/ocp/issues/215)'s fix, the full-upgrade and `--rollback` restart phases resolve which systemd/launchd unit actually owns the OCP port before touching anything, instead of restarting a hard-coded name — see [`scripts/lib/restart-unit.mjs`](../scripts/lib/restart-unit.mjs). Five messages, each a deliberate refusal rather than a silent guess:

- **`could not determine what (if anything) owns the OCP port`** — usually a privilege gap: `ss`'s PID column is only populated when the caller can see the target process's `/proc/*/fd`, which is silently omitted for a system unit owned by a different user (the default for a system unit with no `User=` directive). Also covers a missing `ss`/`lsof` binary and multiple distinct PIDs answering the same port (dual-stack / `SO_REUSEPORT` — "which one" is the actual diagnostic question, so this refuses rather than picking one arbitrarily). **Fix:** re-run with elevated privileges, or check `ss -lptn "sport = :3456"` / `lsof -nP -iTCP:3456 -sTCP:LISTEN` / `cat /proc/<pid>/cgroup` by hand.
- **`... not managed by any systemd unit`** — a PID holds the port but isn't in any systemd cgroup at all (a bare `node server.mjs`, started outside systemd). **Fix:** stop that PID manually, or bring it under systemd, then re-run.
- **`nothing is currently listening`** — the port genuinely isn't bound to anything. This is deliberately a refusal, not an auto-start: if the real production listener is a SYSTEM unit that happens to be down right now, silently starting the default (often loopback-only) unit instead would pass post-flight — which only checks `127.0.0.1` — while the host silently loses LAN reachability. **Fix:** start the intended unit yourself, confirm it's bound the way you expect, then re-run.
- **`requires "sudo systemctl restart <unit>"`** — the port is owned by a SYSTEM unit and `sudo -n -l systemctl restart <unit>` (checked for that *specific* command, not a generic `sudo -n true` — NOPASSWD sudoers rules are per-command) isn't authorized non-interactively. **Fix:** run the printed command manually, or grant it explicitly, e.g. `deploy ALL=(root) NOPASSWD: /bin/systemctl restart <unit>`.
- **`rollback only restores the launchd plist and the USER-scope systemd unit file`** — `--rollback` resolved the port to a SYSTEM unit, but rollback only ever captures/restores the launchd plist and `~/.config/systemd/user/ocp-proxy.service` (see `scripts/lib/snapshot.mjs`); it never touched that unit's config, so restarting it wouldn't apply the rollback. **Fix:** roll back the system unit's config by hand if it needs it, and restart it yourself.

None of these leave an orphan process behind (the whole point of the fix); the working tree/snapshot state is unaffected, so re-running after addressing the message is always safe.

<a id="cache-rekey-v3250"></a>
### Response-cache hit rate drops once after upgrading to v3.25.0

Only affects instances running with the response cache **on** (`CLAUDE_CACHE_TTL > 0`); it is off by default, so most installs see nothing.

v3.25.0 keys the cache on the **resolved** model rather than on the string the client sent, so rows written for an alias (`opus`, `sonnet`, `haiku`, or a legacy alias like `claude-haiku-4-5`) no longer match. Those rows orphan and are reaped by the TTL cleanup interval within one window — **no migration script, no action required**; expect one window of extra misses and then normal hit rates.

Two different scopes, worth being precise about:

- **Normal cache** — only *alias-addressed* rows rekey. Rows written under a literal model id (`claude-sonnet-5`) keep matching — **unless the instance runs `OCP_LOCAL_TOOLS=1`**, in which case the entire normal cache rekeys once. That is a separate mechanism: v3.25.0 also reworded the local-tools wrapper, and the wrapper text is one of the four inputs to `CONFIG_EPOCH`, which every normal cache key folds in (established behavior since v3.23.0, not new here).
- **Structured-output cache** — **every** row rekeys, alias or literal. The same change also folds the config epoch into the structured key, which it had never included; that gap meant a `CLAUDE_SYSTEM_PROMPT` change did not invalidate structured answers either. Structured caching only exists from v3.24.0, so there is at most one release worth of rows to orphan.

This is deliberate, and it is what makes an alias repoint take effect. Before v3.25.0, changing where an alias pointed (v3.25.0 itself repoints `opus` → `claude-opus-5`) left the cache serving the **old** model's answers under that alias until TTL expiry, because `models.json` is read once at boot while the SQLite cache survives the restart. If you were running with the cache on and repointed an alias in an earlier version, that is why it appeared not to take.

A side effect worth knowing: an alias and its canonical id now **share** a cache slot, since both produce an identical spawn. That is a small hit-rate improvement in steady state.

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
