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
