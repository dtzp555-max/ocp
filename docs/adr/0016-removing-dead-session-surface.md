# 0016 — Removing the Dead Session Surface, and How B.2 Surface May Be Removed At All

- **Date**: 2026-08-10
- **Status**: Accepted
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0006 (Class A/B taxonomy and the B.2 grandfather), ADR 0012 (additive fields on grandfathered B.2), issue #355, PR #103

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

**Remove it, in full**: both endpoints, the response keys, the `/settings` field, the env var, the Map, the reaper, the banner line, the CLI subcommand, the plugin commands and the dashboard card.

**And, because ADR 0012 authorizes only additions, this ADR establishes how B.2 surface may be removed at all.** ADR 0012's standing authorization is explicitly additive; a removed or renamed key path has never had an authorizing route. The rule this ADR sets, for this case and as the pattern for any future one:

> A grandfathered Class B.2 element may be removed only by its own ADR, which must (a) demonstrate the element is **inert** — not merely unused, but incapable of taking a non-trivial value on any reachable path — (b) enumerate every consumer, from the wire and the repo rather than from imports, and (c) update them in the same change. Removal is never covered by ADR 0012.

The inertness demonstration for this case is above: zero write sites, confirmed by `git log -S`, with the removing commit and date identified.

## Alternatives rejected

**Wire it up so the counter means something.** Rejected because it requires first deciding what "a session" *is* for a proxy that spawns a process per request — and `server.mjs:1534` already answers that: nothing, on the `-p` path. The only lane with genuine sessions is TUI mode's warm pane pool (ADR 0007), which has its own `tui.pool` reporting. Reviving `sessions` to mean "TUI panes" would give one name two meanings across two lanes, which is the `resolveOcpDir`/`resolveInstallDir` collision `scripts/lib/install-dir.mjs` was created to avoid.

**Keep it, documented as always-zero.** Rejected. It costs a documentation line and leaves every consumer displaying a number that reads as a measurement. A field that can only ever be `0` is worse than an absent one precisely because it answers the question it is asked.

## Consequences

- **The B.2 key-set snapshot will show removed key paths.** That is the correct signal, not a regression: `docs/governance/b2-response-keys.json` is expected to lose `sessions`, `sessions[]`, `proxy.activeSessions` and two whole endpoint records. Regenerating it is *not* authorization — this ADR is.
- **`/settings`' request shape changes.** `sessionTTL` is writable, so this removes an accepted request field, not only a response field. Any caller PATCHing it will need to stop; the removal should reject it explicitly rather than ignore it silently, so a caller learns rather than guesses.
- **`ALIGNMENT.md`'s Class B.2 inventory loses two rows**, and the snapshot's probe-plan cross-check must be updated in the same change or the suite fails — which is the mechanism working.
- **Three consumers change in lockstep** — `ocp`, `ocp-plugin/index.js`, `dashboard.html`. A consumer left reading a removed key is the failure this ADR's rule (b) exists to prevent.
- **The precedent is deliberately narrow.** This authorizes removing *inert* surface. It does not authorize removing surface that works but is unpopular, and it does not weaken the grandfather: a live B.2 element still cannot be changed without its own ADR under `ALIGNMENT.md:114`.
- **A lesson worth keeping with the decision**: the surface outlived its mechanism by twelve releases, and the comment explaining *why* the mechanism was unnecessary (`:1534`) sat four hundred lines from the surface it orphaned. Removing a mechanism is not finished until its surface is removed or re-justified in the same change.
