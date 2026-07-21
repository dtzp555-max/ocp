// ── OpenAI Structured Outputs (response_format) — pure helpers ───────────────
//
// OCP's `/v1/chat/completions` (Class B.1, ADR 0006) advertises OpenAI compatibility but forwards
// to `claude -p`, which has no native `response_format`. Asked for JSON, the coding-assistant CLI
// typically replies with prose, a Markdown table, or a ```json fenced block — none of which is
// `JSON.parse`-able. These helpers implement the OpenAI `response_format` contract on top of that:
// detect the request, build a strict JSON-only steering instruction, then extract and validate the
// JSON the model returns. All functions here are pure (no I/O) so they are unit-tested directly;
// the retry loop that calls the model lives in server.mjs (runStructuredCompletion).
//
// Spec authority (B.1, ADR 0006): OpenAI chat/completions `response_format`
//   https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format
// No field or behaviour beyond that published shape is introduced.

export class StructuredOutputError extends Error {
  constructor(reason, raw) {
    super(`structured output could not be produced: ${reason}`);
    this.name = "StructuredOutputError";
    this.reason = reason;
    this.raw = raw;
  }
}

// Fail-closed parse of the OCP_STRUCTURED_MAX_ATTEMPTS retry cap. `Math.max(1, parseInt("abc",10))`
// === `Math.max(1, NaN)` === NaN, and a retry loop bounded by `attempt < NaN` never runs → 0 spawns,
// every structured request silently refuses. So any non-integer / non-finite / <1 value keeps the
// documented default instead (and warns), rather than bricking the feature. (PR #153 review round 2.)
export function resolveMaxAttempts(raw, { fallback = 3, warn } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    if (typeof warn === "function") {
      warn(`Ignoring invalid OCP_STRUCTURED_MAX_ATTEMPTS="${raw}" (want integer >= 1); using default ${fallback}.`);
    }
    return fallback;
  }
  return n;
}

// Returns { mode: "schema", schema, name?, strict } | { mode: "json_object" } | null.
// Supports the OpenAI shapes: response_format:{type:"json_schema",json_schema:{schema,strict,name}}
// and response_format:{type:"json_object"}, a lenient response_format:{schema} fallback, and the
// widely-used (non-standard) top-level `json_mode: true` flag as a json_object alias.
export function detectStructuredOutput(parsed) {
  const rf = parsed?.response_format;
  if (rf && typeof rf === "object") {
    if (rf.type === "json_schema") {
      const js = (rf.json_schema && typeof rf.json_schema === "object") ? rf.json_schema : {};
      const schema = js.schema || rf.schema || null;
      return { mode: "schema", schema, name: js.name, strict: js.strict === true };
    }
    if (rf.type === "json_object") return { mode: "json_object" };
    if (rf.schema && typeof rf.schema === "object") {
      return { mode: "schema", schema: rf.schema, strict: rf.strict === true };
    }
  }
  // Non-standard convenience alias honored by several OpenAI-compatible clients.
  if (parsed?.json_mode === true) return { mode: "json_object" };
  return null;
}

export function jsonTypeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // object | string | number | boolean
}

export function jsonTypeMatches(t, value) {
  switch (t) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true; // unknown type keyword → do not fail on it
  }
}

const jsonDeepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Resolve a local JSON-Pointer `$ref` (e.g. "#/$defs/Step" or "#/definitions/Step") against the
// document root. Only same-document refs are supported (that is all the OpenAI SDK emits); a remote
// or unresolvable ref returns null and the caller skips validation for it rather than failing.
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/") || !root) return null;
  const parts = ref.slice(2).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = root;
  for (const p of parts) {
    if (cur && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
    else return null;
  }
  return (cur && typeof cur === "object") ? cur : null;
}

