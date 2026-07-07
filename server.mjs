#!/usr/bin/env node
/**
 * openclaw-claude-proxy — OpenAI-compatible proxy for Claude CLI
 *
 * Translates OpenAI chat/completions requests into `claude --output-format stream-json` CLI calls,
 * letting you use your Claude Pro/Max subscription as an OpenClaw model provider.
 *
 * Timeout design: single CLAUDE_TIMEOUT (default 600s / 10 min).
 * No separate first-byte or idle timeout — Claude tool-use causes long pauses
 * in the token stream (30s-5min) that make fine-grained timeouts unreliable.
 * This matches LiteLLM, OpenAI SDK, and other major LLM proxies.
 *
 * Env vars:
 *   CLAUDE_PROXY_PORT            — listen port (default: DEFAULT_PORT from lib/constants.mjs)
 *   CLAUDE_BIN                   — path to claude binary (default: auto-detect)
 *   CLAUDE_TIMEOUT               — per-request timeout in ms (default: 600000)
 *   CLAUDE_ALLOWED_TOOLS         — comma-separated tools to allow (default: expanded set)
 *   CLAUDE_SKIP_PERMISSIONS      — "true" to bypass all permission checks (default: false)
 *   CLAUDE_SYSTEM_PROMPT         — system prompt appended to all requests
 *   CLAUDE_MCP_CONFIG            — path to MCP server config JSON file
 *   CLAUDE_SESSION_TTL           — session TTL in ms (default: 3600000 = 1h)
 *   CLAUDE_MAX_CONCURRENT        — max concurrent claude processes, -p/stream-json path (default: 8)
 *   CLAUDE_MAX_QUEUE             — max requests waiting for a -p slot before HTTP 429 (default: 16)
 *   OCP_TUI_MAX_CONCURRENT       — max concurrent interactive TUI turns, TUI-mode path (default: 2)
 *   OCP_SPAWN_REAL_HOME          — "1" forces the -p spawn to use the real HOME (disables the
 *                                  latency spawn-home isolation; default: isolated when a token exists)
 *   CLAUDE_BREAKER_THRESHOLD     — failures in window before circuit opens (default: 6)
 *   CLAUDE_BREAKER_COOLDOWN      — base ms to wait before retrying after circuit opens (default: 120000)
 *   CLAUDE_BREAKER_WINDOW        — sliding window duration in ms (default: 300000 = 5min)
 *   CLAUDE_BREAKER_HALF_OPEN_MAX — max concurrent probes in half-open state (default: 2)
 *   PROXY_API_KEY                — Bearer token for API auth (optional)
 *   CLAUDE_HEARTBEAT_INTERVAL    — SSE heartbeat interval in ms on streaming path (default: 0 = disabled)
 */
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync, accessSync, existsSync, constants, chmodSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { validateKey, recordUsage, getUsageByKey, getUsageTimeline, getRecentUsage, createKey, listKeys, revokeKey, closeDb, checkQuota, updateKeyQuota, getKeyQuota, findKey, cacheHash, getCachedResponse, setCachedResponse, clearCache, getCacheStats, hasCacheControl, singleflight, getInflightStats } from "./keys.mjs";
import { DEFAULT_PORT } from "./lib/constants.mjs";
import { isLoopbackBind } from "./lib/net.mjs";
import { runTuiTurn, reapStaleTuiSessions, resolveTuiHome } from "./lib/tui/session.mjs";
import { detectTuiUpstreamError } from "./lib/tui/transcript.mjs";
import { TuiSemaphore, recordTuiEntrypoint, buildTuiHealthBlock } from "./lib/tui/semaphore.mjs";
import { createSerialMutex, createTtlCache, isTokenExpiring, orderLabelsLastGoodFirst } from "./lib/spawn-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
const modelsConfig = JSON.parse(readFileSync(join(__dirname, "models.json"), "utf8"));

// ── Resolve claude binary ───────────────────────────────────────────────
// Priority: CLAUDE_BIN env > well-known paths > nvm/fnm/asdf user-local
// installs > which lookup. Fail-fast if not found — never start with an
// unresolvable binary.
function _listVersionDirs(parent) {
  try { return readdirSync(parent); } catch { return []; }
}
function _collectNodeManagerCandidates(home) {
  if (!home) return [];
  const out = [];

  // nvm: $HOME/.nvm/versions/node/<version>/bin/claude
  const nvmRoot = join(home, ".nvm/versions/node");
  for (const v of _listVersionDirs(nvmRoot)) {
    out.push(join(nvmRoot, v, "bin/claude"));
  }
  // nvm default alias: resolve $HOME/.nvm/aliases/default if it points to a version
  try {
    const aliasFile = join(home, ".nvm/aliases/default");
    const aliasVer = readFileSync(aliasFile, "utf8").trim();
    if (aliasVer) {
      const direct = join(nvmRoot, aliasVer, "bin/claude");
      if (!out.includes(direct)) out.unshift(direct);
    }
  } catch {}

  // fnm: $HOME/.fnm/node-versions/<version>/installation/bin/claude
  const fnmRoot = join(home, ".fnm/node-versions");
  for (const v of _listVersionDirs(fnmRoot)) {
    out.push(join(fnmRoot, v, "installation/bin/claude"));
  }

  // asdf: $HOME/.asdf/installs/nodejs/<version>/bin/claude
  const asdfRoot = join(home, ".asdf/installs/nodejs");
  for (const v of _listVersionDirs(asdfRoot)) {
    out.push(join(asdfRoot, v, "bin/claude"));
  }

  // npm prefix-relocated: $HOME/.npm-global/bin/claude
  out.push(join(home, ".npm-global/bin/claude"));

  return out;
}
function resolveClaude() {
  if (process.env.CLAUDE_BIN) {
    try {
      accessSync(process.env.CLAUDE_BIN, constants.X_OK);
      return process.env.CLAUDE_BIN;
    } catch {
      console.error(`FATAL: CLAUDE_BIN="${process.env.CLAUDE_BIN}" is set but not executable.`);
      process.exit(1);
    }
  }

  const home = process.env.HOME || "";
  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    join(home, ".local/bin/claude"),
    ..._collectNodeManagerCandidates(home),
  ];
  for (const p of candidates) {
    try { accessSync(p, constants.X_OK); console.warn(`[init] CLAUDE_BIN not set, resolved to ${p}`); return p; } catch {}
  }

  try {
    const resolved = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 5000 }).trim();
    if (resolved) { console.warn(`[init] CLAUDE_BIN not set, resolved via which: ${resolved}`); return resolved; }
  } catch {}

  console.error(
    "FATAL: claude binary not found.\n" +
    "  Set CLAUDE_BIN=/path/to/claude or ensure claude is in PATH.\n" +
    "  Hint: if you use nvm/fnm/asdf, set CLAUDE_BIN to the absolute path\n" +
    "  shown by `which claude` in your interactive shell.\n" +
    "  Checked: " + candidates.join(", ")
  );
  process.exit(1);
}

// ── OCP system prompt wrapper (Phase 6c port — ADR 0009 Amendment 1 analogue) ─
// Injected via `--system-prompt` flag, replacing claude CLI's default system
// prompt (which normally includes cwd, OS, tool descriptions, and git status —
// all irrelevant and potentially misleading when the model is accessed via the
// OCP HTTP proxy).
//
// Authority: claude CLI § --system-prompt (ported from OLP, verified v2.1.104;
// behavior stable through v2.1.158 — OLP ADR 0009 Amendment 1 §
// "OLP system prompt wrapper"; ported to OCP 2026-05-30).
// Reference: https://github.com/dtzp555-max/olp commit 97e7d16 (Phase 6c)
const OCP_SYSTEM_PROMPT_WRAPPER = `You are accessed via the OCP HTTP proxy. You do NOT have access to any local filesystem, working directory, shell, git status, or machine environment. Do not infer or invent such information from any context you observe. Respond only based on the conversation provided.`;

// Build the full system-prompt string: OCP_SYSTEM_PROMPT_WRAPPER prepended,
// then any system-role messages from the request appended (separated by blank line).
// ADR 0009 Amendment 1 analogue § "OLP system prompt wrapper".
function extractSystemPrompt(messages) {
  const systemMessages = (messages ?? []).filter(m => m.role === "system");
  if (systemMessages.length === 0) {
    return OCP_SYSTEM_PROMPT_WRAPPER;
  }
  const clientContent = systemMessages.map(m =>
    contentToText(m.content)
  ).join("\n\n");
  return `${OCP_SYSTEM_PROMPT_WRAPPER}\n\n${clientContent}`;
}

// ── NDJSON line buffer parser (Phase 6c port) ─────────────────────────────
// Splits a buffered string on newlines, returning complete parsed events
// plus the trailing incomplete line as `remainder` for the next data chunk.
//
// Authority: claude CLI § --output-format stream-json (ported from OLP, verified v2.1.104;
//   behavior stable through v2.1.158; each event is a newline-terminated JSON object on stdout).
// Reference: OLP lib/providers/anthropic.mjs parseStreamJsonLines (commit 97e7d16).
function parseStreamJsonLines(buffered) {
  const lines = buffered.split("\n");
  const remainder = lines.pop(); // last element is the incomplete trailing line
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      console.error("[claude] NDJSON parse error on line:", trimmed.slice(0, 120));
      events.push({ type: "parse_error", raw: trimmed });
    }
  }
  return { events, remainder: remainder ?? "" };
}

// ── NDJSON event → text content extractor (Phase 6c port) ────────────────
// Maps claude CLI stream-json NDJSON events to { text, stop, error } signals.
// Returns:
//   { text: string }   — content delta to forward
//   { stop: true }     — terminal event (emit finish_reason=stop)
//   { error: string }  — error event (emit error stop)
//   null               — consumed event (log/ignore)
//
// Authority: claude CLI § --output-format stream-json (ported from OLP, verified v2.1.104;
//   behavior stable through v2.1.158).
// Reference: OLP lib/providers/anthropic.mjs anthropicStreamJsonEventToIR (commit 97e7d16).
//
// @param {object} event — parsed NDJSON event
// @param {boolean} isFirstDelta — true if no content has been yielded yet
function parseStreamJsonEvent(event, isFirstDelta) {
  const t = event?.type;

  // system/* — first-event init + other system meta (api_retry etc.)
  if (t === "system") return null;
  // user — echo of user message; consumed
  if (t === "user") return null;

  // stream_event — contains nested content_block_delta
  if (t === "stream_event") {
    const inner = event.event ?? event;
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { text: inner.delta.text ?? "" };
    }
    // Other stream_event sub-types (content_block_start, message_delta, etc.) — consumed
    return null;
  }

  // assistant — aggregate message (fallback when no prior content_block_delta seen)
  // Empirically (claude CLI without --include-partial-messages, verified v2.1.104 through v2.1.158): fast/short
  // responses may emit ONLY the aggregate assistant event, no content_block_delta events.
  // If isFirstDelta is true, extract text here; otherwise it's a duplicate, ignore.
  // Reference: OLP commit 65f945c (assistant-aggregate fallback, fold-in).
  if (t === "assistant") {
    if (isFirstDelta) {
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter(b => b && b.type === "text" && typeof b.text === "string")
          .map(b => b.text)
          .join("");
        if (text) return { text };
      }
    }
    return null;
  }

  // result — terminal event
  if (t === "result") {
    if (event.is_error === true) {
      return { error: event.error_message ?? event.result ?? "claude returned is_error" };
    }
    return { stop: true };
  }

  // rate_limit_event / usage — log for observability, don't forward
  if (t === "rate_limit_event" || t === "usage") {
    logEvent("info", "claude_stream_event", { type: t, data: JSON.stringify(event).slice(0, 200) });
    return null;
  }

  // control_request — per Anthropic stream-json docs
  if (t === "control_request") {
    console.error("[claude] stream_json control_request event (ignored):", JSON.stringify(event).slice(0, 120));
    return null;
  }

  // parse_error — already logged by parseStreamJsonLines
  if (t === "parse_error") return null;

  // Unknown event type — log + skip; future-proof for new claude CLI events
  if (t !== undefined) {
    console.error("[claude] unknown stream_json event type:", t);
  }
  return null;
}

// ── Configuration ───────────────────────────────────────────────────────
// Settings marked with `let` can be changed at runtime via PATCH /settings.
const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT), 10);
const CLAUDE = resolveClaude();
let TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "600000", 10);
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const SKIP_PERMISSIONS = process.env.CLAUDE_SKIP_PERMISSIONS === "true";
const ALLOWED_TOOLS = (process.env.CLAUDE_ALLOWED_TOOLS ||
  "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent"
).split(",").map(s => s.trim()).filter(Boolean);
const SYSTEM_PROMPT = process.env.CLAUDE_SYSTEM_PROMPT || "";
const MCP_CONFIG = process.env.CLAUDE_MCP_CONFIG || "";
let SESSION_TTL = parseInt(process.env.CLAUDE_SESSION_TTL || "3600000", 10);
let MAX_CONCURRENT = parseInt(process.env.CLAUDE_MAX_CONCURRENT || "8", 10);
// FIX ⑥ (concurrency): bound on requests WAITING for a -p concurrency slot. Beyond
// MAX_CONCURRENT, requests queue (up to CLAUDE_MAX_QUEUE) instead of being rejected; when the
// queue is ALSO full, the request gets HTTP 429 + Retry-After (not an opaque 500). See
// claudeSemaphore / acquireClaudeSlot below.
const CLAUDE_MAX_QUEUE = parseInt(process.env.CLAUDE_MAX_QUEUE || "16", 10);
// Retry-After seconds advertised on a 429 backpressure response. A claude turn is typically a
// few seconds to tens of seconds; a small constant nudge keeps well-behaved clients from
// hammering while the queue drains.
const CLAUDE_QUEUE_RETRY_AFTER = parseInt(process.env.CLAUDE_QUEUE_RETRY_AFTER || "5", 10);
const BREAKER_THRESHOLD = parseInt(process.env.CLAUDE_BREAKER_THRESHOLD || "6", 10);
const BREAKER_COOLDOWN = parseInt(process.env.CLAUDE_BREAKER_COOLDOWN || "120000", 10);
const BREAKER_WINDOW = parseInt(process.env.CLAUDE_BREAKER_WINDOW || "300000", 10);
const BREAKER_HALF_OPEN_MAX = parseInt(process.env.CLAUDE_BREAKER_HALF_OPEN_MAX || "2", 10);
const HEARTBEAT_INTERVAL = parseInt(process.env.CLAUDE_HEARTBEAT_INTERVAL || "0", 10);
const BIND_ADDRESS = process.env.CLAUDE_BIND || "127.0.0.1";
const NO_CONTEXT = process.env.CLAUDE_NO_CONTEXT === "true";
// Kill-switch for the FIX-③ default-path spawn-home isolation (see resolveSpawnHome /
// spawnHomeMode below). When "1", the -p/stream-json spawn always runs in the operator's
// real HOME with no cwd override — byte-for-byte the pre-isolation behaviour — even if an
// OAuth token is resolvable. Provided as an escape hatch in case a host depends on the real
// HOME's claude config for the spawned process.
const SPAWN_REAL_HOME = process.env.OCP_SPAWN_REAL_HOME === "1";
const AUTH_MODE = process.env.CLAUDE_AUTH_MODE || (PROXY_API_KEY ? "shared" : "none");
const ADMIN_KEY = process.env.OCP_ADMIN_KEY || "";
const PROXY_ANONYMOUS_KEY = process.env.PROXY_ANONYMOUS_KEY || "";
// When set to "1", advertise PROXY_ANONYMOUS_KEY in the public /health body so
// remote `ocp-connect` devices can zero-config auto-discover it (issue #12 §14 Path A).
// Default OFF: /health is unauthenticated, so advertising hands the shared key to any
// LAN-reachable device (issue #109 P0). Localhost callers always see it regardless,
// since localhost is already fully trusted by the auth path.
const ADVERTISE_ANON_KEY = process.env.PROXY_ADVERTISE_ANON_KEY === "1";
let CACHE_TTL = parseInt(process.env.CLAUDE_CACHE_TTL || "0", 10); // 0 = disabled, value in ms

