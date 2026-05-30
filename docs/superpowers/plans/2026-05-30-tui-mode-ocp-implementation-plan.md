# TUI-mode (OCP-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `CLAUDE_TUI_MODE` to OCP that serves `/v1/chat/completions` by driving a *real interactive* `claude` session (no `-p`, no `--output-format`) so the request bills as `cc_entrypoint=cli` (subscription pool), reading the answer from claude's native JSONL transcript — while the default stream-json path stays byte-for-byte unchanged.

**Architecture:** Two new pure-ish modules under `lib/tui/` — a transcript **reader** (`transcript.mjs`, provider-agnostic, the shareable core) and a tmux **session driver** (`session.mjs`, OCP-specific). `server.mjs` gains a `callClaudeTui()` that returns `Promise<string>` and is gated into the existing dispatch by a single env flag; because OCP's entire downstream (singleflight → `setCachedResponse` → `completionResponse` / chunked-SSE-replay → `recordUsage`) already consumes a string from `callClaude`, TUI-mode is a drop-in. Streaming is buffered then replayed as chunked SSE (no token streaming — deliberately, "don't build fragile features").

**Tech Stack:** Node.js ESM (`.mjs`), `tmux` (interactive PTY host), `child_process` (`spawnSync`), `node:fs` polling (no `fs.watch`, no terminal-screen parsing). Test harness: `node test-features.mjs`.

**Source of truth for the TUI mechanism:** the OLP design spec `docs/superpowers/specs/2026-05-30-tui-mode-production-design.md` (CLI-level, applies to both projects) + its 6 validation spikes (S1–S6, T1–T6) run on PI231 against `claude v2.1.158`. This plan is the OCP-grounded execution of that spec.

---

## Why OCP-first / scope decisions (read before coding)

- **OCP-first** because OCP has the users and its compute path is `callClaude → Promise<string>`, a near-perfect impedance match for a reader that also returns a string. OLP would additionally need a string→IR-chunk-array adapter. OLP-sync is **deferred entirely until the post-2026-06-15 fork decision** — do not spend cycles keeping OLP's TUI in lockstep.
- **A-path only.** Single-user / multi-device on one subscription. No per-key ephemeral isolation, no multi-tenant. (That is the OLP B-path, deferred.)
- **A-path isolation = real `$HOME` + dedicated scratch cwd + `--strict-mcp-config`.** OCP has *no* ISOLATION contract and we do not build one. We run interactive `claude` in the operator's real home (OAuth + onboarding already valid) but in a **dedicated scratch working directory** (`OCP_TUI_CWD`, default `$HOME/.ocp-tui/work`) so transcripts land under one stable `projects/<cwd>` folder instead of polluting the operator's genuine project histories, and the trust-folder dialog is granted once.
- **One `claude` session per request.** OCP is stateless (full conversation re-serialized each request via `messagesToPrompt`). TUI-mode mirrors this: per request, start a fresh interactive session with a fresh `--session-id`, submit one serialized prompt, await turn completion, read the transcript, extract the latest assistant text, tear the session down. Warm-pool / large-paste optimizations are explicitly out of v1 scope.
- **Billing is unmeasurable until 2026-06-15.** Spike S1 proved the `cc_entrypoint=cli` *signal*, not the billed pool. The pre-6/15 deliverable is "a tested, working transport that emits `cli`"; 6/16 we flip the flag and measure with a documented kill-switch.
- **Coexistence rule (PI231 runs an OLP test instance too).** All tmux sessions use the prefix `ocp-tui-`; the reaper kills **only** `ocp-tui-*`, never `olp-tui-*`. Never run two TUI proxies on the same OAuth concurrently — stop the OLP test instance during OCP integration.
- **Provenance.** TUI-mode originated in OCP PR #101 (author courtesy: jaekwon-park <insainty21@gmail.com>). The PR #101 author should be credited + notified on the shipping PR.

---

## File Structure

