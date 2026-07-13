// Transcript reader for TUI-mode. Reads claude's native JSONL session transcript
// and returns the latest assistant turn's text once the turn is terminal.
//
// Authority: claude CLI v2.1.157 — interactive session transcript at
//   <HOME>/.claude/projects/<CWD with every "/" -> "-">/<--session-id>.jsonl
// Completion marker: a line {"type":"system","subtype":"turn_duration",...}.
// See docs/superpowers/specs/2026-05-30-tui-mode-production-design.md §4.
import { readFileSync, existsSync, readdirSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Locate a session's transcript by its UUID across every projects subdir, without
// reconstructing the encoded cwd. Robust to whatever encoding claude applies.
// Returns the path, or null if not present yet (it appears once the turn starts).
// TODO: add a CI fixture-contract test (a captured real transcript) so schema drift
//       in the claude JSONL format fails loudly rather than silently degrading.
export function findTranscriptPath(home, sessionId) {
  if (!home || !sessionId) return null;
  const root = `${home}/.claude/projects`;
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const candidate = `${root}/${d}/${sessionId}.jsonl`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

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

// A line marks the assistant turn complete when EITHER:
//   (a) {type:"system", subtype:"turn_duration"} — emitted by newer claude builds
//       (e.g. 2.1.159), OR
//   (b) {type:"assistant"} whose message.stop_reason is a FINAL reason
//       ("end_turn" / "stop_sequence" / "max_tokens"). This is the API-level
//       end-of-turn signal, present across claude builds whose transcripts do NOT
//       emit turn_duration (e.g. 2.1.114 — verified live on the cloud host). Without
//       it OCP can't detect completion on those builds and hangs to the wallclock,
//       then returns only partial text (issue #130, cloud/server-side symptom).
//
// stop_reason "tool_use" is deliberately NOT terminal: the model is mid-turn (it will
// run a tool and continue with a later assistant entry). Matching on a FINAL
// stop_reason — not on the mere presence of a tool_use — keeps tool-using turns intact.
// (The v3.17.1 narrowing dropped a buggy "tool_use is terminal" rule; this restores
// cross-version completion detection without bringing that bug back.)
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);
export function isTerminalLine(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.type === "system" && obj.subtype === "turn_duration") return true;
  if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
    return TERMINAL_STOP_REASONS.has(obj.message.stop_reason);
  }
  return false;
}

// Text of the LAST assistant turn: concatenate its text content blocks
// (ignore thinking/tool_use blocks). Later assistant entries overwrite earlier.
// Fixture-confirmed shape: top-level type:"assistant", message.content[] array.
//
// Scoping: this returns the FINAL text-bearing assistant entry in the whole file,
// not "text since the matching user line" (spec §4.2). Those are equivalent ONLY
// under OCP's one-session-per-request model (a fresh --session-id => a fresh
// transcript holding one logical exchange). If a future warm-pool ever reuses a
// session WITHOUT a fresh session-id / clear, earlier-turn text could leak — that
// author must add user-line scoping here. See spec §7.2.
//
// STATUS (warm pool, lib/tui/pool.mjs — the "future warm-pool" this note anticipated):
// the pool does NOT reuse sessions, so the precondition above still holds and no
// user-line scoping was added. Each pooled pane is booted with its OWN fresh
// randomUUID() --session-id (bootTuiPane) and is SINGLE-USE: it serves exactly one turn
// and is then killed and replaced. One session still means one logical exchange, so the
// last assistant entry is still that request's answer.
// The warning therefore stands UNCHANGED for anyone who later wants a pane to serve a
// SECOND turn (or to reset one with /clear and reuse it): that is a leak, and it needs
// user-line scoping HERE before it can be safe. Do not relax pool.mjs's single-use rule
// without doing that work first.
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

