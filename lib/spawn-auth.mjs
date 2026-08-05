// Pure, dependency-injected primitives for the `-p` spawn-token resolution + HOME-isolation
// layer. Extracted from server.mjs (findings F3 / F5 / F6, 2026-07-07) so the concurrency,
// caching and expiry logic is unit-testable WITHOUT booting the server or mocking execFileSync /
// child_process.spawn / fs. server.mjs owns all I/O (macOS keychain exec, process spawn, fs);
// this module owns only pure decision logic.
//
// ALIGNMENT NOTE: none of this touches the OAuth wire machinery (no endpoint / header / body).
// OCP still NEVER performs a refresh_token grant itself — these helpers only READ + GATE a token
// that some other process (the operator's real claude, or a spawned claude under the real HOME)
// refreshes. That property is load-bearing (issue #112) and preserved.

// ── Inbound-auth secrets must not reach a spawned child (#328) ───────────────
//
// The child is the ONE component that reads attacker-controlled text, so it is the
// prompt-injection surface. OCP's own INBOUND credentials — the ones that authenticate
// callers *to* OCP — have no role in the child's work: it authenticates to Anthropic with
// CLAUDE_CODE_OAUTH_TOKEN and never talks to OCP. Handing it the proxy's own key means an
// injected child holds a valid client credential for the proxy.
//
// This was demonstrated, not theorised. On a host running two OCP instances split by Unix
// identity — an unprivileged one serving untrusted users, a sudo-capable one for the operator —
// both configured with the SAME PROXY_API_KEY, an injected child on the unprivileged side read
// the key from its own environment, called the privileged instance with it, and got a child
// running as the sudo-capable account. The identity boundary was bypassed without being attacked.
// Sharing a key across instances is an operator error; the key reaching the child is ours.
//
// A LIST, not four `delete` lines per site. There turned out to be FOUR sites, each with its own
// hand-rolled copy of the same four-name denylist, and two of them were found only by independent
// review — the TUI pane (`lib/tui/session.mjs`, the ONLY request path under CLAUDE_TUI_MODE) and
// `setup.mjs`'s auth probe. That is precisely the "denylist you have to remember to extend
// everywhere" failure mode, and it had already happened twice before anyone looked.
//
// Adding a new inbound-auth env var means adding it HERE, once. `scrubInboundAuthEnv` is the only
// writer, and there are TEN call sites — the count is stated because an earlier revision of this
// comment said six and a reviewer proved otherwise by mutation:
//
//   server.mjs   the where.exe and which binary lookups; the auth probe; the -p spawn;
//                the macOS keychain read
//   lib/tui/     pane `env -u` prefix (aliases)   the tmux server env passed to new-session
//   setup.mjs    the which lookup; claude --version; the -p auth probe
//
// SEVEN of those are pinned by a test that fails when that one site is reverted. The three
// binary-lookup/keychain sites in server.mjs are NOT — scrubbed for consistency, none of them
// reads attacker-controlled text, and server.mjs cannot be imported by the suite.
//
// Six and three is nine, and the count was wrong twice before it was right: the pane's alias
// layer (:442) went in unpinned, and the test that LOOKED like it covered the prefix asserted
// only the three constant names, so the alias spread was invisible to it. An inventory whose
// coverage is asserted but untrue is how the third and fourth spawn sites stayed hidden — and
// then the same defect landed on the fix for the fourth. It is pinned now.
//
// Deliberately NOT included: PROXY_ADVERTISE_ANON_KEY (a boolean flag, not a secret) and
// CLAUDE_CODE_OAUTH_TOKEN (an OUTBOUND credential the child genuinely needs).
export const INBOUND_AUTH_ENV_VARS = Object.freeze([
  "PROXY_API_KEY",
  "OCP_ADMIN_KEY",
  "PROXY_ANONYMOUS_KEY",
]);

