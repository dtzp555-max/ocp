#!/usr/bin/env node
/**
 * OCP (Open Claude Proxy) setup
 *
 * Automatically configures OpenClaw to use Claude CLI as a model provider.
 * Run: node setup.mjs [--port N] [--default-model opus|sonnet|haiku] [--dry-run] [--reconfigure-only]
 *      (default port = DEFAULT_PORT from lib/constants.mjs)
 *      --reconfigure-only: write the service unit/plist but do not enable-at-boot or start it
 *        now (used by `ocp update`'s reconfigure phase; see scripts/lib/service-mode.mjs)
 *
 * What it does:
 *   1. Verifies claude CLI is installed and authenticated
 *   2. Patches openclaw.json — adds claude-local provider + models
 *   3. Patches auth-profiles.json — adds dummy auth entry
 *   4. Creates start.sh for easy launch
 *   5. Optionally starts the proxy
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolveServicePlan } from "./scripts/lib/service-mode.mjs";
import { installAutoStart } from "./scripts/lib/install-autostart.mjs";
import { buildStartSh, classifyBindCheck } from "./scripts/lib/start-sh.mjs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./lib/constants.mjs";
import { scrubInboundAuthEnv } from "./lib/spawn-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const OPENCLAW_DIR = process.env.OPENCLAW_STATE_DIR || join(HOME, ".openclaw");
const CONFIG_PATH = join(OPENCLAW_DIR, "openclaw.json");

// ── Parse args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = parseInt(opt("port", String(DEFAULT_PORT)), 10);
const DEFAULT_MODEL = opt("default-model", "opus"); // opus | sonnet | haiku
const DRY_RUN = flag("dry-run");
const SKIP_START = flag("no-start");
// --reconfigure-only (issue #226): write the service unit / plist, but never enable-at-boot
// or start-now. For use by scripts/upgrade.mjs's phase 4 ("reconfigure"), so an upgrade's
// installer step stops performing phase 5's job (starting the service) — see
// scripts/lib/service-mode.mjs for the full reasoning. Not used on a first install: that path
// (scripts/doctor.mjs's fresh_install ai_executable) invokes `node setup.mjs` bare, and must
// keep enabling + starting — that IS a first install's job.
// NOT parsed as a bare `flag()` const here like the others above: the parse itself is folded
// into scripts/lib/service-mode.mjs's resolveServicePlan(args, platform) (called below, once
// `platform` is known), so the argv-to-behavior path is one tested function rather than a
// setup.mjs-local assignment that no test can reach.
const PROVIDER_NAME = opt("provider-name", "claude-local");
const BIND_ADDRESS = opt("bind", "127.0.0.1");
const AUTH_MODE_CONFIG = opt("auth-mode", "none");

// ── Service-env injection: CLAUDE_BIN, OCP_ADMIN_KEY, PROXY_ANONYMOUS_KEY ──
// These are read from the user's shell env at install time and written into
// the service unit (plist / systemd) so the daemon picks them up on boot.

// CLAUDE_BIN — detect at install time; omit if not found (server.mjs fallback)
let CLAUDE_BIN_INJECT = null;
if (process.env.CLAUDE_BIN) {
  CLAUDE_BIN_INJECT = process.env.CLAUDE_BIN;
} else {
  try {
    const detected = execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim();
    if (detected && existsSync(detected)) {
      CLAUDE_BIN_INJECT = detected;
    }
  } catch { /* which not available or claude not on PATH — omit */ }
}

// OCP_ADMIN_KEY — omit entirely when empty/unset; don't write empty string
const OCP_ADMIN_KEY_INJECT = process.env.OCP_ADMIN_KEY || null;

// PROXY_ANONYMOUS_KEY — same pattern
const PROXY_ANON_KEY_INJECT = process.env.PROXY_ANONYMOUS_KEY || null;

// ── Inject-value helpers ─────────────────────────────────────────────────
// Validate an injected service value: no control chars (a newline would inject a
// rogue systemd Environment= directive; other control chars corrupt the unit/plist).
// Spaces are allowed — filesystem paths (CLAUDE_BIN) may legitimately contain them.
function assertSafeInjectValue(name, v) {
  if (v == null) return v;
  if (/[\x00-\x1f]/.test(String(v))) {
    console.error(`FATAL: ${name} contains a newline or control character — refusing to write it into the service unit.`);
    process.exit(1);
  }
  return v;
}

