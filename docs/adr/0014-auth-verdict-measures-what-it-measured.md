# ADR 0014 — `/health`'s auth verdict reports what was measured, and learns from real requests

**Date:** 2026-08-04
**Status:** Accepted (maintainer sign-off 2026-08-05)
**Scope:** Class B.2 — `/health` and `/status`. Authority: [ADR 0006](0006-openai-shim-scope.md) (grandfathered as of v3.16.4), amending [ADR 0010](0010-health-verdict-semantics.md).
**Supersedes for `auth.ok`:** ADR 0010's rule that the `claude auth status` probe is the sole writer of the auth verdict.

---

## Context

Issue #308 reported `/health` asserting `auth.ok: true, lastOutcome: "authenticated"` on a host where every request returned HTTP 500 with "OAuth session expired and could not be refreshed", and where the same binary run by hand exited 1 with `loggedIn: false`.

### Root cause, measured

`claude auth status` reports whether a token is **present**, not whether it is **valid**. Verified in an isolated, empty `HOME` — one variable changed:

```
env -i HOME=<empty> PATH=… claude auth status
  → exit 1   { "loggedIn": false, "authMethod": "none" }

env -i HOME=<empty> PATH=… CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-not-a-real-token" claude auth status
  → exit 0   { "loggedIn": true,  "authMethod": "oauth_token" }
```

The token in the second case is a fabricated string. It never existed. The command still exits 0.

Everything in #308 follows: the service carries `CLAUDE_CODE_OAUTH_TOKEN` in its `EnvironmentFile`, `checkAuth` inherits it, the child sees a token and exits 0. The hand-run test in an interactive shell has no such variable, falls back to an empty `~/.claude/.credentials.json`, and exits 1. The token was **present and expired** — presence is what the probe measured, validity is what the request needed.

**This is not one host.** All three Linux hosts in the maintainer's fleet carry the token in the service environment. On any host using that mechanism, `auth.ok: true` currently means "a token is set", and it keeps saying so after the token expires, indefinitely.

### What the probe cannot be fixed into

Parsing `loggedIn` out of stdout does not help — it is `true` in the fabricated-token case too, carrying exactly as much information about validity as the exit code, which is none. The issue said so before this analysis and the analysis confirms it.

## Decision

Two changes, which are complementary rather than alternatives. Neither alone is sufficient.

### B — the probe reports what it measured

When the spawned `claude` resolves its credential from **the environment**, `claude auth status` is a presence check. OCP stops recording that as `authenticated`.

| condition | `auth.ok` | `lastOutcome` |
|---|---|---|
| probe exits 0, credential came from a file/keychain the child resolved itself | `true` | `authenticated` (unchanged) |
| probe exits 0, `CLAUDE_CODE_OAUTH_TOKEN` was in the child's environment | **`null`** | **`token-present`** (new) |
| probe exits non-zero | `false` | `rejected` (unchanged) |
| probe times out / cannot run | preserved | `timeout` / `unavailable` (unchanged) |

`null` already means "no conclusive verdict" (ADR 0010) and `scripts/doctor.mjs` already treats it as WARN rather than FAIL, so this degrades to a known, handled state rather than a new one.

**Cost, stated plainly:** on every host using the env-token mechanism — three of four in this fleet — `auth.ok` goes from a confident `true` to `null`. That is a loss of signal. It is the correct loss: the signal was false.

### C — real requests are conclusive evidence

A request that reaches the model and succeeds proves the credential is valid. A request that fails proves something, and OCP already counts those (`stats.errors`, `recentErrors`, populated by `trackError`).

- **A successful completion sets `auth.ok = true`, `lastOutcome = "verified-by-request"`.** This is stronger evidence than any probe and costs nothing — the request was happening anyway.
- **That verdict EXPIRES.** Past `AUTH_REQUEST_VERDICT_TTL_MS` (15 min) with no new success it decays to `null`. This was added after the draft, and it is not a refinement — without it the design has a defect worse than the one it fixes. See below.
- **Request failures do not set `auth.ok = false`.** See the open question below.

### Why the raise must expire — the latch this design would otherwise create

A raised verdict that never expires is a latch, and on an env-token host **nothing can ever lower it**: `claude auth status` exits 0 whenever a token is merely present, so the probe can never contradict a stale `true`. The sequence is:

1. the proxy serves normally → C raises `auth.ok` to `true`
2. the token expires → every request starts failing
3. `auth.ok` stays `true`, because failures deliberately do not lower it
4. the probe cannot correct it, because the token is still *present*

Step 4 is the trap. The result is **byte-identical to the state #308 reported** — `/health` asserting the credential works while nothing can be served — reached by a different path.

