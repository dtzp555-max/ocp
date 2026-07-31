// scripts/lib/service-mode.mjs — pure decision layer for setup.mjs's "Step 7" (auto-start
// install). Extracted so the enable/start decision is unit-testable without executing
// setup.mjs, which has top-level side effects and cannot be imported (confirmed against
// test-features.mjs's own "setup.mjs cannot be imported (top-level side effects run the
// installer)" comment — this specific claim about setup.mjs is not itself written in
// AGENTS.md; a review caught an earlier draft of this comment wrongly attributing it there).
// AGENTS.md DOES have a directly-relevant, general testing-discipline section — "Testing
// discipline: what counts as a test" — but it is not the server.mjs-scoped section right
// above it in that file; it covers ocp-connect and bash `cmd_restart` alike, and it is
// exactly the section this module's own tests (and scripts/lib/install-autostart.mjs's) have
// to answer to: behavioral, not textual; mutation-proven; restored from a file backup, never
// `git checkout`.
//
// Issue #226: setup.mjs's Linux branch used to unconditionally run
//   systemctl --user daemon-reload / enable ocp-proxy / start ocp-proxy
// every time it ran — including when scripts/upgrade.mjs's phase 4 ("reconfigure") invokes
// it as part of an upgrade. On a host where a competing unit (e.g. a system-scope
// ocp.service) already owns the listening port, that unconditional `start` produces exactly
// the orphan #215 describes, and `enable` re-arms the boot race #215 calls "the part that
// makes it more than cosmetic" — both BEFORE phase 5 (whose job is restarting) ever runs.
// UPDATE (#221, merged): phase 5 no longer hard-codes `systemctl --user restart
// ocp-proxy.service` — ON LINUX it now calls resolveRestartPlan() (scripts/lib/
// restart-unit.mjs) to resolve which unit actually owns the port from live process/cgroup
// state before restarting it. Together with #221, this module's fix (removing phase 4's
// premature `enable`/`start`) closes the #215 orphan for the cross-minor upgrade path — ON
// LINUX. ON MACOS, resolveRestartPlan()'s lsof/netstat cross-check (scripts/upgrade.mjs,
// #240) now correctly tells a genuinely empty port apart from an ambiguous one (a listener
// lsof can't identify the owner of) — but even a CONFIRMED listener is still restarted over
// without verifying it's actually the `dev.ocp.proxy` job (open: #239). The same #215 defect
// shape also persists, on both platforms, on the separate bash `cmd_restart` cascade used by
// the patch-bump and plain-restart paths — tracked separately as #224, not touched by either
// fix.
// The macOS branch has the same phase-4-does-phase-5's-job shape: `launchctl bootstrap` both
// loads AND starts the job (RunAtLoad=true in the plist).
//
// planServiceActions() is that decision, made pure: given a platform and whether the caller
// only wants to reconfigure (write the unit/plist, nothing else), it returns which of the
// individual systemctl/launchctl actions setup.mjs should take. setup.mjs performs the
// actions; this module only decides which ones apply.
//
// resolveServicePlan() wraps planServiceActions() together with the actual --reconfigure-only
// argv parse, so the parse-to-decision path setup.mjs relies on is ONE tested function rather
// than a setup.mjs-local const feeding an imported pure function — closing the gap a review
// found where the argv parse itself (`flag("reconfigure-only")`, a plain assignment inside the
// un-importable top-level script) carried none of the actual behavior-changing logic and could
// be silently hardcoded to `false` (turning the flag into a dead no-op, or worse, reintroducing
// the #226 defect verbatim) without any test noticing.

/**
 * @param {"linux"|"darwin"|string} platform - process.platform value
 * @param {{ reconfigureOnly?: boolean }} [opts]
 * @returns {object} platform-specific action flags; unsupported platforms get {}
 *   linux:  { daemonReload, enable, start }
 *   darwin: { bootstrap }
 */
