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
import { prepareStreamHook, streamFilePath, parseDeltaChunk } from "./stream.mjs";

// F7 fix (audit finding, LOW): the prefix used to be a bare, host-wide constant
// ("ocp-tui-"), so a SECOND OCP instance on the same host (e.g. a temporary
// verification instance stood up alongside production — a real pattern used during
// PR #144/#146 verification) would boot-reap and potentially kill-server the OTHER
// instance's LIVE sessions: the coexistence guard below only ever spared foreign
// PRODUCT prefixes (olp-tui-*), never a second ocp-tui-* instance on a different port.
//
// Fix: scope the prefix to the instance's own listen port. The port is the natural
// stable per-instance discriminator on one host (two OCP instances cannot share a
// port), so `ocp-tui-<port>-` uniquely namespaces this instance's sessions and makes
// a same-host sibling OCP instance look exactly like a foreign product (olp-tui-*) to
// the coexistence guard — its `ocp-tui-<otherPort>-*` sessions never match our own
// prefix and are therefore never reaped/kill-server'd by us.
//
// LEGACY_SESSION_PREFIX / LEGACY_SESSION_NAME_RE describe the OLD bare-prefix shape
// (pre-this-fix), retained ONLY for the boot-time legacy-zombie migration handled in
// reapStaleTuiSessions (see comment there). No code path in this version ever CREATES
// a legacy-shaped session name again — sessionPrefixForPort() is the only session-name
// prefix constructor used going forward.
export const LEGACY_SESSION_PREFIX = "ocp-tui-";
// Exact legacy shape: LEGACY_SESSION_PREFIX + sessionId.slice(0, 8), where sessionId is
// a randomUUID() — so the suffix is always exactly 8 lowercase hex characters with NO
// further separator. The new port-scoped shape always inserts a "-" between the port
// digits and the 8-hex suffix (see sessionPrefixForPort), so this regex can never match
// a new-shape name: a new-shape suffix is `<port digits>-<8 hex>` (contains a literal
// "-"), which `[0-9a-f]{8}$` anchored immediately after the prefix cannot satisfy.
export const LEGACY_SESSION_NAME_RE = /^ocp-tui-[0-9a-f]{8}$/;

// Build this instance's own session-name prefix, scoped by its listen port so a
// second OCP instance on the same host (different port) is never mistaken for "ours".
export function sessionPrefixForPort(port) {
  return `ocp-tui-${port}-`;
}

const TMUX = process.env.OCP_TUI_TMUX_BIN || "tmux";

const defaultTmux = (args, opts = {}) =>
  spawnSync(TMUX, args, { encoding: "utf8", ...opts });

