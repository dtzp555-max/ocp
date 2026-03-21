#!/usr/bin/env node
/**
 * openclaw-claude-proxy — OpenAI-compatible proxy for Claude CLI
 *
 * Translates OpenAI chat/completions requests into `claude -p` CLI calls,
 * letting you use your Claude Pro/Max subscription as an OpenClaw model provider.
 *
 * Features:
 *   - Process pool: pre-spawns CLI processes to eliminate cold start latency
 *   - SSE streaming + non-streaming responses
 *   - Concurrent request support
 *
 * Env vars:
 *   CLAUDE_PROXY_PORT  — listen port (default: 3456)
 *   CLAUDE_BIN         — path to claude binary (default: "claude")
 *   CLAUDE_TIMEOUT     — per-request timeout in ms (default: 120000)
 *   CLAUDE_FIRST_BYTE_TIMEOUT — abort if no stdout within this ms (default: 30000)
 *   CLAUDE_POOL_SIZE   — warm process pool size per model (default: 0, set >0 to enable pool)
 *   PROXY_API_KEY      — Bearer token for API authentication (optional, if unset auth is disabled)
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

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10);
const CLAUDE = resolveClaude();
const TIMEOUT = parseInt(process.env.CLAUDE_TIMEOUT || "120000", 10);
const FIRST_BYTE_TIMEOUT = parseInt(process.env.CLAUDE_FIRST_BYTE_TIMEOUT || "30000", 10);
const POOL_SIZE = parseInt(process.env.CLAUDE_POOL_SIZE || "0", 10);
const POOL_MAX_IDLE = parseInt(process.env.CLAUDE_POOL_MAX_IDLE || "60000", 10); // max idle time before recycle
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";

const VERSION = _pkg.version;
const START_TIME = Date.now();

// Model alias mapping: request model → claude CLI --model arg
// Maps both shorthand aliases AND full model IDs to the canonical full model ID
// that the claude CLI accepts. Using short names like "sonnet"/"opus"/"haiku"
// causes the CLI to reject the --model arg and crash immediately.
const MODEL_MAP = {
  // Full canonical IDs (pass through as-is)
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  // Short aliases → full canonical IDs
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

// ── Process Pool ──────────────────────────────────────────────────────────
// Pre-spawns `claude -p` processes that read prompts from stdin.
// When a request arrives, we grab a warm process and pipe the prompt in.
// After the process finishes, a new one is spawned to replace it.

const pool = new Map(); // model → [{ proc, ready }]

// Exponential backoff state per model: tracks consecutive fast failures
// to prevent a tight spawn/die loop when workers crash on startup.
// Delays: 2s base, doubled each failure, capped at 60s.
// After 5 consecutive fast crashes (each lived < 10s, all within 60s),
// the model is marked "degraded" and respawning stops entirely.
const poolBackoff = new Map(); // model → { failures: number, timer: TimeoutId|null, degraded: boolean, windowStart: number }

function spawnWarm(cliModel) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const proc = spawn(CLAUDE, [
    "-p", "--model", cliModel,
    "--output-format", "text",
    "--no-session-persistence",
    "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  ], { env, stdio: ["pipe", "pipe", "pipe"] });

  const entry = { proc, cliModel, ready: true, spawnedAt: Date.now() };

  // Capture stderr from pool workers so crash reasons are visible in logs
  let stderrBuf = "";
  proc.stderr.on("data", (d) => {
    stderrBuf += d;
    if (stderrBuf.length > 500) stderrBuf = stderrBuf.slice(-500);
  });

  proc.on("error", (err) => {
    console.error(`[pool] spawn error model=${cliModel}: ${err.message}`);
    entry.ready = false;
  });

  proc.on("exit", (code) => {
    const livedMs = Date.now() - entry.spawnedAt;
    entry.ready = false;

    // Log stderr from crashed pool worker (first 500 chars) to aid debugging
    if (stderrBuf.trim()) {
      console.error(`[pool] worker stderr model=${cliModel} exit=${code} lived=${livedMs}ms: ${stderrBuf.slice(0, 500)}`);
    }

    // If the process survived > 10s, it was healthy — reset the backoff counter and window
    if (livedMs > 10000) {
      const state = poolBackoff.get(cliModel);
      if (state && (state.failures > 0 || state.degraded)) {
        console.log(`[pool] resetting backoff for model=${cliModel} (lived ${livedMs}ms)`);
        state.failures = 0;
        state.degraded = false;
        state.windowStart = Date.now();
      }
    }

    // Remove from pool
    const arr = pool.get(cliModel);
    if (arr) {
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
    }
    // Replenish: treat as crash (apply backoff) only if it died fast (< 10s)
    const isCrash = livedMs <= 10000;
    replenishPool(cliModel, isCrash);
  });

  return entry;
}

// Recycle idle processes to prevent stale connections
function recycleStaleProcesses() {
  const now = Date.now();
  for (const [cliModel, arr] of pool) {
    for (const entry of arr) {
      if (entry.ready && (now - entry.spawnedAt) > POOL_MAX_IDLE) {
        console.log(`[pool] recycling stale process model=${cliModel} (idle ${Math.round((now - entry.spawnedAt) / 1000)}s)`);
        entry.ready = false;
        entry.proc.kill();
        // exit handler will replenish
      }
    }
  }
}

setInterval(recycleStaleProcesses, 15000); // check every 15s

const BACKOFF_BASE_MS = 2000;   // 2s starting delay
const BACKOFF_MAX_MS = 60000;   // 60s ceiling
const CRASH_LIMIT = 5;          // max consecutive fast crashes before degraded
const CRASH_WINDOW_MS = 60000;  // window for counting consecutive fast crashes (60s)

// replenishPool(cliModel, isCrash)
//   isCrash=false → initial or manual fill, no backoff applied
//   isCrash=true  → called from exit handler after a fast crash
function replenishPool(cliModel, isCrash = false) {
  if (!pool.has(cliModel)) pool.set(cliModel, []);
  if (!poolBackoff.has(cliModel)) poolBackoff.set(cliModel, { failures: 0, timer: null, degraded: false, windowStart: Date.now() });

  const arr = pool.get(cliModel);
  const state = poolBackoff.get(cliModel);

  // If this model is degraded (too many consecutive fast crashes), stop respawning
  if (state.degraded) {
    console.error(`[pool] DEGRADED: model=${cliModel} will not be respawned. Restart the proxy to retry.`);
    return;
  }

  const alive = arr.filter((e) => e.ready).length;
  const needed = POOL_SIZE - alive;
  if (needed <= 0) return;

  // Cancel any pending backoff timer for this model before scheduling a new one
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  // Only track failures and apply backoff when this is a crash respawn
  if (!isCrash) {
    // Immediate spawn — no backoff on initial fill or manual replenish
    const currentAlive = arr.filter((e) => e.ready).length;
    const currentNeeded = POOL_SIZE - currentAlive;
    for (let i = 0; i < currentNeeded; i++) {
      const entry = spawnWarm(cliModel);
      arr.push(entry);
      console.log(`[pool] pre-spawned model=${cliModel} (pool size: ${arr.filter(e => e.ready).length})`);
    }
    return;
  }

  // --- Crash path: apply exponential backoff and degraded-state logic ---

  const now = Date.now();

  // Reset window if the last crash was outside the rolling window
  if ((now - state.windowStart) > CRASH_WINDOW_MS) {
    state.windowStart = now;
    state.failures = 0;
  }

  state.failures += 1;

  // Check if we've hit the crash limit within the rolling window
  if (state.failures >= CRASH_LIMIT) {
    state.degraded = true;
    console.error(
      `[pool] DEGRADED: model=${cliModel} crashed ${state.failures} times in ` +
      `${Math.round((now - state.windowStart) / 1000)}s. ` +
      `Stopping respawn to prevent CPU spin. Restart the proxy to retry.`
    );
    return;
  }

  // Exponential backoff: 2s, 4s, 8s, 16s, 32s … capped at 60s
  const delayMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, state.failures - 1), BACKOFF_MAX_MS);
  console.warn(`[pool] backoff model=${cliModel} delay=${delayMs}ms (failures=${state.failures}/${CRASH_LIMIT})`);

  state.timer = setTimeout(() => {
    state.timer = null;
    const currentAlive = arr.filter((e) => e.ready).length;
    const currentNeeded = POOL_SIZE - currentAlive;
    for (let i = 0; i < currentNeeded; i++) {
      const entry = spawnWarm(cliModel);
      arr.push(entry);
      console.log(`[pool] re-spawned model=${cliModel} (pool size: ${arr.filter(e => e.ready).length}, failures=${state.failures}/${CRASH_LIMIT})`);
    }
  }, delayMs);
}

function getWarmProcess(cliModel) {
  const arr = pool.get(cliModel) || [];
  const entry = arr.find((e) => e.ready);
  if (entry) {
    entry.ready = false; // mark as in-use
    const warmMs = Date.now() - entry.spawnedAt;
    console.log(`[pool] using warm process model=${cliModel} (warm for ${warmMs}ms)`);
    return entry.proc;
  }
  return null;
}

// Initialize pool for all models
function initPool() {
  for (const cliModel of new Set(Object.values(MODEL_MAP))) {
    replenishPool(cliModel);
  }
}

// ── Call claude CLI ─────────────────────────────────────────────────────
function callClaude(model, messages) {
  return new Promise((resolve, reject) => {
    const prompt = messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (m.role === "system") return `[System] ${text}`;
        if (m.role === "assistant") return `[Assistant] ${text}`;
        return text;
      })
      .join("\n\n");

    const cliModel = MODEL_MAP[model] || model;

    // Try to use a warm process from the pool
    let proc = getWarmProcess(cliModel);
    let usedPool = !!proc;

    if (!proc) {
      // Cold start fallback: spawn fresh
      console.log(`[pool] no warm process for model=${cliModel}, cold starting...`);
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      proc = spawn(CLAUDE, [
        "-p", "--model", cliModel,
        "--output-format", "text",
        "--no-session-persistence",
        "--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
        "--", prompt,
      ], { env, stdio: ["ignore", "pipe", "pipe"] });
    }

    let stdout = "";
    let stderr = "";
    let gotFirstByte = false;
    const t0 = Date.now();

    proc.stdout.on("data", (d) => {
      if (!gotFirstByte) {
        gotFirstByte = true;
        clearTimeout(firstByteTimer);
        const fbElapsed = Date.now() - t0;
        console.log(`[claude] first-byte model=${cliModel} elapsed=${fbElapsed}ms`);
      }
      stdout += d;
    });
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(firstByteTimer);
      const elapsed = Date.now() - t0;
      if (code !== 0) {
        console.error(`[claude] exit=${code} model=${cliModel} elapsed=${elapsed}ms stderr=${stderr.slice(0, 300)}`);
        reject(new Error(stderr || stdout || `exit ${code}`));
      } else {
        console.log(`[claude] ok model=${cliModel} chars=${stdout.length} elapsed=${elapsed}ms pool=${usedPool}`);
        resolve(stdout.trim());
      }
    });
    proc.on("error", (err) => { clearTimeout(timer); clearTimeout(firstByteTimer); reject(err); });

    // Log prompt size for debugging
    console.log(`[claude] request model=${cliModel} prompt_chars=${prompt.length} pool=${usedPool}`);

    // If using pool process, send prompt via stdin
    if (usedPool) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    // First-byte timeout: abort early if Claude CLI produces no output
    const firstByteTimer = setTimeout(() => {
      if (!gotFirstByte) {
        console.error(`[claude] first-byte timeout model=${cliModel} after ${FIRST_BYTE_TIMEOUT}ms — aborting`);
        proc.kill();
        reject(new Error("first-byte timeout"));
      }
    }, FIRST_BYTE_TIMEOUT);

    // Overall request timeout
    const timer = setTimeout(() => {
      console.error(`[claude] total timeout model=${cliModel} after ${TIMEOUT}ms`);
      proc.kill();
      reject(new Error("timeout"));
    }, TIMEOUT);
  });
}

// ── Response helpers ────────────────────────────────────────────────────
function jsonResponse(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamResponse(res, id, model, content) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const created = Math.floor(Date.now() / 1000);
  // Role chunk
  sendSSE(res, {
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  // Content chunks (~500 chars each)
  for (let i = 0; i < content.length; i += 500) {
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: content.slice(i, i + 500) }, finish_reason: null }],
    });
  }
  // Finish
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

  if (!messages?.length) return jsonResponse(res, 400, { error: "messages required" });

  try {
    const content = await callClaude(model, messages);
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

  // GET /health — includes pool status, version, uptime
  if (req.url === "/health") {
    const poolStatus = {};
    for (const [model, arr] of pool) {
      const readyCount = arr.filter(e => e.ready).length;
      const errorCount = arr.filter(e => !e.ready).length;
      poolStatus[model] = {
        total: arr.length,
        ready: readyCount,
        error: errorCount,
        status: readyCount > 0 ? "ready" : "error",
      };
    }
    const uptimeMs = Date.now() - START_TIME;
    let binaryOk = false;
    try { accessSync(CLAUDE, constants.X_OK); binaryOk = true; } catch {}
    return jsonResponse(res, 200, {
      status: binaryOk ? "ok" : "degraded",
      version: VERSION,
      uptime: uptimeMs,
      uptimeHuman: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
      claudeBinary: CLAUDE,
      claudeBinaryOk: binaryOk,
      timeout: TIMEOUT,
      firstByteTimeout: FIRST_BYTE_TIMEOUT,
      pool: poolStatus,
    });
  }

  // Catch-all: try to handle any POST with messages
  if (req.method === "POST") {
    return handleChatCompletions(req, res);
  }

  jsonResponse(res, 404, { error: "Not found. Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health" });
});

// ── Start ──────────────────────────────────────────────────────────────
initPool();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`openclaw-claude-proxy v${VERSION} listening on http://0.0.0.0:${PORT}`);
  console.log(`Models: ${MODELS.map((m) => m.id).join(", ")}`);
  console.log(`Claude binary: ${CLAUDE}`);
  console.log(`Timeout: ${TIMEOUT}ms (first-byte: ${FIRST_BYTE_TIMEOUT}ms)`);
  console.log(`Pool: ${POOL_SIZE > 0 ? `${POOL_SIZE} per model, max idle: ${POOL_MAX_IDLE / 1000}s` : "disabled (on-demand)"}`);
  console.log(`Auth: ${PROXY_API_KEY ? "enabled (PROXY_API_KEY set)" : "disabled (no PROXY_API_KEY)"}`);
});
