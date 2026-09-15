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
  "hit your session limit",
];

// "hit your session limit" is ADDED FROM THE WIRE, not invented, and it is the one entry above with
// a dated observation behind it. On 2026-09-15 a live OCP v3.36.0 instance hit the 5-hour
// subscription wall and the spawned `claude` said, verbatim:
//
//   You've hit your session limit · resets 5am (UTC)
//
// That matched nothing in the list, so the wall became `500 { type: "proxy_error" }` -- the
// fail-closed direction the EXPIRY note above describes, and exactly the shape #481 set out to end.
// The originating stream frame in OCP's own log was a `rate_limit_event` carrying
// `rateLimitType: "five_hour"` and a `resetsAt` epoch; that is corroboration only, because the
// caller-visible input is the message and not the frame, so the phrase has to classify on its own.
//
// WHY "hit your session limit" AND NOT "session limit". The first version of this entry was the bare
// noun, and review measured it promoting FOUR strings that are not walls -- all four taken verbatim
// out of the `claude` 2.1.270 binary this proxy spawns:
//
//   Couldn't reset your session limit right now - try again in a moment   <- an OPERATION FAILURE
//   Your session limit is already being reset - one is already in progress
//   Upgrade to Max for higher session limits every month                  <- marketing copy
//   You will get priority after reaching your session limit; run again to stop
//
// The first is the one that matters: a failed RESET becoming `429 rate_limit_error` tells a
// fallback-capable client to leave the vendor over an operation that did not even concern quota.
// That is the shape #484 removed `limit exceeded` for (`heap limit exceeded` -> false 429),
// reappearing one phrase later. The verb is what distinguishes the wall from everything else that
// mentions the same noun, so the verb is in the pattern.
//
// THE OBSERVED STRING IS NOT A LITERAL IN THE BINARY, and a reviewer will hit that first, so:
// `grep "hit your session limit"` on 2.1.270 returns ZERO. What the binary carries is the TEMPLATE
// --  `You've hit your ` with the limit's name substituted at runtime, alongside its siblings
// `You've hit your fast limit`, `You've hit your monthly spend limit` and
// `You've hit your channel's monthly spend limit.` So the reported message is exactly what that
// template produces, and the absence of the literal corroborates the report rather than undermining
// it. (2.1.270 is a native Mach-O binary, not a JS bundle, so this is `strings -a` + grep, not the
// `grep cli.js` earlier entries here describe. Run a positive control first; `usage limit` matches.)
//
// THOSE THREE SIBLINGS ARE STILL 500 AND ARE DELIBERATELY NOT ADDED. They are walls, and they are
// in the binary -- but the rule this list runs on is the EXPIRY note's: add a phrase when a wall is
// OBSERVED BEING REPORTED AS 500. A string existing in the binary is not that observation. Filed as
// its own issue rather than folded in on a guess.
//
// It is otherwise unchanged from the entry's original reasoning: not a widening toward a bare limit
// (`limit exceeded` was removed for `heap limit exceeded`, with `Memory` / `CPU` / `recursion limit
// exceeded` alongside it); not a transient signal, so it does not reach toward "try again" / "wait"
// / "resets at"; and, like `usage limit` and unlike the quota entries, not `quota`-qualified, so the
// filesystem veto cannot suppress a genuine wall that merely mentions a disk quota.

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

