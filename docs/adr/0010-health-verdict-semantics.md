# ADR 0010 — `/health` and `/status` verdict semantics (what `degraded` means)

**Date:** 2026-08-01
**Status:** Accepted
**Deciders:** project maintainer
**Related:** issue #232; ADR 0006 (Class A/B taxonomy + the B.2 grandfather provision); ADR 0007 (precedent for amending a grandfathered B.2 endpoint's response); `ALIGNMENT.md` § "Current Class B inventory"

---

## Context

Issue #232 reported two defects living in the same eight lines of `server.mjs`'s auth health check.

**(A) The probe blocked the event loop.** `execFileSync(CLAUDE, ["auth","status"], { timeout: 10000 })` sat inside an `async function`, which does not make a synchronous call asynchronous. It froze the whole process for up to 10 seconds — once at boot, *before* `server.listen()`, and then again on every 10-minute interval tick.

**(B) A single failed probe pinned the verdict for ten minutes.** Both endpoints computed

```js
status: binaryOk && authStatus.ok !== false ? "ok" : "degraded"
```

— the identical expression, duplicated verbatim in `handleStatus` and in the `GET /health` handler. One failed probe set `ok:false`, and nothing re-evaluated until the next tick, so a single transient timeout reported `degraded` for a full interval while the proxy served normally.

That is not hypothetical. It was captured in production: `/health` reported `status=degraded, auth.ok=false, message="spawnSync ... ETIMEDOUT"` in the *same minute* that `POST /v1/chat/completions` returned `200`. The probe timed out because the host was loaded; the credentials were fine, and the request path — which resolves the *same* credentials, because `checkAuth` and `spawnClaudeProcess` scrub the environment identically — served the request without trouble.

Both `/health` and `/status` are **Class B.2 administrative endpoints, grandfathered at their v3.16.4 behaviour** by ADR 0006. ADR 0006 ¶39 states that "any change to the request shape, response shape, or semantics of a grandfathered B.2 endpoint is treated as a new authorization request and requires either (a) a behaviour-preserving refactor PR with no contract change, or (b) its own ADR", and ¶109 says so again from the consequences side: "If a grandfathered B.2 endpoint has a latent bug or undesirable behaviour, 'fixing' it is a contract change and now requires an ADR (or a behaviour-preserving refactor). This is intentional friction to prevent silent contract drift."

Fixing defect (B) changes the *semantics* of the `status` field on two grandfathered B.2 endpoints. This ADR is that authorization. No `cli.js` citation applies — `/health` and `/status` are OCP-owned surface (Class B); the citation is ADR 0006 plus this ADR, per `ALIGNMENT.md`'s Class B citation requirement.

## Decision

**`status` answers exactly one question: *can this proxy serve?*** Its value domain stays exactly `{"ok","degraded"}`.

`status` is `degraded` if and only if:

1. the `claude` binary is not executable (`accessSync(CLAUDE, X_OK)` fails), **or**
2. the auth probe has returned `AUTH_DEGRADE_AFTER` (**2**) **consecutive conclusive rejections**.

Otherwise it is `ok`.

Probe outcomes are classified into four cases, only one of which is a credential verdict:

| Probe result | `lastOutcome` | Conclusive? | Effect on `ok` | Effect on `consecutiveFailures` |
|---|---|---|---|---|
| exit 0 | `authenticated` | yes | `true` | reset to `0` |
| non-zero **numeric** exit code | `rejected` | yes | `false` | `+1` |
| killed by a signal (`err.signal` set — including our own timeout) | `timeout` | **no** | preserved | untouched |
| spawn failure (`err.code` non-numeric: `ENOENT`, `EACCES`, …) | `unavailable` | **no** | preserved | untouched |

**Inconclusive probes never move the verdict.** A probe timeout measures *host load*, not credential validity — the production capture above is the proof. A spawn failure means the probe never ran at all, which likewise says nothing about credentials (and an unusable binary is already caught by condition 1, which is a real serving precondition).

**A non-zero exit is different in kind.** `claude` ran to completion and rejected. Because the probe and the request path resolve identical credentials, that genuinely predicts serving failure.

The verdict lives in **one** module-level helper, `proxyHealthStatus(binaryOk)`, called from both sites. This is structural, not stylistic: the two expressions were byte-identical copies, and the only reliable way to keep them from drifting apart is to have exactly one of them.

The probe itself becomes genuinely asynchronous (`execFile`, not `execFileSync`), guarded by a module-level `authProbeInFlight` flag so an interval tick that lands while a probe is still running is skipped rather than stacking another spawn. The probe is an idempotent diagnostic; piling spawns onto a host that is already slow enough to make probes run long is the pathology, not a mitigation.

