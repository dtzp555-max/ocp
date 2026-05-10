#!/usr/bin/env node
/**
 * scripts/upgrade.mjs — OCP unified upgrade dispatcher.
 *
 * Paths:
 *   noop          current == latest, exit 0
 *   light         same major.minor, patch bump only (existing fast path; delegated to bash)
 *   full          cross-minor (snapshot + setup.mjs + post-flight)
 *   fresh_install from-version < v3.4.0 (--yes required for non-interactive)
 *   rollback      restore from snapshot
 */
import { runDoctor } from "./doctor.mjs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, copyFileSync } from "node:fs";
import { writeSnapshot, listSnapshots, readSnapshot } from "./lib/snapshot.mjs";

export async function runUpgrade(opts = {}) {
  const dryRun = !!opts.dryRun;
  const yes = !!opts.yes;
  // yes is reserved for Bundle 3 (fresh-install / rollback interactive gate); not used in upgrade-path here.
  const plan = [];

  // --- rollback path (no doctor needed; snapshot is authoritative) ---
  if (opts.rollback) {
    return await runRollback(opts);
  }

  // --- doctor pre-flight ---
  const doctor = opts.mockDoctor || await runDoctor();
  if (!doctor.ready_to_upgrade && doctor.next_action.kind !== "fresh_install") {
    throw new Error(`doctor FAIL: ${doctor.next_action.kind} (run "ocp doctor" for details)`);
  }

  const kind = doctor.next_action.kind;
  plan.push(`[doctor] from=${doctor.current_version} to=${doctor.latest_version} kind=${kind}`);

  // --- noop ---
  if (kind === "noop") {
    plan.push(`[noop] already at latest (${doctor.latest_version})`);
    return { path: "noop", executed: true, changed: false, plan };
  }

  // --- dry-run early exit ---
  if (dryRun) {
    plan.push(`[plan] would proceed with ${kind} path`);
    if (kind === "upgrade") {
      plan.push(`[plan] phase 1: snapshot to ~/.ocp/upgrade-snapshot-<ts>/`);
      plan.push(`[plan] phase 2: git checkout ${doctor.latest_version} && npm install`);
      plan.push(`[plan] phase 3: node setup.mjs`);
      plan.push(`[plan] phase 4: launchctl bootout/bootstrap`);
      plan.push(`[plan] phase 5: post-flight /health + /v1/models`);
    } else if (kind === "update") {
      plan.push(`[plan] light path: git pull + npm install + restart`);
    } else if (kind === "fresh_install") {
      plan.push(`[plan] fresh-install ai_executable[]:`);
      for (const cmd of doctor.next_action.ai_executable) plan.push(`  - ${cmd}`);
    }
    return { path: kind, executed: false, plan };
  }

  // --- non-dry-run paths ---
  if (kind === "update") {
    return { path: "update", executed: true, changed: true, plan: [...plan, "[light] delegated to bash cmd_update existing logic"] };
  }

  if (kind === "upgrade") {
    return await runFullUpgrade({ doctor, opts });
  }

  if (kind === "fresh_install") {
    return await runFreshInstall({ doctor, opts });
  }

  throw new Error(`path ${kind} not yet implemented`);
}

