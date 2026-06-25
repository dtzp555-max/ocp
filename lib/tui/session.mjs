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
//
// Defunct-reaping (PI231 incident): the pane's `claude` process is a child of the
// long-lived tmux SERVER daemon, NOT of the OCP node process — `tmux new-session -d`
// returns the instant the server forks the pane, so node never becomes its parent and
// therefore can NEVER waitpid()/reap it (a SIGKILL still needs the *parent* to reap, and
// here that parent is the tmux server). `kill-session` destroys the session but the server
// can leave the pane's `claude` (and any grandchildren claude spawned) as `<defunct>`
// zombies that only the server can reap. Over many per-request spawn+teardown cycles these
// accumulate (live evidence on PI231: 25 defunct `<claude>` over 30 days; `tmux kill-server`
// dropped it 25→3). The only node-reachable action that ACTUALLY reaps them — rather than
// merely re-signalling — is to stop the tmux server: when the server exits, the kernel
// reparents its surviving children to init (PID 1), which reaps them immediately.
//
// So after killing our own sessions, if the server has NO sessions left of ANY prefix
// (i.e. nothing we could disrupt — no co-hosted `olp-tui-*` or other instance), we
// `kill-server` to flush the defunct backlog. If ANY non-ocp session remains we leave the
// server running (coexistence rule, ADR 0007) and let the next boot/periodic sweep retry
// once the server is otherwise idle.
export function reapStaleTuiSessions({ tmux = defaultTmux } = {}) {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!r || r.status !== 0) return 0; // no tmux server / no sessions
  const names = String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  let killed = 0;
  let othersRemain = false;
  for (const name of names) {
    if (name.startsWith(SESSION_PREFIX)) {
      tmux(["kill-session", "-t", name]);
      killed++;
    } else {
      othersRemain = true; // a session we do NOT own (e.g. olp-tui-*) — never kill-server
    }
  }
  // Reap defunct `claude` zombies: safe ONLY when the server is now ours-only/empty.
  // kill-server is what actually reaps (server exit reparents survivors to init); a
  // per-session kill cannot, since node is not the zombies' parent.
  if (!othersRemain) {
    tmux(["kill-server"]);
  }
  return killed;
}

// ── Task 5: runTuiTurn ───────────────────────────────────────────────────

// Boot + paste-settle timing. Conservative defaults validated on PI231; env-tunable.
const BOOT_MS         = parseInt(process.env.OCP_TUI_BOOT_MS  || "4000", 10);   // max wait for input-ready
const READY_POLL_MS   = parseInt(process.env.OCP_TUI_READY_POLL_MS || "400", 10); // readiness / paste-verify poll interval
const PASTE_VERIFY_MS = parseInt(process.env.OCP_TUI_PASTE_VERIFY_MS || "5000", 10); // max wait for pasted prompt to render

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Capture the visible tmux pane as plain text (for readiness / paste verification).
function tuiCapturePane(tmux, tmuxName) {
  const r = tmux(["capture-pane", "-p", "-t", tmuxName]);
  return (r && typeof r.stdout === "string") ? r.stdout : "";
}

// True once claude's input bar is rendered and ready for keystrokes.
function tuiInputReady(pane) {
  return /\? for shortcuts/.test(pane);
}

