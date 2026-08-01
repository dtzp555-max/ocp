// lib/prompt.mjs — pure operator-append step for the system prompt.
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
// TRUTHINESS (not != null) on the env value deliberately: an EMPTY value
// ("CLAUDE_MAX_PROMPT_CHARS=" in a systemd EnvironmentFile or .env) must mean "use the
// default". Treating "" as explicit gives parseInt("") = NaN, and a NaN cap silently DISABLES
// the runaway-context guard while injecting a false "[System] Note: 0 older messages were
// truncated" line into every prompt (caught in PR #179 review). Non-empty garbage now also
// returns null rather than NaN — fail-closed to the derivation, matching parseIntEnv.
export function resolveGlobalPromptCharOverride(rawEnv) {
  if (!rawEnv) return null;
  const n = parseInt(rawEnv, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
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
// This does NOT expand the tool surface: tools are governed solely by `--allowedTools` /
// `--disallowedTools` (multi-tenant mode `--disallowedTools` the whole FS surface regardless of the
// wrapper). It only changes the PROMPT the operator's own model reads. Pure so it is unit-testable.
export function selectPromptWrapper(localToolsEnabled, negativeWrapper, positiveWrapper) {
  return localToolsEnabled ? positiveWrapper : negativeWrapper;
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
