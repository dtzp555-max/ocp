// OpenAI tool calling over a stateless MCP bridge (ADR 0022). Pure helpers; no I/O, no process.
//
// THE SHAPE, in one paragraph, because every function below is one step of it. A client sends
// `tools` on /v1/chat/completions. server.mjs writes those tools to a file, writes an `--mcp-config`
// that points `claude` at lib/mcp-bridge.mjs with that file, and spawns with the built-in schema
// EMPTIED (`--tools ""`) so the model holds exactly the client's tools -- which is what the OpenAI
// contract says it holds. When the model emits a `tool_use` for one of them, server.mjs ends the
// spawn and answers the request with `tool_calls` and `finish_reason: "tool_calls"`. The client runs
// the tool and sends the whole history back, including its `tool` message; server.mjs renders that
// history as text into the next spawn's prompt, and the model either answers or calls again. Every
// request is still one short-lived child. Nothing is held across requests.
//
// What was MEASURED before this shape was chosen (2026-09-13, claude 2.1.260, haiku):
//   * `--mcp-config` + `--strict-mcp-config` puts the bridge's tools in the `system`/`init` event's
//     schema (`mcp_servers: [{name:"ocp", status:"connected"}]`), and a request that needs one
//     produces an `assistant` event whose content carries `tool_use` with the arguments already as
//     JSON. That event precedes the MCP dispatch.
//   * Feeding the prior `tool_use`/`tool_result` back as REAL content blocks over
//     `--input-format stream-json` does NOT work: the CLI treats only `user` lines as turns, the
//     injected assistant turn is dropped, and the model re-calls the tool from scratch without ever
//     seeing the result. Ruled out.
//   * Rendering the same history as TEXT in the prompt works: the model answered from the supplied
//     result in one turn with zero tool calls. That is what `renderToolTurn` does.
//   * On 2.1.260, MCP tools were DEFERRED in the CLI's schema and the first call in a turn was
//     preceded by a `ToolSearch` turn resolving the name. On 2.1.270 the PR's reviewer measured the
//     bridged tool listed directly in the init event and called first, with 1 tool and with 25 --
//     no ToolSearch. So this is a per-version observation, not a cost of the design.

// The prefix `claude` puts on every tool the bridge serves: `mcp__<server name>__<tool>`, and the
// server is registered as "ocp" in the config server.mjs writes. lib/mcp-bridge.mjs repeats the
// literal so it can stay import-free; the suite pins that the two agree.
export const TOOL_PREFIX = "mcp__ocp__";
export const BRIDGE_SERVER_NAME = "ocp";

// OpenAI's own constraint on `function.name` (spec: "a-z, A-Z, 0-9, or contain underscores and
// dashes, with a maximum length of 64"). MCP tool names have the same alphabet, so a name that
// passes here survives the round trip through the bridge unchanged.
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// Validate the client's `tools` array before anything is written to disk. Returns null when
// acceptable, else a string suitable for a 400 body. Deliberately strict: a name the bridge would
// have to mangle is refused rather than mangled, because the client will not recognise a mangled
// name coming back in `tool_calls`.
export function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "'tools' must be a non-empty array";
  const seen = new Set();
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (!t || typeof t !== "object") return `tools[${i}] must be an object`;
    if (t.type !== "function") return `tools[${i}].type must be "function" (got ${JSON.stringify(t.type)})`;
    const f = t.function;
    if (!f || typeof f !== "object") return `tools[${i}].function must be an object`;
    if (typeof f.name !== "string" || !NAME_RE.test(f.name)) {
      return `tools[${i}].function.name must match ${NAME_RE} (got ${JSON.stringify(f.name)})`;
    }
    if (seen.has(f.name)) return `tools[${i}].function.name ${JSON.stringify(f.name)} is declared twice`;
    seen.add(f.name);
    if (f.parameters !== undefined && (f.parameters === null || typeof f.parameters !== "object" || Array.isArray(f.parameters))) {
      return `tools[${i}].function.parameters must be a JSON Schema object`;
    }
  }
  return null;
}

export function toMcpToolName(name) { return TOOL_PREFIX + name; }
export function fromMcpToolName(name) {
  return typeof name === "string" && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : null;
}

