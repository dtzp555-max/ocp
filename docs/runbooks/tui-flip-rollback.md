# TUI-Mode Flip and Rollback Runbook

**Purpose:** Step-by-step instructions for enabling (`CLAUDE_TUI_MODE=true`) or disabling TUI-mode on real OCP deployments managed by **systemd** (Linux) or **launchd** (macOS).

Run the [615-canary](./615-canary.md) runbook after any flip to confirm billing pool routing is correct.

---

## Critical pitfalls — read first

### systemd: `daemon-reload` is required after editing the unit

Editing the unit file (or EnvironmentFile) and then doing `systemctl restart ocp.service` **without** `daemon-reload` will restart the process with the **old** environment from the cached unit. Always run `daemon-reload` after editing any unit file.

### launchd: `launchctl kickstart -k` does NOT reload plist env

`launchctl kickstart -k gui/$(id -u)/dev.ocp.proxy` kills the running process and re-launches it, but it **re-uses the launchd-cached environment** — not the current plist file. If you edited the plist's `EnvironmentVariables` section, you must do a full `bootout` + `bootstrap` cycle for the change to take effect. `kickstart` is not sufficient.

---

## Flip — enable TUI-mode

### systemd (Linux, e.g. Raspberry Pi, VPS)

**Option A — EnvironmentFile (recommended for clean separation)**

If your unit uses `EnvironmentFile=/etc/ocp/ocp.env` (or similar):

```bash
# 1. Edit the environment file
sudo nano /etc/ocp/ocp.env
# Add or update:
#   CLAUDE_TUI_MODE=true
#
# If OCP binds to 0.0.0.0 AND you trust the network:
#   OCP_TUI_ALLOW_LAN=1
#   (WARNING: TUI-mode is single-user only — only enable OCP_TUI_ALLOW_LAN=1
#    if you fully trust every caller that can reach the OCP port on your network)

# 2. Reload the unit definition and restart
sudo systemctl daemon-reload
sudo systemctl restart ocp.service

# 3. Verify
curl -s http://127.0.0.1:3456/health | python3 -m json.tool | grep -E "tui|version"
# Expected: "tuiMode": true (or similar TUI indicator in the health response)
```

**Option B — inline Environment= in the unit file**

```bash
# 1. Edit the unit file
sudo systemctl edit --full ocp.service
# Add or update in the [Service] section:
#   Environment=CLAUDE_TUI_MODE=true

# 2. Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart ocp.service

# 3. Verify
systemctl show ocp.service --property=Environment
# Expected: Environment=CLAUDE_TUI_MODE=true ...
```

### launchd (macOS)

Locate the OCP plist. The standard label is `dev.ocp.proxy`:

```bash
# Find the plist path
ls ~/Library/LaunchAgents/dev.ocp.proxy.plist
```

**Edit the plist:**

```bash
# 1. Stop the service first (bootout)
launchctl bootout gui/$(id -u)/dev.ocp.proxy

# 2. Edit the plist — add CLAUDE_TUI_MODE to EnvironmentVariables
#    Use your editor of choice:
nano ~/Library/LaunchAgents/dev.ocp.proxy.plist
```

Inside the plist, in the `<key>EnvironmentVariables</key>` `<dict>` block, add:

```xml
<key>CLAUDE_TUI_MODE</key>
<string>true</string>
```

If `OCP_TUI_ALLOW_LAN=1` is also needed (only if OCP binds to `0.0.0.0` and you trust the network):

```xml
<key>OCP_TUI_ALLOW_LAN</key>
<string>1</string>
```

```bash
# 3. Bootstrap (reload from disk + start)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ocp.proxy.plist

# 4. Verify
curl -s http://127.0.0.1:3456/health | python3 -m json.tool | grep -E "tui|version"
```

**Confirm env was actually loaded** (not just set in your shell):

```bash
ps aux | grep server.mjs | grep -v grep
# Get the PID, then:
# macOS: ps -E -p <PID> | tr ' ' '\n' | grep CLAUDE_TUI_MODE
# Expected: CLAUDE_TUI_MODE=true
```

---

## Rollback — disable TUI-mode

Rollback is the same procedure as flip, but you **remove** `CLAUDE_TUI_MODE` or set it to any value other than `"true"` (e.g. `false`, or simply omit it).

After rollback, OCP returns to the default `callClaude` / `callClaudeStreaming` stream-json path — byte-for-byte identical to the pre-TUI code path. No other change is required.

### systemd rollback

```bash
# Option A — EnvironmentFile
sudo nano /etc/ocp/ocp.env
# Remove or comment out:
#   CLAUDE_TUI_MODE=true
#   OCP_TUI_ALLOW_LAN=1  (if set)

sudo systemctl daemon-reload
sudo systemctl restart ocp.service

# Verify
curl -s http://127.0.0.1:3456/health | python3 -m json.tool | grep tui
# Expected: "tuiMode": false (or the field absent)
```

### launchd rollback

```bash
# 1. Stop
launchctl bootout gui/$(id -u)/dev.ocp.proxy

# 2. Edit plist — remove the CLAUDE_TUI_MODE and OCP_TUI_ALLOW_LAN entries from EnvironmentVariables

# 3. Bootstrap
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ocp.proxy.plist

# 4. Verify
curl -s http://127.0.0.1:3456/health | python3 -m json.tool | grep tui
```

---

## Billing impact of staying on the default (non-TUI) path after 2026-06-15

If you do NOT flip to TUI-mode and keep `CLAUDE_TUI_MODE` unset (the default), OCP continues using `claude -p --output-format stream-json`, which sets `cc_entrypoint=sdk-cli`. After 2026-06-15, every OCP request on the default path will draw from the Agent SDK credit pool (approximately $20/month on a Pro plan, or $100/month on a Max plan) rather than the Pro/Max subscription. The subscription pool usage (5-hour and 7-day windows) will be unaffected, but the Agent SDK credit balance will drain with each request.

If you want to continue using OCP without TUI-mode after 2026-06-15, budget for the Agent SDK credit cost accordingly — or switch to [OLP](https://github.com/dtzp555-max/olp) for multi-provider fallback.

---

## Verify after any flip

1. Check `/health` shows the expected `tuiMode` state.
2. Run the [615-canary](./615-canary.md) to confirm billing pool routing.
3. If TUI-mode is ON: check `ocp logs 10` for any TUI spawn errors (`tui_spawn_failed`, tmux errors).

---

## Related

- [615-canary runbook](./615-canary.md) — how to verify billing pool routing after a flip
- [ADR 0007](../adr/0007-tui-interactive-mode.md) — TUI-mode architecture; Kill-switch section
- [Subscription-pool (TUI) mode](../tui-mode.md#subscription-pool-tui-mode)
- README § [Environment Variables](../../README.md#environment-variables) — `CLAUDE_TUI_MODE`, `OCP_TUI_ALLOW_LAN=1`
