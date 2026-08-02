# ADR 0012 — Additive Read-Only Fields on Grandfathered Class B.2 Endpoints

**Date:** 2026-08-03
**Status:** Proposed
**Extends:** [ADR 0006](0006-openai-shim-scope.md) (Class B scope and the B.2 grandfather provision).
This ADR does not widen ADR 0006's boundary against new Class B surface; it answers a question
ADR 0006's text leaves determinate but expensive, and closes the compliance gap that answer exposes.

---

## Context

Issue #288 asked a question that ADR 0006 already answers, and then observed that the repo has not
been following its own answer.

ADR 0006 § "The grandfather provision is narrowly scoped" says:

> It freezes those endpoints at their **current behaviour**. Any change to the request shape,
> response shape, or semantics of a grandfathered B.2 endpoint is treated as a new authorization
> request and requires either (a) a behaviour-preserving refactor PR with no contract change, or
> (b) its own ADR.

Adding a field to a response **is** a change to the response shape. It therefore cannot be (a),
which requires "no contract change", and so requires (b). The text is not ambiguous.

The practice has been otherwise. Surveying the changelog for additive fields on endpoints the
inventory grandfathers:

| Change | Endpoint | Shipped | Authority actually cited |
|---|---|---|---|
| `inflight`, `requesters` | `/cache/stats` | v3.13.0 | the general ADR 0006 grandfather clause |
| `tui` block (`enabled`, `entrypointMode`, `lastEntrypoint`, `entrypointMismatches`, `inflight`, `maxConcurrent`) | `/health` | v3.19.0 | ADR 0007 / ADR 0008 (the TUI feature ADRs) |
| `auth.lastOutcome`, `auth.consecutiveFailures` | `/health` | v3.27.0 | ADR 0010 |
| `pool` | `/health` | v3.20.0 | ADR 0008 |

Three of the four are covered only incidentally: the field arrived as part of a *feature* that
needed an ADR for its own reasons, and the field rode along. `/cache/stats` had no accompanying
feature ADR, so it cites the grandfather clause directly — which, per the text above, does not
authorize it.

#288 framed this as "`/health` `pool` got its own ADR and `/cache/stats` did not". That framing is
slightly off and the correction matters: **ADR 0008 was not written because a field was added to
`/health`.** It was written for the warm-pane pool, a substantial feature with its own risk
surface; `pool` on `/health` is one paragraph inside it. There is no precedent here of anyone
writing an ADR *for a field*. The real situation is that the rule has never been applied to
additive fields at all, in either direction.

So the choice is not "which of the two cases was right". It is: does the rule mean what it says,
and if so, what does compliance cost?

## The tension

The rule's stated purpose is narrow and worth keeping. ADR 0006:

> The structural intent is: take the one-time hit of declaring "current B.2 surface is authorized"
> cleanly, then make every future addition pay the ADR-per-endpoint cost. This prevents Class B
> from becoming a backdoor for general OCP-owned-surface invention.

The thing being prevented is **invention of new surface**. An additive, read-only observability
field on an endpoint that already exists, already returns a JSON object, and already reports on
the proxy's own internals is not that. Requiring a bespoke ADR for each one would attach the
repo's heaviest process to its lightest change, and — on the evidence above — that requirement has
simply been ignored rather than obeyed, which is worse than either alternative: the rule provides
no protection and the practice has no record.

Relaxing it wholesale is not acceptable either. "Additive" is a slippery word. A field whose
*presence* changes how a client behaves, a field that duplicates an existing one with different
semantics, or a field that is additive on paper while the endpoint's meaning shifts underneath it,
are all real ways for surface to grow without anyone deciding to grow it.

## Decision

**Additive read-only fields on an already-grandfathered Class B.2 endpoint are authorized by this
ADR as a standing authorization, subject to every condition below. A change that fails any
condition is a contract change and needs its own ADR, exactly as ADR 0006 requires today.**

Conditions, all of which must hold:

1. **Additive only.** No existing field is removed, renamed, retyped, or has the rule that
   determines its value changed. (The last clause is the ADR 0010 test, restated: same name, same
   type, new rule is a contract change — see `CLAUDE.md` § "Hard requirements".)
