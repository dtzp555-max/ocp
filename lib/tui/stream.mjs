// TUI-mode real SSE streaming — the `MessageDisplay` hook sink.
//
// WHAT THIS IS. `claude` fires a **MessageDisplay** hook per rendered block of the
// assistant's reply, handing the hook the RAW MARKDOWN SOURCE of an incremental
// `delta` on stdin. Registered via `--settings` on the ordinary interactive TUI spawn
// (NO -p, NO --bare — the billing pool is untouched), it is the only byte-faithful
// incremental source the interactive CLI exposes. Everything here consumes that hook
// surface AS EMITTED — forwarding, not inventing.
//
// ALIGNMENT.md: **Class B**. We consume claude's own hook payload and re-emit it in the
// OpenAI chat/completions streaming shapes OCP already speaks (ADR 0006). There is no
// `cli.js` citation because no `cli.js` function is being mirrored: the TUI spawn is
// OCP-owned surface (ADR 0007), and the hook payload is claude's own published contract.
//
// THE VERIFIED CONTRACT (docs/plans/2026-07-13-tui-latency/streaming-spike.md, and
// independently reproduced on claude 2.1.207 / sonnet-4-6 / banner `· Claude Max`):
//
//   payload (stdin, one JSON object per fire):
//     { hook_event_name:"MessageDisplay", session_id, transcript_path, prompt_id, cwd,
//       turn_id, message_id, index, final, delta }
//
//   - deltas carry the raw markdown source (`## `, `**`, ```javascript all present)
//   - concat(deltas of one message) === T, byte-exactly   (T = extractLatestAssistantText)
//   - T.startsWith(concat(deltas[0..n])) at EVERY n       (prefix-stable)
//   - block-level granularity (~5-7 fires per answer), NOT token-level
//   - only `text` blocks fire it — thinking blocks are excluded (what OCP wants)
//
// ⚠️ THE HOOK IS SYNCHRONOUS. The hook's source sets `forceSyncExecution: true` —
// `claude` BLOCKS on every fire. The hook script must therefore write and exit, doing
// NO work inline. Measured cost of the script below: p50 7.2 ms / p90 14.7 ms per fire,
// i.e. ~50 ms added blocking across a whole ~7-delta turn against a 6-10 s turn. That is
// noise, so a plain append is the right sink — a FIFO would be faster on paper but a FIFO
// blocks its writer until a reader attaches, which would hand `claude` a way to hang.
//
// WARM-POOL COMPATIBILITY (load-bearing — a warm pane pool is a separate in-flight PR).
// The hook script and the settings file are BOTH STATIC: one copy per stream dir, written
// once, never per-request. The per-turn destination is carried in the PANE'S OWN ENV as
// `OCP_TUI_STREAM_FILE` (verified live: a hook inherits the pane's environment), and the
// path is derived from the session-id — which for a pre-booted pane is fixed at BOOT.
// Nothing about a request is baked into the settings file at spawn time, so a pane booted
// before its request arrives streams exactly the same way.
import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { detectTuiUpstreamError } from "./transcript.mjs";

// Default holdback before the first byte is released to the client. See TuiDeltaAssembler.
export const DEFAULT_HOLDBACK_CHARS = 100;

// The hook script. POSIX sh, no interpreter startup beyond /bin/sh, one fork (`cat`).
//
//   - `printf` is a shell BUILTIN in sh/dash/bash, so the newline costs no fork.
//   - the `{ cat; printf '\n'; } >>` group opens the file ONCE and appends both writes
//     through the same O_APPEND fd, so a payload and its terminator can never be split
//     by another writer. (They never race anyway: one file per pane, and MessageDisplay
//     is synchronous within a pane.)
//   - a payload JSON can never contain a literal newline — JSON.stringify escapes them —
//     so "one line == one payload" holds, and a torn write is always a trailing partial
//     line, which parseDeltaChunk() leaves unconsumed until it completes.
//   - NO OCP_TUI_STREAM_FILE (e.g. a pane booted with streaming off, or any other claude
//     session that happens to load this settings file) => swallow stdin and exit 0. The
//     hook must NEVER fail or block: claude is waiting on it.
export const HOOK_SCRIPT = `#!/bin/sh
# OCP TUI streaming sink — claude fires this per MessageDisplay block and BLOCKS on it.
# Write and exit. Never do work here.
[ -n "\$OCP_TUI_STREAM_FILE" ] || exec cat >/dev/null
{ cat; printf '\\n'; } >> "\$OCP_TUI_STREAM_FILE"
`;