// Kill ONLY our own stale sessions. Scoped to sessionPrefixForPort(port) so a co-hosted
// OLP test instance's `olp-tui-*` sessions — AND a co-hosted second OCP instance's
// `ocp-tui-<otherPort>-*` sessions — are never touched (F7 fix).
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
// `port` (required) is this instance's own listen port (server.mjs's PORT / lib/constants.mjs
// DEFAULT_PORT resolution) — the SPOT for "which sessions are ours."
//
// ── POOL/REAPER INVARIANT (warm pane pool — lib/tui/pool.mjs) ───────────────────────────
// A warm pooled pane is one of OUR OWN `ocp-tui-<port>-*` sessions that is ALIVE AND IDLE
// BY DESIGN — and the periodic sweep runs precisely when the instance is idle, i.e. exactly
// when the pool is full. Without an exemption the sweep would kill every warm pane on every
// tick (and kill-server on top). The exemption is `spare`: a set of EXACT session names the
// caller declares live. Three properties, all load-bearing:
//
//   1. A LIVE POOLED PANE IS NEVER REAPED — INCLUDING ONE THAT IS STILL BOOTING. It is in
//      `spare` (the pool's live registry), so it is skipped by name. The booting case is not
//      a footnote, it is the one that bit us: bootTuiPane creates the tmux session
//      SYNCHRONOUSLY and only then waits up to POOL_BOOT_MS for the input bar, so a pooled
//      session can be live for ~20 s before its boot resolves. The pool therefore mints the
//      pane's NAME up front and holds it in `_bootingPane`, so liveNames() can name — and
//      spare — a session whose boot has not finished. (An earlier version tracked only a
//      COUNT of in-flight boots; the sweep could not name that session and killed it.)
//   2. A LEAKED/ORPHANED POOLED PANE IS STILL REAPED. Membership is by EXACT NAME from a
//      live in-memory registry — NOT by "looks pooled" (name shape). A pane the pool no
//      longer owns (handed out, dropped, cancelled, or left behind by a previous process
//      generation — whose registry died with it) is absent from `spare` and is killed like
//      any other stale session. Fail-safe: forgetting to pass `spare` reaps MORE, never less.
//   3. KILL-SERVER NEVER KILLS A LIVE POOL PANE. A spared session suppresses kill-server
//      exactly as a foreign session does (it is a live child of the tmux server). The
//      consequence — that a permanently-full pool would permanently disable the defunct-
//      zombie reaping that ONLY kill-server can do — is resolved in server.mjs by DRAINING
//      the pool immediately before the sweep, so `spare` is empty on the normal tick and
//      kill-server still fires. `spare` is the belt-and-braces: a reap call site that
//      forgets to drain still cannot kill a live pane.
//
// `spare` (default: none) — iterable of session names, or a Set. Ignored when the pool is off.
//
// `includeLegacy` (default false): when true, sessions matching the exact OLD bare-prefix
// shape (LEGACY_SESSION_NAME_RE) are ALSO treated as ours for kill-session purposes. This is
// the boot-time legacy migration: an operator upgrading past this fix could otherwise be left
// with orphaned bare-prefix zombie sessions from the PREVIOUS (pre-fix) process generation of
// this SAME instance, since no live instance of the new version ever creates that shape again
// — a legacy-shaped session found at boot is therefore presumed to be this instance's own
// leftover, not a stranger's. Passed true ONLY from the one-time boot-reap call site in
// server.mjs; the periodic idle-reap sweep does NOT set it, so a lingering legacy session
// during steady-state is conservatively treated as foreign (correctly blocking kill-server)
// rather than assumed to be ours on every 15-minute tick. Residual (accepted, documented):
// if a genuinely-still-running PRE-FIX OCP instance is coexisting on the same host at the
// exact moment a new instance boots, its live legacy-shaped session could be reaped — the
// same class of residual risk the audit finding itself accepts ("no live instance of the new
// version creates them"); this PR does not regress that scenario, it only removes the far
// more common same-version collision (the actual F7 finding).
export function reapStaleTuiSessions({ tmux = defaultTmux, port, includeLegacy = false, spare = null } = {}) {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  if (!r || r.status !== 0) return 0; // no tmux server / no sessions
  const names = String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const ownPrefix = sessionPrefixForPort(port);
  const spared = spare instanceof Set ? spare : new Set(spare || []);
  let killed = 0;
  let othersRemain = false;
  let sparedLive = 0;
  for (const name of names) {
    // Property 1+2: exemption is by EXACT NAME from the pool's live registry. A pooled-
    // LOOKING name that is not in the registry is an orphan and falls through to the
    // normal kill path below.
    if (spared.has(name)) { sparedLive++; continue; }
    const isOwn = name.startsWith(ownPrefix);
    const isLegacyOwn = includeLegacy && LEGACY_SESSION_NAME_RE.test(name);
    if (isOwn || isLegacyOwn) {
      tmux(["kill-session", "-t", name]);
      killed++;
    } else {
      othersRemain = true; // a session we do NOT own (olp-tui-*, a sibling ocp-tui-<otherPort>-*,
                            // or — outside includeLegacy — a legacy-shaped name) — never kill-server
    }
  }
  // Reap defunct `claude` zombies: safe ONLY when the server is now ours-only/empty.
  // kill-server is what actually reaps (server exit reparents survivors to init); a
  // per-session kill cannot, since node is not the zombies' parent.
  //
  // Property 3: a SPARED session is a live child of this tmux server, so kill-server would
  // kill it — it therefore suppresses kill-server exactly as a foreign session does. On the
  // normal sweep the pool is drained first, so sparedLive is 0 and kill-server still fires.
  if (!othersRemain && sparedLive === 0) {
    tmux(["kill-server"]);
  }
  return killed;
}

// ── Task 5: runTuiTurn ───────────────────────────────────────────────────