// Validate all three INJECT values before they are written into any service unit.
assertSafeInjectValue("CLAUDE_BIN", CLAUDE_BIN_INJECT);
assertSafeInjectValue("OCP_ADMIN_KEY", OCP_ADMIN_KEY_INJECT);
assertSafeInjectValue("PROXY_ANONYMOUS_KEY", PROXY_ANON_KEY_INJECT);

// ── Models: derived from models.json (single source of truth) ──────────
const modelsConfig = JSON.parse(readFileSync(join(__dirname, "models.json"), "utf-8"));

const MODEL_ID_MAP = modelsConfig.aliases;
const DEFAULT_MODEL_ID = MODEL_ID_MAP[DEFAULT_MODEL] || MODEL_ID_MAP.opus;

const MODELS = modelsConfig.models.map(m => ({
  id: m.id,
  name: m.openclawName,
  reasoning: m.reasoning,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
}));

const MODEL_ALIASES = Object.fromEntries(
  modelsConfig.models.map(m => [`${PROVIDER_NAME}/${m.id}`, { alias: m.displayName }])
);

// ── Helpers ─────────────────────────────────────────────────────────────
function log(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJSON(path, data) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would write ${path}`);
    return;
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// ── Step 1: Verify prerequisites ────────────────────────────────────────
console.log("\n🔍 Checking prerequisites...\n");

// Check node version
const nodeVer = parseInt(process.versions.node.split(".")[0], 10);
if (nodeVer < 18) fail(`Node.js >= 18 required (found ${process.versions.node})`);
log(`Node.js ${process.versions.node}`);

// Check claude CLI
try {
  // #328: this one had no `env` option at all, so it inherited everything. `--version` reads no
  // prompt, so it is the least exposed of the spawns — scrubbed anyway, because "which spawns are
  // safe to leak to" is not a judgement anyone should have to re-make at each call site.
  const ver = execSync("claude --version 2>/dev/null",
    { encoding: "utf-8", env: scrubInboundAuthEnv({ ...process.env }).env }).trim();
  log(`Claude CLI: ${ver}`);
} catch {
  fail("Claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code");
}

// Check claude auth (quick test)
// NOTE: This probe uses `claude -p` (sdk-cli spawn). After the 2026-06-15 Anthropic billing
// split, every `claude -p` call draws from the Agent SDK credit pool rather than the
// Pro/Max subscription. Re-running setup after 6/15 will consume one metered credit.
// Set OCP_SKIP_AUTH_TEST=1 to skip this probe (auth is still validated at first real request).
if (process.env.OCP_SKIP_AUTH_TEST === "1") {
  warn("OCP_SKIP_AUTH_TEST=1 — skipping claude auth probe (will be validated at first request).");
} else {
  try {
    const out = execSync('claude -p --output-format text --no-session-persistence -- "ping"', {
      encoding: "utf-8",
      timeout: 30000,
      // #328: the FOURTH hand-rolled copy of the four-name denylist lived here, and it leaked all
      // three inbound secrets to the child. Lower severity than the request path — this child's
      // prompt is the literal "ping", so it never reads attacker-controlled text — but it is
      // reachable from `ocp update` (scripts/upgrade.mjs runs `setup.mjs --reconfigure-only`, and
      // the probe is gated only on OCP_SKIP_AUTH_TEST), and leaving it is exactly the
      // "denylist you must remember to extend" failure this fix exists to end.
      env: scrubInboundAuthEnv({ ...process.env, CLAUDECODE: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined }).env,
    }).trim();
    if (out.length > 0) {
      log(`Claude CLI authenticated (test response: "${out.slice(0, 40)}...")`);
    }
  } catch (e) {
    warn(`Claude CLI auth test failed: ${e.message.slice(0, 100)}`);
    warn("Make sure you're logged in: claude login");
  }
}

// Check openclaw config (optional — OCP runs standalone without OpenClaw)
const OPENCLAW_PRESENT = existsSync(CONFIG_PATH);
if (OPENCLAW_PRESENT) {
  log(`OpenClaw config: ${CONFIG_PATH}`);
} else {
  warn(`OpenClaw not detected at ${CONFIG_PATH} — skipping OpenClaw integration.`);
  warn(`To register OCP with OpenClaw later, install OpenClaw and re-run \`node setup.mjs\`,`);
  warn(`or run \`ocp update\` if OpenClaw is installed afterward.`);
}

