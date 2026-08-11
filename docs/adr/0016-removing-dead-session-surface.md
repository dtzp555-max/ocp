# 0016 — Removing the Dead Session Surface, and How B.2 Surface May Be Removed At All

- **Date**: 2026-08-10 (**Amendment 1** accepted 2026-08-11 — see under Decision)
- **Status**: Accepted
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0006 (Class A/B taxonomy and the B.2 grandfather), ADR 0012 (additive fields on grandfathered B.2), issue #355, PR #103, PR #395 (the removal this ADR authorized)

## Context

`server.mjs` carries a complete session-tracking surface that **has never been written to since 2026-05-31**.

The `sessions` Map was introduced in v2.0.0 ("on-demand spawning, session management, full tool access"). PR **#103** (Phase 6c, the `claude --output-format stream-json` port) deleted the single `sessions.set(...)` call — **1 deletion, 0 additions** — because per-request spawning with `messagesToPrompt` made it unnecessary. `server.mjs:1534` states that outright:

> `(messagesToPrompt), so multi-turn correctness is preserved without sessions.`

The *mechanism* was removed with its reason recorded. The *surface* was not. **Twelve releases have shipped since**, each carrying it.

What that surface is, measured at v3.29.2:

| Layer | Item | Behaviour today |
|---|---|---|
| Endpoint | `GET /sessions` | `200 {sessions: []}` — always empty |
| Endpoint | `DELETE /sessions` | `200 {cleared: 0}` — always zero |
| `/health` | `sessions`, `sessions[]` | always `[]` |
| `/status` | `proxy.activeSessions` | always `0` |
| `/settings` | `sessionTTL` — **readable and writable** | settable; governs a reaper with nothing to reap |
| Env | `CLAUDE_SESSION_TTL` (documented in README) | same |
| Internals | `sessions` Map, its TTL reaper (`:980-984`), boot banner (`:3997`) | reaps an always-empty Map |
| CLI | `ocp sessions`, and its `DELETE` (`ocp:463`, `:488`) | prints an empty list |
| Plugin | `ocp-plugin/index.js:115, 168, 174` | same |
| Dashboard | `dashboard.html:155` — a "Sessions" card | renders `0` forever |

The B.2 key-set snapshot already records the fact, tagged `[measured]`:

> `[measured] Element keys of sessions[] on /health and /sessions. They are empty in every run because nothing in server.mjs ever writes the sessions Map — declared by 'const sessions = new Map()' (line 965 as of v3.29.0), with 0 occurrences of sessions.set(`

**Why this is worse than dead code.** An operator reading `activeSessions: 0` on a dashboard concludes *"no sessions are active"*. The truth is *"this counter does not work"*. Those are different statements and only one of them is true. `DELETE /sessions` is worse still: it reports `{cleared: N}` and an operator may reasonably act on that number. This is the same defect class this repo spent 2026-08-10 removing from its operator-facing messages — a sentence that asserts more than the code knows — except here the whole surface is the sentence.

## Decision

**Remove it, in full**: both endpoints, the response keys, the `/settings` field, the env var, the Map, the reaper, the banner line, the CLI subcommand, the plugin commands and the dashboard card. *(This enumeration was one line short. See **Amendment 1** at the end of this section — `stats.sessionHits` and `stats.sessionMisses` belong to it and were missed.)*

**And, because ADR 0012 authorizes only additions, this ADR establishes how B.2 surface may be removed at all.** ADR 0012's standing authorization is explicitly additive; a removed or renamed key path has never had an authorizing route. The rule this ADR sets, for this case and as the pattern for any future one:

> A grandfathered Class B.2 element may be removed only by its own ADR, which must (a) demonstrate the element is **inert** — not merely unused, but incapable of taking a non-trivial value on any reachable path — (b) enumerate every consumer, from the wire and the repo rather than from imports, and (c) update them in the same change. Removal is never covered by ADR 0012.

