@AGENTS.md
@~/.cc-rules/AGENTS.md

# OCP Project Session Instructions

> **WARNING — READ BEFORE WRITING ANY CODE IN THIS REPO**
>
> Before touching `server.mjs` or any network-facing surface, read [`./ALIGNMENT.md`](./ALIGNMENT.md) in full. The constitution is binding. Non-compliant commits are reverted.

---

## Before starting any task

1. Read `./ALIGNMENT.md`. Internalize the five Rules, the scope they are declared under (`ALIGNMENT.md:17` — Class A only), and the 2026-04-11 drift lesson.
2. Run `/dev-start <task description>` to get a pre-flight plan that incorporates the iron rules, `SKILL_ROUTING.md`, this file, and `ALIGNMENT.md`.
3. If the task touches `server.mjs`, classify the change (next section) and locate **that class's** reference — `cli.js` for Class A, the OpenAI specification section for B.1, the authorizing ADR for B.2 — **before** drafting any code. No code is written ahead of the evidence.

---

## Classify the change first: Class A or Class B

`ALIGNMENT.md`'s five Rules are **not** universal. `ALIGNMENT.md:17` scopes Rules 1–5 to **Class A operations** — the `cli.js`-mirror surface. `server.mjs` also serves a **Class B** surface that OCP owns outright, where `cli.js` is not the wire authority and the governing document is an ADR. Which class the change falls in is therefore the *first* decision, and it determines which evidence the next section demands.

**Classification is a table lookup, not an argument.** Class B is a closed, enumerated inventory in `ALIGNMENT.md` § "Current Class B inventory", plus the Hybrid note immediately after it (`ALIGNMENT.md:135`, which is where `/usage` lives — it is not in the table). If the handler you are touching is listed there, it is Class B. You do not get to reclassify an endpoint by arguing for it, and you do not get to declare new surface Class B to avoid a `cli.js` citation — new Class B surface needs its own ADR (below).

| Class | Surface | Authority | Citation |
|---|---|---|---|
| **A** | `cli.js`-mirror: inbound and outbound `/v1/messages`, the OAuth bearer machinery, the Anthropic wire call inside `/usage`. OCP forwards, observes, or multiplexes something `cli.js` already does. | `cli.js` at the `ALIGNMENT.md` audit pin. Rules 1–5 apply verbatim. | `cli.js:NNNN` or `cli.js vE4 <functionName>` |
| **B.1** | OpenAI-compatibility: `/v1/chat/completions`, `/v1/models`. `cli.js` cannot speak OpenAI's wire format, by construction. | OpenAI's published `/v1/chat/completions` specification, plus ADR 0006. | Spec section URL + ADR 0006 |
| **B.2** | OCP-administrative: `/health`, `/dashboard`, `/sessions`, `/logs`, `/status`, `/settings`, `/api/keys*`, `/api/usage`, `/cache*`. Exists to operate the proxy itself. | The ADR that authorized the endpoint. The endpoints listed here are grandfathered by ADR 0006 at their v3.16.4 behaviour. | Authorizing ADR number |
| **Hybrid** | `/usage` — Class A wire call under a Class B synthesis layer. | Both, per layer touched. | Both, per layer touched |

Adding a **Class B** endpoint, or a new method on an existing Class B one, is not covered by any row: it requires its own ADR merged with or before the PR, per `ALIGNMENT.md` § "New Class B endpoint procedure" (`ALIGNMENT.md:157`). That procedure is Class B only. A new **Class A** forwarding route — `ALIGNMENT.md:17` contemplates "any future operations OCP forwards from `cli.js` to Anthropic" — is governed by Rules 1–5 and needs a `cli.js` citation, not an ADR. An ADR is never a substitute for a `cli.js` citation on Class A surface.

A `server.mjs` change that touches no request handler at all (an internal refactor, a comment, a constant) has no row and needs no class evidence — declare "not endpoint-touching" and say so in the PR summary, as the PR template's fourth option already allows. Requirements 2 and 3 below still apply.

This table is a navigation aid so the first decision can be made without leaving this file. `ALIGNMENT.md` § "Scope Clarification: OCP-Owned Compatibility Endpoints (Class B)" and ADR 0006 are the full text, and `ALIGNMENT.md` governs on any conflict (`ALIGNMENT.md:3`).

---

## Hard requirements for `server.mjs` changes

Every PR that modifies `server.mjs` must satisfy all three of the following. A PR missing any one of them is blocked from merge.

