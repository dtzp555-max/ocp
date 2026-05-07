# Design: SSE Heartbeat on Streaming Path

**Issue:** [#47](https://github.com/dtzp555-max/ocp/issues/47)
**Date:** 2026-04-25
**Status:** Draft (awaiting maintainer approval)
**Target version:** v3.12.0 (minor — new opt-in feature + env var)

---

## Overview

Add an opt-in idle-watchdog heartbeat to OCP's streaming response. When enabled, OCP emits an SSE comment frame (`: keepalive\n\n`) whenever the stream has been idle for a configurable interval. Timer resets on every real frame. Covers both pre-first-byte and mid-stream silent windows. Default **disabled**. Zero behavior change for existing deployments on upgrade.

Companion tweak: `X-Accel-Buffering: no` response header added to both SSE header sites so heartbeats survive nginx-default proxy buffering.

## Motivation

Per [#47](https://github.com/dtzp555-max/ocp/issues/47): when `claude -p` takes a long time to respond (processing large contexts, or executing long tool calls that pause the token stream for 30s–5min), OCP emits no bytes to the downstream client for up to 600s. The caller cannot distinguish "slow but alive" from "hung." A recent incident reported 15 consecutive 600s silent waits cascading into a 2-hour downstream gateway outage.

SSE heartbeats at the application layer let a caller observe liveness without OCP introducing any new client-killing timer.

## Key decisions (with rationale)

Six decisions were fixed during brainstorming. Each is presented as "decision → rationale" so future readers can judge whether a decision is still load-bearing.

### D1. Coverage: whole-stream with idle-watchdog reset-on-byte

A per-request timer starts when SSE headers are written and resets on every real `sendSSE()` call. Heartbeat fires only during genuine idle windows — never during healthy token bursts.

**Rationale.** The `server.mjs:8-10` comment documents Claude tool-use pauses as "30s-5min pauses in the token stream." This means silent windows happen both pre-first-byte AND mid-stream. Covering only one of the two windows means re-opening this issue in three months when a different user reports the uncovered case. The reset-on-byte discipline is a ~2-LOC discipline (`clearTimeout` + `setTimeout` inside `sendSSE`) and is the standard "idle watchdog" pattern.

### D2. Frame format: SSE comment (`: keepalive\n\n`)

**Rationale.** Per SSE spec / MDN, lines starting with `:` are comments and MUST be ignored by conforming parsers. This is the maximally inert shape we can emit. Alternatives considered:
- `event: ping` named event — Anthropic's own Messages API uses this, but on an OpenAI-compatible surface, downstream clients don't recognize that event name, so risk of client confusion is higher.
- Empty-delta JSON chunk — parser-safe on OpenAI-compatible clients but burns an event id and is less observably "a heartbeat" in logs.

The known risk with SSE comments is that some SDKs crash on empty comment frames (`openai-go` issue #556). The default-disabled posture (D3) mitigates this: users who opt in can also verify their client tolerates comments. If the comment format turns out to be broken in the wild for common OCP callers, we can add a second format behind `CLAUDE_HEARTBEAT_FORMAT` in a follow-up — **not in this PR**.

### D3. Default disabled

`CLAUDE_HEARTBEAT_INTERVAL=0` (meaning disabled) is the default when the env var is unset. Any positive integer enables at that ms interval.

**Rationale.** Existing deployments see zero byte-shape change on upgrade. Users who have pingvvino's problem set the env var and get the fix. This is a reversible posture: once field evidence shows comment frames are safe across current OCP callers, a future minor can flip the default to `30000`.

### D4. Header relocation: `ensureHeaders()` moves earlier

Currently `ensureHeaders()` is invoked inside the `proc.stdout` handler, so SSE headers are written only on first byte from claude CLI. This PR moves the `ensureHeaders()` call to immediately after successful `spawn()` return.

**Rationale.** You cannot emit SSE frames before sending SSE headers. For heartbeats to cover the pre-first-byte silent window (pingvvino's "processing large contexts" case), headers must be sent earlier. Behavioral consequence: the narrow "spawn succeeded but subprocess erroneously died before any byte" branch — currently a JSON error response — becomes an SSE error event + `[DONE]` + `res.end()`. Pre-spawn errors (before `spawn()`) still return JSON, unchanged. The affected path is rare (claude CLI either spawns or it doesn't).

### D5. Transport-layer buffering hint: `X-Accel-Buffering: no`

Added to both SSE response header sites (real-streaming `ensureHeaders()` and the cache-hit simulated-streaming header write).

**Rationale.** nginx (and many LBs / Cloudflare) default to buffering proxied responses. Without this header, heartbeat bytes may accumulate in an upstream buffer and never reach the client, defeating the feature silently. This header is a nginx-specific hint; other stacks ignore it. 1 line per site, 2 sites total, indistinguishable-from-no-op for stacks that don't use it.

### D6. Observability: single log line per affected request

On the first heartbeat fire within a request, emit a structured log entry (`logEvent("info", "heartbeat_active", { session, intervalMs })`). No log spam for subsequent fires in the same request.

**Rationale.** For a first-mover feature the question "did the heartbeat actually work for that hung request?" needs to be answerable from the existing `/logs` endpoint alone, without external tooling. One line per affected request gives proof-of-life without polluting the log stream during healthy traffic (where the timer resets and never fires).

## Architecture

Single-file change in `server.mjs`. One new helper plus small patches to existing sites.

```
startHeartbeat(res, intervalMs, sessionId) → { reset(), stop() }
  if intervalMs <= 0: return no-op handle
  internal: handle = setTimeout(intervalMs, onFire)
  onFire():
    res.write(": keepalive\n\n")
    if !hasFired: logEvent("info", "heartbeat_active", { session, intervalMs }); hasFired = true
    handle = setTimeout(intervalMs, onFire)
  reset(): clearTimeout(handle); handle = setTimeout(intervalMs, onFire)
  stop():  clearTimeout(handle); handle = null
```

Handle created once per streaming request. `sendSSE()` calls `heartbeat.reset()` before its `res.write()`. All exit paths call `heartbeat.stop()`.

## Components and LOC budget

| Location | Change | Est LOC |
|---|---|---|
| `server.mjs` env block | Parse `CLAUDE_HEARTBEAT_INTERVAL` | 1 |
| `server.mjs` new `startHeartbeat()` function | Per spec above | 12 |
| `server.mjs:565-579` `ensureHeaders()` | Add `"X-Accel-Buffering": "no"` to header object | 1 |
| `server.mjs:~548-554` streaming entry | Move `ensureHeaders()` call to post-spawn; create heartbeat handle | 3 (net) |
| `server.mjs:669` `sendSSE()` | Accept optional `hb` param; call `hb?.reset()` before `res.write()` | 2 |
| `server.mjs` streaming exit hooks (proc 'close', proc 'error', req 'close') | Call `hb.stop()` | 3 |
| `server.mjs:~610-611` pre-first-byte error branch | If headers sent, SSE error + `[DONE]` + `res.end()` instead of JSON | 3 |
| `server.mjs:1171` cache-hit header write | Add `"X-Accel-Buffering": "no"` | 1 |
| `README.md` env var table | One new row | 1 |
| `README.md` new short section | "Streaming heartbeat" paragraph + nginx note | 5 |
| `CHANGELOG.md` new v3.12.0 entry | Features + Config additions | 4 |
| `package.json` + `ocp-plugin/package.json` + `ocp-plugin/openclaw.plugin.json` | Version bump 3.11.1 → 3.12.0 | 3 |

**Estimated total: ~40 lines.** This is 5–10 lines over the 25–35 budget set in brainstorming. The overshoot is accounted for by D4 (header relocation + SSE error branch) and D5 (X-Accel-Buffering at two sites). Reviewer may reject if actual code lands materially larger than ~45 lines of server.mjs code excluding docs and version files.

## Data flow (streaming request, heartbeat enabled)

1. Client sends `POST /v1/chat/completions` with `stream=true`.
2. Cache miss → `callClaudeStreaming()` invoked.
3. `spawn()` claude subprocess succeeds → `ensureHeaders(res)` writes SSE headers including `X-Accel-Buffering: no`.
4. `const hb = startHeartbeat(res, HEARTBEAT_INTERVAL, sessionId)` arms the watchdog (no-op if interval is 0).
5. Watchdog ticks after `HEARTBEAT_INTERVAL` ms of idle. On fire: `: keepalive\n\n` out; first-fire logs once; re-arm.
6. Every real `sendSSE()` write calls `hb.reset()` — cancels and re-arms timer.
7. Healthy token bursts → heartbeat never fires.
8. Tool-use pause → timer elapses → heartbeat fires → client stays alive → re-arm → repeat until next chunk arrives.
9. On proc 'close' (success / `[DONE]`) / proc 'error' / req 'close' / `CLAUDE_TIMEOUT` kill → `hb.stop()`.

## Error handling

- **Client disconnect mid-heartbeat.** `req.on('close')` fires → `hb.stop()`. Any in-flight write becomes a no-op / emits `'error'` on `res`; existing code already tolerates this.
- **`CLAUDE_TIMEOUT` (600s) fires mid-request.** Existing timeout handler SIGTERM's subprocess → proc 'close' → `hb.stop()`. This PR does **not** fix the separate issue that the current timeout path does not `res.end()` or emit an SSE error frame; that is documented as a separate issue.
- **`spawn()` throws synchronously.** Heartbeat never started. Existing JSON error response unchanged.
- **`spawn()` succeeds, subprocess errors before first byte.** Headers have already been written (per D4). Branch emits an SSE error event + `[DONE]` + `res.end()` instead of a JSON error. Documented behavior change.

## Testing plan

OCP has no unit test framework beyond `test-features.mjs`. Verification is manual + cloud-backed.

### Manual local smoke test

1. Set `CLAUDE_HEARTBEAT_INTERVAL=5000` (5s for easy observation) and start OCP.
2. Issue a streaming completion with a prompt that triggers a tool-use pause (e.g., ask for a large file read or long reasoning):
   ```
   curl -N http://localhost:3456/v1/chat/completions \
     -H "Authorization: Bearer $OCP_KEY" \
     -d '{"model":"claude-opus-4-7","stream":true,
           "messages":[{"role":"user","content":"read the attached 200KB text and summarize"}]}'
   ```
3. Confirm `: keepalive` comment lines appear in the raw response during the pause, at ~5s cadence.
4. Confirm `/logs` shows exactly one `heartbeat_active` entry for the request.
5. With `CLAUDE_HEARTBEAT_INTERVAL=0` (default), confirm no heartbeats and no log line.

### Cloud-backed test run (pre-push, required)

Per project feedback, tests must pass before any push to the public repo. Options, in preference order:

1. **GitHub Actions** — add a temporary smoke workflow (or piggyback on an existing one) that runs `test-features.mjs` against a sandboxed claude mock. Not viable if `test-features.mjs` requires a real claude CLI auth.
2. **Remote Linux test host via cc-chat handoff** — push feature branch, instruct a cloud machine with claude CLI installed to run the manual steps above, capture output, return verdict via cc-chat.
3. **Docker/compose locally** — if the maintainer has Docker available, `docker-compose.yml` is present and can be extended.

The implementation subagent and the reviewer subagent MUST include the chosen verification evidence in the PR body (command + output excerpt, sanitized of any identifiers) before the PR is opened for merge review.

### Downstream-parser compatibility

Before merging, verify at least one real downstream client (OCP's own `ocp-connect`, plus — if feasible — the current OpenClaw gateway) does not crash on comment frames. If a target client crashes, either (a) adjust the default to 0 and document the incompatibility, or (b) scope a follow-up PR for `CLAUDE_HEARTBEAT_FORMAT=empty-delta` as an alternative.

## Privacy preflight (for public-repo push)

Before `gh pr create` or any `git push` to `dtzp555-max/ocp`, run the following scan on the full diff (`git diff origin/main...HEAD`):

1. **Use OCP's PR template privacy self-check** — the `.github/PULL_REQUEST_TEMPLATE.md` Privacy self-check section is the canonical list. Fill every checkbox.
2. **Run `.gitleaks.toml` via gitleaks if available.**
3. **Manual grep on the diff** for these patterns (sanitize any hits before commit):
   - Personal names in any language (check commit-author trailers especially — `Co-Authored-By` lines have leaked names before).
   - Email addresses beyond automated placeholders (`noreply@*`).
   - Local paths like `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` — replace with `$HOME/` or `~/`.
   - Machine hostnames — use role-based names or generic descriptors.
   - IPs, internal URLs, tailnet names.
4. **Log samples and test output** pasted into spec / README / CHANGELOG / PR body must be sanitized pre-paste, not pre-push. This spec doc itself was drafted under this discipline.

Historical reference: PR #43 / postmortem #44 (2026-04-22) scrubbed a prior leak and established the current apparatus. The user has explicitly flagged this as a scar to avoid re-treading for this PR.

## Scope lock (out of scope)

- `server.mjs:480-489` `CLAUDE_TIMEOUT` dangling-client behavior (no `res.end()` / no SSE error frame on timeout kill) — **will be filed as a separate issue** before this PR opens.
- Issue #41 (handleSessionFailure deletes on resume only) — separate.
- Issue #42 (SESSION_TTL and `lastUsed` interaction) — separate.
- Any new first-byte / idle / adaptive-tier timeout logic — explicitly forbidden per the v3.3 lesson (`server.mjs:8-11`, commit 3843ec8).
- Non-streaming chat path — no HTTP-level fix possible per [#47](https://github.com/dtzp555-max/ocp/issues/47)'s own conclusion.
- Named-event format (`event: ping`) or empty-delta JSON chunk variants — possible follow-up PR if field evidence shows comment frames break real clients.
- Changes to `CLAUDE_TIMEOUT` default — unchanged (stays 600s).
- Circuit breaker revival — explicitly forbidden.

## ALIGNMENT.md disposition

`cli.js` does not itself emit SSE heartbeat frames — claude CLI speaks newline-delimited JSON to stdout, not SSE. SSE is an OCP-owned translation layer. Per `ALIGNMENT.md` Rule 2 / `AGENTS.md` ("OCP forwards, observes, and multiplexes traffic that cli.js already emits"): heartbeats are a translation-layer response-shaping concern, not a new endpoint and not a behavior mimicry. The PR body will state this explicitly in the `cli.js` citation checkbox and reference this design doc.

## IDR (Iron Rule 11) disposition

Single PR. Scope is one feature (SSE heartbeat) × one layer (streaming response formatting) × one severity (minor opt-in addition). Release-kit companion files (version bump, CHANGELOG, README) are bundled with the code change per the explicit Iron Rule 11 example ("版本 bump 相关的小改动 + README + CHANGELOG 可以同 PR"). The separate filings for the dangling-client bug (`server.mjs:480-489`) and any follow-up heartbeat format variants are IDR-compliant — each lands as its own PR.

## Related

- Issue: [#47](https://github.com/dtzp555-max/ocp/issues/47)
- Prior timeout scar: commit 3843ec8 (v3.3.0 "simplify timeout to single CLAUDE_TIMEOUT")
- Prior privacy scar: PR [#43](https://github.com/dtzp555-max/ocp/pull/43) / postmortem [#44](https://github.com/dtzp555-max/ocp/issues/44)
- Constitution: `ALIGNMENT.md`
- Project instructions: `AGENTS.md`, `CLAUDE.md`
