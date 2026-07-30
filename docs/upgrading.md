Part of [OCP](../README.md) — the full upgrade manual (`ocp update` paths, manual flags, rollback, and OpenClaw auto-sync). The README keeps a short stub with the one-liner.

# Upgrading

The simplest path: ask your AI.

  Paste this prompt:

  ```
  Upgrade my OCP. Run `ocp update` and follow whatever it says.
  If it tells me to run `claude auth login`, I'll do that.
  ```

What `ocp update` does:

- **Tree already at latest, but the running service is stale** (e.g. a previous `ocp update`
  was interrupted after checking out the new tag but before restarting — issue #214):
  restart-only path. No git or npm operations — the tree doesn't need touching, only the
  service does. Just `cmd_restart` + a post-flight `/health` verification against the
  version already on disk.
- **Patch bump** (e.g. `v3.21.0 → v3.21.1`):
  light path (git pull + npm install + restart).
- **Cross-minor** (e.g. `v3.18 → v3.22`):
  full path: pre-flight check, snapshot, `setup.mjs --reconfigure-only` (with plist
  env-merge), service restart, post-flight `/health` and `/v1/models` verification.
  `--reconfigure-only` (issue #226) writes the service unit/plist but does not itself start
  the service now — starting is the dedicated restart phase's job, which runs next. On
  Linux it also leaves the unit's boot-enablement (`systemctl enable`) untouched rather than
  re-asserting it, so a host where an operator has deliberately disabled the OCP-managed
  unit (because a different unit already owns the port) stays disabled across an upgrade.
  Running the installer's reconfigure step with a bare `setup.mjs` (no flag) would
  start/enable the unit itself, before the restart phase gets a chance to run — on the host
  that motivated issue #215, that reproduces the orphan process #215 describes and re-arms
  its boot race. **This alone does not stop the #215 orphan**, though: the restart phase
  that runs next is, as of this writing, still a hard-coded `systemctl --user restart
  ocp-proxy.service` — it does not yet resolve which unit actually owns the port (that fix,
  #221, is a separate PR). So on the #215 host specifically, the restart phase still starts
  `ocp-proxy` unconditionally a few steps later; --reconfigure-only removes the boot-race
  re-arm (`enable`) and phase 4 racing ahead of phase 5 (its premature `start`), which is
  half of the #215/#226 defect family, not the orphan itself. A first install
  (`node setup.mjs`, no flags) is unaffected and still enables + starts the service, which
  is that path's actual job.
- **Old version** (< v3.4.0):
  fresh-install. Pre-v3.4 lacked admin-key/usage-db, so there is nothing to
  migrate. Your OAuth token (managed by the Claude Code CLI, not OCP) is
  preserved; you do not need to re-OAuth unless your token expired
  separately.

Snapshots are saved to `~/.ocp/upgrade-snapshot-<ISO-ts>/` and never
auto-deleted. Clean old ones with `rm -rf ~/.ocp/upgrade-snapshot-*` once
you're confident the upgrade is stable.

## Manual upgrade — same command, no AI

```bash
ocp update                  # smart-pick path
ocp update --check          # show available updates, don't apply
ocp update --dry-run        # preview plan
ocp update --target v3.13.0 # pin a specific version
ocp update --rollback --yes # restore most recent snapshot (--yes confirms)
ocp update --rollback --list      # list snapshots, no mutation
ocp update --rollback --dry-run   # preview rollback plan
```

## When upgrade fails

`ocp update` prints a recovery line on failure. To restore from the snapshot:

```bash
ocp update --rollback --yes   # --yes confirms the destructive restore
ocp doctor
```

If `ocp doctor` still reports problems after rollback, open a GitHub issue
with the snapshot path and the doctor JSON output (`ocp doctor --json`).

## Restart target resolution

The full-upgrade and `--rollback` restart phases resolve which unit actually
owns the OCP port (`ss`/`lsof` + `/proc/<pid>/cgroup` on Linux, launchd on
macOS) instead of restarting a hard-coded name — see
[`scripts/lib/restart-unit.mjs`](../scripts/lib/restart-unit.mjs). If it
can't tell what owns the port, or what it can tell makes restarting unsafe,
**it refuses rather than guesses**:

| Message contains | Meaning | What to do |
|---|---|---|
| `could not determine what ... owns the OCP port` | The listener's owning PID isn't attributable (e.g. `ocp update` run by a different user than a `User=`-less system unit), a tool is missing, or multiple PIDs answer the same port. | Re-run with elevated privileges, or check `ss -lptn` / `lsof -iTCP` / `cat /proc/<pid>/cgroup` manually. |
| `not managed by any systemd unit` | A PID holds the port but isn't in any systemd cgroup (a bare `node server.mjs`). | Stop that PID manually, or bring it under systemd, then re-run. |
| `nothing is currently listening` | Nothing is bound to the port at all. Deliberately **not** auto-started: if the real production unit is a SYSTEM unit that happens to be down, silently starting the default (often loopback-only) unit would pass post-flight — which only checks `127.0.0.1` — while the host loses LAN reachability. | Start the intended unit manually, confirm it's the one you expect, then re-run. |
| `requires "sudo systemctl restart <unit>"` | The port is owned by a SYSTEM unit and non-interactive sudo isn't authorized for that specific command. | Run the printed `sudo systemctl restart <unit>` manually, or grant it explicitly (e.g. `deploy ALL=(root) NOPASSWD: /bin/systemctl restart <unit>`), then re-run. |
| `rollback only restores the launchd plist and the USER-scope systemd unit file` | Rollback resolved the port to a SYSTEM unit, but rollback (see `scripts/lib/snapshot.mjs`) never captured or restores that unit's config. | Roll back the system unit's config manually if it needs it, then restart it yourself. |

If the resolved unit differs from the expected default, that's surfaced
loudly (both on stderr and in the `restart-resolve` phase entry) rather than
restarted silently — this is the fix for
[issue #215](https://github.com/dtzp555-max/ocp/issues/215): a hard-coded
restart target left an orphan `server.mjs` running when the real owner
differed.

## OpenClaw Auto-Sync (v3.11.0+)

Whenever the model list in [`models.json`](../models.json) changes, `ocp update` automatically reconciles your OpenClaw config so the model dropdown stays in sync — no more "I upgraded OCP but my Telegram bot still shows the old models" surprises.

**What gets synced** (and only this — all other config keys are preserved):
- `models.providers."claude-local".models` in `~/.openclaw/openclaw.json`
- `agents.defaults.models["claude-local/*"]` aliases

**Safety**:
- Timestamped backup written before every change: `~/.openclaw/openclaw.json.bak.<ms>`
- Idempotent — already-in-sync runs are a no-op (no backup, no rewrite)
- Non-fatal — sync failure does NOT abort `ocp update`; `/v1/models` still works
- Skips silently if OpenClaw is not installed (`~/.openclaw/openclaw.json` missing)

**Manual trigger** (e.g. after fixing a hand-edited config, or for the one-time v3.10.0→v3.11.0 bootstrap quirk):
```bash
node ~/ocp/scripts/sync-openclaw.mjs
node ~/ocp/scripts/sync-openclaw.mjs --quiet   # silent unless changes
```

**Opt-out**: `ocp update` only invokes the sync if `node` and `scripts/sync-openclaw.mjs` are both present. Removing the script disables auto-sync; the rest of `ocp update` still works.

**One-time bootstrap caveat (v3.10.0 → v3.11.0 only)**: the first `ocp update` to v3.11.0 runs the *old* `cmd_update` already loaded into your shell, so the new sync hook does NOT fire on this single jump. Run `node ~/ocp/scripts/sync-openclaw.mjs` once manually. Every future update from v3.11.0+ syncs automatically. (Also captured in the README Troubleshooting section as a bootstrap quirk.)

**Other IDEs** (Cline / Aider / Cursor / opencode) query `/v1/models` live, so they pick up new models on the next request — no sync needed. Continue.dev users edit their own `config.json` model id manually.