Two env tunables are added, parsed fail-closed through `parseIntEnv` (empty / NaN / non-positive falls back to the default):

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_AUTH_CHECK_INTERVAL_MS` | `600000` | How often the background probe runs |
| `CLAUDE_AUTH_CHECK_TIMEOUT_MS` | `10000` | Per-probe timeout |

The 10-second timeout is **deliberately unchanged**. Issue #232 is explicit that a longer timeout is not the fix, and it is right: the timeout bounds a stuck child, and lengthening it would only widen the window in which the tally is stale. What was wrong was that the call blocked, not that it was bounded.

### Why the auth probe stays in the verdict at all

The issue's simpler suggestion was to drop auth from `status` entirely and let `status` mean only "the binary is usable". Rejected, for a specific downstream reason: **`dashboard.html:151` uses `proxy.status` as its *only* auth signal**, with no fallback — the Status card is rendered green or red purely from that string, and the dashboard never reads `auth.ok`. Removing auth from the verdict would leave the card showing a healthy green during a genuine credential outage, which is a strictly worse failure than the one being fixed: a false negative on the condition an operator most needs to see.

The threshold keeps the true positive (a sustained credential rejection is still reported) and removes the false one (a loaded host is no longer reported as a credential problem).

### Why the threshold is 2

One conclusive rejection is not yet evidence of a condition. The realistic benign case is an OAuth token being refreshed underneath the probe: `claude auth status` can lose a race against its own credential rotation and exit non-zero once, with everything healthy a second later. Two *consecutive* rejections is a real condition, not a race.

The trade-off, stated plainly: **a genuine credential outage is now reported one probe interval later than before** — up to `CLAUDE_AUTH_CHECK_INTERVAL_MS` (10 minutes by default) of additional delay before the dashboard turns red. That is the price of not crying wolf every time the host gets busy, and it is the right trade for this surface: the operator-facing cost of a ten-minute false `degraded` (which happened, repeatedly) is higher than the cost of a ten-minute-later true `degraded`. An operator who wants faster detection can lower the interval.

### Rejected alternative — re-probe on demand when `/health` is queried

The obvious way to make the verdict fresh is to run the probe when someone asks. Rejected: **`/health` is reachable without authentication**, so this would let any unauthenticated caller trigger an unbounded number of subprocess spawns simply by polling. That is a denial-of-service vector, and — worse for this particular fix — it would reintroduce exactly the spawn pressure this change exists to remove, on exactly the loaded host where it does the most damage. A background probe on a fixed interval, with an in-flight guard, is bounded by construction.

## Consequences

### Downstream: `ocp update`'s post-flight check changes behaviour

**This is the change most likely to surprise someone, so it is stated first.** `auth.ok` is now **preserved** across an inconclusive probe instead of being clobbered to `false`. `postFlightOk` (`scripts/upgrade.mjs:453`) requires `body?.auth?.ok !== true` to fail:

```js
export function postFlightOk(body, target) {
  if (body?.auth?.ok !== true) return false;
  const want = String(target || "").replace(/^v/, "");
  return !want || body?.version === want;
}
```

So on a busy host, `ocp update`'s post-flight verification will now **pass** where it previously **failed spuriously** — a timed-out probe used to leave `auth.ok=false` for up to ten minutes, and an upgrade that landed inside that window was reported as failed even though the new version was serving correctly.

This is an intended improvement, and it does not weaken the check that actually guards against the failure mode `postFlightOk` was written for: per that function's own comment, `auth.ok` alone was never sufficient — the **version match** is the real orphan guard ("a stale process holding the port answers `auth.ok=true` while still running the OLD code"). That comparison is untouched.

But it **is** a behaviour change to `ocp update` and must not be discovered by accident.

### Consumers of `status`

There are exactly three readers in the repo:

| Consumer | Reads | Effect |
|---|---|---|
| `dashboard.html:151` | `proxy.status` from `/status` — its **only** auth signal, no fallback | Status card stops flipping red on a busy host. Still turns red on a sustained credential outage (one interval later than before) and on an unusable binary. |
| `ocp-plugin/index.js:113` (`cmdStatus`) | `d.proxy?.status`, the repo's only literal `"degraded"` comparison, three-way 🟢/🟡/🔴 | Unchanged code path; the value domain is still exactly `{"ok","degraded"}`, so the 🟡 branch still fires on `degraded` and 🔴 still fires only when the field is missing/unreachable. |
| `ocp-plugin/index.js:95` (`cmdHealth`) | `d.status`, echoed verbatim | Prints the new verdict. No parsing, no comparison. |

`postFlightOk` (`scripts/upgrade.mjs:453`), `scripts/doctor.mjs:668` / `:869`, the `ocp` CLI, `ocp-connect` and `setup.mjs` all read `auth.ok` / `version` **directly** and never read `status`, so they are affected only via the `auth.ok` preservation described above.

### Field additions

`/health`'s `auth` object gains two fields, `lastOutcome` and `consecutiveFailures`. This is **additive**: no existing field is renamed, removed, or re-typed, and every existing `/health` consumer reads what it already read. That is the same standard ADR 0007 applied when it added the `tui` block to `/health` — "the change is additive … no existing `/health` field is changed, renamed, removed, or re-typed" — and it is the bar ADR 0006's grandfather provision sets for a non-ADR contract change. The `status` **semantics** change is what needs this ADR; the new fields ride along under the ADR 0007 precedent.

`/status` keeps `auth: authStatus.ok ? "ok" : authStatus.message` and `/health` keeps `auth: authStatus` exactly as they were.

### Costs accepted

- A genuine credential outage is reported up to one probe interval later. See "Why the threshold is 2".
- `authStatus.ok` can now be *stale* rather than merely wrong — it holds the last **conclusive** verdict, which may be older than `lastCheck`. `lastOutcome` exists so an operator can tell the difference, and `lastCheck` still moves on every completed probe whatever its outcome.
- `AUTH_DEGRADE_AFTER` is a constant, not an env var. Two is a judgement about what a credential rotation race looks like, not a per-deployment tuning knob; making it configurable would invite operators to set it to 1 and re-create the bug.
