# ADR 0014 — `/health`'s auth verdict reports what was measured, and learns from real requests

**Date:** 2026-08-04
**Status:** Accepted (maintainer sign-off 2026-08-05), **materially amended after sign-off — see below**

> **Ratification provenance.** Sign-off was recorded on the commit titled *"docs(adr): record
> maintainer sign-off of ADR 0014"*. This ADR has been amended **twice since**, and both
> amendments are material:
>
> 1. *"fix(auth): the freshness window was a fiction…"* **rewrote the Decision's mechanism.** An
>    independent review proved the window as originally specified was unreachable under the
>    default configuration *and* permanently disarmable by a single inconclusive probe; the fix
>    introduced `okSource`/`okAt` — a structure the maintainer did not see when signing. It also
>    added **three** consequence bullets: the exit-0 tally reset, probe-never-overwrites-a-fresher-
>    verdict, and clock movement.
> 2. *"fix(auth): a rejected verdict lost its provenance…"* — the commit carrying **this note** —
>    additionally rewrote the `status`/tally consequence bullet (text that *was* part of what was
>    signed) and corrected "a new `lastOutcome` value" to "two".
>
> An earlier version of this note said "two consequence bullets" and attributed all amendment to
> the first commit, omitting the second. In the one paragraph whose only job is exact provenance,
> that under-enumeration is itself the defect — corrected here, and stated because it must be
> right before anyone re-signs against it.
>
> Commits are cited by subject rather than by hash: the hashes changed under a rebase and dangling
> ones are worse than none. ADR 0010's precedent note uses descriptive anchors for the same reason.
>
> **What was ratified is the *direction*** — B + C, with an expiring request verdict. The mechanism
> that implements it, and three of the consequences, changed afterwards. Recorded rather than
> quietly re-dated. **A re-sign is warranted**; until then this note is the honest statement of
> what the label covers.
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
- **That verdict EXPIRES.** Past `AUTH_REQUEST_VERDICT_TTL_MS` (15 min) with no new success it decays to `null`, and `okSource` becomes `expired` so the reason is legible. Not a refinement — without it the design has a defect worse than the one it fixes. See below.
- **The verdict's provenance is separate from the probe's outcome.** `okSource` (`none` / `probe` / `request` / `expired`) and `okAt` record *how and when* `ok` was established; `lastOutcome` and `lastCheck` stay the probe's business. **This separation is not tidiness — it is the fix for two defects found in review**, both of which made the window above a fiction.
- **Request failures do not set `auth.ok = false`.** See the open question below.

### Why the raise must expire — the latch this design would otherwise create

A raised verdict that never expires is a latch, and on an env-token host **nothing can ever lower it**: `claude auth status` exits 0 whenever a token is merely present, so the probe can never contradict a stale `true`. The sequence is:

1. the proxy serves normally → C raises `auth.ok` to `true`
2. the token expires → every request starts failing
3. `auth.ok` stays `true`, because failures deliberately do not lower it
4. the probe cannot correct it, because the token is still *present*

Step 4 is the trap. The result is **byte-identical to the state #308 reported** — `/health` asserting the credential works while nothing can be served — reached by a different path.

This is #324's defect shape in the opposite direction, and the criterion recorded there applies verbatim: *do not ask what the clearing condition is, ask whether it is reachable.* Here it is not.

### The two ways the first implementation got this wrong

Both found by independent review, both proven by execution, both because the window was keyed on `lastOutcome`:

**(a) It was unreachable under the default configuration.** Every probe completion rewrites `lastOutcome`, and a probe always completes within `AUTH_CHECK_INTERVAL_MS + AUTH_CHECK_TIMEOUT_MS` — 610s by default, shorter than any sane window. So the decay branch could never fire, and the ADR, README and CHANGELOG all described a semantic the system did not have. The visible `true` → `null` transition operators would have seen came from the *next probe tick* overwriting the verdict, not from the window.