// ── TUI-mode (subscription-pool bridge) — opt-in; default OFF ───────────
// When ON: requests are served by spawning interactive `claude` (no -p / no
// --output-format) so cc_entrypoint=cli (subscription pool). Responses are
// buffered then replayed as chunked SSE.  Streaming is always buffered here.
// Authority: docs/adr/0007-tui-interactive-mode.md
// SECURITY: TUI-mode is SINGLE-USER ONLY.  Never enable on a multi-user OCP
// (guest prompts would run claude with operator filesystem access).
const TUI_MODE = process.env.CLAUDE_TUI_MODE === "true";
const TUI_WALLCLOCK_MS = parseInt(process.env.CLAUDE_TUI_WALLCLOCK_MS || "120000", 10);
const TUI_CWD  = process.env.OCP_TUI_CWD  || `${process.env.HOME}/.ocp-tui/work`;
// HOME the interactive claude runs under. resolveTuiHome() decides:
//   - OCP_TUI_HOME set            → that path (explicit override, back-compat).
//   - else CLAUDE_CODE_OAUTH_TOKEN set → a CREDENTIAL-FREE scratch home
//     (<HOME>/.ocp-tui/home) with NO .credentials.json, so the env token is the only
//     credential and is authoritative — interactive claude otherwise PREFERS a
//     credentials.json over the env var, so a stale one shadows the token (proven live on
//     PI231) and a refresh on it can corrupt the single-use token. See ADR 0007 PR-D.
//   - else (no env token)         → the operator's real home (legacy credentials.json path,
//     byte-for-byte unchanged for hosts that intentionally rely on credentials.json).
const TUI_HOME = resolveTuiHome({
  realHome:       process.env.HOME,
  configuredHome: process.env.OCP_TUI_HOME,
  envTokenSet:    !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
});
const TUI_ENTRYPOINT = process.env.OCP_TUI_ENTRYPOINT || "cli"; // cli|auto|off — see ADR 0007
// Independent concurrency bound for the TUI path (audit C-4). Default 2: a TUI turn is
// HEAVY (per-request cold-boot of a tmux+claude session + up to TUI_WALLCLOCK_MS=120s of
// wallclock), so a small host (e.g. a Pi 4 serving a family) cannot run many at once
// without OOM + multiplied subscription rate-limit pressure. This is NOT the global
// MAX_CONCURRENT gate (that lives in spawnClaudeProcess, the -p/stream-json path, which
// callClaudeTui never reaches). See ADR 0007 PR-B amendment + lib/tui/semaphore.mjs.
const TUI_MAX_CONCURRENT = parseInt(process.env.OCP_TUI_MAX_CONCURRENT || "2", 10);
const tuiSemaphore = new TuiSemaphore(TUI_MAX_CONCURRENT);
// Operator-visible TUI drift surface (audit C-5). lastEntrypoint + entrypointMismatches
// let the operator poll /health to catch a silent metered-pool drift (the audit's top
// risk: after the 6/15 flip a TTY-loss could flip cc_entrypoint cli→sdk-cli and drain
// metered credits invisibly — the warning currently only reaches journald).
const tuiStats = {
  lastEntrypoint: null,      // last observed cc_entrypoint from the transcript ("cli" | "sdk-cli" | null)
  entrypointMismatches: 0,   // count of cli-expected-but-got-other turns
};

// ── FIX ③ (latency): default-path (-p / stream-json) spawn-home isolation ──────────────
// PROBLEM (measured, not theoretical): OCP's default spawn inherits the operator's real HOME
// (loading the global ~/.claude — plugins, skills, hooks) and runs with cwd=~/ocp (loading the
// project CLAUDE.md / skills) on EVERY request. Pure Anthropic API floor for haiku "hi" ≈ 1–2s;
// the same claude CLI spawned in the operator's real HOME/cwd ≈ 10–28s; a clean minimal HOME +
// CLAUDE_CODE_OAUTH_TOKEN ≈ 3–7s and authenticates fine. So the heavy global config is pure
// per-request latency tax with no proxy benefit (a proxy must NOT leak the host's context into
// the proxied turn — same rationale as NO_CONTEXT / the TUI path's CLAUDE_MDS suppression).
//
// FIX: when an OAuth token is resolvable, run the default spawn under a CREDENTIAL-FREE minimal
// scratch HOME (`<realHome>/.ocp/spawn-home`) with cwd = that same neutral dir, and pass the
// resolved token via CLAUDE_CODE_OAUTH_TOKEN so the env token is authoritative. This MIRRORS the
// TUI path's resolveTuiHome() env-token mode (lib/tui/session.mjs): for `-p`, the env token wins
// over a credentials.json (the opposite of interactive claude), so credential isolation is not
// even strictly required for auth here, but a credential-FREE home is still the right shape —
// nothing to refresh, nothing to corrupt, no heavy config to load.
//
// SAFETY: if NO token is resolvable → fall back to the real HOME with no cwd override (zero
// regression). OCP_SPAWN_REAL_HOME=1 forces that legacy behaviour even when a token exists.
// The scratch home holds NO .credentials.json / NO settings.json / NO plugins — it is created
// minimal and (re)cleaned of any settings.json on prepare.
const SPAWN_HOME_DIR = `${process.env.HOME}/.ocp/spawn-home`;

// Idempotently prepare the minimal scratch HOME. Creates the dir if missing and removes any
// settings.json that might have crept in, so the spawned claude loads no host settings/plugins.
// Best-effort: a failure here degrades toward "dir may be missing", which spawn() tolerates by
// erroring loudly — never a silent auth/credential corruption (there are no credentials here).
function prepareSpawnHome(dir = SPAWN_HOME_DIR) {
  try {
    mkdirSync(`${dir}/.claude`, { recursive: true });
    // Belt-and-braces: ensure no settings.json/plugins leak in (this home is fully ours).
    for (const f of [`${dir}/.claude/settings.json`, `${dir}/.claude/settings.local.json`]) {
      try { if (existsSync(f)) rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  } catch { /* best effort — spawn will surface a hard error if the dir is truly unusable */ }
}

// Resolve the default-spawn HOME-isolation decision. Returns { isolated, home, reason }:
//   - isolated:true  → spawn under SPAWN_HOME_DIR with cwd=SPAWN_HOME_DIR + the env token.
//   - isolated:false → legacy real-HOME spawn, no cwd override (no token, or kill-switch on).
//
// FIX F6 (2026-07-07): this decision is NO LONGER memoized permanently. The previous version
// cached it forever at first call, which meant: (a) credentials appearing after startup never
// enabled isolation; (b) `rm -rf ~/.ocp/spawn-home` at runtime made every isolated spawn ENOENT
// until restart; (c) during a token-expiry stint /health reported isolated:true while spawns
// actually ran real-HOME. Re-evaluating per spawn is cheap because F5's 30s keychain TTL cache
// backs getOAuthCredentials(). This function is the CONFIG-level decision (isolated iff a token
// resolves AND the kill-switch is off) and has NO fs side effects — the per-spawn EFFECTIVE
// decision additionally applies the expiry gate (resolveSpawnDecision), and scratch-HOME dir prep
// moved to ensureSpawnHome() at the isolated spawn site.
//
// The token itself is re-resolved FRESH per spawn via resolveSpawnToken(); a memoized token goes
// stale when its source rotates (the macOS keychain access token rotates ~hourly, refreshed by the
// operator's real claude), which 401'd every isolated spawn for ~31h on 2026-06-26 (#146). OCP
// deliberately does NOT refresh the token itself — a refresh-token grant would consume the
// single-use refresh token and log out the operator's real claude (issue #112).
function getSpawnHomeMode() {
  if (SPAWN_REAL_HOME) {
    return { isolated: false, home: null, reason: "kill-switch (OCP_SPAWN_REAL_HOME=1)" };
  }
  let hasToken = false;
  try { hasToken = !!(getOAuthCredentials()?.accessToken); } catch { hasToken = false; }
  if (hasToken) return { isolated: true, home: SPAWN_HOME_DIR, reason: "oauth token resolved" };
  return { isolated: false, home: null, reason: "no oauth token resolvable" };
}

// FIX F6: re-verify the scratch HOME exists before each isolated spawn and re-create it if it was
// deleted at runtime (it used to be prepared once at startup, so a runtime deletion made every
// isolated spawn fail ENOENT until restart). mkdirSync is recursive+idempotent → cheap to re-run.
function ensureSpawnHome(dir = SPAWN_HOME_DIR) {
  if (!existsSync(`${dir}/.claude`)) prepareSpawnHome(dir);
}

// Resolve a FRESH OAuth access token for an isolated spawn. Read-only (keychain / credentials.json
// / env) — NEVER refreshes/rotates (see getSpawnHomeMode note). Returns null if none resolvable OR
// if a known expiry is within the 5-min buffer (isTokenExpiring): a null return makes the caller
// fall back to real HOME, where the spawned claude refreshes the credential natively and self-heals
// (the keychain token is then fresh again → next spawn is fast). The env-token path (Linux) carries
// no expiresAt → never expiry-gated (those tokens are long-lived).
function resolveSpawnToken() {
  try {
    const creds = getOAuthCredentials();
    if (!creds?.accessToken) return null;
    if (isTokenExpiring(creds)) return null; // 5-min buffer; applied to the CACHED creds every use
    return creds.accessToken;
  } catch { return null; }
}

// FIX F3 (2026-07-07): serializes ONLY the real-HOME fallback spawns. Isolated spawns (the common
// fast path) never touch this mutex.
const realHomeFallbackMutex = createSerialMutex();

// Resolve the EFFECTIVE per-spawn HOME/token decision. Returns
//   { isolated, home, token, releaseFallback }
// `releaseFallback` is non-null ONLY for a real-HOME fallback holder — the caller MUST call it on
// spawn teardown (wired into cleanup()); it releases the serialization mutex. It is null (no-op)
// for isolated and stable real-HOME (kill-switch / no-token) spawns.
//
// This is async so the real-HOME fallback can `await` the mutex; the keychain reads inside stay
// synchronous (F5 keeps the call sites off async conversion).
async function resolveSpawnDecision() {
  const shm = getSpawnHomeMode();
  if (!shm.isolated) return { isolated: false, home: null, token: null, releaseFallback: null };
  const token = resolveSpawnToken();
  if (token) {
    ensureSpawnHome(shm.home);
    return { isolated: true, home: shm.home, token, releaseFallback: null };
  }
  // Token is present but within the 5-min expiry window → we would fall back to real HOME, where
  // the spawned claude refreshes the credential natively. HAZARD PREVENTED: without serialization,
  // every concurrent -p spawn inside this window runs claude under the real HOME simultaneously,
  // and each spawned claude races a `refresh_token` grant against the SAME single-use refresh
  // token — rotating it out from under the others AND the operator's own real claude (the
  // credential-fork hazard; #112 / #146 class). Serialize: admit ONE real-HOME spawn at a time.
  // When the next waiter is admitted (the prior holder torn down → its claude has had its lifetime
  // to refresh the keychain), re-run resolveSpawnToken(): a now-fresh token means we proceed
  // ISOLATED and release the mutex immediately, so the queue drains to the fast path instead of
  // piling every request into the real HOME.
  const release = await realHomeFallbackMutex.acquire();
  try {
    // Drop the 30s keychain TTL cache so the re-check reads FRESH keychain state — otherwise a
    // waiter admitted right after the prior holder's claude refreshed the token could still see the
    // stale (expiring) cached creds and needlessly fall back to real HOME again for up to ~30s.
    invalidateKeychainReadCache();
    const retry = resolveSpawnToken();
    if (retry) {
      release();
      ensureSpawnHome(shm.home);
      return { isolated: true, home: shm.home, token: retry, releaseFallback: null };
    }
  } catch (e) {
    release();
    throw e;
  }
  return { isolated: false, home: null, token: null, releaseFallback: release };
}

// ── FIX ⑥ (concurrency): bounded wait-queue for the -p / stream-json path ──────────────
// PROBLEM (proven): spawnClaudeProcess used `if (activeRequests >= MAX_CONCURRENT) throw` →
// the client got an opaque 500 AND the rejection was NOT counted in stats (a 15-concurrent
// stress run returned 7×500 while /health stats.errors stayed 0). The TUI path already has a
// bounded-queue semaphore (TuiSemaphore); the -p path did not.
//
// FIX: requests beyond MAX_CONCURRENT WAIT on this semaphore (up to CLAUDE_MAX_QUEUE) instead of
// being rejected. Only when the queue is ALSO full do we reject — with HTTP 429 + Retry-After
// (deterministic backpressure), a distinct `concurrency_queue_full` log, and a stats.queueRejections
// counter that shows up on /health. The slot is released on EVERY exit path via the existing
// idempotent cleanup() (proc exit/close/error/timeout) — the #37/#40 slot-leak guard.
const claudeSemaphore = new TuiSemaphore(MAX_CONCURRENT, { maxQueue: CLAUDE_MAX_QUEUE });

// Tagged error so callers can map this single overflow case to HTTP 429 (every OTHER throw stays
// a 500). Carries retryAfter for the Retry-After header.
class ConcurrencyOverflowError extends Error {
  constructor(message) { super(message); this.name = "ConcurrencyOverflowError"; this.httpStatus = 429; this.retryAfter = CLAUDE_QUEUE_RETRY_AFTER; }
}

// Acquire a -p concurrency slot, queuing if all are busy (up to CLAUDE_MAX_QUEUE). Resolves to a
// release() fn that MUST be called exactly once on every exit path (wired into ctx.cleanup()).
// Rejects with ConcurrencyOverflowError when the wait-queue is full. Increments stats.queued while
// waiting (decremented on acquire) and stats.queueRejections on overflow.
async function acquireClaudeSlot() {
  stats.queued = claudeSemaphore.queued + 1; // reflect this waiter before we (maybe) block
  try {
    await claudeSemaphore.acquire();
  } catch (e) {
    stats.queued = claudeSemaphore.queued;
    stats.queueRejections++;
    logEvent("warn", "concurrency_queue_full", {
      limit: claudeSemaphore.limit, maxQueue: claudeSemaphore.maxQueue,
      inflight: claudeSemaphore.inflight, queued: claudeSemaphore.queued,
    });
    throw new ConcurrencyOverflowError(
      `backpressure: concurrency limit (${claudeSemaphore.limit}) reached and wait queue ` +
      `(${claudeSemaphore.maxQueue}) is full — retry shortly`);
  }
  stats.queued = claudeSemaphore.queued;
  let released = false;
  return function releaseClaudeSlot() {
    if (released) return; // idempotent — cleanup() may be reached via multiple proc events
    released = true;
    claudeSemaphore.release();
    stats.queued = claudeSemaphore.queued;
  };
}

// SECURITY fail-loud: TUI-mode is incompatible with any configuration that allows
// non-operator prompts to reach the interactive claude session. Three cases:
//   1. AUTH_MODE=multi — guest/anonymous keys can submit prompts.
//   2. a non-loopback BIND_ADDRESS — server is network-exposed; any reachable peer
//      can send prompts unless per-request trust is in place. Override with
//      OCP_TUI_ALLOW_LAN=1 ONLY if you have a separate network-layer trust (firewall, VPN).
//   3. PROXY_ANONYMOUS_KEY set — anonymous callers can submit prompts without a key.
// In all three cases TUI runs interactive claude with the OPERATOR's full filesystem
// access — home is NOT isolation. Refuse to boot. See ADR 0007.
if (TUI_MODE && AUTH_MODE === "multi") {
  console.error(
    "FATAL: CLAUDE_TUI_MODE=true is incompatible with CLAUDE_AUTH_MODE=multi.\n" +
    "  TUI runs interactive claude with the operator's filesystem access, so a guest/anonymous\n" +
    "  prompt could read operator data. TUI-mode is single-user only until B-path isolation lands.\n" +
    "  See docs/adr/0007-tui-interactive-mode.md. Refusing to start."
  );
  process.exit(1);
}
if (TUI_MODE && !isLoopbackBind(BIND_ADDRESS) && process.env.OCP_TUI_ALLOW_LAN !== "1") {
  console.error(
    `FATAL: CLAUDE_TUI_MODE=true with a non-loopback CLAUDE_BIND (${BIND_ADDRESS}) is unsafe.\n` +
    "  TUI runs interactive claude with operator filesystem access; network-exposed without\n" +
    "  per-request isolation means any reachable peer could drive the operator's claude session.\n" +
    "  Either bind to 127.0.0.1 (default) or set OCP_TUI_ALLOW_LAN=1 if you have a\n" +
    "  separate network-layer trust (firewall/VPN). See docs/adr/0007-tui-interactive-mode.md."
  );
  process.exit(1);
}
if (TUI_MODE && PROXY_ANONYMOUS_KEY) {
  console.error(
    "FATAL: CLAUDE_TUI_MODE=true with PROXY_ANONYMOUS_KEY set is unsafe.\n" +
    "  TUI runs interactive claude with operator filesystem access; anonymous callers\n" +
    "  could drive the operator's claude session without a named key.\n" +
    "  Remove PROXY_ANONYMOUS_KEY or disable TUI-mode. See docs/adr/0007-tui-interactive-mode.md."
  );
  process.exit(1);
}

if (PROXY_ANONYMOUS_KEY && AUTH_MODE !== "multi") {
  console.warn("WARNING: PROXY_ANONYMOUS_KEY is set but AUTH_MODE is not 'multi' — anonymous key will be ignored");
}

if (AUTH_MODE === "shared" && !PROXY_API_KEY) {
  console.warn("WARNING: AUTH_MODE=shared but PROXY_API_KEY is not set — all requests will pass unauthenticated");
}

const VERSION = _pkg.version;
const START_TIME = Date.now();

// ── Structured logging helper ───────────────────────────────────────────
function logEvent(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  if (level === "error" || level === "warn") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ── Startup file-mode reconciliation ───────────────────────────────────
// Idempotently tightens OCP credential-bearing files to 700/600 so that
// existing installs (created before this fix) are hardened on next restart.
// Wrapped in try/catch — chmod failure must never crash startup.
// Does NOT touch systemd units or launchd plists; those are managed by setup.mjs.
function _tightenFileModesIfPossible() {
  const ocpDir = join(homedir(), ".ocp");
  const targets = [
    { path: ocpDir,                      mode: 0o700, label: "~/.ocp (dir)" },
    { path: join(ocpDir, "admin-key"),   mode: 0o600, label: "~/.ocp/admin-key" },
    { path: join(ocpDir, "ocp.db"),      mode: 0o600, label: "~/.ocp/ocp.db" },
  ];
  let tightened = 0;
  let alreadyOk = 0;
  for (const { path, mode, label } of targets) {
    try {
      const st = statSync(path);
      const current = st.mode & 0o777;
      if (current !== mode) {
        chmodSync(path, mode);
        tightened++;
      } else {
        alreadyOk++;
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        // File exists but chmod failed (e.g. EPERM) — log and move on
        logEvent("warn", "file_mode_tighten_failed", { path: label, error: e.message });
      }
      // ENOENT is fine — file doesn't exist yet
    }
  }
  if (tightened > 0) {
    logEvent("info", "file_modes_tightened", { tightened, alreadyOk });
  }
}
_tightenFileModesIfPossible();

// ── Circuit breaker (DISABLED) ──────────────────────────────────────────
// Disabled: CLI proxy has its own retry logic, and the breaker was causing
// cascading failures — once API got briefly slow, ALL agents lost connectivity
// for 120s+ due to the breaker rejecting every request.
// The timeout/failure tracking stubs below are kept as no-ops so callers
// don't need to be changed.
function breakerRecordSuccess(_cliModel) {}
function breakerRecordTimeout(_cliModel) {}
function getBreakerState(_cliModel) { return { state: "closed" }; }
function getBreakerSnapshot() { return { _note: "circuit breaker disabled" }; }

// Legacy constants kept for /health display
const _BREAKER_DISABLED_NOTE = "disabled";
/* Original breaker code removed — see git history for v2.5.0 implementation.
   Re-enable by reverting this block if needed in the future.
   Reason for disabling: CLI-proxy architecture means each request spawns a
   fresh claude process. The breaker was designed for persistent API connections
   where a degraded backend benefits from back-off. With CLI spawning, timeouts
   are usually transient (API load, large prompts) and the breaker's 120s+
   cooldown with graduated backoff made things worse, not better.
*/


// ── Model mapping ───────────────────────────────────────────────────────
// Maps request model IDs and aliases to canonical claude CLI model IDs.
// Derived from models.json (single source of truth).
const MODEL_MAP = Object.fromEntries([
  ...modelsConfig.models.map(m => [m.id, m.id]),
  ...Object.entries(modelsConfig.aliases),
  ...Object.entries(modelsConfig.legacyAliases),
]);

const MODELS = modelsConfig.models.map(m => ({ id: m.id, name: m.displayName }));

// ── Session management ──────────────────────────────────────────────────
// Maps namespaced session keys to Claude CLI session UUIDs.
// Key format: "${keyName}|${conversationId}" — prevents cross-key collision
// when two callers (different API keys or anon + authenticated) use the same
// session_id string. Anonymous callers use "anon"; admin uses "admin".
// Enables --resume for multi-turn conversations, reducing token waste.
const sessions = new Map(); // `${keyName}|${conversationId}` → { uuid, messageCount, lastUsed, model }

// Build the namespaced key used for all sessions Map operations.
// Returns null when conversationId is falsy (one-off requests bypass session tracking).
function _sessionKey(conversationId, keyName) {
  return conversationId ? `${keyName || "anon"}|${conversationId}` : null;
}

const sessionCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const idleMs = now - s.lastUsed;
    const ageMs = s.firstSeen ? now - s.firstSeen : null;
    // id is "${keyName}|${conversationId}"; strip prefix for log output
    const convIdShort = id.includes("|") ? id.slice(id.indexOf("|") + 1, id.indexOf("|") + 13) : id.slice(0, 12);
    if (idleMs > SESSION_TTL) {
      sessions.delete(id);
      console.log(`[session] expired ${convIdShort}... (idle ${Math.round(idleMs / 60000)}m)`);
      logEvent("info", "session_expired", { conversationId: convIdShort + "...", idleMs, ageMs });
    } else if (ageMs !== null && ageMs > 4 * SESSION_TTL) {
      // #42 evidence-gathering: a session whose firstSeen is more than 4× TTL old
      // but whose lastUsed keeps getting bumped (never idle long enough to expire)
      // is the suspected bug. Log without action so the pattern can be confirmed
      // in /logs. Do NOT enforce an absolute age cap here speculatively.
      logEvent("warn", "session_long_lived", { conversationId: convIdShort + "...", idleMs, ageMs });
    }
  }
}, 60000);