// Returns the entrypoint string (e.g. "cli") used for the billing-pool assertion,
// or null if absent. Lets callers assert the subscription-classified path.
//
// Resolution order (C-3, issue #133):
//   1. PREFER the turn_duration system line's `entrypoint` — the authoritative
//      end-of-turn classifier emitted by builds that produce turn_duration
//      (e.g. claude-2.1.104/2.1.157 on PI231).
//   2. FALL BACK to the `entrypoint` field on ANY ordinary transcript line
//      (assistant / user / attachment / system) — present on BOTH emitting and
//      non-emitting builds. Some claude builds (e.g. certain Mac mini transcripts)
//      do NOT emit a turn_duration line at all; reading ONLY turn_duration made the
//      caller's tui_entrypoint_mismatch assertion (server.mjs) get got:null every
//      turn and go blind. The entrypoint value is identical across line types within
//      a single interactive session (fixture-confirmed: every line in
//      complete-haiku.jsonl carrying `entrypoint` reads "cli"), so the fallback
//      yields the same classifier. Last-writer-wins on the fallback.
export function verifyEntrypoint(events) {
  let fallback = null;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "system" && ev.subtype === "turn_duration" && ev.entrypoint != null) {
      return ev.entrypoint; // authoritative — short-circuit
    }
    if (ev.entrypoint != null) fallback = ev.entrypoint;
  }
  return fallback;
}

// ── C-1: honest AUTH-FAILURE banner detection (issue #133) ───────────────
// When the interactive `claude` CLI hits an in-session error it does NOT crash —
// it renders the error as ordinary assistant text in the transcript. The specific
// failure C-1 exists to catch is R-1: EXPIRED / INVALID credentials, where every
// turn comes back as the same one-line auth-failure banner and OCP, none the wiser,
// caches that banner (server.mjs setCachedResponse), shares it via singleflight, and
// records a model SUCCESS — so a hard auth error is silently served (and cached for
// the 5-min TTL) as a real answer. The two live-reproduced banners on PI231
// (2026-06-10) are:
//   "Please run /login · API Error: 401 Invalid authentication credentials"  (69 chars)
//   "Failed to authenticate. API Error: 401 Invalid authentication credentials" (73 chars)
//
// WHY THE SCOPE IS NARROW (conservatism — the load-bearing design choice).
// An earlier generalised rule (^<short-prefix>?API Error:\s*\d{3}\b.*$) was TOO
// BROAD: its unbounded `.*` tail let any short prefix + "API Error: NNN" + an
// arbitrarily long sentence match, so it KILLED legitimate long answers that merely
// DISCUSS an API error (e.g. "API Error: 500 happened because the server was
// overloaded. To fix this, retry with exponential backoff …"). That is the worst
// outcome: a false-positive costs the user a missing answer AND a double-burn retry,
// whereas the rare false-negative (caching one transient error for the 5-min TTL) is
// cheap and self-healing. So C-1 is reframed from "detect ANY API error" to "detect
// a claude-CLI AUTHENTICATION-FAILURE banner", and when unsure it PASSES (does not
// kill). Transient 5xx server errors are deliberately NOT detected — they are not the
// R-1 case and the conservative choice is to let them through.
//
// THE SIGNAL — a turn is an auth-failure banner only if ALL of these hold over the
// WHOLE trimmed assistant text (a conjunction; any one failing => PASS):
//   1. SHORT whole-message. Real banners are one short line (the two live samples are
//      69 and 73 chars). Cap = TUI_ERR_MAX_LEN (100) — headroom over 73 for a
//      slightly longer future banner, while still rejecting multi-sentence prose. A
//      long answer that happens to discuss auth (no code chars, e.g. 226 chars) is
//      rejected on length alone.
//   2. Contains "API Error: 4\d{2}" — auth failures are 4xx (401/403). This rejects
//      transient 5xx ("API Error: 500/503 …") and bare "HTTP 401 means unauthorized."
//      (no "API Error:" core).
//   3. Contains an auth KEYWORD — authenticat | /login | credential (case-insensitive).
//      This rejects answers that quote a 4xx but are not auth banners, e.g.
//      "To debug a 401: the server returns API Error: 401 Unauthorized …"
//      ("Unauthorized" is authoriz-, not authenticat-; no /login, no credential).
//   4. Contains NO backtick or quote char (` ' "). A real CLI banner is plain text;
//      backticked/quoted text signals an answer that is QUOTING the error rather than
//      being the banner, e.g. "You'll see `API Error: 401` … run /login to fix it."
//      (75 chars — passes 1-3 but is excluded here). This is the conservative tie-
//      breaker for short instructional answers.
//
// Worked matrix (all required cases pass — see test-features.mjs C-1 block):
//   KILL: "Please run /login · API Error: 401 Invalid authentication credentials"
//   KILL: "Failed to authenticate. API Error: 401 Invalid authentication credentials"
//   PASS: "API Error: 500 happened because the server was overloaded. …"      (not 4xx)
//   PASS: "Failed to parse the config. Here are the API Error: 401 details …"  (too long + no auth-kw)
//   PASS: "To debug a 401: … API Error: 401 Unauthorized, then you refresh …"  (no auth-kw)
//   PASS: "Here is the handler … It logs the string API Error: 503 …"          (not 4xx)
//   PASS: "You'll see `API Error: 401` … run /login to fix it."                (has backtick)
//   PASS: "HTTP 401 means unauthorized."                                       (no API Error core)
//   PASS: "The capital of France is Paris."                                    (nothing matches)
//
// OPERATOR OVERRIDE (unchanged): CLAUDE_TUI_ERROR_PATTERNS lets an operator REPLACE
// the default auth-banner detector with their own newline- or `||`-separated JS regex
// source strings (each auto-anchored ^…$ over the trimmed text, case-insensitive). A
// non-empty override uses ONLY those regexes (the narrowed default is bypassed); an
// empty / whitespace-only override DISABLES detection entirely (escape hatch).