**(b) One inconclusive probe disarmed it permanently.** The inconclusive branches preserve `ok` — correct, a timeout measures host load, not credentials — while rewriting `lastOutcome` and advancing `lastCheck`. A request-established verdict therefore stopped matching the window and became permanent. Replayed: `T+100h` still read `auth.ok: true`. **That is precisely the unbounded false `true` this design exists to prevent, reintroduced by the guard meant to prevent it.**

Keying on `okSource`/`okAt` fixes both: only a request advances `okAt`, and no probe outcome can change `okSource`. The same replay now expires at `T+16min`.

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
- **`/health`'s `status` cannot be moved by any of this.** `proxyHealthStatus` reads `consecutiveFailures` and never `ok`, so no verdict change here can flip a host to `degraded`. It does **not** follow that the tally is untouched — an exit-0 probe resets it on both branches and a successful request clears it, which is a deliberate restoration of ADR 0010's self-heal. An earlier revision of this line said "nothing here writes that tally"; that was false, and it survived one round after the commit message that introduced the fix had already named it as concealment.
- Two contract changes on a grandfathered B.2 endpoint: the rule determining `auth.ok`, and two new `lastOutcome` values. Both are why this needs its own ADR rather than ADR 0012's additive-field authorization — ADR 0012 condition 1 excludes exactly this.
- The fleet's three env-token hosts will report `auth.ok: null` until their first successful request, then `true` — in practice one request — and back to `null` after 15 minutes of no successful traffic. An idle proxy therefore reports "not established" rather than a stale "works", which is the correct answer to a question nobody has evidence for.
- **An exit-0 probe resets the rejection tally on both branches.** The first implementation preserved it on the token-present branch, which silently removed ADR 0010's self-healing on exactly the hosts that use the env-token mechanism: once the tally reached the degrade threshold nothing could lower it again, because a successful probe was the only thing that did. Restored, and a successful request clears it too.
- **A probe never overwrites a fresher request verdict.** The token-present branch measured *less* than a recent completed request; letting it clobber that would contradict this ADR's own evidence hierarchy.
- **Clock movement, recorded rather than handled.** `now - okAt` uses `Date.now()`, a wall clock, so a backwards step extends a verdict's freshness by the step size. Bounded and in the safe direction (the alternative — expiring early — is also safe), so no monotonic-clock machinery. Stated so it is a known limit rather than an unexamined one.
- **A NaN guard, recorded because it was written wrong first.** The expiry check used `typeof x === "number"`, which `NaN` satisfies; every comparison against `NaN` is false, so `now - NaN <= ttl` fell through and a malformed timestamp silently expired the verdict. `Number.isFinite` now. The unit test that caught it exists precisely because this repo has been bitten by NaN-passes-every-threshold before — and it was written wrong here anyway, which is the argument for the test rather than for care.
- **Unrelated finding, recorded because it was found while writing this:** the circuit breaker is a stub. `breakerRecordSuccess()` and `breakerRecordTimeout()` have empty bodies, `/health` reports `circuitBreaker: "disabled"`, and four `CLAUDE_BREAKER_*` env vars are documented at `server.mjs:31-34` and parsed at `:382-385`. Documented interface, dead implementation. Its own issue, not this ADR's business.

## Alternatives considered

**Make the probe issue a real minimal request.** The only thing that measures "can this proxy serve" on a schedule. Rejected on cost: at the default interval that is ~144 metered calls per instance per day, ~576 across this fleet, and avoiding exactly that is why #232 built the probe the way it is.

**Parse `loggedIn` from stdout.** Carries no more information than the exit code, as the fabricated-token experiment shows.

**Leave it and document it.** The status quo is a health endpoint that reports the opposite of the truth on the majority of the fleet, while `ocp doctor`, `ocp update`'s post-flight, and any fleet-verification harness all read that same field. #308 exists because a rollout passed every check on a host that could not serve a single request.