// Cache cleanup: remove expired entries every 10 minutes
const cacheCleanupInterval = setInterval(() => {
  if (CACHE_TTL > 0) {
    try {
      const cleaned = clearCache(CACHE_TTL);
      if (cleaned > 0) logEvent("info", "cache_cleanup", { expired: cleaned });
    } catch (e) { logEvent("error", "cache_cleanup_failed", { error: e.message }); }
  }
}, 600000);

// TUI defunct-session reap (periodic): the boot reap (below) only fires once, but a
// long-lived host (PI231 ran 30 days without restart) accumulates defunct `<claude>`
// zombies between restarts — the pane's claude is a child of the tmux server, not node,
// so only the server can reap it (see reapStaleTuiSessions). We sweep every 15 min, but
// ONLY when the TUI path is fully idle: reapStaleTuiSessions may `kill-server`, which would
// tear down a live turn's pane, so we skip the sweep while any turn is inflight or queued.
// RESIDUAL (documented, accepted): a brand-new request whose pane is created in the narrow
// window between this idle-check and kill-server would have its pane torn down and fail the
// turn cleanly via runTuiTurn's existing honesty gates (rare; the boot reap is the primary
// mechanism and the 15-min cadence makes the window negligible).
// Gated on TUI_MODE — zero effect (no kill-server, no list-sessions) when TUI is off.
// cli.js does NOT perform this operation (Class B, OCP-owned TUI spawn) — see ADR 0007.
const TUI_REAP_INTERVAL_MS = 15 * 60 * 1000;
const tuiReapInterval = TUI_MODE ? setInterval(() => {
  if (tuiSemaphore.inflight > 0 || tuiSemaphore.queued > 0) return; // a turn is live — defer
  try {
    // F7 fix: scope to THIS instance's own port; a sibling ocp-tui-<otherPort>-* session
    // (a second OCP instance on the same host) is treated as foreign, same as olp-tui-*.
    // includeLegacy is NOT set here — see reapStaleTuiSessions' comment: the periodic sweep
    // conservatively treats any lingering bare-prefix legacy session as foreign so it can
    // never trigger kill-server on a steady-state tick; only the one-time boot reap below
    // claims legacy-shaped zombies.
    const n = reapStaleTuiSessions({ port: PORT });
    if (n) logEvent("info", "tui_reaped_stale_sessions", { count: n, trigger: "periodic" });
  } catch (e) { logEvent("error", "tui_periodic_reap_failed", { error: e.message }); }
}, TUI_REAP_INTERVAL_MS) : null;
if (tuiReapInterval && typeof tuiReapInterval.unref === "function") tuiReapInterval.unref();

// ── Active child process tracking ────────────────────────────────────────
const activeProcesses = new Set();

// ── Stats & diagnostics ─────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  activeRequests: 0,
  errors: 0,
  timeouts: 0,
  sessionHits: 0,
  sessionMisses: 0,
  oneOffRequests: 0,
  queued: 0,           // current requests waiting for a -p concurrency slot (FIX ⑥)
  queueRejections: 0,  // total requests rejected with HTTP 429 because the wait-queue was full (FIX ⑥)
};
const recentErrors = []; // last 20 errors

// Per-model request stats
const modelStats = new Map(); // cliModel → { requests, errors, timeouts, totalElapsed, maxElapsed, totalPromptChars, maxPromptChars }

function getModelStats(cliModel) {
  if (!modelStats.has(cliModel)) {
    modelStats.set(cliModel, {
      requests: 0, successes: 0, errors: 0, timeouts: 0,
      totalElapsed: 0, maxElapsed: 0,
      totalPromptChars: 0, maxPromptChars: 0,
    });
  }
  return modelStats.get(cliModel);
}

function recordModelRequest(cliModel, promptChars) {
  const m = getModelStats(cliModel);
  m.requests++;
  m.totalPromptChars += promptChars;
  if (promptChars > m.maxPromptChars) m.maxPromptChars = promptChars;
}

function recordModelSuccess(cliModel, elapsedMs) {
  const m = getModelStats(cliModel);
  m.successes++;
  m.totalElapsed += elapsedMs;
  if (elapsedMs > m.maxElapsed) m.maxElapsed = elapsedMs;
}

function recordModelError(cliModel, isTimeout) {
  const m = getModelStats(cliModel);
  m.errors++;
  if (isTimeout) m.timeouts++;
}

function getModelStatsSnapshot() {
  const result = {};
  for (const [model, m] of modelStats) {
    result[model] = {
      requests: m.requests,
      successes: m.successes,
      errors: m.errors,
      timeouts: m.timeouts,
      avgElapsed: m.successes > 0 ? Math.round(m.totalElapsed / m.successes) : 0,
      maxElapsed: m.maxElapsed,
      avgPromptChars: m.requests > 0 ? Math.round(m.totalPromptChars / m.requests) : 0,
      maxPromptChars: m.maxPromptChars,
    };
  }
  return result;
}

function trackError(msg) {
  stats.errors++;
  recentErrors.push({ time: new Date().toISOString(), message: String(msg).slice(0, 200) });
  if (recentErrors.length > 20) recentErrors.shift();
}

// ── Auth health check ───────────────────────────────────────────────────
let authStatus = { ok: null, lastCheck: 0, message: "" };

async function checkAuth() {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    execFileSync(CLAUDE, ["auth", "status"], { encoding: "utf8", timeout: 10000, env });
    authStatus = { ok: true, lastCheck: Date.now(), message: "authenticated" };
  } catch (e) {
    const msg = (e.stderr || e.message || "").slice(0, 200);
    authStatus = { ok: false, lastCheck: Date.now(), message: msg };
    console.error(`[auth] check failed: ${msg}`);
  }
}

// Check auth on start and every 10 minutes
checkAuth();
const authCheckInterval = setInterval(checkAuth, 600000);

// ── Build CLI arguments ─────────────────────────────────────────────────
// Phase 6c port (2026-05-30): removed `-p` / `--output-format text`.
// Now uses `--output-format stream-json --verbose --no-session-persistence
// --system-prompt <OCP_SYSTEM_PROMPT_WRAPPER + client system messages>`.
//
// Authority: claude CLI § --output-format stream-json, § --verbose,
//   § --no-session-persistence, § --system-prompt (ported from OLP, verified v2.1.104;
//   behavior stable through v2.1.158).
// Reference: OLP ADR 0009 Amendment 1 + commit 97e7d16.
//
// Session flags (--resume, --session-id) are dropped: they are incompatible
// with stream-json mode without -p. OCP always passes full conversation context
// via stdin instead (messagesToPrompt), preserving multi-turn correctness.
// CLAUDE_SYSTEM_PROMPT env var is absorbed into the system prompt via
// extractSystemPrompt() at the caller level; APPEND_SYSTEM_PROMPT no longer used.
// Note: ALLOWED_TOOLS / SKIP_PERMISSIONS / MCP_CONFIG are preserved as before.
function buildCliArgs(cliModel, systemPrompt) {
  const args = [
    "--model", cliModel,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--system-prompt", systemPrompt,
  ];

  // Permissions
  // ADR 0007 B-path: in multi-tenant mode, suppress operator-FS tools so a guest
  // prompt cannot drive Bash/Read/Write/Edit/etc. on the operator's filesystem.
  // For AUTH_MODE !== "multi" (none/shared — single-operator/trusted), preserve
  // existing behaviour unchanged.
  if (AUTH_MODE === "multi") {
    // Disallow the full operator-FS + web + agent surface. "--disallowedTools" may
    // be repeated; claude accepts multiple occurrences (TUI path already uses it).
    args.push(
      "--disallowedTools", "Bash",
      "--disallowedTools", "Read",
      "--disallowedTools", "Write",
      "--disallowedTools", "Edit",
      "--disallowedTools", "Glob",
      "--disallowedTools", "Grep",
      "--disallowedTools", "WebFetch",
      "--disallowedTools", "WebSearch",
      "--disallowedTools", "Agent",
      "--disallowedTools", "mcp__*",
    );
    // Do NOT push --allowedTools in multi mode.
  } else if (SKIP_PERMISSIONS) {
    args.push("--dangerously-skip-permissions");
  } else if (ALLOWED_TOOLS.length > 0) {
    args.push("--allowedTools", ...ALLOWED_TOOLS);
  }

  // MCP config
  if (MCP_CONFIG) {
    args.push("--mcp-config", MCP_CONFIG);
  }

  return args;
}