// Boot + paste-settle timing. Conservative defaults validated on PI231; env-tunable.
const BOOT_MS         = parseInt(process.env.OCP_TUI_BOOT_MS  || "4000", 10);   // max wait for input-ready
// Readiness cap for a POOL pre-boot. Deliberately far more generous than BOOT_MS: BOOT_MS is
// tight because a client is blocked on it, whereas a warm-pane boot happens in the background
// with nobody waiting. Observed live at size=2: a refill booting alongside an in-flight turn
// exceeded 4000 ms and was discarded (tui_pool_boot_failed), quietly costing hit rate for a
// pane that was merely slow, not broken. Scales with OCP_TUI_BOOT_MS if an operator raises it.
export const POOL_BOOT_MS = BOOT_MS * 5;
const READY_POLL_MS   = parseInt(process.env.OCP_TUI_READY_POLL_MS || "400", 10); // readiness / paste-verify poll interval
const PASTE_VERIFY_MS = parseInt(process.env.OCP_TUI_PASTE_VERIFY_MS || "5000", 10); // max wait for pasted prompt to render
// Hook-sink drain interval when streaming. 100ms: the hook fires at BLOCK granularity
// (~5-7 fires per answer, seconds apart), so a finer poll buys nothing and a coarser one
// would add visible lag to the first delta. Cheap — one readFileSync of a small file.
const STREAM_POLL_MS  = parseInt(process.env.OCP_TUI_STREAM_POLL_MS || "100", 10);

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
//
// `stream` (optional, OCP_TUI_STREAM): { file, settings } — when present, the pane gets
//   (a) OCP_TUI_STREAM_FILE in its env  — read by the static MessageDisplay hook script to
//       decide WHERE to append this pane's deltas. Delivered as env (not baked into the
//       settings file) so the settings file stays STATIC and a pre-booted warm pane works.
//       Verified live: a claude hook inherits the pane's environment.
//   (b) --settings <file>               — registers the MessageDisplay hook.
//   VERIFIED LIVE (claude 2.1.207, this host) before shipping, because both were spawn-level
//   risks:
//     - the startup banner is UNCHANGED with --settings: "Sonnet 4.6 with low effort ·
//       Claude Max" (subscription pool). --settings is NOT a --bare-class flag — it does not
//       silently drop the subscription pool. Transcript entrypoint stayed "cli".
//     - --settings MERGES into the settings hierarchy, it does NOT clobber <HOME>/.claude/
//       settings.json: with --settings passed, the user-level settings.json's `env` block was
//       still applied to the hook's environment. So the isolated-HOME settings story the TUI
//       already relies on (permissions / additionalDirectories — see prepareTuiHome and the
//       OCP_TUI_FULL_TOOLS note above) survives intact.
//   When absent, the argv is byte-for-byte the pre-streaming argv.
export function buildTuiCmd(claudeBin, model, sessionId, ehome, entrypointMode, stream = null) {
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
  // Streaming sink: the pane's own per-session delta file (see the `stream` note above).
  if (stream && stream.file) sets.push(`OCP_TUI_STREAM_FILE=${shq(stream.file)}`);
  const unset = ["CLAUDECODE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
  if (entrypointMode === "cli") sets.push("CLAUDE_CODE_ENTRYPOINT=cli");
  else if (entrypointMode === "auto") unset.push("CLAUDE_CODE_ENTRYPOINT"); // let claude self-classify via TTY
  const envPrefix = ["env", ...unset.map((u) => `-u ${u}`), ...sets].join(" ");

  // Tool surface.
  //   DEFAULT (safe): hard-disable MCP (--strict-mcp-config + --disallowedTools mcp__*);
  //     built-in tools stay on, acceptable for single-user A-path. An operator can further
  //     narrow the built-in set with OCP_TUI_TOOLS (opt-in; see below).
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
    // OCP_TUI_TOOLS (opt-in): restrict which BUILT-IN tools the pane may use, via --tools.
    // --tools is the tool-AVAILABILITY registry (which built-in tools exist for the session),
    // NOT a permission layer — so, unlike --allowedTools / --disallowedTools, a tool omitted
    // here is simply never offered and can never trigger an interactive permission prompt that
    // a headless tmux pane cannot answer (which would hang the turn to the wallclock cap and
    // brick the pane). Value is passed through verbatim (comma- or space-separated names, e.g.
    // "Read,Glob,Grep,WebSearch,WebFetch"; "" disables all, "default" enables all — see
    // `claude --help`). Unset or empty => today's behaviour: all built-in tools available, MCP
    // walled off. shq'd as one arg so scoped/globby names can't break the shell string.
    const tuiTools = (process.env.OCP_TUI_TOOLS || "").trim();
    if (tuiTools) toolArgs.push("--tools", shq(tuiTools));
  }

  // Effort: pass --effort EXPLICITLY. Without it, the pane's claude inherits a
  // HOME-dependent effortLevel — real-home mode inherits the operator's
  // ~/.claude/settings.json (whatever they set for their own interactive use),
  // env-token scratch mode inherits claude's built-in default (prepareTuiHome never
  // writes effortLevel) — so latency silently depends on which HOME mode
  // resolveTuiHome() picked AND on an unrelated operator setting. Pinning it here
  // removes both. Measured (docs/plans/2026-07-13-tui-latency): explicit low cuts
  // direct-spawn TTFT p50 10.35s → 6.17s (−40%) and collapses the spread ~15×;
  // banner-verified to stay on the subscription pool (`· Claude Max`).
  // OCP_TUI_EFFORT=inherit restores the pre-flag argv byte-for-byte (no --effort).
  // An unknown value falls back to the default rather than reaching claude's argv:
  // a typo'd --effort value must not risk a spawn-time usage error in the pane.
  const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"]; // claude 2.1.207 --help
  const effortRaw = (process.env.OCP_TUI_EFFORT || "low").trim().toLowerCase();
  let effortArgs;
  if (effortRaw === "inherit") {
    effortArgs = [];
  } else if (EFFORT_LEVELS.includes(effortRaw)) {
    effortArgs = ["--effort", effortRaw];
  } else {
    console.error(`[tui] invalid OCP_TUI_EFFORT=${JSON.stringify(process.env.OCP_TUI_EFFORT)}; using "low" (valid: ${EFFORT_LEVELS.join("|")}, or "inherit" to omit the flag)`);
    effortArgs = ["--effort", "low"];
  }

  // --settings registers the MessageDisplay hook. Omitted entirely when streaming is off,
  // so the OFF argv is byte-for-byte the pre-streaming argv.
  const settingsArgs = stream && stream.settings ? ["--settings", shq(stream.settings)] : [];

  return [
    envPrefix,
    shq(claudeBin),
    "--model",          shq(model),
    "--session-id",     sessionId,
    ...toolArgs,
    ...effortArgs,
    ...settingsArgs,
  ].join(" ");
}

