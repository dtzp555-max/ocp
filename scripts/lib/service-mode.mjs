// scripts/lib/service-mode.mjs — pure decision layer for setup.mjs's "Step 7" (auto-start
// install). Extracted so the enable/start decision is unit-testable without executing
// setup.mjs, which has top-level side effects and cannot be imported (see AGENTS.md's
// testing note, and test-features.mjs's existing "setup.mjs cannot be imported" comment).
//
// Issue #226: setup.mjs's Linux branch used to unconditionally run
//   systemctl --user daemon-reload / enable ocp-proxy / start ocp-proxy
// every time it ran — including when scripts/upgrade.mjs's phase 4 ("reconfigure") invokes
// it as part of an upgrade. On a host where a competing unit (e.g. a system-scope
// ocp.service) already owns the listening port, that unconditional `start` produces exactly
// the orphan #215 describes, and `enable` re-arms the boot race #215 calls "the part that
// makes it more than cosmetic" — both BEFORE phase 5 (whose job is restarting, and which by
// #221 resolves unit ownership properly) ever runs. The macOS branch has the same shape:
// `launchctl bootstrap` both loads AND starts the job (RunAtLoad=true in the plist), so it is
// phase-4-starts-what-phase-5-should-start on macOS too, independent of which OS/unit family.
//
// planServiceActions() is that decision, made pure: given a platform and whether the caller
// only wants to reconfigure (write the unit/plist, nothing else), it returns which of the
// individual systemctl/launchctl actions setup.mjs should take. setup.mjs performs the
// actions; this module only decides which ones apply.

/**
 * @param {"linux"|"darwin"|string} platform - process.platform value
 * @param {{ reconfigureOnly?: boolean }} [opts]
 * @returns {object} platform-specific action flags; unsupported platforms get {}
 *   linux:  { daemonReload, enable, start }
 *   darwin: { bootstrap }
 */
export function planServiceActions(platform, opts = {}) {
  const reconfigureOnly = !!opts.reconfigureOnly;

  if (platform === "linux") {
    return {
      // daemon-reload only refreshes systemd's in-memory cache of unit files from disk — it
      // does not start or enable anything, so it carries none of #226's risk. It DOES need to
      // stay unconditional: skipping it after writing an updated unit file means a later
      // `systemctl restart` (whichever phase/tool issues it) would restart against the STALE
      // cached definition, not the one just written — the same failure mode PR #221's MED-8
      // finding fixed on the rollback path, and this repo's own
      // docs/runbooks/tui-flip-rollback.md documents as required after any unit-file rewrite.
      daemonReload: true,
      // enabling arms/re-arms "start this unit on next boot" — exactly the boot race #215
      // describes. A reconfigure step must not touch that; only an explicit
      // enable-and-start install action should.
      enable: !reconfigureOnly,
      // starting now is phase 5's job (restart), not phase 4's (reconfigure) — see #226.
      start: !reconfigureOnly,
    };
  }

  if (platform === "darwin") {
    return {
      // launchd has no separate "enable" step distinct from loading: bootstrap loads AND
      // starts the job in one call (the plist sets RunAtLoad=true), and a plist's mere
      // presence under ~/Library/LaunchAgents is what makes launchd auto-load it at the next
      // login — that "enabled for next boot" state is inherent to writing the file, not to
      // calling bootstrap. So reconfigure-only still writes the plist; it just skips the
      // bootstrap call that would start the job immediately in this session.
      bootstrap: !reconfigureOnly,
    };
  }

  // Unsupported platform: setup.mjs's own auto-start step already warns and no-ops here:
  // nothing for a caller to conditionally skip.
  return {};
}
