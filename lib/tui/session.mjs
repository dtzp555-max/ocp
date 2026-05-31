// TUI-mode session driver: hosts an interactive `claude` in tmux, submits one
// serialized prompt, awaits the transcript reader, tears down. OCP-specific.
//
// Authority: claude CLI v2.1.158 interactive mode (no -p / no --output-format
// => cc_entrypoint=cli). Submission recipe validated by spikes T3/T6 on PI231.
// See docs/superpowers/specs/2026-05-30-tui-mode-production-design.md.
//
// Trust handling: rather than answer the trust-folder dialog interactively (which
// only appears on a cwd's FIRST encounter — sending a defensive "1" to an already
// trusted cwd would inject a stray prompt turn), we PRE-TRUST the scratch cwd by
// seeding <home>/.claude.json. Every turn then boots dialog-free and identical.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, statSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readTuiTranscript } from "./transcript.mjs";

export const SESSION_PREFIX = "ocp-tui-"; // per-proxy namespace (coexistence rule)
const TMUX = process.env.OCP_TUI_TMUX_BIN || "tmux";

const defaultTmux = (args, opts = {}) =>
  spawnSync(TMUX, args, { encoding: "utf8", ...opts });

// Kill ONLY our own stale sessions. Scoped to SESSION_PREFIX so a co-hosted
// OLP test instance's `olp-tui-*` sessions are never touched.
export function reapStaleTuiSessions({ tmux = defaultTmux } = {}) {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!r || r.status !== 0) return 0; // no tmux server / no sessions
  let killed = 0;
  for (const name of String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
    if (name.startsWith(SESSION_PREFIX)) {
      tmux(["kill-session", "-t", name]);
      killed++;
    }
  }
  return killed;
}

// ── Task 5: runTuiTurn ───────────────────────────────────────────────────

