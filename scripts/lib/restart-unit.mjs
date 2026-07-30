/**
 * scripts/lib/restart-unit.mjs — resolve the unit that actually owns the OCP
 * listener before the upgrade/rollback restart phase touches anything (issue #215).
 *
 * Background: `ocp update`'s restart phase used to hard-code a target —
 * `systemctl --user restart ocp-proxy.service` on Linux, or the launchd
 * bootout/bootstrap pair on macOS — regardless of what actually held the port.
 * On a real host the listener was owned by a SYSTEM unit
 * (`/etc/systemd/system/ocp.service`, bind 0.0.0.0, different CLAUDE_BIN) while
 * a separate, also-enabled USER unit (`~/.config/systemd/user/ocp-proxy.service`,
 * bind 127.0.0.1) existed with different config. `ocp update` "restarted" the
 * user unit; that spawned a SECOND `server.mjs`, which could not bind the
 * already-held port. Post-flight correctly failed (see the comment above
 * `postFlightOk` in scripts/upgrade.mjs — issue #173's acceptance predicate),
 * but the orphan process was left running and the host kept serving the old
 * version. See GitHub issue #215 for the live evidence.
 *
 * This module is pure: it never runs a command and never touches a real
 * service. Callers gather raw command output (`ss`, `lsof`, `/proc/<pid>/cgroup`)
 * and pass it in as a plain object — the same "inject the probe" shape
 * scripts/doctor.mjs uses for `opts.mockHealth` — which is what makes the
 * resolution logic unit-testable without a live systemd/launchd instance.
 */

// --- Linux: pull the listening PID out of `ss -lptn "sport = :<port>"` output ---
// Typical line: `LISTEN 0 511 0.0.0.0:<port> 0.0.0.0:* users:(("node",pid=798931,fd=19))`
export function parseSsListenerPid(ssOutput) {
  if (!ssOutput) return null;
  const m = String(ssOutput).match(/pid=(\d+)/);
  return m ? m[1] : null;
}

// --- macOS: pull the listening PID out of `lsof -nP -iTCP:<port> -sTCP:LISTEN` output ---
// Typical line: `node 12345 user 20u IPv6 0x... 0t0 TCP *:<port> (LISTEN)`
export function parseLsofListenerPid(lsofOutput) {
  if (!lsofOutput) return null;
  const lines = String(lsofOutput).trim().split("\n").filter(Boolean);
  const dataLine = lines.find(l => !/^COMMAND\s/.test(l));
  if (!dataLine) return null;
  const cols = dataLine.trim().split(/\s+/);
  return cols[1] || null;
}

// --- Linux: map a PID's /proc/<pid>/cgroup content to a systemd unit ---
// Reads the cgroup v2 unified line ("0::/...") when present, falling back to
// the cgroup v1 "name=systemd" controller line on older kernels. The LEAF path
// segment is the unit the process actually belongs to; scope (system vs user)
// is read from the presence of "/system.slice/" or "/user.slice/" anywhere in
// the path, since the user-manager's own unit (`user@<uid>.service`) can also
// appear as a non-leaf segment and must not be mistaken for the owning unit.
// Returns { scope: "system"|"user", unit: "<name>.service" } or null when the
// PID isn't in a systemd-managed cgroup at all (a bare, unmanaged process).
export function parseCgroupUnit(cgroupContent) {
  if (!cgroupContent) return null;
  const text = String(cgroupContent).trim();
  if (!text) return null;
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const line = lines.find(l => l.startsWith("0::"))
    || lines.find(l => l.includes("name=systemd"))
    || lines[0];
  if (!line) return null;

  const path = line.split(":").pop();
  const segments = path.split("/").filter(Boolean);
  const leaf = segments[segments.length - 1];
  if (!leaf || !leaf.endsWith(".service")) return null;

  const scope = path.includes("/system.slice/") ? "system"
    : path.includes("/user.slice/") ? "user"
    : null;
  if (!scope) return null;

  return { scope, unit: leaf };
}

/**
 * Resolve the owner of `probe.platform`'s OCP port from already-collected raw
 * command output. Never shells out — pass real output in from the caller.
 *
 * probe:
 *   platform       "darwin" | anything else (treated as Linux/systemd)
 *   expectedUnit   the unit name the OLD hard-coded restart would have used
 *                  ("ocp-proxy.service" on Linux, "dev.ocp.proxy" on macOS) —
 *                  used only to flag a mismatch loudly, never to pick the
 *                  restart target
 *   ssOutput       raw `ss -lptn "sport = :<port>"` stdout (Linux)
 *   lsofOutput     raw `lsof -nP -iTCP:<port> -sTCP:LISTEN` stdout (macOS)
 *   cgroupContent  raw `/proc/<pid>/cgroup` content for the resolved PID (Linux)
 *
 * Returns { kind, platform, pid, unit, scope?, mismatched }, where kind is one of:
 *   "system-unit"    Linux, port owned by a system-scope systemd unit
 *   "user-unit"      Linux, port owned by a user-scope systemd unit
 *   "launchd"        macOS, port is held by a process (launchd is the only
 *                    restart mechanism this repo drives on macOS)
 *   "no-unit"        Linux, a PID holds the port but isn't in any systemd unit
 *                    (a bare `node server.mjs`, most likely)
 *   "not-listening"  nothing is currently bound to the port on either platform
 */
