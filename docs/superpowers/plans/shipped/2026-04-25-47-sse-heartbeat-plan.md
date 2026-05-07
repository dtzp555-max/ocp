# OCP #47 SSE Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opt-in SSE comment-frame heartbeat on OCP's streaming response path (default disabled, `CLAUDE_HEARTBEAT_INTERVAL` env var), addressing issue #47 while preserving the v3.3 single-timeout architecture.

**Architecture:** Per-request idle-watchdog `setTimeout`, reset on every real `sendSSE()` write, emits `: keepalive\n\n` comment frames during silent windows. `ensureHeaders()` moved to post-spawn so heartbeats cover the pre-first-byte window. Also adds `X-Accel-Buffering: no` to both SSE header sites to survive proxy buffering.

**Tech Stack:** Node.js ≥18 (native ESM), no build step, single-file entrypoint `server.mjs`. No test framework beyond `test-features.mjs`. Verification is manual + cloud-backed.

**Spec:** [`docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md`](../specs/2026-04-25-47-sse-heartbeat-design.md) (committed at `b0b3eef` on branch `feat/47-sse-heartbeat`)

**Out of scope (from spec §Scope lock):** `server.mjs:480-489` dangling-client bug, #41, #42, circuit breaker revival, any first-byte/idle timeout logic, non-streaming path, named-event / empty-delta alternate heartbeat format, `CLAUDE_TIMEOUT` default changes.

---

## Phase order (high level)

| # | Phase | Who | Blocking gate |
|---|---|---|---|
| 0 | Pre-work: file separate issue for `server.mjs:480-489` bug | main thread | Before Phase 1 opens |
| 1 | Implementation (5 tasks, 5 commits) | 1 sonnet subagent | Commits land on `feat/47-sse-heartbeat` |
| 2 | Independent code review | 1 opus fresh-context subagent | APPROVE or REQUEST_CHANGES |
| 3 | Cloud verification (smoke + negative + log) | main thread, cc-chat to Mac rig if needed | SSE bytes + log entries captured and sanitized |
| 4 | Privacy preflight on full branch diff | main thread | Zero personal identifier hits |
| 5 | Push, open PR with all evidence, await merge | main thread | GitHub Actions pass, reviewer approves |
| 6 | Release kit (auto-triggered by tag) | main thread | v3.12.0 GH Release created, README/CHANGELOG reflect |

---

## Phase 0: Pre-work

### Task 0.1: File separate issue for `server.mjs:480-489` dangling-client bug

**Files:** (none — GitHub-only operation)

- [ ] **Step 1: Create issue via `gh`**

Run from any OCP working directory:

```bash
gh issue create --repo dtzp555-max/ocp \
  --title "bug(streaming): CLAUDE_TIMEOUT path does not res.end() or emit SSE error frame" \
  --body "$(cat <<'EOF'
## Symptom
When `CLAUDE_TIMEOUT` (default 600s, `server.mjs:83`) elapses during a streaming request, the timeout handler at `server.mjs:480-489` logs `request_timeout` and SIGTERMs the subprocess, but does **not** call `res.end()` nor emit an SSE error/stop frame. If SSE headers were already sent, the HTTP response is left in an open, byte-less state until the downstream client's own idle timeout fires.

## Location
- `server.mjs:480-489` — timeout handler
- Streaming branches post-headers: `server.mjs:612-619` (proc close code!==0), `server.mjs:647-651` (proc error)

## Impact
Downstream clients cannot distinguish "still waiting" from "gave up" without their own timeout. Contributes to the cascading-failure class described in #47.

## Status
Identified during #47 spec review (see [design doc](../../blob/feat/47-sse-heartbeat/docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md)). **Evidence needed before code change** — do not patch speculatively. Pair with #47's SSE heartbeat work once logs are available from the original reporter.

## Related
- #47 — SSE heartbeat feature (explicitly scope-locks this bug as separate)
- v3.3 timeout refactor lesson (commit `3843ec8`)
EOF
)"
```

Expected: issue URL printed.

- [ ] **Step 2: Note issue number**

Record the returned issue number; you will reference it from the Phase 5 PR body's "Out of scope" section.

---

## Phase 1: Implementation (sonnet subagent)

**Subagent dispatch:** one sonnet subagent for all five tasks. Fresh context. Hand it: the spec path, this plan path, feature branch name, and the scope lock reminder. The subagent commits on `feat/47-sse-heartbeat`.

**Verification between tasks:** each task ends with `node -c server.mjs` (syntax check) and a commit. No runtime test between tasks — runtime verification happens in Phase 3.

---

### Task 1.1: Add `HEARTBEAT_INTERVAL` env var + `startHeartbeat()` helper