// From one stream-json `assistant` event, the bridge tool calls the model made in that message.
// Returns null when there are none -- including for the CLI's own tools (`ToolSearch`, which the
// model uses to resolve a deferred MCP tool before calling it) and for any MCP tool that is not
// ours. Returns every bridge call in the message, because a model can emit several `tool_use`
// blocks in one turn and OpenAI's `tool_calls` is an array for exactly that reason.
export function extractBridgeToolUses(event) {
  if (!event || event.type !== "assistant") return null;
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return null;
  const uses = [];
  for (const b of blocks) {
    if (!b || b.type !== "tool_use") continue;
    const name = fromMcpToolName(b.name);
    if (name === null) continue;
    uses.push({ id: typeof b.id === "string" ? b.id : null, name, input: b.input ?? {} });
  }
  return uses.length ? uses : null;
}

// The text the model wrote in the same message as its tool calls, if any. OpenAI allows `content`
// alongside `tool_calls`, and a model that says "let me look that up" before calling should have
// that sentence delivered rather than dropped.
export function extractAssistantText(event) {
  const blocks = event?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

// Claude's `tool_use` -> OpenAI `tool_calls[]`. `arguments` is a JSON STRING per the OpenAI spec,
// not an object -- a client that does `JSON.parse(call.function.arguments)` must find a string.
// The id is passed through when the CLI gave one (`toolu_...`), else minted; the client echoes it
// back as `tool_call_id`, and it is the only thing that lets `renderToolTurn` pair a result with
// the call that produced it.
export function toolUsesToOpenAI(uses, mintId) {
  return uses.map((u) => ({
    id: u.id || mintId(),
    type: "function",
    function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
  }));
}

// Render the tool half of an OpenAI conversation as text for the prompt. Two message shapes:
//
//   { role: "assistant", content?, tool_calls: [{ id, function: { name, arguments } }] }
//   { role: "tool", tool_call_id, content }
//
// Returns { text } for the shape it renders, or null if the message is neither -- in which case
// messagesToPrompt renders it as before. `callNames` maps tool_call_id -> function name across the
// whole conversation, so a `tool` message can name the tool it answers; callers pass one Map per
// prompt and let this function fill it as it walks the assistant messages.
//
// The wording is not decorative. It tells the model three things it cannot otherwise know: that
// the call already happened (so it does not repeat it), that the client executed it (so the result
// is authoritative), and what the result was. The closing instruction is what turned a re-call into
// a direct answer in the measurement above.
export function renderToolTurn(m, callNames) {
  if (!m || typeof m !== "object") return null;
  if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
    const lines = [];
    // The spec allows assistant `content` as a string OR an array of text parts (or null). Take
    // the parts too -- an earlier revision took only the string and dropped "let me check" text that
    // arrived as an array, measured by the PR's reviewer.
    const text = (typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === "string") ? p.text : "").join("")
      : "").trim();
    if (text) lines.push(`[Assistant] ${text}`);
    for (const c of m.tool_calls) {
      const name = c?.function?.name;
      if (typeof name !== "string") continue;
      if (typeof c.id === "string") callNames.set(c.id, name);
      const args = typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {});
      lines.push(`[Assistant called tool ${name} with arguments ${args}]`);
    }
    return { text: lines.join("\n") };
  }
  if (m.role === "tool") {
    const name = (typeof m.tool_call_id === "string" && callNames.get(m.tool_call_id)) || m.name || "tool";
    const body = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === "string") ? p.text : "").join("")
      : m.content == null ? "" : JSON.stringify(m.content);
    return { text: `[Tool ${name} returned]\n${body}` };
  }
  return null;
}

// The instruction appended once, after the last rendered tool result, so the model treats the
// results as already obtained. Exported so the test can pin its presence behaviourally.
export const TOOL_CONTINUATION_NOTE =
  "[The tool calls above were made by you and executed by the client; their results are final. " +
  "Continue from here: if the results are enough, answer the user directly. Only call a tool again " +
  "if you need something not already returned above.]";

// True when the conversation's LAST non-system message is a tool result -- i.e. this request is the
// client handing results back, and the continuation note belongs at the end of the prompt.
export function endsWithToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const r = messages[i]?.role;
    if (r === "system") continue;
    return r === "tool";
  }
  return false;
}

// The `--mcp-config` document. `command`/`args` launch lib/mcp-bridge.mjs with the running node
// binary; `env` carries only the tools-file path. No inheritance of anything else is implied here
// -- the CLI merges the spawn's environment itself.
export function buildBridgeConfig({ nodeBin, bridgeScript, toolsFile }) {
  return {
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        command: nodeBin,
        args: [bridgeScript],
        env: { OCP_TOOLS_FILE: toolsFile },
      },
    },
  };
}