| File | Responsibility | New/Modified |
|------|----------------|--------------|
| `lib/tui/transcript.mjs` | Pure transcript parsing + the polling reader. Returns the latest assistant text once the turn is terminal or the wall-clock cap elapses. Provider-agnostic — the shareable core. | **Create** |
| `lib/tui/session.mjs` | tmux session lifecycle: boot interactive `claude`, answer the trust dialog, submit the prompt (file → `"$(cat)"` paste → separate Enter), await the reader, tear down. Plus the prefix-scoped reaper. OCP-specific. | **Create** |
| `lib/tui/fixtures/` | Real transcript JSONL harvested from PI231 + a few hand-crafted edge cases, for the reader's unit tests. | **Create** |
| `server.mjs` | `callClaudeTui()` (`Promise<string>`); `streamStringAsSSE()` helper (DRY refactor of the cache-replay block); single-flag dispatch gates; reaper hook at boot; env consts. | **Modify** (`:258` env consts, `:1018`–`:1023` helpers, `:1467` dispatch, boot block) |
| `test-features.mjs` | Suite for the reader (fixtures, runs in CI) + a live-only guarded suite for the driver (`OCP_TUI_LIVE=1`, skipped in CI). | **Modify** |
| `docs/adr/0007-tui-interactive-mode.md` | OCP ADR 0007 (OCP's next number) — TUI mode rationale, billing-signal authority, scope, kill-switch. | **Create** |
| `README.md` | New env vars (`CLAUDE_TUI_MODE`, `CLAUDE_TUI_WALLCLOCK_MS`, `OCP_TUI_CWD`), a "Subscription-pool (TUI) mode" section, troubleshooting + kill-switch. | **Modify** |
| `CHANGELOG.md` | Unreleased entry. | **Modify** |

---

## PR-1 — Transcript reader (`lib/tui/transcript.mjs`)

The shareable core. Pure functions + a polling reader. Fully unit-testable from committed fixtures; needs PI231 only once, to harvest realistic fixtures.

### Task 0: Harvest real fixtures from PI231

**Files:**
- Create: `lib/tui/fixtures/complete-haiku.jsonl` (real, has `turn_duration`)
- Create: `lib/tui/fixtures/complete-sonnet-multiblock.jsonl` (real, multi content-block answer)

- [ ] **Step 1: Drive one real interactive turn on PI231 and copy its transcript**

On PI231 (the only box with an authenticated interactive `claude`), run a single interactive turn in a scratch cwd, then locate its transcript:

Run (on PI231):
```bash
SID=$(uuidgen)
mkdir -p ~/.ocp-tui/work
# drive one turn by hand in tmux OR reuse a transcript already produced by the S-spikes:
ls -t ~/.claude/projects/-home-*-.ocp-tui-work/*.jsonl 2>/dev/null | head
# pick one complete transcript (must contain a line with "subtype":"turn_duration")
```
Expected: at least one `.jsonl` file whose tail contains `{"type":"system","subtype":"turn_duration",...}`.

- [ ] **Step 2: Copy 2 real transcripts into the repo as fixtures, scrubbed**

Run (from the workstation):
```bash
scp pi231:'~/.claude/projects/<encoded-cwd>/<sid>.jsonl' lib/tui/fixtures/complete-haiku.jsonl
# Scrub: the transcript may contain the prompt/answer text only (no OAuth token — tokens
# live in ~/.claude/.credentials.json, NOT in projects/*.jsonl). Confirm no credential
# material before committing:
grep -iE "sk-ant|oat01|bearer|authorization" lib/tui/fixtures/*.jsonl && echo "STOP: scrub" || echo "clean"
```
Expected: `clean`. (Transcripts hold conversation content + metadata, never the bearer token. If a fixture's prompt text is sensitive, replace it with a benign hand-edited turn that keeps the JSON shape.)

- [ ] **Step 3: Commit the fixtures**

```bash
git add lib/tui/fixtures/complete-haiku.jsonl lib/tui/fixtures/complete-sonnet-multiblock.jsonl
git commit -m "test(tui): real claude transcript fixtures harvested from PI231 (v2.1.158)"
```

### Task 1: `encodeCwd` + `transcriptPath` (the path formula)

**Files:**
- Create: `lib/tui/transcript.mjs`
- Test: `test-features.mjs` (new Suite "TUI transcript")

- [ ] **Step 1: Write the failing test**

Add to `test-features.mjs`:
```js
// ── Suite: TUI transcript reader ────────────────────────────────────────
import { encodeCwd, transcriptPath } from "./lib/tui/transcript.mjs";

test("encodeCwd replaces every slash incl. leading", () => {
  assertEqual(encodeCwd("/home/u/.ocp-tui/work"), "-home-u-.ocp-tui-work");
});
test("transcriptPath composes EHOME/.claude/projects/<enc>/<sid>.jsonl", () => {
  assertEqual(
    transcriptPath("/home/u", "/home/u/.ocp-tui/work", "abc-123"),
    "/home/u/.claude/projects/-home-u-.ocp-tui-work/abc-123.jsonl"
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-features.mjs 2>&1 | grep -i "tui transcript\|Cannot find module"`
Expected: FAIL — `Cannot find module './lib/tui/transcript.mjs'`.

- [ ] **Step 3: Minimal implementation**

Create `lib/tui/transcript.mjs`:
```js
// Transcript reader for TUI-mode. Reads claude's native JSONL session transcript
// and returns the latest assistant turn's text once the turn is terminal.
//
// Authority: claude CLI v2.1.158 — interactive session transcript at
//   <HOME>/.claude/projects/<CWD with every "/" -> "-">/<--session-id>.jsonl
// Completion marker: a line {"type":"system","subtype":"turn_duration",...}.
// See docs/superpowers/specs/2026-05-30-tui-mode-production-design.md §4.
import { readFileSync, existsSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Project-dir encoding: every "/" -> "-" (including the leading slash).
export function encodeCwd(cwd) {
  return cwd.replace(/\//g, "-");
}

export function transcriptPath(home, cwd, sessionId) {
  return `${home}/.claude/projects/${encodeCwd(cwd)}/${sessionId}.jsonl`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-features.mjs 2>&1 | grep -i "tui transcript"`
Expected: PASS for both cases.

- [ ] **Step 5: Commit**

```bash
git add lib/tui/transcript.mjs test-features.mjs
git commit -m "feat(tui): transcript path formula (encodeCwd + transcriptPath)"
```

### Task 2: `parseTranscriptLines` + `isTerminalLine` + `extractLatestAssistantText`

**Files:**
- Modify: `lib/tui/transcript.mjs`
- Test: `test-features.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { parseTranscriptLines, isTerminalLine, extractLatestAssistantText } from "./lib/tui/transcript.mjs";
import { readFileSync } from "node:fs";

test("parseTranscriptLines skips blank + malformed/partial lines", () => {
  const evs = parseTranscriptLines('{"a":1}\n\n{bad json\n{"b":2}\n');
  assertEqual(evs.length, 2);
  assertEqual(evs[1].b, 2);
});
test("isTerminalLine true on turn_duration", () => {
  assertEqual(isTerminalLine({ type: "system", subtype: "turn_duration" }), true);
});
test("isTerminalLine true on stop_reason tool_use (message-wrapped + flat)", () => {
  assertEqual(isTerminalLine({ type: "assistant", message: { stop_reason: "tool_use" } }), true);
  assertEqual(isTerminalLine({ stop_reason: "tool_use" }), true);
});
test("isTerminalLine false on ordinary assistant/text lines", () => {
  assertEqual(isTerminalLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), false);
});
test("extractLatestAssistantText concatenates text blocks of the LAST assistant turn", () => {
  const evs = [
    { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    { type: "user", message: { content: "..." } },
    { type: "assistant", message: { content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "x" }, { type: "text", text: "B" }] } },
  ];
  assertEqual(extractLatestAssistantText(evs), "AB");
});
test("real complete fixture yields non-empty text and is terminal", () => {
  const evs = parseTranscriptLines(readFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  assert(evs.some(isTerminalLine), "fixture must contain a terminal line");
  assert(extractLatestAssistantText(evs).length > 0, "fixture must yield assistant text");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-features.mjs 2>&1 | grep -i "parseTranscript\|isTerminal\|extractLatest\|real complete fixture"`
Expected: FAIL — exports not defined.

- [ ] **Step 3: Minimal implementation** (append to `lib/tui/transcript.mjs`)

```js
// Parse NDJSON text into objects; skip blank lines and partial/forming lines
// (the live transcript is read mid-write, so the last line may be incomplete).
export function parseTranscriptLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* partial line being written */ }
  }
  return out;
}

// A line marks the assistant turn complete when it is the turn_duration system
// event, or an assistant message that stopped to hand off to a tool.
export function isTerminalLine(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.type === "system" && obj.subtype === "turn_duration") return true;
  const sr = (obj.message && obj.message.stop_reason) || obj.stop_reason;
  return sr === "tool_use";
}

// Text of the LAST assistant turn: concatenate its text content blocks
// (ignore thinking/tool_use blocks). Later assistant entries overwrite earlier.
export function extractLatestAssistantText(events) {
  let text = "";
  for (const ev of events) {
    if (!ev || ev.type !== "assistant") continue;
    const content = ev.message && ev.message.content;
    if (!Array.isArray(content)) continue;
    const parts = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
    if (parts.length) text = parts.join("");
  }
  return text;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-features.mjs 2>&1 | grep -iE "parseTranscript|isTerminal|extractLatest|real complete fixture"`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/tui/transcript.mjs test-features.mjs
git commit -m "feat(tui): transcript parsing + terminal detection + assistant-text extraction"
```

### Task 3: `readTuiTranscript` (the polling reader with wall-clock cap)

**Files:**
- Modify: `lib/tui/transcript.mjs`
- Test: `test-features.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { readTuiTranscript } from "./lib/tui/transcript.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

test("readTuiTranscript returns assistant text when terminal marker present", async () => {
  const dir = mkdtempSync(`${tmpdir()}/tui-`);
  const p = `${dir}/s.jsonl`;
  writeFileSync(p, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello world" }] } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1200 }),
  ].join("\n") + "\n");
  const out = await readTuiTranscript({ transcriptPath: p, wallclockMs: 2000, pollMs: 50 });
  assertEqual(out, "hello world");
});
test("readTuiTranscript honours wall-clock cap and returns partial text", async () => {
  const dir = mkdtempSync(`${tmpdir()}/tui-`);
  const p = `${dir}/s.jsonl`;
  writeFileSync(p, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }) + "\n");
  const out = await readTuiTranscript({ transcriptPath: p, wallclockMs: 300, pollMs: 50 }); // never terminal
  assertEqual(out, "partial");
});
test("readTuiTranscript throws when no text and cap elapses", async () => {
  const dir = mkdtempSync(`${tmpdir()}/tui-`);
  const p = `${dir}/missing.jsonl`; // file never appears
  let threw = false;
  try { await readTuiTranscript({ transcriptPath: p, wallclockMs: 200, pollMs: 50 }); }
  catch { threw = true; }
  assert(threw, "must throw on empty timeout");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-features.mjs 2>&1 | grep -i "readTuiTranscript"`
Expected: FAIL — export not defined.

- [ ] **Step 3: Minimal implementation** (append)

```js
// Block until the session transcript is terminal (turn_duration / tool_use) or
// the wall-clock cap elapses, polling the file (no fs.watch — robust over NFS /
// editors). Returns the latest assistant text. On cap with text, returns the
// partial text; on cap with no text at all, throws.
//
// No quiescence heuristic by design: a long Opus thinking turn stalls transcript
// growth and a "file stable for N s" rule would false-abort it (spec §4.3).
export async function readTuiTranscript({ transcriptPath: p, wallclockMs = 120000, pollMs = 250 }) {
  const deadline = Date.now() + wallclockMs;
  let lastText = "";
  while (Date.now() < deadline) {
    if (existsSync(p)) {
      const events = parseTranscriptLines(readFileSync(p, "utf8"));
      lastText = extractLatestAssistantText(events) || lastText;
      if (events.some(isTerminalLine)) return lastText;
    }
    await sleep(pollMs);
  }
  if (lastText) return lastText;
  throw new Error("tui_transcript_timeout: no assistant text within wallclock cap");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-features.mjs 2>&1 | grep -i "readTuiTranscript"`
Expected: all 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/tui/transcript.mjs test-features.mjs
git commit -m "feat(tui): polling transcript reader with wall-clock cap (no quiescence)"
```

---

## PR-2 — Session driver (`lib/tui/session.mjs`)

tmux lifecycle + the validated submission recipe. Cannot be unit-tested without a live authenticated `claude`; tested by a live-only guarded suite that runs on PI231.

### Task 4: `reapStaleTuiSessions` (prefix-scoped reaper)

**Files:**
- Create: `lib/tui/session.mjs`
- Test: `test-features.mjs`

- [ ] **Step 1: Write the failing test** (pure — no live claude; inject a fake tmux runner)

```js
import { reapStaleTuiSessions, SESSION_PREFIX } from "./lib/tui/session.mjs";

test("reaper kills ONLY ocp-tui- sessions, never olp-tui-", () => {
  const killed = [];
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-aaaa\nolp-tui-bbbb\nmisc\nocp-tui-cccc\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux });
  assertEqual(SESSION_PREFIX, "ocp-tui-");
  assertEqual(n, 2);
  assertEqual(killed.join(","), "ocp-tui-aaaa,ocp-tui-cccc");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-features.mjs 2>&1 | grep -i "reaper kills"`
Expected: FAIL — module/export missing.

- [ ] **Step 3: Minimal implementation**

Create `lib/tui/session.mjs`:
```js
// TUI-mode session driver: hosts an interactive `claude` in tmux, submits one
// serialized prompt, awaits the transcript reader, tears down. OCP-specific.
//
// Authority: claude CLI v2.1.158 interactive mode (no -p / no --output-format
// => cc_entrypoint=cli). Submission recipe + dialog handling validated by spikes
// T3/T6 on PI231. See docs/superpowers/specs/2026-05-30-tui-mode-production-design.md.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { transcriptPath, readTuiTranscript } from "./transcript.mjs";

export const SESSION_PREFIX = "ocp-tui-"; // per-proxy namespace (coexistence rule)
const TMUX = process.env.OCP_TUI_TMUX_BIN || "tmux";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const defaultTmux = (args, opts = {}) => spawnSync(TMUX, args, { encoding: "utf8", ...opts });

// Kill ONLY our own stale sessions. Scoped to SESSION_PREFIX so a co-hosted
// OLP test instance's `olp-tui-*` sessions are never touched.
export function reapStaleTuiSessions({ tmux = defaultTmux } = {}) {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!r || r.status !== 0) return 0; // no tmux server / no sessions
  let killed = 0;
  for (const name of String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (name.startsWith(SESSION_PREFIX)) { tmux(["kill-session", "-t", name]); killed++; }
  }
  return killed;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-features.mjs 2>&1 | grep -i "reaper kills"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/tui/session.mjs test-features.mjs
git commit -m "feat(tui): prefix-scoped session reaper (ocp-tui-* only)"
```

### Task 5: `runTuiTurn` (boot → trust dialog → paste → Enter → read → teardown)

**Files:**
- Modify: `lib/tui/session.mjs`
- Test: `test-features.mjs` (live-only, guarded by `OCP_TUI_LIVE=1`)

- [ ] **Step 1: Write the live-only guarded test** (skipped in CI; run on PI231)

```js
// Live-only: requires an authenticated interactive `claude`. Skipped unless OCP_TUI_LIVE=1.
if (process.env.OCP_TUI_LIVE === "1") {
  test("runTuiTurn drives a real interactive turn and returns text", async () => {
    const { runTuiTurn } = await import("./lib/tui/session.mjs");
    const out = await runTuiTurn({
      prompt: "Reply with exactly the word PONG and nothing else.",
      model: "claude-haiku-4-5-20251001",
      claudeBin: process.env.OCP_TUI_CLAUDE_BIN || "claude",
      home: process.env.HOME,
      cwd: `${process.env.HOME}/.ocp-tui/work`,
      wallclockMs: 120000,
    });
    assert(/PONG/i.test(out), `expected PONG, got: ${out.slice(0, 200)}`);
  });
} else {
  test("runTuiTurn (live) — SKIPPED (set OCP_TUI_LIVE=1 on PI231 to run)", () => { assert(true); });
}
```

- [ ] **Step 2: Run to verify it fails** (on a box, with the flag)

Run (PI231): `OCP_TUI_LIVE=1 node test-features.mjs 2>&1 | grep -i "runTuiTurn"`
Expected: FAIL — `runTuiTurn` not exported yet.

- [ ] **Step 3: Implementation** (append to `lib/tui/session.mjs`)

```js
// Boot wait + dialog timing. Conservative defaults validated on PI231; env-tunable.
const BOOT_MS   = parseInt(process.env.OCP_TUI_BOOT_MS   || "3500", 10);
const DIALOG_MS = parseInt(process.env.OCP_TUI_DIALOG_MS || "1200", 10);
const PASTE_SETTLE_MS = parseInt(process.env.OCP_TUI_PASTE_MS || "1800", 10);

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`; // single-quote for sh -c

// Build interactive claude argv: NO -p, NO --output-format (=> cc_entrypoint=cli).
// MCP hard-disabled: --strict-mcp-config (no --mcp-config) is the only mechanism
// that stops account-attached managed MCP from connecting (spec §5.2 / T6),
// belt-and-braces with --disallowedTools "mcp__*".
function buildTuiCmd(claudeBin, model, sessionId) {
  return [
    shq(claudeBin),
    "--model", shq(model),
    "--session-id", sessionId,
    "--strict-mcp-config",
    "--disallowedTools", shq("mcp__*"),
  ].join(" ");
}

export async function runTuiTurn({
  prompt, model, claudeBin, home, cwd,
  wallclockMs = 120000, tmux = defaultTmux,
}) {
  const sessionId = randomUUID();
  const tmuxName = SESSION_PREFIX + sessionId.slice(0, 8);
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

  const tmpDir = mkdtempSync(`${tmpdir()}/ocp-tui-`);
  const promptFile = `${tmpDir}/prompt.txt`;
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  const env = { ...process.env, CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" };
  delete env.CLAUDECODE; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; delete env.ANTHROPIC_AUTH_TOKEN;
  if (home) env.HOME = home;

  try {
    // 1. Boot the interactive session inside tmux, in the dedicated scratch cwd.
    tmux(["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "50", "-c", cwd,
          buildTuiCmd(claudeBin, model, sessionId)], { env });
    await sleep(BOOT_MS);

    // 2. Answer the trust-folder dialog defensively. The seeded bypass flag (if any)
    //    suppresses the *bypass-permissions* dialog but NOT the trust-folder dialog;
    //    "1" = "Yes, proceed". Harmless if the dialog is absent (cwd already trusted).
    tmux(["send-keys", "-t", tmuxName, "1"]);
    tmux(["send-keys", "-t", tmuxName, "Enter"]);
    await sleep(DIALOG_MS);

    // 3. Submit the prompt. Body is pasted via `"$(cat file)"` so the content never
    //    touches the command line (no shell injection from prompt text), then a
    //    SEPARATE Enter key event submits it (Ink #15553: literal "\n" in a paste
    //    does not submit; the Enter key event does).
    spawnSync("sh", ["-c",
      `${shq(TMUX)} send-keys -t ${shq(tmuxName)} -- "$(cat ${shq(promptFile)})"`],
      { env, encoding: "utf8" });
    await sleep(PASTE_SETTLE_MS);
    tmux(["send-keys", "-t", tmuxName, "Enter"]);

    // 4. Read the answer from the native transcript.
    const tpath = transcriptPath(home || process.env.HOME, cwd, sessionId);
    return await readTuiTranscript({ transcriptPath: tpath, wallclockMs });
  } finally {
    // 5. Teardown — always. Kill the session, remove the temp prompt dir.
    try { tmux(["kill-session", "-t", tmuxName]); } catch { /* already gone */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
```

- [ ] **Step 4: Run to verify it passes** (PI231, live)

Run (PI231): `OCP_TUI_LIVE=1 node test-features.mjs 2>&1 | grep -i "runTuiTurn"`
Expected: PASS — output contains `PONG`. Also confirm no orphan sessions: `tmux ls 2>/dev/null | grep ocp-tui- || echo "clean"` → `clean`.

- [ ] **Step 5: Commit**

```bash
git add lib/tui/session.mjs test-features.mjs
git commit -m "feat(tui): runTuiTurn — interactive session driver (boot/trust/paste/Enter/read/teardown)"
```

---

## PR-3 — Wiring into `server.mjs`

Gate TUI-mode behind one env flag. Default path (`CLAUDE_TUI_MODE` unset) stays byte-for-byte identical.

### Task 6: env consts + `streamStringAsSSE` DRY refactor

**Files:**
- Modify: `server.mjs` (env consts near `:275`; refactor cache-replay block `:1524`–`:1539` into a helper near `:1023`)

- [ ] **Step 1: Add TUI env consts + import** (near the other `const ... = process.env...` at `server.mjs:258`–`:275`)

```js
import { runTuiTurn, reapStaleTuiSessions } from "./lib/tui/session.mjs";

// TUI-mode (subscription-pool bridge). Opt-in; default OFF keeps stream-json path.
// Authority: docs/adr/0007-tui-interactive-mode.md.
const TUI_MODE = process.env.CLAUDE_TUI_MODE === "true";
const TUI_WALLCLOCK_MS = parseInt(process.env.CLAUDE_TUI_WALLCLOCK_MS || "120000", 10);
const TUI_CWD = process.env.OCP_TUI_CWD || `${process.env.HOME}/.ocp-tui/work`;
```

- [ ] **Step 2: Extract the chunked-SSE-replay into a reusable helper** (near `completionResponse` at `:1023`)

```js
// Replay a complete string as a chunked SSE stream (80 codepoints/chunk).
// Extracted from the cache-hit replay block so TUI-mode streaming reuses it.
function streamStringAsSSE(res, id, model, content) {
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  sendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const CHUNK = 80;
  const codepoints = Array.from(content);
  for (let i = 0; i < codepoints.length; i += CHUNK) {
    sendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: codepoints.slice(i, i + CHUNK).join("") }, finish_reason: null }] });
  }
  sendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}
```

- [ ] **Step 3: Point the cache-hit streaming replay (`:1524`–`:1539`) at the helper** (DRY — behavior identical)

Replace the inline block inside `if (stream) { ... }` of the cache hit with:
```js
          if (stream) {
            const id = `chatcmpl-${randomUUID()}`;
            streamStringAsSSE(res, id, model, cached.response);
            return;
          } else {
```

- [ ] **Step 4: Run the full suite to verify no regression**

Run: `node test-features.mjs 2>&1 | tail -3`
Expected: all existing tests PASS (the refactor is behavior-preserving; cache-replay covered by existing D3 tests).

- [ ] **Step 5: Commit**

```bash
git add server.mjs
git commit -m "refactor(server): extract streamStringAsSSE helper + add TUI env consts"
```

### Task 7: `callClaudeTui` + dispatch gates

**Files:**
- Modify: `server.mjs` (new `callClaudeTui` near `callClaude:735`; gates at the buffered dispatch `:1563`/`:1594` and streaming dispatch `:1551`)

- [ ] **Step 1: Add `callClaudeTui`** (near `callClaude`, after `:800`)

```js
// TUI-mode upstream: drive an interactive claude session, return the assistant
// text as a string — same contract as callClaude(), so all downstream
// (singleflight, cache write-back, completionResponse) is unchanged.
// System messages are rendered inline as [System] blocks by messagesToPrompt;
// we deliberately do NOT pass --system-prompt in interactive mode to avoid any
// flag that could perturb cc_entrypoint classification.
function callClaudeTui(model, messages, conversationId, keyName) {
  const cliModel = MODEL_MAP[model] || model;
  const prompt = messagesToPrompt(messages); // includes system as [System] inline
  recordModelRequest(cliModel, prompt.length);
  return runTuiTurn({
    prompt, model: cliModel, claudeBin: CLAUDE,
    home: process.env.HOME, cwd: TUI_CWD, wallclockMs: TUI_WALLCLOCK_MS,
  }).then((text) => {
    recordModelSuccess(cliModel, 0);
    return text;
  }).catch((err) => {
    recordModelError(cliModel, false);
    throw err;
  });
}
```

- [ ] **Step 2: Gate the buffered dispatch** — at `server.mjs:1563`–`:1597`, replace the two `callClaude(...)` call sites (inside the singleflight closure and the cache-disabled fallback) with a selected upstream:

Add once, just before the `if (CACHE_TTL > 0 && req._cacheHash)` block (~`:1563`):
```js
  const upstreamCall = TUI_MODE ? callClaudeTui : callClaude;
```
Then change `await callClaude(model, messages, conversationId, req._authKeyName)` → `await upstreamCall(model, messages, conversationId, req._authKeyName)` at **both** sites (`:1572` and `:1594`).

- [ ] **Step 3: Gate the streaming dispatch** — at `server.mjs:1551`–`:1553`, branch TUI streaming to buffer-then-replay:

```js
  if (stream) {
    if (TUI_MODE) {
      // TUI has no token stream; buffer the turn, write-back to cache, replay as chunked SSE.
      const t0Usage = Date.now();
      try {
        const content = await callClaudeTui(model, messages, conversationId, req._authKeyName);
        if (CACHE_TTL > 0 && req._cacheHash) {
          try { setCachedResponse(req._cacheHash, model, content); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); }
        }
        const id = `chatcmpl-${randomUUID()}`;
        streamStringAsSSE(res, id, model, content);
        try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars: messages.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0), responseChars: content.length, elapsedMs: Date.now() - t0Usage, success: true }); } catch {}
        return;
      } catch (err) {
        if (res.headersSent || res.writableEnded || res.destroyed) { try { res.end(); } catch {}; return; }
        const safeMessage = (err.message || "Internal error").replace(/\/[\w/.\-]+/g, "[path]");
        return jsonResponse(res, 500, { error: { message: safeMessage, type: "proxy_error" } });
      }
    }
    // Default: real stream-json streaming, unchanged.
    return callClaudeStreaming(model, messages, conversationId, res, { keyId: req._authKeyId, keyName: req._authKeyName, cacheHash: req._cacheHash });
  }