// ── Step 2: Patch openclaw.json ─────────────────────────────────────────
if (OPENCLAW_PRESENT) {
  console.log("\n📝 Configuring OpenClaw...\n");

  const config = readJSON(CONFIG_PATH);

  // Ensure models.providers exists
  if (!config.models) config.models = {};
  if (!config.models.providers) config.models.providers = {};

  // Add/update claude-local provider
  config.models.providers[PROVIDER_NAME] = {
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    api: "openai-completions",
    authHeader: false,
    models: MODELS,
  };
  log(`Provider "${PROVIDER_NAME}" → http://127.0.0.1:${PORT}/v1`);

  // Ensure auth profile in config
  if (!config.auth) config.auth = {};
  if (!config.auth.profiles) config.auth.profiles = {};
  config.auth.profiles[`${PROVIDER_NAME}:default`] = {
    provider: PROVIDER_NAME,
    mode: "api_key",
  };
  log(`Auth profile "${PROVIDER_NAME}:default" registered`);

  // Add models to agents.defaults.models
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models) config.agents.defaults.models = {};
  for (const [key, val] of Object.entries(MODEL_ALIASES)) {
    config.agents.defaults.models[key] = val;
  }
  log(`Model aliases added to agents.defaults.models`);

  // Set idleTimeoutSeconds to 0 — critical for Claude tool-use.
  // When Claude calls tools (Bash, Read, etc.), the token stream pauses for 30-120s.
  // OpenClaw's default idleTimeoutSeconds (60s) kills the connection mid-tool-call,
  // causing exit 143 (SIGTERM) and stuck sessions. Setting to 0 disables the idle timer.
  if (!config.agents.defaults.llm) config.agents.defaults.llm = {};
  if (config.agents.defaults.llm.idleTimeoutSeconds === undefined ||
      config.agents.defaults.llm.idleTimeoutSeconds > 0) {
    config.agents.defaults.llm.idleTimeoutSeconds = 0;
    log(`Set agents.defaults.llm.idleTimeoutSeconds = 0 (prevents tool-call timeouts)`);
  } else {
    log(`idleTimeoutSeconds already configured: ${config.agents.defaults.llm.idleTimeoutSeconds}`);
  }

  writeJSON(CONFIG_PATH, config);
  log(`Config saved`);

  // ── Step 3: Patch auth-profiles.json ────────────────────────────────────
  console.log("\n🔑 Configuring auth profiles...\n");

  // Find all agent auth-profiles.json files
  const agentsDir = join(OPENCLAW_DIR, "agents");
  const agentDirs = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((d) => {
        const ap = join(agentsDir, d, "agent", "auth-profiles.json");
        return existsSync(ap);
      })
    : [];

  for (const agentId of agentDirs) {
    const apPath = join(agentsDir, agentId, "agent", "auth-profiles.json");
    try {
      const ap = readJSON(apPath);
      if (!ap.profiles) ap.profiles = {};

      // Add claude-local profile if missing
      if (!ap.profiles[`${PROVIDER_NAME}:default`]) {
        ap.profiles[`${PROVIDER_NAME}:default`] = {
          type: "api_key",
          provider: PROVIDER_NAME,
          key: "local-proxy-no-auth",
        };
      }

      // Add to lastGood if missing
      if (!ap.lastGood) ap.lastGood = {};
      if (!ap.lastGood[PROVIDER_NAME]) {
        ap.lastGood[PROVIDER_NAME] = `${PROVIDER_NAME}:default`;
      }

      writeJSON(apPath, ap);
      log(`Agent "${agentId}" auth profile updated`);
    } catch (e) {
      warn(`Skipped agent "${agentId}": ${e.message}`);
    }
  }

  if (agentDirs.length === 0) {
    warn("No agent auth-profiles.json found — you may need to restart the gateway first");
  }
}

// ── Step 4: Create start.sh ─────────────────────────────────────────────
console.log("\n🚀 Creating launcher...\n");

