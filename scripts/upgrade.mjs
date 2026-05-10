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
import { existsSync } from "node:fs";
import { writeSnapshot } from "./lib/snapshot.mjs";

export async function runUpgrade(opts = {}) {
  const dryRun = !!opts.dryRun;
  const yes = !!opts.yes;
  const plan = [];

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

  // fresh_install + rollback land in Bundle 3.
  throw new Error(`path ${kind} not yet implemented`);
}

async function runFullUpgrade({ doctor, opts }) {
  const phases = [];
  const exec = (cmd, label) => {
    if (opts.mockExec) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    const out = execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString();
    phases.push({ name: label, cmd, status: "ok" });
    return out;
  };
  const ocpDir = opts.ocpDir || join(homedir(), "ocp");

  // phase 1: pre-flight (doctor already passed; just record)
  phases.push({ name: "pre-flight", status: "ok", note: `kind=upgrade from=${doctor.current_version} to=${doctor.latest_version}` });

  // phase 2: snapshot
  const fromCommit = opts.mockExec
    ? "mock-commit"
    : execSync(`git -C ${ocpDir} rev-parse HEAD`).toString().trim();
  const snapshotPath = opts.mockExec
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
    console.error(`[heads-up] restarting OCP service in 1s — expect ~5–10s blip on requests in flight.`);
    await new Promise(r => setTimeout(r, 1000));
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
      throw Object.assign(new Error("post-flight failed; run `ocp update --rollback`"), { phases, snapshotPath });
    }
    execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/v1/models > /dev/null`);
    phases.push({ name: "post-flight", status: "ok" });
  } else {
    phases.push({ name: "post-flight", status: "skipped-mock" });
  }

  return { path: "upgrade", executed: true, changed: true, snapshotPath, phases };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes("--dry-run");
  const yes = process.argv.includes("--yes");
  try {
    const result = await runUpgrade({ dryRun, yes });
    if (result.plan) for (const line of result.plan) console.log(line);
    if (result.phases) for (const p of result.phases) console.log(`[${p.name}] ${p.status}${p.cmd ? `: ${p.cmd}` : ""}`);
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
