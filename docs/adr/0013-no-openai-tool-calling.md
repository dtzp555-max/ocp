# ADR 0013 — OCP Does Not Implement OpenAI Tool Calling

**Date:** 2026-08-03
**Status:** Accepted (maintainer sign-off 2026-08-03)
**Scope:** Class B.1 — `POST /v1/chat/completions`. Authority: OpenAI's published
`/v1/chat/completions` specification + [ADR 0006](0006-openai-shim-scope.md).

---

## Context

Issue #311 reported that OCP accepts `tools` and `tool_choice` and does nothing with them.
Verified: `server.mjs` contains **zero** occurrences of `tool_calls`, `handleChatCompletions` never
reads either field, and the CLI event parser extracts only `type:"text"` blocks. Forcing a call
with `tool_choice` still returns prose and `finish_reason: "stop"`.

The failure is silent and shaped like success — no 400, no warning field, and `stop` means "the
model finished its turn normally", so a client has nothing to branch on. It cost a real production
outage's worth of diagnosis: an OpenClaw agent bound to a Telegram group went silent for hours
because its `messaging` tool profile routes visible output through a `message` tool the agent could
never successfully call, and every health signal on both sides stayed green throughout.

So the question this ADR answers is not "is this a defect" — it is — but "does OCP implement tool
calling, or refuse it".

## Why implementing it is not a matter of adding a mapping

OpenAI's protocol and the Claude Code CLI own the agentic loop at **opposite ends**.

| | OpenAI `/v1/chat/completions` | `claude` CLI |
|---|---|---|
| who runs the loop | the **client** | the **CLI** |
| who executes tools | the **client** | the **CLI** |
| state | none — every request carries the whole history, including `role:"tool"` results | in-process, across the whole turn |
| a tool call is | a **response** the caller must answer | an **internal step** the CLI performs and continues past |

A `tool_use` block in the CLI's output is not an OpenAI `tool_call`. It is the CLI reporting
something it is **about to do itself**. Forwarding it as a `tool_call` would tell the HTTP client
to execute `Bash`/`Read`/`Edit` on the client's machine and return a result the CLI never asked for
and will not wait for — and the CLI would meanwhile execute it anyway. That is not a partial
implementation; it is a different and wrong behaviour.

Nor does the CLI offer a delegation mode. Checked against 2.1.220:

- `--allowedTools` / `--disallowedTools` / `--tools` — **select from the CLI's own built-ins**.
- `--mcp-config` — load MCP servers, which **the CLI itself calls**.
- `--agents` — define subagents, not caller-executed tools.

There is no flag that means "accept this externally-defined tool, do not execute it, hand the call
back to whoever invoked you, and resume when I give you a result."

### The shape a real implementation would take

Not ruled out, and recorded so the next attempt does not restart from zero. OCP would host an
**in-process MCP server** exposing the client's declared tools, pass it via `--mcp-config`, and
then, when the CLI calls one:

1. suspend the CLI turn,
2. emit an OpenAI `tool_calls` delta and close the HTTP response with `finish_reason: "tool_calls"`,
3. keep the suspended CLI process alive, keyed by conversation,
4. on the client's next request — carrying `role:"tool"` — answer the pending MCP call and resume.

Step 3 is the hard one. It turns a stateless endpoint into a stateful one holding live child
processes across requests, with all the eviction, timeout, crash-recovery and concurrency questions
that implies, on a proxy whose current design deliberately spawns one short-lived child per
request. It also needs an MCP server implementation OCP does not have.

That is a feature with its own ADR, its own risk surface, and its own review. It is not this one.

## Decision

**OCP does not implement OpenAI tool calling. It refuses exactly the requests it would otherwise
answer incorrectly, and leaves the rest untouched.**

The line is drawn where the specification draws it:

| `tool_choice` | spec requires | OCP |
|---|---|---|
| absent / `"auto"` | model **may** call a tool; text is a legal outcome | **unchanged** — text answer, `finish_reason: "stop"` |
| `"none"` | model must **not** call a tool | **unchanged** — satisfied trivially |
| `"required"` | model **must** call a tool; `finish_reason: "tool_calls"` | **400**, `code: "unsupported_parameter"`, `param: "tool_choice"` |
| `{type:"function", …}` | model **must** call that function | **400**, same shape |

`tools` alone never triggers a refusal. A permissive tool list plus a text answer is a
spec-conformant exchange, and refusing it would break every client that offers tools and is content
without them — which is most of them, including OpenClaw, whose every turn carries a tool list.
Refusing on `tools` would have converted a silent wrongness into a loud outage.

## Consequences

- A client that **forces** a call now learns immediately, in the spec's own error shape
  (`error.code = "unsupported_parameter"`, `error.param = "tool_choice"`), and can fall back to
  another provider or retry with `"auto"`. Before, it could not detect the failure at all.
- A client that merely **offers** tools sees no change whatsoever. Nothing that works today breaks.
- OCP still cannot do what a caller with `tool_choice: "auto"` might reasonably hope for. That
  remains true. README § "Client-tools boundary" already documented it — "they never get
  `tool_calls` to execute locally" — and this change extends that section with the new 400
  contract, which is the part a client author could not previously read anywhere.
- **The cost, stated plainly:** the most common real-world case — a client that offers tools and
  genuinely wants them used — is still answered with prose and no signal. This ADR does not fix
  that. It removes the class of failure where OCP's answer contradicts an explicit instruction,
  and is honest that the larger gap remains.
- If tool calling is implemented later, this refusal is the natural thing to delete, and the table
  above is the acceptance criteria for the replacement.

## Alternatives considered

**Refuse whenever `tools` is present.** Simplest and unambiguous, and it would have taken down
every OpenClaw agent on the maintainer's fleet on the same day it shipped — they all send tools and
all accept text. Rejected: it trades a silent wrongness for a loud breakage of working setups, and
the spec does not support it.

**Emit the CLI's own `tool_use` blocks as `tool_calls`.** Wrong behaviour, not partial behaviour —
see above. It would instruct clients to execute the CLI's internal filesystem and shell operations.

**Add a warning field to the response.** No such field exists in the specification, and inventing
one is exactly the anti-invention discipline ADR 0006 binds B.1 surface with.

**Do nothing, document it.** The status quo. Rejected because the documented-but-silent case is
precisely the one that consumed a production outage's worth of diagnosis: nobody reads the docs
when every signal is green.

## References

- Issue #311 — the report, the reproduction, and the confirmed downstream impact
- [ADR 0006](0006-openai-shim-scope.md) — Class B.1 scope; OpenAI's spec is the authority, and
  anti-invention binds it the way `cli.js` binds Class A
- `lib/tool-support.mjs` — the classifier and the spec split it encodes
- Claude Code CLI 2.1.220 `--help` — the tool-related flags, none of which delegate execution