// Whole-message length cap for the default auth-banner detector. Real banners are
// 69/73 chars; 100 gives headroom while still rejecting multi-sentence prose.
const TUI_ERR_MAX_LEN = 100;
// 4xx "API Error:" core — auth failures are 4xx (401/403), never 5xx.
const TUI_ERR_4XX = /API Error:\s*4\d{2}\b/i;
// Auth keyword — the message must be about authentication, not just quote a 4xx.
const TUI_ERR_AUTH_KW = /authenticat|\/login|credential/i;
// Code/quote chars — their presence signals prose QUOTING an error, not the banner.
const TUI_ERR_CODE_CHAR = /[`'"]/;

// Default detector: returns true iff `trimmed` IS a claude-CLI auth-failure banner
// (all four signals above). Conservative — any signal failing => false (PASS).
function isDefaultAuthFailureBanner(trimmed) {
  if (trimmed.length > TUI_ERR_MAX_LEN) return false; // 1. short whole-message
  if (!TUI_ERR_4XX.test(trimmed)) return false;       // 2. 4xx API Error core
  if (!TUI_ERR_AUTH_KW.test(trimmed)) return false;   // 3. auth keyword
  if (TUI_ERR_CODE_CHAR.test(trimmed)) return false;  // 4. no code/quote chars
  return true;
}

// Compile an OPERATOR-SUPPLIED pattern set (override path only). Each source is
// anchored ^…$ over the trimmed text and matched case-insensitively (`s` so `.` spans
// a multi-line banner). A pattern that fails to compile is skipped (never throws into
// the request path).
function compileTuiErrorPatterns(raw) {
  const sources = String(raw).split(/\r?\n|\|\|/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const src of sources) {
    try { out.push(new RegExp(`^(?:${src})$`, "is")); } catch { /* skip bad pattern */ }
  }
  return out;
}

// Returns the matched banner text (the trimmed assistant text) if `text` IS a claude-
// CLI auth-failure banner in its entirety, else null. `patternsRaw` defaults to
// process.env.CLAUDE_TUI_ERROR_PATTERNS:
//   - undefined  → narrowed default auth-banner detector (isDefaultAuthFailureBanner).
//   - non-empty  → operator regex override REPLACES the default.
//   - empty/ws   → detection disabled (escape hatch).
export function detectTuiUpstreamError(text, patternsRaw = process.env.CLAUDE_TUI_ERROR_PATTERNS) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (patternsRaw == null) {
    return isDefaultAuthFailureBanner(trimmed) ? trimmed : null;
  }
  // Operator override path: empty/whitespace disables; otherwise use only their regexes.
  const patterns = compileTuiErrorPatterns(patternsRaw);
  if (patterns.length === 0) return null;
  for (const re of patterns) {
    if (re.test(trimmed)) return trimmed;
  }
  return null;
}

// Block until the session transcript is terminal (turn_duration / final
// stop_reason) or the wall-clock cap elapses, polling the file (no fs.watch —
// robust over NFS / editors). Returns { text, entrypoint, truncated }:
//   - text:       latest assistant text.
//   - entrypoint: billing-pool classifier (see verifyEntrypoint), or null.
//   - truncated:  FALSE when a terminal marker was reached (the turn completed);
//                 TRUE when the wall-clock cap was hit with partial text but NO
//                 terminal marker (the turn is INCOMPLETE — what we have is a
//                 cut-off prefix). (C-2, issue #133.)
//
// Why `truncated` matters: previously the terminal-marker path and the
// cap-with-partial-text path BOTH returned `{text, entrypoint}` identically, so
// callClaudeTui could not tell a complete answer from a truncated one and cached +
// returned the partial as finish_reason:stop (silent success). The caller now
// throws on `truncated` so a cut-off turn is neither cached nor counted as success.
// The field is additive — existing call sites that ignore it keep working.
//
// On cap with NO text at all, still throws (unchanged) — there is nothing to return.
//
// No quiescence heuristic by design: a long Opus thinking turn stalls transcript
// growth and a "file stable for N s" rule would false-abort it (spec §4.3).
// Resolution: pass an explicit `transcriptPath` (used by unit tests), OR pass
// `home` + `sessionId` to resolve by glob each poll (production) — the transcript
// file does not exist until the turn starts, so resolution happens inside the loop.
// `abortSignal` (optional): when it fires, stop waiting and throw TuiAbortError. The one
// caller that passes it is the STREAMING TUI path, which ties it to the client's socket:
// a client that disconnects mid-turn should not leave the pane running (and the caller's
// concurrency slot held) until the turn or the 120s cap ends. runTuiTurn's finally does the
// teardown. Omitted => the loop is byte-for-byte the pre-streaming loop.
export async function readTuiTranscript({ transcriptPath: p, home, sessionId, wallclockMs = 120000, pollMs = 250, abortSignal = null }) {
  const deadline = Date.now() + wallclockMs;
  let lastText = "";
  let lastEntrypoint = null;
  while (Date.now() < deadline) {
    if (abortSignal && abortSignal.aborted) {
      const err = new Error("tui_aborted: client disconnected before the turn completed");
      err.name = "TuiAbortError";
      throw err;
    }
    const resolved = p || findTranscriptPath(home, sessionId);
    if (resolved && existsSync(resolved)) {
      const events = parseTranscriptLines(readFileSync(resolved, "utf8"));
      lastText = extractLatestAssistantText(events) || lastText;
      const ep = verifyEntrypoint(events);
      if (ep != null) lastEntrypoint = ep;
      // Terminal marker reached → the turn is COMPLETE.
      if (events.some(isTerminalLine)) return { text: lastText, entrypoint: lastEntrypoint, truncated: false };
    }
    await sleep(pollMs);
  }
  // Cap elapsed with no terminal marker. If we have partial text, flag it truncated
  // so the caller rejects it (don't cache / don't count as success). No text at all
  // → throw (nothing to return).
  if (lastText) return { text: lastText, entrypoint: lastEntrypoint, truncated: true };
  throw new Error("tui_transcript_timeout: no assistant text within wallclock cap");
}
