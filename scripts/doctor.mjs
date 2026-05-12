#!/usr/bin/env node
/**
 * scripts/doctor.mjs — OCP health & upgrade-readiness check.
 *
 * Usage:
 *   ocp doctor                  human-readable PASS/WARN/FAIL
 *   ocp doctor --json           machine-readable JSON for AI agents + ocp update
 *   ocp doctor --check oauth    fast path: only OAuth check
 *
 * Exit codes:
 *   0  all PASS or WARN-only
 *   1  any FAIL
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const SCHEMA_VERSION = "1";

function semverParts(v) {
  const m = String(v).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function semverCompare(a, b) {
  const A = semverParts(a), B = semverParts(b);
  if (!A || !B) return 0;
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  return A.patch - B.patch;
}

export async function runDoctor(opts = {}) {
  const checks = [];
  const push = (id, level, message, extra = {}) =>
    checks.push({ id, level, message, ...extra });

  // --- fast path: --check oauth ---
  if (opts.checkOnly === "oauth") {
    return runOauthOnly(opts, checks, push);
  }

  // --- version detection ---
  const ocpDir = opts.ocpDir || join(homedir(), "ocp");
  let currentVersion = opts.mockVersion;
  if (!currentVersion) {
    try {
      const pkg = JSON.parse(readFileSync(join(ocpDir, "package.json"), "utf8"));
      currentVersion = `v${pkg.version}`;
    } catch {
      currentVersion = "unknown";
    }
  }
  // Resolve latest from origin/main (cheap: `git show origin/main:package.json`).
  // Falls back to current_version when network/git unavailable, so kind = noop instead
  // of recommending a downgrade against a stale hardcoded value.
  let latestVersion = opts.mockLatest;
  if (!latestVersion) {
    try {
      const out = execSync(`git -C ${ocpDir} show origin/main:package.json 2>/dev/null`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
      const remotePkg = JSON.parse(out);
      latestVersion = `v${remotePkg.version}`;
    } catch {
      latestVersion = currentVersion;
    }
  }
  push("current_version", "PASS", `current=${currentVersion}`);

  // --- from-version supported? ---
  const fromSupported = !!semverParts(currentVersion) && semverCompare(currentVersion, "v3.4.0") >= 0;
  push("from_version_supported", fromSupported ? "PASS" : "FAIL",
       fromSupported ? "≥ v3.4.0" : `${currentVersion} < v3.4.0; in-place upgrade not supported`);

  // --- service health check (mockable) ---
  let healthOk = true, oauthOk = true;
  if (!opts.skipNetwork) {
    let health;
    if (opts.mockHealth !== undefined) {
      health = opts.mockHealth;
    } else {
      try {
        const port = process.env.CLAUDE_PROXY_PORT || "3456";
        const out = execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/health`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
        health = { status: 200, body: JSON.parse(out) };
      } catch (e) {
        health = { error: String(e.message || e) };
      }
    }
    if (health.error || health.status !== 200) {
      healthOk = false;
      push("service_running", "FAIL", `service unreachable: ${health.error || `status ${health.status}`}`);
    } else if (!health.body || typeof health.body !== "object") {
      healthOk = false;
      push("service_running", "FAIL", "service /health returned 200 but empty/non-JSON body");
    } else {
      push("service_running", "PASS", "service responding on /health");
      const authOk = health.body?.auth?.ok;
      if (!authOk) {
        oauthOk = false;
        push("oauth_ok", "FAIL", `auth.ok=false: ${health.body?.auth?.message || "unknown"}`);
      } else {
        push("oauth_ok", "PASS", "OAuth token valid");
      }
    }
  }

  // --- determine next_action.kind (priority: fresh_install > fix_service > fix_oauth > noop > update > upgrade) ---
  let kind;
  if (!fromSupported) {
    kind = "fresh_install";
  } else if (!opts.skipNetwork && !healthOk) {
    kind = "fix_service";
  } else if (!opts.skipNetwork && !oauthOk) {
    kind = "fix_oauth";
  } else {
    const cur = semverParts(currentVersion), lat = semverParts(latestVersion);
    if (!cur) {
      kind = "fresh_install";
    } else if (semverCompare(currentVersion, latestVersion) === 0) {
      kind = "noop";
    } else if (lat && cur.major === lat.major && cur.minor === lat.minor) {
      kind = "update";
    } else {
      kind = "upgrade";
    }
  }

  // --- next_action shape ---
  let next_action;
  if (kind === "fresh_install") {
    next_action = {
      kind,
      human_required: ["claude auth login (only if OAuth becomes invalid after reinstall)"],
      ai_executable: [
        `launchctl bootout gui/$(id -u)/ai.openclaw.proxy 2>/dev/null || true`,
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `mv ${join(homedir(), ".ocp")} ${join(homedir(), ".ocp.backup-")}$(date +%s) 2>/dev/null || true`,
        `rm -rf ${ocpDir}`,
        `git clone https://github.com/dtzp555-max/ocp ${ocpDir}`,
        `cd ${ocpDir} && npm install --no-audit --no-fund && node setup.mjs`,
        `${ocpDir}/ocp doctor`
      ],
      verify: "ocp doctor expects PASS on all checks"
    };
  } else if (kind === "noop") {
    next_action = { kind, human_required: [], ai_executable: [], verify: "already at latest" };
  } else if (kind === "fix_oauth") {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `cd "$(npm root -g)/@anthropic-ai/claude-code" && node install.cjs`,
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor`
      ],
      verify: "ocp doctor expects oauth_ok=PASS",
      reference: "~/.cc-rules/memory/learnings/ocp_claude_native_binary_postinstall.md"
    };
  } else if (kind === "fix_service") {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor`
      ],
      verify: "ocp doctor expects service_running=PASS"
    };
  } else {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [`${ocpDir}/ocp update --yes`],
      verify: "ocp doctor expects PASS on all checks"
    };
  }

  const fail_count = checks.filter(c => c.level === "FAIL").length;
  const warn_count = checks.filter(c => c.level === "WARN").length;
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ready_to_upgrade: fail_count === 0,
    current_version: currentVersion,
    latest_version: latestVersion,
    from_version_supported: fromSupported,
    fail_count,
    warn_count,
    checks,
    next_action
  };
}

function runOauthOnly(opts, checks, push) {
  let healthOk = true, oauthOk = true;
  let health;
  if (opts.mockHealth !== undefined) {
    health = opts.mockHealth;
  } else {
    try {
      const port = process.env.CLAUDE_PROXY_PORT || "3456";
      const out = execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/health`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
      health = { status: 200, body: JSON.parse(out) };
    } catch (e) {
      health = { error: String(e.message || e) };
    }
  }

  if (health.error || health.status !== 200) {
    healthOk = false;
    push("oauth_ok", "FAIL", `service unreachable: ${health.error || `status ${health.status}`}`);
  } else if (!health.body || typeof health.body !== "object") {
    healthOk = false;
    push("oauth_ok", "FAIL", "service /health returned 200 but empty/non-JSON body");
  } else if (!health.body?.auth?.ok) {
    oauthOk = false;
    push("oauth_ok", "FAIL", `auth.ok=false: ${health.body?.auth?.message || "unknown"}`);
  } else {
    push("oauth_ok", "PASS", "OAuth token valid");
  }

  const kind = !healthOk ? "fix_service" : !oauthOk ? "fix_oauth" : "noop";

  let next_action;
  const ocpDir = opts.ocpDir || join(homedir(), "ocp");
  if (kind === "noop") {
    next_action = { kind, human_required: [], ai_executable: [], verify: "OAuth healthy" };
  } else if (kind === "fix_oauth") {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `cd "$(npm root -g)/@anthropic-ai/claude-code" && node install.cjs`,
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor --check oauth`
      ],
      verify: "ocp doctor --check oauth expects PASS",
      reference: "~/.cc-rules/memory/learnings/ocp_claude_native_binary_postinstall.md"
    };
  } else {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor --check oauth`
      ],
      verify: "ocp doctor --check oauth expects service_running=PASS"
    };
  }

  const fail_count = checks.filter(c => c.level === "FAIL").length;
  // "skipped" = --check oauth fast path intentionally omits version detection.
  // AI agents should NOT semver-compare against current_version/latest_version when
  // either equals "skipped"; the full path provides those fields when needed.
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ready_to_upgrade: fail_count === 0,
    current_version: opts.mockVersion || "skipped",
    latest_version: opts.mockLatest || "skipped",
    from_version_supported: true,
    fail_count,
    warn_count: 0,
    checks,
    next_action
  };
}

// CLI entrypoint — use fileURLToPath + realpath to handle symlinked install paths
// (e.g. /tmp/ → /private/tmp/ on macOS would otherwise miss the guard).
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
function _isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}
if (_isMain()) {
  const wantJson = process.argv.includes("--json");
  const checkIdx = process.argv.indexOf("--check");
  const checkOnly = checkIdx !== -1 ? process.argv[checkIdx + 1] : undefined;
  const result = await runDoctor({ checkOnly });
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`OCP doctor — ${result.current_version} → ${result.latest_version}`);
    for (const c of result.checks) console.log(`  [${c.level}] ${c.id}: ${c.message}`);
    console.log(`\nSummary: ${result.fail_count} FAIL, ${result.warn_count} WARN`);
    console.log(`Next action: ${result.next_action.kind}`);
  }
  process.exit(result.fail_count === 0 ? 0 : 1);
}