// Deleting by NAME is not sufficient, and OCP itself is what proves it. `ocp-connect` writes the
// user's OCP credential into `OPENAI_API_KEY` — into every shell rc, into `launchctl setenv`'s
// user domain on macOS, and into `~/.config/environment.d/` on Linux — and `docs/lan-mode.md`
// teaches the same by hand. OCP's own autostart runs in exactly those two scopes
// (`launchctl bootstrap gui/<uid>`, `systemctl --user`), so on any host that has run
// `ocp connect`, the same secret reaches the child under a name this list does not contain.
// An independent reviewer demonstrated it end to end against a real server.
//
// So the second pass is by VALUE: any variable carrying one of the inbound credentials is
// removed, whatever it is called. Adding `OPENAI_API_KEY` to the name list instead would be
// wrong — a child can legitimately need a REAL OpenAI key (an MCP server loaded via
// CLAUDE_MCP_CONFIG), and the point is to remove OCP's credential, not that variable.
//
// MIN_ALIASED_VALUE_LEN exists because value-matching on a short or empty secret would delete
// unrelated variables that happen to share the value — a `PROXY_API_KEY` of "1" would strip every
// flag set to "1" and break the child. Below the threshold only the name-based pass applies.
// Real OCP keys are `ocp_` plus a long random tail, so this costs nothing in practice; the
// exposure it declines to cover is an operator who set a credential short enough to collide with
// ordinary values, which is its own problem.
const MIN_ALIASED_VALUE_LEN = 8;

// A third pass, because the second one CANNOT SEE the credential that matters most on a
// multi-user host. `scrubInboundAuthEnv` removes values it can observe in the parent env — the
// three named credentials — but `ocp-connect`'s documented flow when the remote requires auth is
// `ocp keys add <name>`, and that key lives in OCP's SQLite store, not in any environment
// variable here. It is neither of the three names nor equal to any of their values, so both
// earlier passes miss it. Worse, in multi mode `PROXY_API_KEY` is typically unset, which makes
// the by-value pass entirely inert: measured, `removed: []` with the per-user key untouched.
//
// Every OCP-issued key is self-identifying by construction — `keys.mjs` mints
// `"ocp_" + randomBytes(24).toString("base64url")` — so the shape is exact rather than a guess:
// the prefix plus exactly 32 base64url characters. That is why this is matched by FORMAT and not
// by name: `ocp-connect` writes it into OPENAI_API_KEY, but nothing stops it reaching a child
// under any other name, and a real OpenAI key (`sk-...`) cannot collide with this pattern.
const OCP_ISSUED_KEY_RE = /^ocp_[A-Za-z0-9_-]{32}$/;

// Mutates `env` in place and returns it, so it composes with the existing `delete env.X` blocks.
// Returns the names it actually removed, which is what makes the behaviour assertable without
// reaching into module internals.
export function scrubInboundAuthEnv(env) {
  const removed = [];
  // Collect the values BEFORE deleting the names, or the second pass has nothing to match on.
  const secrets = new Set();
  for (const name of INBOUND_AUTH_ENV_VARS) {
    const v = env[name];
    if (typeof v === "string" && v.length >= MIN_ALIASED_VALUE_LEN) secrets.add(v);
  }
  for (const name of INBOUND_AUTH_ENV_VARS) {
    if (Object.hasOwn(env, name)) { delete env[name]; removed.push(name); }
  }
  for (const name of Object.keys(env)) {
    const v = env[name];
    if (typeof v !== "string") continue;
    // Two independent reasons to remove: the value IS one of this proxy's inbound credentials, or
    // it has the shape of a key this proxy issued to somebody. The second catches the multi-user
    // case the first is structurally blind to.
    if ((secrets.size > 0 && secrets.has(v)) || OCP_ISSUED_KEY_RE.test(v)) { delete env[name]; removed.push(name); }
  }
  return { env, removed };
}

// Promise-chain mutex. `acquire()` resolves to a `release()` fn; the NEXT `acquire()` does not
// resolve until the current holder calls its `release()`. Serializes async critical sections
// without busy-waiting. release() is idempotent.
export function createSerialMutex() {
  let tail = Promise.resolve();
  return {
    acquire() {
      let release;
      const gate = new Promise((r) => { release = r; });
      const prev = tail;
      tail = tail.then(() => gate);
      // Hand the caller its release fn only after the previous holder has released.
      return prev.then(() => {
        let released = false;
        return function releaseMutex() { if (!released) { released = true; release(); } };
      });
    },
  };
}

// Short-TTL memo. `get(produce, now)` returns the cached value while `now - storedAt < ttlMs`,
// otherwise calls `produce()` and re-stores. A miss that produces null/undefined is STILL stored
// (so a genuinely-absent source is not re-probed on every call within the TTL window). `now` is
// injectable for testing.
export function createTtlCache({ ttlMs }) {
  let value;
  let at = -Infinity;
  let has = false;
  return {
    get(produce, now = Date.now()) {
      if (has && now - at < ttlMs) return value;
      value = produce();
      at = now;
      has = true;
      return value;
    },
    clear() { has = false; value = undefined; at = -Infinity; },
  };
}

