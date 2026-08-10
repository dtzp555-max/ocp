# 0017 — `POST /api/keys` Request Shape, and What the Grandfather Is a Snapshot Of

- **Date**: 2026-08-10
- **Status**: Accepted (maintainer sign-off 2026-08-11)
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0006 (Class A/B taxonomy and the B.2 grandfather), ADR 0012 (additive fields on grandfathered B.2), ADR 0016 (how B.2 surface may be *removed*), `ALIGNMENT.md:114`, issues #383, #360, #114

> **Citations in this ADR name symbols, not line numbers.** The draft cited `server.mjs:3928` and
> `:3929`; between drafting and sign-off those lines moved to `:4050`/`:4051` (#395, #403) and then
> to `:4052`/`:4053` (#404) — three moves in two days, none of them touching this handler. A line
> number in a governance document is a citation that decays without anyone editing it, which is the
> defect Consequence 4 below is about. Every claim here was re-derived against `eac7c39` before
> merge, and the branch was then rebased onto `5ff125e`, which touches none of this handler; the measurement commands are given inline so a reader can re-derive them again.

## Context

`POST /api/keys` is a grandfathered Class B.2 endpoint, frozen by ADR 0006 at its **v3.16.4** behaviour. Two facts about its current request shape were established by measurement while drafting this ADR, and they point in opposite directions.

### Fact 1 — a scalar body mints a real API key, and that IS v3.16.4 behaviour

In the `req.url === "/api/keys" && req.method === "POST"` branch the handler does ``const name = parsed.name || `key-${Date.now()}` ``. Property access on a primitive **boxes** rather than throwing, so for a body of `42`, `"str"`, `true`, or `[]`, `parsed.name` is `undefined`, the `||` falls to the auto-name, and `createKey` runs. All four return **201 with a usable credential** — behaviourally identical to the documented `{}` request.

Measured against a running server at `eac7c39` (the branch's base at the time of measurement; it was later rebased onto `5ff125e`, whose three commits touch no request handler), asserting the key **store** and not only the status:

| body | status | keys before → after |
|---|---|---|
| `42` | 201 | 0 → 1 (`key-1786399662735`) |
| `"str"` | 201 | 1 → 2 |
| `true` | 201 | 2 → 3 |
| `[]` | 201 | 3 → 4 |
| `null` | 400 | 4 → 4 |
| `{}` | 201 | 4 → 5 (`key-1786399662741`) |
| `{"name":"named-probe"}` | 201 | 5 → 6 (`named-probe`) |
| `{"name":"bad/name"}` | 400 | 6 → 6 |

The handler at v3.16.4 (`git show $(git rev-list -n1 v3.16.4):server.mjs`, i.e. `9e25160`) was, in full:

```js
let parsed;
try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }
const name = parsed.name || `key-${Date.now()}`;
const newKey = createKey(name);
return jsonResponse(res, 201, newKey);
```

So this is genuinely grandfathered. The `parsed === null` guard added by #360 is not a counterexample: `null` was the one input that received **no response at all** — `parsed.name` threw, the throw escaped the `async` handler unobserved by Node, and the socket was never answered or closed. Answering an unanswered request is not a request-shape change.

### Fact 2 — the key-name regex is NOT v3.16.4 behaviour, and was never authorized

The handler's `/^[A-Za-z0-9 ._-]{1,64}$/` name test does not exist at v3.16.4. It enters between `v3.17.1` and `v3.18.0`, in `879b40f` — *"fix: escape dashboard DB-sourced values + validate key names (#114) (#121)"*, 2026-05-31 — and has shipped in every release since. A name of `"my key ✓"`, or any name over 64 characters, was accepted at v3.16.4 and is a 400 today.

Re-derived tag by tag before merge (`git show $(git rev-list -n1 <tag>):server.mjs | grep -cF 'A-Za-z0-9 ._-'`), across all 51 tags: **absent** in every tag from `v1.0.0` through `v3.17.1`, **present** in every tag from `v3.18.0` (2026-06-01) through `v3.29.2` (2026-08-10).

ADR 0006 is dated 2026-05-20 with sign-off 2026-08-04. The regex therefore landed **after the snapshot it is frozen at, and between ADR 0006's drafting and its enforcement** — before the class-evidence gate existed in practice, not in defiance of a live one. That mitigates the authorship. It does not change the state.

### Why the two facts collide

The `#360:` block comment inside that same branch currently argues #383 must **not** be fixed:

> it is ANSWERED, so it is part of this grandfathered endpoint's v3.16.4 behaviour snapshot, and tightening it changes WHICH REQUESTS ARE ACCEPTED — a request-shape change that `ALIGNMENT.md:114` makes a new authorization request needing its own ADR.

Every clause is individually true. But the argument is being made **twelve lines above an unauthorized request-shape narrowing of exactly that kind**. "We must not move off the v3.16.4 request shape" is being cited by code that already moved off it.

This ADR exists because the honest resolution of that is not "so the rule doesn't matter" and not "so tighten freely" — it is that the rule was never checkable. Which is Consequence 4 below.

## Decision

### 1. Reject a non-object body with 400

`POST /api/keys` will require a JSON **object**. `42`, `"str"`, `true` and `[]` become `400` with the shape this handler already returns for a malformed body. `{}` continues to mint an auto-named key, unchanged — the documented path is untouched.

This is a **request-shape change on a grandfathered endpoint**, authorized here and nowhere else.

The grandfather exists so behaviour does not drift silently, not so that every defect present on one date is preserved forever. Weighed against it: this endpoint mints **credentials**, the accepting inputs are ones no correct client sends, and no consumer in the repo or on the wire sends them — the two consumers that exist, `ocp` (`-d "{\"name\": \"$2\"}"`) and `dashboard.html` (`apiPost("/api/keys", { name })`), both send an object, as does the governance probe in `scripts/b2-key-snapshot.mjs`. The behaviour is reachable only by a caller that is already malformed, and what it hands back is a working key.

**The changed-input set is closed by the JSON grammar, not sampled.** `JSON.parse`, called with no reviver on a body that parsed at all, returns exactly one of RFC 8259's six value productions — object, array, string, number, boolean, null. A body that does not parse is already answered 400 by the surrounding `catch`. `null` is already answered 400 by #360's guard and keeps that status and that message. The new guard admits exactly the object case. So the inputs whose behaviour changes are precisely `array | string | number | boolean` — the four forms measured above, every one of which mints a credential today.

### 2. Retroactively authorize the key-name regex, as of v3.18.0

The regex is correct on its merits — #114 was a dashboard-injection fix and the regex is what closes it at the source rather than at the render. It would have passed an ADR had one been asked for; the defect is procedural. It is authorized here, with its actual provenance recorded, rather than quietly re-baselined.

It is **not** re-opened for redesign by this ADR. Anyone wanting to widen or narrow the charset needs their own.

### 3. Correct the comment

The `#360:` block comment in the `POST /api/keys` branch must stop asserting the endpoint sits at its v3.16.4 snapshot. Under this ADR the scalar path is fixed and the regex is authorized, so the comment's job changes entirely: it should record what the endpoint accepts and under which authorization, not argue for inaction.

## Alternatives rejected

**Leave the scalar path as-is and authorize nothing.** This was the position the `#360:` comment took, and it was defensible while the endpoint was believed to be at its v3.16.4 shape. It is not, so the argument's premise is gone. Keeping a credential-minting path because a snapshot rule protects it, when the same rule is already being violated three lines away in the same handler, is not conservatism — it is an inconsistency that happens to favour inaction.

**Fix the scalar path with a broad predicate (`isJsonObject`).** Rejected for the reason #360 already recorded at this site: every predicate wide enough to be worth naming also captures inputs this change must not touch. State the requirement positively — the body must be a non-null, non-array object — rather than enumerating what is absent.

**Treat the regex as already grandfathered because it predates ADR 0006's sign-off.** Rejected. ADR 0006 grandfathers endpoints at their **v3.16.4 behaviour**, by its own words — not at their behaviour on the day it was signed. Reading it the other way would make the baseline a moving target defined by whenever anyone next looks, which is the failure mode the fixed date exists to prevent.

## Consequences

- **Two request-shape changes ship under this ADR**: one prospective (scalar → 400) and one retroactive (the regex). Both are cited as `Authorized by ADR 0017`, and the retroactive one names v3.18.0 as the release it actually took effect in, so the record does not imply it started today.
- **A caller POSTing a scalar body starts getting 400 instead of a key.** That is the point. Nothing in the repo does it, and any external caller doing it was receiving a credential it did not ask for by name.
- **The B.2 key-set snapshot does not move.** `docs/governance/b2-response-keys.json` records **response** key paths; this changes which **requests** are accepted. The snapshot's own probe for this endpoint sends `{ name: "b2-key-snapshot" }`, an object, so it is admitted before and after. The snapshot will not flag this change, and that is not a gap in the snapshot — it is the next point.
- **The grandfather has never been checkable on the request side, and that is how the regex shipped unnoticed for eleven releases.** #346 replaced a CHANGELOG grep with a wire-read snapshot precisely because reading prose could only ever see what an author chose to write down. The response side now has that. The request side does not: nothing anywhere records what each B.2 endpoint accepts, so a narrowing like the regex produces no signal at all — not a red test, not a snapshot diff, not a failed grep. **This ADR does not build that mechanism**, and says so rather than implying the hole is closed. It is tracked as a follow-up. The honest summary of the regex incident is not "someone skipped a step" but "there was no step to skip."
- **Provenance questions in this repo turn on CLONE DEPTH, not on lineage — and the difference decides which answer you get.** ⚠️ *Corrected after sign-off; see the note below.* Asking "when did this line enter?" from the maintainer's working checkout returns `c180987` (2026-07-27), which reads as "it was always there." That is a **shallow-clone artifact**: `.git/shallow` in that checkout contains exactly `c180987`, so history is truncated there, every pre-boundary line looks introduced at the boundary, and `git merge-base v3.16.4 origin/main` prints nothing because the ancestry connecting them was never fetched — note that this is a **fatal error on stderr with empty stdout**, not git reporting "no common ancestor", and the two are easy to confuse. In a full clone the same questions answer correctly and unremarkably — one root (`593d0dc`, 2026-03-16), `v3.16.4` a direct ancestor of `main` (177 commits back as of `eac7c39`), and `git log -S` naming `879b40f`. **Any provenance question in this repo must first establish whether the checkout is shallow** (`ls .git/shallow`, or `git rev-parse --is-shallow-repository`) and, if it is, be re-asked in a full clone or after `git fetch --unshallow`. `git log --all` is not the cure: it happens to surface `879b40f` in that checkout only because the tags dragged the objects in, and it would not have surfaced a commit no ref reached.

> **Post-sign-off correction (2026-08-11).** The signed draft's final Consequence read, verbatim:
>
> > **This is the second time a governance question turned on which git lineage was being read.**
> > `v3.16.4` and `main` have **no common ancestor** — the public history was recreated as a squashed
> > root at `c180987` (2026-07-27) and the 155-commit pre-history reachable from the old tags was
> > never grafted. `git log -S` on `main` reports the regex as present since the root, i.e. "always
> > there," which is false. Any provenance question in this repo must be asked with `git log --all`
> > and must state which lineage each side is on.
>
> Re-derived before merge in a full `git clone` of the same remote, that is not the case. `c180987`
> is an ordinary commit — *"docs: guard the asymmetric cache keys (#200); document the ltBoot fault
> lever (#197) (#207)"*, 2 files, 28 insertions, parent `f2f9058` — not a squashed root. The
> repository has a single root, `593d0dc`; `git merge-base $(git rev-list -n1 v3.16.4) origin/main`
> returns `9e25160`, i.e. v3.16.4 **is** an ancestor of `main`; and `git log -S` on `main` alone
> returns `879b40f` correctly. The symptom the draft recorded is real and was observed; the
> diagnosis was not. The corrected bullet above keeps the finding and replaces the mechanism.
> Applied here rather than silently, and flagged on the PR — revert this bullet to the wording
> quoted above if the original is preferred.
>
> The whole symptom was **reproduced from scratch**, which is what settles it: a fresh
> `git clone --depth=103` of the same remote lands its shallow boundary on `c180987` and then
> reports, byte-identically, a single root of `c180987`, `git log -S … origin/main` naming
> `c180987`, and `git merge-base` printing nothing. Note also that `155` is a real number in this
> repository — `git rev-list --count v3.16.4` is exactly 155 — which is part of why the account
> read as measured. It is the number of commits *up to* v3.16.4, not a quantity of missing
> pre-history; there are 231 commits before `c180987`.
>
> The draft also named `ocp-plugin/index.js` among the consumers that send an object to this
> endpoint. It does not reference `/api/keys` at all; the consumer list in Decision 1 is the
> measured one. The conclusion it supported is unchanged and slightly stronger.