This is #324's defect shape in the opposite direction, and the criterion recorded there applies verbatim: *do not ask what the clearing condition is, ask whether it is reachable.* Here it is not.

The expiry closes it without classifying anything. A serving proxy refreshes the verdict on every request and never decays; only one that has stopped succeeding does. `applyRequestVerdictTtl` is a pure, injectable function rather than a constant read from the environment — the window must be testable at arbitrary values **without** becoming an operator knob, because a knob on a safety decision is a knob for turning the safety off (the same argument ADR 0010 makes for `AUTH_DEGRADE_AFTER`).

### Why both

C alone leaves the field wrong on an idle proxy: no traffic, no evidence, and the verdict stays at whatever the probe said — which is the lie. B alone leaves three of four fleet hosts with `auth.ok: null` permanently even while serving perfectly. Together, a serving proxy reports `true` on real evidence and an idle one honestly reports "not established".

## Open question — deliberately unresolved in this draft

**What signal identifies an auth failure, as opposed to any other request failure?**

`server.mjs:1698-1700` does not classify the child's failure. It takes `stderr.slice(0, 300)` and rejects with it; the 500's message *is* the raw stderr. So making a failed request set `auth.ok = false` requires either:

- **matching text in another program's stderr** — the "guard built on text rather than on the real boundary" pattern this repo has repeatedly had to undo; or
- **treating any request failure as an auth failure** — wrong, a model error is not a credential error; or
- **an exit code that distinguishes them** — which I could not establish.

Two reproduction attempts, both in an isolated empty `HOME` on a test host:

| case | result |
|---|---|
| fabricated `CLAUDE_CODE_OAUTH_TOKEN`, `claude -p` | **hung** — killed at 45s, no fast failure, no classifiable output |
| no credentials at all, `claude -p` | **hung** — killed at 90s |

Neither reproduces #308's observed behaviour, which was a *fast* 500 with a clear message. That came from a **real expired** token, a state I cannot fabricate. **So the failure signal is unknown, and this draft does not specify one.**

Consequence: C ships as **success-only** evidence. `auth.ok` can be raised to `true` by a real request but not lowered to `false` by one. Lowering waits for evidence from a host actually in the failed state.

This is deliberately asymmetric and the asymmetry is safe in the right direction: the change can only make the field *more* confident on evidence that is genuinely conclusive, and never *less* confident on evidence that is not understood.

## Consequences

- `/health`'s `auth.ok` starts meaning "the credential worked, or we do not know" instead of "a token is set".
- **`/health`'s `status` is unaffected.** `proxyHealthStatus` reads `consecutiveFailures`, never `ok`, and nothing here writes that tally. ADR 0010's degraded rule is untouched.
- Two contract changes on a grandfathered B.2 endpoint: the rule determining `auth.ok`, and a new `lastOutcome` value. Both are why this needs its own ADR rather than ADR 0012's additive-field authorization — ADR 0012 condition 1 excludes exactly this.
- The fleet's three env-token hosts will report `auth.ok: null` until their first successful request, then `true` — in practice one request — and back to `null` after 15 minutes of no successful traffic. An idle proxy therefore reports "not established" rather than a stale "works", which is the correct answer to a question nobody has evidence for.
- **A NaN guard, recorded because it was written wrong first.** The expiry check used `typeof x === "number"`, which `NaN` satisfies; every comparison against `NaN` is false, so `now - NaN <= ttl` fell through and a malformed timestamp silently expired the verdict. `Number.isFinite` now. The unit test that caught it exists precisely because this repo has been bitten by NaN-passes-every-threshold before — and it was written wrong here anyway, which is the argument for the test rather than for care.
- **Unrelated finding, recorded because it was found while writing this:** the circuit breaker is a stub. `breakerRecordSuccess()` and `breakerRecordTimeout()` have empty bodies, `/health` reports `circuitBreaker: "disabled"`, and four `CLAUDE_BREAKER_*` env vars are documented at `server.mjs:31-34` and parsed at `:382-385`. Documented interface, dead implementation. Its own issue, not this ADR's business.

## Alternatives considered

**Make the probe issue a real minimal request.** The only thing that measures "can this proxy serve" on a schedule. Rejected on cost: at the default interval that is ~144 metered calls per instance per day, ~576 across this fleet, and avoiding exactly that is why #232 built the probe the way it is.

**Parse `loggedIn` from stdout.** Carries no more information than the exit code, as the fabricated-token experiment shows.

**Leave it and document it.** The status quo is a health endpoint that reports the opposite of the truth on the majority of the fleet, while `ocp doctor`, `ocp update`'s post-flight, and any fleet-verification harness all read that same field. #308 exists because a rollout passed every check on a host that could not serve a single request.
