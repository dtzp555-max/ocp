// lib/prompt.mjs — pure operator-append step for the system prompt.
//
import { parsePositiveInt } from "./env.mjs";
//
// Extracted so the rule is unit-testable (the suite never imports server.mjs — it
// boots a listener). server.mjs composes wrapper + client system messages exactly as
// before, then passes the result through this. With CLAUDE_SYSTEM_PROMPT unset the
// return is the INPUT STRING UNCHANGED — the default path stays byte-for-byte
// identical, which is the repo's bar for touching a request-shaping function.
//
// The operator prompt goes LAST deliberately: a server-wide directive ("answer in
// Chinese") should read as the final instruction, not something a client system
// message overrides by coming later. Whitespace-only values are treated as unset —
// a stray space in a service unit's Environment= line must not inject "\n\n " into
// every request.
export function appendOperatorPrompt(base, operatorAppend) {
  const op = typeof operatorAppend === "string" ? operatorAppend.trim() : "";
  return op ? `${base}\n\n${op}` : base;
}

// Derive the prompt-char budget from the models.json SPOT, PER MODEL (ADR 0011,
// superseding ADR 0009's global max()).
//
// ADR 0009 made the budget follow the SPOT instead of a hand-set constant, but derived ONE
// global number as `max(models[].contextWindow) × charsPerToken`. That coupling is why
// models.json had to lie: every native-1M model was declared at 200000, because a single 1e6
// entry would have raised the ceiling from 600k to 3M for EVERY model — including
// claude-haiku-4-5, which really is 200k, turning graceful OCP-side truncation into an
// upstream API rejection (#213). The budget is now looked up for the model the request
// actually named, so models.json can state each model's true window:
//
//   budget(model) = models[model].contextWindow × charsPerToken
//
// charsPerToken = 3 is deliberately conservative and unchanged from ADR 0009: English runs
// ~4 chars/token, CJK ~1–1.5. At ×3, a 200k-token window yields 600,000 chars — full window
// for English, and CJK text hits the model's real window at roughly the same point the cap
// fires, so we truncate (graceful, tail-first) rather than let the upstream reject outright.
//
// The floor guards degenerate SPOT states (absent/garbage contextWindow): fall back to the
// historical constant rather than 0 — a zero budget would truncate every request to nothing,
// which is fail-OPEN in the "serve garbage" sense.
//
// `modelId` must be the RESOLVED canonical id (server.mjs passes `MODEL_MAP[model] || model`),
// not a client-supplied alias. An id with no SPOT entry gets fallbackPromptCharBudget() —
// see there for why that is the smallest known window and not the largest.
export function promptCharBudgetFor(models, modelId, { charsPerToken = 3, floor = 150000 } = {}) {
  const entry = (Array.isArray(models) ? models : []).find(m => m?.id === modelId);
  const w = entry?.contextWindow;
  if (!Number.isFinite(w) || w <= 0) return fallbackPromptCharBudget(models, { charsPerToken, floor });
  return Math.max(floor, w * charsPerToken);
}

// The budget for a model OCP has no SPOT entry for, and the single number GET /settings
// reports when no global override is set.
//
// MIN across the registry, not max: for an unknown model the safe assumption is the SMALLEST
// window OCP knows about, so an unrecognised id can never be handed a budget larger than any
// model actually supports. Today every entry that is not native-1M is 200000, so this is
// 600,000 chars — byte-identical to what ADR 0009's global max() produced before the 1M
// windows were declared, which is why the default-path /settings response does not move.
export function fallbackPromptCharBudget(models, { charsPerToken = 3, floor = 150000 } = {}) {
  const windows = (Array.isArray(models) ? models : [])
    .map(m => m?.contextWindow)
    .filter(w => Number.isFinite(w) && w > 0);
  if (windows.length === 0) return floor;
  return Math.max(floor, Math.min(...windows) * charsPerToken);
}

// Resolve the GLOBAL operator override from the env var. Returns a positive integer when the
// operator set one, or null meaning "no override — derive per model".
//
// Delegates to parsePositiveInt (lib/env.mjs) rather than calling parseInt itself, so this
// knob fails closed on exactly the inputs every other numeric cap rejects. A bare
// `parseInt(raw, 10)` is NOT equivalent and is actively dangerous here: parseInt consumes a
// valid PREFIX and discards the rest, so `CLAUDE_MAX_PROMPT_CHARS=1M` parses to **1** and
// `600k` to **600** — a near-zero ceiling applied to EVERY model, truncating every prompt to
// the system text plus a truncation note, and silently, because the caller's warning only
// fires when this returns null. `1M` is a plausible thing to type given the README now quotes
// budgets in the millions. parsePositiveInt's `String(n) !== trimmed` check is what rejects a
// partially-consumed parse; that guard exists because of the identical CLAUDE_MAX_BODY_SIZE=5MB
// hazard (PR #154 review F3), and this knob must not opt out of it.
//
// Unset and EMPTY both mean "no override" — parsePositiveInt maps missing/"" to { value: def,
// ok: true }, so with def = null they return null rather than NaN. That preserves the PR #179
// review contract: "CLAUDE_MAX_PROMPT_CHARS=" in a systemd EnvironmentFile must fall back to
// the derivation, because a NaN cap silently DISABLES the runaway-context guard while injecting
// a false "[System] Note: 0 older messages were truncated" line into every prompt.
export function resolveGlobalPromptCharOverride(rawEnv) {
  const { value, ok } = parsePositiveInt(rawEnv, null);
  return ok ? value : null;
}

