// Is an upstream failure a RATE LIMIT, or a genuine server error? Pure; no I/O.
//
// WHY THIS EXISTS. OCP's only 429 was its own concurrency backpressure. Everything else the spawned
// `claude` failed with -- including the Anthropic subscription wall ("usage limit reached") --
// became `500 { type: "proxy_error" }`. That is non-conformant on a Class B.1 surface: OpenAI's
// specification gives 429 + `rate_limit_error` for exactly this, and every OpenAI client branches
// on it. A client hitting the 5-hour wall was told "the proxy broke", which is the silently-wrong
// shape rather than a degraded one -- it cannot retry sensibly and it cannot fail over.
//
// MEASURED, 2026-09-14, on the consumer of this that motivated it: an agent framework (Hermes
// 0.21.1) classifies a 429 as rate-limit-or-billing and BOTH set `should_fallback`, so a 429 makes
// it switch to its configured fallback provider. A 500 classifies as `server_error`, which sets
// `retryable` and NOT `should_fallback` -- it retries the same wall until it gives up. Read from
// `agent/error_classifier.py`: `_V_RATE_LIMIT`/`_V_BILLING` carry `_ROTATE_FALLBACK`,
// `_V_SERVER_ERROR` carries neither, and `_status_5xx` refines 5xx only for request-validation and
// context-overflow shapes -- never for a quota phrase. So the status code is the whole signal.
//
// WHERE THE PATTERNS COME FROM, and why they are not invented here: they are the intersection of
// (a) the phrases that framework's own curated lists match on -- it has been in production against
// many providers and its `_RATE_LIMIT_PATTERNS` / `_USAGE_LIMIT_PATTERNS` are the battle-tested
// set -- and (b) what the Anthropic wall and the `claude` CLI actually say. Deliberately NOT the
// union: the transient-signal phrases ("try again", "wait", "resets at") are excluded, because on
// their own they match ordinary retry advice in unrelated errors and would turn a genuine server
// error into a spurious 429. Every pattern here names a QUOTA OR RATE NOUN.
//
// EXPIRY: these are strings a vendor can change without notice, and a missed phrase fails CLOSED
// (500, as before -- no failover) rather than open. If a wall is ever observed being reported as
// 500, add the phrase and a test row; do not widen toward the transient signals, which is how this
// becomes a guard that fires on everything.
const RATE_LIMIT_PATTERNS = [
  "usage limit",
  "usage_limit_reached",
  "rate limit",
  "rate_limit",
  "too many requests",
  "quota exceeded",
  "quota exhausted",
  "insufficient_quota",
  "resource exhausted",
  "resource_exhausted",
];

// EVERY PATTERN NAMES A QUALIFIED NOUN, and the three that did not were removed after an
// independent review measured each one promoting an ordinary failure to a 429 on a live server:
//
//   "limit exceeded"   -> "FATAL ERROR: heap limit exceeded - JavaScript heap out of memory"
//                         became 429. The `claude` bundle alone carries `heap limit exceeded`,
//                         `Memory limit exceeded`, `CPU time limit exceeded`, `recursion limit
//                         exceeded` and six more. It was also nearly redundant: "rate limit
//                         exceeded" already hits "rate limit", "quota exceeded" hits its own entry.
//   "quota" (bare)     -> the model's OWN ANSWER became 429. server.mjs rejects with
//                         `stderr || assembledText || "claude exit N"`, so when a spawn dies with
//                         empty stderr the classifier's input is the text the model produced --
//                         i.e. a word the CLIENT put in its prompt could select the HTTP status.
//                         Qualifying it ("quota exceeded"/"exhausted") does not close that channel,
//                         it narrows it; see THE INPUT CHANNEL below.
//   "ratelimit"        -> that is the HTTP HEADER spelling (`x-ratelimit-*`,
//                         `anthropic-ratelimit-*`). The wire error type `rate_limit_error` is
//                         already covered by "rate_limit", so this only added header echoes.
//
// "overloaded_error" was removed for a different reason: it is not a rate limit. The same OpenAI
// specification this endpoint is bounded by declares 429 AND 503 separately, and puts overload at
// 503 (`server_is_overloaded`, `service_unavailable_error`). Calling it 429 also cuts against the
// point: an overload clears in seconds, while a 429 tells a fallback-capable client to leave for
// another vendor.
//
// THE INPUT CHANNEL IS WIDER THAN VENDOR ERROR TEXT, and that is stated rather than fixed here.
// A qualified noun still appears in a sentence a user could ask for. What bounds the damage is the
// direction of the failure: a false positive costs one needless failover, not a wrong answer, and
// the alternative (classifying only stderr) would miss the real walls that `claude` prints as text.
//
// AND THE SAME CHANNEL REACHES THE COUNTER, which is the part that is easy to miss because
// `stats.upstreamRateLimits` is the field this classifier exists to make trustworthy. A client
// whose prompt contains a quota noun, whose spawn then dies with empty stderr, moves that counter.
// It is a LOCAL operator metric on a proxy whose callers are the operator's own, not a billing
// signal, so the cost is a misleading dashboard rather than a wrong answer -- but an operator
// reading a spike should know it can be produced from the outside.

