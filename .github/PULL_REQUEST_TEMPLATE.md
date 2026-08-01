# Pull Request

## Summary

<!-- One or two sentences describing the change and why it is in scope for OCP. -->

## Endpoint Class (REQUIRED)

Per `ALIGNMENT.md` and ADR 0006, every PR that touches a network-facing endpoint must declare its class. Pick the most specific applicable class (Hybrid covers PRs that touch both A and B):

- [ ] **Class A** — forwards a `cli.js` operation (e.g., `/v1/messages`, `/api/oauth/*`, or the Anthropic-side wire call inside `/usage`)
- [ ] **Class B** — extends an OCP-owned compatibility endpoint (per ADR 0006). Sub-bucket:
  - [ ] B.1 — OpenAI-compatibility surface (`/v1/chat/completions`, `/v1/models`)
  - [ ] B.2 — OCP-administrative surface (`/health`, `/dashboard`, `/sessions`, `/logs`, `/status`, `/settings`, `/api/keys*`, `/api/usage`, `/cache*`)
- [ ] **Hybrid** — touches both classes (e.g., `/usage` if the PR modifies both the Anthropic wire call AND the local synthesis layer). Both evidence sections below must be filled.
- [ ] **Not endpoint-touching** — refactor / docs / tooling that does not modify any request handler. Skip both evidence sections; explain in Summary.

## Claude Code Alignment Evidence (REQUIRED)

PRs with the relevant evidence section blank or unchecked will receive a `request changes` review and cannot be merged.

### If Class A

- [ ] **Corresponding `cli.js` reference.** I have identified the `cli.js` function and line range that performs the operation this PR forwards. Citation (format `cli.js:NNNN` or `cli.js vE4 <functionName>`):
  <!-- e.g. cli.js:18423-18467 (function: sendUserMessage)  -->

- [ ] **If `cli.js` does not perform this operation**, I have stated that explicitly below, because Rule 1 requires an absent grep hit to be declared. I have **not** offered `ALIGNMENT.md` Rule 2 as a justification: Rule 2 is a prohibition, not an authorization, and citing it as permission is a category error. On a genuine Class A operation an absent hit means Rule 2 puts the change out of scope and Rule 4 deletes it — this PR should be closed, not merged. Proxy layers do not invent endpoints. If the endpoint is in fact listed in `ALIGNMENT.md` § "Current Class B inventory", switch the class above and use the Class B section instead.
  <!-- Declaration of the absent hit, if applicable. Empty is fine when cli.js does perform the operation. -->

- [ ] **Commit message citations.** Every "Claude Code uses X" or "cli.js uses X" assertion in every commit of this PR is immediately followed by a `cli.js:NNNN` or `cli.js vE4 <functionName>` citation. I have verified this by rereading each commit message.

### If Class B

- [ ] **Authorizing ADR.** Cite the ADR number that authorizes the endpoint this PR modifies (e.g., "ADR 0006 — OpenAI shim scope"). For B.1 endpoints (`/v1/chat/completions`, `/v1/models`), this is ADR 0006. For grandfathered B.2 endpoints, this is "ADR 0006 (grandfathered as of v3.16.4)." For new B.2 endpoints, cite the endpoint's own authorizing ADR; if none exists, the PR cannot proceed — the authorizing ADR must be drafted and merged first.
  <!-- e.g., ADR 0006 -->

- [ ] **Specification citation.** For B.1 endpoints, link to the relevant section of OpenAI's `/v1/chat/completions` specification (https://platform.openai.com/docs/api-reference/chat/create), including the specific field or behaviour being implemented. For B.2 endpoints with their own ADR, cite the ADR section that specifies the behaviour. For grandfathered B.2 endpoints, `ALIGNMENT.md:114` and ADR 0006:39 give exactly two routes — say which one this PR takes: either **(a)** it is a behaviour-preserving refactor (request shape, response shape and semantics all unchanged; link the existing handler code being modified), or **(b)** it is a contract change authorized by **its own ADR**, merged with or before this PR. Note the dividing question is whether the field's documented *meaning* changes, not whether its current value is wrong: making a value truthful under an unchanged rule is route (a); changing the rule that determines it is route (b), even if the field name and type are untouched (ADR 0010 is the worked example of (b)).
  <!-- B.1 example: OpenAI chat/completions, `response_format` parameter, https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format -->
  <!-- B.2 example: ADR 00NN § "Behaviour" -->