// OCP_LOCAL_TOOLS system-prompt wrapper selection (pure).
//
// OCP's `-p` path prepends a fixed wrapper to every request's system prompt. The DEFAULT wrapper
// tells the model it has NO local filesystem/shell/env access — the right posture for a shared or
// multi-tenant gateway. But a single-user, loopback-bound instance (e.g. an OpenClaw agent talking
// to its own local OCP) DOES legitimately have tools — the `-p` path already passes `--allowedTools`
// and the CLI's built-in tools are available — so the default wrapper actively gaslights the model
// into refusing to use tools it holds. `OCP_LOCAL_TOOLS=1` swaps in a positive wrapper for that case.
//
// This does NOT expand the tool surface -- never by the wrapper, which only changes the PROMPT the
// operator's own model reads. What DOES govern it, each clause measured off the `system` init
// `tools` array of `--output-format stream-json --verbose` against a 76-tool unrestricted
// baseline. THE BASELINE'S CONDITIONS ARE PART OF THE MEASUREMENT and are named for the reason
// server.mjs's buildCliArgs comment demonstrates: the model and the config dir move this number
// with no CLI release involved, so "76" without them cannot be told apart from drift. Taken on
// claude 2.1.247, default model (no --model), CLAUDE_CONFIG_DIR unset, cwd inside this repo:
//
//   --tools Read            -> 50 tools, Bash absent   the built-in AVAILABILITY registry; the 49
//                                                      that remain are all mcp__*, so it governs
//                                                      built-ins only
//   --disallowedTools Bash  -> 77 tools, Bash absent   REMOVES the name from the schema (and the
//                                                      CLI adds Glob+Grep in its place, which is
//                                                      why 77 > 76)
//   --allowedTools Read     -> 76 tools, Bash PRESENT  pre-approval ONLY; changes nothing about
//                                                      what exists
//
// An earlier revision of this comment said --disallowedTools decides "which may run without a
// prompt". That is true of --allowedTools and false of --disallowedTools, and the row above is
// the counter-example.
// This sentence used to end "(multi-tenant mode `--disallowedTools` the whole FS surface regardless
// of the wrapper)". Both halves of that are now false: multi-tenant passes `--tools ""`, and the
// deny-list it used to pass never covered "the whole FS surface" in the first place. Corrected here
// rather than only in README.md, which carried the same sentence -- fixing one reader of a drifted
// invariant and walking away is how the same defect comes back on another leg.
// Pure so it is unit-testable.
// Which system-prompt wrapper OCP prepends, chosen from the tool surface the SAME spawn actually
// grants (server.mjs's buildCliArgs branch) rather than from a flag that can drift away from it.
//
// WHY THIS IS NOT A BOOLEAN ANY MORE. The default wrapper told the model it had no filesystem,
// working directory or shell while the same spawn passed
// `--allowedTools Bash,Read,Write,Edit,Glob,Grep,...`. MEASURED 2026-09-09 on claude 2.1.260,
// reading the `tools` array of the `system` init event under the exact flags buildCliArgs pushes
// — the instrument server.mjs's multi-mode block already established as the authoritative one,
// because asking the model its own tools was measured to lie:
//
//   AUTH_MODE=multi branch   `--tools "" --strict-mcp-config --disallowedTools mcp__*`  ->  0 tools
//   every other branch       `--allowedTools Bash Read Write ...`                       -> NON-EMPTY
//                                                                     (incl. Bash, Edit, Glob, Grep)
//
// THE RIGHT-HAND COLUMN IS DELIBERATELY NOT A NUMBER on the second row, and the expiry below is why:
// the first version wrote 27, an independent review re-ran the same instrument on the same host and
// got 82 (49 of them `mcp__*` account connectors, because --strict-mcp-config and
// --disallowedTools mcp__* are passed only in multi mode). Both are real. The load-bearing claim is
// EMPTY vs NON-EMPTY, and that is what is written.
//
// So the denial was TRUE in multi mode and FALSE everywhere else. It is not a restriction either
// way — a prompt cannot remove a tool — and ADR 0021 records it being declined out loud by a model
// that then used the tool anyway. EXPIRY: the two rows are a function of the invocation, not
// constants; re-measure with the same instrument rather than quoting 27 if you need a number.
//
// Three wrappers, because there are three distinct truths and collapsing any two re-creates a lie:
//
//   negative — the schema is empty (multi). The denial is accurate. BYTE-IDENTICAL to what shipped
//              before this change: the untrusted-caller path is deliberately not touched here.
//   neutral  — tools ARE granted, and OCP is not inviting their use. Makes no capability claim at
//              all, and keeps the anti-invention clause the negative wrapper carried.
//   positive — OCP_LOCAL_TOOLS=1: an explicit invitation to act on the operator's machine. Its boot
//              gate (localToolsSafetyError, below) is UNCHANGED and this function does not relax
//              it; `localToolsInvited` is only ever true after that gate has already passed.
//
// EXPIRY: if buildCliArgs gains a branch with a different tool surface, this gains a case.
// SAY WHAT IS ACTUALLY PINNED, because an earlier revision of this comment claimed "that is not
// left to vigilance -- the integration tests assert the prompt and the flags FROM THE SAME SPAWN,
// so adding a branch there without one here reddens", and an independent review falsified it: the
// tests boot ONE configuration each, so a branch reachable only under a third was invisible to all
// of them. It demonstrated this by giving the SKIP_PERMISSIONS arm an empty schema with no matching
// wrapper case -- this defect in mirror image -- and the whole co-location set stayed 9 passed / 0
// failed. `CLAUDE_SKIP_PERMISSIONS` appeared ZERO times in test-features.mjs at the time.
//
// buildCliArgs has THREE arms and all three are now booted: multi (`--tools ""`), skip-permissions
// (`--dangerously-skip-permissions`), and the default (`--allowedTools ...`). Each of those tests
// asserts the prompt and the flags from the same spawn, so THOSE THREE cannot drift. A FOURTH arm
// would still need its own boot -- that is a thing a person has to do, not a thing the suite
// detects, and pretending otherwise is what this paragraph got wrong the first time.
export function selectPromptWrapper(surface, wrappers) {
  if (!surface || typeof surface !== "object") {
    throw new TypeError(
      "selectPromptWrapper(surface, wrappers): `surface` must be an object " +
      "{ toolsGranted, localToolsInvited }. Until 2026-09-09 this took three positional arguments " +
      "(localToolsEnabled, negative, positive); a stale positional call would destructure `false` " +
      "without throwing and silently select a wrapper that contradicts the spawn's tool surface, " +
      "which is the exact defect this signature change exists to remove."
    );
  }
  const { negative, neutral, positive } = wrappers || {};
  if (!negative || !neutral || !positive) {
    throw new TypeError(
      "selectPromptWrapper: `wrappers` must carry all three of { negative, neutral, positive } — " +
      "a missing one would fall through to `undefined` and prepend the string \"undefined\" to " +
      "every system prompt."
    );
  }
  if (surface.localToolsInvited) return positive;
  return surface.toolsGranted ? neutral : negative;
}