**Files:**
- Modify: `server.mjs:~96` (env var block) — add one line
- Modify: `server.mjs:~544` (just above `callClaudeStreaming`) — add helper function

- [ ] **Step 1: Add env var after line 96**

Insert a new line after the `BREAKER_HALF_OPEN_MAX` line (`server.mjs:96`):

```javascript
const HEARTBEAT_INTERVAL = parseInt(process.env.CLAUDE_HEARTBEAT_INTERVAL || "0", 10);
```

- [ ] **Step 2: Add header-block documentation for env var**

In the top-of-file `/** ... */` block (around line 8-28), after the `CLAUDE_TIMEOUT` line add:

```javascript
 *   CLAUDE_HEARTBEAT_INTERVAL    — SSE heartbeat interval in ms on streaming path (default: 0 = disabled)
```

- [ ] **Step 3: Add `startHeartbeat()` helper above `callClaudeStreaming`**

Insert this function immediately before line 545 (`// ── Call claude CLI (real streaming) ──`):

```javascript
// ── SSE heartbeat (opt-in idle watchdog) ────────────────────────────────
// Emits `: keepalive\n\n` SSE comment frames during silent windows on the
// streaming response. Design: docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md
// This is a downstream liveness hint only — it MUST NOT be able to abort
// or time out a request. That discipline is load-bearing: v2.2-v2.5's
// first-byte/adaptive-tier timeouts "repeatedly killed valid requests"
// (see server.mjs top-of-file comment and commit 3843ec8).
function startHeartbeat(res, intervalMs, sessionId) {
  if (!intervalMs || intervalMs <= 0) return { reset: () => {}, stop: () => {} };
  let handle = null;
  let hasFired = false;
  const onFire = () => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": keepalive\n\n");
    if (!hasFired) {
      hasFired = true;
      logEvent("info", "heartbeat_active", { session: sessionId, intervalMs });
    }
    handle = setTimeout(onFire, intervalMs);
  };
  handle = setTimeout(onFire, intervalMs);
  return {
    reset: () => { if (handle) { clearTimeout(handle); handle = setTimeout(onFire, intervalMs); } },
    stop:  () => { if (handle) { clearTimeout(handle); handle = null; } },
  };
}
```

- [ ] **Step 4: Verify syntax**

```bash
cd ~/ocp && node -c server.mjs
```

Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
feat(server): add startHeartbeat helper + HEARTBEAT_INTERVAL env var