// ── Format messages to prompt text ──────────────────────────────────────
// Truncation guard: if total chars exceed MAX_PROMPT_CHARS, keep the system
// message(s) + first user message + last N messages, dropping the middle.
// This prevents runaway context from gateway-side conversation accumulation.
let MAX_PROMPT_CHARS = parseInt(process.env.CLAUDE_MAX_PROMPT_CHARS || "150000", 10);

// Flatten OpenAI content (string | array of parts) to plain text for the prompt.
// Array content: concatenate text parts; replace non-text parts (e.g. image_url)
// with a placeholder rather than dumping raw JSON. (issue #110)
function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p =>
      p && p.type === "text" && typeof p.text === "string" ? p.text : "[non-text content omitted]"
    ).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function messagesToPrompt(messages) {
  const full = messages.map((m) => {
    const text = contentToText(m.content);
    if (m.role === "system") return `[System] ${text}`;
    if (m.role === "assistant") return `[Assistant] ${text}`;
    return text;
  });

  const joined = full.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;

  // Truncation: keep system messages, first user msg, and trim from the tail
  logEvent("warn", "prompt_truncated", {
    originalChars: joined.length,
    maxChars: MAX_PROMPT_CHARS,
    originalMessages: messages.length,
  });

  const system = [];
  const rest = [];
  for (let i = 0; i < full.length; i++) {
    if (messages[i].role === "system") system.push(full[i]);
    else rest.push(full[i]);
  }

  // Keep system + as many recent messages as fit
  const systemText = system.join("\n\n");
  const budget = MAX_PROMPT_CHARS - systemText.length - 200; // 200 for separator
  const kept = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (used + rest[i].length + 2 > budget) break;
    kept.unshift(rest[i]);
    used += rest[i].length + 2;
  }

  const truncNote = `[System] Note: ${rest.length - kept.length} older messages were truncated to fit context limit.`;
  const result = [systemText, truncNote, ...kept].filter(Boolean).join("\n\n");

  logEvent("info", "prompt_after_truncation", {
    chars: result.length,
    keptMessages: kept.length,
    droppedMessages: rest.length - kept.length,
  });

  return result;
}

// Model tier — used for logging only (no timeout logic).
function getModelTier(cliModel) {
  if (cliModel.includes("opus")) return "opus";
  if (cliModel.includes("haiku")) return "haiku";
  return "sonnet";
}

// ── Spawn claude CLI (shared setup) ─────────────────────────────────────
// Builds CLI args, spawns the process, and sets up timeouts.
// Returns context object or throws synchronously.
//
// Phase 6c port (2026-05-30): session resume (--resume / --session-id) is
// dropped because it is incompatible with stream-json mode without -p.
// OCP now always passes the full serialized conversation via stdin
// (messagesToPrompt), so multi-turn correctness is preserved without sessions.
// The sessions Map is retained for stats/logging but no longer drives --resume.
// Reference: OLP ADR 0009 Amendment 1 + commit 97e7d16.
// FIX ⑥: concurrency is now bounded by the claudeSemaphore via acquireClaudeSlot(), which the
// caller MUST await before calling this, passing the resulting release fn as `releaseSlot`. The
// old `if (activeRequests >= MAX_CONCURRENT) throw` gate (→ opaque 500, uncounted) is GONE: at
// most MAX_CONCURRENT callers hold a slot when they reach here, so this spawn is always within
// budget. releaseSlot is wired into the idempotent cleanup() so the slot is freed on EVERY exit
// path (close/error/timeout/abort). Back-compat: releaseSlot defaults to a no-op so any future
// internal caller that does its own gating still works.
function spawnClaudeProcess(model, messages, conversationId, keyName, releaseSlot = () => {}, spawnDecision = null) {
  const cliModel = MODEL_MAP[model] || model;

  // Circuit breaker: disabled (see comment at top of breaker section)

  stats.activeRequests++;
  stats.totalRequests++;

  // Phase 6c: always serialize full conversation via stdin (no session resume).
  // System messages are extracted and passed via --system-prompt; the remaining
  // messages (user/assistant/tool) are serialized by messagesToPrompt.
  const systemPrompt = extractSystemPrompt(messages);

  // messagesToPrompt skips system messages now that they go via --system-prompt.
  // Filter them out before calling to avoid double-injection.
  const nonSystemMessages = messages.filter(m => m.role !== "system");
  const prompt = messagesToPrompt(nonSystemMessages);

  stats.oneOffRequests++;
  if (conversationId) {
    console.log(`[session] stateless conv=${conversationId.slice(0, 12)}... key=${keyName || "anon"} msgs=${messages.length} prompt_chars=${prompt.length}`);
  }

  const cliArgs = buildCliArgs(cliModel, systemPrompt);

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;

  // Pure API mode: suppress Claude Code context injection while preserving OAuth auth
  if (NO_CONTEXT) {
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }

  // FIX ③ (latency) + F3 (concurrency): apply the pre-resolved per-spawn HOME/token decision.
  // The decision is resolved ASYNC in the caller (resolveSpawnDecision) so the real-HOME fallback
  // serialization can await its mutex; here we only apply the result. When isolated, run claude
  // under a credential-free minimal HOME with cwd = that same neutral dir, so it loads NONE of the
  // operator's global ~/.claude (plugins/skills/hooks) or the ~/ocp project CLAUDE.md/skills — the
  // measured 10–28s → 3–7s latency win. The env token is authoritative for `-p` (unlike
  // interactive claude). When no fresh token is resolvable, decision.isolated is false → real HOME
  // + inherited cwd (zero regression), and the spawned claude resolves+refreshes credentials
  // natively. The DISABLE_CLAUDE_MDS / AUTO_MEMORY flags are set unconditionally in isolated mode
  // (belt-and-braces; mirrors the TUI path).
  const decision = spawnDecision || { isolated: false, releaseFallback: null };
  const spawnOpts = { env, stdio: ["pipe", "pipe", "pipe"] };
  if (decision.isolated && decision.token) {
    env.HOME = decision.home;
    env.CLAUDE_CODE_OAUTH_TOKEN = decision.token; // env token is authoritative for -p
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    spawnOpts.cwd = decision.home; // neutral cwd: no project CLAUDE.md/skills
  }

  const proc = spawn(CLAUDE, cliArgs, spawnOpts);
  activeProcesses.add(proc);

  const t0 = Date.now();
  let gotFirstByte = false;
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(overallTimer);
    stats.activeRequests--;
    // FIX ⑥: free the concurrency slot for a queued waiter. releaseSlot is itself idempotent,
    // and cleanup() is guarded by `cleaned`, so the slot is released exactly once on the first
    // exit path reached (proc 'exit' fires before 'close'; 'error' covers spawn failure).
    try { releaseSlot(); } catch { /* never let release throw out of cleanup */ }
    // F3: release the real-HOME fallback serialization mutex (no-op for isolated/normal spawns).
    // By now this spawn's claude has had its lifetime to refresh the keychain token, so the next
    // queued fallback waiter re-checks resolveSpawnToken() and proceeds ISOLATED with the now-fresh
    // token instead of piling into the real HOME. Idempotent; cleanup() is guarded by `cleaned`.
    try { if (decision.releaseFallback) decision.releaseFallback(); } catch { /* never throw out of cleanup */ }
  }

  // Guarantee slot release on ANY exit path (normal close, error, timeout kill,
  // SIGKILL escalation). The 'exit' event fires before 'close' and runs even
  // if stdio pipes stay open. Fixes #37: the timeout path called
  // proc.kill('SIGTERM') without decrementing the concurrency counter, so a
  // stuck subprocess that ignored SIGTERM could leak its slot until (or
  // beyond) the SIGKILL escalation actually reaped it. cleanup() is idempotent
  // so this listener is safe alongside the existing 'close'/'error' paths.
  proc.once("exit", cleanup);

  function handleSessionFailure() {
    // Phase 6c: session resume (--resume/--session-id) is no longer used;
    // OCP always passes full context via stdin. No session state to clean up.
    if (conversationId) {
      logEvent("warn", "session_failure", { mode: "stateless", conversationId: conversationId.slice(0, 12) + "...", action: "none" });
    }
  }

  function markFirstByte() {
    if (!gotFirstByte) {
      gotFirstByte = true;
      console.log(`[claude] first-byte model=${cliModel} elapsed=${Date.now() - t0}ms`);
    }
  }

  // Guard stdin writes against EPIPE (child may close stdin before we finish
  // writing, e.g. early exit on bad model). The ChildProcess "error" event is on
  // the spawned process, NOT on the stdin Writable — it does not catch this.
  proc.stdin.on("error", (e) => logEvent("warn", "stdin_write_error", { error: e.message }));

  // Write prompt to stdin immediately
  proc.stdin.write(prompt);
  proc.stdin.end();

  recordModelRequest(cliModel, prompt.length);
  logEvent("info", "claude_spawned", { model: cliModel, promptChars: prompt.length, timeout: TIMEOUT, tier: getModelTier(cliModel), session: conversationId ? conversationId.slice(0, 12) + "..." : "none" });

  // Single request timeout — no separate first-byte timer.
  // Claude tool-use causes long pauses in the token stream (30s-5min),
  // making first-byte/idle timeouts unreliable. One generous timeout is simpler and correct.
  const overallTimer = setTimeout(() => {
    if (!cleaned) {
      stats.timeouts++;
      recordModelError(cliModel, true);
      breakerRecordTimeout(cliModel);
      logEvent("error", "request_timeout", { model: cliModel, timeoutMs: TIMEOUT, elapsed: Date.now() - t0 });
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
    }
  }, TIMEOUT);

  // Clear ONLY the request timer (not the slot accounting) when the response has
  // semantically completed (result/[DONE]) but the child hasn't exited yet — prevents
  // a spurious post-success timeout. cleanup() (on exit) still clears it idempotently. (issue #111)
  function clearOverallTimer() { clearTimeout(overallTimer); }

  return { proc, cliModel, conversationId, t0, cleanup, clearOverallTimer, handleSessionFailure, markFirstByte };
}

// ── Call claude CLI (non-streaming) ─────────────────────────────────────
// On-demand spawning: each request spawns a fresh claude process.
// No pool = no crash loops, no stale workers, no degraded states.
// Stdin is written immediately so there's no 3s stdin timeout issue.
//
// Phase 6c port (2026-05-30): stdout is now NDJSON (stream-json format).
// We accumulate full text across all content_block_delta events plus the
// assistant-aggregate fallback, then resolve with the assembled string.
// Reference: OLP ADR 0009 Amendment 1 + commit 97e7d16.
async function callClaude(model, messages, conversationId, keyName) {
  // FIX ⑥: acquire a concurrency slot first (queues up to CLAUDE_MAX_QUEUE; rejects with a
  // ConcurrencyOverflowError → 429 when the queue is full). The release fn is passed into the
  // spawn so the idempotent cleanup() frees it on every exit path. If the spawn itself throws
  // synchronously (before cleanup is wired), release here so the slot never leaks.
  const releaseSlot = await acquireClaudeSlot();
  // F3: resolve the per-spawn HOME/token decision (may serialize on the real-HOME fallback mutex).
  const spawnDecision = await resolveSpawnDecision();
  return new Promise((resolve, reject) => {
    let ctx;
    try {
      ctx = spawnClaudeProcess(model, messages, conversationId, keyName, releaseSlot, spawnDecision);
    } catch (err) {
      releaseSlot();
      // Spawn threw before cleanup() was wired → release the fallback mutex here so it never leaks.
      try { spawnDecision.releaseFallback?.(); } catch { /* best effort */ }
      return reject(err);
    }

    const { proc, cliModel, conversationId: convId, t0, cleanup, handleSessionFailure, markFirstByte } = ctx;
    let lineBuffer = "";
    let assembledText = "";
    let isFirstDelta = true;
    let resultEventSeen = false;
    let stderr = "";

    proc.stdout.on("data", (d) => {
      markFirstByte();
      lineBuffer += d.toString();
      const { events, remainder } = parseStreamJsonLines(lineBuffer);
      lineBuffer = remainder;
      for (const event of events) {
        const parsed = parseStreamJsonEvent(event, isFirstDelta);
        if (!parsed) continue;
        if (parsed.text !== undefined) {
          assembledText += parsed.text;
          isFirstDelta = false;
        } else if (parsed.stop) {
          resultEventSeen = true;
        } else if (parsed.error) {
          // is_error result — treat as process error
          reject(new Error(String(parsed.error)));
        }
      }
    });
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code, signal) => {
      activeProcesses.delete(proc);
      const elapsed = Date.now() - t0;
      cleanup();
      // Tolerate null exit code when result event was seen (sandbox-wrap noise, same
      // as OLP commit 2864275 — bwrap shell exits null after model completes).
      if (code !== 0 && !resultEventSeen) {
        recordModelError(cliModel, false);
        logEvent("error", "claude_exit", { model: cliModel, code, signal: signal || "none", elapsed, stderr: stderr.slice(0, 300) });
        trackError(stderr.slice(0, 300) || assembledText.slice(0, 300) || `claude exit ${code}`);
        handleSessionFailure();
        reject(new Error(stderr.slice(0, 300) || assembledText.slice(0, 300) || `claude exit ${code}`));
      } else {
        recordModelSuccess(cliModel, elapsed);
        breakerRecordSuccess(cliModel);
        logEvent("info", "claude_ok", { model: cliModel, chars: assembledText.length, elapsed, session: convId ? convId.slice(0, 12) + "..." : "none" });
        resolve(assembledText);
      }
    });

    proc.on("error", (err) => {
      console.error(`[claude] spawn error: ${err.message}`);
      cleanup();
      trackError(err.message);
      handleSessionFailure();
      reject(err);
    });
  });
}

