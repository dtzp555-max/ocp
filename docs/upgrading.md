Part of [OCP](../README.md) — the full upgrade manual (`ocp update` paths, manual flags, rollback, and OpenClaw auto-sync). The README keeps a short stub with the one-liner.

# Upgrading

The simplest path: ask your AI.

  Paste this prompt:

  ```
  Upgrade my OCP. Run `ocp update` and follow whatever it says.
  If it tells me to run `claude auth login`, I'll do that.
  ```

What `ocp update` does:

- **Patch bump** (e.g. `v3.21.0 → v3.21.1`):
  light path (git pull + npm install + restart).
- **Cross-minor** (e.g. `v3.18 → v3.22`):
  full path: pre-flight check, snapshot, `setup.mjs` (with plist env-merge),
  service restart, post-flight `/health` and `/v1/models` verification.
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
