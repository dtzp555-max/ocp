// Which OpenAI request fields did this request send that OCP does NOT act on? Pure; no I/O.
//
// WHY THIS EXISTS. #467's harm was that a client believes it has a capability it does not, and the
// failure is invisible on every signal -- HTTP 200, finish_reason "stop", /health ok, clean logs on
// both sides. #468 answered that for `tools` with a counter and a log rather than a refusal, and
// #470 records that `tools` was never the only such field. This is the same answer for the rest.
//
// IT IS NOT A REFUSAL, deliberately. A client that sends `temperature: 0` out of habit must still
// get an answer; 400-ing it would break working integrations to make a point. What changes is that
// the silence is now countable and greppable.
//
// WHY THE CLI CANNOT SIMPLY BE GIVEN THESE. Checked against `claude --help` on 2.1.270: there is no
// --max-tokens, --stop, --seed, --temperature or --top-p. The only budget-shaped flags are
// --max-budget-usd (a DOLLAR cap, not a token cap) and --autocompact (the CONTEXT window, not the
// output). So these are not fields someone forgot to wire -- there is no knob to wire them to, and
// honouring them would mean OCP post-processing the model's output, which is a different decision
// than this module makes.
//
// EXPIRY: this list is the complement of what OCP consumes, and it goes stale the moment a field
// moves into the honoured set. A test asserts that none of these names reaches the spawn's argv, so
// implementing one without removing it here reddens rather than quietly lying.

// Sent-and-inert: OCP neither passes them on nor emulates them. EXPORTED so the wiring test iterates
// THIS list rather than a hand-picked copy of it -- review found the first version of that test
// checking six of the eleven, which is a pin that silently stops pinning the moment a field is
// added here and not there.
export const ALWAYS_UNHONOURED = [
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "presence_penalty",
  "seed",
  "stop",
  "temperature",
  "top_logprobs",
  "top_p",
];

// `temperature`, `top_p` and `max_tokens` ARE read -- by cacheHash, and nowhere else. That makes
// them cache-key material, not generation parameters: two requests differing only in `temperature`
// occupy different cache entries and get different-but-equally-unsteered answers. Listing them here
// is still correct, because what the client asked for (steer the sampler) does not happen; saying
// they are "completely ignored" would not be, and the distinction is what a reader needs.
export const CACHE_KEY_ONLY = new Set(["temperature", "top_p", "max_tokens"]);

// THE OPENAI DEFAULTS ARE NOT REPORTED EITHER, and the footing is weaker than for `n: 1`, so it is
// stated. `n: 1` is honoured outright -- OCP returns one choice. `temperature: 1` is not "honoured";
// OCP has no sampler control at all. But a client sending the default value is asking for default
// sampling, and it gets whatever `claude` does by default, which the client cannot distinguish from
// the thing it asked for. Reporting it would fire on every SDK that fills in defaults -- review
// measured a body of five such fields lighting up all five -- which is the "guard that fires on
// everything" the info-vs-warn reasoning in server.mjs exists to avoid. Only a NON-default value is
// an observable, unmet request. `max_tokens` has no default (unset means unlimited), so any explicit
// value is one.
const OPENAI_DEFAULTS = {
  temperature: 1,
  top_p: 1,
  presence_penalty: 0,
  frequency_penalty: 0,
};

// `reasoning_effort` (OpenAI chat/completions, #chat-create-reasoning_effort) IS honoured on the
// `-p` lane: it becomes `claude --effort <level>`. The OpenAI values are none | minimal | low |
// medium | high | xhigh | max (openai-python `ReasoningEffort`); `claude --help` on 2.1.278 accepts
// low | medium | high | xhigh | max, so five map one-to-one. `none` and `minimal` have no CLI
// level and are REPORTED below rather than rounded to `low` -- rounding would be OCP deciding what
// the client meant. Anything else is not an OpenAI value at all; it is reported and never reaches
// argv, so a typo cannot turn into a spawn-time usage error (the same stance as OCP_TUI_EFFORT).
export const CLI_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// The `--effort` value for a request body's `reasoning_effort`, or null when it maps to none.
export function cliEffort(value) {
  return CLI_EFFORT_LEVELS.includes(value) ? value : null;
}

// opts.effortHonoured: false on the TUI lane, whose pane is booted (or pre-warmed) with
// OCP_TUI_EFFORT before the request exists, so a per-request level cannot reach it.
export function listUnhonouredFields(body, opts = {}) {
  if (!body || typeof body !== "object") return [];
  const out = [];
  const effort = body.reasoning_effort;
  if (effort !== undefined && effort !== null && (opts.effortHonoured === false || !cliEffort(effort))) {
    out.push("reasoning_effort");
  }
  for (const f of ALWAYS_UNHONOURED) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    // An empty `stop` array asks for nothing, so it is not an unmet request.
    if (f === "stop" && Array.isArray(v) && v.length === 0) continue;
    // `logprobs: false` is the default and asks for nothing.
    if ((f === "logprobs") && v === false) continue;
    // An empty `logit_bias` asks for nothing.
    if (f === "logit_bias" && typeof v === "object" && Object.keys(v).length === 0) continue;
    // The OpenAI default value, for the fields that have one -- see OPENAI_DEFAULTS.
    if (Object.prototype.hasOwnProperty.call(OPENAI_DEFAULTS, f) && v === OPENAI_DEFAULTS[f]) continue;
    out.push(f);
  }
  // `n` is honoured at its default. Only a request for MORE than one choice goes unmet, and that
  // asymmetry matters: reporting `n: 1` would make this fire on clients that are getting exactly
  // what they asked for.
  if (typeof body.n === "number" && body.n !== 1) out.push("n");
  // `parallel_tool_calls: true` IS the behaviour as of #478 -- every call in a message is delivered.
  // Only an explicit `false`, asking OCP to serialise them, goes unmet.
  if (body.parallel_tool_calls === false) out.push("parallel_tool_calls");
  return out.sort();
}