// ── TUI-mode upstream (interactive claude, cc_entrypoint=cli) ───────────
// Drop-in replacement for callClaude when TUI_MODE is ON.
// Same signature and Promise<string> contract so all downstream
// (singleflight → setCachedResponse → completionResponse) is unchanged.
// System messages are rendered inline as [System] blocks by messagesToPrompt;
// we deliberately do NOT pass --system-prompt in interactive mode to avoid any
// flag that could perturb cc_entrypoint classification.
// Authority: claude CLI v2.1.158 interactive mode (cc_entrypoint=cli).
// SECURITY: A-path single-user ONLY — home is NOT isolation (see ADR 0007).
function callClaudeTui(model, messages, _conversationId, _keyName) {
  const cliModel = MODEL_MAP[model] || model;
  const prompt = messagesToPrompt(messages); // includes system as [System] inline
  recordModelRequest(cliModel, prompt.length);
  // C-4: gate the heavy interactive boot behind the TUI semaphore. run() acquires a slot
  // (queuing if all are busy, up to maxQueue), then releases in a finally so any throw from
  // runTuiTurn (tmux spawn failure, paste-not-landed) OR from the honesty gates below
  // (truncation / error banner) can NEVER leak a slot. tuiSemaphore.inflight feeds /health.
  return tuiSemaphore.run(() => runTuiTurn({
    prompt,
    model: cliModel,
    claudeBin: CLAUDE,
    home: TUI_HOME,
    realHome: process.env.HOME,
    cwd: TUI_CWD,
    port: PORT, // F7 fix: port-scopes the tmux session name so a sibling OCP instance on a
                // different port never collides with this instance's reap/kill-server logic.
    wallclockMs: TUI_WALLCLOCK_MS,
    entrypointMode: TUI_ENTRYPOINT,
  }).then(({ text, entrypoint, truncated }) => {
    // ── Honesty gates (issue #133) ─ run BEFORE recordModelSuccess / cache write-back.
    // A throw here propagates to the .catch below (recordModelError + reject), so the
    // result never reaches the downstream setCachedResponse / singleflight / SUCCESS path.

    // C-2: the wall-clock cap hit with partial text and NO terminal marker — the turn
    // is INCOMPLETE. Returning the cut-off prefix would cache it and report it as
    // finish_reason:stop (a truncated answer served as a complete one). Reject instead.
    if (truncated) {
      logEvent("error", "tui_wallclock_truncated", { model: cliModel, chars: (text || "").length, wallclockMs: TUI_WALLCLOCK_MS });
      throw new Error("tui_wallclock_truncated: turn hit the wall-clock cap before completing; partial text dropped");
    }

    // C-1: the interactive claude CLI renders in-session errors (expired/invalid
    // credentials, transient API failure) as ordinary assistant text. Returning that
    // banner would cache an error AS an answer and record a model SUCCESS. Detect a
    // known error banner (anchored whole-text match — see detectTuiUpstreamError) and
    // reject so it does NOT enter the cache and the client gets a 5xx.
    const banner = detectTuiUpstreamError(text);
    if (banner) {
      logEvent("error", "tui_upstream_error", { model: cliModel, banner: banner.slice(0, 200) });
      throw new Error("tui_upstream_error: claude CLI returned an in-session error banner instead of an answer");
    }

    recordModelSuccess(cliModel, 0); // elapsed not measurable here; wallclock at reader level
    // Assert the subscription-pool classification. TUI exists to keep cc_entrypoint=cli
    // (subscription pool); a silent degrade to sdk-cli (metered Agent SDK pool) would still
    // return text but cost money — warn loudly so it's visible. (issue #115)
    // C-5: also surface the observation on /health. recordTuiEntrypoint sets lastEntrypoint
    // unconditionally (operators can poll it to confirm cli) and increments
    // entrypointMismatches when expected=cli but observed≠cli — the same condition the
    // journald warning already covers — so a silent metered-pool drift is visible on /health
    // without tailing logs.
    if (recordTuiEntrypoint(tuiStats, entrypoint, TUI_ENTRYPOINT)) {
      logEvent("warn", "tui_entrypoint_mismatch", { expected: "cli", got: entrypoint, model: cliModel });
    }
    return text;
  }).catch((err) => {
    recordModelError(cliModel, false);
    throw err;
  }));
}

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

