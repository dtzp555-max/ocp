#!/usr/bin/env node
// The MCP stdio server a `-p` spawn talks to when a client declared OpenAI `tools` (ADR 0022).
//
// WHAT IT IS. `claude` launches this process itself, from the `--mcp-config` file server.mjs writes
// for the spawn. It speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and does exactly two
// things: answer `tools/list` with the client's declared tools, so they enter the model's schema
// under the `mcp__ocp__` prefix; and RECEIVE `tools/call` without ever answering it.
//
// WHY IT NEVER ANSWERS `tools/call`. The tool does not exist here. It exists on the CLIENT, which
// will run it and send the result back in its next request. server.mjs learns that the model chose
// a tool from the `tool_use` block in the spawn's own stream-json output -- which arrives BEFORE
// the MCP call is dispatched (measured, 2026-09-13, claude 2.1.260: `assistant` event carrying
// `tool_use`, then this server's `tools/call`, then `user`/`tool_result`) -- and terminates the
// spawn at that point. Answering here with a placeholder was measured to cost one extra model turn
// in which the model narrates that it is "waiting for the bridge", and to race the kill. Not
// answering means the spawn blocks on this call until server.mjs ends it, so there is exactly ONE
// mechanism that concludes a tool turn, and CLAUDE_TIMEOUT remains the backstop for the case where
// server.mjs somehow never sees the event.
//
// WHAT IT READS. `OCP_TOOLS_FILE`: a 0600 file holding the client's `tools` array verbatim, written
// by server.mjs one call before spawn and removed in the spawn's cleanup. Nothing else.
//
// This file is deliberately dependency-free and stdlib-only, and does not import anything from
// server.mjs: it runs as a child of a child, in the spawn's HOME, and must stay startable from
// there with nothing but node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The prefix is repeated here rather than imported so this file has no import edge back into the
// repo. lib/tool-calling.mjs is the single source of truth and a test pins that the two agree.
export const PREFIX = "mcp__ocp__";

// Only run the server when executed directly. The test suite imports this module to pin PREFIX,
// and an import must not read OCP_TOOLS_FILE or exit the importing process.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();

function main() {
const toolsFile = process.env.OCP_TOOLS_FILE;
if (!toolsFile) {
  process.stderr.write("ocp mcp-bridge: OCP_TOOLS_FILE is not set\n");
  process.exit(2);
}
let tools;
try {
  tools = JSON.parse(readFileSync(toolsFile, "utf8"));
  if (!Array.isArray(tools)) throw new Error("not an array");
} catch (e) {
  process.stderr.write(`ocp mcp-bridge: cannot read OCP_TOOLS_FILE: ${e.message}\n`);
  process.exit(2);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ocp-bridge", version: "1" },
      } });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: tools.map((t) => ({
        // The model sees `mcp__ocp__<name>`; the client's own name is restored by server.mjs when
        // the call is turned back into an OpenAI `tool_calls` entry.
        name: t.function.name,
        description: t.function.description || "",
        inputSchema: t.function.parameters || { type: "object", properties: {} },
      })) } });
    } else if (method === "tools/call") {
      // Deliberately no response. See the header.
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
    // notifications (no id) are ignored
  }
});
process.stdin.on("end", () => process.exit(0));
}
