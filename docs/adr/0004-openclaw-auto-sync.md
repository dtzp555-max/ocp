# 0004 — OpenClaw Auto-Sync on `ocp update`

- **Date**: 2026-04-20
- **Status**: Accepted
- **Authors**: project maintainer (with AI drafting assistance)
- **Related**: PR #31, commit 5ef163a; builds on ADR 0003

## Context

v3.10.0 added Claude Opus 4.7 to OCP's `server.mjs` `MODEL_MAP`. Native Claude Code users and other IDE consumers (Cline, Aider, Cursor) saw the new model immediately, because every one of those clients queries `/v1/models` live at session start.

OpenClaw is different. OpenClaw caches its provider/model list in `~/.openclaw/openclaw.json`, written exactly once during OCP's `setup.mjs` run, then treated as immutable until the user manually edits it. An OpenClaw user who installed OCP in, say, v3.7 and diligently ran `ocp update` through v3.10 still saw only the pre-Claude-4 model list. From their perspective, `ocp update` "did not do what it said."

Within two weeks of v3.10.0, three separate bug reports surfaced, all with the same root cause: OpenClaw's cache was stale. Users tried the obvious workarounds (reinstall OpenClaw, edit the JSON by hand) and reported those as additional bugs when they misformatted the file.

The underlying asymmetry: every other IDE integration is pull-based (asks OCP for models on demand); OpenClaw is push-based (was told once, caches forever). OCP had no mechanism for a subsequent push.

Additionally, ADR 0003 had just landed `models.json` as the single source of truth — meaning the data a sync mechanism would need was now available in a machine-readable file rather than scattered across `server.mjs`.

## Decision

Add `scripts/sync-openclaw.mjs`, invoked automatically at the end of `ocp update`, plus a passive drift self-check in `server.mjs` startup. Design constraints:

1. **Strictly scoped.** The script only touches two sub-trees of `~/.openclaw/openclaw.json`:
   - `models.providers["claude-local"].models` — the provider's model list.
   - `agents.defaults.models["claude-local/*"]` — per-agent defaults that reference claude-local models.
   All other OpenClaw config (user-defined agents, non-claude-local providers, UI preferences) is left untouched.

2. **Idempotent.** Running the script twice with the same `models.json` produces the same file both times — byte-identical. The script diffs before writing and no-ops if there is nothing to change.

3. **Safe.** Before any write, the script creates a timestamped backup at `~/.openclaw/openclaw.json.bak.<ISO8601>`. The user can always roll back.

4. **Non-fatal.** If `~/.openclaw/openclaw.json` is missing (OpenClaw not installed), malformed, or otherwise unwriteable, the script logs a single-line warning and exits 0. `ocp update` never fails because of sync.

5. **Manually invocable.** `node scripts/sync-openclaw.mjs` runs the sync as a standalone operation, for users who want to trigger it without a full `ocp update`.

6. **Passive drift self-check.** On server startup, `server.mjs` reads the `claude-local` model list from `openclaw.json` (if present) and compares against the models derived from `models.json`. Mismatches produce a single WARN log line — enough to alert the user without taking action. This is the "we noticed" signal; the fix is to run `ocp update`.

Implementation source: the sync script reads the SPOT (`models.json`), produces the canonical claude-local model list, merges it into the OpenClaw config in the two scoped locations, writes atomically (write-to-temp then rename), and logs the diff.

## Consequences

**Positive**

- Users get new models on the next `ocp update` with no manual action. The invariant OCP's update flow was advertising is now actually true.
- Manual invocation remains available for users who want to sync without updating OCP itself (edge case, but cheap to support).
- Passive self-check means even users who somehow skip `ocp update` receive a runtime heads-up instead of silent drift.
- The script is short (under 150 lines) and testable in isolation.

**Negative**

- One-time bootstrap quirk: users upgrading from v3.10 → v3.11 have a cached `cmd_update` in their existing installation that does not yet invoke the new script. The first `ocp update` to v3.11 still misses the sync; the second `ocp update` (now running v3.11's code) performs it. This is documented in README § "Troubleshooting" per the release_kit `bootstrap_quirk_policy`.
- A new script to maintain. If OpenClaw's config schema changes, this script needs updating. The strict-scope constraint bounds the maintenance surface.
- Non-fatal-on-error means a broken `openclaw.json` silently stays broken from OCP's perspective. Accepted trade-off: `ocp update` failing because of a sibling tool's config would be worse.

**Follow-ons**

- If OpenClaw ever adopts live `/v1/models` polling upstream, this script becomes redundant and can be deleted per ADR 0002's Rule 4 (unalignable-to-upstream features are deleted).
- Similar sync needs for future sibling tools would follow this pattern: separate script, strictly scoped, idempotent, non-fatal, invoked by `ocp update`.

## Alternatives considered

**(a) Modify OpenClaw itself to poll `/v1/models` live.** The "correct" fix at the architecture level. Rejected: OCP is a tenant in OpenClaw's plugin model, not its owner. Opening an upstream PR creates a cross-repo coordination dependency (review timeline, release timeline, version matrix) that leaves current OCP users broken for weeks or months. The sync script is something OCP can ship unilaterally and remove later if the upstream change lands.

**(b) Re-run `setup.mjs` in full.** `setup.mjs` already knows how to write `openclaw.json` from scratch. Rejected: `setup.mjs` has many side effects beyond OpenClaw registration — it rewrites user shell rc files, regenerates systemd units, touches credential storage. It is explicitly not idempotent, and running it a second time on an already-configured system produces duplicate entries or regressions. The sync script's strict scope is the whole point; re-running `setup.mjs` would blow past it.

**(c) Do nothing — tell users to manually edit `~/.openclaw/openclaw.json`.** Rejected for two reasons. First, UX: OCP's value proposition includes "`ocp update` keeps your toolchain current," and asking users to hand-edit a third party's JSON breaks that promise. Second, error rate: the three bug reports that motivated this ADR included two malformed-JSON follow-ups from users who tried the manual approach. A machine-written file is strictly safer than a hand-edited one.
