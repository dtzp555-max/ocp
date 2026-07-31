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
import { DEFAULT_PORT } from "../lib/constants.mjs";

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

// ═══════════════════════════════════════════════════════════════════════════
// Multi-unit boot-race pre-flight check (issue #220, incident #215)
//
// On a real host, a system-scope systemd unit (/etc/systemd/system/ocp.service,
// bind 0.0.0.0) and a user-scope systemd unit (~/.config/systemd/user/
// ocp-proxy.service, bind 127.0.0.1) were BOTH enabled and BOTH pointed at the
// same server.mjs working tree and the same port, with drifted config. Whichever
// won the boot race silently decided the host's LAN reachability. Nothing in
// `ocp doctor` surfaced this; it was found by hand while diagnosing an unrelated
// update failure. See issue #215 for the live evidence table.
//
// Relationship to scripts/lib/restart-unit.mjs (PR #221, issue #215's OTHER
// half): that module resolves which unit CURRENTLY owns the port from LIVE
// process/cgroup state (ss/lsof + /proc/<pid>/cgroup) for the upgrade restart
// phase — a live-PID question. This check answers a different, STATIC question
// — which units WOULD start at boot, and are any two of them configured to
// collide — by reading unit-file config (`systemctl show` ExecStart/Environment,
// or plist content on macOS), never a live PID. No logic is shared or
// duplicated between the two; this module intentionally does not import
// restart-unit.mjs. See the PR body for the explicit dependency decision.
//
// WARN, never FAIL: scripts/upgrade.mjs's runUpgrade() pre-flight guard only
// tolerates ready_to_upgrade=false for next_action.kind="fresh_install" — a
// FAIL here would block every future `ocp update` on an affected host,
// including the update that might fix the drift. The two units' config could
// also legitimately differ for reasons this check cannot know (e.g. a
// deliberate blue/green setup on a non-standard port) — WARN surfaces the
// hazard without itself becoming a new outage vector.
//
// Enumeration strategy: matching on unit NAME is fragile (a host may name a
// unit anything — the field incident's units were "ocp.service" and
// "ocp-proxy.service", nothing guarantees that pattern elsewhere), so instead
// every ENABLED unit's config is read and fingerprinted by whether its
// ExecStart (Linux) / ProgramArguments (macOS) actually invokes server.mjs, and
// from where. Two units only count as conflicting when they share BOTH the
// resolved port AND the resolved working tree — matching the field incident's
// own shape ("both pointed at the same working tree and the same port") and
// deliberately excluding same-port-different-tree or same-tree-different-port,
// neither of which is this failure mode.
//
// Cost: capped at 4 real subprocess spawns total regardless of host size (two
// `list-unit-files` calls to enumerate enabled *.service names, then at most
// one BATCHED `systemctl show` call per scope covering every candidate at
// once — never one spawn per unit). A missing/erroring systemctl, or an
// unreadable listing, degrades the WHOLE check to "unknown" (no push) rather
// than a false all-clear or a crash — see classifyMultiUnitRisk's null-vs-""
// discipline below, which mirrors restart-unit.mjs's own "ss returned nothing
// we could parse" vs "ss never ran" distinction (ss/lsof there, systemctl here,
// same reasoning: an absent/foreign-uid PID column silently degrades, and the
// caller must not read that as "confirmed clean").
// ═══════════════════════════════════════════════════════════════════════════

const UNIT_NAME_RE = /^[A-Za-z0-9:_.@-]+\.service$/;
// ARG_MAX / cost safety cap: past this many enabled *.service units in one scope,
// a single batched `systemctl show <all names> ...` command line risks becoming
// unwieldy for no real benefit (a host with 200+ enabled units enabling two OCP
// installs specifically is not a realistic shape this check needs to chase) —
// degrade to "unknown" for that scope rather than issuing an oversized command.
const MAX_UNIT_CANDIDATES = 200;

function extractEnabledServiceNames(listUnitFilesOutput) {
  return String(listUnitFilesOutput)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.split(/\s+/)[0])
    .filter(name => UNIT_NAME_RE.test(name)); // also excludes header/footer noise
}

