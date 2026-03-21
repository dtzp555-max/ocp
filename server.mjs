#!/usr/bin/env node
/**
 * openclaw-claude-proxy v2.2.0 — OpenAI-compatible proxy for Claude CLI
 *
 * Translates OpenAI chat/completions requests into `claude -p` CLI calls,
 * letting you use your Claude Pro/Max subscription as an OpenClaw model provider.
 *
 * v2.0.0 highlights:
 *   - On-demand spawning: eliminates pool crash loops from v1.x
 *   - Session management: --resume support reduces token waste on multi-turn
 *   - Full tool access: configurable allowedTools (expanded defaults)
 *   - System prompt & MCP config pass-through
 *   - Concurrency control with queuing
 *   - Coexists safely with Claude Code interactive mode (Telegram, IDE, etc.)
 *
 * Env vars:
 *   CLAUDE_PROXY_PORT        — listen port (default: 3456)
 *   CLAUDE_BIN               — path to claude binary (default: auto-detect)
 *   CLAUDE_TIMEOUT           — per-request timeout in ms (default: 120000)
 *   CLAUDE_FIRST_BYTE_TIMEOUT — abort if no stdout within this ms (default: 30000)
 *   CLAUDE_ALLOWED_TOOLS     — comma-separated tools to allow (default: expanded set)
 *   CLAUDE_SKIP_PERMISSIONS  — "true" to bypass all permission checks (default: false)
 *   CLAUDE_SYSTEM_PROMPT     — system prompt appended to all requests
 *   CLAUDE_MCP_CONFIG        — path to MCP server config JSON file
 *   CLAUDE_SESSION_TTL       — session TTL in ms (default: 3600000 = 1h)
 *   CLAUDE_MAX_CONCURRENT    — max concurrent claude processes (default: 5)
 *   PROXY_API_KEY            — Bearer token for API auth (optional)
 */
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

// ── Resolve claude binary ───────────────────────────────────────────────
// Priority: CLAUDE_BIN env > well-known paths > which lookup
// Fail-fast if not found — never start with an unresolvable binary.
function resolveClaude() {
  if (process.env.CLAUDE_BIN) {
    try {
      accessSync(process.env.CLAUDE_BIN, constants.X_OK);
      return process.env.CLAUDE_BIN;
    } catch {
      console.error(`FATAL: CLAUDE_BIN="${process.env.CLAUDE_BIN}" is set but not executable.`);
      process.exit(1);
    }
  }

  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
    join(process.env.HOME || "", ".local/bin/claude"),
  ];
  for (const p of candidates) {
    try { accessSync(p, constants.X_OK); console.warn(`[init] CLAUDE_BIN not set, resolved to ${p}`); return p; } catch {}
  }

  try {
    const resolved = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 5000 }).trim();
    if (resolved) { console.warn(`[init] CLAUDE_BIN not set, resolved via which: ${resolved}`); return resolved; }
  } catch {}

  console.error(
    "FATAL: claude binary not found.\n" +
    "  Set CLAUDE_BIN=/path/to/claude or ensure claude is in PATH.\n" +
    "  Checked: " + candidates.join(", ")
  );
  process.exit(1);
}

// ── Configuration ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10);
const CLAUDE = resolveClaude();
const TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "120000", 10);
const FIRST_BYTE_TIMEOUT = parseInt(process.env.CLAUDE_FIRST_BYTE_TIMEOUT || "30000", 10);
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const SKIP_PERMISSIONS = process.env.CLAUDE_SKIP_PERMISSIONS === "true";
const ALLOWED_TOOLS = (process.env.CLAUDE_ALLOWED_TOOLS ||
  "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent"
).split(",").map(s => s.trim()).filter(Boolean);
const SYSTEM_PROMPT = process.env.CLAUDE_SYSTEM_PROMPT || "";
const MCP_CONFIG = process.env.CLAUDE_MCP_CONFIG || "";
const SESSION_TTL = parseInt(process.env.CLAUDE_SESSION_TTL || "3600000", 10);
const MAX_CONCURRENT = parseInt(process.env.CLAUDE_MAX_CONCURRENT || "5", 10);

const VERSION = _pkg.version;
const START_TIME = Date.now();

// ── Model mapping ───────────────────────────────────────────────────────
// Maps request model IDs and aliases to canonical claude CLI model IDs.
const MODEL_MAP = {
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-opus-4": "claude-opus-4-6",
  "claude-haiku-4": "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  "opus": "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "haiku": "claude-haiku-4-5-20251001",
};

