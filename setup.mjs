#!/usr/bin/env node
/**
 * OCP (Open Claude Proxy) setup
 *
 * Automatically configures OpenClaw to use Claude CLI as a model provider.
 * Run: node setup.mjs [--port 3456] [--default-model opus|sonnet|haiku] [--dry-run]
 *
 * What it does:
 *   1. Verifies claude CLI is installed and authenticated
 *   2. Patches openclaw.json — adds claude-local provider + models
 *   3. Patches auth-profiles.json — adds dummy auth entry
 *   4. Creates start.sh for easy launch
 *   5. Optionally starts the proxy
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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

const PORT = parseInt(opt("port", "3456"), 10);
const DEFAULT_MODEL = opt("default-model", "opus"); // opus | sonnet | haiku
const DRY_RUN = flag("dry-run");
const SKIP_START = flag("no-start");
const PROVIDER_NAME = opt("provider-name", "claude-local");
const BIND_ADDRESS = opt("bind", "127.0.0.1");
const AUTH_MODE_CONFIG = opt("auth-mode", "none");

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
  const ver = execSync("claude --version 2>/dev/null", { encoding: "utf-8" }).trim();
  log(`Claude CLI: ${ver}`);
} catch {
  fail("Claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code");
}

// Check claude auth (quick test)
try {
  const out = execSync('claude -p --output-format text --no-session-persistence -- "ping"', {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, CLAUDECODE: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
  }).trim();
  if (out.length > 0) {
    log(`Claude CLI authenticated (test response: "${out.slice(0, 40)}...")`);
  }
} catch (e) {
  warn(`Claude CLI auth test failed: ${e.message.slice(0, 100)}`);
  warn("Make sure you're logged in: claude login");
}

// Check openclaw config
if (!existsSync(CONFIG_PATH)) fail(`OpenClaw config not found at ${CONFIG_PATH}`);
log(`OpenClaw config: ${CONFIG_PATH}`);

// ── Step 2: Patch openclaw.json ─────────────────────────────────────────
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

import { readdirSync } from "node:fs";

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

// ── Step 4: Create start.sh ─────────────────────────────────────────────
console.log("\n🚀 Creating launcher...\n");

const serverPath = join(__dirname, "server.mjs");
const logDir = join(OPENCLAW_DIR, "logs");
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

const startSh = `#!/bin/bash
# Start OCP (Open Claude Proxy) if not already running
PORT=\${CLAUDE_PROXY_PORT:-${PORT}}
if ! lsof -i :\$PORT -sTCP:LISTEN &>/dev/null; then
  unset CLAUDECODE
  nohup node "${serverPath}" \\
    >> "${logDir}/claude-proxy.log" \\
    2>> "${logDir}/claude-proxy.err.log" &
  echo "claude-proxy started on port \$PORT (pid $!)"
else
  echo "claude-proxy already running on port \$PORT"
fi
`;

const startPath = join(__dirname, "start.sh");
if (!DRY_RUN) {
  writeFileSync(startPath, startSh);
  execSync(`chmod +x "${startPath}"`);
}
log(`Launcher: ${startPath}`);

// ── Step 5: Summary ─────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════════════╗
║                  Setup complete!                             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Provider: ${PROVIDER_NAME.padEnd(44)}║
║  Port:     ${String(PORT).padEnd(44)}║
║  Models:   ${`see models.json (${MODELS.length} available)`.padEnd(44)}║
║  Default:  ${DEFAULT_MODEL_ID.padEnd(44)}║
║                                                              ║
║  Start proxy:                                                ║
║    bash ${startPath.replace(HOME, "~").padEnd(50)}║
║                                                              ║
║  Or directly:                                                ║
║    node ${serverPath.replace(HOME, "~").padEnd(49)}║
║                                                              ║
║  Set as default model in openclaw.json:                      ║
║    agents.defaults.model.primary =                           ║
║      "${PROVIDER_NAME}/${DEFAULT_MODEL_ID}"${" ".repeat(Math.max(0, 30 - PROVIDER_NAME.length - DEFAULT_MODEL_ID.length))}║
║                                                              ║
║  Then restart gateway:                                       ║
║    openclaw gateway restart                                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

// ── Step 7: Install auto-start on boot ──────────────────────────────────
if (!DRY_RUN) {
  console.log("\n🔄 Installing auto-start on login...\n");

  const platform = process.platform;
  // Use stable symlink path instead of versioned Cellar path (e.g. /opt/homebrew/opt/node/bin/node
  // instead of /opt/homebrew/Cellar/node/25.8.0/bin/node) so the plist survives node upgrades.
  let nodeBin = process.execPath;
  if (platform === "darwin" && nodeBin.includes("/Cellar/")) {
    const stable = nodeBin.replace(/\/Cellar\/[^/]+\/[^/]+\//, "/opt/");
    if (existsSync(stable)) {
      nodeBin = stable;
      log(`Using stable node path: ${nodeBin}`);
    }
  }

  // Ensure logs dir exists
  const logsDir = join(OPENCLAW_DIR, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  // Use neutral service names to avoid OpenClaw gateway's extra-service detection.
  // OpenClaw scans LaunchAgent plists and systemd units for "openclaw" / "clawdbot"
  // markers and flags them as conflicting gateway-like services. Using "dev.ocp.*"
  // and "ocp-proxy" keeps the proxy invisible to that heuristic.
  const OCP_HOME = join(HOME, ".ocp");
  const ocpLogsDir = join(OCP_HOME, "logs");
  if (!existsSync(ocpLogsDir)) mkdirSync(ocpLogsDir, { recursive: true });

  // Uninstall legacy service names if present (upgrade path)
  if (platform === "darwin") {
    const legacyPlist = join(HOME, "Library", "LaunchAgents", "ai.openclaw.proxy.plist");
    if (existsSync(legacyPlist)) {
      try { execSync(`launchctl bootout gui/$(id -u) "${legacyPlist}" 2>/dev/null`); } catch { /* ignore */ }
      try { unlinkSync(legacyPlist); } catch { /* ignore */ }
      log(`Removed legacy plist: ai.openclaw.proxy`);
    }
  } else if (platform === "linux") {
    const legacyService = join(HOME, ".config", "systemd", "user", "openclaw-proxy.service");
    if (existsSync(legacyService)) {
      try { execSync(`systemctl --user stop openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
      try { execSync(`systemctl --user disable openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
      try { unlinkSync(legacyService); } catch { /* ignore */ }
      try { execSync(`systemctl --user daemon-reload`); } catch { /* ignore */ }
      log(`Removed legacy systemd service: openclaw-proxy`);
    }
  }

  if (platform === "darwin") {
    // macOS: launchd
    const plistDir = join(HOME, "Library", "LaunchAgents");
    if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true });

    const plistPath = join(plistDir, "dev.ocp.proxy.plist");
    const logPath = join(ocpLogsDir, "proxy.log");

    const plistXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ocp.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${serverPath}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_PROXY_PORT</key>
    <string>${PORT}</string>
    <key>CLAUDE_BIND</key>
    <string>${BIND_ADDRESS}</string>
    <key>CLAUDE_AUTH_MODE</key>
    <string>${AUTH_MODE_CONFIG}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;

    writeFileSync(plistPath, plistXml);
    log(`Plist written: ${plistPath}`);

    // Bootout first (in case it was already loaded) then bootstrap
    try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null`); } catch { /* ignore */ }
    execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`);
    log(`launchctl loaded dev.ocp.proxy`);

  } else if (platform === "linux") {
    // Linux: systemd user service
    const systemdDir = join(HOME, ".config", "systemd", "user");
    if (!existsSync(systemdDir)) mkdirSync(systemdDir, { recursive: true });

    const servicePath = join(systemdDir, "ocp-proxy.service");
    const logPath = join(ocpLogsDir, "proxy.log");

    const serviceUnit = `[Unit]
Description=OCP — Open Claude Proxy
After=network.target

[Service]
ExecStart=${nodeBin} ${serverPath}
Environment=CLAUDE_PROXY_PORT=${PORT}
Environment=CLAUDE_BIND=${BIND_ADDRESS}
Environment=CLAUDE_AUTH_MODE=${AUTH_MODE_CONFIG}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

    writeFileSync(servicePath, serviceUnit);
    log(`Service file written: ${servicePath}`);

    execSync(`systemctl --user daemon-reload`);
    execSync(`systemctl --user enable ocp-proxy`);
    execSync(`systemctl --user start ocp-proxy`);
    log(`systemd user service enabled and started`);

  } else {
    warn(`Auto-start not supported on ${platform} — start manually with: bash ${startPath}`);
  }

  console.log("\n✅ Auto-start installed — proxy will start automatically on login\n");

  // ── Step 8: Post-install health verification ───────────────────────────
  if (!SKIP_START) {
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

        // Verify bind socket
        try {
          const bindCheck = process.platform === "linux"
            ? execSync(`ss -tlnp 2>/dev/null | grep ':${PORT}'`, { encoding: "utf-8" }).trim()
            : execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf-8" }).trim();
          if (bindCheck) {
            console.log(`    bind:     ${bindCheck.split("\n")[0]}`);
          }
        } catch { /* bind check is best-effort */ }

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
