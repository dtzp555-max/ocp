# ADR 0021 — OCP is an agent backend

**Date:** 2026-09-09
**Status:** Accepted (maintainer sign-off 2026-09-09)
**Scope:** Class B.1 — `POST /v1/chat/completions`. Authority: OpenAI's published
`/v1/chat/completions` specification + [ADR 0006](0006-openai-shim-scope.md).
**Supersedes:** the **Decision** of [ADR 0013](0013-no-openai-tool-calling.md). Its Context and its
"shape a real implementation would take" are **retained and promoted** to the design target.
**Amends:** `AGENTS.md` § "What this project is" — the clause "it is explicitly **not** an
extension layer".

---

## Context

ADR 0013 (2026-08-03) asked *"does OCP implement tool calling, or refuse it"* and answered: refuse.
That answer was correct for the question asked, and this ADR does not call it a mistake.

**The maintainer has since set a different requirement: OCP must work as an agent backend. That is
what it is for.** This ADR exists because that requirement cannot coexist with ADR 0013's Decision,
and a direction that contradicts a signed ADR must not be executed until the ADR is replaced.

**The cost of leaving 0013's Decision in place is now measured twice.** Issue #467 is the *second*
occurrence of one shape: an OpenAI-protocol agent pointed at OCP does not fail — it **degrades into
a chatbot silently**, with `finish_reason: "stop"`, HTTP 200, `ocp health` ok, `recentErrors` empty,
and clean logs on both sides. ADR 0013's own Context records the first: an agent on a group chat
going quiet for hours with every health signal green.

**The first occurrence produced an ADR explaining why OCP refuses tool calling, and produced nothing
that makes the failure observable when a client walks into it.** That gap is the whole reason the
second occurrence cost hours again — including several wrong turns (the TUI permission gate, then
context length, then the network) before the discriminating measurement was taken.

**The same failure mode exists one layer down, and the repo already documented it.** The default
`OCP_SYSTEM_PROMPT_WRAPPER` (`server.mjs:208`) tells the model it has *no* filesystem, working
directory or shell, while the same spawn passes
`--allowedTools Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent`. The comment immediately
below it says so in as many words — the positive `OCP_LOCAL_TOOLS` wrapper exists because the
default one makes the model *"disclaim access it actually holds"*. **The contradiction was known,
and a default-off flag was shipped past it rather than a fix.** That is item 2 below, and it is why
the same task can be fast-and-wrong or slow-and-right: the model holds tools it has been told it
lacks and resolves that differently from turn to turn. Probed in #467 — a Write request ignored the
wrapper and created the file; a Bash request honoured it and refused; asked again, the model
answered *"You're right that `Bash` appears in my tool list. But the deployment instructions…"*.
**The negative wrapper is a request, not a restriction**, and it was watched being declined.

The one criterion that separates "the client's agent loop ran" from "OCP's inner CLI did the work
and narrated it", because capability tests pass on both sides:

> the client's own per-session **tool-call counter**. Same task, same prompt —
> OCP: `tool_call_count=0`, `api_call_count=0`. A native tool-calling API: `1` and `2`.

Ruled out and recorded so nobody re-measures them: **not context length** (none / 20 KB / 100 KB /
300 KB → 4.1 / 2.8 / 4.9 / 4.5 s) and **not the network**. A wedged inner process is `STAT=U` at
~0.2 % CPU — blocked, not computing; `STAT=S` with fluctuating CPU is genuinely working.

---

## Decision

**1. OCP is an agent backend.** Supporting OpenAI-protocol agents is a requirement, not an
extension. `AGENTS.md`'s "not an extension layer" is **narrowed, not deleted**: it continues to
govern *inventing* surface that Anthropic does not expose, and it no longer forbids serving the
tool-calling half of a specification OCP already claims to implement.

**2. ADR 0013's Decision is superseded; its analysis is retained.** The in-process MCP design it
sketched becomes the **target**, with its own stated risk unchanged:

> Step 3 is the hard one. It turns a stateless endpoint into a stateful one holding live child
> processes across requests, with all the eviction, timeout, crash-recovery and concurrency
> questions that implies, on a proxy whose current design deliberately spawns one short-lived child
> per request.

**3. That implementation is NOT authorized by this ADR.** It needs its own ADR, its own risk surface
and its own review — exactly as 0013 said. This ADR authorizes the *direction* and the *staging*.

**4. Three changes ship first, and none of them requires that implementation:**

| # | change | why it stands alone |
|---|---|---|
| 1 | **Make the silent degradation loud.** A request carrying `tools` that OCP cannot honour must produce something an operator, and preferably a client, can branch on — not prose. | ADR 0013 explicitly left *"what OCP owes a client that sends `tools`"* unanswered. This answers it **without** implementing tool calling. |
| 2 | **Stop the prompt contradicting the granted tool surface.** The default wrapper tells the model it has no filesystem, shell or working directory while the same spawn passes `--allowedTools Bash,Read,Write,Edit,Glob,Grep,…`. | Fixes an inconsistency the code **already documents**: `server.mjs`'s own comment says the default wrapper makes the model *"disclaim access it actually holds"*. Not new surface. |
| 3 | **Document the timeout ordering.** `CLAUDE_TIMEOUT` (600 s) sits *under* typical client defaults (1800 s in the reported case), so the client never fails first and never fails over. A wedged turn is ten minutes of silence. | Documentation. |

---

## Consequences

- **ADR 0013 stays in the tree**, marked superseded-in-part. Its Alternatives section still
  constrains item 1: *"refuse whenever `tools` is present"* was rejected because it **would have
  taken down every OpenClaw agent on the maintainer's fleet on the day it shipped** — they all send
  tools and all accept text. **The loud failure must therefore not be a blanket refusal.**
- **Item 2 changes model behaviour on the default path.** The contradiction is currently what makes
  the model decline tools it holds; removing it makes the model act more often. That is the intent,
  it is a behaviour change on a single-user default install, and it needs its own review with a
  measured before/after rather than an assertion.
- **This direction does not retroactively authorize anything.** Every code change still declares its
  class and cites that class's authority; B.1 work still cites the OpenAI specification + ADR 0006.
- **Had the maintainer declined to sign this**, items 1–3 would still have been correct on their own
  merits, and ADR 0013 would have stood. None of the three depends on this ADR — which is why they
  are staged ahead of it.