// ── Call claude CLI (real streaming) ─────────────────────────────────────
// Pipes stdout from the claude process as SSE chunks as they arrive.
// Each NDJSON content_block_delta text event becomes one SSE delta.
// TODO(cache-singleflight-stream): streaming-path singleflight is out of scope for v3.13.0; see spec D4 streaming caveat.
//
// Phase 6c port (2026-05-30): stdout is now NDJSON (stream-json format).
// We parse line-by-line and forward content_block_delta text events as SSE.
// The result event triggers the stop/[DONE] sequence.
// Reference: OLP ADR 0009 Amendment 1 + commits 97e7d16, 65f945c.
async function callClaudeStreaming(model, messages, conversationId, res, authInfo = {}) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // FIX ⑥: acquire a concurrency slot first (queues up to CLAUDE_MAX_QUEUE). On overflow, surface
  // HTTP 429 + Retry-After (NOT 500). Release is wired into cleanup() for every exit path; if the
  // spawn throws synchronously before cleanup is wired, release here.
  let releaseSlot;
  try {
    releaseSlot = await acquireClaudeSlot();
  } catch (err) {
    if (err instanceof ConcurrencyOverflowError) {
      return jsonResponse(res, 429, { error: { message: sanitizeError(err.message), type: "rate_limit_error" } }, { "Retry-After": String(err.retryAfter) });
    }
    return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
  }

  // F3: resolve the per-spawn HOME/token decision (may serialize on the real-HOME fallback mutex).
  const spawnDecision = await resolveSpawnDecision();
  let ctx;
  try {
    ctx = spawnClaudeProcess(model, messages, conversationId, authInfo.keyName, releaseSlot, spawnDecision);
  } catch (err) {
    releaseSlot();
    // Spawn threw before cleanup() was wired → release the fallback mutex here so it never leaks.
    try { spawnDecision.releaseFallback?.(); } catch { /* best effort */ }
    return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
  }

  const { proc, cliModel, conversationId: convId, t0, cleanup, clearOverallTimer, handleSessionFailure, markFirstByte } = ctx;
  let stderr = "";
  let headersSent = false;
  let totalChars = 0;
  let cachedContent = ""; // accumulate for cache write-back
  let lineBuffer = "";
  let isFirstDelta = true;
  let resultEventSeen = false;
  // Separate flag for is_error result — must NOT be conflated with resultEventSeen.
  // If errored===true the close handler must not cache the response or record success
  // (mirrors callClaude which rejects and never caches on is_error).
  let errored = false;

  function ensureHeaders() {
    if (res.writableEnded || res.destroyed) return false;
    if (headersSent) return true;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Send initial role chunk
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    return true;
  }

  // D4 (spec 2026-04-25): eagerly send SSE headers post-spawn so the
  // heartbeat started in the next statement covers the pre-first-byte silent window.
  ensureHeaders();
  const hb = startHeartbeat(res, HEARTBEAT_INTERVAL, convId);

  proc.stdout.on("data", (d) => {
    markFirstByte();
    lineBuffer += d.toString();
    const { events, remainder } = parseStreamJsonLines(lineBuffer);
    lineBuffer = remainder;

    for (const event of events) {
      const parsed = parseStreamJsonEvent(event, isFirstDelta);
      if (!parsed) continue;

      if (parsed.text !== undefined) {
        // content_block_delta text — forward as SSE delta
        const text = parsed.text;
        totalChars += text.length;
        if (CACHE_TTL > 0) cachedContent += text;
        isFirstDelta = false;

        if (!ensureHeaders()) continue;
        sendSSE(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        }, hb);

      } else if (parsed.stop) {
        // result event — emit stop and [DONE] immediately
        resultEventSeen = true;
        if (!ensureHeaders()) continue;
        sendSSE(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }, hb);
        if (!res.writableEnded && !res.destroyed) {
          res.write("data: [DONE]\n\n");
          res.end();
        }
        clearOverallTimer();

      } else if (parsed.error) {
        // is_error result — emit error stop; do NOT set resultEventSeen (that would
        // cause the close handler to record success + write cache). Set errored instead.
        errored = true;
        const errStr = String(parsed.error);
        logEvent("error", "claude_result_error", { model: cliModel, error: errStr.slice(0, 200) });
        trackError(errStr.slice(0, 200));
        if (!headersSent && !res.writableEnded && !res.destroyed) {
          jsonResponse(res, 500, { error: { message: sanitizeError(errStr), type: "provider_error" } });
        } else if (!res.writableEnded && !res.destroyed) {
          // Headers already sent (eager ensureHeaders) — can't send a JSON 500. Surface the
          // failure as an SSE error frame so the client can distinguish an upstream error
          // from a legitimately empty completion, instead of a success-looking finish_reason:"stop". (issue #110)
          sendSSE(res, { error: { message: sanitizeError(errStr), type: "provider_error" } }, hb);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }
    }
  });

  proc.stderr.on("data", (d) => (stderr += d));

  proc.on("close", (code, signal) => {
    activeProcesses.delete(proc);
    hb.stop();
    cleanup();
    const elapsed = Date.now() - t0;

    // Tolerate null exit code when result event was seen (sandbox-wrap noise, same
    // as OLP commit 2864275 — bwrap shell exits null after model completes).
    // Also route to the error path when errored===true (is_error result received):
    // never record success or write cache for an errored response.
    if ((code !== 0 && !resultEventSeen) || errored) {
      recordModelError(cliModel, false);
      try { recordUsage({ keyId: authInfo.keyId, keyName: authInfo.keyName, model, promptChars: messages.reduce((a, m) => a + contentToText(m.content).length, 0), responseChars: 0, elapsedMs: elapsed, success: false }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
      logEvent("error", "claude_exit", { model: cliModel, code, signal: signal || "none", elapsed, errored, stderr: stderr.slice(0, 300) });
      trackError(stderr.slice(0, 300) || `claude exit ${code}`);
      handleSessionFailure();

      // If the error was already sent inline (parsed.error branch above), the
      // response may be writableEnded — nothing more to send.
      if (!headersSent && !res.writableEnded && !res.destroyed) {
        jsonResponse(res, 500, { error: { message: sanitizeError(stderr.slice(0, 300) || `claude exit ${code}`), type: "proxy_error" } });
      } else if (!res.writableEnded && !res.destroyed) {
        // Headers already sent — surface the failure as an SSE error frame instead of a
        // success-looking finish_reason:"stop", so the client can tell the upstream crashed
        // rather than returned empty. (issue #110 — sibling of the parsed.error branch above.)
        sendSSE(res, { error: { message: sanitizeError(stderr.slice(0, 300) || `claude exit ${code}`), type: "proxy_error" } }, hb);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      recordModelSuccess(cliModel, elapsed);
      breakerRecordSuccess(cliModel);
      try { recordUsage({ keyId: authInfo.keyId, keyName: authInfo.keyName, model, promptChars: messages.reduce((a, m) => a + contentToText(m.content).length, 0), responseChars: totalChars, elapsedMs: elapsed, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
      logEvent("info", "claude_ok", { model: cliModel, chars: totalChars, elapsed, session: convId ? convId.slice(0, 12) + "..." : "none" });
      // Cache write-back for streaming — only on true success (not errored)
      if (CACHE_TTL > 0 && authInfo.cacheHash) {
        try { setCachedResponse(authInfo.cacheHash, model, cachedContent); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); }
      }

      // If result event already closed the response, nothing more to do.
      // Otherwise emit a synthetic stop (version drift safety net, same as OLP).
      if (!resultEventSeen) {
        if (!headersSent) ensureHeaders();
        if (!res.writableEnded && !res.destroyed) {
          sendSSE(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }, hb);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }
    }
  });

  proc.on("error", (err) => {
    console.error(`[claude] spawn error: ${err.message}`);
    hb.stop();
    cleanup();
    trackError(err.message);
    handleSessionFailure();
    if (!headersSent && !res.writableEnded && !res.destroyed) {
      jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
    } else if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  });

  // If client disconnects, kill the process to free resources
  res.on("close", () => {
    hb.stop();
    // Only escalate when the child is still alive. On the normal-success path res.end()
    // also fires "close", but the child has usually already exited — skip the spurious
    // SIGTERM and the 5s kill-timer entirely (a post-exit proc.once("exit") never fires,
    // so the timer would otherwise leak a closure over proc for 5s per request). (issue #111)
    if (!proc.killed && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill("SIGTERM"); } catch {}
      // Mirror the overallTimer escalation (server.mjs ~818): a SIGTERM-resistant child would
      // otherwise hold its concurrency slot until the request timeout — #37 on the disconnect path. (issue #111)
      const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      killTimer.unref();
      proc.once("exit", () => clearTimeout(killTimer));
    }
  });
}

// Strip absolute filesystem paths from an error message before sending it to a client.
// claude error_message / stderr routinely embed home-dir / credential-file paths. (issue #111)
function sanitizeError(msg) {
  return String(msg || "Internal error").replace(/\/[\w/.\-]+/g, "[path]");
}

// ── Response helpers ────────────────────────────────────────────────────
function jsonResponse(res, status, data, extraHeaders = null) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  // extraHeaders is optional + additive (e.g. Retry-After on a 429); Content-Type always wins.
  res.writeHead(status, { ...(extraHeaders || {}), "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// FIX ⑥: map an upstream error to the right HTTP response. A ConcurrencyOverflowError (the
// wait-queue was full) becomes HTTP 429 + Retry-After + rate_limit_error; every other error
// stays a 500 proxy_error (byte-for-byte the pre-fix behaviour for non-overflow errors).
function respondUpstreamError(res, err) {
  if (err instanceof ConcurrencyOverflowError) {
    return jsonResponse(res, 429, { error: { message: sanitizeError(err.message), type: "rate_limit_error" } }, { "Retry-After": String(err.retryAfter) });
  }
  return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
}

function sendSSE(res, data, hb) {
  hb?.reset();
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function completionResponse(res, id, model, content) {
  jsonResponse(res, 200, {
    id, object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// Replay a complete string as a chunked SSE stream (80 codepoints/chunk).
// Used by: (a) cache-hit replay on the streaming path; (b) TUI-mode streaming
// (buffered response replayed as SSE so clients get the same wire format).
// Behaviour is byte-for-byte identical to the original inline cache-replay block.
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

// ── Plan usage probe ────────────────────────────────────────────────────
// ── Plan usage probe ────────────────────────────────────────────────────
// ALIGNMENT: mirrors Claude Code cli.js vE4 rate-limit header extraction.
// DO NOT switch endpoints without grepping "anthropic-ratelimit-unified" in cli.js.
// 2026-04-11 b87992f drift lesson: /api/oauth/usage is a hallucinated endpoint.
// See ALIGNMENT.md for full history.
//
// Reads OAuth token (keychain / Linux credentials / CLAUDE_CODE_OAUTH_TOKEN env)
// and makes a minimal /v1/messages request to capture anthropic-ratelimit-unified-*
// headers. Caches the result for 5 minutes.

let usageCache = { data: null, fetchedAt: 0 };
const USAGE_CACHE_TTL = 5 * 60 * 1000; // 5 min
// ALIGNMENT (Class A — OAuth bearer machinery). Verified against the compiled cli.js
// (claude.exe v2.1.154) on 2026-05-31 via `strings`: both OAUTH_CLIENT_ID and
// OAUTH_TOKEN_URL appear in the binary byte-for-byte; the legacy host
// console.anthropic.com/v1/oauth is absent (0 hits). Re-verify on cli.js major bumps
// using the compiled-binary protocol (strings on the Mach-O/ELF; no live OAuth probe —
// a refresh-token grant would rotate the operator's real credentials). (issue #112)
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

// Refresh backoff state — exponential 60s → 3600s.
// Prevents tight loops hammering the token endpoint after a failure
// (lesson from pre-fix session that burned through rate-limit in seconds).
const OAUTH_REFRESH_MIN_BACKOFF = 60 * 1000;
const OAUTH_REFRESH_MAX_BACKOFF = 3600 * 1000;
let oauthRefreshBackoff = { nextAttemptAt: 0, currentDelay: OAUTH_REFRESH_MIN_BACKOFF };

// FIX F5 (2026-07-07): the macOS keychain read (`security find-generic-password`, up to 5s × 2
// labels when the first label misses) ran on EVERY -p spawn's hot path, blocking the event loop
// (worst case 10s) and stalling all in-flight SSE streams. Two minimal, sync-preserving mitigations:
//   (a) memoize the last-good keychain label and try it FIRST → one exec instead of two on the
//       steady-state path (orderLabelsLastGoodFirst);
//   (b) a short (30s) TTL cache of the keychain read result (createTtlCache).
// SAFETY vs the #146 regression: #146 was a token memoized FOREVER at startup that went stale and
// 401'd. This is a 30s TTL (not forever), AND resolveSpawnToken() re-applies the 5-min expiry gate
// (isTokenExpiring) to the CACHED creds on EVERY use — the creds object carries `expiresAt`, so a
// token expiring within the cache window is still rejected → real-HOME fallback. A short TTL bounds
// how often we re-READ the keychain; it does NOT bound how often we re-DECIDE expiry. This is why a
// short-TTL keychain cache + a per-use expiry check does not reintroduce the forever-stale bug.
const KEYCHAIN_LABELS = ["claude-code-credentials", "Claude Code-credentials"];
const KEYCHAIN_CACHE_TTL_MS = 30 * 1000;
const _keychainCache = createTtlCache({ ttlMs: KEYCHAIN_CACHE_TTL_MS });
let _lastGoodKeychainLabel = null;

// Read the macOS keychain credentials, label-memoized + short-TTL cached (F5). Sync (execFileSync);
// returns the `claudeAiOauth` creds object or null.
function readKeychainCreds() {
  return _keychainCache.get(() => {
    for (const label of orderLabelsLastGoodFirst(KEYCHAIN_LABELS, _lastGoodKeychainLabel)) {
      try {
        const raw = execFileSync("security", [
          "find-generic-password", "-s", label, "-w"
        ], { encoding: "utf8", timeout: 5000 }).trim();
        const creds = JSON.parse(raw);
        if (creds?.claudeAiOauth?.accessToken) {
          _lastGoodKeychainLabel = label; // remember the winner → try it first next time
          return creds.claudeAiOauth;
        }
      } catch { /* try next label */ }
    }
    return null;
  });
}

// F3 drain helper: drop the F5 keychain TTL cache so the NEXT getOAuthCredentials() re-reads the
// keychain from scratch. Called under the real-HOME fallback mutex just before the re-check, so a
// waiter admitted after the prior holder's claude refreshed the keychain sees the FRESH token
// immediately (and proceeds ISOLATED) instead of waiting out the ≤30s TTL on the stale creds.
function invalidateKeychainReadCache() {
  _keychainCache.clear();
}

function getOAuthCredentials() {
  // 1. Env var fallback — highest precedence for explicit overrides.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  // 2. Linux file-based credentials
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const creds = JSON.parse(readFileSync(credPath, "utf8"));
    if (creds?.claudeAiOauth?.accessToken) return creds.claudeAiOauth;
  } catch { /* fall through to macOS keychain */ }

  // 3. macOS keychain (both label formats) — F5: label-memoized + 30s TTL cached (see above).
  return readKeychainCreds();
}

async function refreshOAuthToken(refreshToken) {
  const now = Date.now();
  if (now < oauthRefreshBackoff.nextAttemptAt) {
    logEvent("info", "oauth_refresh_backoff_skip", {
      waitMs: oauthRefreshBackoff.nextAttemptAt - now,
    });
    return null;
  }
  try {
    const resp = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: "user:inference user:profile",
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      // Exponential backoff on failure
      oauthRefreshBackoff.nextAttemptAt = Date.now() + oauthRefreshBackoff.currentDelay;
      oauthRefreshBackoff.currentDelay = Math.min(
        oauthRefreshBackoff.currentDelay * 2,
        OAUTH_REFRESH_MAX_BACKOFF,
      );
      logEvent("warn", "oauth_refresh_failed", {
        status: resp.status,
        body: body.slice(0, 200),
        nextBackoffMs: oauthRefreshBackoff.currentDelay,
      });
      return null;
    }
    const data = await resp.json();
    // Reset backoff on success
    oauthRefreshBackoff.currentDelay = OAUTH_REFRESH_MIN_BACKOFF;
    oauthRefreshBackoff.nextAttemptAt = 0;
    return data.access_token || null;
  } catch (err) {
    oauthRefreshBackoff.nextAttemptAt = Date.now() + oauthRefreshBackoff.currentDelay;
    oauthRefreshBackoff.currentDelay = Math.min(
      oauthRefreshBackoff.currentDelay * 2,
      OAUTH_REFRESH_MAX_BACKOFF,
    );
    logEvent("warn", "oauth_refresh_error", {
      error: err.message,
      nextBackoffMs: oauthRefreshBackoff.currentDelay,
    });
    return null;
  }
}

async function fetchUsageFromApi() {
  const creds = getOAuthCredentials();
  if (!creds?.accessToken) {
    return { error: "No OAuth token found (keychain / ~/.claude/.credentials.json / CLAUDE_CODE_OAUTH_TOKEN)" };
  }

  let token = creds.accessToken;

  // Pre-emptive refresh if token looks expired (5 min buffer, same as Claude Code)
  if (creds.expiresAt && Date.now() + 300000 >= creds.expiresAt && creds.refreshToken) {
    logEvent("info", "oauth_token_expired_refreshing");
    const newToken = await refreshOAuthToken(creds.refreshToken);
    if (newToken) token = newToken;
  }

  // Minimal /v1/messages request — we only need the response headers.
  // Mirrors Claude Code cli.js vE4: headers anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}.
  const body = JSON.stringify({
    model: modelsConfig.aliases.haiku,
    max_tokens: 1,
    messages: [{ role: "user", content: "." }],
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const doFetch = (bearerToken) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearerToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
    body,
    signal: controller.signal,
  });

  try {
    let resp = await doFetch(token);

    // 401 → try a single refresh-and-retry
    if (resp.status === 401 && creds.refreshToken) {
      logEvent("info", "oauth_usage_401_refreshing");
      const newToken = await refreshOAuthToken(creds.refreshToken);
      if (newToken) {
        token = newToken;
        resp = await doFetch(token);
      }
    }

    clearTimeout(timeout);

    // Extract all rate-limit headers (we do not need the response body)
    const rl = {};
    for (const [k, v] of resp.headers) {
      if (k.startsWith("anthropic-ratelimit")) rl[k] = v;
    }

    if (!resp.ok && Object.keys(rl).length === 0) {
      return { error: `Usage API returned ${resp.status} with no rate-limit headers` };
    }

    return parseRateLimitHeaders(rl);
  } catch (err) {
    clearTimeout(timeout);
    return { error: `Failed to fetch usage: ${err.message}` };
  }
}

function parseRateLimitHeaders(rl) {
  const now = Date.now();

  const session5hUtil = parseFloat(rl["anthropic-ratelimit-unified-5h-utilization"] || "0");
  const session5hReset = parseInt(rl["anthropic-ratelimit-unified-5h-reset"] || "0", 10);
  const weekly7dUtil = parseFloat(rl["anthropic-ratelimit-unified-7d-utilization"] || "0");
  const weekly7dReset = parseInt(rl["anthropic-ratelimit-unified-7d-reset"] || "0", 10);
  const overageStatus = rl["anthropic-ratelimit-unified-overage-status"] || "unknown";
  const overageDisabledReason = rl["anthropic-ratelimit-unified-overage-disabled-reason"] || "";
  const status = rl["anthropic-ratelimit-unified-status"] || "unknown";
  const representativeClaim = rl["anthropic-ratelimit-unified-representative-claim"] || "";
  const fallbackPct = parseFloat(rl["anthropic-ratelimit-unified-fallback-percentage"] || "0");

  function formatReset(epochSec) {
    if (!epochSec) return "unknown";
    const diff = epochSec * 1000 - now;
    if (diff <= 0) return "now";
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h > 24) {
      const d = Math.floor(h / 24);
      return `${d}d ${h % 24}h`;
    }
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function resetDay(epochSec) {
    if (!epochSec) return "";
    const d = new Date(epochSec * 1000);
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  return {
    status,
    fetchedAt: new Date(now).toISOString(),
    plan: {
      currentSession: {
        utilization: session5hUtil,
        percent: `${Math.round(session5hUtil * 100)}%`,
        resetsIn: formatReset(session5hReset),
        resetsAt: session5hReset ? new Date(session5hReset * 1000).toISOString() : null,
        resetsAtHuman: resetDay(session5hReset),
      },
      weeklyLimits: {
        allModels: {
          utilization: weekly7dUtil,
          percent: `${Math.round(weekly7dUtil * 100)}%`,
          resetsIn: formatReset(weekly7dReset),
          resetsAt: weekly7dReset ? new Date(weekly7dReset * 1000).toISOString() : null,
          resetsAtHuman: resetDay(weekly7dReset),
        },
      },
      extraUsage: {
        status: overageStatus,
        disabledReason: overageDisabledReason || undefined,
      },
      representativeClaim,
      fallbackPercentage: fallbackPct,
    },
    proxy: {
      totalRequests: stats.totalRequests,
      activeRequests: stats.activeRequests,
      errors: stats.errors,
      timeouts: stats.timeouts,
      uptime: `${Math.floor((now - START_TIME) / 3600000)}h ${Math.floor(((now - START_TIME) % 3600000) / 60000)}m`,
    },
    models: getModelStatsSnapshot(),
    _raw: rl,
  };
}

async function handleUsage(_req, res) {
  const now = Date.now();
  let data;
  if (usageCache.data && (now - usageCache.fetchedAt) < USAGE_CACHE_TTL) {
    data = usageCache.data;
  } else {
    data = await fetchUsageFromApi();
    if (!data.error) {
      usageCache = { data, fetchedAt: now };
    }
  }
  // Always attach live model stats and proxy stats (not cached)
  const uptimeMs = now - START_TIME;
  const response = {
    ...data,
    proxy: {
      totalRequests: stats.totalRequests,
      activeRequests: stats.activeRequests,
      errors: stats.errors,
      timeouts: stats.timeouts,
      uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
    },
    models: getModelStatsSnapshot(),
  };
  jsonResponse(res, data.error ? 502 : 200, response);
}

// ── Logs endpoint ──────────────────────────────────────────────────────
// Returns recent structured log entries from the proxy log file.
// GET /logs?n=20&level=error  (default: n=30, level=all)
function handleLogs(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const n = Math.min(parseInt(url.searchParams.get("n") || "30", 10), 200);
  const level = url.searchParams.get("level") || "all"; // all | error | warn | info

  const LOG_PATH = join(process.env.HOME || "/tmp", ".openclaw/logs/proxy.log");
  let lines;
  try {
    const raw = readFileSync(LOG_PATH, "utf8");
    lines = raw.split("\n").filter(Boolean);
  } catch (err) {
    return jsonResponse(res, 500, { error: `Cannot read log: ${err.message}` });
  }

  // Parse JSON lines, fall back to raw text
  let entries = lines.slice(-n * 3).map(line => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });

  // Filter by level
  if (level !== "all") {
    entries = entries.filter(e => {
      if (e.level) return e.level === level;
      if (level === "error") return e.raw?.includes("error") || e.raw?.includes("Error");
      return true;
    });
  }

  entries = entries.slice(-n);

  return jsonResponse(res, 200, {
    count: entries.length,
    level,
    entries,
  });
}

// ── Status endpoint (combined summary) ─────────────────────────────────
async function handleStatus(_req, res) {
  const now = Date.now();
  const uptimeMs = now - START_TIME;

  // Get usage (from cache if fresh)
  let usage = null;
  if (usageCache.data && (now - usageCache.fetchedAt) < USAGE_CACHE_TTL) {
    usage = usageCache.data;
  } else {
    usage = await fetchUsageFromApi();
    if (!usage.error) {
      usageCache = { data: usage, fetchedAt: now };
    }
  }

  // Auth
  let binaryOk = false;
  try { accessSync(CLAUDE, constants.X_OK); binaryOk = true; } catch {}

  return jsonResponse(res, 200, {
    proxy: {
      status: binaryOk && authStatus.ok !== false ? "ok" : "degraded",
      version: VERSION,
      uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      auth: authStatus.ok ? "ok" : authStatus.message,
      activeSessions: sessions.size,
    },
    requests: {
      total: stats.totalRequests,
      active: stats.activeRequests,
      errors: stats.errors,
      timeouts: stats.timeouts,
    },
    plan: usage?.plan || usage?.error || null,
    recentErrors: recentErrors.slice(-3),
  });
}

// ── Settings endpoint ───────────────────────────────────────────────────
// GET  /settings → view current tunable parameters
// PATCH /settings → update one or more parameters at runtime
//
// Tunable keys and their types/ranges:
const SETTINGS_SCHEMA = {
  timeout:          { type: "number", min: 30000, max: 1800000, unit: "ms", desc: "Request timeout (default: 600s)" },
  maxConcurrent:    { type: "number", min: 1, max: 32, unit: "", desc: "Max concurrent claude processes" },
  sessionTTL:       { type: "number", min: 60000, max: 86400000, unit: "ms", desc: "Session idle expiry" },
  maxPromptChars:   { type: "number", min: 10000, max: 1000000, unit: "chars", desc: "Prompt truncation limit" },
  cacheTTL:         { type: "number", min: 0, max: 86400000, unit: "ms", desc: "Response cache TTL (0 = disabled)" },
};

function getSettings() {
  return {
    timeout:          { value: TIMEOUT, ...SETTINGS_SCHEMA.timeout },
    maxConcurrent:    { value: MAX_CONCURRENT, ...SETTINGS_SCHEMA.maxConcurrent },
    sessionTTL:       { value: SESSION_TTL, ...SETTINGS_SCHEMA.sessionTTL },
    maxPromptChars:   { value: MAX_PROMPT_CHARS, ...SETTINGS_SCHEMA.maxPromptChars },
    cacheTTL:         { value: CACHE_TTL, ...SETTINGS_SCHEMA.cacheTTL },
  };
}

function applySettingUpdate(key, value) {
  const schema = SETTINGS_SCHEMA[key];
  if (!schema) return `unknown setting: ${key}`;
  if (typeof value !== schema.type) return `${key}: expected ${schema.type}, got ${typeof value}`;
  if (value < schema.min || value > schema.max) return `${key}: value ${value} out of range [${schema.min}, ${schema.max}]`;

  switch (key) {
    case "timeout":          TIMEOUT = value; break;
    // FIX ⑥: keep the -p wait-queue semaphore's limit in sync with the runtime MAX_CONCURRENT
    // so a /settings change to maxConcurrent actually changes how many claude procs run at once.
    case "maxConcurrent":    MAX_CONCURRENT = value; claudeSemaphore.limit = Math.max(1, value); break;
    case "sessionTTL":       SESSION_TTL = value; break;
    case "maxPromptChars":   MAX_PROMPT_CHARS = value; break;
    case "cacheTTL":         CACHE_TTL = value; break;
    default: return `${key}: not implemented`;
  }
  logEvent("info", "setting_changed", { key, value });
  return null; // success
}

async function handleSettings(req, res) {
  if (req.method === "GET") {
    return jsonResponse(res, 200, getSettings());
  }

  // PATCH
  let body = "";
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10000) return jsonResponse(res, 413, { error: "Body too large" });
    }
  } catch (e) {
    if (!res.headersSent && !res.writableEnded) {
      try { return jsonResponse(res, 400, { error: { message: "request aborted", type: "invalid_request_error" } }); } catch {}
    }
    return;
  }
  let updates;
  try { updates = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

  if (typeof updates !== "object" || Array.isArray(updates)) {
    return jsonResponse(res, 400, { error: "Expected JSON object with key-value pairs" });
  }

  const results = {};
  const errors = [];
  for (const [key, value] of Object.entries(updates)) {
    const err = applySettingUpdate(key, value);
    if (err) {
      errors.push(err);
      results[key] = { error: err };
    } else {
      results[key] = { ok: true, value };
    }
  }

  const status = errors.length === 0 ? 200 : (Object.keys(results).length > errors.length ? 207 : 400);
  return jsonResponse(res, status, {
    results,
    ...(errors.length ? { errors } : {}),
    current: getSettings(),
  });
}

// ── Handle chat completions ─────────────────────────────────────────────
const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5 MB

// Set of all valid model identifiers (canonical IDs + aliases)
const VALID_MODELS = new Set(Object.keys(MODEL_MAP));

async function handleChatCompletions(req, res) {
  let body = "";
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        return jsonResponse(res, 413, { error: { message: "Request body too large (max 5MB)", type: "invalid_request_error" } });
      }
    }
  } catch (e) {
    if (!res.headersSent && !res.writableEnded) {
      try { return jsonResponse(res, 400, { error: { message: "request aborted", type: "invalid_request_error" } }); } catch {}
    }
    return;
  }

  let parsed;
  try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

  const messages = parsed.messages || parsed.input || [{ role: "user", content: parsed.prompt || "" }];
  const model = parsed.model || modelsConfig.aliases.sonnet;
  const stream = parsed.stream;

  // Validate model against known models
  if (!VALID_MODELS.has(model)) {
    return jsonResponse(res, 400, { error: { message: `Unknown model: ${model}. Valid models: ${[...VALID_MODELS].join(", ")}`, type: "invalid_request_error" } });
  }

  // Session ID: from request body, header, or null (one-off)
  const conversationId = parsed.session_id || parsed.conversation_id || req.headers["x-session-id"] || req.headers["x-conversation-id"] || null;

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse(res, 400, { error: { message: "'messages' must be a non-empty array", type: "invalid_request_error" } });
  }

  // NOTE: quota is best-effort / eventually-consistent. The gate reads the recorded count
  // at entry and records only after the upstream completes, so concurrent requests at the
  // boundary can overshoot the cap by up to MAX_CONCURRENT, and cache hits (served before
  // recordUsage) are not counted. This is internal family rate-limiting, not a payment
  // boundary — bounded overshoot is acceptable. (issue #111)
  // Quota check — only for identified per-key users (not anonymous/admin/local)
  if (req._authKeyId) {
    let exceeded;
    try { exceeded = checkQuota(req._authKeyId, req._authKeyName); } catch (e) { logEvent("error", "quota_check_failed", { error: e.message }); exceeded = null; }
    if (exceeded) {
      logEvent("warn", "quota_exceeded", { keyId: req._authKeyId, keyName: req._authKeyName, period: exceeded.period, limit: exceeded.limit, used: exceeded.used });
      return jsonResponse(res, 429, {
        error: {
          message: `Quota exceeded: ${exceeded.used}/${exceeded.limit} requests (${exceeded.period}). Resets ${exceeded.resetsIn}.`,
          type: "quota_exceeded",
          quota: exceeded,
        },
      });
    }
  }

  // Cache check (only when cache is enabled and no active conversation/session)
  if (CACHE_TTL > 0 && !conversationId) {
    // D2: skip OCP cache entirely when messages carry cache_control annotations;
    // the client is requesting Anthropic-side prompt caching, not OCP-layer caching.
    if (hasCacheControl(messages)) {
      req._cacheHash = null;
      logEvent("info", "cache_skipped", { reason: "cache_control_present" });
    } else {
      // D1: include keyId in hash to isolate per-key cache pools (v2 format)
      const hash = cacheHash(model, messages, { keyId: req._authKeyId, temperature: parsed.temperature, max_tokens: parsed.max_tokens, top_p: parsed.top_p });
      req._cacheHash = hash; // store for later write-back
      try {
        const cached = getCachedResponse(hash, CACHE_TTL);
        if (cached) {
          logEvent("info", "cache_hit", { model, hash: hash.slice(0, 12), hits: cached.hits });
          if (stream) {
            // D3: replay cached content as chunked SSE stream — delegated to streamStringAsSSE (DRY).
            const id = `chatcmpl-${randomUUID()}`;
            streamStringAsSSE(res, id, model, cached.response);
            return;
          } else {
            const id = `chatcmpl-${randomUUID()}`;
            return completionResponse(res, id, model, cached.response);
          }
        }
      } catch (e) {
        logEvent("error", "cache_check_failed", { error: e.message });
      }
    }
  }

  if (stream) {
    if (TUI_MODE) {
      // TUI-mode: no real token stream — buffer the full turn via callClaudeTui,
      // optionally write-back to cache, then replay as chunked SSE.
      // Default path (TUI_MODE===false) falls through to callClaudeStreaming below,
      // which is byte-for-byte unchanged from before this gate was added.
      const t0TuiStream = Date.now();
      const promptCharsTuiStream = messages.reduce((a, m) => a + contentToText(m.content).length, 0);
      try {
        const content = await callClaudeTui(model, messages, conversationId, req._authKeyName);
        if (CACHE_TTL > 0 && req._cacheHash) {
          try { setCachedResponse(req._cacheHash, model, content); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); }
        }
        const id = `chatcmpl-${randomUUID()}`;
        streamStringAsSSE(res, id, model, content);
        try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars: promptCharsTuiStream, responseChars: content.length, elapsedMs: Date.now() - t0TuiStream, success: true }); } catch {}
        return;
      } catch (err) {
        if (res.headersSent || res.writableEnded || res.destroyed) { try { res.end(); } catch {} return; }
        return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
      }
    }
    // Default: real stream-json streaming, unchanged.
    return callClaudeStreaming(model, messages, conversationId, res, { keyId: req._authKeyId, keyName: req._authKeyName, cacheHash: req._cacheHash });
  }

  const t0Usage = Date.now();
  const promptChars = messages.reduce((a, m) => a + contentToText(m.content).length, 0);

  // Select upstream based on TUI_MODE flag. With TUI_MODE===false (default),
  // upstreamCall===callClaude — identical to the pre-TUI code path.
  const upstreamCall = TUI_MODE ? callClaudeTui : callClaude;

  // Non-streaming path with stampede protection: wrap the upstream call in singleflight
  // when cache is enabled and a hash is present. Concurrent identical requests share
  // one upstream spawn; followers receive the same promise. Streaming-path dedup is
  // explicitly out of scope (see TODO comment above callClaudeStreaming).
  if (CACHE_TTL > 0 && req._cacheHash) {
    try {
      const content = await singleflight(req._cacheHash, async () => {
        // Re-check cache inside the singleflight: a follower that enters before the
        // leader finishes will wait on the shared promise (not reach here), but a
        // request that races in just after the previous singleflight cleared the map
        // will re-read the freshly-populated cache entry here rather than spawning.
        const recheck = getCachedResponse(req._cacheHash, CACHE_TTL);
        if (recheck) return recheck.response;
        const c = await upstreamCall(model, messages, conversationId, req._authKeyName);
        try { setCachedResponse(req._cacheHash, model, c); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); }
        return c;
      });
      const id = `chatcmpl-${randomUUID()}`;
      completionResponse(res, id, model, content);
      try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars, responseChars: content.length, elapsedMs: Date.now() - t0Usage, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
      return;
    } catch (err) {
      try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars, responseChars: 0, elapsedMs: Date.now() - t0Usage, success: false }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
      console.error(`[proxy] error: ${err.message}`);
      if (res.headersSent || res.writableEnded || res.destroyed) {
        try { res.end(); } catch {}
        return;
      }
      return respondUpstreamError(res, err);
    }
  }

  // Fallback: cache disabled (CACHE_TTL=0) or no _cacheHash — original path untouched.
  try {
    const content = await upstreamCall(model, messages, conversationId, req._authKeyName);
    const id = `chatcmpl-${randomUUID()}`;
    completionResponse(res, id, model, content);
    try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars, responseChars: content.length, elapsedMs: Date.now() - t0Usage, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
  } catch (err) {
    try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars, responseChars: 0, elapsedMs: Date.now() - t0Usage, success: false }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
    console.error(`[proxy] error: ${err.message}`);
    if (res.headersSent || res.writableEnded || res.destroyed) {
      try { res.end(); } catch {}
      return;
    }
    // Sanitize error: strip internal file paths before sending to client.
    // FIX ⑥: ConcurrencyOverflowError → 429 + Retry-After; all other errors → 500 (unchanged).
    respondUpstreamError(res, err);
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // Dynamic CORS: allow localhost and LAN origins
  const origin = req.headers["origin"] || "";
  const isAllowedOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin ? origin : `http://127.0.0.1:${PORT}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // 3-mode auth: none | shared | multi
  const pathname = req.url.split("?")[0];
  const isPublicEndpoint = pathname === "/health" || pathname === "/dashboard";
  const remoteAddr = req.socket.remoteAddress || "";
  const isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
  let authKeyName = isLocalhost ? "local" : "remote";
  let authKeyId = null;

  if (!isPublicEndpoint) {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (isLocalhost) {
      // Localhost always allowed — try to identify key if provided, but never reject
      if (token) {
        if (ADMIN_KEY) {
          const adminBuf = Buffer.from(ADMIN_KEY);
          const tokenBuf = Buffer.from(token);
          if (adminBuf.length === tokenBuf.length && timingSafeEqual(adminBuf, tokenBuf)) {
            authKeyName = "admin";
          }
        }
        if (authKeyName !== "admin" && PROXY_ANONYMOUS_KEY) {
          // anonymous allowlist (issue #12 §14 Path A) — same check as multi branch
          const anonBuf = Buffer.from(PROXY_ANONYMOUS_KEY);
          const tokenBufA = Buffer.from(token);
          if (anonBuf.length === tokenBufA.length && timingSafeEqual(anonBuf, tokenBufA)) {
            authKeyName = "anonymous";
          }
        }
        if (authKeyName !== "admin" && authKeyName !== "anonymous") {
          const keyInfo = validateKey(token);
          if (keyInfo) { authKeyName = keyInfo.name; authKeyId = keyInfo.id; }
        }
      }
    } else if (AUTH_MODE === "shared") {
      if (PROXY_API_KEY) {
        const tokenBuf = Buffer.from(token);
        const keyBuf = Buffer.from(PROXY_API_KEY);
        if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
          return jsonResponse(res, 401, { error: { message: "Unauthorized: invalid or missing Bearer token", type: "auth_error" } });
        }
        authKeyName = "shared";
      }
    } else if (AUTH_MODE === "multi") {
      // If a token is provided, validate it; if not, allow as anonymous
      if (token) {
        let isAdminToken = false;
        if (ADMIN_KEY) {
          const adminBuf = Buffer.from(ADMIN_KEY);
          const tokenBuf2 = Buffer.from(token);
          if (adminBuf.length === tokenBuf2.length && timingSafeEqual(adminBuf, tokenBuf2)) {
            authKeyName = "admin";
            isAdminToken = true;
          }
        }
        // === NEW: anonymous allowlist (issue #12 §14 Path A) ===
        let isAnonymousToken = false;
        if (!isAdminToken && PROXY_ANONYMOUS_KEY) {
          const anonBuf = Buffer.from(PROXY_ANONYMOUS_KEY);
          const tokenBuf3 = Buffer.from(token);
          if (anonBuf.length === tokenBuf3.length && timingSafeEqual(anonBuf, tokenBuf3)) {
            authKeyName = "anonymous";
            isAnonymousToken = true;
          }
        }
        if (!isAdminToken && !isAnonymousToken) {
          const keyInfo = validateKey(token);
          if (!keyInfo) {
            return jsonResponse(res, 401, { error: { message: "Unauthorized: invalid or revoked API key", type: "auth_error" } });
          }
          authKeyName = keyInfo.name;
          authKeyId = keyInfo.id;
        }
      } else {
        authKeyName = "anonymous";
      }
    }
  }

  req._authKeyName = authKeyName;
  req._authKeyId = authKeyId;

  // isAdmin computed here (early, before any admin-gated handler) so that
  // DELETE /sessions, GET /logs, GET /usage, GET /status, PATCH /settings
  // can all gate on it.  Localhost and explicit admin key are always admin;
  // in multi-tenant mode only the "admin" named key qualifies.
  const isAdmin = AUTH_MODE !== "multi" || authKeyName === "admin" || isLocalhost;

  // GET /v1/models
  if (req.url === "/v1/models" && req.method === "GET") {
    return jsonResponse(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id, object: "model", owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      })),
    });
  }

  // POST /v1/chat/completions
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  // GET /health — comprehensive diagnostics
  if (req.url === "/health") {
    let binaryOk = false;
    try { accessSync(CLAUDE, constants.X_OK); binaryOk = true; } catch {}

    const uptimeMs = Date.now() - START_TIME;
    const sessionList = [];
    for (const [id, s] of sessions) {
      // id is "${keyName}|${conversationId}"; expose only the public-facing conversationId
      const convId = id.includes("|") ? id.slice(id.indexOf("|") + 1) : id;
      sessionList.push({
        id: convId.slice(0, 12) + "...",
        model: s.model,
        messages: s.messageCount,
        idleMs: Date.now() - s.lastUsed,
      });
    }

    return jsonResponse(res, 200, {
      status: binaryOk && authStatus.ok !== false ? "ok" : "degraded",
      version: VERSION,
      architecture: "on-demand (v2)",
      uptime: uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      claudeBinary: CLAUDE,
      claudeBinaryOk: binaryOk,
      authMode: AUTH_MODE,
      ...((isLocalhost || ADVERTISE_ANON_KEY) ? { anonymousKey: PROXY_ANONYMOUS_KEY || null } : {}),
      auth: authStatus,
      config: {
        timeout: TIMEOUT,
        maxConcurrent: MAX_CONCURRENT,
        sessionTTL: SESSION_TTL,
        circuitBreaker: "disabled",
        allowedTools: SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS,
        systemPrompt: SYSTEM_PROMPT ? `${SYSTEM_PROMPT.slice(0, 50)}...` : "(none)",
        mcpConfig: MCP_CONFIG || "(none)",
      },
      stats,
      circuitBreaker: "disabled",
      sessions: sessionList,
      recentErrors: recentErrors.slice(-5),
      // ── FIX ③ spawn-home isolation surface — ADDITIVE (default -p/stream-json path) ──
      // Lets the operator confirm the latency-fix isolation is active without inspecting logs.
      // NEVER includes the token. mode: "isolated-scratch-home" | "real-home". home is the
      // scratch HOME path when isolated (null otherwise). For TUI_MODE the -p path is unused,
      // so report it as disabled.
      spawn: (() => {
        if (TUI_MODE) return { mode: "tui (default -p path unused)", isolated: false, home: null };
        const shm = getSpawnHomeMode();
        // FIX F6: report the EFFECTIVE current decision, not just token PRESENCE. During the
        // 5-min pre-expiry window the token exists (shm.isolated=true) but resolveSpawnToken()
        // returns null and spawns actually run real-HOME — so `isolated` MUST also reflect the
        // expiry gate, or /health lies. The field SET is unchanged (grandfathered B.2 contract,
        // ADR 0006 — HARD CONSTRAINT: no field add/remove/rename); only the VALUES are made
        // truthful. resolveSpawnToken() is read-only + backed by F5's 30s keychain cache → cheap.
        const effIsolated = shm.isolated && resolveSpawnToken() !== null;
        return {
          mode: effIsolated ? "isolated-scratch-home" : "real-home",
          isolated: effIsolated,
          home: effIsolated ? shm.home : null,
          reason: effIsolated
            ? shm.reason
            : (shm.isolated
                ? "oauth token within 5-min expiry window → real-HOME fallback (self-heals on next refresh)"
                : shm.reason),
        };
      })(),
      // ── FIX ⑥ -p concurrency wait-queue surface — ADDITIVE ──
      // inflight/queued are live; queueRejections is cumulative (also in stats.queueRejections).
      // Lets the operator see backpressure instead of guessing from opaque 500s.
      concurrency: {
        maxConcurrent: MAX_CONCURRENT,
        maxQueue: claudeSemaphore.maxQueue,
        inflight: claudeSemaphore.inflight,
        queued: claudeSemaphore.queued,
        queueRejections: stats.queueRejections,
      },
      // ── TUI observability (audit C-5) — ADDITIVE block (ADR 0007 PR-B amendment) ──
      // /health is a grandfathered B.2 endpoint (ADR 0006). This block is NEW fields only;
      // every existing field above is byte-identical → behaviour-preserving for existing
      // consumers per ALIGNMENT.md's grandfather provision. When TUI_MODE is off the block
      // still appears with enabled:false (cheap, harmless) so the shape is stable.
      // entrypointMismatches/lastEntrypoint exist so an operator can poll /health to catch a
      // silent metered-pool drift (the audit's top risk after the 6/15 billing flip).
      tui: buildTuiHealthBlock(
        { enabled: TUI_MODE, entrypointMode: TUI_ENTRYPOINT, maxConcurrent: TUI_MAX_CONCURRENT },
        tuiStats, tuiSemaphore,
      ),
    });
  }

  // DELETE /sessions — clear all sessions (mutating; admin only)
  if (req.url === "/sessions" && req.method === "DELETE") {
    if (!isAdmin) return jsonResponse(res, 403, { error: { message: "admin only", type: "auth_error" } });
    const count = sessions.size;
    sessions.clear();
    return jsonResponse(res, 200, { cleared: count });
  }

  // GET /sessions — list active sessions (operator data; admin only)
  if (req.url === "/sessions" && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: { message: "admin only", type: "auth_error" } });
    const list = [];
    for (const [id, s] of sessions) {
      // id is "${keyName}|${conversationId}"; expose only the public-facing conversationId
      const convId = id.includes("|") ? id.slice(id.indexOf("|") + 1) : id;
      list.push({ id: convId, uuid: s.uuid, model: s.model, messages: s.messageCount, lastUsed: new Date(s.lastUsed).toISOString() });
    }
    return jsonResponse(res, 200, { sessions: list });
  }

  // GET /usage — fetches plan usage from Anthropic API with operator token; admin only
  if (req.url === "/usage" && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: { message: "admin only", type: "auth_error" } });
    return handleUsage(req, res);
  }

  // GET /logs — recent proxy log entries (errors and key events); admin only
  if (req.url?.startsWith("/logs") && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: { message: "admin only", type: "auth_error" } });
    return handleLogs(req, res);
  }

  // GET /status — combined usage + health summary; uses operator token; admin only
  if (req.url === "/status" && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: { message: "admin only", type: "auth_error" } });
    return handleStatus(req, res);
  }

  // GET /settings — view current tunable settings (admin only)
  // PATCH /settings — update settings at runtime (JSON body; admin only, mutating)
  if (req.url === "/settings" && (req.method === "GET" || req.method === "PATCH")) {
    if (!isAdmin) return jsonResponse(res, 403, { error: { message: "admin only", type: "auth_error" } });
    return handleSettings(req, res);
  }

  // ── Key management API ──
  // (isAdmin is computed early in the request handler, before the admin-gated routes)

  if (req.url === "/api/keys" && req.method === "POST") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    let body = "";
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 10000) return jsonResponse(res, 413, { error: "Body too large" }); }
    } catch (e) {
      if (!res.headersSent && !res.writableEnded) {
        try { return jsonResponse(res, 400, { error: { message: "request aborted", type: "invalid_request_error" } }); } catch {}
      }
      return;
    }
    let parsed;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }
    const name = parsed.name || `key-${Date.now()}`;
    if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(name)) {
      return jsonResponse(res, 400, { error: { message: "Invalid key name: 1-64 chars of letters, digits, space, dot, underscore, hyphen", type: "invalid_request_error" } });
    }
    const newKey = createKey(name);
    return jsonResponse(res, 201, newKey);
  }

  if (req.url === "/api/keys" && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    return jsonResponse(res, 200, { keys: listKeys() });
  }

  if (req.url?.startsWith("/api/keys/") && !req.url.includes("/quota") && req.method === "DELETE") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    const idOrName = decodeURIComponent(req.url.split("/api/keys/")[1]);
    const revoked = revokeKey(idOrName);
    return jsonResponse(res, 200, { revoked, idOrName });
  }

  // PATCH /api/keys/:id/quota — set quota for a key
  // Body: { "daily": 100, "weekly": 500, "monthly": 2000 }  (null = unlimited)
  if (req.url?.match(/^\/api\/keys\/[^/]+\/quota$/) && req.method === "PATCH") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    const idOrName = decodeURIComponent(req.url.split("/api/keys/")[1].replace("/quota", ""));
    let body = "";
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 10000) return jsonResponse(res, 413, { error: "Body too large" }); }
    } catch (e) {
      if (!res.headersSent && !res.writableEnded) {
        try { return jsonResponse(res, 400, { error: { message: "request aborted", type: "invalid_request_error" } }); } catch {}
      }
      return;
    }
    let quotaBody;
    try { quotaBody = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }
    // Validate quota values: must be positive integers or null
    const quotaFields = {};
    for (const k of ["daily", "weekly", "monthly"]) {
      if (k in quotaBody) {
        const v = quotaBody[k];
        if (v !== null && (!Number.isInteger(v) || v < 0)) {
          return jsonResponse(res, 400, { error: `${k} must be a positive integer or null` });
        }
        quotaFields[k] = v;
      }
    }
    if (Object.keys(quotaFields).length === 0) return jsonResponse(res, 400, { error: "Provide at least one of: daily, weekly, monthly" });
    const updated = updateKeyQuota(idOrName, quotaFields);
    if (!updated) return jsonResponse(res, 404, { error: "Key not found" });
    logEvent("info", "quota_updated", { idOrName, ...quotaFields });
    return jsonResponse(res, 200, { ok: true, idOrName, quota: quotaFields });
  }

  // GET /api/keys/:id/quota — get quota + current usage for a key
  if (req.url?.match(/^\/api\/keys\/[^/]+\/quota$/) && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    const idOrName = decodeURIComponent(req.url.split("/api/keys/")[1].replace("/quota", ""));
    const keyRow = findKey(idOrName);
    if (!keyRow) return jsonResponse(res, 404, { error: "Key not found" });
    const quota = getKeyQuota(keyRow.id);
    return jsonResponse(res, 200, { keyId: keyRow.id, quota });
  }

  if (req.url?.startsWith("/api/usage") && req.method === "GET") {
    // Least-privilege scope rules (security audit follow-up):
    //   - non-admin authenticated key  → only own rows
    //   - anonymous (PROXY_ANONYMOUS_KEY) → only "anonymous" rows; ?all=true ignored
    //   - admin without ?all=true       → only own ("admin") rows
    //   - admin with    ?all=true       → full byKey/recent (legacy behavior); audited
    // Authenticated callers are required (anyone reaching here passed the auth gate above);
    // remote+no-auth requests would have been rejected before this point.
    const url = new URL(req.url, `http://${BIND_ADDRESS}:${PORT}`);
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const wantAll = url.searchParams.get("all") === "true";
    const callerName = req._authKeyName;

    // Anonymous callers may never opt into all-keys view, even if they pass ?all=true.
    const isAnonCaller = callerName === "anonymous";
    const fullScope = isAdmin && wantAll && !isAnonCaller;

    // scopeName === null when fullScope is true (no filter); otherwise the key_name to filter by.
    const scopeName = fullScope ? null : callerName;

    if (fullScope) {
      logEvent("info", "admin_usage_full_scope", { caller: callerName, ip: req.socket.remoteAddress || null });
    }

    const byKeyAll = getUsageByKey({ since, until });
    const recentAll = getRecentUsage(Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 500));
    const timeline = getUsageTimeline({
      keyName: scopeName || undefined,
      hours: Math.min(parseInt(url.searchParams.get("hours") || "24", 10), 720),
    });

    const byKey = scopeName ? byKeyAll.filter((row) => row.key_name === scopeName) : byKeyAll;
    const recent = scopeName ? recentAll.filter((row) => row.key_name === scopeName) : recentAll;

    return jsonResponse(res, 200, {
      byKey,
      timeline,
      recent,
      scope: { self: scopeName, all: fullScope },
    });
  }

  // GET /cache/stats — cache statistics (entries, hits, size, inflight singleflight count)
  if (pathname === "/cache/stats" && req.method === "GET") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    return jsonResponse(res, 200, { ...getCacheStats(), ...getInflightStats() });
  }

  // DELETE /cache — clear cache
  if (pathname === "/cache" && req.method === "DELETE") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    const cleared = clearCache();
    logEvent("info", "cache_cleared", { entries: cleared });
    return jsonResponse(res, 200, { cleared });
  }

  // GET /dashboard — web dashboard
  if (pathname === "/dashboard" && req.method === "GET") {
    try {
      const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      return jsonResponse(res, 500, { error: "Dashboard file not found" });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health, GET /usage, GET /status, GET /logs, GET|PATCH /settings, GET|DELETE /sessions, GET /dashboard, GET|POST|DELETE /api/keys, GET|PATCH /api/keys/:id/quota, GET /api/usage, GET /cache/stats, DELETE /cache" });
});


