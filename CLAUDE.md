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
  changelog_convention: |
    INSERT the new version heading BELOW a retained empty `## Unreleased`.
    Do NOT rename `## Unreleased` in place.

    Renaming in place is what caused v3.29.0's release notes to be relabelled
    `## Unreleased` by a later merge — #354's branch predated the rename and
    carried its own older copy of that line, so it won. Measured, holding base
    and feature branch fixed and varying only this convention:

      rename-in-place  -> exit 0, CLEAN merge; the feature entry files
                          SILENTLY into the just-shipped section
      insert-below     -> exit 1, CONFLICT; a human resolves it

    The cure is not that entries land in the right section. It is that git can
    no longer silently file into a SHIPPED one, because the release commit and
    the feature branch now contend for the same region.

    So: after a release, a CHANGELOG conflict on an open branch is the EXPECTED
    outcome, not a nuisance. A clean auto-merge on a branch whose entry predates
    the release is the symptom, not the happy path.

    Coverage is partial and the boundary was measured: a branch created AFTER
    the release lands its entry inside `## Unreleased` correctly; a branch that
    ALREADY EXISTED still needs its entry moved BY HAND on merge-forward,
    because git merges by context lines, not by section semantics.
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
    # growing one 'obviously fine' field at a time". This is the read that makes
    # that failure mode visible.
    #
    # #346 REPLACED THE MECHANISM. Until then this clause prescribed a grep of the
    # CHANGELOG for ADR 0012's condition-5 marker. That grep missed a COMPLIANT
    # spelling three times running — sentence-initial capital (#338), markdown link
    # (#344 first pass), bold wrapped around the reference (#344 second pass) — each
    # caught by a human reviewer and never by the mechanism. Its own stopping rule
    # ("if a THIRD compliant spelling is missed, stop widening") had fired.
    #
    # The spelling was the symptom. The disease was reading PROSE to learn what
    # shipped: every version of that grep, including a perfect one, could only see
    # additions whose author WROTE the marker. A field added with no marker returned
    # "none this cycle" — a green result for the case the audit was least able to
    # see, and the exact shape of the four pre-#288 additions that motivated ADR 0012
    # in the first place. The primary audit below reads the WIRE instead. The marker
    # grep survives only as a secondary cross-check, and its incompleteness is no
    # longer load-bearing.
    - name: Class B.2 response key-set diff (PRIMARY)
      when: |
        Every release, during the release_kit walk — and automatically on every PR,
        because `npm test` fails on any difference. The release walk reads the diff;
        it does not discover it.
      how: |
        The mechanism is scripts/b2-key-snapshot.mjs and the checked-in record is
        docs/governance/b2-response-keys.json. It boots a real server.mjs against a
        fixture that pins every shape-deciding setting, probes all 16 Class B.2
        endpoint+method pairs in ALIGNMENT.md's inventory, and records each response's
        recursive KEY PATH set plus its status and content-type. Values are never
        recorded, so uptime, timestamps and counters cannot make it flap; the suite
        proves that by probing two fresh boots and requiring identical output.

        TWO CONFIGURATION PROFILES since #357, one snapshot block each, defined in
        scripts/b2-key-snapshot.mjs § B2_PROFILES:

          probes           the default configuration — TUI mode, the warm pane pool and
                           skip-permissions all OFF. What every production instance in
                           the reference fleet runs.
          probesTuiPool    the config-variant corner — CLAUDE_TUI_MODE=true,
                           OCP_TUI_POOL_SIZE=1, CLAUDE_SKIP_PERMISSIONS=true.

        BOTH blocks get all 16 pairs, two fresh boots, and their own ALIGNMENT.md
        coverage check, so a second profile is not a place an endpoint can hide. Read
        the diff of both; a key path that appears in only one is surface only that
        configuration reaches, not a discrepancy.

        To read the release's surface change:

          git diff v<previous-tag>..HEAD -- docs/governance/b2-response-keys.json

        READ IT PER BLOCK, and the distinction is not cosmetic:

          - a key path added INSIDE an existing block  -> NEW B.2 SURFACE. This is the
            thing this audit exists to find; it needs an ADR 0012 citation, or its own ADR.
          - a WHOLE NEW PROFILE BLOCK appearing        -> NEW COVERAGE, not new surface.
            Every one of its key paths is a response this server already returned and
            this mechanism had never looked at. Nothing was added to any endpoint.
          - a key path REMOVED from an existing block  -> removed or renamed surface, which
            ADR 0012 does not cover at all.

        A new block therefore lands as one large one-time addition. #357 added
        `probesTuiPool`: 331 added lines carrying 221 key paths, and NONE of them is new
        B.2 surface. Counting those as additions would have produced 221 phantom ADR 0012
        condition-5 failures at the next release — and `report:` below rests entirely on
        "silence is a result", so a 221-item false alarm is exactly what teaches a releaser
        to stop believing this mechanism. That is the failure mode ADR 0012 names by hand.

        A new block is a rare, deliberate event: it appears only in the PR that adds a
        profile to B2_PROFILES, and that PR says so. If you see one you did not expect,
        that is a finding.

        The whole history is the per-release record:

          git log -p docs/governance/b2-response-keys.json

        The suite also checks the probe plan against ALIGNMENT.md's inventory table, so
        a B.2 endpoint added to the constitution with no probe added to the plan fails
        rather than silently going unreported.

        To run it alone, or to regenerate after a deliberate addition:

          node scripts/b2-key-snapshot.mjs            # diff only, exit 1 on drift
          node scripts/b2-key-snapshot.mjs --write    # rewrite the snapshot

        Regenerating is not authorization. It records that the surface moved; the PR
        still has to say under what.
      report: |
        For the section being dated, list every added and removed key path with its
        endpoint AND ITS BLOCK, taken from the snapshot diff rather than from the
        CHANGELOG, and for each ADDITION INSIDE AN EXISTING BLOCK state whether the PR
        that introduced it carries its ADR 0012 citation.

        A whole new profile block is reported as ONE line naming the block and the PR that
        added it — not as N additions. Its key paths are coverage, not surface, and demanding
        a condition-5 citation for each is a false alarm that costs this audit its
        credibility (see how: above).

        Write "no B.2 key-set change this cycle" when the diff is empty, so silence is a
        result rather than an omission — and note that this silence is now evidence, which
        the marker grep's silence never was.

        The cumulative count ADR 0012 names as load-bearing ("a monotonically rising
        integer is what makes the accumulation visible at all") is still reported, but
        it is now DERIVED from the snapshot's git history rather than recounted with
        whichever grep flags the releaser happens to use. That recomputation is what
        produced both of #338's defects.
      baseline: |
        As of v3.29.1 the cumulative ADR 0012 count is 2, both on /health:
          instanceName                  (#327)   added in v3.29.0
          auth.consecutiveInconclusive  (#324)   added in v3.29.0

        UNRELEASED (#357): the `probesTuiPool` block was added — 221 key paths, **0 new
        B.2 surface**, cumulative ADR 0012 count UNCHANGED at 2. New coverage of responses
        the server already returned under a configuration this mechanism had never probed.
        The `probes` block is byte-identical across that PR, which is the evidence; the one
        removed line in its diff is a superseded `notCovered` prose entry, not a key path.
        Recorded here so the next releaser reading a large diff does not recount it.

        v3.29.1: NONE THIS CYCLE. Recorded rather than omitted, per the report:
        clause above — a releaser reading only the count cannot otherwise tell a
        cycle that was audited and added nothing from a cycle nobody audited.
        The B.2 key-set snapshot also matched unchanged, which is the stronger
        of the two signals: it would have caught a field added with no marker.

        RECONCILED AGAINST THE WIRE when the snapshot was first recorded (#346): both
        key paths are present in docs/governance/b2-response-keys.json's "GET /health"
        record, so the anchored count and the wire agree. auth.okAt and auth.okSource
        are also present, exactly as the previous version of this clause predicted a
        reader would find — they landed under ADR 0014 as part of a contract change,
        not as additive fields, and are correctly not counted here.
      blind_spots: |
        STATED SO NOBODY MISTAKES A GREEN RUN FOR COVERAGE. This is a strictly larger
        set of detections than the grep it replaced, not a complete one. The full list
        lives in the snapshot's own "notCovered" block, where each entry is tagged
        [measured] or [reasoned] so a reader can tell which claims were observed from a
        running server and which were read off the source. That tagging exists because
        #354's review found a REASONED claim written in a measured voice, and wrong.
        The headline items:

          - TYPE changes under an unchanged key path. A key set records names, not
            types, so string -> number under the same name is invisible. Container
            changes ARE caught (object <-> scalar, array <-> object).
          - RENAMES, as renames. A rename fails the test as one removal plus one
            addition; the mechanism cannot tell it apart from two unrelated changes.
          - Shapes that exist only under a configuration NEITHER PROFILE PINS. The 12
            key paths this bullet used to name are now GUARDED (#357): probesTuiPool
            covers the 10 tui.pool.* members and probes covers spawn.reason and
            config.allowedTools[]. The two profiles bracket rather than sample, because
            the three settings are independent — MEASURED by booting the five reachable
            variants (TUI alone; TUI+pool=1; skip-permissions alone; all three at
            pool=1; all three at pool=4) and probing all 16 pairs: no key path appeared
            that is absent from both blocks. What is still blind is the NEXT
            shape-deciding setting, if both profiles happen to pin it to one value.
          - The TUI REQUEST path, in either profile. OCP_TUI_TMUX_BIN points at a stub
            tmux that logs its argv and exits 1, so no pane boots and no `claude` runs;
            the suite asserts from that log that the only invocation is list-sessions.
            Deliberate: MEASURED, warm-up traffic under CLAUDE_TUI_MODE=true issued four
            `tmux new-session` commands each launching a `claude`, and with the REAL
            tmux server.mjs's boot-time reapStaleTuiSessions({includeLegacy:true}) would
            `tmux kill-server` on a workstation with no foreign session. The cost of that
            bound is that probesTuiPool records no element keys for /api/usage's
            byKey[]/recent[]/timeline[] or for recentErrors[] — probes records all of
            them, so a field added there is still caught.
          - REQUEST-SHAPED responses, where the recorded keys come from the probe's own
            body rather than from the server. PATCH /settings echoes one results.<key>
            per setting sent; the probe pins {timeout}. Ask this of every new probe —
            the quota probe already sends all three dimensions for the same reason.
          - ERROR and non-localhost responses. Only the localhost success path of each
            pair is recorded.
          - /usage, which is Hybrid rather than B.2 and cannot be probed without a live
            Anthropic wire call.
          - AUTHORIZATION. This detects that surface moved. It never decides whether the
            move was allowed. ADR 0012 condition 5 is still a human obligation; what
            changed is that forgetting it is now detectable from the other side.
    - name: ADR 0012 marker cross-check (SECONDARY — no longer the mechanism)
      when: every release, after the key-set diff above
      how: |
        Reading the marker is now a convenience, not a control: the key-set diff already
        told you what shipped. This answers the different question of whether the author
        CLAIMED the authorization in the place ADR 0012 condition 5 requires.

          grep -inE 'additive under \[?ADR[^0-9]{0,10}0012' CHANGELOG.md

        Read every hit; subtract by inspection any that is META-TEXT (a line describing
        the sweep necessarily quotes the marker it greps for — that was #338's over-count).
        A field entry names an endpoint and a field; meta-text does not.

        >> DO NOT WIDEN THIS PATTERN. Its stopping rule fired in #346 and the pattern is
        >> deliberately left MISSING a known compliant spelling — bold wrapped around the
        >> reference, `additive under **[ADR 0012](…)**` — so the gap stays visible rather
        >> than appearing closed. Widening it a fourth time is how a guard becomes theatre.

        What changed in #346 is that this incompleteness is no longer load-bearing. A
        marker this grep misses now shows up from the other side: the key appeared in the
        snapshot diff, and the reviewer goes looking for its authorization. A marker
        nobody wrote at all — the case no version of this grep could ever see — is caught
        the same way.
      report: |
        For each addition the key-set diff found, whether a matching marker exists. A
        found key with no marker is an ADR 0012 condition 5 failure, not a grep defect,
        and is fixed in the PR that added the key.
```