function parseSystemctlShowBlocks(showOutput) {
  if (!showOutput) return [];
  return String(showOutput)
    .split(/\n\s*\n/)
    .map(block => {
      const props = {};
      for (const line of block.split("\n")) {
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        props[line.slice(0, idx)] = line.slice(idx + 1);
      }
      return props;
    })
    .filter(p => p.Id);
}

// Fingerprint one `systemctl show` property block as an OCP server.mjs unit, or
// null if it plainly isn't one. ExecStart's structured form from `systemctl show`
// looks like "{ path=... ; argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; ... }" —
// pull argv[] out of that if present, else fall back to treating the whole
// property as the argv string (keeps this tolerant of older systemd's plainer
// ExecStart rendering rather than hard-requiring the structured form).
function fingerprintSystemdUnit(props, scope) {
  if (!UNIT_NAME_RE.test(props.Id || "")) return null; // never trust an unvalidated Id downstream
  const execStart = props.ExecStart || "";
  const argvMatch = execStart.match(/argv\[\]=([^;]+)/);
  const argv = (argvMatch ? argvMatch[1] : execStart).trim().split(/\s+/).filter(Boolean);
  const serverArg = argv.find(a => a === "server.mjs" || a.endsWith("/server.mjs"));
  if (!serverArg) return null; // not an OCP unit — doesn't invoke server.mjs at all
  const workingTree = serverArg === "server.mjs" ? "" : serverArg.slice(0, -"/server.mjs".length);

  const env = props.Environment || "";
  const portMatch = env.match(/CLAUDE_PROXY_PORT=(\S+)/);
  const port = portMatch ? portMatch[1].replace(/^"|"$/g, "") : String(DEFAULT_PORT);
  const bindMatch = env.match(/CLAUDE_BIND=(\S+)/);
  const bind = bindMatch ? bindMatch[1].replace(/^"|"$/g, "") : "(default bind)";

  return { name: props.Id, scope, port, workingTree, bind };
}

// macOS equivalent. setup.mjs only EVER writes one LaunchAgent
// (~/Library/LaunchAgents/dev.ocp.proxy.plist) and never a LaunchDaemon, so the
// structural precondition for this race (two independently-enabled auto-start
// definitions) is far less likely to arise from OCP's own tooling here than on
// Linux, where a hand-rolled system-scope unit is exactly what the field
// incident found. It is not impossible — an operator can hand-create a second
// LaunchAgent or a system LaunchDaemon pointing at the same server.mjs — so
// this still checks rather than silently skipping the platform.
//
// plistBlob is a single pre-concatenated blob (one shell command, see
// gatherUnitCandidates) with each file's content prefixed by a
// "===OCP-DOCTOR-FILE:<path>===" delimiter line, so the whole scan costs one
// subprocess spawn regardless of how many plists exist.
function parsePlistCandidates(plistBlob) {
  if (!plistBlob) return [];
  const parts = String(plistBlob).split(/^===OCP-DOCTOR-FILE:(.*)===$/m);
  const units = [];
  for (let i = 1; i < parts.length; i += 2) {
    const path = (parts[i] || "").trim();
    const content = parts[i + 1] || "";
    if (!/<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(content)) continue; // wouldn't auto-start
    const argsBlock = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!argsBlock) continue;
    const args = [...argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
    const serverArg = args.find(a => a === "server.mjs" || a.endsWith("/server.mjs"));
    if (!serverArg) continue; // not an OCP unit
    const workingTree = serverArg === "server.mjs" ? "" : serverArg.slice(0, -"/server.mjs".length);
    const labelMatch = content.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/);
    const portMatch = content.match(/<key>CLAUDE_PROXY_PORT<\/key>\s*<string>([^<]*)<\/string>/);
    const bindMatch = content.match(/<key>CLAUDE_BIND<\/key>\s*<string>([^<]*)<\/string>/);
    const scope = path.includes("/LaunchDaemons/") ? "system" : "user";
    units.push({
      name: labelMatch ? labelMatch[1] : path,
      scope,
      port: portMatch ? portMatch[1] : String(DEFAULT_PORT),
      workingTree,
      bind: bindMatch ? bindMatch[1] : "(default bind)",
    });
  }
  return units;
}