export function resolveOwningUnit(probe = {}) {
  const platform = probe.platform || process.platform;
  const expectedUnit = probe.expectedUnit;

  if (platform === "darwin") {
    const pid = parseLsofListenerPid(probe.lsofOutput);
    if (!pid) return { kind: "not-listening", platform, pid: null, unit: null, mismatched: false };
    return { kind: "launchd", platform, pid, unit: expectedUnit || "dev.ocp.proxy", mismatched: false };
  }

  const pid = parseSsListenerPid(probe.ssOutput);
  if (!pid) return { kind: "not-listening", platform, pid: null, unit: null, mismatched: false };

  const cgroupUnit = parseCgroupUnit(probe.cgroupContent);
  if (!cgroupUnit) return { kind: "no-unit", platform, pid, unit: null, mismatched: false };

  const mismatched = !!expectedUnit && cgroupUnit.unit !== expectedUnit;
  return {
    kind: cgroupUnit.scope === "system" ? "system-unit" : "user-unit",
    platform,
    pid,
    unit: cgroupUnit.unit,
    scope: cgroupUnit.scope,
    mismatched,
  };
}

function launchdCmds(opts) {
  return [
    { cmd: `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`, label: "restart" },
    { cmd: opts.plistCmd || `launchctl bootstrap gui/$(id -u) ${opts.plistPath}`, label: "restart" },
  ];
}

/**
 * Turn a resolveOwningUnit() result into a restart plan: the exact command(s)
 * to run, plus any loud warnings the caller must print BEFORE executing them.
 *
 * Throws — refusing to restart anything — for the two cases where guessing a
 * unit name would repeat issue #215:
 *   - "no-unit": something we can't identify holds the port; restarting a
 *     named unit here is exactly the bug (a second process that can't bind).
 *   - "system-unit" without sudo available: restarting the user-level unit
 *     instead would again leave the real (system) listener untouched.
 *
 * Does NOT throw for "not-listening": if nothing currently holds the port
 * there is no orphan risk, so this falls back to starting the configured
 * (expected) unit fresh — the pre-#215 behavior — with an informational note.
 */
export function planRestart(owner, opts = {}) {
  const warnings = [];
  if (owner.mismatched) {
    warnings.push(
      `[restart] WARNING: the OCP port is actually served by "${owner.unit}" (${owner.kind}), ` +
      `not the expected "${opts.expectedUnit}". Restarting "${owner.unit}" instead of the expected ` +
      `unit — see issue #215 (a hard-coded restart target left an orphan when the real owner differed).`
    );
  }

  if (owner.kind === "not-listening") {
    warnings.push(
      `[restart] note: nothing is currently listening on the OCP port; starting the configured unit fresh (${opts.expectedUnit}).`
    );
    return owner.platform === "darwin"
      ? { action: "launchd", warnings, cmds: launchdCmds(opts) }
      : { action: "user-unit", warnings, cmds: [{ cmd: `systemctl --user restart ${opts.expectedUnit}`, label: "restart" }] };
  }

  if (owner.kind === "no-unit") {
    throw new Error(
      `restart aborted: PID ${owner.pid} holds the OCP port but is not managed by any systemd unit ` +
      `(a bare "node server.mjs"?). Restarting "${opts.expectedUnit}" here would spawn a second, ` +
      `orphaned process that cannot bind the port — exactly issue #215. Stop PID ${owner.pid} manually ` +
      `(or bring it under systemd) and re-run the upgrade.`
    );
  }

  if (owner.kind === "launchd") {
    return { action: "launchd", warnings, cmds: launchdCmds(opts) };
  }

  if (owner.kind === "system-unit") {
    if (!opts.sudoAvailable) {
      throw new Error(
        `restart aborted: "${owner.unit}" is a SYSTEM unit and requires ` +
        `"sudo systemctl restart ${owner.unit}", but non-interactive sudo is unavailable ` +
        `("sudo -n true" failed). Run "sudo systemctl restart ${owner.unit}" manually and re-run ` +
        `the upgrade, or configure passwordless sudo for systemctl — restarting the user-level unit ` +
        `instead would repeat issue #215.`
      );
    }
    return { action: "system-unit", warnings, cmds: [{ cmd: `sudo systemctl restart ${owner.unit}`, label: "restart" }] };
  }

  if (owner.kind === "user-unit") {
    return { action: "user-unit", warnings, cmds: [{ cmd: `systemctl --user restart ${owner.unit}`, label: "restart" }] };
  }

  throw new Error(`restart aborted: unrecognized owner.kind "${owner.kind}"`);
}
