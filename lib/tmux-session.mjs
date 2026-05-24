// lib/tmux-session.mjs
// Runs Claude Code in interactive TUI mode via a tmux session.
//
// Why not `claude -p`?
// Anthropic's 2026-06-15 billing change moves `claude -p` (non-interactive /
// Agent SDK usage) into a separate credit pool with a hard monthly cap. The
// interactive TUI mode stays within the normal subscription.  By routing OCP
// requests through a tmux-hosted TUI session we stay on the subscription path
// while retaining full tool access and the hook-enforced JSON contract.
//
// JSON contract enforcement (see .claude/hooks/):
//   UserPromptSubmit  — injects the output-contract instruction into every prompt.
//   Stop              — blocks the session from stopping until result.json exists
//                       and passes `jq -e`.  Claude is forced to fix any invalid
//                       output before the session can end.

import { randomUUID }          from "node:crypto";
import { execFileSync }        from "node:child_process";
import { mkdirSync, existsSync,
         readFileSync, rmSync,
         writeFileSync }       from "node:fs";
import { fileURLToPath }       from "node:url";
import { dirname, join }       from "node:path";

const __dir   = dirname(fileURLToPath(import.meta.url));
const OCP_CWD = join(__dir, ".."); // /opt/ocp

const CLAUDE_BIN      = process.env.CLAUDE_BIN || "/usr/local/bin/claude";
const POLL_MS         = 300;
const READY_TIMEOUT   = 15_000;
const TMUX_WIDTH      = "220";
const TMUX_HEIGHT     = "50";
// Max concurrent TUI sessions — each holds a tmux pane + claude process.
const MAX_TUI_SESSIONS = parseInt(process.env.CLAUDE_MAX_TUI || "4", 10);
let _activeSessions = 0;

// ── helpers ────────────────────────────────────────────────────────────────

function tmuxSync(...args) {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── session ready detection ────────────────────────────────────────────────
// Poll until the ❯ prompt is visible and no dialog is blocking.

async function waitForReady(sname) {
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    let pane = "";
    try { pane = tmuxSync("capture-pane", "-t", sname, "-p"); } catch { /* session still starting */ }

    // Auto-dismiss workspace trust dialog ("Is this a project you trust?")
    if (pane.includes("Is this a project") || pane.includes("Yes, I trust this folder")) {
      try { tmuxSync("send-keys", "-t", sname, "1", "Enter"); } catch {}
      await sleep(500);
      continue;
    }

    // Auto-dismiss tool-use permission dialogs ("Do you want to create/edit/run...")
    if (pane.includes("Do you want to") && pane.includes("1. Yes")) {
      try { tmuxSync("send-keys", "-t", sname, "1", "Enter"); } catch {}
      await sleep(300);
      continue;
    }

    if (pane.includes("❯")) return;
    await sleep(300);
  }
  throw new Error(`Claude TUI not ready after ${READY_TIMEOUT}ms (session: ${sname})`);
}

// ── result file polling ────────────────────────────────────────────────────

async function waitForResult(resultFile, timeoutMs, jsonMode) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultFile)) {
      const raw = readFileSync(resultFile, "utf8").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          // json mode: result.json IS the JSON value — return raw string
          // non-json mode: result.json = {"content":"..."} — extract the text
          if (!jsonMode && typeof parsed === "object" && parsed !== null && "content" in parsed) {
            return String(parsed.content);
          }
          return raw;
        } catch { /* written but incomplete — keep polling */ }
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(`result.json not ready within ${timeoutMs}ms: ${resultFile}`);
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * callClaudeTui(prompt, options)
 *
 * Runs Claude Code in interactive TUI mode inside a dedicated tmux session.
 * Returns the contents of result.json as a string (valid JSON guaranteed by
 * the Stop hook contract).
 *
 * @param {string} prompt       — the full text prompt to send
 * @param {object} options
 *   @param {string} model      — Claude model identifier
 *   @param {number} timeoutMs  — per-request timeout (default: 120 000 ms)
 *   @param {string} systemPrompt
 *   @param {boolean} noContext — suppress CLAUDE.md / auto-memory injection
 */
export async function callClaudeTui(prompt, {
  model       = "claude-haiku-4-5-20251001",
  timeoutMs   = 120_000,
  systemPrompt = "",
  noContext   = true,
  jsonMode    = false,   // true → OCP_JSON_MODE=1 in session; hooks enforce result.json
  schema      = null,    // JSON Schema object for json_mode; written to resultDir/schema.json
} = {}) {
  if (_activeSessions >= MAX_TUI_SESSIONS) {
    throw new Error(`TUI session limit reached (${_activeSessions}/${MAX_TUI_SESSIONS}). ` +
      "Increase CLAUDE_MAX_TUI or wait for a session to finish.");
  }

  const requestId  = randomUUID();
  const sname      = `ocp-${requestId.slice(0, 12)}`;
  const resultDir  = `/tmp/ocp-sessions/${requestId}`;
  const resultFile = `${resultDir}/result.json`;
  const wrapScript = `${resultDir}/start.sh`;

  mkdirSync(resultDir, { recursive: true });

  // Write schema.json so the inject hook can include it in the contract
  if (jsonMode && schema) {
    writeFileSync(`${resultDir}/schema.json`, JSON.stringify(schema));
  }

  // Per-request env (written into a wrapper script to avoid tmux quoting hell).
  // Each request gets a unique resultDir so concurrent sessions never share files.
  const envLines = [
    `export OCP_RESULT_DIR="${resultDir}"`,
    `export OCP_RESULT_FILE="${resultFile}"`,
    jsonMode ? 'export OCP_JSON_MODE="1"' : 'export OCP_JSON_MODE="0"',
    noContext ? 'export CLAUDE_CODE_DISABLE_CLAUDE_MDS="1"'  : "",
    noContext ? 'export CLAUDE_CODE_DISABLE_AUTO_MEMORY="1"' : "",
    // Strip API key vars — force OAuth path, same as current OCP behaviour
    "unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN CLAUDECODE",
  ].filter(Boolean).join("\n");

  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--model", model,
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
  ].join(" ");

  writeFileSync(wrapScript,
    `#!/usr/bin/env bash\n${envLines}\nexec "${CLAUDE_BIN}" ${claudeArgs}\n`,
    { mode: 0o700 });

  _activeSessions++;
  try {
    // Spawn the TUI session — each has unique sname/resultDir so concurrent requests
    // never interfere with each other.
    tmuxSync("new-session", "-d", "-s", sname,
      "-x", TMUX_WIDTH, "-y", TMUX_HEIGHT,
      "-c", OCP_CWD,
      "--", "bash", wrapScript);

    await waitForReady(sname);

    // Deliver the prompt
    tmuxSync("send-keys", "-t", sname, prompt, "Enter");

    // Wait for the hook-validated result file
    return await waitForResult(resultFile, timeoutMs, jsonMode);

  } finally {
    _activeSessions--;
    try { tmuxSync("kill-session", "-t", sname); } catch {}
    try { rmSync(resultDir, { recursive: true, force: true }); } catch {}
  }
}
