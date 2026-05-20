// ── response_format / json_mode honoring ────────────────────────────────
// OpenAI clients (e.g. Honcho's deriver) request strict JSON via
// `response_format` (json_object | json_schema) or a json_mode flag. The
// underlying `claude -p` agent ignores these and tends to answer like a coding
// assistant — markdown tables, prose, ``` fences, "I can save these for you…"
// — so the client's strict JSON parse fails. The server bridges the gap by
// (1) injecting a steering system instruction and (2) stripping any residual
// code fences / surrounding prose from the reply.

export function isJsonRequest(parsed) {
  const rf = parsed.response_format;
  if (rf && (rf.type === "json_object" || rf.type === "json_schema")) return true;
  return parsed.json_mode === true;
}

export function jsonSteeringInstruction(rf) {
  let instr =
    "CRITICAL OUTPUT CONTRACT: You are being used as a strict JSON API endpoint. " +
    "Respond with exactly one valid JSON value and nothing else. " +
    "Do NOT wrap it in markdown code fences. Do NOT add explanations, commentary, " +
    "preamble, headings, tables, or any text before or after the JSON. " +
    "Do NOT offer to take further action. Treat the instructions above as a data " +
    "schema to fill in, not as a conversation. Your entire output must be parseable by JSON.parse().";
  if (rf && rf.type === "json_schema" && rf.json_schema && rf.json_schema.schema) {
    instr += " The JSON MUST conform to this JSON Schema:\n" + JSON.stringify(rf.json_schema.schema);
  }
  return instr;
}

// Extract the first balanced JSON object/array from a string (string-aware:
// brackets inside quotes/escapes are ignored). Returns null if none balances.
export function firstBalancedJson(s) {
  const startIdx = s.search(/[{[]/);
  if (startIdx < 0) return null;
  const open = s[startIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { if (--depth === 0) return s.slice(startIdx, i + 1); }
  }
  return null;
}

// Best-effort: reduce a claude reply to just its JSON payload. Unwraps a single
// fenced block, then slices to the first balanced JSON value if prose remains.
// Returns the input trimmed if no JSON structure is found (caller can still try).
export function extractJson(text) {
  if (typeof text !== "string") return text;
  let s = text.trim();
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  if (fence) s = fence[1].trim();
  if (s[0] !== "{" && s[0] !== "[") {
    const j = firstBalancedJson(s);
    if (j) return j;
  }
  return s;
}