// True once the pasted prompt has POSITIVELY landed in the input box. We only trust
// affirmative signals — NOT "the placeholder is gone", which is unreliable (claude's
// placeholder uses a curly quote `"`, randomized example text, and renders the big paste
// a beat after paste-buffer returns; a "placeholder-gone" heuristic false-positived on the
// still-empty box and made us submit Enter into nothing → issue #130 hang). Landed iff:
//   (a) the bracketed-paste indicator "[Pasted text" is present (large/multi-line paste), OR
//   (b) the prompt's own leading text appears in the pane (short/literal paste).
function tuiPromptLanded(pane, prompt) {
  const flatPane = pane.replace(/\s+/g, " ");
  if (flatPane.includes("[Pasted text")) return true;
  const firstLine = String(prompt).split("\n").map(s => s.trim()).find(Boolean) || "";
  const needle = firstLine.replace(/\s+/g, " ").slice(0, 24);
  // C-4/#133: threshold lowered 3 → 2. A prompt whose first non-blank line is 1–2
  // chars ("hi", "ok") previously NEVER matched (needle.length >= 3) and never
  // surfaced "[Pasted text", so EVERY short prompt 5s-failed with tui_paste_not_landed
  // (live-reproduced: "hi"). The input box starts EMPTY (the curly-quote placeholder
  // is excluded by the affirmative-signal design above), so a >=2-char needle present
  // in the pane is the pasted prompt, not placeholder noise — false-positive risk is
  // low. We keep >=2 rather than >=1 because a single visible char is more likely to
  // collide with incidental glyphs in claude's chrome (borders, the "❯" prompt mark);
  // 2 chars is the floor that lands real prompts while staying conservative.
  return needle.length >= 2 && flatPane.includes(needle);
}

async function pollUntil(fn, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch { /* ignore, keep polling */ }
    await sleep(intervalMs);
  }
  return false;
}

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

// Resolve the HOME the TUI `claude` runs under. Three intents, decided by the env
// token + an explicit OCP_TUI_HOME override:
//
//   - ENV-TOKEN MODE (default when CLAUDE_CODE_OAUTH_TOKEN is set AND OCP_TUI_HOME is
//     unset): a CREDENTIAL-FREE scratch home at `<realHome>/.ocp-tui/home`. There is
//     deliberately NO .credentials.json (no symlink, no copy), so the only credential
//     claude can find is the long-lived env token (passed by buildTuiCmd). This is what
//     actually FORCES env-token auth — see the prepareTuiHome comment for why passing
//     the token alone is insufficient.
//   - EXPLICIT OVERRIDE: whatever OCP_TUI_HOME names (back-compat; an operator who set it
//     keeps exactly that home).
//   - REAL-HOME (default when the env token is unset): the operator's real home, shared
//     credentials.json — byte-for-byte the pre-fix behaviour for credentials.json hosts.
//
// Pure + deterministic so server.mjs and the tests share one decision. `configuredHome`
// is the raw OCP_TUI_HOME value (undefined/empty => unset).
export const DEFAULT_TUI_SCRATCH_HOME = (realHome) => `${realHome}/.ocp-tui/home`;
export function resolveTuiHome({ realHome, configuredHome, envTokenSet }) {
  if (configuredHome) return configuredHome;            // explicit override wins (back-compat)
  if (envTokenSet) return DEFAULT_TUI_SCRATCH_HOME(realHome); // credential-free scratch
  return realHome;                                       // legacy real-home default
}