1. **Evidence for the declared class.** Declare the class from the table above, then supply that class's evidence in both the commit message and the PR body.

   - **Class A** — the corresponding `cli.js` function name and line range, as `cli.js:NNNN` or `cli.js vE4 <functionName>`.

     If the grep does not hit, declare that: Rule 1 makes an absent hit a finding in its own right. But do **not** offer "scope justified under Rule 2." **Rule 2 is a prohibition, not an authorization**, and citing it as permission is a category error — recorded in the #193 thread as an independent-review finding the author accepted, which held that PR until the citation was corrected. On a genuine Class A operation an absent hit means Rule 2 puts the feature out of scope and Rule 4 deletes it: the PR should be closed. The one other legitimate outcome is that the classification was wrong, so check the Class B inventory before concluding anything.

   - **Class B.1** — the OpenAI specification section covering the field or behaviour, plus ADR 0006. A `cli.js` citation is neither required nor meaningful here. The anti-invention discipline still binds with OpenAI's spec substituted for `cli.js`: a field OpenAI's spec does not define is as out of scope as a fabricated endpoint is in Class A.

   - **Class B.2** — the authorizing ADR. Which one, and how much work it is, follows from what the change does. The dividing question is **not** "is the current value wrong?" — it is **"does the field's documented meaning change?"**
     - **Behaviour-preserving** — request shape, response shape and semantics all unchanged. This includes a fix that makes a field's *value* truthful **while the rule that determines it stays the same**: the field already promised this, and the code was not delivering it. Worked example: the #193 `stats.activeRequests` leak — the field always meant "requests in flight" and was simply over-reporting, so the field set was unchanged, the values were made truthful, and no new ADR was needed. Cite `Authorized by ADR 0006 (grandfathered as of v3.16.4)`, state that the contract is unchanged, and say which of the two routes you are taking. One line, and it covers most B.2 work.
     - **Contract change** — request shape, response shape, or semantics change, *including* a change to the rule that determines a field's value even when the field name and type are untouched. `ALIGNMENT.md:114` and ADR 0006:39 / :109 make this a new authorization request: it needs its own ADR, merged with or before the PR, cited alongside ADR 0006. Worked example: ADR 0010 redefined *when* `/health` and `/status` report `degraded` — same field, same type, new rule — and needed its own ADR. If you are tempted to file that under "making the value truthful", it is this bullet, not the one above.
     - **Additive read-only field on a grandfathered endpoint** — a response gaining a field *is* a response-shape change, so the bullet above would demand its own ADR. ADR 0012 supplies that authorization once, standing, for changes meeting all six of its conditions: additive only (nothing removed, renamed, retyped, or re-ruled), read-only, no new endpoint or method, reporting on what the endpoint already reports on, field names stated in the PR body **and** the CHANGELOG, B.2 only. Cite `additive under ADR 0012` and list the field names. Miss any condition and it is the bullet above — in particular, a field that reports on a *new subject* through a convenient existing endpoint is new surface wearing an additive costume, and needs its own ADR.
     - **New Class B endpoint, or a new method on a grandfathered one** — its own ADR, always.

   - **Hybrid** — satisfy the Class A requirement for the wire-call layer and the Class B requirement for the synthesis layer, for whichever layers the PR actually touches.

2. **CI blacklist pass.** The `alignment.yml` workflow must pass. The workflow greps `server.mjs` for known-hallucinated tokens (currently blocking `api.anthropic.com/api/oauth/usage`) and fails the build on any hit. New tokens are added via PR amendment to `alignment.yml`; removing entries requires an `ALIGNMENT.md` amendment PR. Do not suppress the workflow. Note its limit: the blacklist is a fixed-string grep and cannot tell a correctly-cited PR from a plausibly-worded one. It catches the 2026-04-11 drift tokens, not a wrong authority. Requirement 3 is the only gate that does that.

3. **Independent reviewer (Iron Rule 10).** The implementation author may not self-approve. A separate reviewer — human or a subagent spawned with a fresh context — must read the diff, **independently confirm the declared class against the `ALIGNMENT.md` inventory table** rather than taking the author's word for it, open the reference that class demands, and explicitly approve:
   - Class A → open `cli.js` at the cited lines.
   - Class B.1 → open the cited OpenAI specification section.
   - Class B.2 → open the authorizing ADR; if the citation is the ADR 0006 grandfather clause, confirm the change really is behaviour-preserving — specifically that the field's documented *meaning* is unchanged, not merely that its value is now correct.
   - Not endpoint-touching → confirm the diff genuinely touches no request handler. This is the cheapest class to declare, so it is the one most worth checking.

   A review comment that does not name the reference it opened is not a valid approval. Neither is one that accepts a Rule 2 argument in place of a citation.

---

## Iron rules in force

This repo operates under the CC Development Iron Rules (CC 开发铁律) v1.3. Three rules are load-bearing for OCP work:

- **Iron Rule 10 (Code Review).** Every implementation phase has an independent reviewer. Self-review does not count. See `server.mjs` hard requirement #3 above.
- **Iron Rule 11 (Incremental Diff Review).** Non-trivial work is split into the minimum reviewable unit — one PR per layer per severity. `ALIGNMENT.md`, `CLAUDE.md`, the PR template, and the CI workflow are therefore shipped as the same constitutional PR (they are one layer: governance), but any subsequent `server.mjs` remediation lands as its own PR.
- **Iron Rule 12 (Pre-Brainstorm Prior-Art Search).** Before proposing any new endpoint or header, search GitHub, Anthropic docs, and the `cli.js` bundle. For OCP specifically, which search is decisive depends on the class: `grep cli.js` for Class A (an absent hit means Rules 2 and 4 apply and the feature is out of scope), OpenAI's published specification for B.1, and `docs/adr/` for B.2. Searching only `cli.js` for a Class B change answers a question nobody asked.

The full iron rules are at `~/.claude/CC_DEV_IRON_RULES.md` (symlinked from the cc-rules repo on the maintainer's workstations). Load them into session context with `/cc-rules` when needed.

---

## Skills relevant to this repo

- `/dev-start` — pre-flight planning, always first.
- `/cc-rules` — load the iron rules into context.
- `/agent-dispatch` — pick the correct model (opus for design and review, sonnet for straightforward edits, haiku for mechanical chores) before spawning any subagent.
- `/cc-mem search <keyword>` — look up cross-machine memory for prior decisions, especially prior drift incidents.

---

## Commit message conventions

- Subject line uses Conventional Commits (`fix:`, `feat:`, `docs:`, `refactor:`, `chore:`).
- Any assertion of the form "Claude Code uses X" or "cli.js uses X" in the body must be immediately followed by a citation in the form `cli.js:NNNN` or `cli.js vE4 <functionName>`. CI performs a soft check for this pattern on all commits in the PR.
- Co-author trailer is required for LLM-assisted commits (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`).

---

## Project-level escalation

If a design decision cannot be resolved by reference to `ALIGNMENT.md` and the change's class authority — `cli.js` (A), OpenAI's specification (B.1), or the authorizing ADR (B.2) — escalate to the project maintainer via `/cc-chat` rather than guessing. Silent guessing is what produced the 2026-04-11 drift. Citing an authority that does not govern the surface you are touching is a quieter version of the same failure.

---

## Release kit overlay (CC 开发铁律 第五律 5.5)

This project's overlay per iron rule v1.4's 5.5. Machine-checkable declaration.

```yaml
release_kit:
  version_source: package.json
  changelog: CHANGELOG.md
  release_channel:
    type: github-release
    tag_format: v{semver}
    auto_create_on_tag_push: true   # via .github/workflows/release.yml
  docs_source: README.md
  resource_lists:
    - name: Available Models table
      location: README.md § "Available Models"
      source_of_truth: models.json
    - name: API Endpoints table
      location: README.md § "API Endpoints"
    - name: Environment Variables table
      location: README.md § "Environment Variables"
  new_feature_doc_expectations:
    - new CLI subcommand → README § "All Commands" + usage example
    - new env var → README § "Environment Variables" table
    - new auto-sync / hook → dedicated §, must document trigger + manual invocation + opt-out + any bootstrap quirk
    - new endpoint → README § "API Endpoints" table + any relevant Config/Troubleshooting §
    - new file / SPOT / schema → Architecture or contributor § with link
  bootstrap_quirk_policy:
    - any one-time migration quirk → README § "Troubleshooting"
  governance_audits:
    # ADR 0012 grants a STANDING authorization for additive read-only fields on
    # grandfathered Class B.2 endpoints, and names its own failure mode: "surface
    # growing one 'obviously fine' field at a time". Condition 5 already puts the
    # field names in the PR body and the CHANGELOG — but nothing ever reads them,
    # which is the state #288 found in the first place. This is the read.
    #
    # KNOWN BLIND SPOT, stated so nobody mistakes a green result for coverage:
    # this sweep finds only additions whose author COMPLIED with condition 5 and
    # wrote the marker. A field added with no marker — which is the exact shape of
    # the four pre-#288 additions — produces "none this cycle", a POSITIVE-looking
    # result for the case this is least able to see. It instruments the compliant
    # path; it does not detect silent growth. Detecting that needs a per-release
    # record of each B.2 endpoint's actual response key set, diffed across
    # releases, which is real machinery and is deliberately not built here.
    # Both defects below were found on the sweep's FIRST real run (v3.29.0, #337)
    # and pushed the count in OPPOSITE directions, which is why the how: below is
    # this specific and not just "grep for the marker":
    #
    #   case-sensitive grep   UNDER-count   a real field vanished from the audit
    #   counts its own prose  OVER-count    total permanently +1
    #
    # The under-count is the dangerous one and it fires on the COMPLIANT path: the
    # author wrote the marker exactly as condition 5 requires, opened a sentence
    # with it, and a literal `grep` missed the capital A. It was caught only
    # because a reviewer happened to re-run the grep with different flags. That is
    # not a control. See #338.
    - name: ADR 0012 additive-field sweep
      when: every release, during the release_kit walk
      how: |
        Count ENTRIES carrying the marker, not raw occurrences:

          grep -inE 'additive under \[?ADR[^0-9]{0,10}0012' CHANGELOG.md

        Then subtract by inspection any hit that is META-TEXT — a line describing
        the sweep mechanism necessarily quotes the marker it greps for. A field
        entry names an endpoint and a field; meta-text does not. Read every hit;
        do not report the raw number.

        Do the same over the section being dated (this cycle) and over the whole
        file (cumulative).

        Why the pattern is shaped like that, since a plain substring was tried
        first and failed twice on the SAME axis: condition 5 requires the marker,
        not a spelling. The literal `additive under ADR 0012` finds only 2 of the
        5 spellings that comply with it. Missed, and not hypothetically — the
        markdown-link form is already used 10 times elsewhere in this repo:

          additive under [ADR 0012](docs/adr/0012-….md)     <- link form
          **Additive under [ADR 0012](….md).**              <- link + bold + capital
          additive under ADR&nbsp;0012                      <- non-breaking space

        Case-insensitivity covers the sentence-initial capital; `\[?` covers the
        link form; `[^0-9]{0,10}` covers whatever separates "ADR" from "0012".

        HONEST LIMIT, because this is the second narrowing of the same grep and
        that pattern usually means the mechanism is wrong: a substring or regex
        match CANNOT be complete over the space of ways to write a reference in
        prose. What makes it acceptable here rather than in a security control is
        that there is no adversary — the author is complying — and the variation
        space is bounded by markdown conventions rather than open.

        >> THE STOPPING RULE BELOW HAS ALREADY FIRED. Read this before touching
        >> the pattern. <<

        The rule was: if a THIRD compliant spelling is found to be missed, stop
        widening. Within one review round of writing it, a reviewer constructed
        twelve spellings and this pattern got 7. The third miss is bold wrapped
        AROUND the reference:

          additive under **[ADR 0012](docs/adr/0012-….md)**

        `\[?` handles bold outside the whole phrase but not this, and the repo
        already contains `authorized by **[ADR 0010](…)**` — an authorization
        sentence about a grandfathered B.2 change, which is the exact slot an
        ADR 0012 marker occupies. Census of reference forms in CHANGELOG+README:
        bare link 12, bold-wrapped 1. A real minority risk, not the house style.

        So: capital (round 1) -> link (round 2) -> bold-wrapped (round 3).
        DO NOT WIDEN THE PATTERN AGAIN. Three rounds of "one spelling over" is
        the mechanism telling you it is the wrong mechanism, and widening a
        fourth time is how a guard becomes theatre. The pattern above is
        deliberately left MISSING a known spelling rather than patched, so the
        gap stays visible instead of appearing closed.

        The two real fixes, both tracked in #346, both too large to land on a
        release eve: make the marker's canonical form part of ADR 0012's
        condition 5 (a sign-off cycle), or diff each B.2 endpoint's real response
        key set per release and stop reading prose altogether (real machinery,
        and the only one that also closes the original no-marker blind spot).

        Until one of those lands, a releaser who finds ZERO field entries should
        treat that as unproven rather than clean, and grep for `ADR 0012` alone
        as a cross-check.
      report: list the field names and their endpoints in the release PR body,
        plus the cumulative count to date; write "none this cycle" when there are
        none, so silence is a result rather than an omission. If the raw grep count
        and the reported count differ, say so and say why — a corrected number
        without its correction is indistinguishable from a miscount. The cumulative
        number is the point — the failure mode ADR 0012 accepts is per-release
        increments each of which looks fine, so a monotonically rising integer is
        what makes the accumulation visible at all.
      baseline: |
        As of v3.29.0 the cumulative count is 2, both on /health:
          instanceName                  (#327)
          auth.consecutiveInconclusive  (#324)
        Anchored here so future releasers INCREMENT a known-good number rather
        than recompute it with whichever grep flags they happen to use — the
        recomputation is exactly what produced both defects above.

        Not counted, correctly: /health's okSource and okAt also landed in
        v3.29.0, but under ADR 0014 as part of a contract change rather than as
        additive fields. They carry no marker by design. Noted because anyone
        diffing /health's key set against this number will find two extra keys
        and should not read that as a miss.
```
