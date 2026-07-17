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
