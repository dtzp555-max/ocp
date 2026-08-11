# 0018 — The Aggregate Request Counters Count Every Lane

- **Date**: 2026-08-11
- **Status**: Accepted
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0006 (Class A/B taxonomy and the B.2 grandfather — this is route **(b)**), ADR 0007 (**superseded in part**, see under Decision), ADR 0010 (`/health` verdict semantics), ADR 0012 (additive fields — deliberately *not* used here), ADR 0014 (auth verdict), ADR 0015 § "The six corrections" correction 2 (which required this ADR to exist), issue #361, PR #389 (the auth half)

## Context

`server.mjs` serves requests down two lanes. The default lane spawns `claude -p` per request
(`spawnClaudeProcess`, wrapped by `callClaude` / `callClaudeStreaming`). The TUI lane drives an
interactive `claude` inside a tmux pane (`callClaudeTui`, with `callClaudeTuiStreaming` awaiting it
rather than spawning its own).

The tempting reading is that these are two lanes with two separate accounting surfaces: `-p`
requests in `stats.*`, TUI turns in `tui.*`. ADR 0007 is usually cited for it. **That separation is
not what the code does.**

### Measured, at `dd90be3`

Cited by symbol rather than by line, because line numbers in this file have gone stale inside a
single merge before (`test-features.mjs`'s #362 comment records that happening twice).

| Counter | Sole write site | TUI lane participates? |
|---|---|---|
| `stats.totalRequests` | `spawnClaudeProcess` | **no** |
| `stats.oneOffRequests` | `spawnClaudeProcess` (unconditional, beside `totalRequests`) | **no** |
| `stats.activeRequests` | `spawnClaudeProcess` (one `++`; one `--` in its `cleanup()`) | **no** |
| `stats.timeouts` | `spawnClaudeProcess` (the `overallTimer` callback) | **no** |
| `stats.errors` | `trackError` — five call sites, two in `callClaude`, three in `callClaudeStreaming` | **no** |
| `stats.queued` | `acquireClaudeSlot` — **assigned**, not incremented; a gauge mirroring `claudeSemaphore.queued` | **no** |
| `stats.queueRejections` | `acquireClaudeSlot` | **no** |
| per-model `requests` / `avgPromptChars` / `maxPromptChars` | `recordModelRequest` — called from **both** `spawnClaudeProcess` **and** `callClaudeTui` | **yes** |
| per-model `successes` / `avgElapsed` / `maxElapsed` | `recordModelSuccess` — including `callClaudeTui`, with an explicit `0` | **yes** |
| per-model `errors` / `timeouts` | `recordModelError` — including `callClaudeTui`, always with `isTimeout: false` | **yes** |

So the TUI lane **half-participates**: it writes every per-model counter and no aggregate one. A
defensible design would be all-in or all-out. This is neither, and it was reached by omission rather
than by decision — the same shape as #339 and as this issue's own auth half (#389).

The consequence an operator actually meets: a failed TUI turn increments the per-model error count
while `/health`'s `stats.errors`, `/status`'s `requests.errors` and `/usage`'s `proxy.errors` all
stay `0`. That is **one response reporting the same event two ways**, not two lanes reported
separately.

### Why this needed an ADR at all

ADR 0015 correction 2 adjudicated the two halves of #361 differently, and the distinction is
`CLAUDE.md`'s dividing question — *not* "is the current value wrong?" but **"does the field's
documented meaning change?"**

- The **auth** half was route **(a)**: ADR 0014 already stated, unqualified by lane, that a request
  reaching the model sets the request-derived verdict. TUI not calling it was an implementation
  omission. Shipped as #389 with no new ADR.
- The **counter** half is a **contract change**. Every field below keeps its name and its type, and
  the *rule that determines its value* changes from "on the `-p` lane" to "on any lane". ADR 0006
  route (b) and `ALIGNMENT.md`'s grandfather provision both make that its own authorization request.

This ADR is that request. **The grandfather clause is deliberately not cited as if this were
behaviour-preserving, and ADR 0012 does not apply** — 0012 authorizes *additive* fields, and nothing
here is added or removed. No response key set moves.

## Decision

**The aggregate counters count every lane. The lane-specific ones stay lane-specific.**

Each field was decided on its own evidence; the result is deliberately not uniform.

### Folded — the rule becomes "on any lane"

| Field (on the wire) | New rule | Where |
|---|---|---|
| `stats.totalRequests` | every request the proxy accepts and begins upstream work for, on either lane | `callClaudeTui`, beside the existing `recordModelRequest` — mirroring the `-p` lane, which also counts before the child exists |
| `stats.activeRequests` | requests in flight on either lane | `callClaudeTui`: `++` as the first statement of the turn's `try`, `--` in the `finally` that already releases the semaphore |
| `stats.errors` | any upstream failure on either lane | `callClaudeTui`'s `catch`, beside the existing `recordModelError` — so it inherits that branch's existing, correct exclusion of client disconnects |
| `stats.timeouts` | a turn that exceeded its wall-clock bound, on either lane | `callClaudeTui`: both wall-clock outcomes (see below) |

`/status`'s `requests.{total,active,errors,timeouts}` and `/usage`'s
`proxy.{totalRequests,activeRequests,errors,timeouts}` read the same four variables and change with
them. `/usage` is Hybrid (ADR 0006); only its Class B.2 synthesis layer is touched, and this ADR
authorizes that layer. The Class A wire call inside it is untouched.

**`stats.timeouts` covers both wall-clock outcomes, because they are one event.**
`readTuiTranscript` polls to a single cap and then either returns `truncated: true` (partial text,
no terminal marker) or throws `tui_transcript_timeout` (no text at all). The difference is how much
text arrived, not whether the bound was exceeded. Counting only one would make the field's value
depend on an accident of the transcript. This mirrors the `-p` lane, where the field means "the
request's deadline expired".

**Per-model `timeouts` is corrected in the same branch.** `callClaudeTui` calls
`recordModelError(cliModel, false)` unconditionally today, so the TUI lane's per-model `timeouts` is
permanently `0` for the same reason the aggregate one was. Folding the aggregate field without this
would replace one asymmetry with a fresher one *inside the same response*, which is the defect this
ADR exists to end. It is authorized here explicitly rather than left to a follow-up.

### Not folded — and why each is not symmetry-for-symmetry's-sake

| Field | Decision | Reason |
|---|---|---|
| `stats.oneOffRequests` | **unchanged** | It does not mean "a request". It means **a request served by a one-off `-p` spawn**, as distinct from a resumed session — the sibling of the `sessionHits`/`sessionMisses` pair ADR 0016 Amendment 1 removed. A TUI turn is the opposite of a one-off spawn: it is a turn inside a persistent interactive pane. Folding it in would make the field's *name* false, which is a worse outcome than leaving it narrow. It is currently equal to `totalRequests` on the `-p` lane; after this change it is the `-p` subset of it, which is the first time the two fields have said anything different from each other. |
| `stats.queued` | **unchanged** | Not a counter — a **gauge assigned from `claudeSemaphore.queued`**, the `-p` semaphore. The TUI semaphore's queue depth is already on the wire at `tui.queued`. Summing two independent semaphores into one number would destroy the operator's ability to tell which lane is backed up, and would make `stats.queued` disagree with `concurrency.queued`, which is fed from the same `-p` semaphore — a contradiction *inside one response*. |
| `stats.queueRejections` | **unchanged** | Same reasoning: it is the `-p` wait queue's rejection count and is mirrored at `concurrency.queueRejections` from the same variable. Folding TUI rejections in would put two different numbers under two names fed by one variable. A TUI queue-full rejection is genuinely unreported today; reporting it needs a **new field**, which is additive surface under ADR 0012 with its own conditions and would move the B.2 key-set snapshot. This ADR authorizes no key-set movement, so that is deliberately left to its own change. |
| per-model `avgElapsed` / `maxElapsed` | **unchanged — the `0` sentinel stays** | Verified still present and still deliberate: `callClaudeTui` calls `recordModelSuccess(cliModel, 0)` under the comment *"elapsed not measurable here; wallclock at reader level"*. These are **per-model fields only — there is no `stats.avgElapsed`** — so there is no aggregate counter to fold. Replacing "unmeasured" with a duration is a separate rule change with a real unanswered question (which clock: the turn, or the turn plus its queue wait?), and it is not needed to make the aggregate counters honest. `TUI_MODE` is process-global, so a single process never mixes a measured and a sentinel elapsed for the same model; the sentinel does not corrupt a mixed average, because there are no mixed averages. |

### What this supersedes in ADR 0007

ADR 0007 § "ALIGNMENT authorization for the `/health` change" argues its own additive change was
behaviour-preserving. Its first bullet reads:

> - The change is **additive**: it adds one new top-level field (`tui`) containing only new
>   sub-fields. **No existing `/health` field is changed, renamed, removed, or re-typed**, and no
>   existing semantics change.

**That bullet's final clause — "and no existing semantics change" — is superseded by this ADR, for
the four folded fields only.** Everything else in ADR 0007 stands, including the whole of § C-5
(`:183`), the `tui` block it introduced, and its authorization for that block.

The distinction worth preserving: ADR 0007's claim was **true when it was made**. It authorized
adding `tui.*` without touching `stats.*`, and it did exactly that. What it did not do — and was
never asked to do — is establish that `stats.activeRequests` *should* exclude the TUI lane. It
recorded that its own change did not alter the field; that has since been read as a design
separation the ADR never argued for. `tui.inflight` remains on the wire, unchanged, still reporting
TUI-only in-flight turns. After this change `stats.activeRequests` is the total across both lanes
and `tui.inflight` is the TUI component of it — a containment relationship, not a contradiction.

## Alternatives rejected

- **All out** — remove `recordModelRequest` / `recordModelSuccess` / `recordModelError` from
  `callClaudeTui` so the separation is genuinely clean. Cheaper and internally consistent, and it
  was a real candidate. Rejected because it *loses* information an operator wants (per-model TUI
  visibility) in order to fix a reporting gap, and because `stats.errors` reading `0` while the
  proxy returns 500s is the least defensible reading on the whole surface — "a different lane" does
  not explain it to someone watching a dashboard.
- **Document the split as designed** — no longer available on the evidence above. It would be
  documenting an inconsistency as a design, and the inconsistency is not one a reader can predict:
  nothing tells them per-model is in and aggregate is out.
- **A shared request-lifecycle wrapper** (ADR 0015's two-token seam). Correct, and out of scope
  here. This ADR deliberately changes *which lanes reach the existing counters* and not *what a
  "request" is*. Cache hits and singleflight followers still move no aggregate counter on either
  lane; that is ADR 0015 correction 1's question and is untouched, unfixed, and unblocked by this.

## Consequences

- **`dashboard.html` (`refreshStatus`), `ocp` (`cmd_usage`), `ocp-plugin/index.js` (`cmdHealth`,
  `cmdStatus`, `cmdUsage`) and any unnamed HTTP consumer start seeing TUI traffic** in total /
  active / errors / timeouts. For a proxy running TUI mode these numbers go from permanently `0` to
  correct. No consumer needs a code change; every one of them was already reading these fields and
  under-reporting. Two **generic** consumers were swept for as well, because a field-name grep
  cannot see them: `ocp health` and `ocp status` pipe the *whole* body through `python3 -m json.tool`
  and will simply print the new values (this repo's `CHANGELOG` records that exact mechanism
  printing two dead fields for twelve releases), and `scripts/b2-key-snapshot.mjs` records key paths
  only and is value-blind by construction.
- **One consumer gates a real operator decision on this, and this change repairs it.**
  `docs/runbooks/615-canary.md` § "Step 1 — Quiesce the host" instructs the operator to
  `grep activeRequests` and *"Wait until `activeRequests` is `0` before proceeding"*. That runbook's
  stated purpose is confirming how a **TUI-mode** turn is billed, and it lists
  `CLAUDE_TUI_MODE=true` as a precondition — so it has been gating on the one field TUI traffic
  never moved. The check reads `0` while a TUI turn is mid-flight, which is exactly the state it
  exists to exclude. After this change it means what the runbook says it means. Recorded here rather
  than fixed elsewhere: no runbook edit is needed, because the text was always correct and the field
  was not.
- **No response key set moves.** Existing fields, existing types, new values.
  `docs/governance/b2-response-keys.json` stays byte-identical and `npm test`'s key-set check stays
  green — which is the correct signal here, and a *diff* in that file would mean this change had
  exceeded its authorization.
- **`totalRequests` and `oneOffRequests` can now differ.** Any consumer that has been treating them
  as interchangeable (they have been numerically equal for the whole life of the `-p` lane) will see
  them diverge under TUI mode. That divergence is the point: it is what makes the `-p` subset
  legible.
- **TUI mode is off in production** (`tui.enabled: false`; the mode is a dormant billing hedge).
  This is a real defect on a lane nothing currently runs, which is why it was worth deciding
  carefully rather than quickly.
- **Not covered, and stated so nobody reads a green suite as coverage**: a TUI queue-full rejection
  is still counted nowhere; cache hits and singleflight followers still move no aggregate counter on
  either lane; `avgElapsed` / `maxElapsed` still report `0` for every TUI turn.