// Prepare the HOME claude runs under. Three modes:
//   - real-home (tuiHome === realHome OR falsy): no isolation; just trust the cwd
//     in the real ~/.claude.json. The legacy default when no env token is set.
//   - ENV-TOKEN scratch-home (envTokenMode === true): a dedicated HOME with a seeded
//     .claude.json (onboarded + trusts only the scratch cwd) and its own projects/ dir,
//     and DELIBERATELY NO .credentials.json (no symlink, no copy). claude then has no
//     credentials file to read, so it authenticates via CLAUDE_CODE_OAUTH_TOKEN (passed
//     by buildTuiCmd) — which is authoritative precisely because nothing shadows it.
//   - legacy scratch-home (envTokenMode falsy, tuiHome !== realHome): the historical
//     mode that SYMLINKS the real .credentials.json. Retained only for an operator who
//     explicitly set OCP_TUI_HOME without an env token; see the caveat below.
//
// WHY ENV-TOKEN MODE IS THE FIX (proven live on PI231, claude 2.1.104):
//   env token passed + a broken ~/.claude/.credentials.json present → 401.
//   env token passed + credentials.json moved aside              → real answer.
// Interactive `claude` PREFERS .credentials.json over the env var (unlike `-p`, where the
// env token wins), so a stale/corrupt credentials.json SHADOWS the env token. Passing the
// token is necessary but insufficient; the TUI claude must run in a HOME with NO
// credentials.json so the env token is the only credential. This ALSO ends the refresh-
// corruption incident at the root: with no credentials file, claude never runs the token-
// refresh path, so the single-use refresh token can never be rotated (and corrupted) by the
// spawn+kill cycle. (This RESOLVES — not reintroduces — the ADR 0007 scratch-home concern:
// the old caveat was about a SYMLINKED credentials.json being forked on refresh; here there
// is no credentials file to fork and no refresh ever happens.)
//
// ⚠️ LEGACY SCRATCH-HOME CAVEAT (envTokenMode falsy, symlink path): claude rewrites
// .credentials.json on token refresh, REPLACING the symlink with a regular-file copy → the
// scratch home FORKS the OAuth credentials and a refresh can invalidate the real-home token.
// That path is therefore safe only with a DEDICATED OAuth or for ephemeral use. The env-token
// mode above avoids this entirely.
//
// Idempotent + best-effort: any failure degrades toward the dialog/cap, never corrupts.
// Run BEFORE the session boots.
export function prepareTuiHome(realHome, tuiHome, cwd, { envTokenMode = false } = {}) {
  if (!tuiHome || tuiHome === realHome) { ensureTuiCwdTrusted(realHome, cwd); return; }
  try {
    const claudeDir = `${tuiHome}/.claude`;
    mkdirSync(`${claudeDir}/projects`, { recursive: true });
    if (!envTokenMode) {
      // Legacy mode ONLY: symlink the real credentials (never copy the token); refresh if
      // missing. Env-token mode deliberately skips this — no credentials file at all.
      const link = `${claudeDir}/.credentials.json`;
      if (!existsSync(link)) {
        try { symlinkSync(`${realHome}/.claude/.credentials.json`, link); } catch { /* best effort */ }
      }
    }
    // Seed .claude.json ONCE (if absent): onboarded + trust ONLY the scratch cwd.
    // In env-token mode start from a MINIMAL config (do NOT copy the real ~/.claude.json —
    // a credential-isolated home should not inherit the operator's account/config state);
    // in legacy mode carry the onboarded real config minus the user's project history.
    const seedPath = `${tuiHome}/.claude.json`;
    if (!existsSync(seedPath)) {
      let base = {};
      if (!envTokenMode) {
        try { base = JSON.parse(readFileSync(`${realHome}/.claude.json`, "utf8")); } catch { /* fresh */ }
      }
      base.hasCompletedOnboarding = true;
      base.projects = { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } };
      writeFileSync(seedPath, JSON.stringify(base, null, 2), { mode: 0o600 });
    }
  } catch { /* best effort */ }
  // Ensure the cwd is trusted in the scratch config (idempotent; atomic).
  ensureTuiCwdTrusted(tuiHome, cwd);
}