// Boot-time safety gate for OCP_LOCAL_TOOLS, mirroring the OCP_TUI_FULL_TOOLS model (ADR 0007): a
// positive "you may use local tools" wrapper must never reach an untrusted caller. Returns a fatal
// message string when the flag is enabled in an unsafe deployment, or null when it is safe/disabled.
// Fail-closed: any of multi-tenant auth, a non-loopback bind, or an anonymous key is refused. Pure —
// the caller does the process.exit so this stays testable.
export function localToolsSafetyError({ enabled, authMode, loopbackBind, anonymousKey }) {
  if (!enabled) return null;
  if (authMode === "multi") {
    return "OCP_LOCAL_TOOLS=1 is incompatible with CLAUDE_AUTH_MODE=multi — a guest/anonymous prompt would be told it may drive the operator's filesystem/shell. Single-user only.";
  }
  if (!loopbackBind) {
    return "OCP_LOCAL_TOOLS=1 requires a loopback bind (127.0.0.1/::1) — a network-exposed positive-tools wrapper could reach an untrusted peer. Bind to loopback, or leave OCP_LOCAL_TOOLS off.";
  }
  if (anonymousKey) {
    return "OCP_LOCAL_TOOLS=1 is unsafe with PROXY_ANONYMOUS_KEY set — anonymous callers could reach the local-tools-enabled model without a named key. Remove PROXY_ANONYMOUS_KEY, or leave OCP_LOCAL_TOOLS off.";
  }
  return null;
}