- [ ] **No invention beyond the specification.** I confirm this PR does not introduce any field or behaviour not present in OpenAI's spec for the endpoint (B.1) or beyond the scope of the authorizing ADR (B.2). For grandfathered B.2 endpoints, I confirm the change is either behaviour-preserving (no contract drift) or authorized by its own ADR, per the route declared above. If something the user actually wants is not in the spec, the right answer is to close this PR and propose an upstream spec change or a new ADR.

## Type of change

- [ ] Bug fix (alignment with existing `cli.js` behavior, or with the cited spec / ADR for Class B)
- [ ] Feature (new `cli.js` behavior now surfaced through OCP, or new field already in OpenAI's spec for Class B)
- [ ] Refactor (no wire-level behavior change)
- [ ] Deletion (unalignable feature removal per `ALIGNMENT.md` Unalignable Policy)
- [ ] Documentation / governance

## Reviewer checklist

Reviewers: this section is for you, not the author. Do not approve until every box is checked.

- [ ] If Class A, I opened `cli.js` at the cited line range and confirmed the operation matches. If Class B, I opened the OpenAI spec at the cited section (B.1) or the authorizing ADR (B.2) and confirmed the behaviour described in this PR matches the cited reference.
- [ ] I ran (or confirmed CI ran) `.github/workflows/alignment.yml` and it passed.
- [ ] I am not the commit author of any commit in this PR (Iron Rule 10).
- [ ] I confirmed the declared class myself against `ALIGNMENT.md` § "Current Class B inventory" rather than taking the author's word for it. A misdeclared class means the wrong evidence section was filled and the PR is not reviewable as submitted.
- [ ] If the PR is Class A with no `cli.js` citation, I did **not** accept `ALIGNMENT.md` Rule 2 as the justification. Rule 2 is a prohibition, not an authorization; an absent hit on a genuine Class A operation closes the PR (Rules 2 and 4). If the endpoint is in the Class B inventory, I asked the author to reclassify instead.
- [ ] If the PR is Class B, I confirmed an authorizing ADR exists and is cited. For a grandfathered B.2 citation, I confirmed the change really is behaviour-preserving — specifically that the field's documented meaning is unchanged, not merely that its value is now correct. A change to the rule that determines a value is a contract change and needs its own ADR (`ALIGNMENT.md:114`, ADR 0006:39), however small the diff.
- [ ] If the PR is Class B and adds a new endpoint or new method, I confirmed the authorizing ADR lands in the same merge or before this PR.

## Related

- `ALIGNMENT.md` Rule(s) invoked: <!-- e.g. Rule 3, or Rule 3 (Class B mapping) -->
- Authorizing ADR (Class B only): <!-- e.g. ADR 0006 -->
- Related issue / prior PR: <!-- #NNN -->
- Historical lesson reference (if relevant): <!-- e.g. 2026-04-11 drift, b87992f -->

### User-visible change self-check (铁律第五律 5.3)

- [ ] This PR has user-visible changes → README has corresponding documentation (paste diff link or line range)
- [ ] This PR has no user-visible changes → stated "no user-visible change" in summary above

Reviewers: if "user-visible" is checked but README diff is empty, block merge (per 5.3 reviewer gate).

### Privacy self-check (for PUBLIC repos) — Iron Rule adjacent

- [ ] This PR does not introduce real names, nicknames, or handles that identify specific individuals. All references use role-based terms (`project maintainer`, `contributor`, `user`, `reviewer`).
- [ ] This PR does not introduce literal personal paths (`/Users/<username>/`, `/home/<username>/`). Uses `$HOME/` or `~/` instead.
- [ ] This PR does not introduce personal machine hostnames. Uses role-based names or generic descriptors.
- [ ] This PR does not introduce personal email addresses beyond automated placeholders like `noreply@<vendor>.com`.

Reviewers: if any of the above is violated and the repo is PUBLIC, block merge and request scrub.
