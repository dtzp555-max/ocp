// scripts/lib/install-autostart.mjs — setup.mjs's "Step 7" (auto-start install), extracted
// into an injectable, importable function.
//
// Review history (issue #226, PR #229): the first cut at testing this step used source-shape
// regex assertions reading setup.mjs's actual text, on the premise that setup.mjs's top-level
// side effects make it unimportable/unexecutable. That premise is real, but the conclusion
// ("so assert on source text instead") was wrong, and AGENTS.md's "Testing discipline: what
// counts as a test" section (not its server.mjs-specific section — this one is general,
// covering ocp-connect and bash `cmd_restart` alike) says why: "a test asserting on the source
// text of the thing it tests is not a test — it passes when the code is deleted and re-added
// wrong, and breaks on reformatting." That failure mode wasn't hypothetical here: a review
// mutation emptied a gate (`if (!servicePlan.reconfigureOnly) { }`) while leaving the migration
// code in an adjacent, now-unguarded block — the region-slice regex still found every string it
// was looking for (co-location, not containment) and passed at 506/0. The actual fix, per that
// review, is this file: move the imperative body into something an injected `run`/fs layer can
// observe, the same seam `scripts/upgrade.mjs` already uses (`opts.mockExec`) and `doctor.mjs`
// uses (`opts.mockHealth`) — NOT `scripts/lib/restart-unit.mjs`, which does not exist on `main`
// (it ships only in #221, a separate, still-unmerged PR; an earlier draft of this module
// wrongly cited it as precedent).
//
// installAutoStart() performs every action setup.mjs's Step 7 used to perform inline: legacy-
// unit migration (gated on !servicePlan.reconfigureOnly — issue #226 review finding H1),
// writing the plist/systemd unit (with existing-file env-merge), and the platform-specific
// enable/start/bootstrap actions (gated per servicePlan, from scripts/lib/service-mode.mjs).
// Every side-effecting primitive is an injected parameter with the real Node function as its
// default, so setup.mjs's actual invocation is unchanged in behavior, while tests can pass
// recording fakes and assert on exactly which commands/files were touched — not on whether a
// string appears near another string in the source.
import { mergePlistEnv, mergeSystemdEnv } from "./plist-merge.mjs";
import { execSync as realExecSync } from "node:child_process";
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  writeFileSync as realWriteFileSync,
  readFileSync as realReadFileSync,
  chmodSync as realChmodSync,
  unlinkSync as realUnlinkSync,
} from "node:fs";
import { join } from "node:path";