const serverPath = join(__dirname, "server.mjs");
const logDir = join(OPENCLAW_DIR, "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

// issue #246: the port-liveness check (bare `lsof`, gates whether a second server.mjs gets
// nohup'd) is extracted into scripts/lib/start-sh.mjs's buildStartSh() so it can be driven
// by injected fake lsof/netstat binaries in tests -- see that file's header for the full
// defect writeup and the darwin/non-darwin scope decision.
const startSh = buildStartSh({ port: PORT, serverPath, logDir });

const startPath = join(__dirname, "start.sh");
if (!DRY_RUN) {
  writeFileSync(startPath, startSh);
  execSync(`chmod +x "${startPath}"`);
}
log(`Launcher: ${startPath}`);

// ── Step 5: Summary ─────────────────────────────────────────────────────
const banner = [
  `╔══════════════════════════════════════════════════════════════╗`,
  `║                  Setup complete!                             ║`,
  `╠══════════════════════════════════════════════════════════════╣`,
  `║                                                              ║`,
  `║  Provider: ${PROVIDER_NAME.padEnd(44)}║`,
  `║  Port:     ${String(PORT).padEnd(44)}║`,
  `║  Models:   ${`see models.json (${MODELS.length} available)`.padEnd(44)}║`,
  `║  Default:  ${DEFAULT_MODEL_ID.padEnd(44)}║`,
  `║                                                              ║`,
  `║  Start proxy:                                                ║`,
  `║    bash ${startPath.replace(HOME, "~").padEnd(50)}║`,
  `║                                                              ║`,
  `║  Or directly:                                                ║`,
  `║    node ${serverPath.replace(HOME, "~").padEnd(49)}║`,
  `║                                                              ║`,
];
if (OPENCLAW_PRESENT) {
  banner.push(
    `║  Set as default model in openclaw.json:                      ║`,
    `║    agents.defaults.model.primary =                           ║`,
    `║      "${PROVIDER_NAME}/${DEFAULT_MODEL_ID}"${" ".repeat(Math.max(0, 30 - PROVIDER_NAME.length - DEFAULT_MODEL_ID.length))}║`,
    `║                                                              ║`,
    `║  Then restart gateway:                                       ║`,
    `║    openclaw gateway restart                                  ║`,
    `║                                                              ║`,
  );
} else {
  banner.push(
    `║  OpenClaw not detected — running in standalone mode.         ║`,
    `║  Point your IDE (Cline / Cursor / Continue / OpenCode /      ║`,
    `║  Aider / OpenClaw) at:                                       ║`,
    `║    http://${BIND_ADDRESS}:${String(PORT)}/v1${" ".repeat(Math.max(0, 47 - BIND_ADDRESS.length - String(PORT).length))}║`,
    `║                                                              ║`,
    `║  See docs/lan-mode.md for per-IDE client setup.              ║`,
    `║                                                              ║`,
  );
}
banner.push(`╚══════════════════════════════════════════════════════════════╝`);
console.log("\n" + banner.join("\n") + "\n");

// ── Step 7: Install auto-start on boot ──────────────────────────────────

// Log service-env injection plan (shown in both dry-run and live mode)
console.log("\n🔧 Service unit env vars to inject:\n");
if (CLAUDE_BIN_INJECT) {
  log(`CLAUDE_BIN: ${CLAUDE_BIN_INJECT}`);
} else {
  log(`CLAUDE_BIN: (not found — server.mjs will auto-detect at runtime)`);
}
if (OCP_ADMIN_KEY_INJECT) {
  log(`OCP_ADMIN_KEY: injected (length: ${OCP_ADMIN_KEY_INJECT.length})`);
} else {
  log(`OCP_ADMIN_KEY: (unset — admin endpoints disabled)`);
}
if (PROXY_ANON_KEY_INJECT) {
  log(`PROXY_ANONYMOUS_KEY: injected (set)`);
} else {
  log(`PROXY_ANONYMOUS_KEY: (unset — anonymous access disabled)`);
}

if (DRY_RUN) {
  console.log("\n  [dry-run] would write service unit with above env vars\n");
}

if (!DRY_RUN) {
  const platform = process.platform;
  // Single tested seam bridging argv → behavior (see scripts/lib/service-mode.mjs). Computed
  // once here (platform is now known) and used both by installAutoStart() below and by Step
  // 8's verification gate.
  const servicePlan = resolveServicePlan(args, platform);

  // Step 7 (auto-start install: legacy-unit migration, plist/unit write, enable/start/
  // bootstrap per servicePlan) lives in scripts/lib/install-autostart.mjs — extracted so it
  // can be called with injected run/fs functions in tests. See that module's header comment
  // for why (issue #226 review: a prior source-text-assertion approach here tested
  // co-location, not containment, and a review mutation proved it — AGENTS.md's "Testing
  // discipline: what counts as a test" section, not its server.mjs-specific section, is the
  // one this had to answer to).
  installAutoStart({
    platform,
    servicePlan,
    paths: { HOME, OPENCLAW_DIR, serverPath, startPath },
    config: { PORT, BIND_ADDRESS, AUTH_MODE_CONFIG, CLAUDE_BIN_INJECT, OCP_ADMIN_KEY_INJECT, PROXY_ANON_KEY_INJECT },
    log,
    warn,
  });

  // ── Step 8: Post-install health verification ───────────────────────────
  // Skipped under --reconfigure-only too: nothing was started above, so there is nothing
  // yet to verify — the upgrade flow's own post-flight phase (phase 6) checks the real
  // post-restart state after phase 5 actually restarts the service.
  if (!SKIP_START && !servicePlan.reconfigureOnly) {
    console.log("⏳ Waiting for server to bind...\n");
    await new Promise(r => setTimeout(r, 3000));

    const healthUrl = `http://127.0.0.1:${PORT}/health`;
    let verified = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        console.log(`  ✓ Health check passed (${healthUrl})`);
        console.log(`    version:  ${body.version ?? "unknown"}`);
        console.log(`    authMode: ${body.authMode ?? "unknown"}`);

        // Verify bind socket. issue #246 (second half): classifyBindCheck() builds the same
        // absolute-path-preferred lsof/ss command as before (see scripts/lib/start-sh.mjs's
        // header for why this call site stays absolute-path-only, no netstat cross-check),
        // but never redirects the underlying command's own stderr to /dev/null, and
        // distinguishes "could not run" (a real tool-execution fault) from "ran, found
        // nothing" (unchanged -- stays silent). The pre-fix body's bare `catch {}` discarded
        // both identically. Cosmetic only: `verified` below is set true unconditionally
        // regardless of this block's outcome -- the HTTP health check above already
        // confirmed the server is up. See classifyBindCheck()'s own header for the full
        // trace of why this stays a diagnostic line, not a gate.
        //
        // Independent review round 1 (LOW-1): classifyBindCheck() itself funnels every
        // expected failure into a returned `kind` rather than throwing, so this inner
        // try/catch is provably unreachable under normal use today -- but it costs nothing to
        // keep, and it means an unforeseen future exception here can never silently skip
        // `verified = true` below, which would misreport a genuinely healthy server as
        // "did not respond" and exit 1. Insurance against this cosmetic diagnostic ever
        // becoming load-bearing by accident, not a response to a live defect.
        try {
          const bindCheck = classifyBindCheck({ port: PORT, platform: process.platform });
          if (bindCheck.kind === "found") {
            console.log(`    bind:     ${bindCheck.line}`);
          } else if (bindCheck.kind === "could-not-run") {
            warn(`bind check could not run (${bindCheck.detail}) — cosmetic only, the health check above already confirmed the server is up`);
          }
        } catch { /* insurance only -- see comment above; classifyBindCheck() should never reach here */ }

        verified = true;
      } else {
        warn(`Health check returned HTTP ${res.status} — service may not have started cleanly`);
      }
    } catch (e) {
      const isTimeout = e.name === "AbortError" || (e.cause && e.cause.code === "UND_ERR_CONNECT_TIMEOUT");
      warn(`Health check failed: ${isTimeout ? "timeout (5s)" : e.message}`);
    }

    if (!verified) {
      const logHint = process.platform === "linux"
        ? "journalctl --user -u ocp-proxy -n 50"
        : `tail -n 100 ~/.ocp/logs/proxy.log`;
      console.error(`\n  ✗ Server did not respond on port ${PORT} within 5 seconds.`);
      console.error(`    Check service logs:\n      ${logHint}\n`);
      process.exit(1);
    }
  }
}
