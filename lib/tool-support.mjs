// lib/tool-support.mjs — issue #311.
//
// OCP accepts `tools` and `tool_choice` on POST /v1/chat/completions and does nothing with them:
// `server.mjs` contains zero occurrences of `tool_calls`, the request fields are never read, and
// the CLI event parser extracts only `type:"text"` blocks. A client that sends tools gets prose
// back with `finish_reason: "stop"`.
//
// Whether that is a defect depends entirely on `tool_choice`, and the OpenAI specification is
// explicit about the split:
//
//   tool_choice absent / "auto"  — the model MAY call a tool. Answering with text is a completely
//                                  legal outcome. OCP's behaviour is spec-conformant, and a client
//                                  written against the spec already handles it.
//   tool_choice "none"           — the model must NOT call a tool. Text is the required outcome.
//                                  OCP satisfies this trivially.
//   tool_choice "required"       — the model MUST call one or more tools, and the response must
//                                  carry finish_reason "tool_calls".
//   tool_choice {type:"function"}— the model MUST call that named function.
//
// For the last two, returning prose with `finish_reason: "stop"` is not a degraded answer, it is a
// WRONG one — and silent, which is the whole harm: no 400, no warning field, and `stop` means "the
// model finished its turn normally", so the client has nothing to branch on. Every health signal
// stays green while the caller's contract is broken.
//
// SCOPE, and why this refuses rather than implements. Emitting real `tool_calls` would require OCP
// to bridge two incompatible models of loop ownership: `claude` runs its OWN agentic loop and
// executes its OWN tools, while OpenAI's protocol is stateless and the CLIENT owns the loop,
// executing each call and returning a `role:"tool"` message. The CLI has no mode that delegates
// execution back to its caller — `--allowedTools` / `--tools` select from its built-ins,
// `--mcp-config` points at servers the CLI itself calls, and `--agents` defines subagents. See
// ADR 0013 for the full analysis and what a real implementation would take.
//
// So the refusal is deliberately NARROW. Refusing whenever `tools` is present would break every
// client that sends a permissive tool list and is perfectly happy with a text answer — which is
// most of them, including OpenClaw, whose every turn carries tools. This refuses exactly the
// requests the spec says OCP is currently answering incorrectly, and stays silent everywhere its
// behaviour is legal.

/**
 * Decide whether a /v1/chat/completions body asks for something OCP cannot honour.
 *
 * Returns `{ supported: true }`, or `{ supported: false, parameter, message }` describing the
 * single parameter that cannot be satisfied. Never throws: a malformed `tool_choice` is not this
 * function's problem to police, and treating it as "supported" leaves the pre-existing behaviour
 * unchanged rather than inventing a new rejection.
 */
// Shared tail of every refusal message. One string, so the four doors below cannot drift into
// four subtly different explanations of the same limitation.
const WHY =
  `OCP cannot return tool_calls — it forwards to the Claude Code CLI, which runs its own agentic ` +
  `loop and executes its own tools rather than handing calls back to the caller. Refusing here ` +
  `rather than returning prose with finish_reason "stop", which would be a silently wrong answer ` +
  `to a request the OpenAI specification says must produce finish_reason "tool_calls". Retry with ` +
  `tool_choice "auto" (or omit it) to receive a text completion, or use a provider that implements ` +
  `tool calling. See ADR 0013.`;

const refuse = (parameter, what) => ({ supported: false, parameter, message: `${what}, and ${WHY}` });

export function classifyToolRequest(parsed) {
  // The DEPRECATED-but-still-accepted forcing form, checked first because it lives on a different
  // field entirely and would otherwise sail past every tool_choice arm below. Per the SDK's own
  // contract: `function_call?: 'none' | 'auto' | ChatCompletionFunctionCallOption`, where
  // "specifying a particular function via {"name": "my_function"} forces the model to call that
  // function". Found by cross-vendor review (codex) reading the installed SDK types, not from
  // memory — the first draft of this file refused two of the four doors and left this one open.
  const fnCall = parsed?.function_call;
  if (fnCall && typeof fnCall === "object" && typeof fnCall.name === "string") {
    return refuse("function_call", `function_call forces a call to "${fnCall.name}"`);
  }

  const choice = parsed?.tool_choice;
  if (choice === undefined || choice === null) return { supported: true };

  // Strings: "none" and "auto" are both satisfiable by a text answer. "required" is not.
  if (typeof choice === "string") {
    if (choice === "required") {
      return refuse("tool_choice", `tool_choice: "required" asks this model to call a tool`);
    }
    return { supported: true };
  }

  if (typeof choice === "object") {
    // {type: "function", function: {name}} — forces one named function.
    if (choice.type === "function") {
      return refuse("tool_choice", `tool_choice forces a call to "${choice.function?.name ?? "(unnamed)"}"`);
    }
    // {type: "custom", custom: {name}} — the custom-tool sibling of the above. Same obligation.
    if (choice.type === "custom") {
      return refuse("tool_choice", `tool_choice forces a call to the custom tool "${choice.custom?.name ?? "(unnamed)"}"`);
    }
    // {type: "allowed_tools", allowed_tools: {mode}} — `mode: "required"` "requires the model to
    // call one or more of the allowed tools" (SDK doc comment); `mode: "auto"` only CONSTRAINS the
    // set the model may pick from and still permits a text answer, so it is left alone. Refusing
    // the auto case would break a client that is merely narrowing its tool list.
    if (choice.type === "allowed_tools") {
      if (choice.allowed_tools?.mode === "required") {
        return refuse("tool_choice", `tool_choice allowed_tools.mode "required" requires a call to one of the allowed tools`);
      }
      return { supported: true };
    }
  }

  // Anything else (including a malformed object, or a forcing form added to the spec after this
  // was written) is left alone — see the doc comment. A future unknown `type` erring toward
  // "supported" preserves today's behaviour rather than inventing a rejection; the cost is that a
  // new forcing form would be silently wrong until this list is extended, which is the trade this
  // file's own history says to make explicit rather than assume.
  return { supported: true };
}
