// Transcript reader for TUI-mode. Reads claude's native JSONL session transcript
// and returns the latest assistant turn's text once the turn is terminal.
//
// Authority: claude CLI v2.1.157 — interactive session transcript at
//   <HOME>/.claude/projects/<CWD with every "/" -> "-">/<--session-id>.jsonl
// Completion marker: a line {"type":"system","subtype":"turn_duration",...}.
// See docs/superpowers/specs/2026-05-30-tui-mode-production-design.md §4.
import { readFileSync, existsSync, readdirSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Project-dir encoding: claude replaces every "/" AND every "." with "-".
// Verified live (claude v2.1.158): cwd /home/u/.ocp-tui/work is stored under
// projects/-home-u--ocp-tui-work/ (the "." in ".ocp-tui" becomes "-", yielding
// the double dash). The earlier "/"-only rule was wrong for dotted paths; the
// fixture cwd /tmp/tui-test happened to have no dots so it never surfaced.
// NOTE: prefer findTranscriptPath() (glob by session-id) for resolution — it is
// immune to the exact encoding rule. This helper is kept for the known-path case.
export function encodeCwd(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

export function transcriptPath(home, cwd, sessionId) {
  return `${home}/.claude/projects/${encodeCwd(cwd)}/${sessionId}.jsonl`;
}

// Locate a session's transcript by its UUID across every projects subdir, without
// reconstructing the encoded cwd. Robust to whatever encoding claude applies.
// Returns the path, or null if not present yet (it appears once the turn starts).
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

// A line marks the assistant turn complete when it is the turn_duration system
// event. That is the ONLY reliable terminal marker in interactive TUI mode.
//
// Why tool_use is NOT a terminal marker:
//   In interactive claude, when the model decides to call a tool (stop_reason=
//   "tool_use"), claude handles the tool call internally and then continues
//   generating — the turn is NOT complete. The transcript advances to another
//   assistant entry after the tool result. Only {type:"system",
//   subtype:"turn_duration"} signals that claude has fully finished the turn.
//   Treating tool_use as terminal would truncate tool-using turns mid-flight.
export function isTerminalLine(obj) {
  if (!obj || typeof obj !== "object") return false;
  return obj.type === "system" && obj.subtype === "turn_duration";
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

// Returns the entrypoint string from the turn_duration line (e.g. "cli"),
// or null if absent. Lets callers assert the subscription-classified path.
// Fixture-confirmed: entrypoint field lives directly on the turn_duration line.
export function verifyEntrypoint(events) {
  for (const ev of events) {
    if (ev && ev.type === "system" && ev.subtype === "turn_duration") {
      return ev.entrypoint != null ? ev.entrypoint : null;
    }
  }
  return null;
}

// Block until the session transcript is terminal (turn_duration / tool_use) or
// the wall-clock cap elapses, polling the file (no fs.watch — robust over NFS /
// editors). Returns the latest assistant text. On cap with text, returns the
// partial text; on cap with no text at all, throws.
//
// No quiescence heuristic by design: a long Opus thinking turn stalls transcript
// growth and a "file stable for N s" rule would false-abort it (spec §4.3).
// Resolution: pass an explicit `transcriptPath` (used by unit tests), OR pass
// `home` + `sessionId` to resolve by glob each poll (production) — the transcript
// file does not exist until the turn starts, so resolution happens inside the loop.
export async function readTuiTranscript({ transcriptPath: p, home, sessionId, wallclockMs = 120000, pollMs = 250 }) {
  const deadline = Date.now() + wallclockMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const resolved = p || findTranscriptPath(home, sessionId);
    if (resolved && existsSync(resolved)) {
      const events = parseTranscriptLines(readFileSync(resolved, "utf8"));
      lastText = extractLatestAssistantText(events) || lastText;
      if (events.some(isTerminalLine)) return lastText;
    }
    await sleep(pollMs);
  }
  if (lastText) return lastText;
  throw new Error("tui_transcript_timeout: no assistant text within wallclock cap");
}