// The --settings payload registering the hook. Static: no per-request data.
export function buildStreamSettings(hookScriptPath) {
  return { hooks: { MessageDisplay: [{ hooks: [{ type: "command", command: hookScriptPath }] }] } };
}

export const hookScriptPath   = (streamDir) => `${streamDir}/md-hook.sh`;
export const streamSettingsPath = (streamDir) => `${streamDir}/settings.json`;
// One file per session-id. For a pre-booted (warm) pane the session-id is fixed at boot,
// so this path is knowable at boot — which is what keeps the pool compatible.
export const streamFilePath   = (streamDir, sessionId) => `${streamDir}/${sessionId}.jsonl`;

// Atomic write: temp file + rename (same-directory, same-filesystem, so rename is atomic on
// POSIX). A process killed mid-`writeFileSync` leaves the TEMP file half-written, never the
// real path — `path` always names either the old complete content or the new complete
// content, never a torn one. That matters specifically for md-hook.sh: it is SYNCHRONOUS
// (claude blocks on every fire), so a truncated script would still pass `existsSync`, still
// get exec'd, and fail/hang on every single MessageDisplay fire with no operator-visible
// symptom short of streaming going silently dead (F7's streamZeroDeltaTurns is the backstop
// for exactly that). Mirrors ensureTuiCwdTrusted's tmp+renameSync pattern in session.mjs.
function writeFileAtomic(path, content, mode) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

// Write the static hook script + settings file into `streamDir`. UNCONDITIONAL, not
// write-if-missing: these files persist across OCP restarts at `streamDir`, so a host that
// booted once under an older version and never had its stream dir cleared would otherwise be
// silently stuck on a stale HOOK_SCRIPT / buildStreamSettings() forever — no future OCP
// upgrade could ever reach it. Safe to call every boot: the content is static (no per-request
// data), so a same-content rewrite is the overwhelmingly common case and costs two tiny
// atomic writes, not a per-turn expense. Returns the settings path to hand to `claude
// --settings`.
export function prepareStreamHook(streamDir) {
  mkdirSync(streamDir, { recursive: true });
  const script = hookScriptPath(streamDir);
  const settings = streamSettingsPath(streamDir);
  writeFileAtomic(script, HOOK_SCRIPT, 0o700);
  writeFileAtomic(settings, JSON.stringify(buildStreamSettings(script), null, 2), 0o600);
  return settings;
}

// Parse newly-appended sink lines. `consumed` is the number of COMPLETE lines already
// taken; only lines terminated by "\n" are complete, so a payload caught mid-write stays
// unconsumed until its terminator lands. Returns the fresh MessageDisplay payloads plus
// the new consumed count. Pure — the caller owns the cursor.
export function parseDeltaChunk(text, consumed = 0) {
  const lines = String(text ?? "").split("\n");
  const complete = lines.slice(0, -1); // the tail after the last "\n" is a partial line
  const deltas = [];
  for (const line of complete.slice(consumed)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.hook_event_name === "MessageDisplay" && typeof o.delta === "string") deltas.push(o);
    } catch { /* not ours / not parseable — skip, never throw into the request path */ }
  }
  return { deltas, consumed: complete.length };
}