// Is a pane alive AND still sitting at its input bar? Used by the warm pool to decide,
// at hand-out time, whether a pre-booted pane is still usable (a dead/degraded pane must
// become a MISS → cold path, never a hung turn). capture-pane exits non-zero when the
// session no longer exists, so this covers "pane gone" and "pane not ready" in one call.
export function tuiPaneHealthy(tmux, tmuxName) {
  const r = tmux(["capture-pane", "-p", "-t", tmuxName]);
  if (!r || r.status !== 0 || typeof r.stdout !== "string") return false;
  return tuiInputReady(r.stdout);
}

// Pool pane names carry a "p" marker after the port-scoped prefix:
//   turn pane: ocp-tui-<port>-<8hex>      (unchanged)
//   pool pane: ocp-tui-<port>-p<8hex>
// Purely for operator legibility (`tmux ls` shows which panes are warm). It is NOT the
// reaper's exemption mechanism — that is the exact-name spare set (see the POOL/REAPER
// INVARIANT above), so a pooled-LOOKING orphan is still reaped. Both shapes start with
// sessionPrefixForPort(port), so both remain reapable as "ours", and neither can match
// LEGACY_SESSION_NAME_RE.
export function poolPaneName(port, sessionId) {
  return sessionPrefixForPort(port) + "p" + sessionId.slice(0, 8);
}