Per design doc (refs #47). Helper is a per-request idle watchdog that
emits `: keepalive\n\n` SSE comment frames; returns a {reset, stop} handle.
No wiring yet — helper is unused, safe to commit in isolation.

cli.js citation: N/A — SSE response shaping is an OCP-owned translation
layer, not a cli.js operation. See AGENTS.md and ALIGNMENT.md Rule 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: Move `ensureHeaders()` call to post-spawn (D4 — isolated commit)

**Files:** Modify `server.mjs:~579` (just after `ensureHeaders` function body closes, before `proc.stdout.on("data")`)

**Why isolated:** This is the one behavioral change in the PR. Reviewer focuses on it separately via `git show <this-commit>`.

- [ ] **Step 1: Read current state at server.mjs:579-581**

Current:
```javascript
    return true;
  }

  proc.stdout.on("data", (d) => {
```

- [ ] **Step 2: Insert eager `ensureHeaders()` call**

Modified:
```javascript
    return true;
  }

  // D4 (spec 2026-04-25): eagerly send SSE headers post-spawn so the
  // heartbeat started in the next statement (Task 1.3) covers the
  // pre-first-byte silent window. Behavior change: the `code !== 0`
  // before-first-byte branch at server.mjs:610-611 becomes effectively
  // unreachable in the common case — the post-headers SSE-stop path
  // (612-619) handles it instead.
  ensureHeaders();

  proc.stdout.on("data", (d) => {
```

- [ ] **Step 3: Verify syntax**

```bash
cd ~/ocp && node -c server.mjs
```

Expected: no output, exit 0.

- [ ] **Step 4: Commit (ISOLATED — behavior change only)**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
refactor(server): eagerly send SSE headers post-spawn (D4, refs #47)

Moves the ensureHeaders() call from "on first stdout byte" to
"immediately after successful spawn." This is a prerequisite for the
heartbeat covering the pre-first-byte silent window (the 'processing
large contexts' failure mode in #47).

Behavioral consequence: the narrow "spawn succeeded but subprocess died
before any byte" branch at server.mjs:610-611 becomes effectively dead
in the common case. The post-headers SSE-stop path (612-619) handles
it instead. The branch remains defensively for the client-closed-before-
ensureHeaders race.

Isolated commit per design doc §D4 so reviewer can focus on this one
behavior change.

cli.js citation: N/A — SSE header emission is OCP response-shaping.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: Wire heartbeat into `callClaudeStreaming` + `sendSSE`

**Files:** Modify `server.mjs` — multiple sites inside `callClaudeStreaming` (lines 548-660) and `sendSSE` (line 669).

- [ ] **Step 1: Update `sendSSE` signature to accept optional heartbeat handle**

Current (line 669-671):
```javascript
function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

Modified:
```javascript
function sendSSE(res, data, hb) {
  hb?.reset();
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

- [ ] **Step 2: Start heartbeat after the eager `ensureHeaders()` call from Task 1.2**

Current (after Task 1.2 changes, ~line 582):
```javascript
  ensureHeaders();

  proc.stdout.on("data", (d) => {
```

Modified:
```javascript
  ensureHeaders();
  const hb = startHeartbeat(res, HEARTBEAT_INTERVAL, convId);

  proc.stdout.on("data", (d) => {
```

- [ ] **Step 3: Pass `hb` to sendSSE calls inside `callClaudeStreaming` streaming frames**

Modify three `sendSSE(res, { ... })` calls inside `callClaudeStreaming` to pass `hb` as third argument:

**Line ~590** (stream chunk):
```javascript
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }, hb);
```

**Line ~613** (proc.close code !== 0, post-headers stop chunk):
```javascript
        sendSSE(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }, hb);
```

**Line ~632** (proc.close success, stop chunk):
```javascript
        sendSSE(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }, hb);
```

Leave the initial role chunk inside `ensureHeaders` (line 574) unchanged — it fires before `hb` exists and doesn't need reset semantics.

- [ ] **Step 4: Add `hb.stop()` to all three exit handlers**

**proc.on('close')** — add as first line after `activeProcesses.delete(proc);` at line 599:
```javascript
  proc.on("close", (code, signal) => {
    activeProcesses.delete(proc);
    hb.stop();
    cleanup();
```

**proc.on('error')** — add as first line after `console.error(...)` at line 643:
```javascript
  proc.on("error", (err) => {
    console.error(`[claude] spawn error: ${err.message}`);
    hb.stop();
    cleanup();
```

**res.on('close')** — modify the body at line 655-659:
```javascript
  res.on("close", () => {
    hb.stop();
    if (!proc.killed) {
      try { proc.kill("SIGTERM"); } catch {}
    }
  });
```

- [ ] **Step 5: Verify syntax**

```bash
cd ~/ocp && node -c server.mjs
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
feat(server): wire heartbeat into streaming path (refs #47)

- sendSSE() accepts optional hb handle and calls hb.reset() before write
- callClaudeStreaming starts heartbeat after ensureHeaders() and passes
  hb to the three streaming sendSSE call sites
- All three exit paths (proc close, proc error, res close) call
  hb.stop() to guarantee timer cleanup; no-op handle when disabled
  means zero runtime cost when CLAUDE_HEARTBEAT_INTERVAL=0

Heartbeat never aborts — only writes comment frames and re-arms. Aligns
with v3.3 timeout discipline (single CLAUDE_TIMEOUT, no secondary
client-killing timers).

cli.js citation: N/A — SSE response shaping is OCP translation layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: Add `X-Accel-Buffering: no` to both SSE header sites

**Files:** Modify `server.mjs` at two SSE header-write sites.

- [ ] **Step 1: Add to real-streaming `ensureHeaders()` (server.mjs:568-572)**

Current:
```javascript
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
```

Modified:
```javascript
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
```

- [ ] **Step 2: Add to cache-hit streaming (server.mjs:1171)**

Current:
```javascript
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
```

Modified:
```javascript
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
```

- [ ] **Step 3: Verify syntax**

```bash
cd ~/ocp && node -c server.mjs
```

Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add server.mjs
git commit -m "$(cat <<'EOF'
feat(server): add X-Accel-Buffering: no to SSE response headers (refs #47)

nginx (and many LBs / Cloudflare) default to proxy_buffering=on, which
would buffer heartbeat comment frames indefinitely and defeat the
feature silently. This header hints no-buffering; other stacks ignore
it. Applied at both SSE header sites (real streaming + cache-hit).

cli.js citation: N/A — response header shaping is OCP translation layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.5: Version bump + CHANGELOG + README (release kit)

**Files:**
- Modify: `package.json` (version field)
- Modify: `ocp-plugin/package.json` (version field)
- Modify: `ocp-plugin/openclaw.plugin.json` (version field)
- Modify: `CHANGELOG.md` (new top section)
- Modify: `README.md` (env var table row + new short section)

- [ ] **Step 1: Read current versions**

```bash
cd ~/ocp
grep '"version"' package.json ocp-plugin/package.json ocp-plugin/openclaw.plugin.json
```

Expected output will show current version (likely `3.11.1`). Record it.

- [ ] **Step 2: Bump all three version files to 3.12.0**

In each file, change the `"version"` field value from the current version to `"3.12.0"`. Only the version string changes.

- [ ] **Step 3: Read current CHANGELOG.md top**

```bash
head -30 ~/ocp/CHANGELOG.md
```

Note where the previous version entry begins so you can insert a new section above it.

- [ ] **Step 4: Prepend v3.12.0 section to CHANGELOG.md**

Insert directly after the `# Changelog` heading (and any file header), before the previous version section:

```markdown
## v3.12.0 (2026-04-25)

### Features

- **Streaming heartbeat** — opt-in SSE comment frame (`: keepalive\n\n`) emitted during silent windows on the streaming response. Controlled by `CLAUDE_HEARTBEAT_INTERVAL` env var (ms; `0` = disabled, default). Covers both pre-first-byte and mid-stream tool-use pauses. Addresses #47. See [design doc](docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md).
- **`X-Accel-Buffering: no`** response header added to SSE responses so heartbeats survive nginx/Cloudflare default buffering.

### Behavior changes

- SSE headers are now sent immediately after the claude CLI spawns successfully, not on first stdout byte. The rare "spawn succeeded but subprocess died before any byte" path now closes the SSE stream cleanly rather than returning a JSON error.

### Config additions

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` (disabled) | Interval in ms for SSE keepalive comment frames on streaming path. Resets on every real frame. |
```

- [ ] **Step 5: Add env var row to README.md Environment Variables table**

Find the env var table in `README.md` (has `CLAUDE_PROXY_PORT`, `CLAUDE_TIMEOUT`, etc.). Add a new row immediately after the `CLAUDE_TIMEOUT` row:

```markdown
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` | Streaming SSE keepalive interval (ms). `0` = disabled. See "Streaming heartbeat" section. |
```

- [ ] **Step 6: Add "Streaming heartbeat" section to README.md**

Insert a new subsection in README.md's Configuration or Usage section (placement: after the env var table, or in a Troubleshooting / Long-running requests area — follow existing README structure):

```markdown
### Streaming heartbeat

When `CLAUDE_HEARTBEAT_INTERVAL` is set to a positive integer (milliseconds), OCP emits an SSE comment frame (`: keepalive\n\n`) on streaming responses whenever the stream has been idle for that duration. The timer resets on every real chunk, so heartbeats only fire during genuine silent windows (for example, Claude CLI tool-use pauses of 30s–5min, or a long "processing large contexts" delay before the first token).

Use cases: downstream HTTP clients or load balancers with idle-connection timeouts that would otherwise abort a slow-but-alive request. `CLAUDE_HEARTBEAT_INTERVAL=30000` (30s) is a reasonable starting value if your downstream has a 60s idle timeout.

Heartbeats are inert SSE comment lines — conforming SSE clients ignore them. If your downstream client's SSE parser crashes on comment frames, leave this disabled (the default) and file an issue so we can consider an alternate frame format.

OCP also sends `X-Accel-Buffering: no` on SSE responses so nginx-default proxy buffering does not hold heartbeats in an upstream buffer.
```

- [ ] **Step 7: Verify no JSON syntax break in any of the three version files**

```bash
cd ~/ocp
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('ocp-plugin/package.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('ocp-plugin/openclaw.plugin.json','utf8'))"
```

Expected: no output on each. Exit 0.

- [ ] **Step 8: Commit**

```bash
git add package.json ocp-plugin/package.json ocp-plugin/openclaw.plugin.json CHANGELOG.md README.md
git commit -m "$(cat <<'EOF'
chore(release): v3.12.0 — streaming heartbeat (refs #47)

Bundles the release-kit companion files per Iron Rule 5.2 / 11 example:
version bump across package.json + ocp-plugin + openclaw.plugin.json,
CHANGELOG v3.12.0 section, README env var row + "Streaming heartbeat"
explainer.

Tag push to v3.12.0 triggers .github/workflows/release.yml to create
the GitHub Release automatically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.6: Hand off to reviewer

- [ ] **Step 1: Confirm branch state**

```bash
cd ~/ocp && git log --oneline feat/47-sse-heartbeat ^main
```

Expected: exactly 6 commits on the branch (1 spec + 5 implementation):
```
<hash> chore(release): v3.12.0 — streaming heartbeat (refs #47)
<hash> feat(server): add X-Accel-Buffering: no to SSE response headers (refs #47)
<hash> feat(server): wire heartbeat into streaming path (refs #47)
<hash> refactor(server): eagerly send SSE headers post-spawn (D4, refs #47)
<hash> feat(server): add startHeartbeat helper + HEARTBEAT_INTERVAL env var
b0b3eef docs(spec): design for #47 SSE heartbeat on streaming path
```

- [ ] **Step 2: Confirm LOC budget**

```bash
cd ~/ocp && git diff main...feat/47-sse-heartbeat --stat -- server.mjs
git diff main...feat/47-sse-heartbeat --stat -- README.md CHANGELOG.md 'package*.json' ocp-plugin/
```

Expected: `server.mjs` change ≤ 45 insertions net. Total diff ≤ 70 insertions combined.

If server.mjs exceeds 45 lines of code added, stop and flag this as a scope-creep signal before dispatching reviewer.

---

## Phase 2: Independent code review (opus fresh-context subagent)

**Subagent:** fresh-context opus. Reads ONLY the spec + the branch diff (not this plan, not the prior conversation). Scope: confirm design compliance, scope lock compliance, privacy preflight readiness, and ALIGNMENT.md fit.

### Task 2.1: Dispatch opus reviewer

- [ ] **Step 1: Prepare review brief**

Reviewer prompt must include:
- Spec path: `docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md`
- Branch: `feat/47-sse-heartbeat`
- Diff command: `git diff main...feat/47-sse-heartbeat`
- Explicit: reviewer is a fresh context; do NOT consult the conversation that produced the spec.

- [ ] **Step 2: Review checklist (reviewer must verify each)**

```
1. D1 whole-stream coverage: confirm sendSSE reset is called on every real streaming frame (3 sites inside callClaudeStreaming). Heartbeat NEVER fires inside the cache-hit path (which does not start a heartbeat).
2. D2 frame format: confirm the only heartbeat emission is literally `res.write(": keepalive\n\n")`. No named event, no empty-delta JSON.
3. D3 default disabled: confirm env var parsed with `|| "0"` default AND the helper's `if (!intervalMs || intervalMs <= 0) return no-op` guard exists.
4. D4 header relocation: confirm `ensureHeaders()` is called eagerly after spawn and the behavior-change commit is isolated. Confirm the pre-first-byte error branches are unchanged in code (their unreachable-in-common-case status is documented in the commit message, not enforced by code removal).
5. D5 X-Accel-Buffering: confirm the header appears at exactly the two SSE header sites — server.mjs:~568 (ensureHeaders) and server.mjs:~1171 (cache-hit). Not added to any JSON response or non-SSE path.
6. D6 observability: confirm exactly one logEvent("info", "heartbeat_active", ...) per request, gated by `hasFired` flag. No log spam.

7. Scope lock: scan the diff for any unrelated changes. Reject any of:
   - Changes to server.mjs:480-489 timeout handler
   - Changes to session/TTL/concurrency logic
   - New circuit breaker / failure counter logic
   - Any new *_TIMEOUT env var
   - Changes to non-streaming path
   - Named-event or empty-delta heartbeat variants

8. Heartbeat cannot abort: confirm startHeartbeat's onFire only writes and re-arms. No `res.end()`, no `proc.kill`, no error throwing. Cannot cause request termination under any timer path.

9. ALIGNMENT.md: confirm all commit messages state cli.js citation status explicitly. Confirm no alignment.yml blacklisted tokens (api/oauth/usage, api/usage) introduced.

10. Privacy preflight readiness: run `git diff main...feat/47-sse-heartbeat | grep -iE "taodeng|Tao |@gmail|Taos-Mac|MacBook-Pro|C:\\\\Users\\\\|/Users/[a-z]|/home/[a-z]"` — must return zero hits.

11. LOC budget: server.mjs code insertions net ≤ 45 lines.

12. Syntax: `node -c server.mjs` passes.
```

- [ ] **Step 3: Dispatch reviewer (see agent-dispatch skill / cc-rules for exact Agent tool invocation)**

```
Agent({
  description: "Fresh-context review of #47 PR",
  subagent_type: "general-purpose",
  model: "opus",
  prompt: "<paste the review checklist + spec path + branch name above>"
})
```

- [ ] **Step 4: Read reviewer's verdict**

Two outcomes:

- **APPROVE** → proceed to Phase 3.
- **REQUEST_CHANGES with specific findings** → return to Phase 1, dispatch a sonnet subagent to apply fixes (one fix-commit per finding), then re-dispatch a fresh reviewer (can be the same one via SendMessage with the new diff, or a brand-new opus for a true fresh re-read if the change is substantive).

---

## Phase 3: Cloud verification

**Environment:** The Mac mini OCP rig at `~/ocp/` (per auto-memory handoff 2026-04-21) is the reference cloud-backed test host. If that rig is unavailable, an Ubuntu cloud VM with claude CLI installed is acceptable. **Local Windows verification is NOT sufficient for Phase 3 evidence** per user feedback (cloud testing required).

### Task 3.1: Cloud smoke test (heartbeat enabled)

- [ ] **Step 1: Deploy feature branch to test rig**

Via cc-chat or ssh, instruct the Mac rig to:
```bash
cd ~/ocp && git fetch origin feat/47-sse-heartbeat:feat/47-sse-heartbeat
git checkout feat/47-sse-heartbeat
./ocp stop 2>/dev/null || true
CLAUDE_HEARTBEAT_INTERVAL=5000 ./ocp start   # 5s interval for fast observation
sleep 2
./ocp status
```

Expected: status shows running, version 3.12.0.

- [ ] **Step 2: Issue a streaming request that triggers a tool-use pause**

```bash
curl -N -sS -D /tmp/ocp-headers.txt \
  -H "Authorization: Bearer $OCP_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3456/v1/chat/completions \
  -d '{
    "model":"claude-opus-4-7",
    "stream":true,
    "messages":[{"role":"user","content":"List the files in your current directory by running ls, then summarize what each is."}]
  }' \
  | tee /tmp/ocp-stream.txt \
  | head -50
```

- [ ] **Step 3: Verify response headers include X-Accel-Buffering: no**

```bash
grep -i 'x-accel-buffering' /tmp/ocp-headers.txt
```

Expected: `X-Accel-Buffering: no`

- [ ] **Step 4: Verify heartbeat lines appear in the stream**

```bash
grep -c '^: keepalive$' /tmp/ocp-stream.txt
```

Expected: integer > 0. If the tool use took >5s, you should see at least one heartbeat.

- [ ] **Step 5: Verify `heartbeat_active` log entry**

```bash
curl -sS http://localhost:3456/logs | grep heartbeat_active | tail -5
```

Expected: at least one log line with `"event":"heartbeat_active"`, `"intervalMs":5000`, and a session id (truncated). Sanitize any host-path or identifier fields before pasting into PR body.

### Task 3.2: Cloud negative test (heartbeat disabled)

- [ ] **Step 1: Restart OCP with heartbeat disabled**

```bash
./ocp stop
CLAUDE_HEARTBEAT_INTERVAL=0 ./ocp start    # explicit 0 = disabled
sleep 2
```

- [ ] **Step 2: Re-run the same curl as Task 3.1 Step 2, capture to a different file**

```bash
curl -N -sS -D /tmp/ocp-headers-off.txt \
  -H "Authorization: Bearer $OCP_KEY" \
  -H "Content-Type: application/json" \
  http://localhost:3456/v1/chat/completions \
  -d '{"model":"claude-opus-4-7","stream":true,"messages":[{"role":"user","content":"List the files in your current directory by running ls, then summarize what each is."}]}' \
  | tee /tmp/ocp-stream-off.txt \
  | head -50
```

- [ ] **Step 3: Verify zero heartbeat lines**

```bash
grep -c '^: keepalive$' /tmp/ocp-stream-off.txt
```

Expected: `0`.

- [ ] **Step 4: Verify zero heartbeat_active log entries for this run**

```bash
# note timestamp at start of Step 1, then:
curl -sS http://localhost:3456/logs | grep heartbeat_active | grep -v "<timestamp-before-restart>"
```

Expected: no matches from this run.

- [ ] **Step 5: Verify X-Accel-Buffering: no is STILL present (it's on the headers regardless of heartbeat state)**

```bash
grep -i 'x-accel-buffering' /tmp/ocp-headers-off.txt
```

Expected: `X-Accel-Buffering: no`.

### Task 3.3: Sanitize evidence for PR body

- [ ] **Step 1: Extract a representative evidence snippet**

Build an evidence block that contains:
- curl commands (exactly as run, but with `$OCP_KEY` substituted literally — do not paste the real token)
- 6-10 lines of `/tmp/ocp-stream.txt` showing at minimum: `data:` role line, at least one `data:` content line, at least one `: keepalive` heartbeat line, final `data: [DONE]`.
- The `heartbeat_active` log line (truncate session id to first 8 chars; strip any `host` / `pid` / `cwd` fields).
- The negative-test `grep -c` showing `0`.

- [ ] **Step 2: Scrub sample**

Run through the privacy grep (Phase 4 Step 2 pattern list) on the evidence block. Fix or redact any hits BEFORE copying into the PR body.

- [ ] **Step 3: Save evidence to a local file**

```
~/ocp-verification-evidence-47.txt   # NOT checked in, NOT uploaded, local only
```

Keep for reference; do not commit it.

---

## Phase 4: Privacy preflight

### Task 4.1: Run gitleaks on branch diff

- [ ] **Step 1: Run gitleaks if installed**

```bash
cd ~/ocp
which gitleaks && gitleaks detect --source=. --config=.gitleaks.toml --log-opts="main..feat/47-sse-heartbeat" || echo "gitleaks not installed, skip"
```

Expected: no findings, or "gitleaks not installed" (in which case Step 2 manual grep is load-bearing).

### Task 4.2: Manual identifier grep on full branch diff

- [ ] **Step 1: Build the full diff**

```bash
cd ~/ocp
git diff main...feat/47-sse-heartbeat > /tmp/ocp-47-diff.patch
```

- [ ] **Step 2: Grep for personal-identifier patterns**

```bash
grep -inE 'taodeng|@gmail\.com|@yahoo|@hotmail|Taos-Mac|MacBook-Pro|Tao Deng|C:\\Users\\[A-Za-z]+\\|/Users/[a-z]+/|/home/[a-z]+/' /tmp/ocp-47-diff.patch
```

Expected: zero hits. Any hit must be investigated and either sanitized or justified (e.g., `noreply@anthropic.com` in Co-Authored-By trailers is fine; a real personal email is not).

- [ ] **Step 3: Grep for machine hostnames**

```bash
grep -inE '([A-Z][a-z]+(-Mac(-mini|Book-Pro)?|-[A-Z][a-z]+-[0-9]+))' /tmp/ocp-47-diff.patch
```

Expected: zero hits.

- [ ] **Step 4: Inspect commit author metadata**

```bash
git log main..feat/47-sse-heartbeat --format='%H %an %ae' | grep -iE 'taodeng|@gmail\.com'
```

Expected: zero hits. Commit author should match OCP's public committer identity; Co-Authored-By trailers should be `noreply@*` only.

### Task 4.3: Fill PR template Privacy self-check

- [ ] **Step 1: Open `.github/PULL_REQUEST_TEMPLATE.md` and mentally check every box in the "Privacy self-check" section**

All four boxes must be checkable honestly:
- No real names / handles
- No literal personal paths
- No personal machine hostnames
- No personal email addresses

If any box cannot be honestly checked, stop and scrub before proceeding to Phase 5.

---

## Phase 5: Push, open PR, merge

### Task 5.1: Push feature branch

- [ ] **Step 1: Final pre-push check**

```bash
cd ~/ocp && git log --oneline feat/47-sse-heartbeat ^main | wc -l
```

Expected: `6` (spec + 5 impl commits).

```bash
git log feat/47-sse-heartbeat ^main --format='%ae' | sort -u
```

Expected: only the project's public committer email.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/47-sse-heartbeat
```

- [ ] **Step 3: Verify GitHub received the branch**

```bash
gh api repos/dtzp555-max/ocp/branches/feat/47-sse-heartbeat --jq .name
```

Expected: `feat/47-sse-heartbeat`.

### Task 5.2: Open PR

- [ ] **Step 1: Prepare PR body with all required sections**

The PR body must:
- Start with a Summary section (1-2 sentences).
- Fill the ALIGNMENT section: `cli.js` citation is N/A with this text:
  > `cli.js` does not perform SSE response shaping. SSE is an OCP-owned translation layer that converts claude CLI's newline-delimited JSON stdout into OpenAI-compatible SSE chunks. This PR adds an application-layer liveness signal on that existing translation layer. Per `AGENTS.md`, response shaping is in-scope for OCP; per `ALIGNMENT.md` Rule 2, no new endpoint is introduced. See design doc for reasoning.
- Type of change: **Feature** (new opt-in behavior, no cli.js surface change).
- Reviewer checklist: pre-checked items where reviewer was the opus subagent who already verified each.
- User-visible change: YES — new env var + new behavior. Paste README diff link (GitHub auto-renders the diff).
- Privacy self-check: all four boxes checked.
- Related: #47, design doc, the Phase 0 new issue number for server.mjs:480-489 bug.
- **Verification section** with the sanitized evidence block from Task 3.3.
- Historical lesson reference: `v3.3 single-timeout refactor (commit 3843ec8)` — this PR's heartbeat must not regress that lesson.

- [ ] **Step 2: Open the PR**

```bash
cd ~/ocp
gh pr create --repo dtzp555-max/ocp \
  --base main \
  --head feat/47-sse-heartbeat \
  --title "feat: SSE heartbeat on streaming path (#47)" \
  --body-file /tmp/ocp-47-pr-body.md
```

Where `/tmp/ocp-47-pr-body.md` is the PR body prepared in Step 1 (local file, not committed).

- [ ] **Step 3: Capture PR URL and check CI**

```bash
gh pr view --json url,number,statusCheckRollup
```

- [ ] **Step 4: Wait for alignment.yml CI pass**

```bash
gh pr checks --watch
```

Expected: alignment.yml passes. If it fails on a blacklisted-token hit, investigate immediately — do not add an allowlist entry without reviewing `ALIGNMENT.md`.

### Task 5.3: Await merge

- [ ] **Step 1: PR merges via squash or merge-commit per project convention**

Wait for maintainer merge. Do not self-merge (Iron Rule 10).

- [ ] **Step 2: After merge, confirm tag push triggers release.yml**

```bash
gh run list --repo dtzp555-max/ocp --workflow=release.yml --limit 3
```

Expected: a run started for the v3.12.0 tag (if the project uses auto-tag-on-merge) OR a manual tag-push is needed. Check `CLAUDE.md` `release_kit.auto_create_on_tag_push` — it's `true`.

If auto-tag is not configured, the maintainer pushes a `v3.12.0` tag manually, which triggers the release workflow.

- [ ] **Step 3: Verify GitHub Release exists**

```bash
gh release view v3.12.0 --repo dtzp555-max/ocp
```

Expected: release exists with notes pulled from CHANGELOG or release.yml-generated body.

---

## Phase 6: Post-merge deployment + observation

### Task 6.1: Deploy to production OCP instance

Per auto-memory handoff 2026-04-21, the Mac mini rig runs the production OCP instance that users hit. Deploy via cc-chat handoff:

- [ ] **Step 1: Pull + restart on production rig**

```bash
cd ~/ocp && git checkout main && git pull
./ocp stop
./ocp start   # heartbeat remains disabled by default
./ocp status
```

- [ ] **Step 2: Verify health endpoint shows v3.12.0**

```bash
curl -sS http://localhost:3456/health | grep -oE '"version":"[^"]+"'
```

Expected: `"version":"3.12.0"`.

### Task 6.2: Update auto-memory with deployment result

- [ ] **Step 1: Append a brief memory entry documenting deployment**

At `~/.cc-rules/memory/auto/MEMORY.md` append a dated entry under "Recent entries" with:
- Version deployed (v3.12.0)
- What shipped (SSE heartbeat, opt-in, default off)
- Production config (heartbeat disabled by default; users opt in via env var)
- PR URL + release URL
- Sanitized — no identifiers

### Task 6.3: Follow up on #47

- [ ] **Step 1: Comment on #47 with resolution summary**

```bash
gh issue comment 47 --repo dtzp555-max/ocp --body "Shipped in v3.12.0. Opt in with \`CLAUDE_HEARTBEAT_INTERVAL=<ms>\` (e.g. \`30000\` for 30s). Default remains disabled pending field evidence that comment frames are safe across common OCP callers. README: [link]. CHANGELOG: [link]. The related bug for the 600s-timeout dangling-client behavior (separate root cause) is tracked at #<bug-issue-number>."
```

- [ ] **Step 2: Close #47 once pingvvino confirms or after a reasonable response window**

If pingvvino responded to the earlier comment with logs, thank them and close with resolution note. If not, leave the issue open with a bot-style "feedback welcome" note for a week, then close as resolved with the shipping summary.

---

## Self-review checklist (done by plan author before execution)

**Spec coverage.** Every section of the spec has at least one task:
- D1 coverage → Task 1.1 helper + Task 1.3 reset wiring
- D2 frame format → Task 1.1 helper (`": keepalive\n\n"`)
- D3 default disabled → Task 1.1 guard + Task 1.5 CHANGELOG default=0
- D4 header relocation → Task 1.2 (isolated commit)
- D5 X-Accel-Buffering → Task 1.4
- D6 observability → Task 1.1 helper (hasFired + logEvent)
- Scope lock → Phase 2 reviewer checklist #7
- ALIGNMENT.md → Phase 5 Task 5.2 Step 1 PR body text
- Privacy preflight → Phase 4 all tasks
- Cloud testing → Phase 3 all tasks
- Release kit → Task 1.5 + Phase 5 Task 5.3
- 480-489 bug filing → Phase 0 Task 0.1

**Placeholder scan.** No TBD / TODO / "implement later" / "similar to Task N." Every code step has concrete code. Every command has concrete flags and expected output.

**Type consistency.** `hb`, `startHeartbeat`, `HEARTBEAT_INTERVAL`, `heartbeat_active`, `CLAUDE_HEARTBEAT_INTERVAL` — all spelled consistently across tasks. `sendSSE(res, data, hb)` signature consistent between Task 1.3 Step 1 (definition) and Steps 3 (all three call sites).

---

## Execution handoff

Plan complete. Recommended execution path:

**Subagent-Driven (recommended for this plan)** — Phase 0 main-thread, Phase 1 as a single sonnet subagent handling all 5 implementation tasks (commits are small and sequential, one agent can do them cleanly), Phase 2 fresh-context opus reviewer, Phase 3 main-thread coordinating remote rig via cc-chat, Phase 4-6 main-thread.

Total subagents: 2 (1 implementer + 1 reviewer). Optional retry loop if Phase 2 requests changes.