// A BARE 429 IS NOT EVIDENCE. Three rounds of review taught this one number at a time, and the
// final lesson is that the whole approach of the first two was wrong -- each fixed the DELIMITERS
// around `429` while leaving the premise that a delimited `429` means an HTTP status:
//
//   /(^|[^0-9])429([^0-9]|$)/      `req_011CT429kLmN` -- the class excluded digits but admitted
//                                  LETTERS, and a request id is the commonest decoration on an
//                                  API error.
//   /(^|[^0-9a-z])429([^0-9a-z]|$)/
//                                  `claude exited after 12.429 seconds`, `processed 1,429 tokens`,
//                                  `completed in 429.5 seconds` -- `.` and `,` were still
//                                  separators, so the last group of ANY number matched.
//   /(?<![0-9a-z])(?<![0-9][.,])429(?![0-9a-z])(?![.,][0-9])/
//                                  `at handler (/srv/ocp/server.mjs:429:15)` -- A NODE STACK TRACE
//                                  WHOSE LINE NUMBER IS 429. Also `pid=429`, `{"elapsedMs":429}`,
//                                  `processed 429 tokens`. This is the worst of the three by far:
//                                  a stack trace is what an ORDINARY PROXY CRASH looks like, so the
//                                  classifier reported "we hit the wall" on precisely the failure
//                                  `stats.upstreamRateLimits` exists to distinguish from the wall.
//
// So the rule is no longer about delimiters. A `429` counts only where something adjacent says it
// is a STATUS: `HTTP 429`, `status: 429`, `API Error: 429`, `"code":429`. A number standing alone
// is a number.
//
// TWO SHAPES WERE DELIBERATELY GIVEN UP to get there, and they were positive test rows one round
// earlier: `(429)` and `upstream returned 429.` No longer matched, because neither carries anything
// that says "status" and admitting them means admitting the stack trace. Both fail CLOSED (500), and
// both are recoverable for free if they are ever observed: a real upstream 429 almost always prints
// a body carrying `rate_limit_error` or `Too Many Requests`, which the phrase list above already
// matches without this regex being involved at all.
//
// `429 Too Many Requests` still classifies -- via the PHRASE, not this regex. That is the intended
// division of labour, and the test rows assert it from the outside so it cannot silently invert.
// Three refinements a second review measured, each with its own negative row:
//
//   `[^0-9a-z]{1,3}` not `{0,3}`  -- zero separators let the keyword ABUT the number, so `code429`,
//                                    `status429` and `errors429` classified. A concatenated token is
//                                    not a status followed by its value.
//   `(?![.,:][0-9])` not `(?![.,][0-9])`
//                                    -- `:` joins a LINE to a COLUMN. `at new NodeError
//                                    (node:internal/errors:429:15)` matched on `errors` + `:`, and
//                                    `node:internal/errors` appears in essentially every Node error
//                                    trace -- the same stack-trace class this whole regex exists to
//                                    kill, one keyword further in. `HTTP 429: slow down` is
//                                    unaffected: `: ` is not `:` followed by a digit.
//
// DELIBERATELY NOT FIXED: the keyword must be a STANDALONE token, so camelCase compounds miss --
// `APIError: 429`, `{"errorCode":429}`, `{"httpStatus":429}` all return false. That is a real gap
// and it is left open, because this regex is a BACKSTOP, not the mechanism. Every upstream string
// actually observed carries a phrase the list above already matches (`API Error: 429 {"type":
// "error","error":{"type":"rate_limit_error"...}}` matches on `rate_limit`; the 5-hour wall says
// `Claude usage limit reached`), so the camelCase miss costs nothing on known traffic and fails
// CLOSED. Widening the keyword to allow a lowercase prefix would admit every word ENDING in one --
// `stderr: 429 bytes` is the cheap counterexample -- which trades a free miss for a false 429 on a
// crash. If a vendor is ever OBSERVED emitting a bare camelCase status, add that spelling and a row.
const STATUS_429 = /(?:^|[^0-9a-z])(?:https?|status(?:[ _-]?code)?|code|errors?|err|response|resp)[^0-9a-z]{1,3}429(?![0-9a-z])(?![.,:][0-9])/;

// Filesystem quota is not an API quota. `EDQUOT: disk quota exceeded` would otherwise match
// "quota exceeded" above.
const NOT_RATE_LIMIT = [/\bdisk quota\b/, /\bedquot\b/];

export function isUpstreamRateLimit(message) {
  if (typeof message !== "string" || !message) return false;
  const m = message.toLowerCase();
  // The filesystem veto applies ONLY to a quota pattern, and only when nothing else matched. Run
  // unconditionally and first (as it was), it also suppressed a genuine wall that merely mentioned
  // a disk quota -- `rate_limit_error: request rejected (EDQUOT on journal)` classified as a proxy
  // error. Written over the matched SET rather than the first hit, so the answer does not depend on
  // the order of RATE_LIMIT_PATTERNS: someone reordering that list for readability must not be able
  // to change what this returns.
  const status429 = STATUS_429.test(m);
  // `p &&` is not defensive noise and was wrong to drop. An EMPTY STRING in the list is the hazard,
  // not a null: `m.includes("")` is true for every message, so `hits` would never be empty and
  // `"".includes("quota")` is false, making `onlyQuota` false and this function return TRUE for
  // ABSOLUTELY ANYTHING -- silently, with every test above still green, since they all assert on
  // messages rather than on the list. A one-character typo in the array is enough.
  const hits = RATE_LIMIT_PATTERNS.filter((p) => p && m.includes(p));
  if (hits.length) {
    // The filesystem veto may only overrule a QUOTA PHRASE, never an explicit status. Without this
    // clause `HTTP 429` classified and `HTTP 429; disk quota exceeded` did not: an incidental disk
    // note flipped a genuine wall to a proxy error, which is the very defect the veto's scoping was
    // introduced to fix, surviving in the half nobody tested.
    const onlyQuota = hits.every((p) => p.includes("quota"));
    if (onlyQuota && !status429 && NOT_RATE_LIMIT.some((re) => re.test(m))) return false;
    return true;
  }
  return status429;
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
    // FALL THROUGH rather than returning null. An unusable epoch -- already past, or absurdly far
    // out -- is a reason to stop trusting THAT number, not a reason to ignore a usable relative
    // reset in the same message. `resets_at: <stale>; try again in 10 minutes` used to return null
    // and ship a 429 with no Retry-After while the message said when.
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