// Boot ONE interactive `claude` pane and wait for its input bar. Shared by the cold
// request path (runTuiTurn) and the warm pool (lib/tui/pool.mjs) so a pooled pane is
// spawned with byte-for-byte the same argv, HOME, cwd and trust preparation as a
// cold-booted one — the pool must not become a second, drifting spawn path.
//
// Each pane gets its OWN fresh randomUUID() --session-id, fixed at boot. That is what
// keeps a pooled pane single-use-safe: its transcript holds exactly one exchange.
//
// requireReady: the cold path tolerates a readiness timeout (it falls through and lets
// the paste-verify decide — pre-existing behaviour, unchanged). The POOL sets it, because
// a pane that never reached its input bar is worthless as a warm pane and must not be
// enlisted: throw, let the pool count a bootFailure, and leave the request path to
// cold-boot as usual.
// bootMs: max wait for the input bar. Defaults to BOOT_MS (the REQUEST path's cap, which is
// deliberately tight — a client is blocked on it). The POOL passes POOL_BOOT_MS instead: a
// background pre-boot has nobody waiting on it, and capping it at the request-path's 4 s
// made real refills fail (observed live: a refill booting alongside an in-flight turn took
// >4 s and was discarded, silently lowering the hit rate). Slow != broken for a pre-boot.
// `sessionId` / `name` (both optional): the caller may supply the pane's identity instead of
// letting bootTuiPane mint it. The POOL does, because it must know the tmux session's NAME
// before this function runs — the session is created synchronously below, well before the
// readiness wait returns, so a pool that only learned the name on resolve could neither spare
// the session from the reaper nor kill it on shutdown. Supplying BOTH also keeps the name's
// hex suffix equal to the session-id's, so `tmux ls` correlates to the transcript file.
// `streamDir` (optional, OCP_TUI_STREAM): install claude's MessageDisplay hook on this pane.
// Done HERE, at boot — not at turn time — and that is the whole reason streaming survives the
// WARM POOL: the hook script + settings file are STATIC (one pair per streamDir), and the only
// per-turn thing, the sink path, is derived from the pane's own --session-id, which is fixed
// right here. So a pre-booted pane already carries its hook and its own sink and streams exactly
// like a cold-booted one; nothing request-specific is ever baked into the spawn.
export async function bootTuiPane({
  model, claudeBin, home, realHome, cwd, port, entrypointMode = "cli",
  tmux = defaultTmux, sessionId = null, name = null, requireReady = false, bootMs = BOOT_MS,
  streamDir = null,
}) {
  const sid = sessionId || randomUUID();
  // Port-scoped session name (F7 fix) — see sessionPrefixForPort / reapStaleTuiSessions
  // for why this instance's own listen port is the namespace discriminator.
  const tmuxName  = name || (sessionPrefixForPort(port) + sid.slice(0, 8));
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

  // Streaming sink for THIS pane (see the streamDir note above). rmSync first so a
  // re-used session-id can never replay a previous turn's deltas.
  let streamFile = null, streamSettings = null;
  if (streamDir) {
    streamFile     = streamFilePath(streamDir, sid);
    streamSettings = prepareStreamHook(streamDir);
    try { rmSync(streamFile, { force: true }); } catch { /* start from a fresh sink */ }
  }

  // Minimal env for spawnSync (tmux itself). The pane's claude env comes exclusively
  // from the `env` prefix string built inside buildTuiCmd — tmux does NOT forward the
  // spawning process's env to the pane, so the {env} here is intentionally minimal.
  const env = { ...process.env };
  env.HOME = ehome; // tmux needs HOME; all claude-specific vars go via buildTuiCmd prefix

  // Boot the interactive session inside tmux, rooted at the scratch cwd.
  // Capture the result: if tmux new-session fails (status !== 0) there is no PTY, no
  // interactive spawn — abort BEFORE the boot wait rather than paste into a non-existent
  // session or issue a billing request without a verified interactive context.
  const spawnResult = tmux(
    ["new-session", "-d", "-s", tmuxName, "-x", "220", "-y", "50", "-c", cwd,
     buildTuiCmd(claudeBin, model, sid, ehome, entrypointMode,
                 streamFile ? { file: streamFile, settings: streamSettings } : null)],
    { env },
  );
  if (!spawnResult || spawnResult.status !== 0) {
    throw new Error("tui_spawn_failed: tmux session not created");
  }

  // Wait until claude's input bar is actually ready (not a blind sleep).
  // bootMs is the MAX readiness wait, not a fixed delay.
  const ready = await pollUntil(() => tuiInputReady(tuiCapturePane(tmux, tmuxName)),
    { timeoutMs: bootMs, intervalMs: READY_POLL_MS });
  if (!ready) {
    if (requireReady) {
      try { tmux(["kill-session", "-t", tmuxName]); } catch { /* already gone */ }
      throw new Error("tui_pane_not_ready: input bar did not appear within " + bootMs + "ms");
    }
    // Cold path (pre-existing behaviour): readiness timed out; rely on paste-verify.
    console.error("[tui] input_not_ready", tmuxName);
  }
  return { name: tmuxName, sessionId: sid, model, ehome, streamFile, bootedAt: Date.now() };
}

