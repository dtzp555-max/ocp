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
  that motivated issue #215, that would reproduce the orphan process #215 describes and
  re-arm its boot race. `--reconfigure-only` removes that half of the risk (phase 4 no
  longer races ahead of phase 5 with a premature `enable`/`start`); the restart phase that
  runs next closes most of the other half. **On Linux**, it no longer hard-codes a restart
  target — it resolves which unit actually owns the port from live process/cgroup state
  before restarting it (PR #221, merged). **macOS coverage is narrower** — see
  [Restart target resolution](#restart-target-resolution) below for exactly what is and
  isn't verified there. A first install (`node setup.mjs`, no flags) is unaffected and still
  enables + starts the service, which is that path's actual job.

  The same #215 defect shape is **not yet fully fixed**: the "tree already at latest" and
  patch-bump paths above both delegate to bash's `cmd_restart()`, a hard-coded
  try-these-names-in-order cascade that does not do the live-ownership resolution described
  above — tracked separately as
  [#224](https://github.com/dtzp555-max/ocp/issues/224). And on the cross-minor path just
  described, a narrower gap remains on macOS even after that resolution runs (see
  [Restart target resolution](#restart-target-resolution) below): a *confirmed* listener
  there is still restarted over without verifying it is actually the `dev.ocp.proxy` job —
  its own open item, tracked as
  [#239](https://github.com/dtzp555-max/ocp/issues/239).
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
owns the OCP port instead of restarting a hard-coded name — see
[`scripts/lib/restart-unit.mjs`](../scripts/lib/restart-unit.mjs). **Coverage
differs by platform, and this is intentional, not an oversight** (issue #233
found the docs previously overclaimed macOS parity):

- **Linux**: full resolution — `ss` finds the owning PID, then a leaf-to-root
  walk of `/proc/<pid>/cgroup` identifies the actual systemd unit (system vs.
  user scope), flags a mismatch against the hard-coded default, and refuses
  outright if the PID belongs to no unit at all (`no-unit`).
- **macOS**: currently only listening/not-listening detection via `lsof`,
  cross-checked against `netstat` when `lsof`'s result is ambiguous (see
  below). There is **no macOS analogue of `no-unit` yet** — if something is
  confirmed listening on the port, the launchd bootout/bootstrap pair is
  treated as safe to run without verifying that the `dev.ocp.proxy` launchd
  job is actually the process holding it. Tracked as a follow-up (issue
  #239, design included); until it lands, a bare `node server.mjs` holding
  the port on macOS is not detected before restarting the way it is on
  Linux.

  **The `lsof`/`netstat` cross-check** (issue #233 HIGH-1): a non-root
  `lsof` probing a port held by a ROOT-OWNED process reports the exact same
  result as a genuinely empty port — both look like "nothing matched" to
  `lsof` itself. Before restarting anything, the resolution cross-checks
  with `netstat` (which shows listeners regardless of owning user and needs
  no privilege) to tell those two cases apart: a confirmed-empty port
  proceeds as not-listening; a port `netstat` shows as occupied, but whose
  owner `lsof` couldn't identify, refuses with `could not determine ...`
  rather than being silently read as free. A root-owned OCP deployment is a
  supported shape (see `scripts/doctor.mjs`'s multi-unit-risk check for
  `/Library/LaunchDaemons`), so this is not a hypothetical edge case.

If it can't tell what owns the port, or what it can tell makes restarting
unsafe, **it refuses rather than guesses**:

**On `--rollback` these refusals differ in one place**: "nothing is currently
listening" is a refusal on `ocp update`, but a warning-then-proceed on
`--rollback` — see the note in the table below. The other four are refusals
on both paths.

| Message contains | Meaning | What to do |
|---|---|---|
| `could not determine what ... owns the OCP port` | The listener's owning PID isn't attributable — on Linux, `ocp update` run by a different user than a `User=`-less system unit; on macOS, `netstat` confirms a listener on the port but `lsof` couldn't identify its owner (issue #233 HIGH-1 — the same root-owned-listener shape, cross-platform) — a tool is missing, or multiple PIDs answer the same port (Linux: across separate rows/dual-stack or within one row/`SO_REUSEPORT`). | Re-run with elevated privileges, or check `ss -lptn` / `lsof -iTCP` / `netstat -an` / `cat /proc/<pid>/cgroup` manually. |
| `not managed by any systemd unit` | **Linux only.** A PID holds the port but isn't in any systemd cgroup (a bare `node server.mjs`). macOS has no equivalent check yet — see "Coverage differs by platform" above (issue #239) — so a bare, unmanaged process holding the port is not currently detected before restarting on macOS the way it is on Linux. | Stop that PID manually, or bring it under systemd, then re-run. |
| `nothing is currently listening` | Nothing is bound to the port at all. On `ocp update`, deliberately **not** auto-started: if the real production unit is a SYSTEM unit that happens to be down, silently starting the default (often loopback-only) unit would pass post-flight — which only checks `127.0.0.1` — while the host loses LAN reachability. **On `--rollback`, this is NOT a refusal** — restoring a down service is the point of a rollback, there's no post-flight check to protect, and refusing would leave the rollback stuck forever on a re-run. Rollback proceeds to start the default unit (the one its own snapshot restores) with a loud `[restart] WARNING` instead. This case is now correctly reachable on **both** platforms (issue #233 defect 1 fixed a macOS `lsof` exit-code bug that had previously collapsed this into the `could not determine ...` refusal above instead, making the rollback fallback unreachable there). | On `ocp update`: start the intended unit manually, confirm it's the one you expect, then re-run. On `--rollback`: nothing to do — it already proceeded; check the warning names the right unit. |
| `requires "sudo systemctl restart -- <unit>"` | The port is owned by a SYSTEM unit and non-interactive sudo isn't authorized for that specific command. | Run the printed `sudo systemctl restart -- <unit>` manually, or grant it explicitly (e.g. `deploy ALL=(root) NOPASSWD: /bin/systemctl restart -- <unit>`), then re-run. |
| `rollback only restores the launchd plist and the USER-scope systemd unit file` | `--rollback` resolved the port to a SYSTEM unit. Rollback (see `scripts/lib/snapshot.mjs`) never captured or restores that unit's OWN config, so that part of the refusal stands — but the message also names the exact commit the working tree was already rolled back to and the exact manual restart command, since on a host where that unit runs from the same working tree (common — see issue #215), the code-level rollback is otherwise complete. | Run the printed manual restart command; separately roll back the system unit's own config by hand if that also needs it. |

> **Upgrading with an existing `NOPASSWD` sudoers rule — read this if you granted one before PR #221.**
> The probe now sends `systemctl restart -- <unit>`; it previously sent `systemctl restart <unit>`.
> `sudoers(5)`: *"If a Cmnd has associated command line arguments, the arguments in the Cmnd must
> match those given by the user on the command line."* So a rule written as
> `deploy ALL=(root) NOPASSWD: /bin/systemctl restart ocp.service` **no longer matches**, and a host
> where the restart previously succeeded will now hit the `requires "sudo systemctl restart -- <unit>"`
> refusal instead. Nothing is broken and nothing is started — the upgrade refuses and prints the
> command — but it needs a one-character-class edit to the rule:
>
> ```
> -deploy ALL=(root) NOPASSWD: /bin/systemctl restart ocp.service
> +deploy ALL=(root) NOPASSWD: /bin/systemctl restart -- ocp.service
> ```
>
> This affects **only argument-scoped rules**. A rule with no arguments
> (`NOPASSWD: /bin/systemctl`) authorizes any arguments and is unaffected — so the operators who
> scoped their grant most tightly are the ones who need the edit.

If the resolved unit differs from the expected default, that's surfaced
loudly (both on stderr and in the `restart-resolve` phase entry) rather than
restarted silently — this is the fix for
[issue #215](https://github.com/dtzp555-max/ocp/issues/215): a hard-coded
restart target left an orphan `server.mjs` running when the real owner
differed.

**On safety of re-running**: none of the cases above leave an orphan process
behind — nothing new starts until a plan gets past every check above. The
working tree, however, has typically already moved by the time any of these
fire: `ocp update`'s full-upgrade path has already done the git checkout,
`npm install`, and `setup.mjs --reconfigure-only` (which, since
[#226](https://github.com/dtzp555-max/ocp/issues/226), only writes the
service unit/plist and never enables-at-boot or starts anything, so it can't
create an orphan either); `--rollback` has already done the git checkout to
the snapshot's from-commit, the config-file restore, and `npm install`. So
re-running is safe from a corruption standpoint, but you're re-running
against the tree these phases already produced, not your original one.

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
