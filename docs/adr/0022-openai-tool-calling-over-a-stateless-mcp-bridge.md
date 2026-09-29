# ADR 0022 — OpenAI tool calling over a stateless MCP bridge

**Date:** 2026-09-13
**Status:** Accepted (maintainer instruction 2026-09-13: *"继续把工具调用做完 … 做完直接合"*); §5 amended 2026-09-25 by #520 (maintainer approval 2026-09-26: *"ADR 补注存吧，提交"*)
**Scope:** Class B.1 — `POST /v1/chat/completions`. Authority: OpenAI's published
`/v1/chat/completions` specification (`tools`, `tool_choice`, `tool_calls`, `finish_reason:
"tool_calls"`, the `tool` message role) + [ADR 0006](0006-openai-shim-scope.md).
**Authorized by:** [ADR 0021](0021-ocp-is-an-agent-backend.md), which set the direction and
explicitly reserved the implementation for its own ADR. This is that ADR.
**Supersedes:** the remainder of [ADR 0013](0013-no-openai-tool-calling.md)'s Decision. 0021
superseded the *whether*; this supersedes the *how* — and adopts 0013's own sketch of "the shape a
real implementation would take", with one change 0013 did not anticipate.

---

## Context

ADR 0021 made "OCP is an agent backend" a requirement and staged three changes ahead of the
implementation: make the silent drop observable (#468), stop the prompt contradicting the tool
surface (#473), and document the timeout ordering (which turned out to be a defect, #474). All three
shipped. **An OpenAI-protocol agent pointed at OCP still received prose** — measured on the shipped
3.32.0 dev instance on 2026-09-13 with the #469 probe: `finish_reason: stop`, `tool_calls: NO`, exit 1.

ADR 0013 sketched the real implementation as an in-process MCP server and named its cost:

> Step 3 is the hard one. It turns a stateless endpoint into a stateful one holding live child
> processes across requests, with all the eviction, timeout, crash-recovery and concurrency
> questions that implies, on a proxy whose current design deliberately spawns one short-lived child
> per request.

**That cost is avoidable, and this ADR avoids it.** The OpenAI protocol is itself stateless: the
client sends the *entire* conversation on every request, including its own `tool` messages carrying
results. Nothing about tool calling requires OCP to remember anything between requests, provided each
fresh spawn can be told what happened. Whether it can was the open question, and it was measured
before this design was chosen.

### What was measured (2026-09-13, `claude` 2.1.260, haiku unless stated)

| question | instrument | answer |
|---|---|---|
| Can a `-p` spawn be given a client's tools? | `--mcp-config` pointing at a stdio server that answers `tools/list`; read the `system`/`init` event | Yes — `mcp_servers: [{name:"ocp", status:"connected"}]`, the tool is in the schema, and the model calls it by `mcp__ocp__<name>` |
| How does OCP learn the model chose one? | the spawn's own stream-json | An `assistant` event carrying a `tool_use` block with `input` already as JSON — emitted **before** the MCP `tools/call` is dispatched, so ending the spawn on that event loses nothing |
| Can the result be fed back as real `tool_use`/`tool_result` blocks? | `--input-format stream-json` with an injected assistant turn | **No.** The CLI treats only `user` lines as turns; the injected assistant turn is dropped; the model re-calls the tool from scratch without seeing the result. Ruled out |
| Can it be fed back as text? | the same history rendered into the prompt | **Yes.** One turn, zero tool calls, the answer contains the supplied result |
| Does the whole loop work through OCP with a real model? | two-turn round trip, a fresh random nonce as the tool result | Turn 1 `finish_reason: tool_calls`, `arguments` a parseable JSON string; turn 2 `finish_reason: stop`, no re-call, the nonce in the answer. `/health`: `toolCallsEmitted 1`, `errors 0` |
| Does the #469 probe pass? | `scripts/probes/tools-dropped.mjs` | Exit **0** against this branch; exit 1 against 3.32.0 the same hour |

One cost was observed on 2.1.260 and had already gone by 2.1.270: there, MCP tools were *deferred*
in the CLI's schema and the first call in a turn was preceded by a `ToolSearch` round-trip. The
reviewer measured 2.1.270 listing the bridged tool directly and calling it first. A per-version
observation, recorded as one; nothing in this design depends on it either way.

---

## Decision

**1. Each tool turn is one short-lived spawn, exactly as every other request is.** Nothing is held
across requests. The stateful design 0013 sketched is not built, and this ADR records why it is
unnecessary: the client carries the state, and a text rendering of it is sufficient.

**2. When a request declares `tools`, the spawn holds exactly those tools and nothing else.**
`buildCliArgs` empties the built-in schema (`--tools ""`, the way `AUTH_MODE=multi` already does),
loads only the bridge (`--mcp-config <file> --strict-mcp-config`), and pre-approves it
(`--allowedTools mcp__ocp__*`). This is what the OpenAI contract says the model holds, it makes "which
tool did the model choose" unambiguous, and it applies in every auth mode — the tools it grants run on
the **client**, so a guest in multi mode calling its own tool touches nothing of the operator's. An
operator's own `MCP_CONFIG` is deliberately not merged in: a client's tool surface and an operator's
are different things.

**3. The bridge is `lib/mcp-bridge.mjs`, launched by `claude`, and it never answers `tools/call`.**
The tool exists on the client. OCP ends the spawn on the `tool_use` event; answering the call with a
placeholder was measured to cost an extra narrating turn and to race the kill. Not answering leaves
exactly one mechanism that concludes a tool turn, with `CLAUDE_TIMEOUT` as the backstop.

**4. The response is what the specification says.** `choices[0].message.tool_calls[]` with
`function.arguments` as a JSON **string**, `finish_reason: "tool_calls"`, and — when it arrives in the
same `assistant` event as the call — the text the model wrote alongside, as `content`. **This gap is CLOSED as of #478**, and the
record of it is kept because it is what the design was measured against. As originally shipped, the
CLI emitting one `assistant` event per content block meant a text preamble arrived in an earlier
event (delivered as `content: null`) and a second *parallel* call arrived in a later event the spawn
had already been ended before — the client got one call and the model re-issued the rest next turn,
converging at one extra round trip per dropped call.

The message-end signal this section anticipated turned out to exist exactly as sketched:
`--include-partial-messages`, added on the tool-bridge branch only, makes the stream carry
`message_delta` with `stop_reason: "tool_use"` after the last content block. Re-measured on 2.1.270
with `buildCliArgs`' own bridge argv and a prompt asking for two calls at once: both `tool_use`
blocks arrive as separate `assistant` events, **each with `stop_reason: null`**, all sharing one
`message.id`, followed by the `message_delta`. So every call is now accumulated and the spawn ends
on the signal rather than on the first call; a fail-safe delivers whatever was collected if the
signal never arrives, logged as `signalMissing`. Streaming delivers each call whole in one delta chunk keyed by
`index`, which is a valid instance of the spec's chunked form. The `tool_call_id` the client echoes
back is the CLI's own `tool_use.id` where it gave one.

**5. The client's history is rendered as text into the next spawn's prompt.** An assistant message
with `tool_calls` becomes `[Assistant called tool X with arguments …]`; a `tool` message becomes
`[Tool X returned] …`, paired by id; and when the conversation ends on a result, a continuation note
tells the model the results are final and to answer unless it needs something not yet returned. The
wording is the thing measured to turn a re-call into an answer.

> **Amendment (2026-09-25, #512 / PR #520; approved by the maintainer 2026-09-26).** Under
> `OCP_MULTIBLOCK_INPUT` (the default), the continuation note lives in the system prompt of every `-p`
> spawn, byte-constant and worded as a condition (`TOOL_CONTINUATION_SYSTEM_NOTE`), instead of trailing
> the last result. As a trailing block it moved to the new end of the prompt on every step, which
> defeated prompt caching. Re-measured with the new placement on 2026-09-25 through OCP: haiku 4.5,
> sonnet 5 and opus 5.5 each answered from a returned result without re-calling, over two tool steps
> each. `OCP_MULTIBLOCK_INPUT=0` restores the trailing note, and the TUI lane keeps it.

**6. `OCP_TOOL_CALLING=0` restores the pre-0022 path** — declared tools dropped and counted — and
the drop event now says *which* gate kept the request off the bridge. Default is on, because 0021
made this a requirement. **Expiry:** when no deployment has needed the switch for two releases,
remove it; a kill-switch nobody has pulled is a second code path nobody tests.

**7. Out of scope, stated so it is not read as covered:** the deprecated `functions`/`function_call`
shape (still dropped and counted, with reason `legacy_functions_shape`); forcing `tool_choice` shapes
(still refused with 400, per 0013's analysis — the CLI cannot be forced, and a forced call the model
does not make would be a silently wrong answer); `response_format` together with `tools`; and the TUI
lane, which composes its own prompt and has no bridge.

---

## Consequences

- **A `/health` field is added: `stats.toolCallsEmitted`** — additive under ADR 0012, B.2, read-only,
  the companion of `stats.toolRequestsDropped`: with the switch on, a request that declares tools
  lands in exactly one of the two. Snapshot diff +2/−0.
- **This is a behaviour change on the default path.** A client that sent `tools` and was content
  with prose — every agent on the maintainer's fleet at the time of 0013 — now receives `tool_calls`
  and must run them. That is the intended change and it is what "agent backend" means; the switch
  exists for the one that is not ready.
- **ADR 0013's Alternatives section is now fully discharged.** "Refuse whenever `tools` is present"
  was rejected because it would take down the fleet; this ADR neither refuses nor drops.
- **The `ToolSearch` round-trip seen on 2.1.260 is gone on 2.1.270** — measured by the reviewer, not
  assumed. Nothing here depended on it.
- **#474 applies to a tool turn exactly as to any other.** A spawn that is ended on the event is
  ended by the same SIGTERM/SIGKILL pair the timeout uses; if a descendant holds the stdout pipe,
  the same hang follows. Measured not to happen with the bridge, by the discriminating instrument rather than by the
  round trip's duration (an 8 s completion cannot tell a held pipe from none): `lsof -d 0,1,2` on
  the bridge during a live turn shows all three of its fds distinct from `claude`'s stdout/stderr,
  and `close` followed SIGTERM by ~590 ms both directly and through OCP. A client tool that made the
  *model* spawn something would not be reachable here anyway — the model holds no such tool.
- **What this does not make true:** that the model will always choose a tool when it should, or
  choose the right one. That is the model's behaviour and OpenAI's own clients face the same. What
  is now true is that when it does, the client is told.

---

## Alternatives considered

- **Stateful child across requests (0013's sketch).** Rejected as unnecessary once text rendering
  was measured to work. Every question it raises — eviction, crash recovery, concurrency, a session
  table — is a question this design does not have.
- **`--input-format stream-json` with real content blocks.** Measured not to work; see the table.
- **Answering `tools/call` from the bridge with a placeholder.** Measured to cost a turn and race the
  kill. The bridge is silent instead.
- **Keeping the built-in tools alongside the client's.** Rejected: it contradicts the OpenAI contract
  and reintroduces the ambiguity 0021 item 2 just removed — a model holding both `Bash` and the
  client's `run_command` has two ways to do one thing, and which it picks is not a contract.
- **Default off.** Rejected: 0021 says agent backend is a requirement, and a required feature that
  ships off is a documented feature, not a working one.