// ── The assembler: hook deltas → client bytes, with the honesty gates intact ──
//
// Two jobs, both load-bearing.
//
// 1. THE AUTH-BANNER HOLDBACK (C-1 / issue #133 must survive streaming).
//    The interactive CLI renders an auth failure as ordinary assistant TEXT — so an
//    expired-credential turn fires MessageDisplay with the BANNER as its delta, and a
//    naive forwarder would stream "Please run /login · API Error: 401 …" to the client as
//    a normal answer, exactly the silent-error case C-1 exists to prevent.
//    detectTuiUpstreamError() classifies a WHOLE message, so it cannot be run per-delta.
//    Instead we HOLD BACK the first `holdbackChars` characters. The default detector only
//    ever fires on a message of <= 100 chars (TUI_ERR_MAX_LEN — real banners are 69 and 73),
//    so once the TRIMMED accumulation EXCEEDS 100 chars the final text cannot be a banner by
//    that detector's own length rule, and releasing is safe. An answer that never exceeds the
//    holdback is simply delivered whole at terminal — i.e. exactly today's buffered
//    behaviour, gates and all.
//    THE GUARANTEE HAS TWO HALVES, both required — neither alone is sufficient:
//      (i)  Nothing is emitted for a message until its trimmed accumulation exceeds the
//           detector's max banner length. This is what keeps the FIRST message of a turn
//           safe: a banner-length message can never clear the holdback.
//      (ii) Once a message boundary follows an emit (`restartedAfterEmit`), push() stops
//           emitting ENTIRELY for the rest of the turn — a SECOND message (e.g. an
//           auth-failure banner rendered mid-turn, after tool-using prose already streamed)
//           gets zero bytes forwarded, not just a fresh holdback of its own. finalize() then
//           refuses the whole turn (SSE error frame, no cache) precisely because the first
//           message's bytes are unretractable and unverifiable against T. Without this half,
//           (i) alone only protects the FIRST message per turn — see F1.
//    ⚠️ Soundness is w.r.t. the DEFAULT detector. An operator who REPLACES it via
//    CLAUDE_TUI_ERROR_PATTERNS with a pattern that can match a longer message must raise
//    OCP_TUI_STREAM_HOLDBACK past their longest banner; server.mjs warns at boot. That is the
//    one case (i) does not cover — (ii) still applies regardless. Even past both, the
//    terminal gate still refuses to cache a banner and still ends the stream on an SSE error
//    frame rather than finish_reason:"stop" — the holdback is the first of two layers, not
//    the only one.
//
// 2. MESSAGE SCOPING (keeps `concat === T` the RIGHT assertion).
//    The transcript's T is extractLatestAssistantText() — the LAST text-bearing assistant
//    entry, not every assistant entry. A tool-using turn therefore has TWO messages
//    (prose → tool_use → answer) and T is only the second. So the assembler scopes to the
//    CURRENT message_id: when a new message_id appears and NOTHING has been emitted yet,
//    the held text is DISCARDED — the transcript is about to discard it too, so this keeps
//    us byte-identical to the buffered path instead of streaming prose the buffered path
//    would have dropped. When a new message_id appears AFTER we have already emitted, the
//    bytes are gone and cannot be retracted: finalize() then reports !ok and the caller
//    fails the turn loudly (SSE error frame, no cache, counted on /health). Fail-loud is
//    the correct posture — a proxy that silently serves text the transcript disagrees with
//    is the exact class of bug ALIGNMENT.md exists to prevent.
// Sentinel for "no message seen yet". Deliberately not null/undefined — see the constructor.
const NO_MESSAGE_YET = Symbol("no-message-yet");

export class TuiDeltaAssembler {
  constructor({ holdbackChars = DEFAULT_HOLDBACK_CHARS, detectError = detectTuiUpstreamError } = {}) {
    this.holdbackChars = holdbackChars;
    this.detectError = detectError;
    this.emitted = "";   // bytes ALREADY written to the client — unretractable
    this.pending = "";   // held back, not yet written
    this.released = false;
    // NOT null: a payload may legitimately carry message_id === null, and if the sentinel were
    // also null the FIRST such payload would compare equal to it, register no boundary, and
    // leave `messages` at 0 — which used to disarm the restartedAfterEmit guard below entirely.
    // A unique object is === to nothing a JSON payload can produce, so the first fire ALWAYS
    // registers as message 1, whatever its message_id is (or isn't).
    this.messageId = NO_MESSAGE_YET;
    this.deltas = 0;     // hook fires seen
    this.messages = 0;   // distinct message_ids seen
    this.restartedAfterEmit = false;
  }