// Escape a value for safe inclusion in a plist <string>…</string> body. Moved here from
// setup.mjs (was only ever used by the plist-building code this module now owns).
export function xmlEscape(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * @param {object} opts
 * @param {"darwin"|"linux"|string} opts.platform
 * @param {object} opts.servicePlan - from scripts/lib/service-mode.mjs's resolveServicePlan()
 * @param {{HOME:string, OPENCLAW_DIR:string, serverPath:string, startPath:string}} opts.paths
 * @param {{PORT:number, BIND_ADDRESS:string, AUTH_MODE_CONFIG:string, CLAUDE_BIN_INJECT:?string, OCP_ADMIN_KEY_INJECT:?string, PROXY_ANON_KEY_INJECT:?string}} opts.config
 * @param {(cmd:string)=>string} [opts.run] - execSync replacement (shell-out seam)
 * @param {Function} [opts.writeFile] - writeFileSync replacement
 * @param {Function} [opts.readFile] - readFileSync replacement (existing-unit-file read, for env-merge)
 * @param {Function} [opts.existsPath] - existsSync replacement
 * @param {Function} [opts.makeDir] - mkdirSync replacement
 * @param {Function} [opts.chmodPath] - chmodSync replacement
 * @param {Function} [opts.unlinkPath] - unlinkSync replacement
 * @param {(msg:string)=>void} [opts.log]
 * @param {(msg:string)=>void} [opts.warn]
 * @param {(msg:string)=>void} [opts.print] - banner-level console.log replacement
 */
export function installAutoStart(opts) {
  const {
    platform,
    servicePlan,
    paths,
    config,
    run = realExecSync,
    writeFile = realWriteFileSync,
    readFile = realReadFileSync,
    existsPath = realExistsSync,
    makeDir = realMkdirSync,
    chmodPath = realChmodSync,
    unlinkPath = realUnlinkSync,
    log = (msg) => console.log(`  ✓ ${msg}`),
    warn = (msg) => console.log(`  ⚠ ${msg}`),
    print = (msg) => console.log(msg),
  } = opts;

  const { HOME, OPENCLAW_DIR, serverPath, startPath } = paths;
  const { PORT, BIND_ADDRESS, AUTH_MODE_CONFIG, CLAUDE_BIN_INJECT, OCP_ADMIN_KEY_INJECT, PROXY_ANON_KEY_INJECT } = config;

  print("\n🔄 Installing auto-start on login...\n");

  const platformSupported = platform === "darwin" || platform === "linux";

  // Use stable symlink path instead of versioned Cellar path (e.g. /opt/homebrew/opt/node/bin/node
  // instead of /opt/homebrew/Cellar/node/25.8.0/bin/node) so the plist survives node upgrades.
  let nodeBin = process.execPath;
  if (platform === "darwin" && nodeBin.includes("/Cellar/")) {
    const stable = nodeBin.replace(/\/Cellar\/[^/]+\/[^/]+\//, "/opt/");
    if (existsPath(stable)) {
      nodeBin = stable;
      log(`Using stable node path: ${nodeBin}`);
    }
  }

  // Ensure logs dir exists
  const logsDir = join(OPENCLAW_DIR, "logs");
  if (!existsPath(logsDir)) makeDir(logsDir, { recursive: true });

  // Use neutral service names to avoid OpenClaw gateway's extra-service detection.
  // OpenClaw scans LaunchAgent plists and systemd units for "openclaw" / "clawdbot"
  // markers and flags them as conflicting gateway-like services. Using "dev.ocp.*"
  // and "ocp-proxy" keeps the proxy invisible to that heuristic.
  const OCP_HOME = join(HOME, ".ocp");
  const ocpLogsDir = join(OCP_HOME, "logs");
  // mode 0700: with `recursive`, this call can create ~/.ocp ITSELF on a fresh install, and
  // without an explicit mode that parent lands at the umask default (world-listable 0755).
  if (!existsPath(ocpLogsDir)) makeDir(ocpLogsDir, { recursive: true, mode: 0o700 });

  // Uninstall legacy service names if present (upgrade path). Gated on !reconfigureOnly
  // (issue #226 review, finding H1): stopping, disabling, and deleting a service is exactly
  // the phase-5-shaped action this PR exists to keep out of phase 4 — regardless of WHICH
  // unit it targets, "only write config" cannot also mean "and stop/disable/delete a
  // different one". Left ungated, a host that auto-started via the legacy unit would end this
  // run with NO enabled unit at all (legacy disabled+deleted here, new unit's `enable` skipped
  // by reconfigure-only) — invisible until the next reboot. Reconfigure-only therefore leaves
  // any pre-v3.4.0 legacy unit untouched; migrating away from it remains a bare
  // `node setup.mjs` (first install / fresh_install) job, same as it always was. In practice
  // this is very close to unreachable via scripts/upgrade.mjs's phase 4 specifically — doctor
  // gates that cross-minor "upgrade" path (the only caller of --reconfigure-only) at
  // >= v3.4.0, already past the v3.1.0 rename that produced these legacy names — but the
  // gate lives here regardless, since the contract ("reconfigure-only touches only this
  // unit's own config") should hold even where it's never exercised.
  // Consequence, stated plainly (review round 2): on a host that DOES still have a legacy unit
  // and DOES take the reconfigure-only path, this gate converts what used to be a successful
  // migration into a failed upgrade — phase 5 starts the new unit against a port the legacy
  // one may still hold, post-flight fails, and the operator rolls back. Rollback restores the
  // git tree and admin-key/db files, not `~/.config/systemd/user/` or
  // `~/Library/LaunchAgents/`, so the newly-written (but not migrated-away-from) unit is left
  // as-is; since it carries `Restart=always`/`RestartSec=5`, it will keep respawning and
  // failing after the aborted upgrade until an operator intervenes. Judged acceptable given
  // the same near-zero reachability as above, and because loud-and-rolled-back beats silent-
  // and-invisible-until-reboot (round 1's failure mode).
  if (!servicePlan.reconfigureOnly) {
    if (platform === "darwin") {
      const legacyPlist = join(HOME, "Library", "LaunchAgents", "ai.openclaw.proxy.plist");
      if (existsPath(legacyPlist)) {
        try { run(`launchctl bootout gui/$(id -u) "${legacyPlist}" 2>/dev/null`); } catch { /* ignore */ }
        try { unlinkPath(legacyPlist); } catch { /* ignore */ }
        log(`Removed legacy plist: ai.openclaw.proxy`);
      }
    } else if (platform === "linux") {
      const legacyService = join(HOME, ".config", "systemd", "user", "openclaw-proxy.service");
      if (existsPath(legacyService)) {
        try { run(`systemctl --user stop openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
        try { run(`systemctl --user disable openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
        try { unlinkPath(legacyService); } catch { /* ignore */ }
        try { run(`systemctl --user daemon-reload`); } catch { /* ignore */ }
        log(`Removed legacy systemd service: openclaw-proxy`);
      }
    }
  }

  if (platform === "darwin") {
    // macOS: launchd
    const plistDir = join(HOME, "Library", "LaunchAgents");
    if (!existsPath(plistDir)) makeDir(plistDir, { recursive: true });

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
    <string>${xmlEscape(PORT)}</string>
    <key>CLAUDE_BIND</key>
    <string>${xmlEscape(BIND_ADDRESS)}</string>
    <key>CLAUDE_AUTH_MODE</key>
    <string>${xmlEscape(AUTH_MODE_CONFIG)}</string>${CLAUDE_BIN_INJECT ? `
    <key>CLAUDE_BIN</key>
    <string>${xmlEscape(CLAUDE_BIN_INJECT)}</string>` : ""}${OCP_ADMIN_KEY_INJECT ? `
    <key>OCP_ADMIN_KEY</key>
    <string>${xmlEscape(OCP_ADMIN_KEY_INJECT)}</string>` : ""}${PROXY_ANON_KEY_INJECT ? `
    <key>PROXY_ANONYMOUS_KEY</key>
    <string>${xmlEscape(PROXY_ANON_KEY_INJECT)}</string>` : ""}
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

    const existingPlist = existsPath(plistPath) ? readFile(plistPath, "utf8") : null;
    const finalPlistXml = mergePlistEnv(existingPlist, plistXml);
    writeFile(plistPath, finalPlistXml);
    chmodPath(plistPath, 0o600);
    if (existingPlist && finalPlistXml !== plistXml) {
      log(`Plist written: ${plistPath} (mode 600, preserved user env vars)`);
    } else {
      log(`Plist written: ${plistPath} (mode 600)`);
    }

    if (servicePlan.bootstrap) {
      // Bootout first (in case it was already loaded) then bootstrap
      try { run(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null`); } catch { /* ignore */ }
      run(`launchctl bootstrap gui/$(id -u) "${plistPath}"`);
      log(`launchctl loaded dev.ocp.proxy`);
    } else {
      // Does NOT touch launchd's persistent enable/disable state either way (see
      // scripts/lib/service-mode.mjs) — only skips loading/starting the job THIS session.
      log(`Plist written (reconfigure-only: launchctl bootstrap left to the upgrade flow's restart phase)`);
    }

  } else if (platform === "linux") {
    // Linux: systemd user service
    const systemdDir = join(HOME, ".config", "systemd", "user");
    if (!existsPath(systemdDir)) makeDir(systemdDir, { recursive: true });

    const servicePath = join(systemdDir, "ocp-proxy.service");
    const logPath = join(ocpLogsDir, "proxy.log");

    const serviceUnit = `[Unit]
Description=OCP — Open Claude Proxy
After=network.target

[Service]
ExecStart=${nodeBin} ${serverPath}
Environment=CLAUDE_PROXY_PORT=${PORT}
Environment=CLAUDE_BIND=${BIND_ADDRESS}
Environment=CLAUDE_AUTH_MODE=${AUTH_MODE_CONFIG}${CLAUDE_BIN_INJECT ? `\nEnvironment=CLAUDE_BIN=${CLAUDE_BIN_INJECT}` : ""}${OCP_ADMIN_KEY_INJECT ? `\nEnvironment=OCP_ADMIN_KEY=${OCP_ADMIN_KEY_INJECT}` : ""}${PROXY_ANON_KEY_INJECT ? `\nEnvironment=PROXY_ANONYMOUS_KEY=${PROXY_ANON_KEY_INJECT}` : ""}
Restart=always
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;

    const existingService = existsPath(servicePath) ? readFile(servicePath, "utf8") : null;
    const finalServiceUnit = mergeSystemdEnv(existingService, serviceUnit);
    writeFile(servicePath, finalServiceUnit);
    chmodPath(servicePath, 0o600);
    if (existingService && finalServiceUnit !== serviceUnit) {
      log(`Service file written: ${servicePath} (mode 600, preserved user env vars)`);
    } else {
      log(`Service file written: ${servicePath} (mode 600)`);
    }

    if (servicePlan.daemonReload) run(`systemctl --user daemon-reload`);
    if (servicePlan.enable) run(`systemctl --user enable ocp-proxy`);
    if (servicePlan.start) run(`systemctl --user start ocp-proxy`);
    if (servicePlan.enable && servicePlan.start) {
      log(`systemd user service enabled and started`);
    } else {
      // Note: only `start` is "left to" the restart phase (it issues `systemctl restart`,
      // which starts a not-yet-running unit fine). `enable` is not deferred to anything — it
      // is simply left untouched here, preserving whatever it already was.
      log(`Service file written + daemon-reload'd (reconfigure-only: enable left as-is; start left to the upgrade flow's restart phase)`);
    }

  } else {
    warn(`Auto-start not supported on ${platform} — start manually with: bash ${startPath}`);
  }

  // Banner: only claim "will start automatically" when this run actually attempted to
  // load/start it (bare install/first-run — not --reconfigure-only, which never runs
  // `enable`/`start`/`bootstrap` on either platform). This applies uniformly to both
  // platforms: a first-install bootstrap/enable+start failing against a disabled unit would
  // already have thrown and killed the script before reaching this banner, so reaching it on
  // the non-reconfigure-only path is real evidence, not an assumption — whereas
  // reconfigure-only never attempts either action, so it never gets to claim that evidence
  // (previously this banner over-claimed unconditionally on darwin; see #226 review M1).
  if (!platformSupported) {
    // warn() above already explained it; nothing further to add.
  } else if (servicePlan.reconfigureOnly) {
    // Leaves auto-start-on-boot/login state untouched either way (issue #226) — whatever this
    // unit's enablement already was (first install, or an operator's manual override) is
    // preserved, not re-asserted. The upgrade flow's restart phase runs next and starts the
    // service; it does not call `enable` (Linux). launchd's persistent disabled state
    // (`launchctl enable`/`disable`, distinct from the plist file itself — man 5
    // launchd.plist) is, as far as this module's own actions go, also simply never touched
    // either way; whether `bootstrap`/`bootout` themselves have any side effect on that state
    // is not something `man 1 launchctl` documents either way, so this is stated as "this
    // module doesn't touch it", not as a claim about bootstrap/bootout's own behavior.
    print("\n✅ Service config written (--reconfigure-only) — auto-start-on-boot state left as-is; the upgrade flow's restart phase starts the service next\n");
  } else {
    print("\n✅ Auto-start installed — proxy will start automatically on login\n");
  }
}
