#!/usr/bin/env node
/**
 * OCP (Open Claude Proxy) uninstaller
 *
 * Stops and removes the launchd (macOS) or systemd (Linux) auto-start entry.
 * Handles both legacy (ai.openclaw.proxy / openclaw-proxy) and current
 * (dev.ocp.proxy / ocp-proxy) service names.
 *
 * Run: node uninstall.mjs
 */
import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

function log(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

console.log("\n🗑  Uninstalling OCP auto-start...\n");

const platform = process.platform;

if (platform === "darwin") {
  // Remove current service
  const plistPath = join(HOME, "Library", "LaunchAgents", "dev.ocp.proxy.plist");
  if (existsSync(plistPath)) {
    try { execSync(`launchctl bootout gui/$(id -u) "${plistPath}" 2>/dev/null`); } catch { /* ignore */ }
    unlinkSync(plistPath);
    log(`Removed: ${plistPath}`);
  }

  // Remove legacy service
  const legacyPath = join(HOME, "Library", "LaunchAgents", "ai.openclaw.proxy.plist");
  if (existsSync(legacyPath)) {
    try { execSync(`launchctl bootout gui/$(id -u) "${legacyPath}" 2>/dev/null`); } catch { /* ignore */ }
    unlinkSync(legacyPath);
    log(`Removed legacy: ${legacyPath}`);
  }

  if (!existsSync(plistPath) && !existsSync(legacyPath)) {
    warn("No plist found (service may not have been installed)");
  }

} else if (platform === "linux") {
  // Remove current service
  const servicePath = join(HOME, ".config", "systemd", "user", "ocp-proxy.service");
  try { execSync(`systemctl --user stop ocp-proxy 2>/dev/null`); } catch { /* ignore */ }
  try { execSync(`systemctl --user disable ocp-proxy 2>/dev/null`); } catch { /* ignore */ }
  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
    log(`Removed: ${servicePath}`);
  }

  // Remove legacy service
  const legacyPath = join(HOME, ".config", "systemd", "user", "openclaw-proxy.service");
  try { execSync(`systemctl --user stop openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
  try { execSync(`systemctl --user disable openclaw-proxy 2>/dev/null`); } catch { /* ignore */ }
  if (existsSync(legacyPath)) {
    unlinkSync(legacyPath);
    log(`Removed legacy: ${legacyPath}`);
  }

  try { execSync(`systemctl --user daemon-reload`); } catch { /* ignore */ }
  log("systemd daemon reloaded");

} else {
  warn(`Auto-start not supported on ${platform} — nothing to remove`);
}

console.log("\n✅ Auto-start removed — proxy will no longer start on login\n");
