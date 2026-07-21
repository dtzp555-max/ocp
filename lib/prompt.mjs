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

// Derive the default prompt-char budget from the models.json SPOT (ADR 0009).
//
// The old default was a hand-set constant (150000 chars ≈ 37.5k English tokens) from the
// 200k-window era — silently far below what the advertised contextWindow promises. Instead
// of picking a new constant that will also rot, the default now FOLLOWS the SPOT:
//
//   budget = max(models[].contextWindow) × charsPerToken
//
// charsPerToken = 3 is deliberately conservative: English runs ~4 chars/token, CJK ~1–1.5.
// At ×3, a 200k-token window yields 600,000 chars — full window for English, and CJK text
// hits the model's real window at roughly the same point the cap fires, so we truncate
// (graceful, tail-first) rather than let the upstream reject the request outright.
//
// The floor guards the degenerate cases (empty/missing models[], absent contextWindow):
// fall back to the historical constant rather than 0 — a zero budget would truncate every
// request to nothing, which is fail-OPEN in the "serve garbage" sense. CLAUDE_MAX_PROMPT_CHARS
// remains an absolute operator override at the call site (server.mjs); this function is only
// the unset-env default.
export function derivePromptCharBudget(models, { charsPerToken = 3, floor = 150000 } = {}) {
  const windows = (Array.isArray(models) ? models : [])
    .map(m => m?.contextWindow)
    .filter(w => Number.isFinite(w) && w > 0);
  if (windows.length === 0) return floor;
  return Math.max(floor, Math.max(...windows) * charsPerToken);
}

// Resolve the effective budget from the env var + SPOT. TRUTHINESS (not != null) on the env
// value deliberately: an EMPTY value ("CLAUDE_MAX_PROMPT_CHARS=" in a systemd EnvironmentFile
// or .env) must mean "use the default" — exactly the old `parseInt(env || "150000")` contract.
// Treating "" as explicit gives parseInt("") = NaN, and a NaN cap silently DISABLES the
// runaway-context guard while injecting a false "[System] Note: 0 older messages were
// truncated" line into every prompt (caught in PR #179 review). Non-empty garbage still
// parses to NaN — the pre-existing class, slated for parseIntEnv routing in PR #154.
export function resolvePromptCharBudget(rawEnv, models, opts) {
  return rawEnv ? parseInt(rawEnv, 10) : derivePromptCharBudget(models, opts);
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