```

- [ ] **Step 4: Verify default path is untouched + TUI path selected only by flag**

Run: `CLAUDE_TUI_MODE=  node -e "process.env.CLAUDE_TUI_MODE; import('./server.mjs')" 2>&1 | head -1 || true`
Then the regression suite: `node test-features.mjs 2>&1 | tail -3`
Expected: all PASS (no test sets `CLAUDE_TUI_MODE`, so `upstreamCall === callClaude` and streaming uses `callClaudeStreaming` — identical to today).

Live end-to-end (PI231, after Task 8 setup): with `CLAUDE_TUI_MODE=true` start OCP and `curl` both `stream:false` and `stream:true`:
```bash
curl -s localhost:3456/v1/chat/completions -H "Authorization: Bearer <key>" \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"say PONG"}]}' | head
```
Expected: a normal OpenAI completion whose content contains `PONG`. Cross-check on PI231 that the spawned `claude` had no `-p`/`--output-format` (`ps -ef | grep claude`).

- [ ] **Step 5: Commit**

```bash
git add server.mjs
git commit -m "feat(tui): gate interactive TUI upstream behind CLAUDE_TUI_MODE (buffered + streaming)"
```

### Task 8: reaper hook at boot + ADR + README + CHANGELOG

**Files:**
- Modify: `server.mjs` (boot block — call `reapStaleTuiSessions()` once on startup when `TUI_MODE`)
- Create: `docs/adr/0007-tui-interactive-mode.md`
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Reaper on boot** (in the server start/`listen` block)

```js
  if (TUI_MODE) {
    try { const n = reapStaleTuiSessions(); if (n) logEvent("info", "tui_reaped_stale_sessions", { count: n }); } catch {}
    console.log(`  TUI-mode: ON (interactive claude → cc_entrypoint=cli). cwd=${TUI_CWD} wallclock=${TUI_WALLCLOCK_MS}ms`);
  }