// A bare 429 counts only as its OWN token, and "its own token" took THREE tries to state correctly.
// Each of these was measured returning 429 from a live server under the version above it:
//
//   /(^|[^0-9])429([^0-9]|$)/      `req_011CT429kLmN` -- the separator class excluded digits but
//                                  admitted LETTERS, and a request id is the commonest decoration
//                                  on a real API error.
//   /(^|[^0-9a-z])429([^0-9a-z]|$)/
//                                  `claude exited after 12.429 seconds`, `processed 1,429 tokens`,
//                                  `completed in 429.5 seconds` -- adding `a-z` fixed the letters
//                                  and left `.` and `,` as valid separators, so the LAST GROUP OF
//                                  ANY NUMBER still matched. The negative test row in place at the
//                                  time (`processed 1429 tokens`) passed only because it had no
//                                  separator, which is why the guard looked sound.
//
// What is actually meant is "429 is not part of a number and not part of a word". A digit joined
// through a single `.` or `,` is part of a number; a trailing `.` with no digit after it is
// punctuation, so `upstream returned 429.` still matches -- that sentence is a real error shape and
// dropping it would be a silent narrowing rather than a fix. Lookbehind is used rather than a
// wider character class because a class cannot express "`.` only counts when a digit follows it".
// The string is lowercased before this runs, so `a-z` covers case.
const BARE_429 = /(?<![0-9a-z])(?<![0-9][.,])429(?![0-9a-z])(?![.,][0-9])/;

// Filesystem quota is not an API quota. `EDQUOT: disk quota exceeded` would otherwise match
// "quota exceeded" above.
const NOT_RATE_LIMIT = [/\bdisk quota\b/, /\bedquot\b/];

export function isUpstreamRateLimit(message) {
  if (typeof message !== "string" || !message) return false;
  const m = message.toLowerCase();
  if (NOT_RATE_LIMIT.some((re) => re.test(m))) return false;
  if (RATE_LIMIT_PATTERNS.some((p) => p && m.includes(p))) return true;
  return BARE_429.test(m);
}

// Seconds to advertise in Retry-After when the upstream message carries a reset time we can read.
// Returns null when it does not -- an invented number is worse than no header, because a client
// that trusts it retries into the same wall and concludes the proxy is lying.
//
// Two shapes are read. The unix `resets_at`/`resetsAt` epoch IS observed in `claude` 2.1.270 (the
// bundle even carries "resetsAt is unix epoch seconds"). The relative "try again in 5 minutes" shape
// is NOT: a review searched that bundle and found 34 occurrences of "try again in", every one of
// them non-numeric ("in a moment", "in a few seconds"), which this returns null for. It is kept as a
// cheap accommodation for other upstreams, and labelled so nobody cites it as measured. Anything
// else -> null.
export function retryAfterSeconds(message, now = Date.now()) {
  if (typeof message !== "string" || !message) return null;
  // Case-INSENSITIVE, unlike isUpstreamRateLimit this one gets no lowercased copy: `ResetsAt` and
  // `RESETS_AT` were measured returning null, so the request became a 429 with NO Retry-After and
  // the client retried straight into the same wall. Failing closed, but needlessly.
  const epoch = message.match(/"?resets?_?at"?\s*[:=]\s*"?(\d{9,11})"?/i);
  if (epoch) {
    const secs = Math.ceil((Number(epoch[1]) * 1000 - now) / 1000);
    if (secs > 0 && secs < 86400) return secs;
    return null;
  }
  const rel = message.match(/try again in (\d+)\s*(second|minute|hour)s?/i);
  if (rel) {
    const n = Number(rel[1]);
    const mult = { second: 1, minute: 60, hour: 3600 }[rel[2].toLowerCase()];
    const secs = n * mult;
    if (secs > 0 && secs < 86400) return secs;
  }
  return null;
}