// Full per-request TUI lifecycle:
//   1. Take a WARM pane from the pool if one is available for this model (opt-in;
//      OCP_TUI_POOL_SIZE=0 => always null => steps 2-3 below are exactly today's path).
//      A pooled pane is SINGLE-USE: it already carries its own fresh --session-id, it
//      serves this one turn, and it is killed in the finally like any other pane.
//   2. On a MISS: pre-trust the scratch cwd, boot an interactive `claude` in a fresh tmux
//      session in the scratch cwd, poll capture-pane until the `? for shortcuts` input bar
//      appears (bootTuiPane). BOOT_MS is the max wait, not a fixed delay.
//   3. Write prompt to a 0600 temp file (no shell injection from prompt content).
//   4. Paste the prompt via tmux load-buffer + paste-buffer -p (bracketed paste) —
//      reliable for large multi-line prompts where send-keys -l is not (issue #130).
//      Poll-verify the prompt landed in the input (placeholder gone / [Pasted text]);
//      fast-fail with tui_paste_not_landed if it never lands (prevents the 120s
//      wallclock "stuck typing" hang). Then submit with a SEPARATE Enter key event.
//   5. Block on the native JSONL transcript (located by THIS pane's session-id) until
//      terminal marker or wall-clock cap.
//   6. Always teardown: kill session + rm temp dir (even on throw), and kick a background
//      pool refill so the next request finds a warm pane.
// Returns { text, entrypoint } from readTuiTranscript (entrypoint is the billing-pool
// classifier, e.g. "cli", or null if the transcript did not include a turn_duration).
//
// STREAMING (OCP_TUI_STREAM, default off). Pass `onDelta` and `streamDir`, and the pane's
// MessageDisplay hook (installed by bootTuiPane; see lib/tui/stream.mjs) appends each raw
// delta payload to the pane's own sink. This driver polls that sink and invokes onDelta(payload)
// per fire while the turn is still generating. A WARM pane already carries its sink from boot
// (pane.streamFile), so the pooled and cold paths stream identically.
//
// `streamDir` IS PASSED TO THE COLD BOOT UNCONDITIONALLY (not gated on `onDelta`) — F4 fix. The
// spawn argv is this project's billing-classification surface: a caller with OCP_TUI_STREAM on
// but THIS particular request non-streaming (stream:false) must still get the SAME argv whether
// it lands on a pool HIT or a cold-boot MISS, because a pre-booted pool pane cannot know in
// advance whether the request it will eventually serve wants streaming — it installs the hook
// unconditionally whenever the pool is warming at all (see server.mjs's bootPane closure). Gating
// the cold boot's hook install on `onDelta` made a stream:false request's argv depend on whether
// it happened to hit the pool or miss it — the exact drift this surface cannot tolerate. Whether
// the hook is actually POLLED is a separate, correctly-scoped decision: see `streaming` below,
// gated on onDelta && streamFile, so a non-streaming turn never reads its own sink even though
// the hook is running.
//
// The transcript stays AUTHORITATIVE regardless: it is still the terminal-turn signal, still the
// source of the returned `text`, and still the input to the caller's honesty gates. The delta
// stream is a low-latency MIRROR of it, never a replacement, and the caller asserts the two
// agree. With onDelta AND streamDir both omitted, nothing here changes: no poll, no hook.
//
// `abortSignal` (optional): aborts the transcript wait, so a client that disconnects mid-turn
// tears the pane down NOW (the finally below) instead of holding the pane — and therefore the
// caller's semaphore slot — until the turn or the wallclock cap ends.
export async function runTuiTurn({
  prompt,
  model,
  claudeBin,
  home,
  realHome,
  cwd,
  port,
  wallclockMs = 120000,
  entrypointMode = "cli",
  tmux = defaultTmux,
  pool = null,       // TuiPanePool | null — null (default) === today's cold-boot-only path
  onPane = null,     // optional observer: ({ warm }) => void, for logging/metrics
  onDelta = null,    // (payload) => void — invoked per MessageDisplay hook fire, mid-turn
  streamDir = null,  // hook sink dir, passed to the COLD boot UNCONDITIONALLY (F4 — see above);
                      // a warm pane brings its own, fixed at its own boot
  abortSignal = null,
}) {
  // 1. Warm pane, or cold boot. A MISS is never an error — it is exactly today's path.
  let pane = pool ? pool.acquire(model) : null;
  const warm = !!pane;
  // Kick the refill IMMEDIATELY (not after the turn): the replacement pane then boots
  // CONCURRENTLY with this turn and is warm by the time the next request arrives. Also
  // runs on a MISS — acquire() has just retargeted the pool to this model, so the miss
  // that cold-boots today warms the pool for the next caller. Fire-and-forget; it takes
  // no TuiSemaphore slot (see pool.refill's SLOT ACCOUNTING note).
  if (pool) pool.refill();
  if (onPane) { try { onPane({ warm }); } catch { /* observer must never break a turn */ } }
  if (!pane) {
    // streamDir passed AS-IS (not gated on onDelta) — F4: see the STREAMING comment above.
    pane = await bootTuiPane({ model, claudeBin, home, realHome, cwd, port, entrypointMode, tmux,
                              streamDir });
  }
  const tmuxName  = pane.name;
  const sessionId = pane.sessionId;   // THIS pane's own session-id — one session, one turn
  const ehome     = pane.ehome || home || process.env.HOME;

  // Streaming state is read off the PANE, not recomputed here — a warm pane fixed its sink at
  // boot, and a cold one just did the same above. If the pool was booted WITHOUT a streamDir
  // while onDelta is set, streamFile is null and the turn degrades to buffered: correct, just
  // not fast. (server.mjs wires the same streamDir into both paths so that cannot happen.)
  const streamFile = pane.streamFile || null;
  const streaming  = !!(onDelta && streamFile);
  const streamCursor = { consumed: 0 };
  let streamStopped = false;
  let pollTimer = null;
  // Drain every complete line appended since the last drain. Never throws into the turn: a
  // malformed line is skipped by parseDeltaChunk, and an onDelta that throws is contained.
  const drainDeltas = () => {
    if (!streaming) return;
    let text;
    try { text = readFileSync(streamFile, "utf8"); } catch { return; } // absent until the first fire
    const { deltas, consumed } = parseDeltaChunk(text, streamCursor.consumed);
    streamCursor.consumed = consumed;
    for (const d of deltas) {
      try { onDelta(d); } catch { /* a sink error must never abort the turn */ }
    }
  };

  // Write prompt to a temp file (mode 0600) so the content never touches argv.
  const tmpDir     = mkdtempSync(`${tmpdir()}/ocp-tui-`);
  const promptFile = `${tmpDir}/prompt.txt`;
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  try {
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

    // 5a. Streaming only: start polling the hook sink. Runs CONCURRENTLY with the
    //     transcript wait below — the deltas are what make the answer visible while the
    //     turn is still generating; the transcript is what makes it authoritative.
    if (streaming) {
      const loop = () => {
        if (streamStopped) return;
        drainDeltas();
        pollTimer = setTimeout(loop, STREAM_POLL_MS);
      };
      pollTimer = setTimeout(loop, STREAM_POLL_MS);
    }

    // 5b. Block on the native transcript (resolved by THIS pane's session-id) until terminal.
    //     Returns { text, entrypoint, truncated } from readTuiTranscript.
    const result = await readTuiTranscript({ home: ehome, sessionId, wallclockMs, abortSignal });

    // 5c. FINAL drain. The terminal marker can land between two poll ticks, so the last
    //     delta(s) may still be unread — without this the tail would be missing from the
    //     stream and every turn would need a transcript top-up.
    streamStopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    drainDeltas();
    return result;
  } finally {
    // 6. Teardown — always, even on throw (including an abortSignal disconnect, which is
    //    exactly why the pane cannot outlive a client that walked away). A pooled pane is
    //    torn down here exactly like a cold-booted one: SINGLE-USE, never returned (pool.mjs).
    streamStopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    try { tmux(["kill-session", "-t", tmuxName]); } catch { /* already gone */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (streamFile) { try { rmSync(streamFile, { force: true }); } catch { /* best effort */ } }
  }
}