```

- [ ] **Step 2: Write ADR 0007** — `docs/adr/0007-tui-interactive-mode.md`

Context: 2026-06-15 billing split routes by `cc_entrypoint`; `-p`/`--output-format` ⇒ `sdk-cli` (Agent SDK credit pool, ~$20 on Pro = unusable). Decision: opt-in interactive driver ⇒ `cli` (subscription pool). Authority: spec §1/§4, claude v2.1.158. Scope: A-path single-user; MCP hard-disabled via `--strict-mcp-config`. Kill-switch: unset `CLAUDE_TUI_MODE` → stream-json path restored. Consequences: no token streaming (buffered+replayed); grey-area, billing unmeasurable until 6/15; reaper + tmux-prefix coexistence rules.

- [ ] **Step 3: README** — add `CLAUDE_TUI_MODE`, `CLAUDE_TUI_WALLCLOCK_MS`, `OCP_TUI_CWD` to the env-var table; add a "Subscription-pool (TUI) mode" section (what it is, opt-in, the 6/15 rationale, no-streaming caveat, the one-time `mkdir -p ~/.ocp-tui/work` + tmux dependency, and the `CLAUDE_TUI_MODE` unset kill-switch).

- [ ] **Step 4: CHANGELOG** — Unreleased: `feat(tui): opt-in CLAUDE_TUI_MODE — serve via interactive claude (cc_entrypoint=cli / subscription pool); default stream-json path unchanged.`

- [ ] **Step 5: Commit**

```bash
git add server.mjs docs/adr/0007-tui-interactive-mode.md README.md CHANGELOG.md
git commit -m "feat(tui): boot reaper + ADR 0007 + README + CHANGELOG (TUI-mode docs)"
```

---

## Integration & canary (post-implementation, on PI231)

1. Stop the OLP test instance (`:4567`) — clean shared OAuth + no tmux collision.
2. `git clone`/checkout this branch on PI231, `mkdir -p ~/.ocp-tui/work`, start OCP on `:3456` with `CLAUDE_TUI_MODE=true`.
3. Run the live driver suite: `OCP_TUI_LIVE=1 node test-features.mjs`.
4. End-to-end `curl` (buffered + streaming) through OCP; confirm spawned `claude` carries no `-p`/`--output-format`.
5. **Pre-6/15 deliverable = here.** Billing measurement waits for 6/15; document the kill-switch (unset `CLAUDE_TUI_MODE`).

---

## Self-Review (against spec + the OCP-first execution review)

- **Spec coverage:** transcript path formula (§4 → Task 1), parsing/terminal/extract (§4 → Task 2), polling reader + wall-clock cap + no-quiescence (§4.3 → Task 3), submission recipe file→paste→Enter (§5/T3 → Task 5), trust-dialog handling (§5.2 → Task 5), MCP disable `--strict-mcp-config` (§5.2/T6 → Tasks 5 & buildTuiCmd), string-contract drop-in (→ Tasks 6–7), kill-switch + default-path-sacred (→ Task 7 Step 4), coexistence prefix + reaper (→ Tasks 4 & 8). ✅
- **Review findings folded:** OCP-first string match (Task 7); no ephemeral-home, real-home + scratch cwd (scope §); reader-only sharing, driver forked (file table); tmux prefix + scoped reaper + never-both-on-OAuth (Task 4, Integration §1); `TIMEOUT=600000 > 120s` cap verified (no SIGKILL-mid-turn); `--strict-mcp-config` added (Task 5); provenance jaekwon-park (Why §). OLP-sync deferred. ✅
- **Placeholder scan:** none — every code step carries real code; every run step an exact command + expected output. ✅
- **Type consistency:** `runTuiTurn`/`reapStaleTuiSessions`/`SESSION_PREFIX` exported in Task 4–5 match imports in Task 6–8; `streamStringAsSSE(res, id, model, content)` defined Task 6, used Tasks 6–7; `callClaudeTui(model, messages, conversationId, keyName)` mirrors `callClaude`'s signature. ✅
- **Open item for integration:** confirm on PI231 that the seeded `~/.claude.json` is unnecessary for real-home A (onboarding already complete); if a bypass-permissions dialog *does* appear in real home, add a one-line seed step (`bypassPermissionsModeAccepted:true`) — but the driver already answers the trust dialog defensively, so the turn still completes.