const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
];

// ── Session management ──────────────────────────────────────────────────
// Maps conversation IDs (from caller) to Claude CLI session UUIDs.
// Enables --resume for multi-turn conversations, reducing token waste.
const sessions = new Map(); // conversationId → { uuid, messageCount, lastUsed, model }

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL) {
      sessions.delete(id);
      console.log(`[session] expired ${id.slice(0, 12)}... (idle ${Math.round((now - s.lastUsed) / 60000)}m)`);
    }
  }
}, 60000);

// ── Stats & diagnostics ─────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  activeRequests: 0,
  errors: 0,
  timeouts: 0,
  sessionHits: 0,
  sessionMisses: 0,
  oneOffRequests: 0,
};
const recentErrors = []; // last 20 errors

function trackError(msg) {
  stats.errors++;
  recentErrors.push({ time: new Date().toISOString(), message: String(msg).slice(0, 200) });
  if (recentErrors.length > 20) recentErrors.shift();
}

// ── Auth health check ───────────────────────────────────────────────────
let authStatus = { ok: null, lastCheck: 0, message: "" };

async function checkAuth() {
  try {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    execFileSync(CLAUDE, ["auth", "status"], { encoding: "utf8", timeout: 10000, env });
    authStatus = { ok: true, lastCheck: Date.now(), message: "authenticated" };
  } catch (e) {
    const msg = (e.stderr || e.message || "").slice(0, 200);
    authStatus = { ok: false, lastCheck: Date.now(), message: msg };
    console.error(`[auth] check failed: ${msg}`);
  }
}

// Check auth on start and every 10 minutes
checkAuth();
setInterval(checkAuth, 600000);

// ── Build CLI arguments ─────────────────────────────────────────────────
function buildCliArgs(cliModel, sessionInfo) {
  const args = ["-p", "--model", cliModel, "--output-format", "text"];

  // Session handling
  if (sessionInfo?.resume) {
    args.push("--resume", sessionInfo.uuid);
  } else if (sessionInfo?.uuid) {
    args.push("--session-id", sessionInfo.uuid);
  } else {
    args.push("--no-session-persistence");
  }

  // Permissions
  if (SKIP_PERMISSIONS) {
    args.push("--dangerously-skip-permissions");
  } else if (ALLOWED_TOOLS.length > 0) {
    args.push("--allowedTools", ...ALLOWED_TOOLS);
  }

  // System prompt
  if (SYSTEM_PROMPT) {
    args.push("--append-system-prompt", SYSTEM_PROMPT);
  }

  // MCP config
  if (MCP_CONFIG) {
    args.push("--mcp-config", MCP_CONFIG);
  }

  return args;
}

// ── Format messages to prompt text ──────────────────────────────────────
function messagesToPrompt(messages) {
  return messages.map((m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m.role === "system") return `[System] ${text}`;
    if (m.role === "assistant") return `[Assistant] ${text}`;
    return text;
  }).join("\n\n");
}