export function planServiceActions(platform, opts) {
  // Defensive: default parameters only cover `undefined`, not an explicit `null` — a caller
  // passing `null` (e.g. a mistyped opts threading) must not throw reading `.reconfigureOnly`
  // off it. Review-flagged robustness gap.
  const reconfigureOnly = !!(opts && opts.reconfigureOnly);

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
      // (See the module-level note above: phase 5 now resolves unit ownership itself via
      // resolveRestartPlan() (#221, merged); this `start` removal's job is only to stop
      // phase 4 from racing ahead of phase 5's resolution, not to resolve ownership itself.)
      start: !reconfigureOnly,
    };
  }

  if (platform === "darwin") {
    return {
      // CORRECTED (review M1 — the previous comment here was wrong and has been removed):
      // launchd DOES have a persistent enable/disable state, set via `launchctl enable` /
      // `launchctl disable service-target` and inspectable with `launchctl print-disabled`.
      // `man 5 launchd.plist` documents the migration explicitly: "Previous Darwin operating
      // systems would modify the configuration file's value for [the Disabled] key, but now
      // this state is kept externally" — i.e. NOT in the plist file, in a separate persistent
      // store, exactly analogous to systemd's enablement symlink. `bootstrap`/`bootout` do not
      // set or clear that disabled state either way.
      // So the correct parallel to Linux's `enable` is: --reconfigure-only preserves launchd's
      // disabled/enabled state THE SAME WAY it preserves systemd's — by not touching it either
      // way, regardless of this flag. What --reconfigure-only actually controls here is only
      // whether the job is LOADED AND STARTED in this session: `bootstrap` does both in one
      // call (RunAtLoad=true in the plist), so gating it is the direct analogue of Linux's
      // `start` — not of Linux's `enable`, which has no gate here because nothing here touches
      // enable/disable state on either platform.
      bootstrap: !reconfigureOnly,
    };
  }

  // Unsupported platform: setup.mjs's own auto-start step already warns and no-ops here:
  // nothing for a caller to conditionally skip.
  return {};
}

// Recognized forms: bare `--reconfigure-only` (enables it) or its absence (disables it). Any
// `--reconfigure-only=<value>` form is refused rather than silently parsed — a boolean-ish
// `=true`/`=false` suffix is a natural typo for a flag defined as presence-only, and
// `args.includes("--reconfigure-only")` treats EITHER suffixed form as "absent", so a typo'd
// `--reconfigure-only=true` (intending to enable the safety mode) would otherwise silently
// fall through to full enable+start — the more dangerous of the two behaviors defaulting to
// "on" for a malformed safety flag is exactly backwards. Review-flagged ("fails open").
const RECONFIGURE_ONLY_FLAG = "--reconfigure-only";

/**
 * Parses --reconfigure-only out of argv and folds it into planServiceActions() for the given
 * platform — the single tested seam setup.mjs calls, so the argv-parse-to-decision path is not
 * split between an untestable top-level const in setup.mjs and a separately-tested pure
 * function that never sees real argv.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @param {"linux"|"darwin"|string} platform
 * @returns {{ reconfigureOnly: boolean } & object}
 */
export function resolveServicePlan(argv, platform) {
  const list = Array.isArray(argv) ? argv : [];
  const malformed = list.find(a => a !== RECONFIGURE_ONLY_FLAG && a.startsWith(`${RECONFIGURE_ONLY_FLAG}=`));
  if (malformed) {
    throw new Error(
      `${RECONFIGURE_ONLY_FLAG} takes no value (got "${malformed}") — pass it bare to enable, ` +
      `omit it to disable. Refusing rather than silently defaulting to full enable+start.`
    );
  }
  const reconfigureOnly = list.includes(RECONFIGURE_ONLY_FLAG);
  return { reconfigureOnly, ...planServiceActions(platform, { reconfigureOnly }) };
}
