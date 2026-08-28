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
 *   CLAUDE_AUTH_CHECK_INTERVAL_MS — how often the background `claude auth status` probe runs (default: 600000 = 10min)
 *   CLAUDE_AUTH_CHECK_TIMEOUT_MS  — per-probe timeout in ms (default: 10000)
 *   CLAUDE_MAX_CONCURRENT        — max concurrent claude processes, -p/stream-json path (default: 8)
 *   CLAUDE_MAX_QUEUE             — max requests waiting for a -p slot before HTTP 429 (default: 16)
 *   OCP_TUI_MAX_CONCURRENT       — max concurrent interactive TUI turns, TUI-mode path (default: 2)
 *   OCP_TUI_POOL_SIZE            — pre-booted warm `claude` panes held for TUI-mode (default: 0 = off;
 *                                  max 32). Each is a live idle process; cuts ~3-4s per request.
 *   OCP_SPAWN_REAL_HOME          — "1" forces the -p spawn to use the real HOME (disables the
 *                                  latency spawn-home isolation; default: isolated when a token exists)
 *   CLAUDE_BREAKER_THRESHOLD     — failures in window before circuit opens (default: 6)
 *   CLAUDE_BREAKER_COOLDOWN      — base ms to wait before retrying after circuit opens (default: 120000)
 *   CLAUDE_BREAKER_WINDOW        — sliding window duration in ms (default: 300000 = 5min)
 *   CLAUDE_BREAKER_HALF_OPEN_MAX — max concurrent probes in half-open state (default: 2)
 *   PROXY_API_KEY                — Bearer token for API auth (optional)
 *   CLAUDE_HEARTBEAT_INTERVAL    — SSE heartbeat interval in ms on streaming path (default: 0 = disabled)
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { spawn, execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID, timingSafeEqual, createHash as cryptoCreateHash } from "node:crypto";
import { readFileSync, readdirSync, accessSync, existsSync, constants, chmodSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { validateKey, recordUsage, getUsageByKey, getUsageTimeline, getRecentUsage, createKey, listKeys, revokeKey, closeDb, checkQuota, updateKeyQuota, getKeyQuota, findKey, cacheHash, getCachedResponse, setCachedResponse, clearCache, getCacheStats, hasCacheControl, singleflight, getInflightStats } from "./keys.mjs";
import { DEFAULT_PORT } from "./lib/constants.mjs";
import { StructuredOutputError, detectStructuredOutput, validateJsonSchemaSafe, extractJsonPayload, structuredSystemInstruction, resolveMaxAttempts } from "./lib/structured-output.mjs";
import { isLoopbackBind } from "./lib/net.mjs";
import { parseAllowedHosts, parseAuthority, matchesDeclared, evaluateOriginGate } from "./lib/host-gate.mjs";
import { classifyToolRequest } from "./lib/tool-support.mjs";
import { runTuiTurn, reapStaleTuiSessions, resolveTuiHome, bootTuiPane, tuiPaneHealthy, poolPaneName, killLiveTurnPanes, POOL_BOOT_MS } from "./lib/tui/session.mjs";
import { detectTuiUpstreamError } from "./lib/tui/transcript.mjs";
import { TuiSemaphore, SemaphoreAbortError, recordTuiEntrypoint, buildTuiHealthBlock } from "./lib/tui/semaphore.mjs";
import { TuiPanePool, resolvePoolSize, POOL_MAX_SIZE } from "./lib/tui/pool.mjs";
import { TuiDeltaAssembler, DEFAULT_HOLDBACK_CHARS, resolveStreamHoldback } from "./lib/tui/stream.mjs";
import { createSerialMutex, createTtlCache, orderLabelsLastGoodFirst, scrubInboundAuthEnv, applyRequestVerdictTtl } from "./lib/spawn-auth.mjs";
import { makeResolveSpawnToken } from "./lib/spawn-token.mjs";
import { hasImageContent, buildImageBlocks, buildStreamJsonInput, MultimodalError } from "./lib/multimodal.mjs";
import { parsePositiveInt } from "./lib/env.mjs";
import { appendOperatorPrompt, promptCharBudgetFor, fallbackPromptCharBudget, resolveGlobalPromptCharOverride, selectPromptWrapper, localToolsSafetyError } from "./lib/prompt.mjs";

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
function _joinIfBase(base, ...parts) {
  return base ? join(base, ...parts) : null;
}
function _collectWindowsClaudeCandidates() {
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  return [
    _joinIfBase(userProfile, ".local", "bin", "claude.exe"),
    _joinIfBase(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
    _joinIfBase(localAppData, "Microsoft", "WindowsApps", "claude.exe"),
  ].filter(Boolean);
}
function _isWindowsSpawnableBinary(path) {
  return /\.exe$/i.test(path);
}
function _lookupLines(out) {
  return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
function _warnUnspawnableWindowsMatches(lines) {
  const unspawnable = lines.filter(p => !/\.exe$/i.test(p));
  if (unspawnable.length > 0) {
    console.warn(`[init] Ignoring non-exe Windows claude command(s): ${unspawnable.join(", ")}`);
  }
}
function resolveClaude() {
  const isWin = process.platform === "win32";
  if (process.env.CLAUDE_BIN) {
    if (isWin && !_isWindowsSpawnableBinary(process.env.CLAUDE_BIN)) {
      console.error(
        `FATAL: CLAUDE_BIN="${process.env.CLAUDE_BIN}" is not a native Windows executable.\n` +
        "  Set CLAUDE_BIN to claude.exe; shell shims cannot be spawned without a shell."
      );
      process.exit(1);
    }
    try {
      accessSync(process.env.CLAUDE_BIN, constants.X_OK);
      return process.env.CLAUDE_BIN;
    } catch {
      console.error(`FATAL: CLAUDE_BIN="${process.env.CLAUDE_BIN}" is set but not executable.`);
      process.exit(1);
    }
  }

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = isWin
    ? _collectWindowsClaudeCandidates()
    : [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
        join(home, ".local/bin/claude"),
        ..._collectNodeManagerCandidates(home),
      ];
  for (const p of candidates) {
    try { accessSync(p, constants.X_OK); console.warn(`[init] CLAUDE_BIN not set, resolved to ${p}`); return p; } catch {}
  }

  if (isWin) {
    try {
      const lines = _lookupLines(execFileSync("where.exe", ["claude"], { encoding: "utf8", timeout: 5000, env: scrubInboundAuthEnv({ ...process.env }).env }));
      const resolved = lines.find(_isWindowsSpawnableBinary);
      if (resolved) { console.warn(`[init] CLAUDE_BIN not set, resolved via where.exe: ${resolved}`); return resolved; }
      _warnUnspawnableWindowsMatches(lines);
    } catch {}
  } else {
    try {
      const resolved = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 5000, env: scrubInboundAuthEnv({ ...process.env }).env }).trim();
      if (resolved) { console.warn(`[init] CLAUDE_BIN not set, resolved via which: ${resolved}`); return resolved; }
    } catch {}
  }

  console.error(
    "FATAL: claude binary not found.\n" +
    (isWin
      ? "  Set CLAUDE_BIN to the absolute path of claude.exe or ensure claude.exe is in PATH.\n" +
        "  Hint: npm .cmd/.bat/.ps1 shims cannot be spawned without a shell.\n" +
        "  The .exe requirement is an intentional allow-list for shell-less spawning.\n"
      : "  Set CLAUDE_BIN=/path/to/claude or ensure claude is in PATH.\n" +
        "  Hint: if you use nvm/fnm/asdf, set CLAUDE_BIN to the absolute path\n" +
        "  shown by `which claude` in your interactive shell.\n") +
    "  Checked: " + candidates.join(", ")
  );
  process.exit(1);
}

// ── OCP system prompt wrapper (Phase 6c port — ADR 0009 Amendment 1 analogue) ─
// Injected via `--system-prompt-file` (#453; it was `--system-prompt` until then, and the value
// is no longer in argv), replacing claude CLI's default system prompt (which normally includes
// cwd, OS, tool descriptions, and git status — all irrelevant and potentially misleading when the
// model is accessed via the OCP HTTP proxy).
//
// Authority: claude CLI § --system-prompt (ported from OLP, verified v2.1.104; behavior stable
// through v2.1.158 — OLP ADR 0009 Amendment 1 § "OLP system prompt wrapper"; ported to OCP
// 2026-05-30). THAT VERIFICATION IS FOR --system-prompt AND DOES NOT TRANSFER: --system-prompt-file
// was verified separately and much later, and carries a narrower measured range. See
// spawnClaudeProcess's write site for it -- the version note lives with the code that depends on
// it rather than here, because this comment is 1400 lines away and the last time a citation sat
// that far from its subject it went stale without anything noticing.
// Reference: https://github.com/dtzp555-max/olp commit 97e7d16 (Phase 6c)
const OCP_SYSTEM_PROMPT_WRAPPER = `You are accessed via the OCP HTTP proxy. You do NOT have access to any local filesystem, working directory, shell, git status, or machine environment. Do not infer or invent such information from any context you observe. Respond only based on the conversation provided.`;

// Positive counterpart used only when OCP_LOCAL_TOOLS=1 — a single-user, loopback-bound instance
// where the operator's own model legitimately has tools (the `-p` path passes --allowedTools). Tells
// the model it MAY use them instead of disclaiming access it actually holds. Off by default; the
// default wrapper above is byte-for-byte unchanged. Selecting the positive wrapper does NOT expand
// the tool surface (governed independently by --tools/--disallowedTools, and NOT by --allowedTools,
// which only pre-approves; see lib/prompt.mjs for the measurements) — it only changes the prompt —
// and is boot-gated below (multi/non-loopback/anon → refuse) mirroring OCP_TUI_FULL_TOOLS.
// The `--tools` half was added when an independent review found this the THIRD copy of the same
// omission, after README.md and lib/prompt.mjs. It was the least wrong of the three -- it carries
// no over-claim, only a gap -- which is exactly why it survived two passes.
const OCP_LOCAL_TOOLS_WRAPPER = `You are accessed via the OCP HTTP proxy running on the operator's own machine. Unlike the shared-gateway posture, you may use your available local tools to act on the operator's machine as the task requires. Use only the tools you actually have — do not assume filesystem, shell, or other access beyond the tool set provided to you in this session.`;

// OCP_LOCAL_TOOLS is inert in TUI mode: the interactive (non-`-p`) path composes its own prompt via
// callClaudeTui/messagesToPrompt and never calls extractSystemPrompt, so the wrapper is only ever
// applied on the `-p` path. LOCAL_TOOLS_ACTIVE is the single source of truth (hoisted once, house
// style) used by the wrapper selection, the boot gate, and the startup notice — so the flag is
// enabled/announced/gated in exactly the mode where it has an effect. (TUI tool surface is governed
// by OCP_TUI_FULL_TOOLS instead.)
const LOCAL_TOOLS = process.env.OCP_LOCAL_TOOLS === "1";
const LOCAL_TOOLS_ACTIVE = LOCAL_TOOLS && process.env.CLAUDE_TUI_MODE !== "true";

// The wrapper actually prepended to each request's system prompt, chosen once at startup.
const SYSTEM_PROMPT_WRAPPER = selectPromptWrapper(LOCAL_TOOLS_ACTIVE, OCP_SYSTEM_PROMPT_WRAPPER, OCP_LOCAL_TOOLS_WRAPPER);

// Build the full system-prompt string: SYSTEM_PROMPT_WRAPPER prepended,
// then any system-role messages from the request appended (separated by blank line),
// then the operator-wide CLAUDE_SYSTEM_PROMPT appended LAST (lib/prompt.mjs — a
// no-op returning the same string when the var is unset, so the default path is
// byte-for-byte unchanged). ADR 0009 Amendment 1 analogue § "OLP system prompt wrapper".
function extractSystemPrompt(messages) {
  const systemMessages = (messages ?? []).filter(m => m.role === "system");
  if (systemMessages.length === 0) {
    return appendOperatorPrompt(SYSTEM_PROMPT_WRAPPER, SYSTEM_PROMPT);
  }
  const clientContent = systemMessages.map(m =>
    contentToText(m.content)
  ).join("\n\n");
  return appendOperatorPrompt(`${SYSTEM_PROMPT_WRAPPER}\n\n${clientContent}`, SYSTEM_PROMPT);
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
// @param {boolean} sawTextDelta — true if a streaming content_block_delta text was already seen
function parseStreamJsonEvent(event, sawTextDelta) {
  const t = event?.type;

  // system/* — first-event init + other system meta (api_retry etc.)
  if (t === "system") return null;
  // user — echo of user message; consumed
  if (t === "user") return null;

  // stream_event — contains nested content_block_delta
  if (t === "stream_event") {
    const inner = event.event ?? event;
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { text: inner.delta.text ?? "", fromDelta: true };
    }
    // Other stream_event sub-types (content_block_start, message_delta, etc.) — consumed
    return null;
  }

  // assistant — aggregate message. claude CLI without --include-partial-messages emits NO
  // content_block_delta events; each assistant message arrives as its own aggregate `assistant`
  // event. An agentic/tool-using turn has SEVERAL (preamble + one per tool round + final answer),
  // so we must accumulate the text of EVERY such event. The prior `isFirstDelta` guard kept only
  // the FIRST message's text and dropped the rest — silently losing the post-tool-use final answer
  // on every tool-using turn (verified v2.1.104 through v2.1.211; see PR body capture).
  // The only real hazard is the delta+aggregate DOUBLE-COUNT: if streaming deltas were already
  // seen (sawTextDelta), the aggregate duplicates them — ignore it.
  // Reference: OLP commit 65f945c (assistant-aggregate fallback, fold-in).
  if (t === "assistant") {
    if (!sawTextDelta) {
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
// Max attempts (initial + retries) to coerce a valid structured-output (OpenAI response_format)
// JSON response out of the model before rejecting. See runStructuredCompletion.
// Fail closed on a non-numeric value via resolveMaxAttempts(): the old `Math.max(1, parseInt("abc",10))`
// === `Math.max(1, NaN)` === NaN, which made the retry loop `attempt < NaN` never execute → 0 spawns,
// every structured request silently refused. The helper rejects NaN/non-finite/<1 and keeps the
// documented default of 3. (PR #153 review round 2, NaN-guard must-fix.)
const STRUCTURED_MAX_ATTEMPTS = resolveMaxAttempts(
  process.env.OCP_STRUCTURED_MAX_ATTEMPTS,
  { fallback: 3, warn: (m) => console.warn(`[init] ${m}`) },
);
const MCP_CONFIG = process.env.CLAUDE_MCP_CONFIG || "";
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
// ADR 0020 (#446). Public DNS names that may vouch for a same-origin request, and that are
// admitted as an Origin outright. Empty by default: IP literals and RFC 6761/6762 reserved names
// need no declaration, so the ONLY deployment that has to set this is one reached by a real public
// DNS name — which is also the only deployment DNS rebinding can imitate. See lib/host-gate.mjs.
const ALLOWED_HOSTS = parseAllowedHosts(process.env.OCP_ALLOWED_HOSTS);
const NO_CONTEXT = process.env.CLAUDE_NO_CONTEXT === "true";
// Config epoch for the response cache (issue #176). The cache key hashes model + messages +
// sampling params, but the ANSWER also depends on boot-time server config that shapes the
// composed prompt / tool surface: the operator system prompt (#175), the OCP wrapper text,
// the allowed-tools set, and NO_CONTEXT. The cache store is SQLite-backed and survives
// restarts, so without this an operator who changes any of these and restarts keeps serving
// answers composed under the OLD config until TTL expiry. Folding a digest of the four into
// every cache key makes any change an instant, whole-cache invalidation — the honest behavior.
// Deliberately boot-time-only: runtime-mutable settings (e.g. maxPromptChars via the settings
// API) are excluded because a const epoch cannot track them; truncation also only drops
// context rather than changing the instruction set.
const CONFIG_EPOCH = cryptoCreateHash("sha256")
  .update(JSON.stringify([SYSTEM_PROMPT, SYSTEM_PROMPT_WRAPPER, ALLOWED_TOOLS, NO_CONTEXT]))
  .digest("hex").slice(0, 16);
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

// #327, additive under ADR 0012. A non-primary OCP instance names itself.
//
// A host can legitimately run more than one instance — the documented case is an isolated
// backend for an agent that serves untrusted users, bound to loopback under its own Unix user so
// the `claude` children it spawns cannot inherit the primary's identity. Nothing in OCP could
// express that, so a second instance was indistinguishable from a leftover duplicate: `ocp
// doctor`'s multi-unit check reported "too many candidates" on a correct configuration, every
// run, and a version sweep that probed only the default port silently missed the other one.
//
// Empty is the default and means "the primary". The value is an operator label, not an
// identifier OCP acts on — nothing branches on it.
const INSTANCE_NAME = (process.env.OCP_INSTANCE_NAME || "").trim();
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
  streamTurns: 0,            // streamed TUI turns ATTEMPTED (counted before the honesty gates — F6)
  streamDeltas: 0,           // MessageDisplay hook fires OBSERVED (forwarded + held-back — F6)
  streamTopUps: 0,           // turns where the delta stream != T but was a safe PREFIX of it
  streamDivergences: 0,      // turns REFUSED: emitted bytes were not a prefix of T
  streamZeroDeltaTurns: 0,   // streamed turns where the hook fired ZERO times (F7 — the hook is
                             // dead, not just one fire dropped; distinct from streamTopUps)
};

// ── TUI real streaming (backlog #2) — opt-in; default OFF ────────────────
// When ON *and* TUI_MODE is on *and* the client asked for stream:true, the turn is emitted
// as real SSE delta.content chunks as claude renders them, sourced from claude's own
// MessageDisplay hook (lib/tui/stream.mjs). When OFF, the buffered
// callClaudeTui → streamStringAsSSE path below is byte-for-byte unchanged — the spawn does
// not even get --settings. Opt-in is deliberate: the buffered path is stable production.
//
// Honest expectation (docs/plans/2026-07-13-tui-latency/streaming-spike.md): this moves the
// FIRST byte, not the last. A consumer that must parse a complete reply gains nothing; a
// progressively-rendering chat UI gains the ~4s between first delta and last. It does not
// move the ~6s TTFT floor of TUI mode.
const TUI_STREAM = process.env.OCP_TUI_STREAM === "1";
const TUI_STREAM_DIR = process.env.OCP_TUI_STREAM_DIR || `${process.env.HOME}/.ocp-tui/stream`;
// First-bytes holdback — the auth-banner gate's (C-1) survival mechanism under streaming.
// See TuiDeltaAssembler: nothing is emitted for a message until its TRIMMED accumulation
// exceeds this, which puts it out of the default banner detector's <=100-char reach — the
// FIRST of the two halves of the guarantee (see the assembler's class comment for the second:
// no further emission at all once a message boundary follows an emit). Only raise it.
// resolveStreamHoldback enforces the DEFAULT_HOLDBACK_CHARS floor: the "Only raise it" comment
// above is now load-bearing, not advisory. A sub-floor value (or garbage) is clamped UP to the
// floor and reported via `_holdback.clamped`, because a holdback below the default banner
// detector's 100-char reach would let the first chars of a real auth banner stream before the
// end-of-turn gate rejects the turn (the A1 leak). We can only ever raise the guarantee, never
// weaken it below the detector's bound.
const _holdback = resolveStreamHoldback(process.env.OCP_TUI_STREAM_HOLDBACK);
const TUI_STREAM_HOLDBACK = _holdback.value;
if (TUI_MODE && TUI_STREAM && _holdback.clamped) {
  console.error(
    `[tui] WARNING: OCP_TUI_STREAM_HOLDBACK=${JSON.stringify(process.env.OCP_TUI_STREAM_HOLDBACK)} is below the\n` +
    `  safe floor (${DEFAULT_HOLDBACK_CHARS}) or not a number; clamped up to ${DEFAULT_HOLDBACK_CHARS}. The holdback can only be raised.`
  );
}
if (TUI_MODE && TUI_STREAM && process.env.CLAUDE_TUI_ERROR_PATTERNS != null && TUI_STREAM_HOLDBACK <= DEFAULT_HOLDBACK_CHARS) {
  // The holdback's FIRST-MESSAGE half (see TuiDeltaAssembler) is sound for the DEFAULT
  // auth-banner detector (which cannot match a message longer than 100 chars). An
  // operator-supplied pattern set has no such bound, so a banner longer than the holdback
  // could reach the client before the terminal gate rejects the turn. (The second half — no
  // further emission once a message boundary follows an emit — holds regardless of the
  // detector; this warning is only about the first-message case.)
  console.error(
    `[tui] WARNING: OCP_TUI_STREAM=1 with a custom CLAUDE_TUI_ERROR_PATTERNS and holdback=${TUI_STREAM_HOLDBACK}.\n` +
    "  The streaming holdback's first-message coverage is sound only against the DEFAULT banner\n" +
    "  detector (<=100 chars). Raise OCP_TUI_STREAM_HOLDBACK above your longest custom banner, or\n" +
    "  the first chars of one could be streamed before the end-of-turn gate refuses the turn."
  );
}

// ── Warm pane pool (docs/plans/2026-07-13-tui-latency #3) — opt-in; default OFF ─────────
// OCP_TUI_POOL_SIZE=0 (default) => tuiPool is null => runTuiTurn's cold-boot path is
// byte-for-byte unchanged. Set it to N (clamped to POOL_MAX_SIZE) to keep N pre-booted
// `claude` panes warm, each SINGLE-USE (see lib/tui/pool.mjs for why single-use is the
// load-bearing rule, and lib/tui/session.mjs for the POOL/REAPER INVARIANT).
//
// Default-off is deliberate on a stable production path: a warm pane is a LIVE idle
// `claude` process held whether or not a request ever arrives, so the operator must opt
// in to that standing cost. Measured saving when on (this host, Sonnet 4.6, --effort low):
// end-to-end p50 10.17 s (n=6, pool off) -> 6.00 s (n=12 warm hits), i.e. -41%.
// cli.js does NOT perform this operation (Class B, OCP-owned TUI spawn) — see ADR 0007.
const TUI_POOL_SIZE = TUI_MODE ? resolvePoolSize(process.env.OCP_TUI_POOL_SIZE) : 0;
const tuiPool = TUI_POOL_SIZE > 0
  ? new TuiPanePool({
      size: TUI_POOL_SIZE,
      // The POOL mints the pane's identity, not bootTuiPane: the tmux session exists the
      // instant the boot starts, so the pool must be able to name (hence spare, hence kill)
      // it before then. Name is derived from the session-id, so `tmux ls` correlates to the
      // transcript file <HOME>/.claude/projects/*/<sessionId>.jsonl.
      mintPane: () => {
        const sessionId = randomUUID();
        return { sessionId, name: poolPaneName(PORT, sessionId) };
      },
      bootPane: (model, ident) => bootTuiPane({
        model,
        claudeBin: CLAUDE,
        home: TUI_HOME,
        realHome: process.env.HOME,
        cwd: TUI_CWD,
        port: PORT,
        entrypointMode: TUI_ENTRYPOINT,
        sessionId: ident.sessionId,
        name: ident.name,
        requireReady: true,     // a pane that never reached its input bar must not be enlisted
        bootMs: POOL_BOOT_MS,   // background pre-boot — no client is blocked, so be patient
        // Warm panes must carry the MessageDisplay hook too, or every pool HIT would
        // silently fall back to buffered while every MISS streamed — the two paths have to
        // spawn identically (F4). Gated on TUI_STREAM, the deployment-wide switch — NOT on any
        // particular request's stream:true/false, which does not exist yet at pre-boot time.
        // The runTuiTurn cold-boot call site (callClaudeTui, below) mirrors this exact gate for
        // the same reason. bootTuiPane derives the sink from the pane's own session-id, which is
        // minted above, so nothing request-specific is baked in at pre-boot time.
        streamDir: TUI_STREAM ? TUI_STREAM_DIR : null,
      }),
      killPane: (name) => { try { spawnSync(process.env.OCP_TUI_TMUX_BIN || "tmux", ["kill-session", "-t", name]); } catch { /* already gone */ } },
      paneHealthy: (name) => tuiPaneHealthy((args) => spawnSync(process.env.OCP_TUI_TMUX_BIN || "tmux", args, { encoding: "utf8" }), name),
      log: (level, event, data) => logEvent(level, event, data),
    })
  : null;

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
    // mode 0700, and it matters for the PARENT: with `recursive`, this call can create ~/.ocp
    // itself on a fresh install (spawn homes live under it), and without an explicit mode that
    // parent lands at the umask default — world-listable 0755. keys.mjs used to pre-create it
    // 0700 as an import side effect; it no longer does (it resolves its dir lazily), so the
    // 0700 guarantee has to be stated here rather than inherited by luck.
    mkdirSync(`${dir}/.claude`, { recursive: true, mode: 0o700 });
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
// The expiry gate is extracted to lib/spawn-token.mjs so a unit test can drive it without booting
// server.mjs (#343). Production passes NO injection → byte-for-byte identical to the inline gate it
// replaces (defaultIsTokenExpiring IS the real isTokenExpiring; now defaults to Date.now()).
const resolveSpawnTokenCore = makeResolveSpawnToken();
function resolveSpawnToken() {
  try {
    return resolveSpawnTokenCore(getOAuthCredentials());
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

// Tagged error for audit finding F2: the client disconnected while queued (or was already gone
// before we even tried to queue it). Distinct from ConcurrencyOverflowError so callers never send
// a response on this path — there is no socket left to write to.
class RequestDisconnectedError extends Error {
  constructor(message) { super(message); this.name = "RequestDisconnectedError"; }
}

// Build an AbortSignal that fires when `res` (an http.ServerResponse) closes — i.e. the client
// disconnected. Used to cancel a QUEUED concurrency-slot wait (F2) so a client that gives up
// before a slot is granted is spliced out of the wait queue instead of eventually spawning a
// claude process for a dead socket. If `res` has already closed by the time we get here (its
// underlying stream already torn down), the signal is returned pre-aborted so acquire() rejects
// immediately without ever touching the queue — the "close already fired before we attach" case.
// `detach()` MUST be called once the wait settles (granted or rejected) to avoid a listener leak.
function closeSignalFor(res) {
  const controller = new AbortController();
  if (!res || typeof res.on !== "function") return { signal: controller.signal, detach() {} };
  if (res.destroyed) {
    controller.abort();
    return { signal: controller.signal, detach() {} };
  }
  const onClose = () => controller.abort();
  res.on("close", onClose);
  return { signal: controller.signal, detach() { res.removeListener("close", onClose); } };
}

// Acquire a -p concurrency slot, queuing if all are busy (up to CLAUDE_MAX_QUEUE). Resolves to a
// release() fn that MUST be called exactly once on every exit path (wired into ctx.cleanup()).
// Rejects with ConcurrencyOverflowError when the wait-queue is full, or with
// RequestDisconnectedError when `res` closes before a slot is granted (F2) — the caller must not
// spawn claude in that case. `res` is optional (back-compat for any caller without a live response
// object); omitting it just means a queued wait can't be cancelled early.
//
// F8 fix: stats.queued is set from claudeSemaphore.queued AFTER calling acquire() (not before) —
// acquire() synchronously updates _inflight/_waiters before its Promise ever resolves, so reading
// .queued right after the call already reflects reality. The old code set `queued + 1` BEFORE
// calling acquire() to account for "this waiter", which over-reported by 1 whenever the slot was
// granted immediately (the common case, not a queue at all).
async function acquireClaudeSlot(res) {
  const { signal, detach } = closeSignalFor(res);
  const slot = claudeSemaphore.acquire(signal);
  stats.queued = claudeSemaphore.queued; // accurate: acquire() already updated the queue synchronously
  try {
    await slot;
  } catch (e) {
    detach();
    stats.queued = claudeSemaphore.queued;
    if (e instanceof SemaphoreAbortError) {
      // Client-driven cancellation, not backpressure — do NOT count it as a queueRejection or
      // log it as concurrency_queue_full (that log/counter means "the queue itself is full").
      logEvent("info", "concurrency_wait_cancelled", {
        reason: "client_disconnected", inflight: claudeSemaphore.inflight, queued: claudeSemaphore.queued,
      });
      throw new RequestDisconnectedError("client disconnected while waiting for a concurrency slot");
    }
    stats.queueRejections++;
    logEvent("warn", "concurrency_queue_full", {
      limit: claudeSemaphore.limit, maxQueue: claudeSemaphore.maxQueue,
      inflight: claudeSemaphore.inflight, queued: claudeSemaphore.queued,
    });
    throw new ConcurrencyOverflowError(
      `backpressure: concurrency limit (${claudeSemaphore.limit}) reached and wait queue ` +
      `(${claudeSemaphore.maxQueue}) is full — retry shortly`);
  }
  detach();
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

// OCP_LOCAL_TOOLS safety gate (mirrors the OCP_TUI_FULL_TOOLS model, ADR 0007): the positive
// "you may use local tools" system-prompt wrapper is single-user only, so refuse to boot if it
// could reach an untrusted caller. Fail-closed on multi-tenant auth, a non-loopback bind, or an
// anonymous key. The pure predicate lives in lib/prompt.mjs (unit-tested); the exit stays here.
const _localToolsBootError = localToolsSafetyError({
  enabled: LOCAL_TOOLS_ACTIVE,
  authMode: AUTH_MODE,
  loopbackBind: isLoopbackBind(BIND_ADDRESS),
  anonymousKey: !!PROXY_ANONYMOUS_KEY,
});
if (_localToolsBootError) {
  console.error(`FATAL: ${_localToolsBootError}\n  See README § "Environment Variables" (OCP_LOCAL_TOOLS) and docs/adr/0007-tui-interactive-mode.md. Refusing to start.`);
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

// ── Session management: REMOVED (ADR 0016) ──────────────────────────────
// The `sessions` Map, its TTL reaper and `_sessionKey()` were REMOVED here under ADR 0016.
// PR #103 (merge commit 885f62a, 2026-05-30) deleted the only `sessions.set(...)` — 1 deletion,
// 0 additions — because per-request spawning with messagesToPrompt made it unnecessary; see the
// comment above spawnClaudeProcess. The Map survived twelve releases with no writer, so every
// surface reading it reported a constant dressed as a measurement. Nothing replaces it: on the
// `-p` path a "session" is not a thing OCP has, and TUI mode's warm pane pool reports itself
// through `tui.pool` (ADR 0007). Do not re-add a counter here without wiring a writer in the
// same change — that is the failure ADR 0016 exists to stop repeating.

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
//
// WARM POOL INTERACTION (the crux — see the POOL/REAPER INVARIANT in lib/tui/session.mjs).
// A warm pooled pane is one of OUR OWN ocp-tui-<port>-* sessions that is alive and idle BY
// DESIGN, and this sweep fires precisely when the instance is idle — i.e. exactly when the
// pool is full. Two things are therefore required, and both are done here:
//   (a) DRAIN the pool BEFORE the sweep. Zombie reaping is possible ONLY via kill-server,
//       and a live pooled pane suppresses kill-server (it is a live child of the tmux
//       server). A permanently-full pool would otherwise permanently disable the very
//       thing this tick exists to do. Draining costs a FULL POOL re-boot per tick — drain()
//       drops every warm pane and resume() refills serially back to OCP_TUI_POOL_SIZE, so it
//       is that many boots (~1.2 s each), not one, every 15 min — and is invisible to
//       callers: a request landing in the
//       drain→refill gap simply MISSES the pool and takes today's cold path.
//   (b) Pass the pool's live registry as `spare` anyway. After (a) it is empty, so this is
//       belt-and-braces — it makes it impossible for THIS call site (or a future one) to
//       kill a live pooled pane even if the drain were ever removed or reordered.
// RESIDUAL (unchanged in kind from the pre-pool code, and explicitly accepted there): a
// request arriving in the narrow window between the idle-check and kill-server has its pane
// torn down and fails cleanly via runTuiTurn's honesty gates. The drain widens that window
// by the cost of N kill-session calls (single-digit ms), not materially.
const TUI_REAP_INTERVAL_MS = 15 * 60 * 1000;
const tuiReapInterval = TUI_MODE ? setInterval(() => {
  if (tuiSemaphore.inflight > 0 || tuiSemaphore.queued > 0) return; // a turn is live — defer
  try {
    const drained = tuiPool ? tuiPool.drain() : 0;
    // F7 fix: scope to THIS instance's own port; a sibling ocp-tui-<otherPort>-* session
    // (a second OCP instance on the same host) is treated as foreign, same as olp-tui-*.
    // includeLegacy is NOT set here — see reapStaleTuiSessions' comment: the periodic sweep
    // conservatively treats any lingering bare-prefix legacy session as foreign so it can
    // never trigger kill-server on a steady-state tick; only the one-time boot reap below
    // claims legacy-shaped zombies.
    const n = reapStaleTuiSessions({ port: PORT, spare: tuiPool ? tuiPool.liveNames() : null });
    if (n || drained) {
      logEvent("info", "tui_reaped_stale_sessions", { count: n, poolDrained: drained, trigger: "periodic" });
    }
  } catch (e) { logEvent("error", "tui_periodic_reap_failed", { error: e.message }); }
  finally {
    // Refill in the background regardless of how the sweep went — a throw mid-sweep must not
    // leave the pool permanently paused (it would silently degrade to the cold path forever).
    if (tuiPool) { try { tuiPool.resume(); } catch { /* best effort */ } }
  }
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
  // sessionHits / sessionMisses removed here under ADR 0016 Amendment 1. `git show 885f62a`
  // (PR #103) deletes `stats.sessionHits++` and `stats.sessionMisses++` in the same hunk as
  // `sessions.set(...)`, so both were permanently 0 from then on. They reached the wire via the
  // bare `stats,` shorthand in GET /health — which is why deleting two declarations here was a
  // Class B.2 response-shape change and needed an authorization rather than a tidy-up.
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
// Both tunables go through parseIntEnv (hoisted below), so an empty / NaN / non-positive value
// falls back to the default rather than silently disabling or bricking the probe — the same
// fail-closed discipline CLAUDE_MAX_PROMPT_CHARS uses.
const AUTH_CHECK_INTERVAL_MS = parseIntEnv("CLAUDE_AUTH_CHECK_INTERVAL_MS", 600000);
// The 10s bound is DELIBERATELY unchanged by #232 and is still correct now that the probe no
// longer blocks: it bounds a stuck child, and lengthening it would only widen the window in
// which authStatus is stale. A longer timeout was explicitly NOT the fix — the defect was that
// a SYNCHRONOUS execFileSync held the whole event loop for the duration.
const AUTH_CHECK_TIMEOUT_MS = parseIntEnv("CLAUDE_AUTH_CHECK_TIMEOUT_MS", 10000);

// How many CONSECUTIVE conclusive rejections before the proxy calls itself degraded (ADR 0010).
// One rejection can be a token mid-refresh race; two consecutive is a real condition.
const AUTH_DEGRADE_AFTER = 2;


let authStatus = {
  ok: null,                  // last CONCLUSIVE verdict: true | false | null (never established)
  lastCheck: 0,              // when the last probe COMPLETED, any outcome
  message: "",               // human-readable detail of the last probe
  // Domain: "none" | "authenticated" | "token-present" | "rejected" | "timeout" | "unavailable".
  //
  // NOT the authority, and the tiebreak is scoped rather than absolute: ADR 0014 § B's table
  // governs the five PROBE OUTCOMES, and if this line disagrees with it about one of those, the
  // ADR wins and this line is the bug. "none" is deliberately outside that table — it is the
  // pre-probe initial value on the next line, not an outcome any probe produces. An earlier
  // revision of this comment gave an unscoped "the ADR wins", which read literally would have
  // deleted the very value it annotates. README § "What `auth.ok` means" covers the same domain
  // for operators but is NOT the same table — it is keyed on okSource, carries a `none` row, and
  // omits timeout/unavailable, because those change lastOutcome without touching the verdict.
  // Calling the two "the same" would re-conflate okSource with lastOutcome, which is the exact
  // confusion lib/spawn-auth.mjs:199 exists to warn about.
  //
  // This is a reading aid and it has already drifted once: it omitted "token-present" from the day
  // ADR 0014 shipped it until #345, so the only enumeration in CODE contradicted the docs. The
  // values are written by checkAuth's branches below; that is where to look for what sets what.
  lastOutcome: "none",
  consecutiveFailures: 0,    // consecutive CONCLUSIVE rejections only
  // #324, additive under ADR 0012. Consecutive INCONCLUSIVE probes (timeout / unavailable) since
  // the last conclusive one. Reset to 0 by BOTH conclusive outcomes, so it means "nothing has
  // concluded in this many probes", never "things have been bad for a while".
  //
  // It exists because `ok` alone cannot express staleness: an inconclusive probe deliberately
  // preserves the last conclusive `ok` (right — a timeout measures host load, not credentials),
  // and that composes into a latch only a conclusive success can clear, which a reliably-timing-out
  // probe never produces. `ok` is deliberately NOT changed by this counter: the last conclusive
  // verdict really was what it was, and rewriting it would be a contract change on a grandfathered
  // B.2 field (the ADR 0010 test). Consumers that must DECIDE — doctor, and through it the
  // `ocp update` gate — read this alongside `ok` instead.
  consecutiveInconclusive: 0,
  // #308 / ADR 0014. HOW and WHEN `ok` was established — distinct from lastOutcome/lastCheck,
  // which describe the last PROBE. Conflating them made the freshness window both unreachable
  // under the default config and permanently disarmable by a single inconclusive probe.
  okSource: "none",          // "none" | "probe" | "request" | "expired"
  okAt: 0,                   // when `ok` was established, by whichever source
};

// The single definition of "can this proxy serve?", used by BOTH /status and /health (#232).
// Those two carried byte-identical copies of the old expression; a shared function is what keeps
// them from drifting. Value domain is exactly {"ok","degraded"} — dashboard.html and
// ocp-plugin/index.js compare against those two strings, so do not invent a third. See ADR 0010.
// #308 / ADR 0014. How long a verdict established by a REAL REQUEST stays fresh.
//
// A successful completion is the strongest evidence OCP can have that the credential works —
// stronger than any probe, and free, because the request was happening anyway. But a raised
// verdict that never expires is a latch, and on an env-token host NOTHING can lower it: the
// `claude auth status` probe exits 0 whenever a token is merely PRESENT (measured: a fabricated
// token yields exit 0 / loggedIn:true), so it can never contradict a stale `true`. That is
// #324's defect shape in the opposite direction, with no clearing path at all — the criterion
// from that issue applies here: do not ask what the clearing condition is, ask whether it is
// REACHABLE.
//
// So the raise expires. Past the window with no new success, the honest value is `null` —
// "it worked, that was a while ago, we do not know now" — which is a state ADR 0010 already
// defines and doctor already treats as WARN rather than FAIL. A serving proxy refreshes this on
// every request and never decays; only one that has stopped succeeding does.
const AUTH_REQUEST_VERDICT_TTL_MS = 900000; // 15 min

// #308: a completed request proves the credential is valid. Called from THREE success paths, not
// two: callClaude's and callClaudeStreaming's `claude_ok` branches (the default -p lanes), and
// callClaudeTui's post-honesty-gate success (#361 — the TUI lane, which logs no `claude_ok` of its
// own, so "both claude_ok sites" no longer locates the callers). `grep -n 'noteAuthVerifiedByRequest()'`
// is the durable form of this list; the count in prose is not.
//
// WHAT THIS FUNCTION WRITES IS DOCUMENTED IN THE BODY, NOT HERE — deliberately, and this is the
// second time that decision has had to be made. This header used to assert "deliberately does NOT
// touch consecutiveFailures", three lines above the code that clears it. The correction was
// written into the body and THIS HEADER WAS LEFT STANDING, so the comment recording the fix sat
// *below* the sentence that was still wrong, and the pair shipped together until #361's review
// opened the file. The rule is immediately below, stated once in this file.
//
// THERE IS EXACTLY ONE OTHER LIVE STATEMENT OF IT, AND IT IS NAMED HERE ON PURPOSE:
// README § "What `auth.ok` means" carries the operator-facing version. That copy exists because
// its audience is different — operators debugging `status` never read this file — but a second
// copy is still a second thing that can drift, and it did: an earlier revision of this comment
// claimed "one copy is the only version that cannot drift again" while the README simultaneously
// said "`status` is unaffected by any of this", which the tally clear makes false. Both were
// corrected in #361. Change one, change the other, and check both against ADR 0014 § Consequences,
// which is the authority they each restate rather than a third copy.
function noteAuthVerifiedByRequest() {
  const now = Date.now();
  // Does NOT touch lastOutcome/lastCheck: those belong to the probe, and overwriting them would
  // make /health claim a probe ran when none did. It DOES clear consecutiveFailures — a completed
  // request is direct evidence the credential is not being refused, and ADR 0014 § Consequences
  // names that clear as "a deliberate restoration of ADR 0010's self-heal", unqualified by which
  // lane served the request. Note what that does and does not license: proxyHealthStatus reads
  // consecutiveFailures and never `ok`, so the VERDICT cannot move /health.status, but clearing
  // the TALLY can. That distinction is the whole finding — it is easy to state as either "status
  // is untouchable here" or "requests move status", and both are wrong.
  // An earlier revision of the header above said "deliberately does NOT touch consecutiveFailures"
  // three lines above the code that writes it; the reviewer who caught that was reading the
  // comment, which is what comments are for. (The header itself was only corrected in #361 — the
  // fix had been applied here and nowhere else, which is the drift this note now guards.)
  authStatus = { ...authStatus, ok: true, okSource: "request", okAt: now,
                 message: "verified by a completed request", consecutiveFailures: 0 };
}

// #308: apply the TTL at READ time rather than on a timer — no extra interval to keep alive, and
// the value is correct the instant it is asked for rather than up to one tick late.
function effectiveAuthStatus(now = Date.now()) {
  return applyRequestVerdictTtl(authStatus, now, AUTH_REQUEST_VERDICT_TTL_MS);
}

function proxyHealthStatus(binaryOk) {
  if (!binaryOk) return "degraded";
  if (authStatus.consecutiveFailures >= AUTH_DEGRADE_AFTER) return "degraded";
  return "ok";
}

// One probe at a time. The probe is an idempotent diagnostic, so stacking spawns when the host
// is already slow is exactly the pathology being fixed — a loaded host makes probes run long,
// and overlapping probes would then add spawn pressure to the very host that is struggling.
let authProbeInFlight = false;

async function checkAuth() {
  if (authProbeInFlight) return;
  authProbeInFlight = true;
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // #328: OCP's own INBOUND credentials must not reach a child. Applied here too, not only on
    // the request path, because this child is spawned from the same process env and a future
    // change could give it a wider role than `auth status`.
    scrubInboundAuthEnv(env);
    // ASYNC execFile, not execFileSync (#232). Marking the function `async` never made the old
    // synchronous call non-blocking: it froze the event loop for up to AUTH_CHECK_TIMEOUT_MS at
    // boot (before server.listen()) and again on every interval tick.
    // NOT unref()'d, deliberately. An unref'd execFile child silently drops its callback if
    // nothing else is holding the event loop open — measured: with a keepalive the callback
    // fired at +505ms; without one the process exited at +803ms and it never fired at all.
    // It would be safe here only by accident (the authCheckInterval below is registered
    // synchronously right after), and it buys nothing, because gracefulShutdown always
    // process.exit()s. So: no unref, no trap for whoever moves this code next.
    await new Promise((resolve, reject) => {
      execFile(CLAUDE, ["auth", "status"],
        { encoding: "utf8", timeout: AUTH_CHECK_TIMEOUT_MS, env },
        // execFile does NOT attach stdout/stderr to the error object the way execFileSync does
        // (verified: err.stderr is undefined in the callback), so carry stderr across
        // explicitly — the message below depends on it.
        (err, _stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve()));
    });
    const tokenFromEnv = typeof env.CLAUDE_CODE_OAUTH_TOKEN === "string" && env.CLAUDE_CODE_OAUTH_TOKEN.length > 0;
    const nowP = Date.now();

    if (tokenFromEnv) {
      // Presence, not validity. But do NOT clobber a FRESHER verdict that a real request
      // established — a probe that measured less must not overwrite evidence that measured more.
      const keepRequestVerdict = authStatus.okSource === "request" &&
                                 nowP - authStatus.okAt <= AUTH_REQUEST_VERDICT_TTL_MS;
      authStatus = keepRequestVerdict
        ? { ...authStatus, lastCheck: nowP, lastOutcome: "token-present", consecutiveFailures: 0 }
        : { ...authStatus, ok: null, okSource: "probe", okAt: nowP, lastCheck: nowP,
            message: "a token is present; the probe cannot tell whether it is valid",
            lastOutcome: "token-present", consecutiveFailures: 0 };
    } else {
      authStatus = { ok: true, okSource: "probe", okAt: nowP, lastCheck: nowP, message: "authenticated",
                     lastOutcome: "authenticated", consecutiveFailures: 0, consecutiveInconclusive: 0 };
    }
  } catch (e) {
    const msg = (e.stderr || e.message || "").slice(0, 200);
    const now = Date.now();
    if (e.signal) {
      // INCONCLUSIVE. Our own timeout lands here (Node reports killed:true, signal:"SIGTERM"),
      // as does any other signal death. A probe timeout measures HOST LOAD, not credential
      // validity — proven in production, where /health reported auth.ok=false with
      // "spawnSync ... ETIMEDOUT" in the same minute that POST /v1/chat/completions returned 200
      // on the same credentials. So preserve the last conclusive `ok` and leave the tally alone.
      authStatus = { ...authStatus, lastCheck: now, message: msg, lastOutcome: "timeout",
                     consecutiveInconclusive: (authStatus.consecutiveInconclusive || 0) + 1 };
    } else if (typeof e.code !== "number") {
      // INCONCLUSIVE. A spawn failure (ENOENT / EACCES / …) means the probe never ran, so it
      // says nothing about the credentials either. Same treatment. (A missing/non-executable
      // binary is still caught — by binaryOk in proxyHealthStatus, which is a real precondition.)
      authStatus = { ...authStatus, lastCheck: now, message: msg, lastOutcome: "unavailable",
                     consecutiveInconclusive: (authStatus.consecutiveInconclusive || 0) + 1 };
    } else {
      // CONCLUSIVE REJECTION. claude ran to completion and exited non-zero. checkAuth and
      // spawnClaudeProcess scrub the environment identically, so the probe resolves the SAME
      // credentials the request path uses — a non-zero exit genuinely predicts serving failure.

      // okSource/okAt on this branch too: a conclusive rejection IS a probe-established verdict.
      // Omitting them made the fields VANISH after a rejection — a fifth state ("absent") outside
      // the domain ADR 0014 and the README document, found by execution in review.
      authStatus = { ok: false, okSource: "probe", okAt: now, lastCheck: now, message: msg,
                     lastOutcome: "rejected", consecutiveFailures: authStatus.consecutiveFailures + 1,
                     consecutiveInconclusive: 0 };
    }
    // Carries the outcome class so an operator can tell a timeout from a real rejection.
    console.error(`[auth] check ${authStatus.lastOutcome}: ${msg}`);
  } finally {
    authProbeInFlight = false;
  }
}

// Check auth on start and on every interval tick (default 10 minutes)
checkAuth();
const authCheckInterval = setInterval(checkAuth, AUTH_CHECK_INTERVAL_MS);

// ── Build CLI arguments ─────────────────────────────────────────────────
// Phase 6c port (2026-05-30): removed `-p` / `--output-format text`.
// Now uses `--output-format stream-json --verbose --no-session-persistence
// --system-prompt-file <path to a 0600 temp file holding OCP_SYSTEM_PROMPT_WRAPPER + client
// system messages>` (#453 moved that value out of argv).
//
// Authority: claude CLI § --output-format stream-json, § --verbose,
//   § --no-session-persistence (ported from OLP, verified v2.1.104; behavior stable through
//   v2.1.158). --system-prompt-file is NOT covered by that verification and is dated separately
//   at the write site below.
// Reference: OLP ADR 0009 Amendment 1 + commit 97e7d16.
//
// Session flags (--resume, --session-id) are dropped: they are incompatible
// with stream-json mode without -p. OCP always passes full conversation context
// via stdin instead (messagesToPrompt), preserving multi-turn correctness.
// CLAUDE_SYSTEM_PROMPT env var is absorbed into the system prompt via
// extractSystemPrompt() at the caller level; APPEND_SYSTEM_PROMPT no longer used.
// Note: ALLOWED_TOOLS / SKIP_PERMISSIONS / MCP_CONFIG are preserved as before.
function buildCliArgs(cliModel, systemPromptFile, opts = {}) {
  const args = [
    "--model", cliModel,
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    // --system-prompt-FILE, not --system-prompt. The value used to travel in argv, which put it
    // under the OS argv ceiling AND on a channel other local users can read. Both were measured;
    // see the block at the write site in spawnClaudeProcess for the numbers and the limits.
    "--system-prompt-file", systemPromptFile,
  ];

  // Multimodal path (issue #110): images are fed as Anthropic content blocks over
  // a stream-json stdin stream. `--input-format stream-json` (§ --input-format,
  // choices text|stream-json; realtime streaming input) is added ONLY when the
  // request carries an image part; the default (text) input path is untouched.
  if (opts.streamJsonInput) {
    args.push("--input-format", "stream-json");
  }

  // Permissions
  // ADR 0007 B-path: in multi-tenant mode, suppress operator-FS tools so a guest
  // prompt cannot drive Bash/Read/Write/Edit/etc. on the operator's filesystem.
  // For AUTH_MODE !== "multi" (none/shared — single-operator/trusted), preserve
  // existing behaviour unchanged.
  if (AUTH_MODE === "multi") {
    // EMPTY THE SCHEMA; DO NOT ENUMERATE WHAT TO REMOVE.
    //
    // `--tools` is the tool-AVAILABILITY registry -- `claude --help`: "Specify the list of
    // available tools from the built-in set. Use \"\" to disable all tools". `--disallowedTools`
    // is a DENY LIST: it can only ever deny the tools whoever wrote it knew about, so it goes
    // stale on every CLI release that adds one, silently and with no error.
    //
    // This branch used to be a hardcoded ten-entry deny-list (Bash/Read/Write/Edit/Glob/Grep/
    // WebFetch/WebSearch/Agent/mcp__*), which is the shape ADR 0007 already ruled out. Grep it
    // for "The B-path (multi-tenant isolation) requires:" -- item 1 of the 3 is `--tools ""`
    // (:138 at the time of writing; the string is the citation, the number is decorative, per
    // AGENTS.md on cross-file line references). The comment on this branch cited that B-path
    // while the code did something else.
    //
    // MEASURED 2026-08-27 on claude 2.1.247. THE INSTRUMENT MATTERS MORE THAN THE NUMBER, so
    // read this before quoting either. The authority is the `tools` array on the `system` init
    // event of `--output-format stream-json --verbose` -- the schema the CLI actually built. An
    // earlier pass asked the spawned model to name its own tools instead; the reviewer showed
    // that instrument lies, in the direction that matters: under these very flags it answered
    // "Read, Edit, Write, Glob, Grep, Bash, PowerShell" while the wire, same model same flags,
    // answered [].
    //
    // What the wire says, varying ONE thing at a time from ONE BASELINE ON ONE HOST -- and the
    // baseline's own conditions have to be named, because the table below is precisely a proof
    // that they move the answer: default model (no --model), CLAUDE_CONFIG_DIR unset, cwd inside
    // this repo's worktree, claude 2.1.247:
    //
    //   old deny-list, default model                        -> 20 tools
    //   old deny-list, + --model haiku                      -> 24
    //   old deny-list, + CLAUDE_CONFIG_DIR set              -> 16
    //   old deny-list, baseline repeated                    -> 20   (deterministic, not flaky)
    //   THIS branch's flags, default model AND haiku        ->  0
    //
    // Each row repeated identically is stable (baseline 4x, deny-list 3x, this branch 3x), so
    // these are conditions, not noise. But the exposure is still not a number: it is a FUNCTION
    // OF THE INVOCATION -- the model and the config dir move it without any CLI release, and
    // those are merely the two knobs that turned up, not a claim that they are the only two.
    // Do not "update the 20"; there is no single value to update, and that is the argument for
    // emptying the schema rather than enumerating it. THE LAST ROW is the stable one -- the
    // right-hand column is precisely what varies. (An earlier revision of this comment said
    // "the right-hand column is the only stable one", which asserts the opposite of its table.)
    //
    // Why BOTH mcp-closing flags, when either alone would do. [measured] `--tools ""` governs
    // built-ins ONLY: alone it leaves 49 tools in the schema, all of them mcp__* from
    // account-level servers. [measured] Adding EITHER `--strict-mcp-config` OR
    // `--disallowedTools mcp__*` takes that to 0 -- so on the SCHEMA axis they are
    // interchangeable, not complementary. An earlier revision of this comment claimed they were
    // "not redundant" and called that measured; the measurement cited (49 under `--tools ""`
    // alone) does not discriminate between them at all, and the claim was wrong.
    //
    // They are BOTH kept because they are not interchangeable on a second axis -- `mcp_servers`,
    // one field over in the same init event. WHERE that matters depends on the spawn's HOME, and
    // an earlier revision of this comment got that wrong, so the conditions come first. All rows
    // are `--tools "" --disallowedTools 'mcp__*'` versus adding --strict-mcp-config:
    //
    //   HOME = the operator's REAL home        deny-list alone: schema empty, but 3 account-level
    //                                          connectors report "status":"connected".
    //                                          --strict-mcp-config: mcp_servers [].
    //   HOME = <realHome>/.ocp/spawn-home      deny-list ALONE already gives 0 connected.
    //   HOME = a fresh empty directory         0 connected.
    //
    // The middle row is what THIS FILE hands the -p spawn by default (`env.HOME = decision.home`
    // below, when an OAuth token is resolvable), so under the default configuration the deny-list
    // alone already suffices and --strict-mcp-config costs nothing. It is load-bearing on the
    // REAL-HOME path, which is not hypothetical: it is the documented fallback when no token is
    // resolvable -- the boot banner then prints "Spawn home: real-home" -- and it is what
    // OCP_SPAWN_REAL_HOME=1 selects.
    //
    // An earlier revision asserted the connectors were "ESTABLISHED inside a multi-tenant guest's
    // session" full stop. That was measured under the real HOME and is FALSE for the default
    // spawn home; it was the THIRD time this block claimed more than was observed, which is why
    // the rows above lead with their HOME rather than with a number. Limits that remain: one
    // host, one operator's account, and a guest REACHING a connected server was never measured.
    // [measured, and the reason none of this can be reasoned from the flags] --disallowedTools is
    // not a subtraction the CLI passively applies: `--disallowedTools Bash` yields 77 tools where
    // the unrestricted baseline is 76, because removing Bash makes the CLI ADD Glob and Grep.
    //
    // Reported by an external fork (princelundgren/ocp, FLEET-32) that hit it on its own fleet
    // and never opened a PR; reproduced here before adopting rather than taken on its word.
    args.push("--tools", "", "--strict-mcp-config", "--disallowedTools", "mcp__*");
    // Do NOT push --allowedTools in multi mode: it is a PRE-APPROVAL list ("tool names to
    // allow", per --help), not a restriction, so it could only ever widen this.
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

// Thin env wrapper over parsePositiveInt (lib/env.mjs): resolve `name` from the
// environment fail-closed, warning on a present-but-invalid value. Keeps the pure
// parse in a unit-testable module. (PR #154 review F3)
function parseIntEnv(name, def) {
  const { value, ok } = parsePositiveInt(process.env[name], def);
  if (!ok) console.warn(`⚠ ${name}="${process.env[name]}" is not a valid positive integer (bytes/count, no unit suffix); ignoring and using default ${def}.`);
  return value;
}

// ── Format messages to prompt text ──────────────────────────────────────
// Truncation guard: if total chars exceed the request's per-model budget, keep the system
// message(s) + first user message + last N messages, dropping the middle.
// This prevents runaway context from gateway-side conversation accumulation.
// The budget is PER-MODEL (ADR 0011, #213), superseding ADR 0009's single global number.
// ADR 0009 derived one ceiling as max(models.json contextWindow) × 3, which forced models.json
// to under-declare every native-1M model at 200000: one 1e6 entry would have raised the ceiling
// from 600k to 3M for EVERY model, including the genuinely-200k claude-haiku-4-5, converting
// graceful OCP-side truncation into upstream API rejections. Now models.json states each true
// window and the ceiling is looked up for the model the request actually named.
//
// CLAUDE_MAX_PROMPT_CHARS and PATCH /settings {maxPromptChars} remain ABSOLUTE GLOBAL overrides,
// exactly as ADR 0009 specified them: when either is set, that one number is the ceiling for
// every model and no derivation happens. null means "no override — derive per model".
// resolveGlobalPromptCharOverride fails CLOSED on a set-but-garbage value (→ null → derivation)
// rather than NaN, preserving PR #154 round 2 gap (a): CLAUDE_MAX_PROMPT_CHARS=unlimited used to
// yield NaN → enforceTextBudget's `!(NaN > 0)` early-return → text passed unbounded.
// `let` is kept for the settings API.
let MAX_PROMPT_CHARS_OVERRIDE = resolveGlobalPromptCharOverride(process.env.CLAUDE_MAX_PROMPT_CHARS);
if (process.env.CLAUDE_MAX_PROMPT_CHARS && MAX_PROMPT_CHARS_OVERRIDE === null) {
  console.warn(`⚠ CLAUDE_MAX_PROMPT_CHARS="${process.env.CLAUDE_MAX_PROMPT_CHARS}" is not a valid positive integer (chars, no unit suffix); ignoring and deriving the budget per model from models.json.`);
}
// Reported by GET /settings when no override is in force, and applied to any model id with no
// models.json entry. See lib/prompt.mjs for why this is the SMALLEST known window, not the largest.
const FALLBACK_PROMPT_CHARS = fallbackPromptCharBudget(modelsConfig.models);

// The truncation ceiling for one request. `cliModel` must be the RESOLVED canonical id
// (MODEL_MAP[model] || model), never the raw client string.
function promptCharBudget(cliModel) {
  return MAX_PROMPT_CHARS_OVERRIDE ?? promptCharBudgetFor(modelsConfig.models, cliModel);
}

// ── Multimodal image caps (issue #110) ──────────────────────────────────
// OpenAI `image_url` parts are forwarded to claude as Anthropic image blocks via
// `--input-format stream-json`. Images deliberately BYPASS the text char budget
// (the per-model prompt budget) — they are bounded by these byte/count caps instead, and by
// MAX_BODY_SIZE at the HTTP layer. Data URIs are supported by default; remote
// http(s) image URLs are OFF unless CLAUDE_IMAGE_ALLOW_URL is set (v1: data URIs
// only). See docs/adr/0006-openai-shim-scope.md (Class B.1) and README § "Images".
const IMAGE_ALLOW_URL = /^(1|true|yes|on)$/i.test(process.env.CLAUDE_IMAGE_ALLOW_URL || "");
const MAX_IMAGE_BYTES = parseIntEnv("CLAUDE_MAX_IMAGE_BYTES", 5 * 1024 * 1024);
const MAX_IMAGES = parseIntEnv("CLAUDE_MAX_IMAGES", 20);
const MAX_IMAGE_TOTAL_BYTES = parseIntEnv("CLAUDE_MAX_IMAGE_TOTAL_BYTES", 20 * 1024 * 1024);
const MULTIMODAL_OPTS = {
  allowRemoteUrl: IMAGE_ALLOW_URL,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxImages: MAX_IMAGES,
  maxTotalImageBytes: MAX_IMAGE_TOTAL_BYTES,
};

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

// `maxChars` is the caller's per-model budget (promptCharBudget(cliModel)). It is a required
// argument in practice — the default only exists so a future internal caller that has no model
// in hand still gets the conservative fallback rather than an undefined (NaN) ceiling, which
// would disable the guard entirely.
function messagesToPrompt(messages, maxChars = FALLBACK_PROMPT_CHARS) {
  const full = messages.map((m) => {
    const text = contentToText(m.content);
    if (m.role === "system") return `[System] ${text}`;
    if (m.role === "assistant") return `[Assistant] ${text}`;
    return text;
  });

  const joined = full.join("\n\n");
  if (joined.length <= maxChars) return joined;

  // Truncation: keep system messages, first user msg, and trim from the tail
  logEvent("warn", "prompt_truncated", {
    originalChars: joined.length,
    maxChars,
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
  const budget = maxChars - systemText.length - 200; // 200 for separator
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
// The sessions Map that this comment used to say was "retained for stats/logging" is GONE
// (ADR 0016): retaining it kept every reader reporting a constant. conversationId is still
// accepted and still logged per request — it just no longer indexes anything.
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

  // Phase 6c: always serialize full conversation via stdin (no session resume).
  // System messages are extracted and passed via --system-prompt-file; the remaining
  // messages (user/assistant/tool) are serialized for stdin.
  const systemPrompt = extractSystemPrompt(messages);

  // The path is computed here (a pure string) but the file is NOT written until immediately
  // before spawn(), so the window in which an orphan can exist is one function call wide.
  const systemPromptFile = join(tmpdir(), `ocp-sysprompt-${randomUUID()}.txt`);

  // messagesToPrompt / buildStreamJsonInput skip system messages (they go via
  // --system-prompt-file). Filter them out first to avoid double-injection.
  const nonSystemMessages = messages.filter(m => m.role !== "system");

  // Multimodal (issue #110): when any message carries an OpenAI image_url part,
  // feed the conversation as Anthropic content blocks over --input-format
  // stream-json (images preserved and kept OUT of the text char budget).
  // Otherwise the text path is byte-for-byte unchanged. buildStreamJsonInput may
  // throw MultimodalError on an invalid/oversized image; it runs BEFORE any stats
  // mutation so a validation failure never leaks counters or the concurrency slot
  // (handleChatCompletions validates first, so in practice it will not throw here).
  const useStreamJson = hasImageContent(nonSystemMessages);
  // Per-model ceiling (ADR 0011): resolved from cliModel, not a global max across the registry.
  const maxPromptChars = promptCharBudget(cliModel);
  let stdinPayload, promptChars;
  if (useStreamJson) {
    // Pass the budget so the multimodal text is bounded by the same
    // runaway-context guard as the text path (PR #154 review F2). Images bypass it.
    const built = buildStreamJsonInput(nonSystemMessages, { ...MULTIMODAL_OPTS, maxTextChars: maxPromptChars });
    stdinPayload = built.payload;
    promptChars = built.stats.textChars;
    if (built.stats.truncated) {
      logEvent("warn", "prompt_truncated", {
        originalChars: built.stats.originalTextChars,
        maxChars: maxPromptChars,
        keptChars: built.stats.textChars,
        path: "multimodal",
      });
    }
  } else {
    stdinPayload = messagesToPrompt(nonSystemMessages, maxPromptChars);
    promptChars = stdinPayload.length;
  }

  stats.totalRequests++;
  stats.oneOffRequests++;
  if (conversationId) {
    console.log(`[session] stateless conv=${conversationId.slice(0, 12)}... key=${keyName || "anon"} msgs=${messages.length} prompt_chars=${promptChars}`);
  }

  const cliArgs = buildCliArgs(cliModel, systemPromptFile, { streamJsonInput: useStreamJson });

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // #328: strip OCP's own INBOUND credentials (PROXY_API_KEY / OCP_ADMIN_KEY /
  // PROXY_ANONYMOUS_KEY). This child reads attacker-controlled text; the proxy's key
  // authenticates callers TO the proxy and is useless to the child, so its only effect here is
  // to hand an injected child a working client credential. Demonstrated live, not theorised —
  // see lib/spawn-auth.mjs for the chain and issue #328.
  scrubInboundAuthEnv(env);

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

  // ── The system prompt travels as a FILE, not as argv (#453) ────────────────────────────────
  //
  // Written HERE, one call before spawn(), and removed in cleanup() below. Two things were wrong
  // with argv, and only the first is the one that gets noticed:
  //
  // 1. SIZE. `--system-prompt <string>` put the whole value under the OS argv ceiling, while
  //    nothing bounded the value itself -- promptCharBudget applies to messagesToPrompt, never to
  //    extractSystemPrompt -- so the only gate was CLAUDE_MAX_BODY_SIZE (5 MiB default). MEASURED
  //    single-argv ceiling: 131 071 bytes on Linux (MAX_ARG_STRLEN = 32 pages; note `getconf
  //    ARG_MAX` reports 2 MiB there and is the WRONG number), ~1 045 424 bytes on macOS. A 200 KiB
  //    system prompt therefore worked on a Mac and returned `spawn E2BIG` on a Pi, from the same
  //    client. Reproduced end to end before fixing: 1.5 MiB system message -> HTTP 500
  //    {"error":{"message":"spawn E2BIG"}}, with no counter leak and the server still healthy.
  //
  // 2. DISCLOSURE, which is the half that argues for a FILE rather than a bigger budget. argv is
  //    world-readable on Linux: /proc/<pid>/cmdline is mode -r--r--r-- and the reference fleet's
  //    /proc carries no hidepid, VERIFIED CROSS-USER on a real deployment (a non-owning local
  //    account read the OCP service's own argv; the same host's /proc/<pid>/environ is -r-------- 
  //    and refused). And the value really is there: a sentinel placed in a `system` message was
  //    caught with `ps -ww` in the spawned child's command line during a live request. So this was
  //    the one sensitive channel OCP had NOT already routed safely -- the conversation goes via
  //    stdin and the OAuth token via env (protected by that same environ mode), and only the
  //    system prompt sat in the open.
  //
  //    NOT MEASURED, and therefore not claimed: a capture from a PRODUCTION instance. The
  //    mechanism was shown locally and the cross-user readability on the fleet host; composing
  //    them is a short inference, not an observation.
  //
  // mode 0o600 is what makes the file a fix rather than a lateral move: tmpdir() is /tmp on Linux
  // (mode 777) and writeFileSync's default is 0666 & ~umask = 644, so the naive form would have
  // relocated the disclosure, not closed it. [measured] A umask sweep (000/002/022/027/077/177 ->
  // 0600; 200/277/377 -> 0400; 777 -> 0000) confirms no umask can make this file MORE permissive
  // than 0600, because umask only clears bits.
  //
  // `flag: "wx"` (O_CREAT|O_EXCL) does more than refuse a pre-planted symlink, which is how an
  // earlier revision of this comment undersold it. [measured] With `flag: "w"` the `mode` is
  // SILENTLY IGNORED on a path that already exists -- a pre-created 0666 file stayed 0666 -- so
  // `wx` is what makes the 0600 guarantee TOTAL rather than conditional on the path being fresh.
  // The name carries a randomUUID, so reaching that case requires guessing it.
  //
  // CLI VERSION. --system-prompt-file is NOT in `claude --help`'s option list (0 hits; positive
  // controls: --append-system-prompt 2, --system-prompt 1), so a reader cannot confirm it from
  // --help and the older `--system-prompt` verification 1400 lines up does NOT cover it.
  // [measured] It works on 2.1.233, 2.1.243 and 2.1.247; the discriminator is the error text --
  // an unknown flag gives `error: unknown option '<flag>'` while this one gives `Error: System
  // prompt file not found: <path>`. NOT MEASURED: anything older, including the 2.1.104 / 2.1.158
  // the comments above cite for the old flag. OCP has no `claude` version gate at all (setup.mjs
  // only records `claude --version`; the only floor machinery in this repo is for Node). What
  // makes that survivable rather than silent, and the SUBJECT of the measurement matters more
  // than the result: [measured] against a STUB that rejects the flag the way commander does --
  // no claude lacking the flag exists on this host to test -- every request 500s and the child's
  // stderr reaches the caller, on the non-streaming path AND as a data: frame on the SSE path:
  // {"error":{"message":"error: unknown option '--system-prompt-file'"}}. sanitizeError leaves it
  // intact because its rewrite needs a leading `/` and this message carries no path, so "passed
  // through" is accurate here and is NOT a general property of stderr. [reasoned, from three real
  // binaries -- 2.1.233/2.1.243/2.1.247 -- all emitting commander's `error: unknown option '<x>'`
  // format] a real older claude would say the same, so the failure names the flag and the remedy.
  // Total outage, but not a mystery. See #455.
  //
  // RESIDUAL, stated rather than hidden: a SIGKILL of the server leaves the file behind, because
  // cleanup() never runs. At 0600 that is litter, not a leak.
  let proc;
  try {
    writeFileSync(systemPromptFile, systemPrompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    proc = spawn(CLAUDE, cliArgs, spawnOpts);
  } catch (e) {
    // Covers BOTH the write failing and spawn() throwing synchronously (the #193 shape). Every
    // later exit path -- including a FAILED spawn, which emits 'error'/'close' -- reaches
    // cleanup(). force:true makes this a no-op when the write itself is what failed.
    //
    // UNTESTED, and this is the SECOND untested guard here rather than the first (`flag: "wx"` is
    // the other) -- an independent review found the count wrong by deleting this line and getting
    // 5 passed / 0 failed. Only the write-failure arm is exercised (the TMPDIR test), where no
    // file exists and this is a no-op; nothing reaches a SUCCESSFUL write followed by a
    // synchronous spawn() throw. That is not for want of looking. The two levers this repo already
    // owns are both closed: a NUL byte in argv does make spawn() throw synchronously
    // (ERR_INVALID_ARG_VALUE, measured) but the model is validated and rejected as "Unknown model"
    // long before the spawn, and #193's --stack-size spread throw fires inside buildCliArgs, which
    // runs BEFORE the write. So NO LEVER IN THIS REPO REACHES IT and one would have to be built
    // -- a production fault hook, which AGENTS.md says not to add. That is the scope actually
    // established: two levers checked and closed, NOT a proof that no lever exists. Recorded so
    // the next reader does not re-derive the two, and knows what is still open.
    try { rmSync(systemPromptFile, { force: true }); } catch { /* never mask the real error */ }
    throw e;
  }
  // #365 (the other half of #359): decode the child's stdout/stderr as UTF-8 ONCE, here, at the
  // shared spawn boundary — this function is the SOLE spawn site for the -p/stream-json path and
  // callClaude + callClaudeStreaming are its only two callers, so these two lines cover all four
  // `on("data")` accumulators (two `lineBuffer`, two `stderr`) instead of four separate edits.
  //
  // Without it each Buffer is decoded independently (`lineBuffer += d.toString()`, `stderr += d`),
  // so a multi-byte character whose bytes straddle two 'data' events becomes replacement
  // characters BEFORE the pieces are joined, and joining cannot repair it. On stdout that means
  // altered completion text reaching the client, silently: the NDJSON line stays syntactically
  // valid, nothing throws, nothing logs. setEncoding installs a StringDecoder on the stream, which
  // holds an incomplete trailing sequence until the next chunk completes it
  // (node/lib/internal/streams/readable.js `Readable.prototype.setEncoding`; stream.md: "The
  // Readable stream will properly handle multi-byte characters delivered through the stream that
  // would otherwise become improperly decoded if simply pulled from the stream as Buffer objects").
  //
  // END-OF-STREAM IS A DECISION, not a default: `onEofChunk` calls `decoder.end()`, so a sequence
  // still incomplete when the child dies is FLUSHED as U+FFFD, not dropped. Flush is what we want
  // on BOTH streams, for different reasons. On stdout it is inert — a truncated final line has no
  // terminating "\n", so parseStreamJsonLines already leaves it in `remainder`, which is discarded;
  // a child that died mid-write therefore still surfaces as its real cause (non-zero exit / no
  // result event), never as a spurious NDJSON parse error. On stderr the flushed U+FFFD keeps the
  // diagnostic byte-identical to what a whole-buffer decode produces today, so an error message
  // can never be silently shortened by dropping its tail.
  //
  // Type is unchanged, which is what makes this safe for the stderr accumulators specifically:
  // `stderr` starts as "" and `+=` already coerced each Buffer with toString("utf8"), so it was
  // always a string. Both accumulators stay strings and every downstream consumer — slice(0,300),
  // logEvent, trackError, sanitizeError, new Error(...) — keeps its exact current meaning. The
  // corrected values also reach /logs (via logEvent's `stderr` field) and /api/usage +
  // /cache/stats (via responseChars/size, which the corruption inflated); all Class B.2,
  // grandfathered under ADR 0006, route (a) — no field's rule changes, only its value stops
  // being wrong.
  //
  // Deliberately NOT `?.`-guarded: spawnOpts.stdio is unconditionally ["pipe","pipe","pipe"] a few
  // lines up, so both streams exist even when the spawn itself fails (measured: an ENOENT spawn
  // still exposes both, and setEncoding on them does not throw). An optional-chain here would turn
  // a future stdio change into a SILENT return of this bug; a throw is caught by both callers,
  // which release the slot and answer 500.
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  activeProcesses.add(proc);
  // Counter drift (#180, reported by @konceptnet): increment ONLY after the spawn has
  // succeeded and the process is registered. Incrementing before the spawn (as this did) leaked
  // +1 permanently on any synchronous throw in between — buildCliArgs, env assembly, the spawn
  // decision, or spawn() itself — because nothing was yet attached that could undo it.
  //
  // cleanup() is the SOLE decrement site, but note how it is reached: only 'exit' is wired HERE
  // (below); 'close' and 'error' are wired by each CALLER (callClaude / callClaudeStreaming).
  // That caller wiring is REQUIRED, not belt-and-braces — a FAILED spawn emits 'error' and
  // 'close' but never 'exit', so without it a spawn failure would never decrement. A future
  // third caller of spawnClaudeProcess must wire them too.
  stats.activeRequests++;

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
    // The --system-prompt-file temp file is single-use. cleanup() is the sole removal site for
    // every path past a successful spawn, and it is reached on 'exit' (wired below) as well as on
    // the 'close'/'error' the CALLERS wire -- which is why a failed spawn also removes it.
    try { rmSync(systemPromptFile, { force: true }); } catch { /* a missing file is the success case */ }
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

  // Write the serialized turn to stdin immediately. Text path: the flat prompt.
  // Multimodal path: a single newline-terminated stream-json user envelope.
  proc.stdin.write(stdinPayload);
  proc.stdin.end();

  recordModelRequest(cliModel, promptChars);
  logEvent("info", "claude_spawned", { model: cliModel, promptChars, systemPromptChars: systemPrompt.length, inputFormat: useStreamJson ? "stream-json" : "text", timeout: TIMEOUT, tier: getModelTier(cliModel), session: conversationId ? conversationId.slice(0, 12) + "..." : "none" });

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
// `res` (optional, F2) is the client's http.ServerResponse — passed through so a queued wait
// can be cancelled the moment the client disconnects, instead of spawning claude for a dead
// socket once a slot finally frees up.
async function callClaude(model, messages, conversationId, keyName, res) {
  // FIX ⑥: acquire a concurrency slot first (queues up to CLAUDE_MAX_QUEUE; rejects with a
  // ConcurrencyOverflowError → 429 when the queue is full, or a RequestDisconnectedError (F2)
  // if the client goes away first). The release fn is passed into the spawn so the idempotent
  // cleanup() frees it on every exit path. If the spawn itself throws synchronously (before
  // cleanup is wired), release here so the slot never leaks.
  // F2×F3 composition: the slot acquire comes FIRST and is the cancellable step — a client
  // that disconnects while queued rejects here, BEFORE resolveSpawnDecision() runs, so a
  // cancelled request can never acquire (or briefly hold) the real-HOME fallback mutex.
  const releaseSlot = await acquireClaudeSlot(res);
  // F3: resolve the per-spawn HOME/token decision (may serialize on the real-HOME fallback
  // mutex). If it throws, release the just-acquired slot before propagating — cleanup() is
  // not wired yet at this point.
  let spawnDecision;
  try {
    spawnDecision = await resolveSpawnDecision();
  } catch (err) {
    releaseSlot();
    throw err;
  }
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
    let sawTextDelta = false;
    let resultEventSeen = false;
    let stderr = "";

    proc.stdout.on("data", (d) => {
      markFirstByte();
      // `d` is already a decoded string: spawnClaudeProcess calls proc.stdout.setEncoding("utf8")
      // at the spawn boundary (#365), so toString() here is a no-op and is kept only to leave this
      // line byte-compatible with both stream modes. It is NOT a safeguard, and an earlier version
      // of this comment wrongly claimed it was (caught by #365's independent review): if a future
      // caller of spawnClaudeProcess omits the setEncoding, `d` is a Buffer again and
      // `lineBuffer += d.toString()` is this bug VERBATIM. The guarantee lives at the boundary.
      lineBuffer += d.toString();
      const { events, remainder } = parseStreamJsonLines(lineBuffer);
      lineBuffer = remainder;
      for (const event of events) {
        const parsed = parseStreamJsonEvent(event, sawTextDelta);
        if (!parsed) continue;
        if (parsed.text !== undefined) {
          if (parsed.fromDelta) {
            assembledText += parsed.text;
            sawTextDelta = true;
          } else {
            // aggregate assistant message — separate successive messages so the preamble and
            // the post-tool-use final answer don't run together.
            if (assembledText && !assembledText.endsWith("\n")) assembledText += "\n\n";
            assembledText += parsed.text;
          }
        } else if (parsed.stop) {
          resultEventSeen = true;
        } else if (parsed.error) {
          // is_error result — treat as process error
          reject(new Error(String(parsed.error)));
        }
      }
    });
    // Decoded upstream (#365): proc.stderr.setEncoding("utf8") in spawnClaudeProcess. `stderr` was
    // always a string here — `"" += Buffer` coerces — so its type and every consumer below
    // (slice(0,300) → logEvent / trackError / new Error) are unchanged; only the bytes are now
    // decoded across chunk boundaries instead of per chunk.
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
        noteAuthVerifiedByRequest(); // #308: a completed request is conclusive evidence the credential works
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
// `res` (optional, F2) is the client's http.ServerResponse — see closeSignalFor.
//
// `streamCtx` (optional, OCP_TUI_STREAM): { emit(text), signal } — when present the turn is
// ALSO streamed live via claude's MessageDisplay hook. The contract is unchanged: this still
// returns the TRANSCRIPT's text (T), the honesty gates still run on T before anything is
// committed, and the cache still stores T — never the concatenated deltas. streamCtx.emit is
// the SSE sink; streamCtx.signal is the client's disconnect signal, which tears the pane down
// mid-turn instead of holding the semaphore slot for a dead socket.
async function callClaudeTui(model, messages, _conversationId, _keyName, res, streamCtx = null) {
  const cliModel = MODEL_MAP[model] || model;
  const prompt = messagesToPrompt(messages, promptCharBudget(cliModel)); // includes system as [System] inline
  recordModelRequest(cliModel, prompt.length);
  // C-4: gate the heavy interactive boot behind the TUI semaphore (queuing if all slots are
  // busy, up to maxQueue). F2: `signal` (tied to `res` "close") cancels a QUEUED wait the
  // instant the client disconnects, so a dead socket never triggers a cold-boot tmux+claude
  // spawn; detach() drops the "close" listener as soon as the wait settles rather than
  // holding it for the whole (up to 120s) turn.
  const { signal, detach } = closeSignalFor(res);
  try {
    await tuiSemaphore.acquire(signal);
  } catch (err) {
    detach();
    if (err instanceof SemaphoreAbortError) {
      // L1: client-driven cancellation, not an upstream failure — info, not error (mirrors
      // acquireClaudeSlot's concurrency_wait_cancelled on the -p path).
      logEvent("info", "concurrency_wait_cancelled", {
        reason: "client_disconnected", path: "tui", inflight: tuiSemaphore.inflight, queued: tuiSemaphore.queued,
      });
      throw new RequestDisconnectedError("client disconnected while waiting for a TUI concurrency slot");
    }
    throw err;
  }
  detach();
  // release() runs in a finally so any throw from runTuiTurn (tmux spawn failure,
  // paste-not-landed) OR from the honesty gates below (truncation / error banner) can NEVER
  // leak a slot. tuiSemaphore.inflight feeds /health.
  // Streaming assembler (null when OCP_TUI_STREAM is off — then runTuiTurn gets no onDelta,
  // spawns no hook, and behaves byte-for-byte as before). It owns the auth-banner holdback
  // and the message scoping; see lib/tui/stream.mjs.
  const assembler = streamCtx ? new TuiDeltaAssembler({ holdbackChars: TUI_STREAM_HOLDBACK }) : null;
  // F6: counted here — the moment a streamed turn is ATTEMPTED — not after the honesty gates
  // below. A turn refused by the truncation or auth-banner gate is exactly the turn an operator
  // most wants visible in streamTurns; counting only turns that reached the gates made
  // streamDivergences/streamTurns silently exclude its own worst cases from the denominator.
  if (assembler) tuiStats.streamTurns++;
  const onDelta = assembler
    ? (payload) => {
        const out = assembler.push(payload);
        tuiStats.streamDeltas++; // every hook fire OBSERVED, not just forwarded ones — see the
                                  // /health field doc in lib/tui/semaphore.mjs (F6)
        if (out) streamCtx.emit(out); // released past the holdback — safe to show the client
      }
    : null;
  // ADR 0018 (#361): did THIS turn exceed its wall-clock bound? Read by the catch below, which
  // cannot otherwise tell a timeout from any other failure. Declared out here so both wall-clock
  // outcomes — `truncated` (partial text) and the `tui_transcript_timeout` throw (no text at all)
  // — converge on one flag; they are the same event seen at two different transcript lengths.
  let timedOut = false;
  try {
    // ── ADR 0018 (#361): the aggregate counters count EVERY lane ──────────────────────────────
    // Before this, `stats.*` was written only by `spawnClaudeProcess` and `trackError`, so the TUI
    // lane HALF-participated: every per-model counter (recordModelRequest / recordModelSuccess /
    // recordModelError, all already called here) but no aggregate one. A failed TUI turn moved the
    // per-model error count while /health's stats.errors, /status's requests.errors and /usage's
    // proxy.errors all stayed 0 — one response reporting the same event two ways.
    //
    // PLACEMENT MIRRORS THE -p LANE, and that is why it is here and not beside recordModelRequest
    // at the top of this function. On -p, `acquireClaudeSlot` runs BEFORE `spawnClaudeProcess`, so
    // a client that disconnects while QUEUED is never counted. Counting at the top of this function
    // would count it. Inside this try, the semaphore has already been acquired.
    //
    // activeRequests is safe to increment before runTuiTurn — unlike the -p lane, whose #180 fix
    // had to wait for a successful spawn because its decrement is wired to child-process events
    // with nothing covering a synchronous throw. Here the `finally` below covers every exit path
    // by construction, so there is no window in which a throw can leak a +1.
    stats.totalRequests++;
    stats.activeRequests++;
    const { text, entrypoint, truncated } = await runTuiTurn({
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
      // Warm pane pool (null unless OCP_TUI_POOL_SIZE > 0 → today's cold path exactly).
      // A pooled pane is single-use: runTuiTurn kills it in its finally like any other.
      pool: tuiPool,
      // Only observe when the pool is ON — with it off (the default) no new log line is
      // emitted, so the disabled path stays byte-for-byte today's, logs included.
      onPane: tuiPool
        ? ({ warm }) => logEvent("info", warm ? "tui_pool_hit" : "tui_pool_miss",
            { model: cliModel, warmRemaining: tuiPool.warm })
        : null,
      onDelta,
      // Gated on TUI_STREAM (the deployment-wide switch), NOT on `assembler` (this REQUEST's
      // stream:true/false) — F4 fix. The pool's bootPane closure above installs the hook on
      // every warm pane whenever TUI_STREAM is on, regardless of what any given future request
      // asks for (a pre-booted pane cannot know that yet); the cold path must match, or a
      // stream:false request gets --settings on a pool HIT and not on a pool MISS — two
      // different spawn argvs for the identical request, which this project's alignment/billing
      // posture cannot tolerate. Whether the hook's OUTPUT is actually consumed for THIS turn is
      // decided downstream by `onDelta` (null when assembler is null), so a non-streaming
      // request still never polls or emits — it just spawns identically either way.
      streamDir: TUI_STREAM ? TUI_STREAM_DIR : null,
      abortSignal: streamCtx ? streamCtx.signal : null,
    });
    // ── Billing-pool observation (issue #115, #133) — A3 fix: record the entrypoint the moment
    // runTuiTurn returns, BEFORE the honesty gates below that can throw. The entrypoint (cli vs
    // sdk-cli) is which BILLING POOL the turn consumed; a turn that then fails a gate (wall-clock
    // truncation, auth banner, stream divergence) STILL spent that pool — and those failed turns
    // are exactly the ones most likely to signal a silent degrade to the metered Agent SDK pool.
    // Recording only on the success path (the old placement) blinded /health's entrypointMismatches
    // and lastEntrypoint to every failed turn. recordModelSuccess still runs later, only on success.
    if (recordTuiEntrypoint(tuiStats, entrypoint, TUI_ENTRYPOINT)) {
      logEvent("warn", "tui_entrypoint_mismatch", { expected: "cli", got: entrypoint, model: cliModel });
    }

    // ── Honesty gates (issue #133) ─ run BEFORE recordModelSuccess / cache write-back.
    // A throw here propagates to the catch below (recordModelError + reject), so the
    // result never reaches the downstream setCachedResponse / singleflight / SUCCESS path.

    // C-2: the wall-clock cap hit with partial text and NO terminal marker — the turn
    // is INCOMPLETE. Returning the cut-off prefix would cache it and report it as
    // finish_reason:stop (a truncated answer served as a complete one). Reject instead.
    if (truncated) {
      // ADR 0018: the wall-clock cap expiring IS this lane's timeout — the same event the -p
      // lane's `overallTimer` books as stats.timeouts. Counted here rather than in the catch
      // because only this branch knows the cap is what ended the turn; the catch sees a generic
      // Error. `timedOut` then also makes the per-model call below truthful (it was hard-coded
      // `false`, which is why the TUI lane's per-model `timeouts` was permanently 0 too).
      timedOut = true;
      stats.timeouts++;
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

    // ── Streaming safety net — the transcript is the authority, the deltas are the mirror.
    // Runs AFTER the two gates above (so a truncated turn or an auth banner is never
    // reconciled, let alone flushed) and BEFORE recordModelSuccess / the caller's cache
    // write. Three outcomes:
    //   exact     — concat(deltas) === T. The invariant held; emit whatever is still held
    //               back (a short answer never passes the holdback, so this is its whole text).
    //   top-up    — what we emitted is a strict PREFIX of T but the deltas did not add up to
    //               it (a dropped/late fire). We serve exactly T by emitting the missing tail;
    //               the client still gets the right answer. Counted, and visible on /health.
    //   divergence— we already emitted bytes that are NOT a prefix of T. The client is holding
    //               text the transcript disagrees with and it cannot be retracted. REFUSE the
    //               turn: throw → SSE error frame, no cache, no success. Serving on would be
    //               exactly the "silently serve wrong text" failure this gate exists to stop.
    //               (Known trigger: a tool-using turn whose pre-tool prose exceeded the
    //               holdback — the transcript keeps only the LAST assistant message, so the
    //               prose we streamed is text T does not contain.)
    if (assembler) {
      // F7: a total hook failure (a claude version bump stops honoring --settings, or a
      // truncated md-hook.sh per F3) produces zero fires for every turn, finalize() still
      // reports ok:true/exact:false (the transcript alone carries the whole answer), and the
      // turn succeeds NORMALLY — degrading to buffered with no error, no divergence, nothing
      // but streamTopUps climbing (which the comment above calls "benign"). That is
      // indistinguishable from one late fire dropped unless it is counted separately.
      if (assembler.deltas === 0) {
        tuiStats.streamZeroDeltaTurns++;
        logEvent("warn", "tui_stream_zero_deltas", { model: cliModel });
      }
      const rec = assembler.finalize(text);
      if (!rec.ok) {
        tuiStats.streamDivergences++;
        logEvent("error", "tui_stream_divergence", {
          model: cliModel,
          // The dominant cause in practice: a TOOL-USING turn whose pre-tool prose exceeded the
          // holdback and was already streamed. The transcript keeps only the LAST assistant
          // message, so that prose is text T does not contain. Remedy for such a deployment:
          // raise OCP_TUI_STREAM_HOLDBACK above the model's typical narration length (later first
          // chunk, but the prose stays held back and is then correctly discarded), or leave
          // OCP_TUI_STREAM off. See README + ADR 0007 (2026-07-13 amendment).
          reason: assembler.restartedAfterEmit ? "multi_message_after_emit (tool-use turn?)" : "delta_transcript_mismatch",
          emittedChars: rec.emitted, transcriptChars: rec.transcript,
          deltas: assembler.deltas, messages: assembler.messages,
        });
        throw new Error("tui_stream_divergence: streamed text is not a prefix of the transcript; refusing to serve it");
      }
      if (!rec.exact) {
        tuiStats.streamTopUps++;
        logEvent("warn", "tui_stream_topup", {
          model: cliModel, emittedChars: rec.emitted, transcriptChars: rec.transcript, deltas: assembler.deltas,
        });
      }
      if (rec.tail) streamCtx.emit(rec.tail);
    }

    recordModelSuccess(cliModel, 0); // elapsed not measurable here; wallclock at reader level
    // #361: a completed request is conclusive evidence the credential works — ADR 0014 § C states
    // that rule for "a request that reaches the model and succeeds", unqualified by lane, and the
    // TUI lanes simply never called it. That made ADR 0014's whole premise inapplicable in TUI
    // mode: a host serving every request could sit at auth.ok:null indefinitely, and the failure
    // direction is the SAFE one (null, not a false true), which is why nobody noticed.
    //
    // PLACEMENT IS LOAD-BEARING, and it is why this is not simply mirrored next to
    // recordModelRequest at the top. It must run AFTER the honesty gates above, because the
    // default gate is LITERALLY an auth-failure-banner detector: with CLAUDE_TUI_ERROR_PATTERNS
    // unset, detectTuiUpstreamError delegates to `isDefaultAuthFailureBanner`
    // (lib/tui/transcript.mjs — grep the name, not a line number), whose four signals include a
    // 4xx "API Error:" core and an /authenticat|\/login|credential/ keyword. So the interactive
    // CLI renders an EXPIRED CREDENTIAL as ordinary assistant text, and calling this before the
    // gate would raise auth.ok:true on exactly the turn whose text says the credential was
    // refused — the #308 lie rebuilt on the other lane. All THREE gates above throw — truncation,
    // banner, and the streaming-divergence refusal — so the catch below runs and this does not.
    //
    // One call site covers BOTH TUI lanes: `callClaudeTuiStreaming` does not spawn, it awaits
    // `callClaudeTui`, so the streaming lane reaches this same line.
    noteAuthVerifiedByRequest(); // #308: a completed request is conclusive evidence the credential works
    // Entrypoint/billing-pool observation was already recorded above, right after runTuiTurn
    // returned — see the A3-fix comment there (it must cover failed turns too, so it cannot live
    // on this success-only path).
    return text;
  } catch (err) {
    // A mid-turn client disconnect (streaming path only — abortSignal) is NOT an upstream
    // failure: runTuiTurn's finally already tore the pane down, and this finally releases the
    // slot. Mirror the queued-disconnect handling above (info, no recordModelError, no
    // response) rather than booking a phantom model error against the socket going away.
    if (err && err.name === "TuiAbortError") {
      logEvent("info", "tui_turn_aborted", { reason: "client_disconnected", model: cliModel });
      throw new RequestDisconnectedError("client disconnected mid-turn; TUI pane torn down");
    }
    // ADR 0018: the OTHER wall-clock outcome. readTuiTranscript polls to a single cap and then
    // either returns truncated:true (partial text — handled above) or throws this (no assistant
    // text at all). The difference is how much text arrived, not whether the bound was exceeded,
    // so counting only one would make stats.timeouts depend on an accident of the transcript.
    // Matched on the thrown token because that is the only thing distinguishing it. A brittle string
    // match is only defensible if a rename reddens something, so the token is pinned by the test
    // named "a TUI turn whose transcript never arrives is ALSO a timeout" (grep the name, not a line
    // number), which drives this branch and asserts the token on the served body. That test was
    // added because an independent review found this comment claiming to be pinned when nothing
    // asserted it anywhere — the claim, not the code, was the defect.
    if (!timedOut && typeof err?.message === "string" && err.message.startsWith("tui_transcript_timeout")) {
      timedOut = true;
      stats.timeouts++;
    }
    recordModelError(cliModel, timedOut);
    // ADR 0018: the headline of #361 — a failed TUI turn is a failure OF THE PROXY, and until now
    // it reached no aggregate counter at all. Deliberately placed AFTER the TuiAbortError branch
    // above (which returns), so it inherits that branch's already-correct exclusion of client
    // disconnects: a client walking away is not an upstream error on either lane.
    trackError(err?.message || String(err));
    throw err;
  } finally {
    // Paired with the `stats.activeRequests++` at the top of the try. A `finally` is what makes the
    // pairing unreachable-by-construction rather than a prohibition someone must remember.
    stats.activeRequests--;
    tuiSemaphore.release();
  }
}

// ── TUI-mode REAL streaming (OCP_TUI_STREAM=1) ──────────────────────────
// The stream:true + TUI_MODE + OCP_TUI_STREAM=1 path. Emits the turn as it is generated,
// from claude's own MessageDisplay hook, instead of buffering it and replaying it with
// streamStringAsSSE.
//
// WIRE SHAPES: every frame below is COPIED from callClaudeStreaming (the -p path) — the role
// chunk, the content-delta chunk, the stop chunk, `[DONE]`, and the post-header
// {error:{message,type}} frame. No new fields, no new shapes. (ALIGNMENT.md Rule 2 / Class B:
// the authority for the wire format is the OpenAI chat/completions streaming spec, adopted by
// ADR 0006; the authority for the TUI spawn is ADR 0007. No cli.js citation applies — see the
// commit body.)
//
// HEADERS ARE SENT EAGERLY, exactly as the -p path does, so the existing heartbeat
// (CLAUDE_HEARTBEAT_INTERVAL) covers the ~6s of silence before the first delta. The cost is
// the same one the -p path already pays: after the headers are out, an upstream failure can
// no longer be a JSON 500, so it is surfaced as the SSE error frame instead (issue #110).
async function callClaudeTuiStreaming(model, messages, conversationId, res, authInfo = {}) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  const promptChars = messages.reduce((a, m) => a + contentToText(m.content).length, 0);
  let headersSent = false;

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
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    return true;
  }

  ensureHeaders();
  const hb = startHeartbeat(res, HEARTBEAT_INTERVAL, conversationId);
  // Held for the WHOLE turn (not just the queue wait): a disconnect must abort the transcript
  // wait so runTuiTurn tears the pane down and callClaudeTui's finally frees the slot.
  const { signal, detach } = closeSignalFor(res);

  const streamCtx = {
    signal,
    emit(text) {
      if (!text) return;
      if (!ensureHeaders()) return; // client vanished — drop the write, the turn still unwinds
      sendSSE(res, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      }, hb);
    },
  };

  try {
    // callClaudeTui returns the TRANSCRIPT text T after its honesty gates + the streaming
    // reconciliation. Everything the client should see has been emitted by then.
    const content = await callClaudeTui(model, messages, conversationId, authInfo.keyName, res, streamCtx);
    // Cache T — never the concatenated deltas (mirrors the buffered TUI path).
    if (CACHE_TTL > 0 && authInfo.cacheHash) {
      try { setCachedResponse(authInfo.cacheHash, model, content); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); }
    }
    if (!res.writableEnded && !res.destroyed) {
      sendSSE(res, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }, hb);
      res.write("data: [DONE]\n\n");
      res.end();
    }
    try { recordUsage({ keyId: authInfo.keyId, keyName: authInfo.keyName, model, promptChars, responseChars: content.length, elapsedMs: Date.now() - t0, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
  } catch (err) {
    // Client walked away (queued OR mid-turn): nothing to write to, nothing to record —
    // same quiet outcome as every other disconnect path (L1 / F2).
    if (err instanceof RequestDisconnectedError) { try { res.end(); } catch {} return; }
    try { recordUsage({ keyId: authInfo.keyId, keyName: authInfo.keyName, model, promptChars, responseChars: 0, elapsedMs: Date.now() - t0, success: false }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
    console.error(`[proxy] error: ${err.message}`);
    // Headers are already out (eager, above), so — exactly like the -p path — the failure is
    // surfaced as an SSE error frame, NOT a success-looking finish_reason:"stop". This is what
    // keeps a truncated turn, an auth banner, or a stream divergence from being served as an
    // answer: the client sees an error, and nothing was cached.
    if (!res.writableEnded && !res.destroyed) {
      sendSSE(res, { error: { message: sanitizeError(err.message), type: "provider_error" } }, hb);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } finally {
    hb.stop();
    detach();
  }
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
  // F2: pass `res` so a queued wait is cancelled the instant this client disconnects — the client
  // is already gone in that case, so there is no response to send back.
  let releaseSlot;
  try {
    releaseSlot = await acquireClaudeSlot(res);
  } catch (err) {
    if (err instanceof RequestDisconnectedError) return; // client gone — nothing to write to
    if (err instanceof ConcurrencyOverflowError) {
      return jsonResponse(res, 429, { error: { message: sanitizeError(err.message), type: "rate_limit_error" } }, { "Retry-After": String(err.retryAfter) });
    }
    return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
  }

  // F3: resolve the per-spawn HOME/token decision (may serialize on the real-HOME fallback
  // mutex). F2×F3 composition: this runs strictly AFTER the (cancellable) slot acquire, so a
  // request cancelled while queued never touches the fallback mutex. If it throws, release
  // the just-acquired slot before responding — cleanup() is not wired yet at this point.
  let spawnDecision;
  try {
    spawnDecision = await resolveSpawnDecision();
  } catch (err) {
    releaseSlot();
    return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
  }
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
  let streamEndsWithNewline = false; // tracks whether emitted text ends in "\n" — see the separator guard below
  let cachedContent = ""; // accumulate for cache write-back
  let lineBuffer = "";
  let sawTextDelta = false;
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
    // Already a decoded string — see the twin reader in callClaude and the setEncoding pair in
    // spawnClaudeProcess (#365). This is the streaming path, so a character split across two
    // 'data' events used to be forwarded corrupted to the client inside an SSE delta.
    lineBuffer += d.toString();
    const { events, remainder } = parseStreamJsonLines(lineBuffer);
    lineBuffer = remainder;

    for (const event of events) {
      const parsed = parseStreamJsonEvent(event, sawTextDelta);
      if (!parsed) continue;

      if (parsed.text !== undefined) {
        // Streamed delta, or an aggregate assistant-message text (agentic turns emit several).
        // For an aggregate message after earlier text, prepend a separator so the preamble and
        // the post-tool-use final answer don't run together in the forwarded stream.
        let text = parsed.text;
        if (parsed.fromDelta) {
          sawTextDelta = true;
        } else if (totalChars > 0 && !streamEndsWithNewline) {
          // Mirror the buffered path's guard (assembledText.endsWith("\n")): only inject the
          // blank-line separator when the already-emitted text doesn't already end in a newline,
          // so a message ending in "\n" doesn't produce a triple newline here while the buffered
          // path produces a single. Keeps the two assembly paths byte-identical. (PR #183 review.)
          text = "\n\n" + text;
        }
        streamEndsWithNewline = text.endsWith("\n");
        totalChars += text.length;
        if (CACHE_TTL > 0) cachedContent += text;

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

  // Decoded upstream (#365) — same note as callClaude's stderr reader. Consumers here are
  // slice(0,300) → logEvent / trackError / sanitizeError, into a 500 body or an SSE error frame.
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
      noteAuthVerifiedByRequest(); // #308: a completed request is conclusive evidence the credential works
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

// ── Parsed-body shape predicates (#360) ─────────────────────────────────
// STATED POSITIVELY, as what the code downstream needs, rather than as "not a non-object".
// That framing is the whole lesson of #360: the guard this replaced was
// `typeof updates !== "object"`, which tests for the ABSENCE of the object tag — and
// `typeof null === "object"`, so `null` is not absent from it. A negation of a property that is
// nearly-but-not-quite the requirement reads as complete and is not. Both predicates below name
// the capability the caller is about to use, so a reader checks them against the NEXT line
// instead of against a mental list of JavaScript's type-tag exceptions.
//
// Two predicates, not one, because the four body handlers require different things and collapsing
// them would silently widen two of them:
//
//   isJsonObject     — safe to enumerate as a name/value map: `Object.entries(v)`, or a read of a
//                      named field that decides the request. Arrays are excluded: an array has no
//                      meaningful named fields at these call sites.
//   isLegalInOperand — the WEAKER one, and named for exactly what it certifies and nothing more:
//                      `k in v` requires an object on its right-hand side, and an array satisfies
//                      that. It does NOT claim the value is a sensible property bag — an array
//                      passes. `PATCH /api/keys/:id/quota` uses it deliberately so an array body
//                      keeps the answer it already gives instead of being captured by a wider
//                      guard (see the comment there). Renamed from `isPropertyBag` in review: a
//                      NAME IS A CLAIM, and that one claimed more than the call site needs.
//
// Neither is exported or reused beyond the four call sites; they exist so the null case is decided
// ONCE rather than re-remembered at each site, which is how the fifth reader would otherwise
// arrive carrying this bug again.
const isJsonObject  = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isLegalInOperand = (v) => typeof v === "object" && v !== null;

// ── Query-integer parse for GET /api/usage (#379) ───────────────────────
// GUARANTEE, and the only one: the return value is always a FINITE number. That is the whole
// job. `parseInt("%", 10)` is NaN, `Math.min(NaN, 500)` is NaN, and the two call sites hand
// that NaN straight to a sink that throws:
//
//   ?limit=%  → getRecentUsage(NaN)  → SQLite bind → "datatype mismatch"      (TypeError)
//   ?hours=%  → getUsageTimeline({hours: NaN}) → new Date(NaN).toISOString()
//                                             → "Invalid time value"          (RangeError)
//
// Both throws escape the `async` request callback, which Node does not observe, so nothing
// answers and the socket is held open until the client gives up. Measured on this tree before
// the fix: 0 bytes received, socket still open at a 4 s deadline, and one
// `unhandled_rejection` line per request in the proxy log. That is a credential-free
// connection-exhaustion primitive on the DEFAULT configuration (`CLAUDE_AUTH_MODE=none`), from
// a bare GET with no body and no Authorization header.
//
// NOT modelled on `/logs`, and the difference is worth recording because issue #379 names
// `/logs` as the precedent to copy and that is a MISREADING — checked on the wire rather than
// taken on trust:
//   - `GET /logs?limit=…` answers 200 because `/logs` HAS NO `limit` PARAMETER (it reads `n`
//     and `level`, server.mjs handleLogs). The 200 is an unread query param, not a clamp.
//   - `GET /logs?n=%` also answers 200, but NOT because anything clamps: NaN flows into
//     `Array.prototype.slice`, which coerces NaN to 0, so `slice(-NaN*3)` returns EVERYTHING.
//     Measured: `?n=%` → 173517 bytes vs `?n=5` → 776 bytes, i.e. the whole log file.
// `/logs` survives by SINK TOLERANCE, not by a guard. Copying it would mean letting NaN through
// and hoping the next sink is forgiving — which is precisely what fails here, because SQLite's
// bind and `Date.prototype.toISOString` are not.
//
// NOT `parsePositiveInt` (lib/env.mjs) either, for a reason that is the crux of the class
// analysis: it rejects `<= 0` and any value `parseInt` only partially consumed. Both of those
// inputs are ANSWERED today and must keep their exact answers —
//   `?limit=5abc` → 5 (parseInt prefix), `?limit=-1` → SQLite `LIMIT -1` = unbounded,
//   `?limit=0` → 0 rows, `?hours=-1` → a window in the future.
// Using it would change WHICH VALUE a currently-answered request gets, which is the contract
// change ALIGNMENT.md:114 makes a new authorization request.
//
// THE GUARD RUNS *AFTER* `Math.min`, AND THAT ORDER IS THE WHOLE CORRECTNESS ARGUMENT.
// `parseInt` returns NaN, ±Infinity, or a finite integer — and `Math.min(+Infinity, cap)` is
// `cap`, an ordinary finite value that reaches the sink and IS ANSWERED at v3.16.4. A 400-digit
// `?limit` overflows to `+Infinity` and therefore answers 500 rows today. Guarding BEFORE the
// clamp would substitute the default instead, changing the value of a request that is answered
// — a contract change, caught by independent review after the first version of this patch did
// exactly that. Guarding after the clamp keeps `+Infinity → cap` intact and still catches NaN
// (`Math.min(NaN, cap)` is NaN) and `-Infinity` (which is NOT answered today: it reaches the
// bind and throws).
//
// ROUTE (a) IS SOUND BY CASE EXHAUSTION HERE, not merely by sampling — which is worth stating
// because a sampled argument is what let the `+Infinity` case through in the first place.
// `parseInt` returns exactly one of NaN, +Infinity, -Infinity, or a finite integer, so the
// non-finite values `Math.min(parseInt(…), cap)` can produce are exactly TWO:
//   NaN        -> `Math.min(NaN, cap)` is NaN                       -> guard fires
//   -Infinity  -> `Math.min(-Infinity, cap)` is -Infinity           -> guard fires
//   +Infinity  -> `Math.min(+Infinity, cap)` is CAP, a finite value -> guard CANNOT fire
// So the guard is reachable only for NaN and -Infinity, and BOTH were measured to throw at both
// sinks (`datatype mismatch` / `Invalid time value`), i.e. both were unanswered. The set of
// inputs whose value changes is therefore EXACTLY the set that received no response — not a
// sample of it. Corroborated empirically over 47 raw inputs × both parameters against the real
// sinks: ZERO inputs the old code answered change value, and 20 that it could not answer now do.
//
// WHAT THIS FUNCTION DOES NOT FIX, STATED SO THE NEXT READER DOES NOT TRUST IT TOO FAR. A FINITE
// value still reaches both sinks and is still refused by them — `Math.min(x, cap)` bounds only
// the HIGH side, so it is the NEGATIVE direction that survives:
//   `?limit=-100000000000000000000` → SQLite bind rejects it        → "datatype mismatch"
//   `?hours=-2400000000`            → Date range overflow           → "Invalid time value"
// Both were PRE-EXISTING hangs — identical at v3.16.4 and on `main` — and both are a different
// input class from the `parseInt`-yields-NaN defect issue #379 case 3 describes, with their own
// contract questions (SQLite's int64 bind range; `Date`'s ±8.64e15 ms range). They are now
// answered, but NOT HERE: #400 guards them AT THE SINKS in keys.mjs, because the `hours` boundary
// MOVES WITH THE CLOCK and a pre-check in this file would evaluate `Date.now()` at a different
// instant than the sink does. This helper's guarantee is unchanged and remains exactly one thing:
// the value it returns is finite. See keys.mjs's #400 block for the rest.
// Still unfixed, and route (b) rather than route (a): the `created_at` string-comparison bug in
// getUsageTimeline (`.toISOString()` vs SQLite's space-separated format), which changes WHICH ROWS
// an answered request returns and needs its own ADR. The ?hours=-1 test arm records it.
//
// Authorized by ADR 0006 (grandfathered as of v3.16.4) — behaviour-preserving, route (a). At
// v3.16.4 (`git rev-list -n1 v3.16.4` → 9e25160, read with `git show`; the maintainer's checkout
// is a SHALLOW clone, so `git log -S` on main THERE reports the shallow boundary rather than the
// real introducing commit — corrected under ADR 0017, last Consequence) BOTH call sites here AND
// both sinks in keys.mjs
// (getRecentUsage, getUsageTimeline) are byte-identical to the pre-fix code. The grandfathered
// snapshot therefore IS the defective behaviour — the hang is inside what ADR 0006 froze, not
// something added after it. Contrast #383, where POST /api/keys' name regex entered between
// v3.17.1 and v3.18.0, so ADR 0006's snapshot never covered it and it needed — and now has —
// its own authorization, ADR 0017 § Decision 2. `limit`'s documented meaning — "how
// many recent rows, default 50, capped at 500" — is unchanged. Same reasoning as #360's
// `parsed === null` guard: a request that currently receives NO RESPONSE AT ALL is not a
// behaviour anyone can be relying on.
function usageQueryInt(raw, fallback, cap) {
  const clamped = Math.min(parseInt(raw || String(fallback), 10), cap);
  return Number.isFinite(clamped) ? clamped : fallback;
}

// ── #379 cases 1 and 2: a malformed percent-escape in a /api/keys/… path ─────────────────────
//
// `decodeURIComponent` throws `URIError: URI malformed` on any input that is not a valid
// percent-encoding of a UTF-8 sequence. Three routes called it UNGUARDED on a path segment the
// client controls, and the throw escaped the `async` request callback — Node never observes the
// promise a request handler returns — so nothing wrote a response and nothing closed the socket.
// Measured on `main` before this fix, loopback, default `CLAUDE_AUTH_MODE=none`, 4 s deadline:
//   DELETE /api/keys/%E0%A4%A     → 0 bytes, socket still open, 1 unhandled_rejection
//   PATCH  /api/keys/%/quota      → 0 bytes, socket still open, 1 unhandled_rejection
//   GET    /api/keys/%/quota      → 0 bytes, socket still open, 1 unhandled_rejection
// The DELETE and the PATCH are #379's cases 1 and 2. The GET is the SAME call on the ADJACENT
// route of the same handler block, found by probing rather than reported, and folded in under
// Iron Rule 11 §11.1: cheaper than its own PR, found by this PR's stated job, and a reviewer can
// still follow the diff. Fixing two of three would have left an identical hang on the very next
// route in this block (measured on main: the three calls are at :3979, :3988 and :4037).
//
// RETURNS `null` — NEVER a falsy sentinel — AND CALLERS MUST TEST `=== null`. The empty string is
// a LEGITIMATE decode result: `DELETE /api/keys/` yields `""` and is ANSWERED today (200,
// `{"revoked":false,"idOrName":""}` — measured). A `if (!idOrName)` check would capture it and
// change an answered request, which is the same trap `?limit=0` set for #379 case 3.
//
// THE SPLIT IS DELIBERATELY OUTSIDE THIS FUNCTION'S `try`, at every call site. The `catch` must be
// reachable ONLY by `decodeURIComponent`, because that is what makes the exhaustion argument below
// sound; wrapping the `.split(…)[1]` too would let an unrelated TypeError be absorbed into a 404.
//
// WHY 404, AND WHY NOT 400. Both were considered; the choice is evidence-led, because #379 flags
// that it may itself move a rule.
//   - 404 IS THIS SERVER'S EXISTING ANSWER TO A URL IT CANNOT RESOLVE. [measured] 20 paths were
//     probed. 18 of them carry a malformed percent-escape and do NOT reach one of these three
//     calls; of those, 16 answer 404 — `/%`, `/api/%`, `GET /api/keys/%`, `POST /api/keys/%`,
//     `DELETE /cache/%`, `PATCH /settings/%`, `GET /v1/%`, `GET /health/%`, `GET /status/%`,
//     `GET /usage/%`, `GET /dashboard/%`, `GET /v1/models/%`, `GET /api/keys/%/quota/x` and so on.
//     The remaining 2 are stated rather than dropped, because an enumeration that quietly omits its
//     exceptions is not evidence: `GET /api/usage/%` and `GET /logs/%` answer 200, since both
//     routes match by PREFIX (`startsWith("/api/usage")`, `startsWith("/logs")`) and therefore
//     RESOLVE the URL rather than failing to. They are not counterexamples — nothing was
//     unresolvable — but the honest arithmetic is 16 of 18, not 18 of 18. The last 2 of the 20
//     (`GET /api/keys/a/b/quota`, `GET /no-such-endpoint`) carry NO escape at all and are controls
//     for the rule itself; both answer 404. This is the THIRD numeric claim in this change that did
//     not survive being recounted, which is why the count is now spelled out rather than summarised.
//   - A URL-TRIGGERED 400 EXISTS NOWHERE ON THIS SURFACE. Every `jsonResponse(res, 400, …)` site in
//     this file is triggered by the request BODY or a body-derived field — the body-read abort, the
//     `JSON.parse` failure, the shape guards, the key-name regex, `model`, `messages`, the tool and
//     image checks, and the empty-quota-fields check. NOT ONE is keyed on the URL. Deliberately
//     stated by TRIGGER and not by count: grepping that pattern is unreliable here because it now
//     also matches THIS COMMENT, which is the ADR 0012 marker-grep failure mode one level down —
//     reading prose to learn what the code does. Answering 400 here would invent a rejection KIND,
//     which is the invention ALIGNMENT.md's anti-invention discipline exists to stop — and #379
//     names it as the choice that would NOT be route (a).
//   - THE BODY IS THE ONE THE TWO QUOTA ROUTES ALREADY USE. `{ error: "Key not found" }` is
//     byte-identical to their existing 404 (server.mjs, `updateKeyQuota`/`findKey` misses; present
//     at v3.16.4 too), so those two routes gain no new response shape at all — only a new input
//     reaches an answer they already give. It is also TRUE: a segment that cannot be decoded names
//     no key.
//   - THE DELETE IS THE ONE SITE WHERE 404 IS A STATUS THE ROUTE DOES NOT EMIT TODAY, and that is
//     stated rather than glossed. Its authorization is route (a): the ONLY inputs whose behaviour
//     changes are inputs that receive no response at all. The alternative of reusing its 200
//     `{revoked:false}` was rejected on two grounds — it needs an invented "use the raw undecoded
//     segment" rule, and it would REPORT A LOOKUP THAT NEVER HAPPENED. `DELETE /api/keys/no-such-key`
//     answering `revoked:false` means "I looked and it was not there"; `%E0%A4%A` is not a key name
//     at all, so there is nothing to look up. Refusing before the body is read also keeps case 2's
//     property intact: an unreadable URL is answered without consuming a body, instead of falling
//     through to `{"error":"Invalid JSON"}`, which would diagnose the body for a URL problem.
//
// ROUTE (a) IS SOUND BY EXHAUSTION, and here it needs no enumeration of the input domain at all —
// the `catch` block IS the throw set. The catch is deliberately UNFILTERED (it does not test for
// `URIError`), so the argument does not depend on `decodeURIComponent` having exactly one failure
// mode, or on anyone enumerating which strings are malformed: the set of inputs whose behaviour
// changes is precisely { inputs for which this call throws }, whatever it throws. Every such input
// reached this line, threw, and — there is no enclosing `try` anywhere in the request callback —
// was never answered. Changed-input set == previously-unanswered set, exactly.
//
// Authorized by ADR 0006 (grandfathered as of v3.16.4); contract unchanged. `git rev-list -n1
// v3.16.4` → 9e25160, read with `git show` — the right method, though NOT for the reason this
// comment used to give. It said v3.16.4 and `main` share no ancestor (roots 593d0dc vs c180987);
// measured in a full clone, the repo has ONE root (593d0dc) and v3.16.4 IS an ancestor of `main`.
// That reading was a SHALLOW-CLONE artifact of the maintainer's checkout (`.git/shallow` holds
// c180987) — corrected under ADR 0017. All THREE call sites are
// byte-identical there (9e25160:server.mjs:1633, :1642, :1668), and the second layer is stronger
// than byte-identity: [measured] booting v3.16.4 itself, each of these three requests sent the
// client ZERO BYTES and then KILLED THE DAEMON (exit code 1, stack naming those exact lines) —
// v3.16.4 has no `unhandledRejection` handler, so Node's default terminated the process. The
// grandfathered snapshot's behaviour for these inputs is "no response, and the proxy dies", which
// is emphatically not a behaviour anyone can be relying on. Contrast #383, where POST /api/keys'
// name regex entered AFTER v3.16.4 and is therefore not grandfathered at all.
function decodeKeySegment(raw) {
  try { return decodeURIComponent(raw); } catch { return null; }
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

// OpenAI's designated mechanism for "the model would not produce the required output" is the
// assistant `refusal` field (content:null, refusal:<text>, finish_reason:"stop") — NOT an invented
// error type. Structured-output exhaustion emits this so SDK clients take their written `refusal`
// branch instead of throwing an opaque UnprocessableEntityError. (PR #153 review, finding 3.)
function refusalResponse(res, id, model, refusal) {
  jsonResponse(res, 200, {
    id, object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: null, refusal }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// Streaming form of refusalResponse: a role chunk, a `refusal` delta, then the stop chunk.
function streamRefusalAsSSE(res, id, model, refusal) {
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  sendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  sendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { refusal }, finish_reason: null }] });
  sendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
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
        ], { env: scrubInboundAuthEnv({ ...process.env }).env, encoding: "utf8", timeout: 5000 }).trim();
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
      status: proxyHealthStatus(binaryOk),
      version: VERSION,
      uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      auth: (() => { const a = effectiveAuthStatus(); return a.ok ? "ok" : a.message; })(),
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
  // `sessionTTL` was REMOVED from this schema under ADR 0016, and removing it from HERE is what
  // performs the rejection the ADR asks for. A PATCH carrying it now falls through
  // applySettingUpdate's `if (!schema) return "unknown setting: sessionTTL"`, i.e. HTTP 400
  // (or 207 alongside a valid key) with a named error — the same answer any other unknown key
  // has always got. That is deliberate: "reject explicitly rather than ignore silently" needs no
  // new code path, only the absence of this line, and a bespoke 410-style branch would have been
  // a second way to say no. Do not add `sessionTTL` back as a no-op accepted key.
  // ADR 0011: a GLOBAL override of the per-model budget. Setting it pins the truncation ceiling
  // to this one number for EVERY model; unset, each model gets contextWindow × 3 from models.json
  // and this reports the fallback (smallest known window × 3). Range unchanged — deliberately not
  // widened to the 3,000,000 a native-1M model now derives, because that would be a separate
  // request-validation contract change with no requester; see ADR 0011 § Rejected alternatives.
  maxPromptChars:   { type: "number", min: 10000, max: 1000000, unit: "chars", desc: "Global prompt truncation override (unset = per-model from models.json)" },
  cacheTTL:         { type: "number", min: 0, max: 86400000, unit: "ms", desc: "Response cache TTL (0 = disabled)" },
};

function getSettings() {
  return {
    timeout:          { value: TIMEOUT, ...SETTINGS_SCHEMA.timeout },
    maxConcurrent:    { value: MAX_CONCURRENT, ...SETTINGS_SCHEMA.maxConcurrent },
    // Stays a plain number: `ocp settings` formats this into a fixed-width column and PATCH
    // takes a single scalar, so a null or a per-model map would break both consumers. When no
    // override is set this is FALLBACK_PROMPT_CHARS (600,000 today) — the same number this
    // field reported before ADR 0011, because every non-1M entry is still 200000.
    maxPromptChars:   { value: MAX_PROMPT_CHARS_OVERRIDE ?? FALLBACK_PROMPT_CHARS, ...SETTINGS_SCHEMA.maxPromptChars },
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
    // FIX ⑥ + F1: keep the -p wait-queue semaphore's limit in sync with the runtime MAX_CONCURRENT
    // so a /settings change to maxConcurrent actually changes how many claude procs run at once —
    // in BOTH directions. setLimit() (not a bare `.limit =` assignment) is required: lowering
    // needs release() to stop over-granting until inflight drains under the new cap, and raising
    // needs queued waiters woken immediately to use the new headroom. See lib/tui/semaphore.mjs.
    case "maxConcurrent":    MAX_CONCURRENT = value; claudeSemaphore.setLimit(value); break;
    // ADR 0011: installs the GLOBAL override. There is deliberately no way to clear it back to
    // per-model derivation over PATCH — the schema's min is 10000, so no in-range value means
    // "unset", and accepting null would be a request-shape change. Restart without
    // CLAUDE_MAX_PROMPT_CHARS to return to derivation.
    case "maxPromptChars":   MAX_PROMPT_CHARS_OVERRIDE = value; break;
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
  // #359: decode the request body as UTF-8 ACROSS chunk boundaries. Without this, `body += chunk`
  // coerces each Buffer to a string independently, so a multi-byte character whose bytes straddle
  // two chunks is decoded as replacement characters BEFORE the pieces are joined — the join can
  // never repair it, and the JSON stays syntactically valid, so nothing errors. setEncoding installs
  // a StringDecoder on the stream, which holds an incomplete trailing sequence until the next chunk
  // completes it (node/lib/internal/streams/readable.js `setEncoding` + `onEofChunk`; stream.md:
  // "The Readable stream will properly handle multi-byte characters delivered through the stream
  // that would otherwise become improperly decoded if simply pulled from the stream as Buffer
  // objects"). `chunk` is now already a correctly-decoded string, so `body` stays a string and the
  // cap below keeps counting UTF-16 code units — the unit is deliberately unchanged (see #310 at
  // the MAX_BODY_SIZE comment), and the early abort still fires mid-stream.
  req.setEncoding("utf8");
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

  // #360: this guard was `typeof updates !== "object" || Array.isArray(updates)` — it READ as
  // complete and was not, because `typeof null === "object"` walked `null` straight past it into
  // `Object.entries(null)`, which throws. The throw then escapes this `async` handler (Node does
  // not observe the promise a request callback returns), so `unhandledRejection` logs it and
  // NOTHING answers or closes the socket. Measured before the fix: PATCH /settings with body
  // `null` held the connection open with zero bytes sent until the client gave up.
  //
  // `isJsonObject` states the requirement of the LINE BELOW — "safe to Object.entries" — instead
  // of negating a type tag that happens to include null. Every other non-object (42, "str", true,
  // []) already landed on this exact 400, so `null` now joins them with the SAME status and the
  // SAME message: the rule that decides this response ("the body must be a JSON object") is
  // unchanged and always meant this, and only the enforcement becomes truthful. Request shape,
  // response shape and semantics all unchanged → ADR 0006 grandfather route (a), the same shape as
  // the `stats.activeRequests` worked example in CLAUDE.md.
  if (!isJsonObject(updates)) {
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
// This cap is compared against `body.length` — UTF-16 code units, i.e. CHARACTERS — because the
// accumulator below is a JS string (the reader calls `req.setEncoding("utf8")`, so each `chunk` is
// already a decoded string and `body += chunk` concatenates strings). Issue #310: it
// was labelled "5MB", which reads as bytes to every reader, including two review rounds that
// concluded a 3,000,000-character CJK prompt would be rejected here. It would not: 3,000,000 is
// well under the 5,242,880-character cap, though it is 9,000,000 bytes on the wire. That label
// cost two review rounds and nearly shipped operator guidance to raise a knob nobody needed to
// touch.
//
// The comparison is deliberately LEFT counting characters. A byte cap of the same number is never
// more permissive — UTF-8 byte length >= UTF-16 unit length for every character class (ASCII 1:1,
// Latin-1 accents 2:1, CJK 3:1, astral 4:2) — so switching to bytes would reject bodies accepted
// today. That is a contract change on a Class B.1 surface under CLAUDE.md's dividing test, not a
// label fix, and it is not what #310 is for. What changes here is that the label and the 413 body
// now state which quantity they measured, so nobody reasons in the wrong unit again.
//
// Parsed fail-closed (PR #154 review F3): a bad value (`unlimited` → NaN, `5MB` → 5) must not
// disable the body cap or brick the proxy — parseIntEnv keeps the default and warns instead.
const MAX_BODY_SIZE = parseIntEnv("CLAUDE_MAX_BODY_SIZE", 5 * 1024 * 1024);
// No "MB": the number is a character count and any byte-flavoured unit on it is a lie. Deliberately
// not `toLocaleString()` — that is locale-sensitive and would make the 413 body vary by host.
const MAX_BODY_SIZE_LABEL = `${MAX_BODY_SIZE} characters`;

// Set of all valid model identifiers (canonical IDs + aliases)
const VALID_MODELS = new Set(Object.keys(MODEL_MAP));

// Drive the model to a valid structured-output (OpenAI response_format) JSON string, retrying up to
// STRUCTURED_MAX_ATTEMPTS. Appends a strict JSON-only steering instruction, extracts + validates the
// reply (pure helpers in lib/structured-output.mjs), and escalates the instruction on failure.
// Returns the canonical JSON string (message.content) or throws StructuredOutputError.
async function runStructuredCompletion(upstreamCall, model, messages, conversationId, keyName, res, structured) {
  let lastErr = "no valid JSON produced";
  let lastRaw = "";
  for (let attempt = 0; attempt < STRUCTURED_MAX_ATTEMPTS; attempt++) {
    const augmented = [...messages, { role: "system", content: structuredSystemInstruction(structured, attempt, lastErr) }];
    const raw = await upstreamCall(model, augmented, conversationId, keyName, res);
    lastRaw = raw;
    const extracted = extractJsonPayload(raw, { whole: structured.mode === "json_object" });
    if (!extracted.ok) {
      lastErr = extracted.reason || "response was not parseable as JSON";
      logEvent("warn", "structured_retry", { attempt, reason: extracted.reason || "unparseable" });
      continue;
    }
    if (structured.mode === "schema" && structured.schema) {
      // validateJsonSchemaSafe (#181): a pathologically deep model reply overflows the value-depth
      // recursion; the safe façade turns that into a validation miss (→ retry → refusal) instead of
      // a caught RangeError surfacing as a generic 500.
      const errs = validateJsonSchemaSafe(extracted.value, structured.schema, "$", structured.strict);
      if (errs.length) {
        lastErr = "schema validation failed: " + errs.slice(0, 5).join("; ");
        logEvent("warn", "structured_retry", { attempt, reason: "schema", errors: errs.slice(0, 5) });
        continue;
      }
    }
    if (attempt > 0) logEvent("info", "structured_recovered", { attempt });
    return JSON.stringify(extracted.value); // canonical, fence-free, prose-free
  }
  throw new StructuredOutputError(lastErr, lastRaw);
}

async function handleChatCompletions(req, res) {
  // #359: see handleSettings. Chunk boundaries are chosen by the kernel and the network, so a
  // multi-byte character in a prompt is split unpredictably rather than rarely; setEncoding makes
  // the stream decode across those boundaries instead of per-Buffer. The accumulator and the
  // character-counted cap below are deliberately unchanged.
  req.setEncoding("utf8");
  let body = "";
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY_SIZE) {
        // #310: the message names the unit. A client that reads "5MB" and shrinks its payload by
        // byte count is optimising against the wrong quantity — a multi-byte body is several times
        // this limit on the wire and still admitted.
        return jsonResponse(res, 413, { error: { message: `Request body too large (max ${MAX_BODY_SIZE_LABEL}; this limit counts characters, not bytes)`, type: "invalid_request_error" } });
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

  // #360: JSON.parse verifies SYNTAX, not that the result is an object. `JSON.parse("null")`
  // succeeds, and the two failure modes below are opposite and both wrong:
  //
  //   null  -> `parsed.messages` throws. The throw escapes this `async` handler (Node does not
  //            observe the promise a request callback returns), `unhandledRejection` logs it, and
  //            nothing answers or closes the socket. Measured before the fix: zero bytes, socket
  //            still open, client hangs until it gives up.
  //   42 / "str" / true / [] -> NO throw. Property access on a primitive boxes rather than
  //            throwing, so all three lookups on the next line are `undefined`, the `||` chain
  //            manufactures `[{ role: "user", content: "" }]`, and the request proceeds to a real,
  //            BILLED upstream spawn that returns 200. Measured: one `claude` spawn per request.
  //            That is the worse half — a nonsense body answered too successfully rather than not
  //            at all.
  //
  // Class B.1. The authority is OpenAI's `/v1/chat/completions` specification, which defines the
  // request body as an object with a REQUIRED `messages` array
  // (https://platform.openai.com/docs/api-reference/chat/create), authorized by ADR 0006. A scalar
  // or array body carries no `messages`, so 400 is the specified answer and the 200 was not. This
  // is also what OCP already does for the semantically identical `{"messages": 42}` — the guard
  // further down returns exactly this shape. Error shape is byte-identical to that existing guard,
  // deliberately: no new error body is invented here.
  if (!isJsonObject(parsed)) {
    return jsonResponse(res, 400, { error: { message: "Request body must be a JSON object", type: "invalid_request_error" } });
  }

  // #360 review F1: the guard above closes the SCALAR door, not the door. An earlier version of
  // this comment claimed it closed "the one door through which a body with no `messages` reached
  // the model"; that was false, and measured false — `{}`, `{"messages":null}`, `{"messages":0}`
  // and `{"model":"haiku"}` are all objects, all pass the shape guard, and all still reached the
  // `||` chain below, which manufactures `[{ role: "user", content: "" }]` and pays for a real
  // BILLED spawn. `{"model":"haiku"}` is a far more plausible accidental client body than `42`, so
  // fixing only the scalars removed six bodies and left an unbounded family of them.
  //
  // The condition is the one the `||` chain actually turns on: if none of the three sources yields
  // anything truthy, the only thing left to send upstream is an empty prompt, and an empty prompt is
  // never a request worth spending quota on. Falsy rather than `=== undefined` on purpose — `null`
  // and `0` are exactly the values measured above, and they reach the fallback identically.
  //
  // Deliberately NOT a wider check. `{"messages":[]}` and `{"messages":42}` stay on the existing
  // `'messages' must be a non-empty array` guard further down (arrays and numbers are truthy, so
  // they pass this one untouched) — their answers are unchanged, status and message both.
  //
  // Class B.1, and the grandfather route is unavailable here by construction: ADR 0006's
  // grandfather provision, 4th bullet — "It does **not** extend to B.1 (OpenAI-compat) endpoints.
  // B.1 endpoints are bounded by OpenAI's published specification, not by a behaviour snapshot —
  // there is no grandfather equivalent for them." OpenAI's spec makes `messages` REQUIRED
  // (https://platform.openai.com/docs/api-reference/chat/create), which covers `{}` exactly as it
  // covers `42`. The `input`/`prompt` fallback is undocumented in both README.md and ADR 0006, so
  // no documented OCP behaviour is being changed either — but it is PRESERVED here regardless: a
  // real `prompt` or `input` still works, and only the empty-handed case is refused.
  if (!parsed.messages && !parsed.input && !parsed.prompt) {
    return jsonResponse(res, 400, { error: { message: "'messages' is required", type: "invalid_request_error" } });
  }

  const messages = parsed.messages || parsed.input || [{ role: "user", content: parsed.prompt || "" }];
  const model = parsed.model || modelsConfig.aliases.sonnet;
  // Cache keys must hash the RESOLVED model, never the string the client happened to use.
  // `model` is whatever was sent — a canonical id, an alias ("opus"), or a legacyAlias
  // ("claude-opus-4"). MODEL_MAP carries all three, and models.json is read once at boot, so
  // repointing an alias only takes effect on restart — while the SQLite response_cache outlives
  // it. Hashing the raw string would therefore keep serving the OLD model's answers under that
  // alias until TTL expiry, silently defeating the repoint (the #176 hazard, for aliases).
  // Resolving first also means "opus" and "claude-opus-5" correctly share one slot: identical
  // spawn, identical answer. Only the cache KEY is resolved — `model` is still echoed back to
  // the client verbatim, so the wire response is unchanged.
  // hasOwn, not a bare lookup: MODEL_MAP is a plain object, so `MODEL_MAP["constructor"]`
  // would return an inherited FUNCTION. Unreachable today (the VALID_MODELS gate below 400s
  // first, and it is built from Object.keys so it holds only own keys), but a bare lookup
  // would hand cacheHash a function the day anyone widens that gate or moves this binding.
  const cacheModel = Object.hasOwn(MODEL_MAP, model) ? MODEL_MAP[model] : model;
  const stream = parsed.stream;

  // Issue #311. OCP accepts `tools`/`tool_choice` and never reads them; `server.mjs` emits no
  // tool_calls at all. Under a permissive tool_choice that is spec-conformant — the model MAY call
  // a tool, and text is a legal outcome — so those requests are left exactly as they were. Under a
  // FORCING tool_choice ("required", or a named function) the spec requires finish_reason
  // "tool_calls", and answering with prose and finish_reason "stop" is not a degraded answer but a
  // silently wrong one: no 400, no warning field, and "stop" means the turn ended normally, so the
  // client has nothing to branch on. Refuse those, and only those. See lib/tool-support.mjs for the
  // spec split and ADR 0013 for why OCP does not implement tool calling.
  const toolSupport = classifyToolRequest(parsed);
  if (!toolSupport.supported) {
    return jsonResponse(res, 400, { error: {
      message: toolSupport.message,
      type: "invalid_request_error",
      param: toolSupport.parameter,
      code: "unsupported_parameter",
    } });
  }

  // Validate model against known models
  if (!VALID_MODELS.has(model)) {
    return jsonResponse(res, 400, { error: { message: `Unknown model: ${model}. Valid models: ${[...VALID_MODELS].join(", ")}`, type: "invalid_request_error" } });
  }

  // Session ID: from request body, header, or null (one-off)
  const conversationId = parsed.session_id || parsed.conversation_id || req.headers["x-session-id"] || req.headers["x-conversation-id"] || null;

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse(res, 400, { error: { message: "'messages' must be a non-empty array", type: "invalid_request_error" } });
  }

  // #379 case 4: the guard above proves `messages` is a non-empty ARRAY, not that its ELEMENTS
  // are message objects. `{"messages":[null]}` — a null element inside a valid object — passes
  // every guard so far (the body is an object, `messages` is truthy, the array is non-empty) and
  // then throws deep in the spawn path (`m.role` / `m.content` on null), which escapes the async
  // router unanswered: the connection-exhaustion shape #379 is about. Measured before the fix on
  // this tree: zero bytes, socket still open at a 4 s deadline, one unhandled_rejection.
  //
  // The same array with a PRIMITIVE element (42 / "str" / true) or an object with no string `role`
  // did NOT hang — property access on a primitive boxes rather than throws, so the element flowed
  // through as an empty prompt and paid for a real BILLED spawn, the #360 "empty-handed" shape one
  // level down. Both halves are the same defect: the element was never validated.
  //
  // Class B.1: OpenAI's message schema is the authority
  // (https://platform.openai.com/docs/api-reference/chat/create) — each message is an object with a
  // REQUIRED string `role`. ADR 0006's grandfather provision (4th bullet) does not extend to B.1,
  // so the spec compels the 400. `isJsonObject` is the shared predicate (non-null, non-array
  // object); `role` is the schema's one load-bearing field — every later dereference is safe once
  // the element is an object, and the system/non-system split below reads `m.role` as a string.
  // `content` is deliberately NOT validated here: `contentToText` already handles missing/null
  // content defensively, and OpenAI permits a null `content` on an assistant message carrying
  // `tool_calls`/refusal, so requiring it would reject valid requests.
  const badIndex = messages.findIndex((m) => !isJsonObject(m) || typeof m.role !== "string");
  if (badIndex !== -1) {
    return jsonResponse(res, 400, { error: {
      message: `messages[${badIndex}] must be an object with a string 'role'`,
      type: "invalid_request_error",
    } });
  }

  // Multimodal validation (issue #110): when a request carries OpenAI `image_url`
  // content parts, validate/parse them now so an invalid, unsupported, or oversized
  // image returns a clean 4xx BEFORE the cache/spawn path (rather than a silent drop
  // or an opaque 500). The stream-json transform itself runs at spawn time
  // (spawnClaudeProcess → buildStreamJsonInput). Class B.1: authorized by ADR 0006;
  // request shape per OpenAI vision spec (image_url content parts). buildImageBlocks
  // validates without stringifying, so this early pass is cheap.
  if (hasImageContent(messages)) {
    // F1 (PR #154 review): the TUI path (callClaudeTui → messagesToPrompt) cannot
    // carry image blocks — it renders every non-text part as "[non-text content
    // omitted]". Forwarding here would let the model answer about an image it never
    // saw and return 200, which is strictly worse than an honest error (the one
    // outcome ALIGNMENT.md forbids: silently serving text the model did not mean).
    // Stream-json image input requires the `claude -p` path, so in TUI_MODE we fail
    // loudly instead of dropping. Documented in README § "Images".
    if (TUI_MODE) {
      return jsonResponse(res, 400, {
        error: {
          message: "Image inputs are not supported in TUI mode (CLAUDE_TUI_MODE=true). Images require the default -p spawn path; remove images or run OCP without TUI mode.",
          type: "invalid_request_error",
          code: "images_unsupported_in_tui_mode",
        },
      });
    }
    // Detection runs on the FULL message list, but extraction/spawn drop system messages
    // (system role carries no image blocks to the CLI). So an image present ONLY in a
    // system message would be detected as multimodal, survive no filter, fall to the text
    // path, and render as "[non-text content omitted]" → 200 with a hallucinated answer —
    // the exact silent-drop this guard exists to forbid. Fail loudly instead. OpenAI
    // disallows images in the system role anyway, so no legitimate request is rejected.
    // (PR #154 review round 2, gap (b).)
    const nonSystem = messages.filter(m => m.role !== "system");
    if (!hasImageContent(nonSystem)) {
      return jsonResponse(res, 400, {
        error: {
          message: "Image inputs are only supported in user/assistant messages, not in system messages. Move the image_url part to a user message.",
          type: "invalid_request_error",
          code: "images_unsupported_in_system_messages",
        },
      });
    }
    try {
      // cacheModel is the RESOLVED canonical id, so this early validation pass uses the same
      // per-model ceiling spawnClaudeProcess will apply (ADR 0011).
      buildImageBlocks(nonSystem, { ...MULTIMODAL_OPTS, maxTextChars: promptCharBudget(cacheModel) });
    } catch (e) {
      if (e instanceof MultimodalError) {
        return jsonResponse(res, e.status, { error: { message: e.message, type: e.type, code: e.code } });
      }
      throw e;
    }
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

  // Structured output (OpenAI response_format / json_mode): its own path — the response must be
  // schema-valid JSON, so it never shares the conversational cache slot. When caching is enabled it
  // uses a structured-keyed hash (isolated via cacheHash's `structured` marker) and writes back ONLY
  // a validated result (never a 422). Always validates on a miss.
  const structured = detectStructuredOutput(parsed);
  if (structured) {
    const t0s = Date.now();
    const promptCharsS = messages.reduce((a, m) => a + contentToText(m.content).length, 0);
    let structuredHash = null;
    // DO NOT collapse this with `dedupKey` below (#200). The two cacheHash calls take IDENTICAL
    // arguments and look like obvious duplicate work — they are not interchangeable, because
    // their GUARDS differ: this one additionally requires CACHE_TTL > 0. CLAUDE_CACHE_TTL
    // DEFAULTS TO 0, so in the default configuration structuredHash is null while dedupKey must
    // still be computed — it drives #153's single-flight stampede protection, which is
    // deliberately independent of whether response caching is on. `dedupKey = structuredHash`
    // would therefore silently disable stampede protection by default, in exactly the
    // concurrent-AI-Task case it exists to bound. The duplicate call is the honest price of the
    // asymmetry. If you do deduplicate it, compute once under the WEAKER guard and derive the
    // cache lookup under the stronger one — and add a stampede test before you do.
    if (CACHE_TTL > 0 && !conversationId && !hasCacheControl(messages)) {
      structuredHash = cacheHash(cacheModel, messages, { keyId: req._authKeyId, temperature: parsed.temperature, max_tokens: parsed.max_tokens, top_p: parsed.top_p, structured, configEpoch: CONFIG_EPOCH });
      try {
        const cached = getCachedResponse(structuredHash, CACHE_TTL);
        if (cached) {
          logEvent("info", "cache_hit", { model, hash: structuredHash.slice(0, 12), hits: cached.hits, structured: true });
          const id = `chatcmpl-${randomUUID()}`;
          if (stream) streamStringAsSSE(res, id, model, cached.response);
          else completionResponse(res, id, model, cached.response);
          return;
        }
      } catch (e) { logEvent("error", "cache_check_failed", { error: e.message }); }
    }
    const upstreamCall = TUI_MODE ? callClaudeTui : callClaude;
    // Stampede protection (PR #153 review, finding 5): a structured request can cost up to
    // STRUCTURED_MAX_ATTEMPTS metered spawns, so N identical concurrent requests (Home Assistant
    // firing several AI Tasks at once) must NOT each pay N× — they share one flight. We dedup every
    // one-off structured request (not stateful sessions / client-side prompt caching), independent of
    // whether OCP response caching is enabled; when caching IS on, the same key gates cache read/write.
    // Note the guard here is deliberately WEAKER than structuredHash's — no CACHE_TTL check. See the
    // do-not-collapse comment above (#200).
    const dedupKey = (!conversationId && !hasCacheControl(messages))
      ? cacheHash(cacheModel, messages, { keyId: req._authKeyId, temperature: parsed.temperature, max_tokens: parsed.max_tokens, top_p: parsed.top_p, structured, configEpoch: CONFIG_EPOCH })
      : null;
    const runStructured = async () => {
      const c = await runStructuredCompletion(upstreamCall, model, messages, conversationId, req._authKeyName, res, structured);
      if (structuredHash) { try { setCachedResponse(structuredHash, model, c); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); } }
      return c;
    };
    try {
      const content = dedupKey
        ? await singleflight(dedupKey, async () => {
            // A follower that raced in after the leader populated the cache re-reads it here.
            if (structuredHash) { const rc = getCachedResponse(structuredHash, CACHE_TTL); if (rc) return rc.response; }
            return runStructured();
          }, (err) => err instanceof RequestDisconnectedError && !res.destroyed)
        : await runStructured();
      const id = `chatcmpl-${randomUUID()}`;
      if (stream) streamStringAsSSE(res, id, model, content);
      else completionResponse(res, id, model, content);
      try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars: promptCharsS, responseChars: content.length, elapsedMs: Date.now() - t0s, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
      return;
    } catch (err) {
      if (err instanceof RequestDisconnectedError) { try { res.end(); } catch {} return; }
      try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars: promptCharsS, responseChars: 0, elapsedMs: Date.now() - t0s, success: false }); } catch {}
      if (res.headersSent || res.writableEnded || res.destroyed) { try { res.end(); } catch {} return; }
      if (err instanceof StructuredOutputError) {
        // OpenAI's spec mechanism for "model would not produce the required output" is the assistant
        // `refusal` field (200, content:null, finish_reason:"stop"), NOT an invented 422 error type —
        // so SDK clients take their written refusal branch. (PR #153 review, finding 3.)
        logEvent("warn", "structured_failed", { reason: err.reason });
        const id = `chatcmpl-${randomUUID()}`;
        const refusal = `Could not produce a response matching the requested response_format after ${STRUCTURED_MAX_ATTEMPTS} attempts (${sanitizeError(err.reason)}).`;
        if (stream) streamRefusalAsSSE(res, id, model, refusal);
        else refusalResponse(res, id, model, refusal);
        return;
      }
      return respondUpstreamError(res, err);
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
      // D1: include keyId in hash to isolate per-key cache pools (v2 format).
      // configEpoch (#176): any boot-config change that shapes answers invalidates the cache.
      const hash = cacheHash(cacheModel, messages, { keyId: req._authKeyId, temperature: parsed.temperature, max_tokens: parsed.max_tokens, top_p: parsed.top_p, configEpoch: CONFIG_EPOCH });
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
    if (TUI_MODE && TUI_STREAM) {
      // TUI-mode REAL streaming (opt-in): emit delta.content chunks as claude renders them,
      // via its MessageDisplay hook. The transcript remains authoritative (gates + cache).
      return callClaudeTuiStreaming(model, messages, conversationId, res, { keyId: req._authKeyId, keyName: req._authKeyName, cacheHash: req._cacheHash });
    }
    if (TUI_MODE) {
      // TUI-mode: no real token stream — buffer the full turn via callClaudeTui,
      // optionally write-back to cache, then replay as chunked SSE.
      // Default path (TUI_MODE===false) falls through to callClaudeStreaming below,
      // which is byte-for-byte unchanged from before this gate was added.
      const t0TuiStream = Date.now();
      const promptCharsTuiStream = messages.reduce((a, m) => a + contentToText(m.content).length, 0);
      try {
        const content = await callClaudeTui(model, messages, conversationId, req._authKeyName, res);
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
        const c = await upstreamCall(model, messages, conversationId, req._authKeyName, res);
        try { setCachedResponse(req._cacheHash, model, c); } catch (e) { logEvent("error", "cache_write_failed", { error: e.message }); }
        return c;
      },
      // M1: if the LEADER disconnected while queued (F2), its RequestDisconnectedError is
      // personal to the leader — a live follower must not inherit it as a spurious 500.
      // retryIf makes this follower re-enter singleflight with its OWN fn (own res, own
      // disconnect signal), becoming the new leader or joining a retrying sibling's flight —
      // but only while OUR client is still connected. If our client is also gone, the
      // rejection propagates and the RDE early-return in the catch below ends it quietly.
      (err) => err instanceof RequestDisconnectedError && !res.destroyed);
      const id = `chatcmpl-${randomUUID()}`;
      completionResponse(res, id, model, content);
      try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars, responseChars: content.length, elapsedMs: Date.now() - t0Usage, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
      return;
    } catch (err) {
      // L1: a client disconnect while queued is NOT an upstream failure — mirror the
      // streaming path (which returns without recording anything): no usage-failure row,
      // no [proxy] error log, no error response (the socket is gone). The disconnect is
      // already logged at info level (concurrency_wait_cancelled) by acquireClaudeSlot.
      if (err instanceof RequestDisconnectedError) { try { res.end(); } catch {} return; }
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
    const content = await upstreamCall(model, messages, conversationId, req._authKeyName, res);
    const id = `chatcmpl-${randomUUID()}`;
    completionResponse(res, id, model, content);
    try { recordUsage({ keyId: req._authKeyId, keyName: req._authKeyName, model, promptChars, responseChars: content.length, elapsedMs: Date.now() - t0Usage, success: true }); } catch (e) { logEvent("error", "usage_record_failed", { error: e.message }); }
  } catch (err) {
    // L1: disconnect-while-queued — same quiet non-error outcome as the singleflight
    // path above and the streaming path (see acquireClaudeSlot's info-level log).
    if (err instanceof RequestDisconnectedError) { try { res.end(); } catch {} return; }
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
// #411: request-context storage so the unhandledRejection handler can name the request (method +
// path) whose async callback threw. The storage runs around handleRequest, and the rejection
// handler below reads it back — the difference between "a hang went unnoticed" and "we know which
// request hung". Not endpoint-touching: no request handler change, no response shape change.
const requestContext = new AsyncLocalStorage();

async function handleRequest(req, res) {
  // Dynamic CORS: allow localhost and LAN origins
  const origin = req.headers["origin"] || "";
  const isPrivateOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
  // ADR 0020: a DECLARED origin gets its own value echoed back. Without this the gate would admit
  // the reverse-proxy dashboard's request and the BROWSER would then discard the response — the
  // same invisible failure, moved one layer out.
  let originAuthority = null;
  if (origin) { try { originAuthority = parseAuthority(new URL(origin).host); } catch { /* opaque */ } }
  const isAllowedOrigin = isPrivateOrigin || matchesDeclared(originAuthority, ALLOWED_HOSTS.hosts);
  res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin ? origin : `http://127.0.0.1:${PORT}`);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PATCH");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id");
  // ── ADR 0019: a foreign Origin may not reach anything that changes state ──────────────
  //
  // Until this gate there was NO CSRF defense here and none had been considered: `git grep -niE
  // 'csrf|cross-site request'` over the repo returned ZERO hits (positive control: `Allow-Origin`
  // returned one). `isAllowedOrigin` above decides which value goes in the RESPONSE header; it has
  // never rejected a request.
  //
  // What that cost, MEASURED against a live default-configuration instance rather than reasoned
  // about (2026-08-23): the server does not look at the inbound Content-Type — `text/plain` with a
  // malformed body answers `400 Invalid JSON`, not `415`, so the body reached JSON.parse — and
  // `text/plain` is CORS-safelisted, so a cross-origin POST carrying it needs NO PREFLIGHT. The
  // localhost branch below admits it unconditionally ("never reject"). ALLOWED_TOOLS defaults to a
  // set containing Bash/Write/Edit. And the spawned `claude` runs them WITHOUT PROMPTING: a nonce
  // file was written locally and a request through the live proxy asking it to `cat` that file came
  // back carrying the nonce — an output only execution can produce.
  //
  // So the exposure was not "a web page can burn quota". It was a web page running commands as the
  // operator, blind. NOT gated by LAN/multi-user mode — this is the default loopback deployment.
  //
  // WHY THIS SHAPE, and why it is free: a cross-origin browser request ALWAYS carries `Origin`, so
  // rejecting on it closes the chain at the first link. An ABSENT `Origin` changes nothing, which is
  // what makes the gate cost nothing — curl, the OpenAI SDKs and ocp-connect send none, so no client
  // has to change and no request shape moves. `Origin: null` (sandboxed iframe, file://) does not
  // match the allowlist and is refused, which is the intended direction.
  //
  // GET/HEAD are exempt. Not because GET is side-effect-free here — it is not: GET /usage and
  // GET /status reach fetchUsageFromApi, which POSTs a real (haiku, max_tokens:1) request to
  // api.anthropic.com and can trigger an OAuth refresh, bounded by USAGE_CACHE_TTL. The reason is
  // that an Origin gate CANNOT defend that surface in either configuration: the same effect is
  // reachable with an `<img>` whose src points at this server's own /usage, which sends NO Origin
  // at all (the literal port is deliberately not written here — see the port-literal SPOT gate in
  // alignment.yml, which exists because a stray one cascaded into a production outage). Gating
  // GET would close only the strictly narrower fetch-with-Origin shape while breaking cross-origin
  // dashboards, and would close nothing an attacker needs. No endpoint that runs a USER-SUPPLIED
  // prompt is a GET, which is the property that matters for the chain above.
  // OPTIONS is NOT exempt, so a foreign preflight fails at the preflight rather than one round trip
  // later — same outcome, earlier.
  //
  // A Content-Type requirement was designed and deliberately NOT taken; ADR 0019 records why, with
  // the measured cost (it would rewrite ~20 malformed-body assertions and break dashboard.html's
  // body-less DELETE) and the fact that it adds nothing to THIS chain.
  // SAME-ORIGIN IS ADMITTED SEPARATELY, and this half was missing from the first version of this
  // gate — caught by independent review, as a REGRESSION IT INTRODUCED rather than as a bypass.
  // Browsers send `Origin` on same-origin requests too whenever the method is not GET/HEAD (Fetch
  // Standard, "append a request Origin header", step 3 — the same-origin case is not excluded).
  // dashboard.html sets `BASE = window.location.origin` and POSTs/DELETEs to it, so an operator
  // who opens the dashboard at any address the literal allowlist above does not spell — a hostname
  // like `ocp-host.local`, `[::1]`, a Tailscale CGNAT address, a public IP, or through a TLS
  // reverse proxy, all of which README/docs tell them to do — would have had "add key" and
  // "revoke key" start returning 403. And SILENTLY: apiPost/apiDelete return `resp.json()` without
  // looking at the status, so revoking a compromised key would show a confirm, refresh the list,
  // and leave the key there with no error anywhere. A security control failing invisibly on the
  // operator's side is the wrong failure.
  //
  // Comparing the Origin's host to this request's `Host` is STRICTLY STRONGER than the allowlist
  // for the CROSS-ORIGIN case: a browser sets both headers itself and `Host` is a forbidden header
  // name, so an attacker page cannot make them match FROM A DIFFERENT ORIGIN. (A non-browser client
  // could forge both — and could equally send no `Origin` at all, so nothing is lost.)
  // `Origin: null` still fails here, because `new URL("null")` throws.
  //
  // DNS REBINDING — what ADR 0019 could not stop, and what ADR 0020 (#446) closes. An attacker who
  // serves their page on this port and flips the A record to 127.0.0.1 produces a request the
  // browser considers GENUINELY SAME-ORIGIN: `Host` and `Origin` are the attacker's domain and are
  // equal by construction. NO ORIGIN CHECK CAN CLOSE THAT, so the check moved to the OTHER header:
  // a `Host` that is an IP literal or an RFC 6761/6762 reserved name cannot have been rebound at
  // all, and any other name must appear in `OCP_ALLOWED_HOSTS`. lib/host-gate.mjs carries the
  // reasoning; the three-way behavioural split is pinned in test-features.mjs.
  //
  // THE SAME CONFIG CLOSES THE OPPOSITE FAILURE, which is why it is one setting and not two. A
  // reverse proxy that does NOT preserve `Host` (nginx's default `proxy_pass` sends the upstream's
  // address; Caddy preserves) makes `Origin` and `Host` differ for a legitimate dashboard, so the
  // same-origin arm can never fire and every mutation 403s — silently, per apiPost/apiDelete above.
  // Declaring the public name admits it as an Origin outright, before the same-origin arm is even
  // reached. Found by external review (prime) as the mirror of the rebinding finding: `Host` was
  // being pulled in opposite directions by the two, and only an operator can say which is theirs.
  const gate = evaluateOriginGate({
    origin,
    hostHeader: req.headers.host,
    method: req.method,
    declaredHosts: ALLOWED_HOSTS.hosts,
    isPrivateOrigin,
  });
  if (!gate.allow) {
    logEvent("warn", "origin_rejected", { origin, host: String(req.headers.host || ""), reason: gate.reason, method: req.method, path: req.url.split("?")[0] });
    return jsonResponse(res, 403, {
      error: {
        message: gate.reason === "undeclared-host"
          ? "Forbidden: this request is same-origin, but its Host is a public DNS name that has not been declared — which is indistinguishable from DNS rebinding. Set OCP_ALLOWED_HOSTS to the hostname you serve this proxy on (ADR 0020)."
          : "Forbidden: cross-origin request rejected. This proxy only accepts browser requests from loopback and private-range origins, from its own origin, or from a host declared in OCP_ALLOWED_HOSTS (ADR 0019, ADR 0020).",
        type: "forbidden_origin",
      },
    });
  }

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
  // GET /logs, GET /usage, GET /status, PATCH /settings
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

    return jsonResponse(res, 200, {
      status: proxyHealthStatus(binaryOk),
      version: VERSION,
      architecture: "on-demand (v2)",
      uptime: uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      claudeBinary: CLAUDE,
      claudeBinaryOk: binaryOk,
      authMode: AUTH_MODE,
      ...((isLocalhost || ADVERTISE_ANON_KEY) ? { anonymousKey: PROXY_ANONYMOUS_KEY || null } : {}),
      auth: effectiveAuthStatus(), // #308: the TTL on a request-verified verdict is applied at read time
      // #327: empty string rather than omitted, so a consumer can tell "primary" from "an older
      // build that does not report this at all" — the same distinction #324's backward-compat
      // test turned on.
      instanceName: INSTANCE_NAME,
      config: {
        timeout: TIMEOUT,
        maxConcurrent: MAX_CONCURRENT,
        circuitBreaker: "disabled",
        allowedTools: SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS,
        systemPrompt: SYSTEM_PROMPT ? `${SYSTEM_PROMPT.slice(0, 50)}...` : "(none)",
        mcpConfig: MCP_CONFIG || "(none)",
      },
      stats,
      circuitBreaker: "disabled",
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
      // `pool` is a NEW nested field inside the (already additive) tui block: null when the
      // warm pool is off (the default), so the disabled shape is unchanged apart from one
      // explicit null. Lets the operator confirm hit rate + standing process cost.
      //
      // streamEnabled + the stream* counters are likewise ADDITIVE (new fields only, same
      // grandfathered B.2 rationale — ADR 0006). streamDivergences is the one an operator
      // must watch: a non-zero value means a streamed turn was REFUSED because the deltas
      // disagreed with the transcript, which is the streaming path's only correctness risk.
      tui: buildTuiHealthBlock(
        { enabled: TUI_MODE, entrypointMode: TUI_ENTRYPOINT, maxConcurrent: TUI_MAX_CONCURRENT, streamEnabled: TUI_MODE && TUI_STREAM },
        tuiStats, tuiSemaphore, tuiPool,
      ),
    });
  }

  // GET /sessions and DELETE /sessions were REMOVED under ADR 0016. No replacement handler is
  // registered, so both now fall through to the catch-all 404 below — the same answer any other
  // unrouted path gets, and the same answer POST /sessions already gave. Verified on the wire
  // rather than assumed.

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
    req.setEncoding("utf8"); // #359: decode UTF-8 across chunk boundaries (see handleSettings)
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
    // ── What this endpoint accepts, and under what authorization ────────────────────────────
    // This is a RECORD of the accepted request shape, not an argument about whether to change it.
    // An earlier revision of this comment argued #383 must NOT be fixed, on the grounds that the
    // endpoint sat at its v3.16.4 snapshot. It did not — the name regex below has been narrowing
    // this same request shape since v3.18.0 — so ADR 0017 retired that argument and authorized
    // both halves. Do not re-derive the old one from the grandfather clause alone.
    //
    //   {}                                   -> 201, auto-named `key-<epoch-ms>`   (unchanged)
    //   {"name":"<1-64 of [A-Za-z0-9 ._-]>"}  -> 201                                (unchanged)
    //   {"name":<anything else>}              -> 400 "Invalid key name"  (below; shipped since
    //                                            v3.18.0 in 879b40f, retroactively authorized by
    //                                            ADR 0017 § Decision 2 — NOT grandfathered)
    //   anything that is not a JSON object    -> 400, here                (ADR 0017 § Decision 1)
    //
    // Class B.2, `/api/keys*` in ALIGNMENT.md's inventory. The guard below is a REQUEST-SHAPE
    // change on a grandfathered endpoint, so it is ADR 0006 route (b) — its own ADR — and NOT the
    // grandfather clause: `42`, `"str"`, `true` and `[]` were all ANSWERED 201 and each CREATED A
    // REAL KEY (measured, key store asserted, not just the status), because property access on a
    // primitive boxes instead of throwing, so `parsed.name` is `undefined` and the `||` falls to
    // the auto-name. Authorized by ADR 0006 (Class B.2 inventory) AND ADR 0017 (this change).
    //
    // The requirement — the body must be a non-null, non-array object — is stated POSITIVELY, and
    // it is stated by `isJsonObject`, the SHARED predicate, not re-inlined here. ADR 0017 as signed
    // rejected that predicate by name; that rejection was withdrawn (ADR 0017, second post-sign-off
    // correction) because it asserted a property `isJsonObject` does not have. The predicate is
    // character-for-character this requirement, and it IS #360's implementation of the very lesson
    // the rejection cited against it. An earlier revision of this comment said "Deliberately NOT
    // `isJsonObject`" — true under #360's scope, which forbade changing which requests are accepted,
    // and false here, because ADR 0017 removes exactly that constraint.
    //
    // Inlining it would also re-open what the predicates' own doc block closes: they exist so the
    // null case is "decided ONCE rather than re-remembered at each site". A fourth hand-rolled copy
    // is the fifth reader arriving carrying the bug again.
    //
    // THE ENUMERATION IS CLOSED, not sampled. `JSON.parse` with no reviver returns exactly one of
    // RFC 8259's six value productions — object, array, string, number, boolean, null. A body that
    // does not parse is already answered by the `catch` above. So this guard's admitted set is the
    // object case and its rejected set is the other five, with no residual input to have missed.
    //
    // `null` is one of those five and its behaviour is UNCHANGED: it received this exact status and
    // this exact body from #360's `parsed === null` guard, which this supersedes. #360's finding is
    // why the message exists — `JSON.parse("null")` succeeds, `parsed.name` then threw, the throw
    // escaped this `async` handler unobserved by Node, and the socket was never answered or closed.
    // The rejection body is the `{ error: "<string>" }` shape this handler already used for a
    // malformed body; no new error shape is invented here.
    if (!isJsonObject(parsed)) {
      return jsonResponse(res, 400, { error: "Expected JSON object with key-value pairs" });
    }
    const name = parsed.name || `key-${Date.now()}`;
    // Authorized by ADR 0017 § Decision 2, retroactively and as of v3.18.0 — this line entered in
    // 879b40f ("escape dashboard DB-sourced values + validate key names (#114)", 2026-05-31), after
    // the v3.16.4 snapshot ADR 0006 grandfathers this endpoint at, so ADR 0006 alone never covered
    // it. Not re-opened for redesign: widening or narrowing the charset needs its own ADR.
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
    // #379 case 1. `=== null`, never a falsy test: `""` is a legitimate decode and is answered
    // today. See decodeKeySegment for the 404-vs-400 evidence and the ADR 0006 route (a) argument.
    const idOrName = decodeKeySegment(req.url.split("/api/keys/")[1]);
    if (idOrName === null) return jsonResponse(res, 404, { error: "Key not found" });
    const revoked = revokeKey(idOrName);
    return jsonResponse(res, 200, { revoked, idOrName });
  }

  // PATCH /api/keys/:id/quota — set quota for a key
  // Body: { "daily": 100, "weekly": 500, "monthly": 2000 }  (null = unlimited)
  if (req.url?.match(/^\/api\/keys\/[^/]+\/quota$/) && req.method === "PATCH") {
    if (!isAdmin) return jsonResponse(res, 403, { error: "Admin access required" });
    // #379 case 2. This runs BEFORE the body is read, which is the whole shape of case 2 — the
    // request needs no body to hang. Answering here keeps that: a URL that cannot be decoded is
    // refused without consuming a body, rather than falling through to "Invalid JSON" and
    // diagnosing the body for a problem in the URL. See decodeKeySegment.
    const idOrName = decodeKeySegment(req.url.split("/api/keys/")[1].replace("/quota", ""));
    if (idOrName === null) return jsonResponse(res, 404, { error: "Key not found" });
    req.setEncoding("utf8"); // #359: decode UTF-8 across chunk boundaries (see handleSettings)
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
    // #360: `k in quotaBody` throws on EVERY non-object, not just on `null` — the `in` operator
    // requires an object on its right-hand side. Measured before the fix: `null`, `42`, `"str"`
    // and `true` each left the socket unanswered and open (four hangs on this route, where the
    // issue reported one), the throw escaping this `async` handler into `unhandledRejection`.
    //
    // Arrays are NOT caught here, deliberately: `typeof [] === "object"`, so `[]` and `[1,2]`
    // reach the loop below and already answer 400 "Provide at least one of: daily, weekly,
    // monthly" (measured). Adding `Array.isArray` would change that answered input's message for
    // no defect. The rule is that only inputs which today receive NO response change behaviour.
    // Authorized by ADR 0006 (grandfathered as of v3.16.4); contract unchanged — request shape,
    // response shape and semantics all as documented, and the `{ error: "<string>" }` shape is the
    // one this handler already uses for its other rejections.
    if (!isLegalInOperand(quotaBody)) {
      return jsonResponse(res, 400, { error: "Expected JSON object with key-value pairs" });
    }
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
    // #379's SIBLING, not in its table: the same unguarded call on the adjacent route, measured to
    // hang identically. Folded in under Iron Rule 11 §11.1 rather than deferred. See decodeKeySegment.
    const idOrName = decodeKeySegment(req.url.split("/api/keys/")[1].replace("/quota", ""));
    if (idOrName === null) return jsonResponse(res, 404, { error: "Key not found" });
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
    // #379: both were `Math.min(parseInt(<param> || "<default>", 10), <cap>)`, which yields NaN
    // for any non-numeric value and hands it to a sink that throws. usageQueryInt is that same
    // expression with a finiteness check appended AFTER the clamp — the order matters, see its
    // comment.
    const recentAll = getRecentUsage(usageQueryInt(url.searchParams.get("limit"), 50, 500));
    const timeline = getUsageTimeline({
      keyName: scopeName || undefined,
      hours: usageQueryInt(url.searchParams.get("hours"), 24, 720),
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

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health, GET /usage, GET /status, GET /logs, GET|PATCH /settings, GET /dashboard, GET|POST|DELETE /api/keys, GET|PATCH /api/keys/:id/quota, GET /api/usage, GET /cache/stats, DELETE /cache" });
}

const server = createServer((req, res) => {
  return requestContext.run({ method: req.method, path: req.url ? req.url.split("?")[0] : null }, () => handleRequest(req, res));
});


// ── Process-level safety nets ────────────────────────────────────────────
// Prevent unhandled async rejections and synchronous exceptions from crashing
// the daemon. Each registers once at module level so they are installed before
// the first request arrives. These are global no-ops on the happy path.
process.on("unhandledRejection", (e) => {
  // #411: name the request whose async callback threw, or the record is unactionable — the whole
  // point of this issue is that four live hangs went unnoticed because the log said only the error,
  // never which request produced it. Honest limit: a rejection that escapes before requestContext.run
  // (or before the router parsed anything) has method/path null — say so rather than emit a field
  // that is sometimes a lie.
  const ctx = requestContext.getStore();
  logEvent("error", "unhandled_rejection", {
    error: e && e.message ? e.message : String(e),
    method: ctx?.method ?? null,
    path: ctx?.path ?? null,
  });
});
process.on("uncaughtException", (e) =>
  logEvent("error", "uncaught_exception", { error: e && e.message ? e.message : String(e) })
);
// Destroy the socket on low-level HTTP parse errors so broken connections
// don't accumulate as open file descriptors.
server.on("clientError", (err, socket) => { try { socket.destroy(); } catch {} });

// #412: a bind failure reaches the global uncaughtException handler and is swallowed, so the
// process stays alive and never listens. "Up but not listening" is the worst of the three states:
// a process-liveness check passes, Restart= never fires, and every client fails — nothing an
// operator would check says anything is wrong. Class: not endpoint-touching (no request handler,
// no response shape). Distinguish the boot-time bind from a later error: exit non-zero ONLY when
// the server never began serving; a post-listen error (an established connection failing) is
// logged, not fatal — conflating them would be a different change.
let _listening = false;
server.on("error", (err) => {
  if (!_listening) {
    console.error(`FATAL: failed to bind ${BIND_ADDRESS}:${PORT} — ${err.message}`);
    process.exit(1);
  }
  logEvent("error", "server_error", { error: err.message });
});

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
  clearInterval(authCheckInterval);
  clearInterval(cacheCleanupInterval);
  if (tuiReapInterval) clearInterval(tuiReapInterval);
  closeDb();

  // 2b. Drain the warm pane pool. A pooled `claude` is a child of the tmux SERVER, not of
  // this node process, so it is NOT in activeProcesses and step 3 below cannot reach it —
  // without this explicit drain every warm pane would outlive OCP as an orphan (and the
  // pool's in-memory registry dies with the process, so nothing would remember it owned them).
  //
  // drain() kills the pane that is currently BOOTING too, and it does so SYNCHRONOUSLY. That
  // is required, not incidental: step 4 below calls process.exit(0) in THIS SAME TICK whenever
  // activeProcesses is empty — which on a TUI host it always is — so any cleanup a boot
  // deferred to a .then()/.catch() would simply never run. (That was a real bug: the pool used
  // to track in-flight boots as a count, could not name the booting session, and orphaned a
  // live authenticated `claude` on every shutdown that landed mid-boot.)
  //
  // Orphans that survive anyway (SIGKILL, power loss) are still caught by the next instance's
  // boot reap — this makes the graceful path clean, it is not the only safety net.
  if (tuiPool) {
    try {
      const drained = tuiPool.drain();
      if (drained) logEvent("info", "tui_pool_drained", { count: drained, trigger: "shutdown" });
    } catch (e) { logEvent("error", "tui_pool_drain_failed", { error: e.message }); }
  }

  // 2c. Kill the pane an IN-FLIGHT TURN is holding (#362). Step 2b above reaches only panes the
  // POOL owns: an acquired pane has LEFT the pool (that is by design — see POOL/REAPER INVARIANT
  // property 2) and a cold-booted pane was never in it, so drain() cannot see either. Neither is
  // in activeProcesses, for the same reason the pool needs 2b at all — a pane's `claude` is a
  // child of the tmux SERVER, not of node. That pane was therefore owned by nothing here, and
  // step 4's process.exit(0) — which fires in THIS SAME TICK on a TUI host — meant runTuiTurn's
  // own finally never ran. The result was a live, interactive, AUTHENTICATED `claude` outliving
  // the process that was supposed to own it, for any shutdown that landed mid-turn.
  //
  // Same tick, same reason as 2b: killLiveTurnPanes() is synchronous by construction, and its
  // header says why a deferred version would silently do nothing.
  //
  // The two sets are DISJOINT — a pane is either in the pool or held by a turn, never both — so
  // the order of 2b and 2c is not load-bearing.
  //
  // Unconditional, deliberately: with TUI mode off the registry is empty and this issues no tmux
  // command at all, which is a stronger guarantee than a TUI_MODE gate that could be wrong.
  try {
    const orphans = killLiveTurnPanes();
    if (orphans) logEvent("info", "tui_turn_panes_killed", { count: orphans, trigger: "shutdown" });
  } catch (e) { logEvent("error", "tui_turn_pane_kill_failed", { error: e.message }); }

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
  _listening = true;
  const bindMsg = BIND_ADDRESS === "0.0.0.0" ? `http://0.0.0.0:${PORT} (LAN mode)` : `http://127.0.0.1:${PORT}`;
  console.log(`openclaw-claude-proxy v${VERSION} listening on ${bindMsg}`);
  // ADR 0020: a token that did not parse is a name the operator BELIEVES they declared. Say so at
  // boot rather than at the 403, because the 403 arrives on someone else's screen. Not fatal — a
  // refusing boot would take the proxy down to fix a misspelling.
  if (ALLOWED_HOSTS.invalid.length) {
    console.warn(`WARNING: OCP_ALLOWED_HOSTS — ignored ${ALLOWED_HOSTS.invalid.length} unparseable entr${ALLOWED_HOSTS.invalid.length === 1 ? "y" : "ies"}: ${ALLOWED_HOSTS.invalid.join(", ")}`);
    console.warn(`         Expected a comma-separated list of host[:port], e.g. "ocp.example.com,dash.example.com:8443".`);
  }
  if (ALLOWED_HOSTS.defaultPort.length) {
    console.warn(`WARNING: OCP_ALLOWED_HOSTS — ${ALLOWED_HOSTS.defaultPort.join(", ")} names a port that Origin usually omits.`);
    console.warn(`         If you serve HTTPS on 443 (or HTTP on 80) this entry cannot match — declare the bare host, e.g. "${ALLOWED_HOSTS.defaultPort[0].split(":")[0]}".`);
    console.warn(`         If you serve PLAIN HTTP on 443 (or HTTPS on 80) the entry is correct as written and this warning does not apply.`);
    console.warn(`         Kept either way: OCP cannot tell which, because a declaration carries no scheme.`);
  }
  console.log(`Architecture: on-demand spawning (no pool)`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT / 1000}s | Max concurrent: ${MAX_CONCURRENT} | Queue: ${CLAUDE_MAX_QUEUE} (429 on overflow)`);
  console.log(`Circuit breaker: disabled`);
  // Multi-tenant is its own arm because ALLOWED_TOOLS is NOT what that mode passes: the branch in
  // buildCliArgs pushes `--tools ""` and never `--allowedTools`, so printing the ALLOWED_TOOLS
  // list here told an operator running a multi-tenant instance that guests had Bash/Read/Write.
  // Console banner only. The B.2 field is the `allowedTools` member of the `config` object in
  // the /health response body; find the /health handler and read its config block. NO GREP STRING
  // IS GIVEN ON PURPOSE: two earlier revisions of this comment named one, and each time the
  // comment itself became a second hit, falsifying its own "the sole hit" claim. A locator that
  // must not appear in the locator is not a string, it is a place. That field is deliberately
  // NOT touched: it is a
  // grandfathered Class B.2 response field, and changing the rule that determines its value is a
  // contract change needing its own ADR (CLAUDE.md § Class B.2), not a truthfulness fix.
  // An earlier revision of this comment said `/status`. It was wrong, and wrong in the way
  // AGENTS.md names as its own defect class: the reasoning survived (both endpoints are equally
  // grandfathered) while the NAME it rested on did not, so a maintainer following the instruction
  // would have grepped /status, found nothing, and been unable to tell whether it applied.
  console.log(`Tools: ${AUTH_MODE === "multi" ? 'none (multi-tenant: --tools "" empties the built-in schema)'
                      : SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS.join(", ")}`);
  if (SYSTEM_PROMPT) console.log(`System prompt: "${SYSTEM_PROMPT.slice(0, 80)}..."`);
  if (MCP_CONFIG) console.log(`MCP config: ${MCP_CONFIG}`);
  console.log(`Auth: ${PROXY_API_KEY ? "enabled (PROXY_API_KEY set)" : "disabled (no PROXY_API_KEY)"}`);
  console.log(`Auth mode: ${AUTH_MODE}${AUTH_MODE === "shared" ? " (PROXY_API_KEY)" : AUTH_MODE === "multi" ? " (per-user keys)" : " (open)"}`);
  console.log(`Bind: ${BIND_ADDRESS}${BIND_ADDRESS === "0.0.0.0" ? " ⚠ LAN-accessible" : ""}`);
  if (LOCAL_TOOLS_ACTIVE) console.log(`Local tools: ON (OCP_LOCAL_TOOLS=1) — model told it may use local tools; single-user/loopback only`);
  else if (LOCAL_TOOLS) console.warn(`⚠ OCP_LOCAL_TOOLS=1 is ignored in TUI mode (the -p system-prompt wrapper is not used). The TUI tool surface is governed by OCP_TUI_FULL_TOOLS.`);
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
    console.log(TUI_POOL_SIZE > 0
      ? `  TUI warm pool: ON size=${TUI_POOL_SIZE} — ${TUI_POOL_SIZE} idle \`claude\` process(es) held warm; first request per model is still a cold MISS`
      : `  TUI warm pool: OFF (set OCP_TUI_POOL_SIZE=1..${POOL_MAX_SIZE} to pre-boot panes and cut ~3-4s per request)`);
    try {
      // F7 fix: scope to THIS instance's own port (see reapStaleTuiSessions). includeLegacy:
      // true ONLY here — the one-time boot reap is the designated point to claim orphaned
      // bare-prefix ("ocp-tui-<uuid8>") zombie sessions left by a PRE-fix process generation
      // of this same instance (no live post-fix instance ever creates that shape again).
      // No `spare`: the warm pool is EMPTY at boot (there is no boot-time pre-warm — the pool
      // learns its model from the first request), so this reap has no live pane to protect and
      // it is exactly what SHOULD claim any ocp-tui-<port>-p* pool orphans left by a previous
      // process generation of this instance (POOL/REAPER INVARIANT property 2). If a future
      // change ever pre-warms at boot, this call MUST start passing tuiPool.liveNames().
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