// Two-or-more units sharing BOTH port and working tree are the actual hazard
// shape (see the module comment above); anything else — a lone OCP unit, or
// two units that merely happen to share a port with a DIFFERENT tree, or the
// same tree on a DIFFERENT port — is not this failure mode and must not warn.
function groupAndAssessConflicts(units) {
  if (units.length < 2) return { state: "clear" };
  const groups = new Map();
  for (const u of units) {
    const key = `${u.port}::${u.workingTree}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }
  const conflicting = [...groups.values()].filter(g => g.length >= 2);
  if (conflicting.length === 0) return { state: "clear" };
  return { state: "warn", groups: conflicting };
}

// Pure classifier: parses already-gathered raw command/file output into a
// verdict. Never shells out itself — mirrors restart-unit.mjs's
// gather-vs-classify split so the decision logic is directly unit-testable
// without a live systemd/launchd instance.
//
// raw.userShowOut / raw.systemShowOut (Linux) and raw.plistBlob (macOS) follow
// a strict three-value discipline, same as restart-unit.mjs's ss/lsof/cgroup
// probes: `null` means "could not gather this" (tool missing, command failed,
// or too many candidates to probe cheaply — MAX_UNIT_CANDIDATES), `""` or a
// real listing means "gathered successfully, here's what's there" (including
// legitimately empty). `null` must never be read as "confirmed nothing found".
export function classifyMultiUnitRisk(raw = {}) {
  if (raw.platform === "darwin") {
    if (raw.plistBlob == null) {
      return { state: "unknown", reason: "could not enumerate LaunchAgents/LaunchDaemons" };
    }
    return groupAndAssessConflicts(parsePlistCandidates(raw.plistBlob));
  }

  if (raw.userShowOut == null || raw.systemShowOut == null) {
    return {
      state: "unknown",
      reason: "systemctl unavailable, errored, or returned too many candidates for one or more scopes — cannot rule out a boot race",
    };
  }
  const units = [
    ...parseSystemctlShowBlocks(raw.userShowOut).map(p => fingerprintSystemdUnit(p, "user")),
    ...parseSystemctlShowBlocks(raw.systemShowOut).map(p => fingerprintSystemdUnit(p, "system")),
  ].filter(Boolean);
  return groupAndAssessConflicts(units);
}

// Impure gathering layer: decides which commands run and folds every failure
// mode (missing binary, non-zero exit, empty-but-valid output) into the
// null/""/text discipline classifyMultiUnitRisk expects. `run` defaults to
// real execSync in production; tests inject a fake runner that pattern-matches
// on the command string — the exact shape PR #221's resolveRestartPlan uses,
// adopted here specifically because that PR's review (MED-6) found the
// UNTESTED impure layer was where the real defects hid, not the pure
// classifier.
export function gatherUnitCandidates(run, platform) {
  if (platform === "darwin") {
    let plistBlob;
    try {
      plistBlob = run(
        `for f in "$HOME/Library/LaunchAgents"/*.plist /Library/LaunchDaemons/*.plist; do ` +
        `[ -f "$f" ] && { echo "===OCP-DOCTOR-FILE:$f==="; cat "$f"; }; done 2>/dev/null`
      );
    } catch { plistBlob = null; }
    return { platform, plistBlob };
  }

  let userListing, systemListing;
  try {
    userListing = run(`systemctl --user list-unit-files --type=service --state=enabled --no-legend --no-pager`);
  } catch { userListing = null; }
  try {
    systemListing = run(`systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager`);
  } catch { systemListing = null; }

  const userNames = userListing != null ? extractEnabledServiceNames(userListing) : [];
  const systemNames = systemListing != null ? extractEnabledServiceNames(systemListing) : [];

  let userShowOut = userListing == null ? null : "";
  let systemShowOut = systemListing == null ? null : "";

  if (userListing != null && userNames.length > 0) {
    if (userNames.length > MAX_UNIT_CANDIDATES) {
      userShowOut = null;
    } else {
      try {
        userShowOut = run(`systemctl --user show ${userNames.join(" ")} -p Id -p ExecStart -p Environment --no-pager`);
      } catch { userShowOut = null; }
    }
  }
  if (systemListing != null && systemNames.length > 0) {
    if (systemNames.length > MAX_UNIT_CANDIDATES) {
      systemShowOut = null;
    } else {
      try {
        systemShowOut = run(`systemctl show ${systemNames.join(" ")} -p Id -p ExecStart -p Environment --no-pager`);
      } catch { systemShowOut = null; }
    }
  }

  return { platform, userListing, systemListing, userShowOut, systemShowOut };
}

export function detectMultiUnitBootRace(opts = {}) {
  const platform = opts.mockPlatform || process.platform;
  const run = opts.run || ((cmd) => execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).toString());
  const raw = gatherUnitCandidates(run, platform);
  return classifyMultiUnitRisk(raw);
}

// Actionable WARN text: names every conflicting unit, the difference that
// matters (bind address — the field incident's actual LAN-reachability hazard),
// and the operator fix used to resolve the real host (disable the stray unit;
// the file is preserved, the fix is reversible).
function describeMultiUnitConflict(groups) {
  return groups.map(group => {
    const port = group[0].port;
    const names = group.map(u => `${u.scope}-scope "${u.name}" (bind ${u.bind})`).join(" and ");
    const userUnit = group.find(u => u.scope === "user");
    const disableHint = userUnit
      ? `disable the stray one — e.g. "systemctl --user disable ${userUnit.name}" (reversible: the unit file is preserved, only the boot-enable link is removed)`
      : `disable whichever is not your intended target — e.g. "systemctl disable <unit>" (reversible: the unit file is preserved)`;
    return `${group.length} enabled units target OCP port ${port}: ${names} — boot race: whichever starts first wins the port and the other silently orphans (issue #215). Pick one and ${disableHint}.`;
  }).join(" | ");
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
    // Issue #173: `git show origin/main:...` reads the LOCALLY CACHED remote ref. Without a
    // fetch first, a machine that hasn't pulled since the last release sees latest == current
    // and reports noop — new releases were invisible everywhere except the machine that cut
    // the tag (live repro: Oracle VM, 2026-07-17). Fetch before comparing; on failure
    // (offline, auth, timeout) fall through to the cached ref — the pre-existing behavior.
    if (!opts.skipNetwork) {
      try {
        execSync(`git -C ${ocpDir} fetch --tags --quiet`, { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
      } catch { /* offline → compare against cached origin/main, as before */ }
    }
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
  // Issue #214: the RUNNING SERVICE's version, as reported by /health, kept distinct from
  // currentVersion (the tree's package.json, above). A partially-failed `ocp update` can
  // `git checkout` the new tag and then fail before the restart phase runs, leaving the tree
  // looking fully updated while the service still answers with the old code. null means
  // "unknown" (skipNetwork, /health unreachable, or a body with no usable version field) —
  // the decision below must degrade gracefully on unknown, same philosophy as upgrade.mjs's
  // postFlightOk ("an empty/unknown target degrades ... rather than blocking an otherwise-good
  // upgrade"). Stored as the bare string /health returns (no "v" prefix): semverParts()/
  // semverCompare() strip a leading "v" themselves, so prefixing here would be purely
  // cosmetic — an earlier version of this fix added one and it was dead weight (PR #217
  // review: survived mutation because nothing downstream reads the prefix).
  let serviceVersion = null;
  if (!opts.skipNetwork) {
    let health;
    if (opts.mockHealth !== undefined) {
      health = opts.mockHealth;
    } else {
      try {
        const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
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
      // /health reports a bare semver (server.mjs `version: VERSION`, no leading "v"); only
      // trust it when it actually parses as a version, so a missing/garbled field degrades to
      // "unknown" (serviceVersion stays null) instead of being mistaken for a real mismatch.
      if (typeof health.body.version === "string" && semverParts(health.body.version)) {
        serviceVersion = health.body.version;
      }
    }
  }

  // --- multi-unit boot-race pre-flight (issue #220 / incident #215) ---
  // Gated by skipNetwork like the health/oauth block above — this reads the live
  // systemd/launchd environment (not "network" in the curl/git sense, but the same
  // "don't touch anything live" contract skipNetwork already exists to express in
  // tests). Only pushed when there's a confirmed conflict to report — "clear" and
  // "unknown" both push nothing, mirroring service_version_matches_tree's own
  // "no check id at all when there's nothing warn-worthy" convention elsewhere in
  // this file. See the module comment above classifyMultiUnitRisk for the full
  // design rationale (why WARN not FAIL, why port+workingTree must both match,
  // why this doesn't depend on scripts/lib/restart-unit.mjs).
  if (!opts.skipNetwork) {
    const multiUnit = detectMultiUnitBootRace(opts);
    if (multiUnit.state === "warn") {
      push("multi_unit_boot_race", "WARN", describeMultiUnitConflict(multiUnit.groups));
    }
  }

  // --- determine next_action.kind (priority: fresh_install > fix_service > fix_oauth > noop/restart > update > upgrade) ---
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
      // Issue #214: "tree == latest" alone is NOT "nothing to do" — the goal is the running
      // service serving the tree's version. When serviceVersion is known (see health-check
      // block above) and OLDER than the tree, a previous update half-completed (tree checked
      // out, restart phase never ran): the service needs a restart, with NO git operations
      // (the tree is already correct).
      //
      // kind="restart" is a DISTINCT value from "update" — PR #217's first draft reused
      // "update" and was rejected in review for two reasons, both load-bearing:
      //   1. "update"'s bash handler (_cmd_update_light) runs `git pull origin main --ff-only`.
      //      That is NOT a no-op in general: doctor's latestVersion comes from the VERSION
      //      NUMBER in origin/main's package.json, not from origin/main's commit. Between
      //      releases, main accumulates merged-but-unreleased commits while package.json stays
      //      put, so "tree == latest" (by version string) can hold while origin/main HEAD is
      //      genuinely ahead of the release tag. Routing that state through "update" would
      //      silently fast-forward a production host off its release tag onto unreleased main,
      //      then restart into it — worse than the bug this issue reports.
      //   2. _cmd_update_light drops every CLI flag ("$@" is never forwarded to it), so
      //      `ocp update --dry-run` on a stale host would have skipped straight to a real
      //      mutating restart despite the documented "preview the plan, don't mutate" contract.
      // "restart" has its own bash handler (_cmd_update_restart) that never touches git and
      // honors --dry-run.
      //
      // When serviceVersion is NEWER than the tree (e.g. the tree was rolled back, or someone
      // is running a newer/test build), do NOT restart: that would silently DOWNGRADE a
      // running service to match an older tree, which is exactly the class of surprise
      // auto-mutation this issue is about. Surface it (WARN) but leave kind="noop" — the same
      // "nothing forced" default as before this fix.
      //
      // Either way, push a WARN (not FAIL) so ready_to_upgrade stays true when kind="restart" —
      // runUpgrade()'s pre-flight guard only tolerates ready_to_upgrade=false for
      // kind="fresh_install".
      if (serviceVersion) {
        const serviceCmp = semverCompare(serviceVersion, currentVersion);
        if (serviceCmp < 0) {
          kind = "restart";
          push("service_version_matches_tree", "WARN",
            `tree at ${currentVersion.replace(/^v/, "")}, service serving ${serviceVersion.replace(/^v/, "")} — restarting`);
        } else if (serviceCmp > 0) {
          kind = "noop";
          push("service_version_matches_tree", "WARN",
            `tree at ${currentVersion.replace(/^v/, "")}, service serving ${serviceVersion.replace(/^v/, "")} (NEWER than tree) — not auto-restarting`);
        } else {
          kind = "noop";
        }
      } else {
        kind = "noop";
      }
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
      const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
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