// Build interactive claude argv: NO -p, NO --output-format (=> cc_entrypoint=cli).
// MCP hard-disabled: --strict-mcp-config (no --mcp-config) is the only mechanism
// that stops account-attached managed MCP from connecting (spec §5.2 / T6),
// belt-and-braces with --disallowedTools "mcp__*".
// A-PATH ONLY: built-in tools are left enabled (acceptable single-user). Deployment B
// (guest keys) MUST additionally pass --tools "" per spec §5.2(2) as the credential
// wall before this argv is reachable for owner_tier=guest — guard that in PR-3 wiring.
export function buildTuiCmd(claudeBin, model, sessionId, ehome, entrypointMode) {
  // Deliver claude's env via an `env` prefix on the PANE COMMAND — tmux does NOT forward the
  // spawning process's environment to the pane, and `new-session -e` needs tmux ≥3.2 (the cloud
  // host runs 2.7), so this is the only portable, reliable mechanism (verified live 2026-06-01:
  // passing {env} to spawnSync left the pane with only HOME). DISABLE_AUTOUPDATER pins the version
  // (no "What's new" splash that delayed input-readiness); CLAUDE_CODE_ENTRYPOINT labels the
  // billing pool (set below per entrypointMode).
  //
  // CLAUDE_CODE_DISABLE_CLAUDE_MDS + DISABLE_AUTO_MEMORY: OCP is a PROXY, not a Claude Code
  // session. The proxied client (OpenClaw / an IDE) owns its own context and memory; the HOST's
  // CLAUDE.md and auto-memory must NEVER leak into the agent OCP runs on the user's behalf.
  // Without these, claude loads the host's project/user CLAUDE.md + memory into every proxied
  // turn — verified live 2026-06-02: a cwd CLAUDE.md ("end every reply with QUACKMARKER_42") was
  // obeyed by the proxied turn until these flags were set, after which it was not. Unconditional
  // by design (not gated): proxy purity is not an opt-in. Harmless on hosts with no CLAUDE.md
  // (the common case — they suppress nothing). Mirrors the -p path's CLAUDE_NO_CONTEXT vars.
  const sets = [
    `HOME=${shq(ehome)}`,
    "DISABLE_AUTOUPDATER=1",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
  ];
  // CLAUDE_CODE_OAUTH_TOKEN: tmux does NOT forward the parent process's env to the pane (the
  // same reason the whole env is delivered as an `env` prefix above — verified live 2026-06-01),
  // so the token MUST be set explicitly here or the spawned `claude` never sees it. Without it,
  // the TUI claude falls back to authenticating via <HOME>/.claude/.credentials.json, whose
  // single-use refresh token gets corrupted by the per-request spawn + `kill-session` teardown
  // racing claude's token-rotation write (the PI231 incident: refresh token ended up an empty
  // string → permanent 401 "Please run /login", re-login re-corrupted on the next spawn). With
  // the long-lived OAuth token in env, claude authenticates via the token and never touches the
  // credentials.json refresh path — matching how the stable oracle / Mac-mini hosts already run.
  //
  // SECURITY: the token appears in the pane command (ps-visible). This is acceptable for the
  // single-user A-path — it mirrors the existing plaintext-token practice (server.mjs reads the
  // same CLAUDE_CODE_OAUTH_TOKEN env at getOAuthCredentials()), and the multi-user B-path is
  // already refused at boot (TUI + AUTH_MODE=multi is a hard FATAL). Read from process.env here,
  // consistent with how buildTuiCmd already reads OCP_TUI_FULL_TOOLS / CLAUDE_ALLOWED_TOOLS below.
  //
  // When the env is unset (e.g. a host that intentionally relies on credentials.json), no token
  // is added — behaviour is byte-for-byte unchanged from before this fix.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    sets.push(`CLAUDE_CODE_OAUTH_TOKEN=${shq(process.env.CLAUDE_CODE_OAUTH_TOKEN)}`);
  }
  const unset = ["CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
  if (entrypointMode === "cli") sets.push("CLAUDE_CODE_ENTRYPOINT=cli");
  else if (entrypointMode === "auto") unset.push("CLAUDE_CODE_ENTRYPOINT"); // let claude self-classify via TTY
  const envPrefix = ["env", ...unset.map((u) => `-u ${u}`), ...sets].join(" ");

  // Tool surface.
  //   DEFAULT (safe): hard-disable MCP (--strict-mcp-config + --disallowedTools mcp__*);
  //     built-in tools stay on, acceptable for single-user A-path.
  //   OCP_TUI_FULL_TOOLS=1: grant the SAME tool surface as the -p A-path
  //     (--allowedTools [+ --mcp-config]), so a SINGLE-USER / trusted TUI deployment can
  //     run a tool-using agent (e.g. an OpenClaw assistant that needs Bash/Read/Write/MCP)
  //     on the subscription pool. ALWAYS uses --allowedTools (CLAUDE_SKIP_PERMISSIONS /
  //     --dangerously-skip-permissions is intentionally removed: claude v2.1.x shows an
  //     interactive bypass-acceptance screen in headless tmux that nothing can answer →
  //     the turn hangs until the wallclock cap, bricks the pane; not recoverable without a
  //     human at a keyboard). Use scratch-home settings.json additionalDirectories instead.
  let toolArgs;
  if (process.env.OCP_TUI_FULL_TOOLS === "1") {
    toolArgs = [];
    const allowed = (process.env.CLAUDE_ALLOWED_TOOLS ||
      "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent")
      .split(",").map((s) => s.trim()).filter(Boolean);
    // shq EACH token: buildTuiCmd returns a SHELL STRING (run by tmux via sh -c), unlike
    // buildCliArgs which returns an argv array to spawn(). claude accepts scoped specifiers
    // like "Bash(npm run test:*)" / "Read(~/**)" whose ( ) * ~ would break/inject the shell
    // command if pasted bare. (operator-self-injection only — guests can't reach TUI.)
    if (allowed.length) toolArgs.push("--allowedTools", ...allowed.map(shq));
    if (process.env.CLAUDE_MCP_CONFIG) toolArgs.push("--mcp-config", shq(process.env.CLAUDE_MCP_CONFIG));
  } else {
    toolArgs = ["--strict-mcp-config", "--disallowedTools", shq("mcp__*")];
  }
  return [
    envPrefix,
    shq(claudeBin),
    "--model",          shq(model),
    "--session-id",     sessionId,
    ...toolArgs,
  ].join(" ");
}