// Minimal JSON-Schema validator: covers the subset OpenAI structured outputs use — type (incl.
// arrays of types / integer), required, properties, additionalProperties (no invented keys), items
// (list + tuple), enum, const, nullability (type:["x","null"] or nullable:true), min/maxItems, and
// $ref/$defs + allOf/anyOf/oneOf composition (which the official OpenAI SDK emits heavily via
// zodResponseFormat / client.beta.chat.completions.parse). `root` carries the top-level schema so
// same-document $refs resolve. Returns error strings ([] = valid).
// `refChain` tracks the $ref pointers resolved on the CURRENT path WITHOUT consuming data (a $ref
// hop, or an allOf/anyOf/oneOf branch, all re-validate the same value). A pointer reappearing on
// that chain is a pure ref→ref (or ref→composition→ref) cycle that recurses forever independent of
// the data — we fail closed on it. Data-consuming recursion (properties/items/additionalProperties)
// deliberately resets the chain (default []): it always terminates because a JSON value is a finite
// tree, so a legitimately recursive schema (Node→child:Node) must NOT be flagged as a cycle. A depth
// cap backstops any threading mistake. (PR #153 review round 2, cyclic-$ref blocker.)
const REF_DEPTH_CAP = 512;
export function validateJsonSchema(value, schema, path = "$", strict = false, root = schema, refChain = []) {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (refChain.length > REF_DEPTH_CAP) { // defensive backstop; refChain cycle-check below is primary
    errors.push(`${path}: $ref resolution too deep (possible cycle)`);
    return errors;
  }

  // $ref: resolve against the document root ($defs / definitions) and validate the target. Without
  // this a nested {$ref:"#/$defs/Step"} presents as {no type, no properties} — and under strict that
  // used to wrongly reject every real key as "additional property not allowed" (the flagship OpenAI
  // SDK shape). Sibling keywords alongside $ref (rare) are merged over the resolved target.
  if (typeof schema.$ref === "string") {
    if (refChain.includes(schema.$ref)) { // cyclic $ref (a→b→a, or self a→a) — fail closed.
      errors.push(`${path}: cyclic $ref detected (${schema.$ref})`);
      return errors;
    }
    const resolved = resolveRef(schema.$ref, root);
    if (!resolved) return errors; // unresolvable ref → cannot validate; do not fail
    const { $ref, ...siblings } = schema;
    return validateJsonSchema(value, { ...resolved, ...siblings }, path, strict, root, [...refChain, schema.$ref]);
  }

  // Composition. allOf: every branch must pass. anyOf: at least one. oneOf: exactly one.
  // These re-validate the SAME value → thread refChain so a ref cycle routed through a branch is caught.
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) errors.push(...validateJsonSchema(value, sub, path, strict, root, refChain));
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some(sub => validateJsonSchema(value, sub, path, strict, root, refChain).length === 0)) {
      errors.push(`${path}: does not match any of the allowed schemas (anyOf)`);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(sub => validateJsonSchema(value, sub, path, strict, root, refChain).length === 0).length;
    if (matches !== 1) errors.push(`${path}: must match exactly one allowed schema (oneOf), matched ${matches}`);
  }

  // Nullability takes precedence: a null value is valid whenever the schema permits null (its type
  // union includes "null", or nullable:true), regardless of enum/const. This mirrors OpenAI
  // structured-output behaviour — nullable fields accept null even when a bare enum (as generated by
  // Home Assistant's extended_openai_conversation) omits null from its value list.
  const allowsNull = schema.nullable === true
    || (Array.isArray(schema.type) ? schema.type.includes("null") : schema.type === "null");
  if (value === null && allowsNull) return errors;

  if (Array.isArray(schema.enum) && !schema.enum.some(e => jsonDeepEqual(e, value))) {
    errors.push(`${path}: not one of the allowed enum values`);
  }
  if ("const" in schema && !jsonDeepEqual(schema.const, value)) {
    errors.push(`${path}: does not equal the required const value`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const nullable = schema.nullable === true || types.includes("null");
    const ok = types.some(t => jsonTypeMatches(t, value)) || (value === null && nullable);
    if (!ok) {
      errors.push(`${path}: expected ${types.join("|")}${schema.nullable ? "|null" : ""}, got ${jsonTypeOf(value)}`);
      return errors; // type mismatch — deeper checks are meaningless
    }
  }
  if (value === null) return errors;

  const vt = jsonTypeOf(value);
  if (vt === "object") {
    const props = schema.properties || {};
    for (const r of (schema.required || [])) {
      if (!Object.prototype.hasOwnProperty.call(value, r)) errors.push(`${path}.${r}: required property missing`);
    }
    const addl = schema.additionalProperties;
    // Only treat strict as implying "no additional properties" when this object actually declares
    // its own `properties` and is NOT a composite (allOf/anyOf/oneOf put the real keys in sub-schemas,
    // which are validated separately above). Inferring closure from an EMPTY properties map — the
    // shape an unresolved $ref or a pure-composition node presents — would reject every real key.
    // An explicit additionalProperties:false is always honoured. (PR #153 review, finding 1.)
    const isComposite = Array.isArray(schema.allOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf);
    const noExtra = addl === false || (strict && addl === undefined && Object.keys(props).length > 0 && !isComposite);
    for (const k of Object.keys(value)) {
      if (props[k]) {
        errors.push(...validateJsonSchema(value[k], props[k], `${path}.${k}`, strict, root));
      } else if (isComposite) {
        // key may be defined in an allOf/anyOf/oneOf branch — already validated there; don't reject.
      } else if (noExtra) {
        errors.push(`${path}.${k}: additional property not allowed`);
      } else if (addl && typeof addl === "object") {
        errors.push(...validateJsonSchema(value[k], addl, `${path}.${k}`, strict, root));
      }
    }
  } else if (vt === "array" && schema.items) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((s, i) => { if (i < value.length) errors.push(...validateJsonSchema(value[i], s, `${path}[${i}]`, strict, root)); });
    } else {
      value.forEach((item, i) => errors.push(...validateJsonSchema(item, schema.items, `${path}[${i}]`, strict, root)));
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer items than minItems ${schema.minItems}`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more items than maxItems ${schema.maxItems}`);
  }
  return errors;
}