async function runFullUpgrade({ doctor, opts }) {
  const phases = [];
  let snapshotPath = null;
  const exec = (cmd, label) => {
    if (opts.mockExec) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    try {
      const out = execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString();
      phases.push({ name: label, cmd, status: "ok" });
      return out;
    } catch (err) {
      const detail = err.stderr?.toString().trim();
      phases.push({ name: label, cmd, status: "fail", stderr: detail });
      throw Object.assign(
        new Error(`phase ${label} failed: ${detail || err.message}`),
        { phases, cmd }
      );
    }
  };
  const ocpDir = opts.ocpDir || join(homedir(), "ocp");

  try {
    // phase 1: pre-flight (doctor already passed; just record)
    phases.push({ name: "pre-flight", status: "ok", note: `kind=upgrade from=${doctor.current_version} to=${doctor.latest_version}` });

    // phase 2: snapshot
    const fromCommit = opts.mockExec
      ? "mock-commit"
      : execSync(`git -C ${ocpDir} rev-parse HEAD`).toString().trim();
    snapshotPath = opts.mockExec
      ? "/tmp/mock-snapshot"
      : writeSnapshot({ homeDir: homedir(), fromCommit, fromVersion: doctor.current_version, toVersion: doctor.latest_version });
    phases.push({ name: "snapshot", path: snapshotPath, status: "ok" });

    // phase 3: fetch + install
    exec(`git -C ${ocpDir} fetch --tags --quiet`, "fetch+install");
    exec(`git -C ${ocpDir} checkout ${doctor.latest_version}`, "fetch+install");
    exec(`npm --prefix ${ocpDir} install --no-audit --no-fund`, "fetch+install");

    // phase 4: reconfigure
    exec(`node ${ocpDir}/setup.mjs`, "reconfigure");

    // phase 5: restart (heads-up note printed before invoking)
    if (!opts.mockExec) {
      console.error(`[heads-up] restarting OCP service in 3s — expect ~5–10s blip on requests in flight.`);
      await new Promise(r => setTimeout(r, 3000));
    }
    if (process.platform === "darwin") {
      exec(`launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`, "restart");
      exec(`launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`, "restart");
    } else {
      exec(`systemctl --user restart ocp-proxy.service`, "restart");
    }

    // phase 6: post-flight (10s budget; skipped under mockExec)
    if (!opts.mockExec) {
      const port = process.env.CLAUDE_PROXY_PORT || "3478";
      let ok = false;
      for (let i = 0; i < 10; i++) {
        try {
          const out = execSync(`curl -sf --max-time 2 http://127.0.0.1:${port}/health`).toString();
          const body = JSON.parse(out);
          if (body.auth?.ok === true) { ok = true; break; }
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!ok) {
        phases.push({ name: "post-flight", status: "fail", message: "health did not return auth.ok=true within 10s" });
        throw new Error("post-flight failed");
      }
      execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/v1/models > /dev/null`);
      phases.push({ name: "post-flight", status: "ok" });
    } else {
      phases.push({ name: "post-flight", status: "skipped-mock" });
    }

    return { path: "upgrade", executed: true, changed: true, snapshotPath, phases };
  } catch (err) {
    if (snapshotPath && !err.snapshotPath) {
      Object.assign(err, {
        snapshotPath,
        phases,
        hint: "Working tree may be at new version. Run `ocp update --rollback` to restore from snapshot."
      });
    }
    throw err;
  }
}

async function runFreshInstall({ doctor, opts }) {
  if (!opts.yes) {
    throw new Error("fresh_install requires --yes for non-interactive execution (or run interactively and answer y)");
  }
  const steps = [];
  for (const cmd of doctor.next_action.ai_executable) {
    if (opts.mockExec) {
      steps.push({ cmd, status: "skipped-mock" });
    } else {
      try {
        execSync(cmd, { stdio: "inherit" });
        steps.push({ cmd, status: "ok" });
      } catch (e) {
        const detail = e.stderr?.toString().trim() || e.message;
        steps.push({ cmd, status: "fail", error: String(detail) });
        throw Object.assign(new Error(`fresh_install step failed: ${cmd} — ${detail}`), { steps });
      }
    }
  }
  return { path: "fresh_install", executed: true, changed: true, steps };
}

async function runRollback(opts) {
  const homeDir = opts.homeDir || homedir();
  const snapshots = opts.mockSnapshots ?? listSnapshots(homeDir);

  if (opts.list) {
    return { path: "rollback-list", snapshots };
  }
  if (snapshots.length === 0) {
    throw new Error("no upgrade snapshots found in ~/.ocp/upgrade-snapshot-*");
  }

  const target = opts.snapshotPath
    ? snapshots.find(s => s.path === opts.snapshotPath)
    : snapshots[snapshots.length - 1];
  if (!target) throw new Error(`snapshot not found: ${opts.snapshotPath} (must be inside ~/.ocp/upgrade-snapshot-*)`);

  const meta = opts.mockSnapshotMeta ?? readSnapshot(target.path);
  if (!meta.fromCommit) throw new Error(`snapshot ${target.path} has no from-commit.txt`);

  const phases = [];
  if (opts.dryRun) {
    return {
      path: "rollback-dry-run",
      executed: false,
      target: target.path,
      plan: [
        `git checkout ${meta.fromCommit}`,
        `cp ${target.path}/plist ~/Library/LaunchAgents/dev.ocp.proxy.plist`,
        `cp ${target.path}/db.bak ~/.ocp/ocp.db`,
        `launchctl bootout/bootstrap`,
        `ocp doctor`
      ]
    };
  }

  if (!opts.yes) throw new Error("rollback requires --yes for non-interactive execution");

  const exec = (cmd, label) => {
    if (opts.mockExec) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    try {
      execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] });
      phases.push({ name: label, cmd, status: "ok" });
    } catch (err) {
      const detail = err.stderr?.toString().trim();
      phases.push({ name: label, cmd, status: "fail", stderr: detail });
      throw Object.assign(
        new Error(`rollback phase ${label} failed: ${detail || err.message}`),
        { phases, target: target.path }
      );
    }
  };

  const ocpDir = opts.ocpDir || join(homedir(), "ocp");
  exec(`git -C ${ocpDir} checkout ${meta.fromCommit}`, "git-checkout");

  if (!opts.mockExec) {
    const tryCopy = (src, dst) => {
      try {
        if (existsSync(src)) copyFileSync(src, dst);
      } catch (err) {
        console.error(`[rollback] warn: could not restore ${src} → ${dst} (${err.code || err.message})`);
      }
    };
    tryCopy(join(target.path, "plist"), join(homeDir, "Library", "LaunchAgents", "dev.ocp.proxy.plist"));
    tryCopy(join(target.path, "service"), join(homeDir, ".config", "systemd", "user", "ocp-proxy.service"));
    tryCopy(join(target.path, "db.bak"), join(homeDir, ".ocp", "ocp.db"));
    tryCopy(join(target.path, "admin-key"), join(homeDir, ".ocp", "admin-key"));
    phases.push({ name: "restore-files", status: "ok" });
  } else {
    phases.push({ name: "restore-files", status: "skipped-mock" });
  }

  exec(`npm --prefix ${ocpDir} install --no-audit --no-fund`, "npm-install");

  if (!opts.mockExec) {
    console.error(`[heads-up] restarting OCP service in 3s — expect ~5–10s blip on requests in flight.`);
    await new Promise(r => setTimeout(r, 3000));
  }
  if (process.platform === "darwin") {
    exec(`launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`, "restart");
    exec(`launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`, "restart");
  } else {
    exec(`systemctl --user restart ocp-proxy.service`, "restart");
  }

  return { path: "rollback", executed: true, changed: true, target: target.path, phases };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const rollback = args.includes("--rollback");
  const list = args.includes("--list");
  const targetIdx = args.indexOf("--target");
  const target = targetIdx !== -1 ? args[targetIdx + 1] : undefined;
  // First non-flag positional after --rollback is the snapshot path
  let snapshotPath;
  if (rollback) {
    const rb = args.indexOf("--rollback");
    const cand = args[rb + 1];
    if (cand && !cand.startsWith("--")) snapshotPath = cand;
  }
  try {
    const result = await runUpgrade({ dryRun, yes, rollback, list, snapshotPath, target });
    if (result.plan) for (const line of result.plan) console.log(line);
    if (result.phases) for (const p of result.phases) console.log(`[${p.name}] ${p.status}${p.cmd ? `: ${p.cmd}` : ""}`);
    if (result.steps) for (const s of result.steps) console.log(`  ${s.status === "ok" ? "✓" : s.status === "skipped-mock" ? "·" : "✗"} ${s.cmd}`);
    if (result.snapshots) {
      console.log(`Found ${result.snapshots.length} snapshots:`);
      for (const s of result.snapshots) console.log(`  ${s.name}`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    if (e.snapshotPath) console.error(`   snapshot: ${e.snapshotPath}`);
    if (e.target) console.error(`   target: ${e.target}`);
    if (e.hint) console.error(`   hint: ${e.hint}`);
    process.exit(1);
  }
}