2. **Read-only.** The field reports state. It does not accept input, and no request shape changes.
3. **No new endpoint and no new method.** ADR 0006's prohibition here is untouched and is not
   subject to this standing authorization.
4. **Same endpoint purpose.** The field reports on what the endpoint already reports on. A
   genuinely new subject — a new subsystem surfaced through a convenient existing endpoint because
   it is cheaper than adding one — is new surface wearing an additive costume, and needs its own ADR.
5. **Recorded.** The PR states "additive under ADR 0012" and lists the exact field names, and the
   CHANGELOG entry names them. This is what makes the standing authorization auditable: the record
   lives in the same place a reviewer already looks, rather than in a document nobody re-reads.
6. **B.2 only.** This does not extend to B.1, which is bounded by OpenAI's published specification
   and has no grandfather equivalent (ADR 0006), nor to Class A, which is bounded by `cli.js`.

**Retroactive scope.** The four changes in the Context table are authorized under this ADR as of
their shipped versions. This is not a general amnesty: they are enumerated, they each satisfy the
six conditions above (verified field by field), and no future change inherits authorization from
them. `ALIGNMENT.md`'s Amendment Procedure clause — *"Amendments never retroactively legitimize
previously unalignable features"* — is satisfied because none of these were unalignable; they were
under-recorded. The distinction is the point: an unalignable feature is one that could not have
been authorized had it been asked for, and each of these would have been.

## Consequences

- The `/cache/stats` compliance gap #288 identified is closed, by authorization rather than by
  removal, because the fields themselves were never the problem.
- Adding an observability field to `/health`, `/status`, `/cache/stats`, `/sessions` or another
  grandfathered B.2 endpoint costs one line in the PR body and one in the CHANGELOG, not an ADR.
- The boundary that actually matters — new endpoints, new methods, new subjects, changed semantics
  — is unchanged and still costs an ADR. ADR 0006's structural intent is preserved; what changes
  is that the cheapest legitimate change no longer carries the most expensive process, which is
  what made the rule unenforced in practice.
- Condition 5 creates the audit trail this ADR relies on. Without it the standing authorization
  would be indistinguishable from having no rule, which is the state #288 found.
- **Cost, stated plainly:** this is a genuine loosening. A reviewer who previously would have been
  forced to read a dedicated ADR for a new `/health` field now sees only a PR line. The bet is that
  conditions 1–6 are checkable in a review and an unread ADR is not; if that bet is wrong, the
  failure mode is surface growing one "obviously fine" field at a time, and the remedy is to revert
  to ADR 0006's unmodified rule.

## Alternatives considered

**Leave ADR 0006 unchanged and file an ADR retroactively for `/cache/stats`.** Answers #288's
narrow question and leaves the general one open, which means the next author faces the same
decision with the same absence of guidance — and, on the evidence, makes the same call. It also
leaves the `/health` `tui` and `auth` additions resting on feature ADRs that do not discuss them.

**Declare additive changes behaviour-preserving under ADR 0006(a).** Cheapest, and wrong: (a)
says "no contract change", and a response gaining a field has changed its contract. Redefining
"behaviour-preserving" to include shape changes would also weaken the ADR 0010 test, which turns
on precisely that word.

**Require an ADR per field, and enforce it.** Internally consistent and the honest reading of ADR
0006 as written. Rejected on proportionality: four instances shipped without one and nobody
noticed until an outside review, which is evidence about what the process will actually bear.

## References

- Issue #288 — the inconsistency, and the question
- [ADR 0006](0006-openai-shim-scope.md) § "The grandfather provision is narrowly scoped"
- [ADR 0008](0008-tui-warm-pane-pool.md), [ADR 0010](0010-health-verdict-semantics.md) — the feature ADRs the earlier additive fields rode along with
- `ALIGNMENT.md` § "Grandfather provision for existing B.2 inventory", § "Amendment Procedure"
- `CLAUDE.md` § "Hard requirements for `server.mjs` changes" — where the dividing test is stated for authors
