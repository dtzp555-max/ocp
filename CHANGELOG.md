# Changelog

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