  // All hook bytes for the CURRENT message (emitted + still held).
  get full() { return this.emitted + this.pending; }

  // Feed one MessageDisplay payload. Returns the text to emit NOW, or null (held back).
  push(payload) {
    const delta = payload && typeof payload.delta === "string" ? payload.delta : "";
    const mid = payload ? payload.message_id : null;
    if (mid !== this.messageId) {
      this.messageId = mid;
      this.messages++;
      if (this.emitted === "") {
        this.pending = "";        // safe: the transcript will drop this message too
      } else {
        // A boundary while bytes are ALREADY out is unrecoverable, full stop — the count of
        // messages seen so far is irrelevant. The old `else if (this.messages > 1)` guard was
        // the sole reason a null-message_id first payload could disarm F1: it left `messages`
        // at 0, so the real boundary evaluated 1 > 1 === false and never armed. The invariant
        // is "a boundary occurred while emitted !== ''", and that is exactly what this says.
        this.restartedAfterEmit = true; // unrecoverable — finalize() will refuse the turn
      }
    }
    this.deltas++;
    // F1: once a message boundary has followed an emit, the turn is ALREADY unrecoverable —
    // finalize() will refuse it (see restartedAfterEmit above). `this.released` stays true
    // from the FIRST message's release and, uncorrected, lets every later message's deltas
    // stream straight through unfiltered — exactly the auth-banner-mid-turn leak this class
    // exists to prevent. Stop emitting HERE, permanently, for the rest of the turn: there is
    // nothing left to gain from continuing to forward bytes for a turn that will be refused,
    // and every byte forwarded now is one more the client cannot be told to un-see.
    if (this.restartedAfterEmit) return null;
    if (!delta) return null;

    if (this.released) {
      this.emitted += delta;
      return delta;
    }
    this.pending += delta;
    // Release only once the TRIMMED accumulation is past the banner detector's reach.
    // detectTuiUpstreamError() trims before measuring length (TUI_ERR_MAX_LEN is a trimmed-
    // length bound), so gating release on the UNTRIMMED pending.length let a run of >
    // holdbackChars whitespace trim down to "" — detectError("") sees nothing to classify,
    // returns null, and release fires with the holdback never having actually screened
    // anything. Trimming here keeps both sides of the check talking about the same string.
    if (this.pending.trim().length > this.holdbackChars && this.detectError(this.pending) == null) {
      const out = this.pending;
      this.pending = "";
      this.released = true;
      this.emitted += out;
      return out;
    }
    return null;
  }

  // Reconcile against the AUTHORITATIVE transcript text T. Call only AFTER the truncation
  // and auth-banner gates have passed. Returns:
  //   { ok:true,  tail, exact }  — tail is the remaining text to emit (may be ""). `exact`
  //                               is concat(deltas) === T; when false we still serve exactly
  //                               T, having topped up from the transcript, and the caller
  //                               counts a topUp.
  //   { ok:false, ... }          — what we already emitted is NOT a prefix of T. The client
  //                               holds bytes the transcript disagrees with; the caller must
  //                               NOT cache and must end the stream on an SSE error frame.
  finalize(T) {
    const text = typeof T === "string" ? T : "";
    const full = this.full;
    if (!text.startsWith(this.emitted)) {
      return { ok: false, tail: null, exact: false, emitted: this.emitted.length, transcript: text.length };
    }
    return {
      ok: true,
      tail: text.slice(this.emitted.length),
      exact: full === text,
      emitted: this.emitted.length,
      transcript: text.length,
    };
  }
}
