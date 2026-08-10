# 0015 — The Three-Boundary Refactor Is Not Approved As Drafted

- **Date**: 2026-08-10
- **Status**: Accepted
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0002 (Alignment Constitution), ADR 0006 (Class A/B taxonomy), ADR 0007 (TUI interactive mode), ADR 0012 (additive fields on grandfathered B.2), ADR 0014 (auth verdict measures what it measured), issue #363

## Context

An external cross-vendor audit of `server.mjs` (codex / gpt-5.6-sol, read-only, at v3.29.0) was commissioned to answer a maintainer question: *is OCP a ball of mud, and can the defect stream converge?*

Its answer was specific and is worth preserving on its own: **not a whole-repo mud, but `server.mjs` IS a localized ball-of-mud at the request-lifecycle boundary**, and it is convergent **only if the shared boundaries become shared mechanisms**. It recommended three: a decoder boundary, a lifecycle boundary, and a resource-ownership boundary.

A plan was drafted to execute that recommendation. The same reviewer was then asked to attack the plan. **It rejected it**, in terms that make the rejection more valuable than the recommendation:

> **Do not execute this plan as written.** The narrow #359 fix should be done; the three-boundary program should not yet be approved.

Independent scope estimate: **6–9 reviewable PRs plus an ADR and operational soak, with high semantic risk.** The P0 inside it was a one-PR fix, and shipped as one (#359, #365/#369).

This ADR exists because **the recommendation is easy to re-derive and the corrections are not.** Anyone reading `server.mjs` with fresh eyes will reach "these six lanes should share one lifecycle wrapper" within an hour. Reaching it *without* the six corrections below repeats a rejected design.

## Decision

**The three-boundary refactor is not approved as drafted.** Narrow, individually-reviewable fixes are the approved path for the defects it was meant to address. A future proposal for shared boundaries is welcome and must address every correction in this record explicitly.

## The six corrections

### 1. The seam was wrong — two tokens, not one wrapper

"One lifecycle wrapper for six lanes" is a **forced abstraction**. The lanes do not share one lifecycle; there are at least **three domains**: client-request lifecycle, provider-attempt lifecycle, and resource ownership/shutdown.

Evidence, all from `server.mjs` at v3.29.0: the default path counts `totalRequests` at spawn but `activeRequests` only after process registration (`:1572`, `:1618`); TUI records a model attempt *before* semaphore acquisition and writes elapsed as an explicit `0` (`:1837`, `:2003`); default streaming returns without awaiting the child's terminal outcome (`:2156`, `:2305`); structured output can make **several upstream attempts for one HTTP request** (`:2999`, `:3216`); a cache hit makes **no** upstream attempt (`:3265`); singleflight can be **several HTTP requests sharing one upstream attempt** (`:3323`).

A single wrapper either miscounts these or grows five conditionals — centralising the duplication rather than removing it.

The seam that does fit is **two tokens**:

- a **request-outcome token**, created once per accepted HTTP request — client-request count, final usage row, wall-clock, disconnect;
- a **provider-attempt token**, created once per actual Claude attempt — per-model counters, timeout, auth-on-success;
- resource ownership stays separate.

Then the awkward cases stop being awkward: a cache hit is a request with **zero** attempts; a structured retry is **one** request with N attempts; singleflight is **N** requests with **one** attempt.

### 2. Most of it is a contract change, not ADR 0006 route (a)

The plan assumed "making an under-reporting counter truthful" was behaviour-preserving. Checked against the ADRs the plan had not read:

| Field | Verdict |
|---|---|
| `auth.ok` | **Route (a), correct.** ADR 0014:114 already states that a successful request reaching the model sets the request-derived verdict. TUI not calling `noteAuthVerifiedByRequest()` is an implementation omission. |
| `activeRequests` | **Needs its own ADR.** ADR 0007 deliberately introduced a separate `tui.inflight` and stated existing `/health` field semantics were unchanged (`:183`, `:217`). Folding TUI into the old counter **changes its rule**. |
| `avgElapsed` / `maxElapsed` | **Needs its own ADR.** The TUI `0` is an **explicit sentinel** (`server.mjs:2003`), not a missing call. Replacing "unmeasured" with a duration changes the rule. |
| `stats.errors` | **Treat as a contract change** until an ADR proves otherwise. |

Also threatened by the same change and unlisted in the plan's compatibility table: `totalRequests`, `oneOffRequests`, `timeouts`, and queued/rejected work.

This is `CLAUDE.md`'s dividing question in its sharpest form: **not "is the current value wrong?" but "does the field's documented meaning change?"**

### 3. The compatibility inventory was wrong, including its method

- `dashboard.html:145` reads total, active, errors **and timeouts** — not just `activeSessions`.
- `ocp:304` and `ocp-plugin/index.js:72` read per-model errors, avg and max elapsed, proxy errors/timeouts.
- `scripts/upgrade.mjs:492` uses **`/health.status`** for post-flight, not `auth.ok`; its `auth.ok` dependency is indirect, via doctor.
- **"No third-party consumers" cannot be established by finding zero imports.** ADR 0006:12 explicitly names external OpenAI clients and BYO scripts as consumers. For an HTTP proxy that inference is invalid on its face.

Counts were also wrong — decoder 8 not 9 (chat double-counted), lifecycle 33/34 not 38 (function declarations counted as calls), ownership 27 occurrence lines not 20 operations. The reviewer's summary of why that matters is the durable part:

> These errors do not determine implementation size, but they show the proposed seams were **counted textually rather than traced behaviorally.**

### 4. Phase 1 was not zero-risk

Three more caps use string `.length` — `/settings` (`:2930`), `POST /api/keys` (`:3658`), quota (`:3694`) — and both stderr accumulators are later string-sliced, logged, and turned into `Error` messages (`:1787`, `:1797`, `:2303`, `:2318`). So `StringDecoder` and "Buffer.concat once" are **not interchangeable**, which the plan treated as equivalent options.

And the fix **does** change observable behaviour: a body split mid-character currently corrupts and may 400; afterwards it parses. Justified — and shipped as #359 — but not "no consumer-visible change".

### 5. #362 has a much smaller seam than a registry

Recorded in the issue; the point generalises. Several defects the program was meant to fix have local seams that do not require the program.

### 6. The recommendation survives; the plan does not

The audit's convergence claim — that this is a *localized* mud at one boundary, and that shared boundaries would converge it — was **not** retracted. What was rejected is the specific decomposition, the compatibility analysis, and the assumption that most of it was behaviour-preserving.

## Consequences

- Defects in this area ship as narrow, individually-reviewable PRs with their own class evidence. #359, #365/#369, #347/#351, #352/#371 all took that path and all landed.
- A future shared-boundary proposal must (a) use the two-token seam or argue against it with behavioural traces, (b) carry an ADR for every field whose *rule* moves, (c) build its consumer inventory from the wire rather than from imports, and (d) count by tracing behaviour, not by grepping text.
- **The cost of not doing it is accepted and named**: the duplication at the request-lifecycle boundary stays, and defects will keep appearing there one at a time. That is the trade — bounded, reviewable increments over one large semantically-risky change — and it is a decision, not an oversight.
- **This ADR does not license refusing the refactor forever.** If the per-defect rate at that boundary stops falling, that is evidence the trade has gone bad, and the correct response is a new proposal that answers the six corrections — not a re-run of the rejected one.

## Provenance note

The review that produced these corrections was **cross-vendor** — a different model family, harness, and quota pool from the agent that wrote the plan. That decorrelation is the mechanism, not a detail: the plan's author had already reviewed it and found it sound.