// Boot + paste-settle timing. Conservative defaults validated on PI231; env-tunable.
const BOOT_MS         = parseInt(process.env.OCP_TUI_BOOT_MS  || "4000", 10);
const PASTE_SETTLE_MS = parseInt(process.env.OCP_TUI_PASTE_MS || "1800", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single-quote escaper for sh -c arguments.
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// Pre-trust the scratch cwd by seeding the trust record in <home>/.claude.json so
// the trust-folder dialog never appears. Verified-live trust shape:
//   projects["<cwd>"] = { hasTrustDialogAccepted: true, allowedTools: [], ... }
// Idempotent + best-effort: a missing/unreadable .claude.json must not abort a
// turn (a fresh cwd would then show the dialog once; the boot wait tolerates it).
// Must run BEFORE the session boots so claude reads the trusted record at startup.
export function ensureTuiCwdTrusted(home, cwd) {
  if (!home || !cwd) return;
  const path = `${home}/.claude.json`;
  let j, mode;
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
    mode = statSync(path).mode & 0o777;
  } catch { return; }
  j.projects = j.projects || {};
  const entry = j.projects[cwd] || {};
  if (entry.hasTrustDialogAccepted === true) return; // already trusted, no rewrite
  entry.hasTrustDialogAccepted = true;
  if (!Array.isArray(entry.allowedTools)) entry.allowedTools = [];
  j.projects[cwd] = entry;
  // Atomic write (temp + rename on the same fs), preserving mode, so a crash
  // mid-write can never truncate the user's real ~/.claude.json. We seed ONLY the
  // per-project trust flag — NOT bypassPermissionsModeAccepted: the driver never
  // passes --dangerously-skip-permissions, so the bypass dialog cannot appear, and
  // onboarding completion is an A-path precondition (the host already runs claude).
  // NOTE: when the A-path moves to a dedicated scratch HOME (task #26), this writes
  // a file we fully own, removing the real-config-mutation concern entirely.
  try {
    const tmp = `${path}.ocp-tui.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, 2), { mode });
    renameSync(tmp, path);
  } catch { /* best effort */ }
}

// Prepare the HOME claude runs under. Two modes:
//   - real-home (tuiHome === realHome OR falsy): no isolation; just trust the cwd
//     in the real ~/.claude.json. Opt in by setting OCP_TUI_HOME=$HOME.
//   - scratch-home: a dedicated HOME that reuses the real OAuth via a SYMLINKED
//     .credentials.json, with a seeded .claude.json (onboarded real config minus
//     the user's project history; trusts only the scratch cwd) and its own
//     projects/ dir — so the real ~/.claude is never mutated or polluted.
//
// ⚠️ CREDENTIAL CAVEAT (verified live): claude rewrites .credentials.json on token
// refresh, REPLACING the symlink with a regular-file copy → the scratch home then
// FORKS the OAuth credentials. Because OAuth refresh tokens rotate (single-use), a
// refresh in the scratch home can invalidate the token the user's real-home claude
// relies on. Therefore scratch-home is safe only with a DEDICATED OAuth or for
// ephemeral use; for a shared subscription prefer real-home (tuiHome===realHome),
// which shares one .credentials.json — identical to how OCP already spawns claude.
// Idempotent + best-effort: any failure degrades toward the dialog/cap, never
// corrupts. Run BEFORE the session boots.
export function prepareTuiHome(realHome, tuiHome, cwd) {
  if (!tuiHome || tuiHome === realHome) { ensureTuiCwdTrusted(realHome, cwd); return; }
  try {
    const claudeDir = `${tuiHome}/.claude`;
    mkdirSync(`${claudeDir}/projects`, { recursive: true });
    // Symlink the real credentials (never copy the OAuth token); refresh if missing.
    const link = `${claudeDir}/.credentials.json`;
    if (!existsSync(link)) {
      try { symlinkSync(`${realHome}/.claude/.credentials.json`, link); } catch { /* best effort */ }
    }
    // Seed .claude.json ONCE (if absent): start from the onboarded real config,
    // drop the user's project history, trust only the scratch cwd. mode 0600.
    const seedPath = `${tuiHome}/.claude.json`;
    if (!existsSync(seedPath)) {
      let base = {};
      try { base = JSON.parse(readFileSync(`${realHome}/.claude.json`, "utf8")); } catch { /* fresh */ }
      base.hasCompletedOnboarding = true;
      base.projects = { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } };
      writeFileSync(seedPath, JSON.stringify(base, null, 2), { mode: 0o600 });
    }
  } catch { /* best effort */ }
  // Ensure the cwd is trusted in the scratch config (idempotent; atomic).
  ensureTuiCwdTrusted(tuiHome, cwd);
}

// ── Billing-classifier labeling ─────────────────────────────────────────
// Resolve CLAUDE_CODE_ENTRYPOINT on the spawn env per mode. ALWAYS deletes any
// inherited value first (so a stray entrypoint from OCP's own parent env can never
// leak into / mislabel the billing header). Then:
//   "cli"  (default) → set "cli": deterministic subscription-pool classification.
//          HONEST ONLY because OCP's spawn is a genuine interactive PTY (tmux pane,
//          no -p, stdout not redirected). Never set "cli" on a non-interactive spawn.
//   "auto" → leave unset → claude self-classifies via its t$A (TTY → cli). Use to
//          observe/diagnose the real TTY-derived value.
//   "off"  → leave the env exactly as inherited (diagnostics / honesty audit).
export function resolveTuiEntrypointEnv(env, mode = "cli") {
  if (mode === "off") return env;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (mode === "cli") env.CLAUDE_CODE_ENTRYPOINT = "cli";
  return env;
}

// Build interactive claude argv: NO -p, NO --output-format (=> cc_entrypoint=cli).
// MCP hard-disabled: --strict-mcp-config (no --mcp-config) is the only mechanism
// that stops account-attached managed MCP from connecting (spec §5.2 / T6),
// belt-and-braces with --disallowedTools "mcp__*".
// A-PATH ONLY: built-in tools are left enabled (acceptable single-user). Deployment B
// (guest keys) MUST additionally pass --tools "" per spec §5.2(2) as the credential
// wall before this argv is reachable for owner_tier=guest — guard that in PR-3 wiring.
function buildTuiCmd(claudeBin, model, sessionId) {
  return [
    shq(claudeBin),
    "--model",          shq(model),
    "--session-id",     sessionId,
    "--strict-mcp-config",
    "--disallowedTools", shq("mcp__*"),
  ].join(" ");
}

// Full per-request TUI lifecycle:
//   1. Pre-trust the scratch cwd (no trust dialog will appear).
//   2. Write prompt to a 0600 temp file (no shell injection from prompt content).
//   3. Boot an interactive `claude` in a fresh tmux session in the scratch cwd.
//   4. Submit the prompt via `send-keys -- "$(cat file)"` + a SEPARATE Enter key
//      event (spec §5 / T3: literal "\n" in paste does NOT submit; Enter token does).
//   5. Block on the native JSONL transcript (located by session-id) until terminal
//      marker or wall-clock cap.
//   6. Always teardown: kill session + rm temp dir (even on throw).
export async function runTuiTurn({
  prompt,
  model,
  claudeBin,
  home,
  realHome,
  cwd,
  wallclockMs = 120000,
  entrypointMode = "cli",
  tmux = defaultTmux,
}) {
  const sessionId = randomUUID();
  const tmuxName  = SESSION_PREFIX + sessionId.slice(0, 8);
  const ehome     = home || process.env.HOME;       // HOME claude runs under (scratch or real)
  const rhome     = realHome || process.env.HOME;   // real home (OAuth + onboarded config source)

  // Ensure scratch cwd exists, then prepare the (scratch or real) HOME + trust the
  // cwd — before claude boots.
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  prepareTuiHome(rhome, ehome, cwd);

  // Write prompt to a temp file (mode 0600) so the content never touches argv.
  const tmpDir     = mkdtempSync(`${tmpdir()}/ocp-tui-`);
  const promptFile = `${tmpDir}/prompt.txt`;
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  // Build the env: disable marketplace auto-install, strip any Anthropic / CC
  // env vars that might interfere with interactive-mode classification.
  const env = { ...process.env, CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1" };
  delete env.CLAUDECODE;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.HOME = ehome; // claude reads credentials + writes the transcript under this HOME
  resolveTuiEntrypointEnv(env, entrypointMode);

  try {
    // 1. Boot the interactive session inside tmux, rooted at the scratch cwd.
    //    Capture the result: if tmux new-session fails (status !== 0) there is no
    //    PTY, no interactive spawn — abort BEFORE the boot sleep rather than paste
    //    into a non-existent session or issue a billing request without a verified
    //    interactive context. The finally teardown is still harmless (kill-session
    //    is a no-op when the session never existed).
    const spawnResult = tmux(
      ["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "50", "-c", cwd,
       buildTuiCmd(claudeBin, model, sessionId)],
      { env },
    );
    if (!spawnResult || spawnResult.status !== 0) {
      throw new Error("tui_spawn_failed: tmux session not created");
    }
    await sleep(BOOT_MS);

    // 2. Submit prompt body via `"$(cat file)"` — byte-safe for any content —
    //    then settle, then send a SEPARATE Enter key event to submit the line.
    //
    //    The `-l` (literal) flag is required on the paste send-keys call so that
    //    a prompt that happens to equal a tmux key token (e.g. "C-c", "Escape")
    //    is typed literally as text rather than being interpreted as a key binding.
    //    The SEPARATE Enter event below deliberately omits -l so that tmux sends a
    //    real keypress (carriage return) to submit the prompt line.
    spawnSync(
      "sh",
      ["-c", `${shq(TMUX)} send-keys -t ${shq(tmuxName)} -l -- "$(cat ${shq(promptFile)})"`],
      { env, encoding: "utf8" },
    );
    await sleep(PASTE_SETTLE_MS);
    tmux(["send-keys", "-t", tmuxName, "Enter"]);

    // 3. Block on the native transcript (resolved by session-id) until terminal.
    return await readTuiTranscript({ home: ehome, sessionId, wallclockMs });
  } finally {
    // 4. Teardown — always, even on throw.
    try { tmux(["kill-session", "-t", tmuxName]); } catch { /* already gone */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