// Pure expiry gate. Returns true when `creds` carries a known expiry that is at/within `bufferMs`
// of `now`. Creds WITHOUT `expiresAt` (e.g. long-lived env tokens) are never treated as expiring.
// This gate is applied to the CACHED creds on EVERY use — which is precisely why a short-TTL
// keychain cache (createTtlCache) cannot reintroduce the #146 forever-stale-token regression: the
// cache bounds how often we re-READ the keychain, but the expiry decision is recomputed per use.
export function isTokenExpiring(creds, now = Date.now(), bufferMs = 300000) {
  return !!(creds && creds.expiresAt && now + bufferMs >= creds.expiresAt);
}

// Order candidate keychain labels so the last-known-good label is tried first (avoids the
// wrong-label miss that doubles the `security` exec count on the hot path). Pure: performs no
// read. Returns a fresh array; input is not mutated.
export function orderLabelsLastGoodFirst(labels, lastGood) {
  if (!lastGood || !labels.includes(lastGood)) return labels.slice();
  return [lastGood, ...labels.filter((l) => l !== lastGood)];
}

// #308 / ADR 0014. Apply the freshness window to a verdict that was established by a real
// REQUEST rather than by the probe.
//
// Why this exists at all: a completed request is the strongest evidence OCP can have that the
// credential works, and it is free. But a raised verdict that never expires is a LATCH, and on a
// host whose token comes from the environment nothing can ever lower it — `claude auth status`
// exits 0 whenever a token is merely PRESENT (measured: a fabricated token yields exit 0 and
// loggedIn:true), so the probe can never contradict a stale `true`. That is #324's defect shape
// in the opposite direction with no clearing path at all. The criterion recorded there applies:
// do not ask what the clearing condition IS, ask whether it is REACHABLE.
//
// Pure and injectable rather than reading a clock or a constant, so the window is testable at
// arbitrary values WITHOUT making it an operator-tunable env var. A knob on a safety decision is
// a knob for turning the safety off — the same argument ADR 0010 makes for AUTH_DEGRADE_AFTER.
//
// Only "verified-by-request" decays. A probe verdict is the probe's business and is governed by
// its own rules; this function must not silently rewrite one.
export function applyRequestVerdictTtl(status, now, ttlMs) {
  // Keyed on okSource, NOT on lastOutcome. Those are two different facts and conflating them was
  // a real defect, proven by execution during review:
  //
  //   (a) every probe completion rewrites lastOutcome, and a probe always completes within
  //       AUTH_CHECK_INTERVAL_MS + AUTH_CHECK_TIMEOUT_MS (610s by default) — shorter than any
  //       sane TTL. So a TTL keyed on lastOutcome could never fire under the default config: it
  //       was dead code describing a semantic the system did not have.
  //   (b) worse, ONE inconclusive probe disarmed it permanently. The inconclusive branches
  //       preserve `ok` (correct — a timeout measures host load, not credentials) while rewriting
  //       lastOutcome and advancing lastCheck. A request-established `true` therefore stopped
  //       matching and stayed true forever: replayed, T+100h still read ok:true. That is the
  //       unbounded false-`true` this design exists to prevent, reintroduced by the guard itself.
  //
  // okSource/okAt describe how and when `ok` was established. lastOutcome/lastCheck stay the
  // probe's business. A probe that cannot conclude now touches only the latter.
  if (!status || status.okSource !== "request") return status;
  // A malformed okAt EXPIRES the verdict; it does not preserve it. Both the original bug and its
  // first fix got the direction wrong, in opposite ways, and the second was worse:
  //
  //   `typeof x === "number"` let NaN through, and every comparison against NaN is false, so
  //   `now - NaN <= ttl` fell through and silently expired the verdict. Conservative by accident.
  //
  //   `Number.isFinite(...) || ...` then made a malformed okAt PRESERVE it — fail-OPEN, straight
  //   to the unbounded false `true` this entire design exists to prevent. A reviewer caught that
  //   the "fix" inverted the failure direction of its own criterion.
  //
  // Unreachable today (okAt is only ever Date.now()), so this is about which way an unexamined
  // input falls, and for a verdict that grants trust the answer is: it expires.
  if (!Number.isFinite(status.okAt)) {
    return { ...status, ok: null, okSource: "expired",
             message: "verification timestamp is unusable — treating the verdict as expired" };
  }
  if (now - status.okAt <= ttlMs) return status;
  return { ...status, ok: null, okSource: "expired",
           message: "last successful request is older than the verification window" };
}