// Crash-safe façade over validateJsonSchema (issue #181). The validator recurses on the DATA's
// nesting depth (properties/items/additionalProperties), which the REF_DEPTH_CAP does NOT bound —
// only the ref-chain is. A model reply nested ~2000 levels deep therefore overflowed the stack with
// a RangeError, which the request handler caught as a generic HTTP 500 instead of the spec-correct
// `refusal`. This wrapper converts ANY throw (the deep-data RangeError, or any future recursion
// hazard) into a single validation error, so the structured-output retry loop treats a pathological
// reply as "did not validate" → refusal — never a 500, never a crash. A well-formed reply is
// unaffected: the inner validator returns and this just passes its errors through.
export function validateJsonSchemaSafe(value, schema, path = "$", strict = false, root = schema) {
  try {
    return validateJsonSchema(value, schema, path, strict, root);
  } catch (e) {
    // Catch ONLY the deep-nesting stack overflow (the #181 vector) and turn it into a validation
    // miss → retry → refusal, never a 500. Any OTHER throw is a genuine bug: re-throw it so it
    // surfaces at error level instead of being silently masked as "did not validate" (reviewer
    // finding — a catch-all would hide a future TypeError behind a warn-level structured_retry).
    if (e instanceof RangeError) return [`${path}: schema validation aborted (value nesting too deep)`];
    throw e;
  }
}

function tryJsonParse(s) {
  try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; }
}

// Find the next brace-balanced JSON span at or after `from`. String-aware: brackets inside quoted
// strings are ignored. Returns { text, start, end } for the first complete top-level span, or null.
function balancedSlice(s, from) {
  let start = -1;
  for (let i = from; i < s.length; i++) { if (s[i] === "{" || s[i] === "[") { start = i; break; } }
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { depth--; if (depth === 0) return { text: s.slice(start, i + 1), start, end: i }; }
  }
  return null;
}

// Extract a single JSON value from model text. Two modes (PR #153 review, finding 2):
//
//   opts.whole === true  (json_object mode): the ENTIRE reply, after trimming and stripping one code
//     fence, must parse as a single JSON value. json_object has no schema to validate against, so
//     this whole-reply parse is its ONLY guard — a reply like `I can't. The schema is {"type":"object"}`
//     must NOT parse-and-serve the embedded object as if it were the answer.
//
//   default (schema mode): prose-wrapped JSON is tolerated (models often add a sentence), BUT a reply
//     containing MORE THAN ONE top-level JSON value is rejected rather than silently serving the first
//     — "Schema: {...}\n\nAnswer: {...}" or "Option A: {...} Option B: {...}" is ambiguous, not an
//     answer. The extracted value is still schema-validated by the caller.
//
// Returns { ok:true, value } | { ok:false, reason? }.
export function extractJsonPayload(text, opts = {}) {
  if (typeof text !== "string") return { ok: false };
  let s = text.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();

  if (opts.whole) {
    const whole = tryJsonParse(s);
    return whole.ok ? whole : { ok: false, reason: "reply was not a single JSON value" };
  }

  const direct = tryJsonParse(s);
  if (direct.ok) return direct;

  const first = balancedSlice(s, 0);
  if (!first) return { ok: false };
  const parsedFirst = tryJsonParse(first.text);
  if (!parsedFirst.ok) return { ok: false };

  // Reject ambiguity: a second parseable top-level JSON value means we cannot know which is the answer.
  const second = balancedSlice(s, first.end + 1);
  if (second && tryJsonParse(second.text).ok) {
    return { ok: false, reason: "reply contained more than one JSON value" };
  }
  return parsedFirst;
}

// The strict JSON-only system instruction appended to the request (attempt 0), escalated with the
// prior failure reason on retries.
export function structuredSystemInstruction(structured, attempt, lastErr) {
  const schemaBlock = (structured.mode === "schema" && structured.schema)
    ? `Your JSON MUST validate EXACTLY against this JSON Schema:\n${JSON.stringify(structured.schema)}\n`
      + `- Include every required property.\n`
      + `- Do NOT add any property that is not defined in the schema.\n`
      + `- Respect all declared types, enums, and nullability.`
    : `Respond with a single valid JSON value.`;
  let text =
`You are a strict JSON generator. Output a SINGLE JSON value and NOTHING else.
- The response MUST begin with { or [ and end with the matching } or ].
- Do NOT wrap the JSON in Markdown or code fences (no \`\`\`).
- Do NOT include any prose, explanation, heading, comment, reasoning, or XML — only the raw JSON.
${schemaBlock}`;
  if (attempt > 0) {
    text = `YOUR PREVIOUS RESPONSE WAS REJECTED (${lastErr}). Output ONLY the corrected raw JSON now, with no other text.\n\n` + text;
  }
  return text;
}
