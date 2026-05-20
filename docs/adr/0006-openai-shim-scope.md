# 0006 — OpenAI Shim Scope: Class A vs Class B Endpoints

- **Date**: 2026-05-20
- **Status**: Proposed — owner reviewing
- **Authors**: project maintainer (with AI drafting assistance)
- **Related**: `ALIGNMENT.md` (the constitution); ADR 0002 (Alignment Constitution provenance, PR #20, commit 2853088); PR #99 by external contributor (triggering incident — OpenAI `response_format` honoring on `/v1/chat/completions`)

## Context

`ALIGNMENT.md` was drafted in the aftermath of the 2026-04-11 drift (commit `b87992f` — fabricated `/api/oauth/usage` endpoint) and ratified in PR #20 / commit 2853088. Its five Rules are written in the language of a one-to-one proxy: Rule 1 (Grep First), Rule 2 (No Invention), Rule 3 (Match the Implementation), Rule 4 (Unalignable Features Are Deleted), Rule 5 (Cite Line Numbers in Commits). All five anchor explicitly on `cli.js` as the golden reference. This is correct and binding for the endpoints OCP was originally designed to forward — `/v1/messages`, `/api/oauth/*`, and the rate-limit-header extraction path that backs `/usage` — because for those, `cli.js` is the literal wire authority and any deviation is a drift risk.

OCP also exposes a second class of endpoint that the constitution does not currently distinguish: **OpenAI-compatible surface** that exists so non-Claude-Code clients (Honcho, OpenWebUI, OpenAI SDK consumers, BYO scripts) can talk to claude via OCP. The flagship is `/v1/chat/completions`, which translates between OpenAI's request/response schema and `cli.js`'s native protocol. `cli.js` never speaks OpenAI's wire format — by construction it cannot, because OpenAI and Anthropic are different vendors with different protocols. There is no `cli.js:NNNN` to cite for OpenAI's `messages[].role` field handling, OpenAI's streaming `delta` shape, OpenAI's `stop` event names, or OpenAI's `response_format` parameter. The protocol authority for these is OpenAI's published specification, not `cli.js`.

The structural gap surfaced when PR #99 (external contributor `jaekwon-park`) added support for the OpenAI `response_format` request field on `/v1/chat/completions`. A strict reading of Rule 2 ("OCP must not introduce request fields that are not present in `cli.js`") blocks the PR. But the same strict reading also blocks the existence of `/v1/chat/completions` itself — every OpenAI-shaped field on that endpoint is, by definition, not in `cli.js`. The endpoint has been in OCP since before the constitution was written and is used by real downstream consumers. The constitution and the endpoint cannot both be correct under the current reading.

The 2026-04-11 drift remains the cautionary tale that drove the constitution and remains binding. The drift was not "OCP exposed an endpoint that wasn't in `cli.js`" — it was specifically "OCP claimed to forward `cli.js`'s `/api/oauth/usage` call when no such call exists in `cli.js`." That is a Class A failure mode: a forwarding endpoint that lied about what it was forwarding. The fix to that failure mode (Rules 1, 2, 3, 5; CI blacklist; reviewer gate) was correct then and is correct now. This ADR does not relitigate that decision and does not soften Rules 1–5 for the class of endpoint they were designed to discipline.

What this ADR does is acknowledge that OCP has two classes of endpoint, and that the discipline that fits Class A does not fit Class B without distortion. Class B needs its own anchor (OpenAI's specification) and its own authorization gate (an ADR per endpoint), so contributors know exactly which rule set applies to their PR and so Class B never becomes a backdoor for "OCP can do anything OpenAI-shaped."

## Decision

Introduce an explicit two-class taxonomy of OCP endpoints:

- **Class A — `cli.js`-mirror endpoints.** Endpoints that exist because `cli.js` performs the equivalent operation and OCP forwards, observes, or multiplexes that operation. Rules 1–5 of `ALIGNMENT.md` apply verbatim. The citation requirement is `cli.js:NNNN` (or `cli.js vE4 <functionName>`).

- **Class B — OCP-owned compatibility endpoints.** Endpoints that exist because OCP itself surfaces them, with no `cli.js` analogue. They fall into two sub-buckets:
  - **B.1 — OpenAI-compatibility surface.** Endpoints implementing OpenAI's published API contract so non-Anthropic clients can use OCP. The protocol authority is OpenAI's specification.
  - **B.2 — OCP-administrative surface.** Endpoints that exist purely to operate the proxy itself (health, dashboard, key management, cache control). The authority for these is the ADR that authorized the endpoint's existence.

For Class B endpoints, the citation requirement shifts from `cli.js:NNNN` to **(a)** the relevant specification section (OpenAI spec section for B.1, or the authorizing ADR for B.2) **and (b)** the ADR that authorized the endpoint's existence in the first place.

### Grandfather provision for existing B.2 inventory

ADR 0006 retroactively authorizes the existing B.2 endpoints listed in the inventory table below, **frozen at their current behaviour as of v3.16.4**. This is a one-time grandfather provision intended to avoid a 12-ADR back-fill burden for endpoints that have existed in OCP since before any constitutional governance was written.

The grandfather provision is narrowly scoped:

- It covers only the B.2 endpoints enumerated in the inventory table as of this ADR's merge date.
- It freezes those endpoints at their **current behaviour**. Any change to the request shape, response shape, or semantics of a grandfathered B.2 endpoint is treated as a new authorization request and requires either (a) a behaviour-preserving refactor PR with no contract change, or (b) its own ADR.
- It does **not** authorize new B.2 endpoints. Any new B.2 endpoint, or any new method on a grandfathered B.2 endpoint, requires its own ADR before merge.
- It does **not** extend to B.1 (OpenAI-compat) endpoints. B.1 endpoints are bounded by OpenAI's published specification, not by a behaviour snapshot — there is no grandfather equivalent for them.

The structural intent is: take the one-time hit of declaring "current B.2 surface is authorized" cleanly, then make every future addition pay the ADR-per-endpoint cost. This prevents Class B from becoming a backdoor for general OCP-owned-surface invention while not blocking the present ADR on twelve back-fill PRs.

### Current Class B inventory (enumerated from `server.mjs`)

The following endpoints exist today in `server.mjs` and are Class B (no `cli.js` analogue):

| Endpoint | Method | Sub-bucket | Authorizing ADR |
|---|---|---|---|
| `/v1/chat/completions` | POST | B.1 (OpenAI-compat) | ADR 0006 |
| `/v1/models` | GET | B.1 (OpenAI-compat) | ADR 0006; content sourced from `models.json` per ADR 0003 |
| `/health` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/dashboard` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/sessions` | GET, DELETE | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/logs` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/status` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/settings` | GET, PATCH | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/keys` | GET, POST | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/keys/:id` | DELETE | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/keys/:id/quota` | GET, PATCH | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/usage` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/cache/stats` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/cache` | DELETE | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |

For Class A reference, the current Class A inventory is `/v1/messages` (forwarded directly to `api.anthropic.com/v1/messages`) and the OAuth bearer / rate-limit-header machinery used by `handleUsage()` (which calls `https://api.anthropic.com/v1/messages` to extract `anthropic-ratelimit-unified-*` headers, per the in-file comment at line 845–849). The `GET /usage` endpoint surface itself is Class B (administrative augmentation: it adds `proxy:` and `models:` blocks not present in any upstream API), but the data fetch underlying it is Class A — see "Hybrid endpoints" below.

### Hybrid endpoints

`/usage` is a hybrid: the wire call out to `api.anthropic.com/v1/messages` is Class A and must continue to cite `cli.js`; the local synthesis on top (`proxy:` stats block, `models:` snapshot, response shape) is Class B and is authorized by this ADR. Any future change strictly to the wire-call layer is Class A; any change strictly to the synthesis layer is Class B. A PR touching both must satisfy both citation requirements.

## What does NOT change

The following continue to apply verbatim and are not weakened by this ADR:

- **Rules 1, 2, 3, 4, 5 of `ALIGNMENT.md`** for all Class A endpoints. The 2026-04-11 drift discipline is unchanged. Class A PRs still require `cli.js:NNNN` citations, still must match `cli.js`'s wire format byte-for-byte, and still face the Unalignable Policy if the citation cannot be produced.
- **CI blacklist** (`.github/workflows/alignment.yml`). The known-hallucinated token list (currently `api.anthropic.com/api/oauth/usage`) continues to be greppable-and-failable on every PR.
- **Reviewer gate** (CLAUDE.md hard requirements + Iron Rule 10). Implementation author may not self-approve; a fresh-context reviewer opens `cli.js` at the cited lines for Class A PRs.
- **Annual Alignment Audit** on 11 April. The Class A audit (re-verify each `server.mjs` Class A reference against the pinned `cli.js` SHA-256) continues unchanged.
- **Unalignable Policy.** A Class A endpoint that cannot be traced to a `cli.js` reference is still deleted, not deprecated.
- **Historical Lesson section in `ALIGNMENT.md`.** The 2026-04-11 drift remains the named cautionary incident, with commit SHAs intact.

## What additionally applies to Class B

The following are new and apply only to Class B endpoints:

1. **OpenAI specification as protocol authority (B.1).** The OpenAI compatibility surface follows OpenAI's published `/v1/chat/completions` specification (https://platform.openai.com/docs/api-reference/chat/create) — not OCP imagination, not "OpenAI probably does X," not generalization from adjacent OpenAI endpoints. The same anti-invention discipline that Rule 2 imposes for `cli.js` applies, with OpenAI's spec substituted as the reference.

2. **ADR-authorized endpoint existence.** Any new Class B endpoint, or any new Class B endpoint method, requires its own ADR before merge. The grandfather provision above covers existing B.2 inventory only. An "ADR-less" Class B endpoint added after this ADR merges is itself an alignment finding and is subject to deletion under a Class B equivalent of the Unalignable Policy (see Rule 4 mapping in `ALIGNMENT.md`'s new section).

3. **Class B citation format.** Class B PRs cite (a) the relevant specification section and (b) the authorizing ADR. Example for B.1: "OpenAI `chat/completions` API, `response_format` parameter (https://platform.openai.com/docs/api-reference/chat/create), authorized by ADR 0006." Example for B.2: "Authorized by ADR 0006 (grandfathered)" for grandfathered endpoints, or "Authorized by ADR 00NN" for endpoints with their own ADR.

4. **Class B audit cadence.** Class B endpoints are audited annually alongside the Class A audit. B.1 endpoints are audited against OpenAI's current `/v1/chat/completions` specification snapshot. B.2 endpoints (grandfathered or ADR-specific) are audited against their authorizing ADR — for grandfathered endpoints, the audit verifies the endpoint behaviour still matches its v3.16.4 snapshot; for ADR-specific endpoints, the audit verifies behaviour still matches the ADR. The B.1 specification pin lives in `docs/openai-compat-pin.md` (to be created alongside the first B.1 audit; not a prerequisite for this ADR to land).

5. **Reviewer expectation.** The fresh-context reviewer for a Class B PR opens the cited OpenAI spec section (B.1) or the authorizing ADR (B.2) instead of opening `cli.js`. The "I am not the commit author" rule and the "explicit approval comment naming the verified reference" rule continue.

## Consequences

**Positive**

- PR #99 becomes mergeable with a one-line scope declaration ("Class B — extends `/v1/chat/completions` per ADR 0006") plus the existing alignment-evidence section adapted to Class B citation format. The structural ambiguity that blocked it is removed.
- Future Class B contributors have a clear template and a defensible scope: "extend `/v1/chat/completions` for an OpenAI-spec field that's already in OpenAI's spec" is a well-formed PR; "add a new OCP-invented field that looks OpenAI-shaped" is not, and the same anti-invention discipline that protects Class A protects Class B.
- The Class A surface is structurally unchanged. Reviewers reading the new `ALIGNMENT.md` see a clean Class A regime with all five Rules intact, plus an enumerated and explicitly scoped Class B carve-out.
- The administrative endpoint surface (B.2) is no longer in a "is this even allowed under the constitution?" limbo. The grandfather provision cleanly authorizes the current inventory; new B.2 endpoints must earn their ADR.

**Negative**

- OCP now maintains a second alignment surface. OpenAI's `/v1/chat/completions` specification is also a moving target (OpenAI ships changes more than once per year, including breaking ones), so the B.1 audit has real work attached.
- The grandfather provision freezes the current B.2 behaviour. If a grandfathered B.2 endpoint has a latent bug or undesirable behaviour, "fixing" it is a contract change and now requires an ADR (or a behaviour-preserving refactor). This is intentional friction to prevent silent contract drift.
- Contributors must now choose Class A or Class B on every PR. Some will misclassify. The PR template's required Class A/B radio (see PR template update) and the reviewer's spec-or-cli verification step are the structural counter-measures.

**Mitigations**

- The Class B inventory is small (currently 14 endpoints) and is enumerated explicitly in `ALIGNMENT.md`. New entries require an ADR per item 2 above, so the inventory cannot grow silently.
- Anthropic-side change frequency (which drives Class A audit cost) is structurally higher than OpenAI's `chat/completions` shape, which has been stable across multiple OpenAI API versions. The marginal B.1 audit cost is low. The grandfathered B.2 audit cost is also low — most of those endpoints have not changed in months.
- The B.1 specification pin in `docs/openai-compat-pin.md` lets the audit anchor on a specific OpenAI spec snapshot, the same way the Class A pin anchors on a specific `cli.js` SHA-256. Drift detection then works the same way for both classes.

## Historical Lesson — explicit non-relitigation

This ADR does not relitigate the 2026-04-11 drift. The drift commit `b87992f` was Class A — it claimed `cli.js` forwarded a call that `cli.js` did not in fact make. The fix (constitution + CI blacklist + reviewer gate) was correct and remains binding for Class A. This ADR carves out Class B because the discipline that fits Class A does not fit a class of endpoint where `cli.js` is not the wire authority — not because the discipline was wrong, and not because the drift lesson is any less load-bearing.

A reviewer or future maintainer reading this ADR should not infer: "OCP relaxed its alignment rules." The Class A regime is structurally identical to the version that shipped in PR #20. What changed is that the constitution now names the scope of that regime precisely (the class of endpoint for which `cli.js` is the wire authority) instead of implicitly applying it to every endpoint, including ones the regime was never designed for.

## Alternatives considered

**(a) Refuse Class B as a category; close PR #99 and delete `/v1/chat/completions`.** This would resolve the structural ambiguity by enforcing Rule 2 maximally — if `cli.js` doesn't speak OpenAI's protocol, neither does OCP. Rejected: there is an existing user base on the OpenAI-compat surface, the surface is genuinely useful (it is OCP's bridge to non-Claude-Code agents), and deletion would be a load-bearing user-facing breakage in service of a doctrinal point that the constitution was never designed to make. The constitution was a response to the 2026-04-11 forwarding drift, not a charter against any OCP-owned surface.

**(b) Soften Rule 2 to "OCP must not introduce surface area not present in `cli.js` OR not authorized by an ADR."** This is the obvious diff and would unblock PR #99 with the smallest possible textual change. Rejected because it loses the precision that Class A needs. A combined Rule 2 means a Class A reviewer has to read the PR description twice to figure out which authority applies. The Class A/B split makes the question explicit at the PR-template level (the author picks the class) and at the reviewer level (the reviewer opens the appropriate reference). The cost of the split is one new section in `ALIGNMENT.md`; the benefit is no ambiguity in either class.

**(c) Move `/v1/chat/completions` and all OpenAI-compat surface out of OCP into a separate "ocp-openai-shim" repository.** This would cleanly resolve the scope question by moving Class B out of OCP entirely. Rejected as premature: the maintainer is one person, the OpenAI-compat surface today is a single endpoint plus its support, and the operational cost of two repositories (separate releases, separate CI, separate version coordination) exceeds the cost of one constitution with two named classes. If the OpenAI-compat surface ever grows to the size where a separate repo is justified, ADR 0006 is the natural pivot point — at that future date, the carve-out becomes a separation.

**(d) Twelve-ADR back-fill for the existing B.2 inventory before this ADR can merge.** Considered and rejected on cost grounds. Each back-fill ADR would be a short paragraph explaining what an existing endpoint does and why it's allowed; the educational value is low and the merge friction is high (12 PRs through the reviewer gate). The grandfather provision above achieves the same authorization outcome in one paragraph, while still requiring an ADR for any future B.2 endpoint. The trade-off: grandfathered endpoints are not individually documented to ADR-depth. Mitigation: the inventory table in `ALIGNMENT.md` lists every grandfathered endpoint by path and method, so the audit surface remains explicit.