// Full per-request TUI lifecycle:
//   1. Pre-trust the scratch cwd (no trust dialog will appear).
//   2. Write prompt to a 0600 temp file (no shell injection from prompt content).
//   3. Boot an interactive `claude` in a fresh tmux session in the scratch cwd; poll
//      capture-pane until the `? for shortcuts` input bar appears (readiness-poll
//      replaces the old blind boot sleep). BOOT_MS is the max wait, not a fixed delay.
//   4. Paste the prompt via tmux load-buffer + paste-buffer -p (bracketed paste) —
//      reliable for large multi-line prompts where send-keys -l is not (issue #130).
//      Poll-verify the prompt landed in the input (placeholder gone / [Pasted text]);
//      fast-fail with tui_paste_not_landed if it never lands (prevents the 120s
//      wallclock "stuck typing" hang). Then submit with a SEPARATE Enter key event.
//   5. Block on the native JSONL transcript (located by session-id) until terminal
//      marker or wall-clock cap.
//   6. Always teardown: kill session + rm temp dir (even on throw).
// Returns { text, entrypoint } from readTuiTranscript (entrypoint is the billing-pool
// classifier, e.g. "cli", or null if the transcript did not include a turn_duration).
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

  // Env-token-only mode: the env token is set AND claude runs in an isolated home
  // (ehome !== rhome). In that case the scratch home must be CREDENTIAL-FREE (no
  // .credentials.json) so the env token — passed by buildTuiCmd — is the only credential
  // and is therefore authoritative (interactive claude otherwise PREFERS a credentials.json,
  // shadowing the env token; proven live on PI231). server.mjs derives TUI_HOME via
  // resolveTuiHome() so this isolated home is the DEFAULT once CLAUDE_CODE_OAUTH_TOKEN is set.
  const envTokenMode = !!process.env.CLAUDE_CODE_OAUTH_TOKEN && ehome !== rhome;

  // Ensure scratch cwd exists, then prepare the (scratch or real) HOME + trust the
  // cwd — before claude boots.
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
  prepareTuiHome(rhome, ehome, cwd, { envTokenMode });

  // Write prompt to a temp file (mode 0600) so the content never touches argv.
  const tmpDir     = mkdtempSync(`${tmpdir()}/ocp-tui-`);
  const promptFile = `${tmpDir}/prompt.txt`;
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  // Minimal env for spawnSync (tmux itself). The pane's claude env comes exclusively
  // from the `env` prefix string built inside buildTuiCmd — tmux does NOT forward the
  // spawning process's env to the pane, so the {env} here is intentionally minimal.
  const env = { ...process.env };
  env.HOME = ehome; // tmux needs HOME; all claude-specific vars go via buildTuiCmd prefix

  try {
    // 1. Boot the interactive session inside tmux, rooted at the scratch cwd.
    //    Capture the result: if tmux new-session fails (status !== 0) there is no
    //    PTY, no interactive spawn — abort BEFORE the boot sleep rather than paste
    //    into a non-existent session or issue a billing request without a verified
    //    interactive context. The finally teardown is still harmless (kill-session
    //    is a no-op when the session never existed).
    const spawnResult = tmux(
      ["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "50", "-c", cwd,
       buildTuiCmd(claudeBin, model, sessionId, ehome, entrypointMode)],
      { env },
    );
    if (!spawnResult || spawnResult.status !== 0) {
      throw new Error("tui_spawn_failed: tmux session not created");
    }

    // 2. Wait until claude's input bar is actually ready (was: blind sleep(BOOT_MS)).
    //    BOOT_MS is now the MAX readiness wait, not a fixed delay.
    const ready = await pollUntil(() => tuiInputReady(tuiCapturePane(tmux, tmuxName)),
      { timeoutMs: BOOT_MS, intervalMs: READY_POLL_MS });
    if (!ready) {
      // (readiness timed out; relying on paste-verify)
      console.error("[tui] input_not_ready", tmuxName);
    }

    // 3. Paste the prompt via a tmux PASTE BUFFER with bracketed paste (-p), NOT
    //    `send-keys -l`. send-keys of a large multi-line prompt is unreliable: the
    //    embedded newlines arrive as separate key events (effectively repeated Enter),
    //    so a big OpenClaw-style prompt never lands and the turn hangs to the wallclock
    //    (issue #130 — reproduced at ~300 lines; fixed by bracketed paste). load-buffer
    //    reads the file directly (no shell arg limit, no `"$(cat)"`), and paste-buffer -p
    //    wraps it in bracketed-paste markers so claude ingests it atomically as ONE paste
    //    ("[Pasted text #N +M lines]"). -d deletes the buffer afterward. Buffer name is the
    //    per-session tmuxName, so concurrent turns never collide.
    tmux(["load-buffer", "-b", tmuxName, promptFile]);
    tmux(["paste-buffer", "-b", tmuxName, "-t", tmuxName, "-p", "-d"]);

    // Verify the prompt POSITIVELY landed before submitting; poll (a large bracketed paste
    // takes a beat to render the "[Pasted text]" indicator). This is load-bearing: firing
    // Enter before the paste renders submits an empty box → the turn hangs to the wallclock
    // (issue #130). Fast-fail if it never lands → deterministic error in seconds.
    const landed = await pollUntil(() => tuiPromptLanded(tuiCapturePane(tmux, tmuxName), prompt),
      { timeoutMs: PASTE_VERIFY_MS, intervalMs: READY_POLL_MS });
    if (!landed) {
      throw new Error("tui_paste_not_landed: prompt did not reach claude's input within " + PASTE_VERIFY_MS + "ms");
    }

    // Submit (separate Enter key event).
    tmux(["send-keys", "-t", tmuxName, "Enter"]);

    // 4. Block on the native transcript (resolved by session-id) until terminal.
    //    Returns { text, entrypoint } from readTuiTranscript.
    return await readTuiTranscript({ home: ehome, sessionId, wallclockMs });
  } finally {
    // 5. Teardown — always, even on throw.
    try { tmux(["kill-session", "-t", tmuxName]); } catch { /* already gone */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