The inertness demonstration for this case is above: zero write sites, confirmed by `git log -S`, with the removing commit and date identified.

> **Amendment 1 (accepted 2026-08-11).** The enumeration under "Remove it, in full" is amended to add two more `/health` response keys:
>
> ```
> stats.sessionHits
> stats.sessionMisses
> ```
>
> They are removed on the same terms as everything already listed. **Nothing else in this ADR changes.** In particular the removal rule (a)/(b)/(c) above is unamended, and this amendment is an *instance* of it rather than an exception to it — the demonstrations it requires are below.
>
> **Why an amendment rather than a follow-up ADR.** These two fields meet this ADR's inertness bar and its consumer bar identically to everything already listed. What they lacked was a line in the enumeration. A separate ADR would restate this ADR's own reasoning verbatim to authorize two fields it was already about; an amendment records what actually happened, which is an omission in enumeration rather than a new decision.
>
> **How the omission happened, recorded because the mechanism is reusable.** The Context above quotes the snapshot's `notCovered` entry for `sessions[]`. That quote is a verbatim prefix of the entry, and it stops **mid-sentence**, at *"…with 0 occurrences of `sessions.set(`"* — cutting the very enumeration it was quoting, which continues *"and 0 of `sessions.get(`, only `.delete` and `.clear`."* Measured against `git show c0e57dc^:docs/governance/b2-response-keys.json`: from that stopping point it is **50 characters** to *"The array is unreachable, not under-probed."* and **94 characters, two sentences**, to the one that matters —
>
> > *"Tracked as issue #355, whose blast radius is wider than this array: /status.activeSessions and stats.sessionHits/sessionMisses are permanently constant too."*
>
> `/status.activeSessions` reached the Context table; the two fields named alongside it did not. The Decision list, the consumer sweep and the snapshot expectations all inherited the truncation, and every one of them verified as internally consistent — because they were consistent with each other. **This ADR quoted an enumeration and cut it mid-clause, two sentences before the source named the two fields.** A governance document is not a different kind of artifact from a code comment: it asserts things about the code, and it can assert more than it checked.
>
> **And the sharpest part of this amendment is that the paragraph above had to be corrected for the very defect it diagnoses.** As first drafted it asserted that the quote *"ends at 'The array is unreachable, not under-probed'"* and that *"the very next sentence"* named the two fields. Both were false. The quote stops **50 characters earlier** than that, mid-sentence, and **94 characters and two sentences** before the fields are named. **So the paragraph diagnosing an unverified quotation contained an unverified quotation.** What went wrong is precise and worth naming: the source entry's next sentence *was* verified against `git show c0e57dc^:…` — and the **stopping point**, which is the half that actually carries the claim, was never checked at all. Verifying the part of a quotation you can look up, while inheriting the part that says where it ends, is not verification.
>
> Caught by independent review, not by the author. Recorded rather than silently reworded, because a near-miss and a mid-clause cut are different lessons, and because an ADR whose subject is *"a document quoted a source and stopped too early"* is the right place to keep the second instance next to the first.
>
> The failure surfaced the right way. PR #395's author declined to remove these two fields *because this ADR did not name them*, citing the "deliberately narrow" clause against the tempting inference that an ADR about dead session surface obviously covers all dead session surface. The narrowness clause blocked its own author's intent, which is exactly what it is for.
>
> **Inertness (clause (a)) — re-derived for this amendment, not inherited.** Not merely unused, but incapable of a non-trivial value on any reachable path:
>
> - Both are declared in the `const stats = {…}` object literal in `server.mjs`, initialised to `0`.
> - **Zero write sites of any kind**, established by enumerating *every* `stats` reference in the file rather than by sampling for the two names. Every write in `server.mjs` targets a named property — `stats.totalRequests++`, `stats.oneOffRequests++`, `stats.activeRequests++`/`--`, `stats.errors++`, `stats.timeouts++`, `stats.queueRejections++`, `stats.queued = …` — and the file contains **no** `stats[…]` bracket access, **no** `...stats` spread target, **no** `Object.assign` onto it and **no** alias binding. Neither field can therefore be written under any spelling, dynamic or otherwise. This matters more than a name grep: a name grep cannot rule out a computed key.
> - **History, now checkable locally.** `git show 885f62a` (PR #103) deletes `stats.sessionHits++` and `stats.sessionMisses++` **in the same hunk as the only `sessions.set(...)`**. So these two were not orphaned *indirectly* by the Map losing its writer — their own increments were deleted, by that commit, on that day. #395 could not see this and confirmed #103 from the GitHub API instead, because it believed the checkout was a shallow clone in which `v3.16.4` and `main` shared no ancestor. **That belief was wrong, and was corrected in `2593eb1` (#408)**: the repository has one root (`593d0dc`), `merge-base(v3.16.4, origin/main)` is `9e25160`, and in a non-shallow clone the pickaxe names `885f62a` directly. This ADR's sentence above — "confirmed by `git log -S`" — is accurate as written and is now reproducible rather than aspirational.
>
> **Consumers (clause (b)) — from the wire and the repo rather than from imports.**
>
> - **On the wire.** Both keys are recorded in `docs/governance/b2-response-keys.json` under the **`GET /health`** record of **both profile blocks** (`probes` and `probesTuiPool`). That is *one endpoint recorded twice, not two endpoints* — a distinction worth stating because the two-places-in-the-file shape invites the other reading. `/health` is the only response that carries them, because `stats` reaches the wire through a single bare `stats,` shorthand in the `/health` handler; `/status` and `/usage` build their own response blocks by naming four fields each (`totalRequests`, `activeRequests`, `errors`, `timeouts`) and never included these. Being on the wire is what makes them grandfathered B.2 *response surface* rather than internal bookkeeping, and therefore what makes an authorization necessary at all.
> - **In the repo, by name.** No consumer *names* either field, checked on the current tree rather than restated from #395: `ocp`, `ocp-connect`, `ocp-plugin/index.js`, `dashboard.html`, `README.md`, `scripts/doctor.mjs`, `scripts/upgrade.mjs` and `test-features.mjs` contain zero references under any spelling or case. Every *named* `/health` consumer reads a fixed field list (`version`, `uptimeHuman`, `stats.totalRequests`, `stats.activeRequests`, `stats.errors`, `stats.timeouts`, the `auth` block), and `dashboard.html` renders `/status`, which never carried them.
> - **In the repo, generically — and this is the half a name grep cannot reach.** Two consumers took these fields without ever mentioning them, which is exactly why clause (b) says "from the wire and the repo rather than **from imports**":
>   - **`ocp health`** (`ocp:369-377`) pipes the entire `/health` body through `_json` (`ocp:37`, `python3 -m json.tool`). It pretty-prints **every** key, so before this change it printed `"sessionHits": 0` and `"sessionMisses": 0` straight to the operator. It is format-agnostic and needs no clause (c) update — but "no consumer displays either field" would have been **false**, and the zero-reference grep is precisely what hid it.
>   - **`scripts/b2-key-snapshot.mjs`** walks whatever key paths a response happens to carry, so the checked-in snapshot consumed these fields without naming them. Updated in the same change, per clause (c).
>
>   The snapshot was named from the start; **`ocp health` was missed by the first pass of this amendment's own sweep and found by independent review.** Recorded because it is the amendment's own thesis recurring inside the evidence the authorization rests on — and because the sweep that missed it had already reasoned correctly about generic consumers for the snapshot, and simply did not apply that reasoning to a shell pipeline. **A grep for the name answers "is it referenced", not "is it consumed".**
>
> **Consequences of this amendment.**
>
> - **The B.2 key-set snapshot loses two key paths per block** — four lines, nothing added, no other record moved. Regenerating it is *not* authorization; this amendment is. **ADR 0012 is not engaged**: it authorizes additions only, and a removal has never been covered by it, which is the whole reason this ADR had to establish a removal route.
> - **`ALIGNMENT.md`'s Class B.2 inventory keeps every row.** These are response keys on an endpoint that remains, not endpoints, so unlike the parent decision no inventory row and no probe-plan entry is added or removed. The `/health` row's *Authorizing ADR* cell does gain `session-surface removals per ADR 0016 (+ Amendment 1)`, following the convention `/api/keys` (ADR 0017) and `/cache/stats` (ADR 0012) already use — because the Annual Alignment Audit (`ALIGNMENT.md:168`) asks whether a grandfathered endpoint still matches its v3.16.4 snapshot, and after this change and #395's, `/health` does not. An unrecorded divergence makes that audit unanswerable.
> - **The narrowness clause is reaffirmed, not weakened.** It cost a round trip here, and that is the correct price. The alternative reading — that an ADR implicitly covers anything sufficiently similar to what it names — is precisely what would make the grandfather unenforceable. An ADR that has to be amended when it under-enumerates is working, not failing.
> - **One durable check falls out of this.** When an ADR's Context quotes an enumeration, **the enumeration is the thing to verify, not the sentence**. This ADR's Context table should have been built by reading the `notCovered` entry to its end and the `stats` object to its end and cross-checking the two — mechanically, the way the probe plan is already cross-checked against the inventory table. It was built by reading a quotation.

## Alternatives rejected

**Wire it up so the counter means something.** Rejected because it requires first deciding what "a session" *is* for a proxy that spawns a process per request — and `server.mjs:1534` already answers that: nothing, on the `-p` path. The only lane with genuine sessions is TUI mode's warm pane pool (ADR 0007), which has its own `tui.pool` reporting. Reviving `sessions` to mean "TUI panes" would give one name two meanings across two lanes, which is the `resolveOcpDir`/`resolveInstallDir` collision `scripts/lib/install-dir.mjs` was created to avoid.

**Keep it, documented as always-zero.** Rejected. It costs a documentation line and leaves every consumer displaying a number that reads as a measurement. A field that can only ever be `0` is worse than an absent one precisely because it answers the question it is asked.

## Consequences

- **The B.2 key-set snapshot will show removed key paths.** That is the correct signal, not a regression: `docs/governance/b2-response-keys.json` is expected to lose `sessions`, `sessions[]`, `proxy.activeSessions` and two whole endpoint records. Regenerating it is *not* authorization — this ADR is. **Amendment 1 adds `stats.sessionHits` and `stats.sessionMisses` to that list**, in a later change with its own snapshot diff.
- **`/settings`' request shape changes.** `sessionTTL` is writable, so this removes an accepted request field, not only a response field. Any caller PATCHing it will need to stop; the removal should reject it explicitly rather than ignore it silently, so a caller learns rather than guesses.
- **`ALIGNMENT.md`'s Class B.2 inventory loses two rows**, and the snapshot's probe-plan cross-check must be updated in the same change or the suite fails — which is the mechanism working.
- **Three consumers change in lockstep** — `ocp`, `ocp-plugin/index.js`, `dashboard.html`. A consumer left reading a removed key is the failure this ADR's rule (b) exists to prevent.
- **The precedent is deliberately narrow.** This authorizes removing *inert* surface. It does not authorize removing surface that works but is unpopular, and it does not weaken the grandfather: a live B.2 element still cannot be changed without its own ADR under `ALIGNMENT.md:114`. **Amendment 1 is the evidence this clause works.** It stopped PR #395's own author from removing two fields that were inert, orphaned by the same commit, and named in the very source this ADR's Context quoted — because this ADR did not enumerate them. The clause cost a round trip and bought an enforceable grandfather.
- **A lesson worth keeping with the decision**: the surface outlived its mechanism by twelve releases, and the comment explaining *why* the mechanism was unnecessary (`:1534`) sat four hundred lines from the surface it orphaned. Removing a mechanism is not finished until its surface is removed or re-justified in the same change.
