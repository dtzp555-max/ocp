# Changelog

## v3.15.1 — 2026-05-10

### Fixes

- **doctor: dynamic `latest_version` from `origin/main:package.json`** — v3.15.0 doctor used a hard-coded `latest = "v3.14.0"` fallback, which made any v3.15.0+ install report `kind = upgrade` (against a stale value). `ocp update` would then attempt `git checkout v3.14.0` — a downgrade. Doctor now fetches `git -C ~/ocp show origin/main:package.json` to determine the actual latest version; on failure (offline, fresh clone with no remote), falls back to `currentVersion` so `kind = noop` instead of recommending a downgrade.

## v3.15.0 — 2026-05-10

### Features

- **`ocp doctor`** — health & upgrade-readiness check; primary entry for AI-driven debugging.
  `--json` mode emits a `next_action` with `ai_executable[]` for agents to run verbatim
  and `human_required[]` for steps requiring the user (typically only OAuth).
- **`ocp update` cross-version path** — for cross-minor jumps (e.g. v3.10 → v3.14),
  `ocp update` now runs doctor → snapshot → `setup.mjs` (with the plist env-merge from
  PR #90) → service restart → post-flight `/health` + `/v1/models` verification.
  Same-patch updates retain the existing light path; users see no change for routine
  patch bumps.
- **`ocp update --rollback`** — restore the most recent (or specified) upgrade snapshot.
  Snapshots are saved to `~/.ocp/upgrade-snapshot-<ISO-ts>/` and never auto-deleted.
- **Fresh-install routing** — `ocp update` on installations < v3.4.0 routes to a fresh-install
  flow (with `--yes` to skip confirmation; AI agents pass this). OAuth survives via Claude
  Code's credential store; users do not re-OAuth unless their token was independently broken.
- **AI prompt blocks in README** — §Installation, §Upgrading, and §Troubleshooting each
  start with a copy-paste prompt for Claude Code / Cursor / Copilot, so users can drive
  install / setup / upgrade through their existing AI assistant.

### Behavior changes

- `ocp update` may take 10–30s longer when a cross-minor jump triggers the full path
  (snapshot + post-flight). Patch bumps are unchanged.
- Pre-v3.4.0 installs are routed to fresh-install rather than failing silently or
  half-migrating.

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.
- Depends on PR #90 (plist env merge bug fix; merged before this release).

## v3.14.0 — 2026-05-10

### Features (security hardening)

- **Per-key session isolation** (PR #86, S1) — the `sessions` Map in `server.mjs` is now keyed by `${keyName}|${conversationId}` instead of bare `conversationId`. Before this fix, two clients using distinct API keys but the same `session_id` value (e.g. both defaulting to `"default"`) would share the same `cli.js` subprocess and conversation history, creating a cross-tenant leak path. Post-fix each (key, session) pair is isolated end-to-end, extending the per-key cache isolation shipped in v3.13.0 D1 to the session layer.
- **On-disk credential file modes 0700/0600** (PR #87, S2) — `setup.mjs` now creates `~/.ocp` at mode 0700 and both `admin-key` and `ocp.db` at mode 0600. An idempotent `reconcileFileModes()` call in `server.mjs` startup tightens any existing installation to these modes automatically on every launch, so existing prod boxes fix themselves without manual `chmod`. Before this fix, all three files were created at the process's default umask (typically world-readable 0644 / 0755), leaving plaintext credentials readable by other local users.
- **`/api/usage` default scope = self; admin all-keys requires `?all=true`** (PR #88, S3) — the usage endpoint now applies a least-privilege default: anonymous callers receive only their own rows, non-admin authenticated callers receive only their own rows, and admin callers receive only their own rows unless they explicitly pass `?all=true`. When `?all=true` is used, an audit log line is emitted. Before this fix, any admin-token holder could silently enumerate usage data for every key on the server.

### Behavior changes

- **Breaking change for admin tooling**: `/api/usage` no longer returns all-keys data by default. Existing cron jobs, dashboards, or scripts that rely on the admin token seeing all-keys output must add `?all=true` to their request URL after upgrading to v3.14.0.
- **File mode reconcile at server startup** logs a one-line notice per path when mode is tightened (e.g. `[security] tightened ~/.ocp/ocp.db → 0600`). No action is required from the operator; the reconcile is idempotent and silent when modes are already correct.
- **`sessions` Map key is now `${keyName}|${conversationId}` internally.** No client-visible wire change — the `session_id` field in request/response is unchanged.

### Verification

- Stress-test pass: 11/11 phases including S1/S2/S3 security regression checks (Phase E, I, J). 35-minute sustained run, 60 calls, 0 errors, 0 timeouts. RSS dropped 51→47 MB across the window. Per-key cache isolation, singleflight, cache_control bypass, quota enforcement, file-mode reconcile, and scope guard against escalation all verified against running code.

### Governance

- All three PRs (#86, #87, #88) include the explicit `cli.js`-citation-not-applicable disclaimer (per PR #75 pattern) since they are OCP-internal access-control, session-state, and file-permission changes with no corresponding `cli.js` operation to cite.

### No new env vars / no public API surface change beyond the documented breaking change

This release adds no new env vars or endpoints. The only externally visible change is the `/api/usage` scope guard (breaking for admin all-keys consumers; see Behavior changes above).

## v3.13.0 — 2026-05-07

### Features (cache layer hardening)

- **Per-key cache isolation** (D1) — the cache key now includes the API key id, so distinct keys never share cache entries. Anonymous/unauthenticated callers share one `anon` pool. Hash format upgraded to `v2`; legacy v1-format rows orphan and are reaped by the existing TTL cleanup interval (no migration script).
- **`cache_control` bypass** (D2) — when a request carries an Anthropic `cache_control` annotation (top-level or nested in a content array), OCP skips its own cache entirely. The caller is using Anthropic-side prompt caching deliberately, and OCP must not interfere. A `cache_skipped{reason: cache_control_present}` log line is emitted on bypass.
- **Chunked stream replay** (D3) — when a streaming request hits the cache, the cached content is now emitted as multiple SSE chunks (80 codepoints/chunk, codepoint-safe via `Array.from()`) instead of a single large delta. Multibyte characters (CJK / emoji) stay intact.
- **Singleflight stampede protection** (D4) — concurrent identical cache-miss requests now share one upstream `cli.js` spawn instead of spawning N processes. Followers receive byte-identical responses to what the leader returns. All-or-nothing failure semantics: if the leader errors, all followers receive the same error. Streaming-path singleflight is explicitly out of scope (TODO left for follow-up).

### Behavior changes

- `/cache/stats` response now includes additive fields `inflight` and `requesters` (current in-flight singleflight entries and total waiting callers). Existing fields `entries`, `totalHits`, `sizeBytes` are preserved unchanged.

### Governance

- New ADR [`docs/adr/0005-no-multi-provider.md`](docs/adr/0005-no-multi-provider.md): OCP stays single-provider (Anthropic via `cli.js` spawn). Multi-provider gateway refactor explicitly out of scope; cache improvements are explicitly in scope.
- Design spec for this release: [`docs/superpowers/specs/2026-05-07-cache-upgrade-design.md`](docs/superpowers/specs/2026-05-07-cache-upgrade-design.md).

### No new env vars / no public API surface change

This release adds no new env vars or endpoints. All four improvements are internal correctness/concurrency upgrades to the existing `CLAUDE_CACHE_TTL`-gated cache layer. No client-observable wire shape change.

## v3.12.0 — 2026-04-25

### Features

- **Streaming heartbeat** — opt-in SSE comment frame (`: keepalive\n\n`) emitted during silent windows on the streaming response. Controlled by `CLAUDE_HEARTBEAT_INTERVAL` env var (ms; `0` = disabled, default). Covers both pre-first-byte and mid-stream tool-use pauses. Addresses #47. See [design doc](docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md).
- **`X-Accel-Buffering: no`** response header added to SSE responses so heartbeats survive nginx/Cloudflare default buffering.

### Behavior changes

- SSE headers are now sent immediately after the claude CLI spawns successfully, not on first stdout byte. The rare "spawn succeeded but subprocess died before any byte" path now closes the SSE stream cleanly rather than returning a JSON error.

### Config additions

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` (disabled) | Interval in ms for SSE keepalive comment frames on streaming path. Resets on every real frame. |

## v3.11.1 — 2026-04-21

### Fixes
- Concurrency slot leak on subprocess timeout (#37). The request-timeout handler called `proc.kill("SIGTERM")` without decrementing `stats.activeRequests`. A subprocess stuck in a syscall that ignored SIGTERM would hold its slot until (or beyond) the 5s SIGKILL escalation actually reaped it. Slot release is now wired to `proc.once("exit", cleanup)` so every termination path — normal close, error, SIGTERM, SIGKILL — releases the slot exactly once.

## v3.11.0 — 2026-04-20

### Features
- `ocp update` now automatically syncs OpenClaw's registry with the latest models (scripts/sync-openclaw.mjs)
- Server logs warn if OpenClaw registry drifts from models.json

### Refactor
- models.json is now the single source of truth for model list
- server.mjs and setup.mjs derive MODEL_MAP/MODELS from models.json
- Adding a new model is now a one-file edit

### Fixes
- OpenClaw's model dropdown now shows all 4 current models (opus-4-7, opus-4-6, sonnet-4-6, haiku-4.5) on existing installs after `ocp update`. Previously setup.mjs only wrote the registry at install time.