// ── Process-level safety nets ────────────────────────────────────────────
// Prevent unhandled async rejections and synchronous exceptions from crashing
// the daemon. Each registers once at module level so they are installed before
// the first request arrives. These are global no-ops on the happy path.
process.on("unhandledRejection", (e) =>
  logEvent("error", "unhandled_rejection", { error: e && e.message ? e.message : String(e) })
);
process.on("uncaughtException", (e) =>
  logEvent("error", "uncaught_exception", { error: e && e.message ? e.message : String(e) })
);
// Destroy the socket on low-level HTTP parse errors so broken connections
// don't accumulate as open file descriptors.
server.on("clientError", (err, socket) => { try { socket.destroy(); } catch {} });

// ── Graceful shutdown ────────────────────────────────────────────────────
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logEvent("info", "shutdown_start", { signal });

  // 1. Stop accepting new connections
  server.close(() => {
    logEvent("info", "shutdown_server_closed", {});
  });

  // 2. Clear intervals/timers
  clearInterval(sessionCleanupInterval);
  clearInterval(authCheckInterval);
  clearInterval(cacheCleanupInterval);
  if (tuiReapInterval) clearInterval(tuiReapInterval);
  closeDb();

  // 3. Kill all active child processes
  for (const proc of activeProcesses) {
    try { proc.kill("SIGTERM"); } catch {}
  }

  // Force-kill any remaining processes after 5s, then exit
  const forceExitTimer = setTimeout(() => {
    for (const proc of activeProcesses) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    logEvent("warn", "shutdown_forced", { remainingProcesses: activeProcesses.size });
    process.exit(1);
  }, 5000);
  forceExitTimer.unref();

  // If no active processes, exit immediately
  if (activeProcesses.size === 0) {
    logEvent("info", "shutdown_complete", {});
    process.exit(0);
  }

  // Wait for active processes to finish
  const checkDone = setInterval(() => {
    if (activeProcesses.size === 0) {
      clearInterval(checkDone);
      logEvent("info", "shutdown_complete", {});
      process.exit(0);
    }
  }, 200);
  checkDone.unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, BIND_ADDRESS, () => {
  const bindMsg = BIND_ADDRESS === "0.0.0.0" ? `http://0.0.0.0:${PORT} (LAN mode)` : `http://127.0.0.1:${PORT}`;
  console.log(`openclaw-claude-proxy v${VERSION} listening on ${bindMsg}`);
  console.log(`Architecture: on-demand spawning (no pool)`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT / 1000}s | Max concurrent: ${MAX_CONCURRENT} | Queue: ${CLAUDE_MAX_QUEUE} (429 on overflow)`);
  console.log(`Circuit breaker: disabled`);
  console.log(`Tools: ${SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS.join(", ")}`);
  console.log(`Sessions: TTL=${SESSION_TTL / 1000}s`);
  if (SYSTEM_PROMPT) console.log(`System prompt: "${SYSTEM_PROMPT.slice(0, 80)}..."`);
  if (MCP_CONFIG) console.log(`MCP config: ${MCP_CONFIG}`);
  console.log(`Auth: ${PROXY_API_KEY ? "enabled (PROXY_API_KEY set)" : "disabled (no PROXY_API_KEY)"}`);
  console.log(`Auth mode: ${AUTH_MODE}${AUTH_MODE === "shared" ? " (PROXY_API_KEY)" : AUTH_MODE === "multi" ? " (per-user keys)" : " (open)"}`);
  console.log(`Bind: ${BIND_ADDRESS}${BIND_ADDRESS === "0.0.0.0" ? " ⚠ LAN-accessible" : ""}`);
  if (NO_CONTEXT) console.log(`Context: suppressed (CLAUDE_NO_CONTEXT=true — no CLAUDE.md, no auto-memory)`);
  if (CACHE_TTL > 0) console.log(`Cache: enabled (TTL=${CACHE_TTL / 1000}s)`);
  else console.log(`Cache: disabled (set CLAUDE_CACHE_TTL to enable)`);
  // FIX ③: announce default-path (-p/stream-json) spawn-home isolation mode (never logs the token).
  if (!TUI_MODE) {
    const shm = getSpawnHomeMode();
    if (shm.isolated) {
      console.log(`Spawn home: isolated-scratch-home (${shm.home}, cwd-neutral, env-token auth) — fast path`);
    } else {
      console.log(`Spawn home: real-home (${shm.reason}) — set CLAUDE_CODE_OAUTH_TOKEN for the isolated fast path`);
    }
  }
  if (TUI_MODE) {
    console.warn(`⚠️  TUI-mode ON — single-user only; do NOT enable on a multi-user OCP (guest prompts would run claude with operator filesystem access). See ADR 0007.`);
    const tuiAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? (TUI_HOME === process.env.HOME ? "env-token (real home — unset OCP_TUI_HOME for credential isolation)" : "env-token (credential-isolated home — no credentials.json)")
      : "credentials.json (no CLAUDE_CODE_OAUTH_TOKEN — see Troubleshooting #401)";
    console.log(`  TUI-mode: ON home=${TUI_HOME} cwd=${TUI_CWD} auth=${tuiAuth} wallclock=${TUI_WALLCLOCK_MS}ms maxConcurrent=${TUI_MAX_CONCURRENT}`);
    try {
      // F7 fix: scope to THIS instance's own port (see reapStaleTuiSessions). includeLegacy:
      // true ONLY here — the one-time boot reap is the designated point to claim orphaned
      // bare-prefix ("ocp-tui-<uuid8>") zombie sessions left by a PRE-fix process generation
      // of this same instance (no live post-fix instance ever creates that shape again).
      const n = reapStaleTuiSessions({ port: PORT, includeLegacy: true });
      if (n) logEvent("info", "tui_reaped_stale_sessions", { count: n });
    } catch {}
  }
  console.log(`---`);
  console.log(`Coexistence: This proxy does NOT conflict with Claude Code interactive mode.`);
  console.log(`  OCP uses: localhost:${PORT} (HTTP) → claude --output-format stream-json (per-request process)`);
  console.log(`  CC uses:  MCP protocol (in-process) → persistent session`);
  console.log(`  Both can run simultaneously on the same machine.`);

  // Passive OpenClaw registry drift check (non-fatal, read-only).
  // Emits a console.warn only. No network/endpoint surface change. No
  // Claude-CLI-call boundary touched — cli.js citation N/A (ALIGNMENT.md Rule 2).
  try {
    const openclawCfg = join(homedir(), ".openclaw", "openclaw.json");
    if (existsSync(openclawCfg)) {
      const cfg = JSON.parse(readFileSync(openclawCfg, "utf-8"));
      const registered = cfg?.models?.providers?.["claude-local"]?.models ?? [];
      const expected = modelsConfig.models.map(m => m.id);
      const registeredIds = new Set(registered.map(r => r.id));
      const missing = expected.filter(id => !registeredIds.has(id));
      if (missing.length > 0) {
        console.warn(`⚠ OpenClaw registry out of sync (missing: ${missing.join(", ")})`);
        console.warn(`  Run: node ${__dirname}/scripts/sync-openclaw.mjs`);
      }
    }
  } catch { /* ignore — best-effort */ }
});