// ── Call claude CLI ─────────────────────────────────────────────────────
// On-demand spawning: each request spawns a fresh `claude -p` process.
// No pool = no crash loops, no stale workers, no degraded states.
// Stdin is written immediately so there's no 3s stdin timeout issue.
function callClaude(model, messages, conversationId) {
  return new Promise((resolve, reject) => {
    if (stats.activeRequests >= MAX_CONCURRENT) {
      return reject(new Error(`concurrency limit reached (${stats.activeRequests}/${MAX_CONCURRENT})`));
    }
    stats.activeRequests++;
    stats.totalRequests++;

    const cliModel = MODEL_MAP[model] || model;
    let sessionInfo = null;
    let prompt;

    // ── Session logic ──
    if (conversationId && sessions.has(conversationId)) {
      // Resume existing session: only send the latest user message
      const session = sessions.get(conversationId);
      session.lastUsed = Date.now();
      sessionInfo = { uuid: session.uuid, resume: true };
      stats.sessionHits++;

      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      prompt = lastUserMsg
        ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
        : "";
      session.messageCount = messages.length;

      console.log(`[session] resume conv=${conversationId.slice(0, 12)}... uuid=${session.uuid.slice(0, 8)}... msgs=${messages.length} prompt_chars=${prompt.length}`);

    } else if (conversationId) {
      // New session: send all messages, persist session for future --resume
      const uuid = randomUUID();
      sessions.set(conversationId, { uuid, messageCount: messages.length, lastUsed: Date.now(), model: cliModel });
      sessionInfo = { uuid, resume: false };
      stats.sessionMisses++;
      prompt = messagesToPrompt(messages);

      console.log(`[session] new conv=${conversationId.slice(0, 12)}... uuid=${uuid.slice(0, 8)}... msgs=${messages.length}`);

    } else {
      // One-off request, no session
      stats.oneOffRequests++;
      prompt = messagesToPrompt(messages);
    }

    const cliArgs = buildCliArgs(cliModel, sessionInfo);

    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const proc = spawn(CLAUDE, cliArgs, { env, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const t0 = Date.now();
    let settled = false;
    let gotFirstByte = false;

    function settle(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(firstByteTimer);
      stats.activeRequests--;

      if (err) {
        trackError(err.message || String(err));

        // If session resume failed, remove session so next request starts fresh
        if (sessionInfo?.resume && conversationId) {
          console.warn(`[session] resume failed for ${conversationId.slice(0, 12)}..., removing stale session`);
          sessions.delete(conversationId);
        }

        reject(err);
      } else {
        resolve(result);
      }
    }

    proc.stdout.on("data", (d) => {
      if (!gotFirstByte) {
        gotFirstByte = true;
        clearTimeout(firstByteTimer);
        console.log(`[claude] first-byte model=${cliModel} elapsed=${Date.now() - t0}ms`);
      }
      stdout += d;
    });
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      const elapsed = Date.now() - t0;
      if (code !== 0) {
        console.error(`[claude] exit=${code} model=${cliModel} elapsed=${elapsed}ms stderr=${stderr.slice(0, 500)}`);
        settle(new Error(stderr.slice(0, 300) || stdout.slice(0, 300) || `claude exit ${code}`));
      } else {
        console.log(`[claude] ok model=${cliModel} chars=${stdout.length} elapsed=${elapsed}ms session=${conversationId ? conversationId.slice(0, 12) + "..." : "none"}`);
        settle(null, stdout.trim());
      }
    });

    proc.on("error", (err) => {
      console.error(`[claude] spawn error: ${err.message}`);
      settle(err);
    });

    // Write prompt to stdin immediately — no idle timeout issue
    proc.stdin.write(prompt);
    proc.stdin.end();

    console.log(`[claude] spawned model=${cliModel} prompt_chars=${prompt.length} session=${conversationId ? conversationId.slice(0, 12) + "..." : "none"}`);

    // First-byte timeout: abort early if Claude CLI produces no output
    const firstByteTimer = setTimeout(() => {
      if (!gotFirstByte) {
        stats.timeouts++;
        console.error(`[claude] first-byte timeout after ${FIRST_BYTE_TIMEOUT}ms model=${cliModel} — aborting`);
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
        settle(new Error(`first-byte timeout after ${FIRST_BYTE_TIMEOUT}ms`));
      }
    }, FIRST_BYTE_TIMEOUT);

    // Overall request timeout with graceful kill
    const timer = setTimeout(() => {
      stats.timeouts++;
      console.error(`[claude] timeout after ${TIMEOUT}ms model=${cliModel}`);
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      settle(new Error(`timeout after ${TIMEOUT}ms`));
    }, TIMEOUT);
  });
}

// ── Response helpers ────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamResponse(res, id, model, content) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  for (let i = 0; i < content.length; i += 500) {
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: content.slice(i, i + 500) }, finish_reason: null }],
    });
  }
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function completionResponse(res, id, model, content) {
  jsonResponse(res, 200, {
    id, object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

// ── Handle chat completions ─────────────────────────────────────────────
async function handleChatCompletions(req, res) {
  let body = "";
  for await (const chunk of req) body += chunk;

  let parsed;
  try { parsed = JSON.parse(body); } catch { return jsonResponse(res, 400, { error: "Invalid JSON" }); }

  const messages = parsed.messages || parsed.input || [{ role: "user", content: parsed.prompt || "" }];
  const model = parsed.model || "claude-sonnet-4-6";
  const stream = parsed.stream;

  // Session ID: from request body, header, or null (one-off)
  const conversationId = parsed.session_id || parsed.conversation_id || req.headers["x-session-id"] || req.headers["x-conversation-id"] || null;

  if (!messages?.length) return jsonResponse(res, 400, { error: "messages required" });

  try {
    const content = await callClaude(model, messages, conversationId);
    const id = `chatcmpl-${randomUUID()}`;

    if (stream) {
      streamResponse(res, id, model, content);
    } else {
      completionResponse(res, id, model, content);
    }
  } catch (err) {
    console.error(`[proxy] error: ${err.message}`);
    if (res.headersSent || res.writableEnded || res.destroyed) {
      try { res.end(); } catch {}
      return;
    }
    jsonResponse(res, 500, { error: { message: err.message, type: "proxy_error" } });
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Bearer token auth (skip for /health and when PROXY_API_KEY is not set)
  if (PROXY_API_KEY && req.url !== "/health") {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== PROXY_API_KEY) {
      return jsonResponse(res, 401, { error: { message: "Unauthorized: invalid or missing Bearer token", type: "auth_error" } });
    }
  }

  // GET /v1/models
  if (req.url === "/v1/models" && req.method === "GET") {
    return jsonResponse(res, 200, {
      object: "list",
      data: MODELS.map((m) => ({
        id: m.id, object: "model", owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      })),
    });
  }

  // POST /v1/chat/completions
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  // GET /health — comprehensive diagnostics
  if (req.url === "/health") {
    let binaryOk = false;
    try { accessSync(CLAUDE, constants.X_OK); binaryOk = true; } catch {}

    const uptimeMs = Date.now() - START_TIME;
    const sessionList = [];
    for (const [id, s] of sessions) {
      sessionList.push({
        id: id.slice(0, 12) + "...",
        model: s.model,
        messages: s.messageCount,
        idleMs: Date.now() - s.lastUsed,
      });
    }

    return jsonResponse(res, 200, {
      status: binaryOk && authStatus.ok !== false ? "ok" : "degraded",
      version: VERSION,
      architecture: "on-demand (v2)",
      uptime: uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`,
      claudeBinary: CLAUDE,
      claudeBinaryOk: binaryOk,
      auth: authStatus,
      config: {
        timeout: TIMEOUT,
        firstByteTimeout: FIRST_BYTE_TIMEOUT,
        maxConcurrent: MAX_CONCURRENT,
        sessionTTL: SESSION_TTL,
        allowedTools: SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS,
        systemPrompt: SYSTEM_PROMPT ? `${SYSTEM_PROMPT.slice(0, 50)}...` : "(none)",
        mcpConfig: MCP_CONFIG || "(none)",
      },
      stats,
      sessions: sessionList,
      recentErrors: recentErrors.slice(-5),
    });
  }

  // DELETE /sessions — clear all sessions
  if (req.url === "/sessions" && req.method === "DELETE") {
    const count = sessions.size;
    sessions.clear();
    return jsonResponse(res, 200, { cleared: count });
  }

  // GET /sessions — list active sessions
  if (req.url === "/sessions" && req.method === "GET") {
    const list = [];
    for (const [id, s] of sessions) {
      list.push({ id, uuid: s.uuid, model: s.model, messages: s.messageCount, lastUsed: new Date(s.lastUsed).toISOString() });
    }
    return jsonResponse(res, 200, { sessions: list });
  }

  // Catch-all POST
  if (req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health, GET|DELETE /sessions" });
});

// ── Start ───────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`openclaw-claude-proxy v${VERSION} listening on http://0.0.0.0:${PORT}`);
  console.log(`Architecture: on-demand spawning (no pool)`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT}ms (first-byte: ${FIRST_BYTE_TIMEOUT}ms) | Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`Tools: ${SKIP_PERMISSIONS ? "all (skip-permissions)" : ALLOWED_TOOLS.join(", ")}`);
  console.log(`Sessions: TTL=${SESSION_TTL / 1000}s`);
  if (SYSTEM_PROMPT) console.log(`System prompt: "${SYSTEM_PROMPT.slice(0, 80)}..."`);
  if (MCP_CONFIG) console.log(`MCP config: ${MCP_CONFIG}`);
  console.log(`Auth: ${PROXY_API_KEY ? "enabled (PROXY_API_KEY set)" : "disabled (no PROXY_API_KEY)"}`);
  console.log(`---`);
  console.log(`Coexistence: This proxy does NOT conflict with Claude Code interactive mode.`);
  console.log(`  OCP uses: localhost:${PORT} (HTTP) → claude -p (per-request process)`);
  console.log(`  CC uses:  MCP protocol (in-process) → persistent session`);
  console.log(`  Both can run simultaneously on the same machine.`);
});
