#!/usr/bin/env node
/**
 * scripts/upgrade.mjs — OCP unified upgrade dispatcher.
 *
 * Paths:
 *   noop          current == latest AND service already serving it, exit 0
 *   restart       current == latest but the RUNNING SERVICE is stale (issue #214); no git/npm
 *                 changes — cmd_restart + post-flight only; delegated to bash cmd_update
 *   light         same major.minor, patch bump only (existing fast path; delegated to bash)
 *   full          cross-minor (snapshot + setup.mjs + post-flight)
 *   fresh_install from-version < v3.4.0 (--yes required for non-interactive)
 *   rollback      restore from snapshot
 */
import { runDoctor, detectMultiUnitBootRace } from "./doctor.mjs";
import { execSync, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, copyFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeSnapshot, listSnapshots, readSnapshot, gcSnapshots } from "./lib/snapshot.mjs";
import { resolveOwningUnit, planRestart, classifySsListener, classifyLsofListener } from "./lib/restart-unit.mjs";
import { DEFAULT_PORT } from "../lib/constants.mjs";

// Default command runner for restart-unit gathering/probing: real execSync, string in,
// string out, thrown on nonzero exit. Exists as a named function (not an inline arrow)
// so both the default-parameter position below and any explicit `opts.run ||` fallback
// refer to the exact same implementation.
function execRun(cmd) {
  return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString();
}

// issue #254: the working tree THIS installation (the one this process is actually running from)
// is rooted in.
//
// Post-review correction: the first cut of this function defaulted to `opts.ocpDir ||
// join(homedir(), "ocp")` — the SAME pattern runFullUpgrade/runRollback already use for their own
// git-checkout/npm-install target. That default is silently wrong for THIS comparison specifically.
// `opts.ocpDir` is dead in every real invocation: the `ocp` bash wrapper calls `node
// "$script_dir/scripts/upgrade.mjs" ...` positionally (verified: grep the `ocp` script — no
// `--ocp-dir` flag anywhere), and this file's own `_isMain()` argv parser never reads one either.
// So in production the old default ALWAYS resolved to `~/ocp`, regardless of which tree is
// actually running — which reproduces, in this new check, the exact class of bug it exists to
// catch: it silently reports "match" when a DIFFERENT tree (say `~/ocp-dev`) manages production's
// real `~/ocp` install (nothing about that scenario ever gets compared against the tree that's
// actually acting), and it spuriously reports "mismatch" on every single restart on the
// `/opt/ocp`-shaped hosts this fix was explicitly written to support (this file's own module
// comment and the PR that introduced it both cite `/opt/ocp` as a real production shape) — because
// the default never resolves to anything BUT `~/ocp`.
//
// Fix: default to the directory of THIS RUNNING FILE — the one fact this process can actually be
// certain of — via `fileURLToPath(import.meta.url)`, exactly the same "trust the module's own URL
// over any assumption about where it's installed" precedent `_isMain()` below already establishes
// for symlinked install paths. `scripts/upgrade.mjs` always lives at `<ocpDir>/scripts/upgrade.mjs`
// (setup.mjs never installs it anywhere else), so the OCP root is two `dirname()` calls up.
// `opts.ocpDir` remains a valid EXPLICIT override (tests use it, and any future CLI flag could) —
// only the no-override default changed. realpath'd where possible so a symlinked install dir
// (~/ocp -> /data/ocp, say) compares correctly against /proc/<pid>/cwd's already-kernel-canonical
// target; this function must never throw, only degrade to the best answer it has.
function resolveExpectedWorkingTree(opts) {
  let ocpDir = opts.ocpDir;
  if (!ocpDir) {
    try {
      ocpDir = dirname(dirname(fileURLToPath(import.meta.url)));
    } catch {
      ocpDir = join(homedir(), "ocp"); // last-resort fallback if import.meta.url is ever unavailable
    }
  }
  try { return realpathSync(ocpDir); } catch { return ocpDir; }
}

// issue #233 defect 1: `lsof -nP -iTCP:<port> -sTCP:LISTEN` signals "nothing matched" via
// **exit code 1 with empty stdout** — that's normal, documented lsof behavior, not a probe
// failure. execSync throws on any nonzero exit, so the old code's single `catch { ... = null }`
// mapped that clean "not listening" result to the SAME thing as a genuinely missing tool: both
// became `null` -> resolveOwningUnit's "unknown" -> planRestart's unconditional refusal. That
// made `opts.allowNotListeningFallback` (the rollback recovery path #221 added specifically for
// a down service) unreachable on macOS, and produced a false "lsof did not run" diagnosis on a
// host where lsof ran perfectly cleanly. Verified live on this host:
//   `/usr/sbin/lsof -nP -iTCP:59999 -sTCP:LISTEN; echo $?` -> (no output), exit 1
//   `/usr/sbin/lsof -nP -iTCP:<the OCP port> -sTCP:LISTEN; echo $?` -> (one row), exit 0
// and, via `execSync`'s own error shape for the exit-1 case: `err.status === 1`,
// `err.stdout === ""`, `err.stderr === ""` — no ENOENT, no code, nothing else distinguishes it
// from a "real" failure except the (status, stdout) pair checked below. A missing binary run
// through the shell (`execSync` always shells out for a string command) surfaces as a *shell*
// "command not found" exit — 127, not a Node-level ENOENT — so "anything other than
// status===1-with-empty-stdout" already covers that case.
//
// HIGH-1 (independent review of PR #240, the PR that shipped the paragraph above): that
// (status===1, empty stdout) signature is NOT unique to "genuinely not listening" — a non-root
// `lsof` probing a ROOT-OWNED listener produces the byte-identical (status, stdout, stderr).
// Verified live as a non-root user, three independent instruments, against known-listening ports:
//   port    lsof(status,stdout,stderr)   netstat LISTEN rows   tcp connect
//   <root-owned #1>   (1, "", "")        2 rows                CONNECTED  <- ambiguous
//   <root-owned #2>   (1, "", "")        2 rows                CONNECTED  <- ambiguous
//   <own-uid port>    (0, <data>, "")    1 row                 CONNECTED  <- unambiguous (exit 0)
//   <genuine no-match> (1, "", "")       0 rows                ECONNREFUSED <- the only real "" case
// stderr is empty in BOTH the genuine no-match and the privilege-gap case — an earlier proposal
// to key off stderr emptiness does NOT distinguish them and was rejected for that reason; it only
// would have caught a malformed-argument case (see the port validation at the call site below).
// A root-owned OCP deployment is a supported shape, not hypothetical: scripts/doctor.mjs's
// multi-unit-risk check has a dedicated branch for `/Library/LaunchDaemons`, `scope:"system"`.
// Pre-defect-1 this mapped to `null` -> refuse (fail-closed, wrongly-worded, but safe).
// Post-defect-1 (pre-this-fix) it mapped to `""` -> not-listening -> (on `--rollback`)
// `allowNotListeningFallback` -> bootout the user launchd agent while the root daemon still held
// the port -> EADDRINUSE -> (plist `KeepAlive => true`, verified live) a respawn loop. The
// failure direction inverted.
//
// Fix: gate the `""` mapping behind a POSITIVE liveness cross-check via `netstat`, which (unlike
// `lsof`) reports LISTEN rows regardless of the owning uid and needs no privilege — same live
// evidence table above. Absolute path (`/usr/sbin/netstat`) for the same restricted-PATH reason
// as `lsof` — verified live this session that a restricted PATH omits `/usr/sbin` entirely.
function netstatHasListenerOnPort(run, port) {
  let out;
  try { out = run(`/usr/sbin/netstat -an -p tcp`); }
  catch { return null; } // netstat itself failed to run — cannot confirm either way
  const suffix = `.${port}`;
  return String(out).split("\n").some((line) => {
    if (!/\bLISTEN\b/.test(line)) return false;
    // macOS `netstat -an` columns: Proto Recv-Q Send-Q Local-Address Foreign-Address (State).
    // Local-Address is host.port ("*.<port>", "127.0.0.1.<port>", "::1.<port>") — match on the
    // ".<port>" suffix rather than parsing the address, since the host part varies by family.
    const cols = line.trim().split(/\s+/);
    const localAddr = cols[3] || "";
    return localAddr.endsWith(suffix);
  });
}

// Maps an lsof execSync failure to a probe result. Three outcomes, matching the evidence above:
//   status !== 1 or stdout non-empty  -> { lsofOutput: null }                    (unambiguous failure)
//   status===1, empty stdout, netstat CONFIRMS a LISTEN row for this port
//                                      -> { lsofOutput: null, netstatConfirmsListener: true }
//   status===1, empty stdout, netstat shows NO LISTEN row for this port
//                                      -> { lsofOutput: "" }                     (genuinely not-listening)
//   status===1, empty stdout, netstat itself failed to run
//                                      -> { lsofOutput: null, netstatProbeFailed: true } (fail closed)
// `classifyLsofListener` (scripts/lib/restart-unit.mjs) uses the two flags to pick the right
// human-facing reason text for the `null` cases — see its own comment for the full rationale.
function mapLsofFailureToProbeValue(err, run, port) {
  const status = err && typeof err.status === "number" ? err.status : null;
  const stdout = err && err.stdout != null ? String(err.stdout) : "";
  if (status !== 1 || stdout.trim() !== "") return { lsofOutput: null };

  const listening = netstatHasListenerOnPort(run, port);
  if (listening === true) return { lsofOutput: null, netstatConfirmsListener: true };
  if (listening === false) return { lsofOutput: "" };
  return { lsofOutput: null, netstatProbeFailed: true };
}

// issue #239: `launchctl print gui/<uid>/<label>` signals "label not registered" via a NONZERO
// exit (113 observed on this host; Apple does not document launchctl's exit codes, so this is NOT
// asserted on — matching this file's existing lsof-failure posture above, see
// mapLsofFailureToProbeValue) with EMPTY stdout and a stderr message:
//   Bad request.
//   Could not find service "<label>" in domain for user gui: <uid>
// — verified live against a deliberately nonexistent label on this host. That specific, expected
// failure maps to `""` (classifyLaunchdJob's own "not-registered" sentinel — same convention
// mapLsofFailureToProbeValue uses for lsof's own "nothing matched" signature above); anything else
// (permission failure, launchctl itself missing, a differently-worded failure) maps to `null`
// ("unknown" — genuinely couldn't tell), never silently treated the same as "not registered".
function mapLaunchctlPrintFailureToProbeValue(err) {
  const stdout = err && err.stdout != null ? String(err.stdout) : "";
  const stderr = err && err.stderr != null ? String(err.stderr) : "";
  if (stdout.trim() === "" && /Could not find service/i.test(stderr)) {
    return { launchdPrintOutput: "" };
  }
  return { launchdPrintOutput: null };
}

// issue #253: does a SECOND enabled unit — besides expectedUnit — also target the same port this
// rollback is about to fall back onto? Reuses scripts/doctor.mjs's own #230 detectMultiUnitBootRace
// (its `multi_unit_boot_race` check) rather than re-implementing unit enumeration a second time —
// the exact reuse issue #253 itself asks for. multiUnit is the already-classified result (never
// shells out itself — this function is pure); returns a short human-readable descriptor of every
// OTHER enabled unit sharing this port, or null if there is none / detection was inconclusive.
// Best-effort by design: this is a diagnostic addition to a warning message, not a new refusal —
// a `null` here must never be read as "confirmed no second unit", only as "nothing more specific
// to say", so the caller's existing fallback wording (which already covers the "don't know"
// case honestly) is untouched when this returns null.
function describeSecondUnit(multiUnit, port, expectedUnit) {
  if (!multiUnit || multiUnit.state !== "warn") return null;
  const group = multiUnit.groups.find(g => g.length > 0 && String(g[0].port) === String(port));
  if (!group) return null;
  const others = group.filter(u => u.name !== expectedUnit);
  if (others.length === 0) return null;
  return others.map(u => `${u.scope}-scope "${u.name}" (bind ${u.bind})`).join(" and ");
}

// Resolve which unit actually owns the OCP port and build a restart plan for it, instead
// of blindly restarting a hard-coded name (issue #215). The resolution logic itself
// (resolveOwningUnit / planRestart, in scripts/lib/restart-unit.mjs) is pure and unit-
// tested directly against injected command OUTPUT. This function is the impure layer
// that decides which command runs, with which flags, and how a failure maps to a state —
// independent review of the first version of this fix (PR #221, findings MED-6) found
// that layer had ZERO coverage, and that is exactly where the real defects lived (a
// platform-branch swap and an unreadable-cgroup mismapping both survived mutation
// undetected). opts.run (default: real execSync via execRun above) is the fix: tests pass
// a fake runner that pattern-matches on the command string, driving this function
// end-to-end — see test-features.mjs "Restart-unit resolution".
//
// Three ways to reach a restart plan, all exercised by test-features.mjs:
//   - opts.mockOwnerProbe: skip gathering entirely, resolve from an already-classified
//     probe object (fast path for wiring-level tests: mismatch/refusal behavior)
//   - opts.run given (with or without opts.mockExec): gather via the injected runner —
//     drives the REAL ss/lsof/cgroup-classification pipeline with fake command output
//   - opts.mockExec, no run, no probe: skip gathering, assume the expected unit owns the
//     port (preserves the pre-#215 command; kept for pre-existing tests that only care
//     about phase bookkeeping, not restart resolution)
// isRollback (review finding MED-8): rollback (scripts/lib/snapshot.mjs) only restores the
// launchd plist and the USER-scope systemd unit file — never a SYSTEM unit's config, and
// issues no daemon-reload for one either. If resolution finds the port owned by a system
// unit, rollback must refuse rather than restart config it never touched.
function resolveRestartPlan({ opts, port, isRollback = false, fromCommit = null }) {
  const platform = opts.mockPlatform || process.platform;
  const expectedUnit = platform === "darwin" ? "dev.ocp.proxy" : "ocp-proxy.service";
  const run = opts.run || execRun;

  let owner;
  if (opts.mockOwnerProbe) {
    owner = resolveOwningUnit({ ...opts.mockOwnerProbe, platform: opts.mockOwnerProbe.platform || platform, expectedUnit });
  } else if (opts.mockExec && !opts.run) {
    owner = platform === "darwin"
      ? { kind: "launchd", platform, pid: null, unit: expectedUnit, mismatched: false }
      : { kind: "user-unit", platform, pid: null, unit: expectedUnit, mismatched: false };
  } else {
    // Gather via `run` (real execSync in production, injected in tests). resolveOwningUnit
    // treats null as "couldn't verify" (kind "unknown") and "" as "ran cleanly, found nothing"
    // (kind "not-listening") — those are different facts and collapsing them into one was
    // HIGH-1 on PR #221 (Linux `ss`, which never throws on "no match" — a clean empty read IS
    // the not-listening signal, no catch involved) and issue #233 defect 1 (macOS `lsof`, which
    // DOES throw on "no match" via exit 1 — see mapLsofFailureToProbeValue above for why the
    // catch below cannot just set null unconditionally the way every other catch in this
    // function does).
    const probe = { platform, expectedUnit };
    if (platform === "darwin") {
      // Absolute path: `lsof` lives in /usr/sbin on macOS, which restricted PATHs (a launchd
      // job's `default environment`, a minimal update-runner PATH) omit entirely — a bare
      // `lsof` then fails as "command not found" (exit 127 via the shell), maps to `null`
      // ("unknown"), and aborts an otherwise-healthy restart. /usr/sbin/lsof is a base-system
      // binary present on every macOS install (see mapLsofFailureToProbeValue's comment for the
      // exit-code distinction this catch now makes).
      //
      // Port validation (HIGH-1 follow-up, independent review of PR #240): `port` comes straight
      // from CLAUDE_PROXY_PORT (env, unvalidated — see the two call sites below) and is
      // interpolated directly into the `-iTCP:` flag. A non-numeric or non-positive value would
      // reach lsof and produce the SAME (status 1, empty stdout) shape as a privilege gap or a
      // genuine non-listener — rather than lean on the netstat cross-check to untangle a
      // malformed argument from those two genuine cases, refuse to probe an invalid port at all.
      //
      // Second-round review finding: `Number(port)` VALIDATES the value (and, per `ToNumber`,
      // tolerates leading/trailing whitespace — `Number(" <port> ") === <port>` as a number) but
      // the two lines below used to interpolate the RAW STRING `port`, not the validated
      // `portNum`. A whitespace-padded `CLAUDE_PROXY_PORT` therefore passed validation yet still
      // reached the shell as `-iTCP: <port> ` (note the embedded spaces) — a malformed lsof
      // invocation — and the netstat suffix became `". <port> "`, which matches no real address
      // in `netstat`'s output. Driven live: a REAL listener on the port was read as "nothing is
      // listening", and
      // on `--rollback` that PROCEEDED with the launchd bootout/bootstrap pair against a port a
      // real process still held — the exact HIGH-1 failure direction, reached through a
      // different input. `server.mjs:348` uses `parseInt`, which tolerates the same padding and
      // binds correctly, so this misconfiguration is invisible everywhere except here. Fixed by
      // interpolating the already-validated `portNum` (a clean integer, no padding) in BOTH the
      // `lsof` command and — via the `port` parameter threaded through to
      // `netstatHasListenerOnPort` — the `netstat` suffix, instead of the untouched raw string.
      const portNum = Number(port);
      if (!Number.isInteger(portNum) || portNum <= 0) {
        probe.lsofOutput = null;
      } else {
        try { probe.lsofOutput = run(`/usr/sbin/lsof -nP -iTCP:${portNum} -sTCP:LISTEN`); }
        catch (err) {
          const mapped = mapLsofFailureToProbeValue(err, run, portNum);
          probe.lsofOutput = mapped.lsofOutput;
          if (mapped.netstatConfirmsListener) probe.netstatConfirmsListener = true;
          if (mapped.netstatProbeFailed) probe.netstatProbeFailed = true;
        }
      }

      // issue #239: a confirmed listener alone is not proof it's dev.ocp.proxy — gather launchd's
      // own bookkeeping for the ONE label this repo manages, keyed off nothing but the label
      // itself (unlike Linux, launchd has no pid -> label reverse lookup, so this doesn't need
      // listener.pid the way the cgroup/cmdline reads below do). resolveOwningUnit
      // (scripts/lib/restart-unit.mjs) uses this to verify the port's actual holder before ever
      // treating a confirmed listener as a restart candidate — see classifyLaunchdJob /
      // classifyLaunchdArgv for the pure classification half. Only probed once a listener is
      // actually confirmed (same "don't shell out for nothing" posture the Linux branch below
      // already takes for its own cgroup/cmdline reads).
      const macListener = classifyLsofListener(probe.lsofOutput, {
        netstatConfirmsListener: !!probe.netstatConfirmsListener,
        netstatProbeFailed: !!probe.netstatProbeFailed,
      });
      if (macListener.state === "listening") {
        try { probe.launchdPrintOutput = run(`launchctl print gui/$(id -u)/${expectedUnit}`); }
        catch (err) { probe.launchdPrintOutput = mapLaunchctlPrintFailureToProbeValue(err).launchdPrintOutput; }
      }
    } else {
      try { probe.ssOutput = run(`ss -lptn "sport = :${port}"`); } catch { probe.ssOutput = null; }
      const listener = classifySsListener(probe.ssOutput);
      if (listener.state === "listening") {
        try { probe.cgroupContent = run(`cat /proc/${listener.pid}/cgroup`); } catch { probe.cgroupContent = null; }
        // issue #237: read cmdline in the SAME gather step, keyed off the same listener.pid — no
        // separate resolution pass. resolveOwningUnit (scripts/lib/restart-unit.mjs) uses this to
        // confirm the owning process is actually OCP's server.mjs before ever treating a resolved
        // unit as a restart candidate, instead of acting on a real-but-foreign unit name.
        try { probe.cmdlineContent = run(`cat /proc/${listener.pid}/cmdline`); } catch { probe.cmdlineContent = null; }
        // issue #254: same gather step, same pid — read the process's actual working directory via
        // the /proc/<pid>/cwd symlink (readlink resolves it to a kernel-canonical absolute path,
        // regardless of whether argv itself spelled out a relative or absolute server.mjs). Paired
        // with expectedWorkingTree (this installation's own tree) so resolveOwningUnit can tell a
        // same-name, same-argv process apart from a DIFFERENT OCP checkout — see
        // classifyWorkingTree's own comment in restart-unit.mjs for what this can and cannot decide.
        try { probe.cwdTarget = run(`readlink /proc/${listener.pid}/cwd`); } catch { probe.cwdTarget = null; }
        probe.expectedWorkingTree = resolveExpectedWorkingTree(opts);
      }
    }
    owner = resolveOwningUnit(probe);
  }

  // uid===0 short-circuits sudo entirely (MED-4): a process already running as root needs
  // no sudo prefix, and telling it to run `sudo` is actively wrong on a minimal image that
  // doesn't have sudo installed at all.
  let isRoot = opts.mockIsRoot;
  if (isRoot === undefined) {
    isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  }

  // sudoAuthorized answers "is THIS SPECIFIC restart command authorized non-interactively",
  // not "is sudo generically passwordless" (MED-4) — NOPASSWD sudoers entries are per-command,
  // so `sudo -n true` both false-negatives on a correctly least-privilege-scoped rule and
  // false-positives on a broad rule that doesn't actually cover systemctl. Only probed when
  // it matters (system-unit, not already root) and only for the resolved unit.
  let sudoAuthorized = opts.mockSudoAuthorized;
  if (sudoAuthorized === undefined && owner.kind === "system-unit" && !isRoot) {
    const isBareProduction = !opts.run && !opts.mockExec && !opts.mockOwnerProbe;
    if (opts.run || isBareProduction) {
      // MED-C (PR #221 round-2 review): "--" matches the actual restart command's shape
      // (scripts/lib/restart-unit.mjs's planRestart) — a sudoers rule authorizing one must
      // authorize the other, and a leading-dash unit name must not be read as another sudo/
      // systemctl option here either.
      try { run(`sudo -n -l systemctl restart -- ${owner.unit}`); sudoAuthorized = true; }
      catch { sudoAuthorized = false; }
    } else {
      // Mocked/test context with no injected runner and no explicit answer — never shell
      // out to a real sudo here; an unset expectation must be explicit (fail loud).
      sudoAuthorized = false;
    }
  }

  if (isRollback && owner.kind === "system-unit") {
    // MED-F (PR #221 round-2 review): this refusal is still correct — rollback never restored
    // this unit's OWN config (bind address, environment; see scripts/lib/snapshot.mjs), so
    // restarting it would not, by itself, prove the rollback landed. But the original message
    // stopped short of telling the operator what it DOES know: the `git-checkout` phase (which
    // ran before this check, unconditionally) already moved the working tree to fromCommit, and
    // on a host shaped like issue #215's own — both units pointing at that SAME working tree —
    // that IS the code this unit runs; only its own config was left untouched. Naming the exact
    // manual command matches the posture the upgrade-path refusals already take (see planRestart's
    // "requires sudo systemctl restart" message) instead of leaving the operator to derive it.
    const manualCmd = isRoot ? `systemctl restart -- ${owner.unit}` : `sudo systemctl restart -- ${owner.unit}`;
    throw new Error(
      `rollback aborted: the OCP port is owned by a SYSTEM unit ("${owner.unit}"), but rollback only ` +
      `restores the launchd plist and the USER-scope systemd unit file ` +
      `(~/.config/systemd/user/ocp-proxy.service — see scripts/lib/snapshot.mjs). It never touched ` +
      `this unit's OWN config, so this refusal stands for that config. However: the working tree ` +
      `has ALREADY been rolled back to ${fromCommit || "the snapshot's from-commit"} (the ` +
      `git-checkout phase, which ran before this check) — if "${owner.unit}" runs from that same ` +
      `tree (the common shape: one working tree, two units differing only in bind/env — see issue ` +
      `#215's own host), the rollback is otherwise complete and only a restart is outstanding. Run ` +
      `\`${manualCmd}\` manually to pick that up; separately revert "${owner.unit}"'s own config by ` +
      `hand if it also needs to change.`
    );
  }

  // issue #234 (second independent review of #221, post-merge): the refusal above only fires for
  // a SYSTEM-scope mismatch — it keys on `owner.kind`, i.e. SCOPE, not on unit IDENTITY. But
  // rollback's restore step (scripts/lib/snapshot.mjs's tryCopy calls / runRollback's own tryCopy
  // calls above) only EVER writes `expectedUnit`'s own file — never any other unit's, user-scope
  // included. A user-scope unit under a DIFFERENT name from `expectedUnit` is exactly as untouched
  // by the restore as a system unit is: nothing above this line has EVER written its config, and
  // restarting it would restart whatever config was already there before the rollback started,
  // while "${expectedUnit}"'s just-restored file sits on disk unused. That is precisely the field
  // report in #234 — "restored: ocp-proxy.service, restarted: ocp.service" — except here the
  // restarted unit is user-scope too, so the SYSTEM-unit check above never even sees it. Guard on
  // IDENTITY (owner.unit !== expectedUnit) for this case, exactly as issue #234 prescribes,
  // instead of extending the scope check to somehow cover it.
  if (isRollback && owner.kind === "user-unit" && owner.unit !== expectedUnit) {
    const manualCmd = `systemctl --user restart -- ${owner.unit}`;
    throw new Error(
      `rollback aborted: the OCP port is owned by a DIFFERENT user-scope unit ("${owner.unit}"), but ` +
      `rollback only ever restores "${expectedUnit}"'s own config (scripts/lib/snapshot.mjs's ` +
      `tryCopy calls / runRollback's own tryCopy calls in scripts/upgrade.mjs always target that ` +
      `exact file, never "${owner.unit}"'s). Restarting "${owner.unit}" would not make the rollback ` +
      `take effect: it would restart config the rollback never touched, while "${expectedUnit}"'s ` +
      `freshly-restored file sits unused. The working tree has ALREADY been rolled back to ` +
      `${fromCommit || "the snapshot's from-commit"} (the git-checkout phase, which ran before this ` +
      `check) — if "${owner.unit}" runs from that same tree, only a restart is outstanding: run ` +
      `\`${manualCmd}\` manually to pick that up, and separately reconcile "${owner.unit}"'s own ` +
      `config against "${expectedUnit}"'s restored file by hand if they differ.`
    );
  }

  // issue #253: the allowNotListeningFallback warning below (planRestart) used to assert "there is
  // no other candidate unit to weigh this against" unconditionally — true on the #221 host this
  // fallback was designed for, but not in general: the exact host that motivated #215 has a SYSTEM
  // unit and a USER unit both enabled for the same port, and #230's own multi_unit_boot_race check
  // already knows how to detect that shape. Only probed when it's actually about to matter
  // (rollback, and the port genuinely isn't listening — the one state where the fallback fires) so
  // a healthy rollback never pays for an extra `systemctl`/plist scan. opts.mockSecondUnitNote is
  // the test seam, mirroring sudoAuthorized's own opts.mockSudoAuthorized pattern just above: an
  // explicit answer always wins; otherwise, in a mocked/test context with no injected runner, this
  // skips rather than shells out for real (never silently probes a live host from inside a test).
  let secondUnitNote = opts.mockSecondUnitNote;
  if (secondUnitNote === undefined && isRollback && owner.kind === "not-listening") {
    const isBareProduction = !opts.run && !opts.mockExec && !opts.mockOwnerProbe;
    if (opts.run || isBareProduction) {
      try {
        const multiUnit = detectMultiUnitBootRace({ mockPlatform: platform, run });
        secondUnitNote = describeSecondUnit(multiUnit, port, expectedUnit);
      } catch {
        // Best-effort: this is a diagnostic addition to a warning, not a new refusal — a failed
        // probe here must never abort an otherwise-recoverable rollback.
        secondUnitNote = null;
      }
    } else {
      secondUnitNote = null;
    }
  }

  const plan = planRestart(owner, {
    expectedUnit,
    isRoot,
    sudoAuthorized,
    plistPath: join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist"),
    // HIGH-A (PR #221 round-2 review): scope the "not-listening" refusal to the upgrade path.
    // Rollback's whole point is restoring a down service, it has no doctor health gate to
    // protect (see runUpgrade: "no doctor needed; snapshot is authoritative"), and refusing here
    // left rollback permanently stuck — re-running hits this identical state forever. See
    // scripts/lib/restart-unit.mjs's planRestart for the fallback itself.
    allowNotListeningFallback: isRollback,
    // issue #253: name the second enabled unit (if any) in the fallback warning, instead of
    // asserting none exists.
    secondUnitNote,
  });
  return { owner, plan };
}

// Post-flight acceptance predicate (issue #173). A health probe passes ONLY when the server
// is authed AND actually serving the TARGET version. auth.ok alone is not enough: a stale
// process holding the port answers auth.ok=true while still running the OLD code — exactly
// what a nohup-fallback orphan did on 2026-07-17 (upgrade "succeeded", /health kept serving
// 3.21.1). Comparing /health.version to the checkout target catches orphan-holds-port,
// restart-didn't-take, and wrong-unit-restarted alike. `target` tolerates a leading "v"
// (doctor reports "v3.22.1"; /health reports "3.22.1"); an empty/unknown target degrades to
// the old auth-only check rather than blocking an otherwise-good upgrade.
export function postFlightOk(body, target) {
  if (body?.auth?.ok !== true) return false;
  const want = String(target || "").replace(/^v/, "");
  return !want || body?.version === want;
}

// Issue #214 remediation (kind="restart"): bash's cmd_restart() already performs the actual
// restart — it has richer fallback logic than anything worth duplicating here (launchd →
// systemd → manual nohup, see `ocp`). What it lacked was verification: its failure path only
// echoes and still returns 0, so a failed restart reported success while the service kept
// serving the old version (review finding MED-1 on PR #217 — this was the "reports success
// while serving old code" complaint from #214, only partly fixed by detection alone). This
// polls /health and reuses postFlightOk() — the SAME acceptance predicate runFullUpgrade's
// post-flight phase uses — rather than a second hand-rolled check. Exported so `ocp update`'s
// bash "restart" path can invoke it via the CLI entrypoint below (`--post-flight-only`).
// opts.mockProbe (test hook, mirrors doctor.mjs's opts.mockHealth / runFullUpgrade's
// opts.mockExec convention): a zero-arg function called instead of the real curl, returning a
// /health body object or throwing (to simulate unreachable) — makes the retry loop testable
// without a live server or real sleeps.
export async function runPostFlightCheck(target, opts = {}) {
  const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
  const attempts = opts.attempts ?? 10;
  const intervalMs = opts.intervalMs ?? 1000;
  const probe = opts.mockProbe || (() => {
    const out = execSync(`curl -sf --max-time 2 http://127.0.0.1:${port}/health`).toString();
    return JSON.parse(out);
  });
  let ok = false, lastSeen = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const body = probe();
      lastSeen = body.version;
      if (postFlightOk(body, target)) { ok = true; break; }
    } catch { /* retry */ }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok, lastSeen, target: String(target || "").replace(/^v/, "") };
}

// Issue #257: `--target` was parsed from argv (see `_isMain()` below) and threaded into
// `runUpgrade(opts)`, but `opts.target` was never actually READ anywhere in `runUpgrade`,
// `runFullUpgrade`, `runFreshInstall`, or `runRollback` — the full (cross-minor) upgrade path
// always checked out `doctor.latest_version`, silently ignoring any pin. This is the fix for
// that path specifically.
//
// Scope, decided here rather than left implicit: this does NOT let `--target` bypass doctor's
// own kind selection (current-vs-latest comparison, decided before either caller below ever
// runs) — it only decides WHICH tag gets checked out once doctor has ALREADY chosen the
// "upgrade" kind. Whether `--target` should be able to force an upgrade doctor wouldn't
// otherwise recommend (e.g. an arbitrary downgrade) is the larger design question the issue
// itself raises ("does --target bypass doctor's own kind selection entirely?") and explicitly
// defers — out of scope for this fix, which closes the "dead code" bug, not that open question.
// Consistency with the light path's own --target handling (issue #241, PR #255, still under
// review as of this PR): that path made --target a warning-only no-op because its mechanism
// (`git pull origin main --ff-only`) has no tag-checkout step to redirect at all — honoring a
// pin there means SWAPPING mechanisms (pull -> tag checkout), a separate design decision #255
// deliberately deferred. The full path's mechanism ALREADY is a tag checkout
// (`git checkout ${target}` below) — redirecting which tag is a small, in-mechanism change, not
// a mechanism swap, which is why this PR reaches a different, still-coherent answer instead of
// mirroring #255's no-op for consistency's own sake.
//
// Kept pure (no git access) so `runUpgrade`'s --dry-run preview can call this too without ever
// shelling out — a preview does not need to confirm the tag actually exists, only the real
// execution path does (see runFullUpgrade's own tag-existence check, right after this is called).
//
// SECURITY (independent review finding, HIGH — fixed here): the regex below is anchored at BOTH
// ends (`^...$`), not just the start. The original, unanchored form (`^(\d+)\.(\d+)\.(\d+)` with
// no trailing `$`) happily matched a PREFIX of an arbitrary string — e.g.
// `_targetSemverParts("3.99.0 ; touch /tmp/PWNED ; false")` returned `{major:3,minor:99,patch:0}`,
// silently discarding everything from the space onward. Because `resolveUpgradeTarget` (below,
// pre-fix) returned the RAW input string rather than a value rebuilt from the parsed integers,
// that discarded suffix survived downstream, where it was interpolated directly into an
// `execSync` template string in `runFullUpgrade` (`git -C ${ocpDir} rev-parse --verify
// refs/tags/${pinnedTarget}` and `git -C ${ocpDir} checkout ${upgradeTarget}`) — `execSync` runs
// its argument through `/bin/sh`, so the `; touch ... ; false` portion executed as an
// independent shell command regardless of whether the `git` portion succeeded. Verified: the
// crafted payload above made the tag-existence check "cleanly" refuse (git's own exit code was
// masked by the trailing `; false`), while the injected `touch` ran anyway, during validation,
// before the refusal was ever reported. The fix has two independent layers, both required
// ("belt and braces" per review): (1) this anchor makes ANY string containing extra characters
// fail to parse at all, so it never reaches `resolveUpgradeTarget`'s return; (2) even if this
// anchor is ever loosened again by a future edit, `runFullUpgrade` now invokes `git` via
// `execFileSync(file, [args...])` (see below) instead of a shell template string, which never
// invokes `/bin/sh` at all — a malformed argv element is passed to `git` as a single, inert
// argument, never parsed as shell syntax.
function _targetSemverParts(v) {
  const m = String(v).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}
function _targetSemverCompare(a, b) {
  const A = _targetSemverParts(a), B = _targetSemverParts(b);
  if (!A || !B) return null; // unparseable -- caller must treat as "cannot compare", not 0
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  return A.patch - B.patch;
}
function resolveUpgradeTarget({ target: rawTarget, currentVersion }) {
  if (!rawTarget) return { target: null, pinned: false };
  const parsed = _targetSemverParts(rawTarget);
  if (!parsed) {
    throw new Error(`--target ${rawTarget} is not a parseable vX.Y.Z version`);
  }
  // SECURITY: rebuilt from the PARSED INTEGER PARTS, never `rawTarget` itself (see the security
  // note above `_targetSemverParts`) — this is what makes a shell-metacharacter payload
  // structurally impossible to carry downstream, independent of whether the anchored regex
  // above is ever loosened by a future edit.
  const requested = `v${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const cmp = _targetSemverCompare(requested, currentVersion);
  if (cmp === null) {
    throw new Error(`--target ${rawTarget} is not a parseable vX.Y.Z version`);
  }
  if (cmp <= 0) {
    throw new Error(
      `--target ${requested} is not newer than the current version (${currentVersion}) — the ` +
      `upgrade path only moves forward; use \`ocp update --rollback\` to go back to a previous ` +
      `snapshot instead`
    );
  }
  return { target: requested, pinned: true };
}

export async function runUpgrade(opts = {}) {
  const dryRun = !!opts.dryRun;
  const yes = !!opts.yes;
  // yes is reserved for Bundle 3 (fresh-install / rollback interactive gate); not used in upgrade-path here.
  const plan = [];

  // --- rollback path (no doctor needed; snapshot is authoritative) ---
  if (opts.rollback) {
    // Independent review of #260/#272 (round 2): --target has NO meaning on --rollback --
    // rollback restores a STORED SNAPSHOT (selected by path, or the most recent one), never
    // an arbitrary requested version, and runRollback() below never reads opts.target at
    // all -- it silently ignores it, the same "accepted and dropped with no signal" shape
    // #260 exists to close everywhere else. This combination became genuinely reachable in
    // practice only after this same file's own noop/restart/fresh_install refusal messages
    // (below) started pointing refused users at `ocp update --rollback` for downgrade
    // intent -- following that advice with --target still attached would otherwise restore
    // the newest snapshot while reporting success, believing the requested version was
    // honored, on the one path that actually mutates disk (git checkout, npm install,
    // restore plist/db, restart). Refuse rather than silently drop it, matching every other
    // guard this issue added.
    if (opts.target) {
      throw new Error(
        `--target ${opts.target} has no effect on --rollback -- rollback restores a stored snapshot (selected by path, or the most recent one), not a requested version. Use \`ocp update --rollback --list\` to see available snapshots, then \`ocp update --rollback <path>\` to restore a specific one.`
      );
    }
    return await runRollback(opts);
  }

  // --- doctor pre-flight ---
  const doctor = opts.mockDoctor || await runDoctor();
  if (!doctor.ready_to_upgrade && doctor.next_action.kind !== "fresh_install") {
    throw new Error(`doctor FAIL: ${doctor.next_action.kind} (run "ocp doctor" for details)`);
  }

  const kind = doctor.next_action.kind;
  plan.push(`[doctor] from=${doctor.current_version} to=${doctor.latest_version} kind=${kind}`);

  // Issue #260: --target is a PIN ("do not put me on anything else"), not a preference. noop,
  // restart, and fresh_install have no mechanism to redirect what they do onto a specific
  // version: noop does nothing, restart re-serves the CURRENT tree exactly as-is, and
  // fresh_install replays doctor's own ai_executable[] -- a fixed, unparameterized script, not
  // a tag checkout. Refuse (throw -- matching resolveUpgradeTarget's own refusal shape below,
  // and mirroring bash's identical noop/restart refusal in `ocp`'s cmd_update) rather than
  // silently proceeding -- including proceeding to do NOTHING -- when the caller asserted a
  // pin. Checked here, before both the noop early-return and the --dry-run early-exit below,
  // so previewing an impossible pin also refuses rather than previewing a plan that quietly
  // drops it.
  //
  // "restart" is reachable here only when something calls runUpgrade() programmatically with a
  // mockDoctor/live doctor reporting kind="restart" -- the real CLI path (`ocp`'s cmd_update)
  // handles "restart" entirely in bash (_cmd_update_restart, which never execs into this file
  // at all) and refuses it there directly, for the identical reason -- see that refusal's own
  // comment in `ocp`. Included here anyway as defense in depth for any other caller of this
  // exported function.
  //
  // "fresh_install" IS reached for real through the CLI: `ocp`'s cmd_update dispatches BOTH
  // "upgrade" and "fresh_install" through the same `exec node scripts/upgrade.mjs "$@"` arm
  // (only "upgrade" honors --target, per #259), so this is the only layer that can refuse it.
  //
  // Consistency with the light/patch-bump path ("update" kind, #241/#255): that path stays a
  // WARNING, not a refusal, here and in `ocp` -- out of this issue's own stated scope (its own
  // table lists only noop/restart/fresh_install as "no signal at all"; the light path already
  // gives an observable, if non-blocking, stderr signal). See this PR's description for the
  // full reasoning either way.
  if (opts.target && (kind === "noop" || kind === "restart" || kind === "fresh_install")) {
    const why = kind === "noop"
      ? "the tree is already at the latest release -- there is nothing to check out"
      : kind === "restart"
        ? "the tree already matches the latest release and only the running service is stale -- this path restarts the current tree as-is and never runs git"
        : "fresh_install replays doctor's own fixed install steps, not a checkout of a specific tag";
    throw new Error(
      `--target ${opts.target} was requested, but doctor selected the "${kind}" path, which cannot honor a version pin (${why}). Re-run \`ocp update\` without --target, or once a cross-minor release makes the full upgrade path available -- that is currently the ONLY path that honors --target (the light/patch-bump path warns and ignores it, per #241/#255). To move to an OLDER version instead, run \`ocp update --rollback --list\` to pick a snapshot, then \`ocp update --rollback <path>\` to restore it -- --target is NOT accepted on --rollback.`
    );
  }

  // --- noop ---
  if (kind === "noop") {
    plan.push(`[noop] already at latest (${doctor.latest_version})`);
    return { path: "noop", executed: true, changed: false, plan };
  }

  // --- dry-run early exit ---
  if (dryRun) {
    plan.push(`[plan] would proceed with ${kind} path`);
    if (kind === "upgrade") {
      // Issue #257: preview must show what the real run would ACTUALLY check out, not always
      // doctor.latest_version — otherwise `--dry-run --target vX.Y.Z` promises one thing and the
      // real (non-dry-run) invocation, right below, does another. resolveUpgradeTarget() throws
      // on an invalid/non-forward target even here — a preview should not claim to plan something
      // the real run would refuse.
      const { target: previewPinned } = resolveUpgradeTarget({ target: opts.target, currentVersion: doctor.current_version });
      const previewTarget = previewPinned || doctor.latest_version;
      plan.push(`[plan] phase 1: snapshot to ~/.ocp/upgrade-snapshot-<ts>/`);
      plan.push(`[plan] phase 2: git checkout ${previewTarget} && npm install`);
      plan.push(`[plan] phase 3: node setup.mjs --reconfigure-only`);
      plan.push(`[plan] phase 4: launchctl bootout/bootstrap`);
      plan.push(`[plan] phase 5: post-flight /health + /v1/models`);
    } else if (kind === "update") {
      plan.push(`[plan] light path: git pull + npm install + restart`);
    } else if (kind === "restart") {
      plan.push(`[plan] restart-only path: NO git/npm changes (tree already at ${doctor.current_version}) — cmd_restart + post-flight verify`);
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

  if (kind === "restart") {
    // Placeholder for parity with "update" above: the real work (cmd_restart + post-flight)
    // happens in bash's _cmd_update_restart, which `ocp`'s cmd_update case statement calls
    // directly — this function is only reached here if something calls runUpgrade()
    // programmatically (bypassing the bash CLI) with a mockDoctor/live doctor reporting
    // kind="restart".
    return { path: "restart", executed: true, changed: true, plan: [...plan, "[restart] delegated to bash cmd_update existing logic (cmd_restart + post-flight, no git)"] };
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
  // SECURITY (issue #257 review, HIGH): argv-form sibling of `exec` above, for the one command in
  // this function whose arguments can carry a user-supplied value (`upgradeTarget`, from
  // `--target`) — `execFileSync(file, args)` never invokes `/bin/sh`, so an argv element can
  // never be reinterpreted as shell syntax, unlike `exec`'s template-string form. `cmd` (the
  // human-readable display string recorded into `phases`, e.g. for existing tests asserting on
  // `.cmd.includes("checkout vX.Y.Z")`) is built via `.join(" ")` purely for bookkeeping/display
  // — it is NEVER itself executed.
  const execArgv = (file, args, label) => {
    const cmd = [file, ...args].join(" ");
    if (opts.mockExec) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    try {
      const out = execFileSync(file, args, { stdio: ["pipe", "pipe", "pipe"] }).toString();
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
  // opts.mockPort (test hook, mirrors opts.mockPlatform): lets tests drive resolveRestartPlan's
  // port validation (HIGH-1 follow-up below) with a deliberately malformed value without
  // mutating the real process.env — a global that would otherwise leak across tests.
  const port = opts.mockPort || process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);

  // Issue #257: resolve --target BEFORE any mutation (deliberately outside the try/catch below,
  // and before phase 1 is even recorded) — an invalid or unknown pin must refuse loudly with no
  // snapshot taken and no git/npm command run, not fail partway through. resolveUpgradeTarget()
  // itself only checks shape + direction (pure, no git); the tag's actual EXISTENCE is checked
  // here, separately, because that part legitimately needs git and is execution-only (the
  // --dry-run preview above deliberately does not need to confirm existence, only shape).
  // opts.mockTargetExists (test hook, same convention as opts.mockPort/opts.mockPlatform) lets
  // tests drive both branches without a real git tree; absent that, opts.mockExec defaults to
  // "assume it exists" (matching this function's existing mockExec-is-bookkeeping-only
  // convention below — every other real git/npm call in this function is already skipped the
  // same way under mockExec).
  const { target: pinnedTarget } = resolveUpgradeTarget({ target: opts.target, currentVersion: doctor.current_version });
  if (pinnedTarget) {
    const tagExists = opts.mockTargetExists !== undefined
      ? opts.mockTargetExists
      : opts.mockExec
        ? true
        : (() => {
            // SECURITY: argv form, never a shell template string (see the security note above
            // resolveUpgradeTarget) — execFileSync passes `pinnedTarget` as ONE inert argument to
            // `git` directly, with no `/bin/sh` in between to reinterpret it. Defense in depth:
            // by the time execution reaches here, `pinnedTarget` is already normalized (rebuilt
            // from parsed integers, never raw input), so this would already be safe even as a
            // shell string — this is the second, independent layer, not reliance on the first.
            try {
              execFileSync("git", ["-C", ocpDir, "rev-parse", "--verify", `refs/tags/${pinnedTarget}`], { stdio: ["pipe", "pipe", "pipe"] });
              return true;
            } catch { return false; }
          })();
    if (!tagExists) {
      throw new Error(
        `--target ${pinnedTarget} is not a known release tag (checked refs/tags/${pinnedTarget} ` +
        `in ${ocpDir}). Run \`git -C ${ocpDir} tag -l\` to see available versions.`
      );
    }
  }
  const upgradeTarget = pinnedTarget || doctor.latest_version;

  try {
    // phase 1: pre-flight (doctor already passed; just record)
    phases.push({ name: "pre-flight", status: "ok", note: `kind=upgrade from=${doctor.current_version} to=${upgradeTarget}` });

    // phase 2: snapshot
    const fromCommit = opts.mockExec
      ? "mock-commit"
      : execSync(`git -C ${ocpDir} rev-parse HEAD`).toString().trim();
    snapshotPath = opts.mockExec
      ? "/tmp/mock-snapshot"
      : writeSnapshot({ homeDir: homedir(), fromCommit, fromVersion: doctor.current_version, toVersion: upgradeTarget });
    phases.push({ name: "snapshot", path: snapshotPath, status: "ok" });

    // phase 3: fetch + install
    // Issue #257: checkout `upgradeTarget` (the validated --target pin, when given), not
    // unconditionally `doctor.latest_version` — this is the actual fix; everything above is
    // resolving/validating what that value should be. SECURITY (review, HIGH): the checkout uses
    // `execArgv` (argv form), not `exec` (shell template string) — `upgradeTarget` can carry
    // user-supplied content via --target, so it must never be concatenated into a string that
    // reaches `/bin/sh`. `fetch`/`npm install` carry no user-supplied value, so they stay on the
    // plain `exec` helper.
    exec(`git -C ${ocpDir} fetch --tags --quiet`, "fetch+install");
    execArgv("git", ["-C", ocpDir, "checkout", upgradeTarget], "fetch+install");
    exec(`npm --prefix ${ocpDir} install --no-audit --no-fund`, "fetch+install");

    // phase 4: reconfigure — writes the service unit/plist ONLY (config + legacy-unit
    // migration are both gated on --reconfigure-only inside setup.mjs; see
    // scripts/lib/service-mode.mjs); must not enable-at-boot or start (issue #226). Enabling
    // re-arms the boot race #215 describes on a host with a competing unit for the same port.
    // UPDATE: together with #221 (merged), this closes MOST of #215's orphan for THIS path.
    // Phase 5 below no longer hard-codes `systemctl --user restart ocp-proxy.service` — ON
    // LINUX it calls resolveRestartPlan() (scripts/lib/restart-unit.mjs), which resolves which
    // unit actually owns the port from live process/cgroup state before restarting it. ON
    // MACOS, resolveRestartPlan()'s lsof/netstat cross-check (mapLsofFailureToProbeValue /
    // netstatHasListenerOnPort above, #240) now correctly tells a genuinely empty port apart
    // from an ambiguous one (a listener lsof can't identify the owner of) — but even a
    // CONFIRMED listener is still restarted over without verifying it's actually the
    // `dev.ocp.proxy` job (open: #239). What this phase-4 fix removes is phase 4's premature
    // `enable` (the boot-race re-arm) and its premature `start` (racing ahead of phase 5's
    // resolution); #221 is what makes phase 5 itself restart the right unit on Linux.
    // --reconfigure-only is setup.mjs's opt-in mode for exactly this call site; a bare first
    // install still calls setup.mjs without it (scripts/doctor.mjs's fresh_install path), so
    // it keeps enabling + starting, which is that path's actual job.
    // The same #215 defect shape persists on the SEPARATE bash `cmd_restart` cascade used by
    // the patch-bump ("update") and plain-restart ("restart") kinds — tracked as #224, not
    // fixed by this module.
    exec(`node ${ocpDir}/setup.mjs --reconfigure-only`, "reconfigure");

    // phase 5: restart (heads-up note printed before invoking)
    if (!opts.mockExec) {
      console.error(`[heads-up] restarting OCP service in 3s — expect ~5–10s blip on requests in flight.`);
      await new Promise(r => setTimeout(r, 3000));
    }
    let restartPlan;
    try {
      restartPlan = resolveRestartPlan({ opts, port });
    } catch (err) {
      phases.push({ name: "restart", status: "fail", stderr: err.message });
      throw err;
    }
    for (const w of restartPlan.plan.warnings) {
      console.error(w);
      phases.push({ name: "restart-resolve", status: "warn", note: w });
    }
    for (const c of restartPlan.plan.cmds) exec(c.cmd, c.label);

    // phase 6: post-flight (10s budget; skipped under mockExec)
    if (!opts.mockExec) {
      let ok = false;
      let lastSeen = null;
      for (let i = 0; i < 10; i++) {
        try {
          const out = execSync(`curl -sf --max-time 2 http://127.0.0.1:${port}/health`).toString();
          const body = JSON.parse(out);
          lastSeen = body.version;
          // Issue #257: verify against upgradeTarget (the validated pin, when given) — checking
          // against doctor.latest_version unconditionally would report a PINNED upgrade as
          // "failed" once the service correctly landed on the (older, requested) target, or
          // wrongly "succeeded" if some other process happened to already be serving latest.
          if (postFlightOk(body, upgradeTarget)) { ok = true; break; }
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!ok) {
        phases.push({
          name: "post-flight", status: "fail",
          message: `health did not return auth.ok=true AND version=${upgradeTarget} within 10s`
            + (lastSeen ? ` (last saw version=${lastSeen} — a stale process may still hold the port; check \`ss -ltnp\` / \`lsof -i\`)` : ""),
        });
        throw new Error("post-flight failed");
      }
      execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/v1/models > /dev/null`);
      phases.push({ name: "post-flight", status: "ok" });
    } else {
      phases.push({ name: "post-flight", status: "skipped-mock" });
    }

    // Auto-GC old snapshots after successful upgrade (best-effort, never throws).
    try {
      const gc = gcSnapshots(homedir(), { keepCount: 5, keepDays: 30 });
      if (gc.removed.length > 0) {
        console.error(`[gc] removed ${gc.removed.length} old snapshots; kept ${gc.kept.length}`);
      }
    } catch (e) {
      console.error(`[gc] warn: snapshot GC failed: ${e.message}`);
    }

    // `target` (issue #257): the ACTUAL version this upgrade landed on — the validated --target
    // pin when one was given, doctor.latest_version otherwise. Observable/testable independent
    // of the real (non-mockExec) git/curl branches above, which this suite never exercises for
    // real (see this file's own test-features.mjs coverage note).
    return { path: "upgrade", executed: true, changed: true, snapshotPath, phases, target: upgradeTarget };
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

  if (opts.gc) {
    const result = gcSnapshots(homeDir, { dryRun: opts.dryRun });
    return { path: opts.dryRun ? "rollback-gc-dry-run" : "rollback-gc", ...result };
  }

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
  const rollbackPlatform = opts.mockPlatform || process.platform;
  const rollbackPort = opts.mockPort || process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
  let restartPlan;
  try {
    restartPlan = resolveRestartPlan({ opts, port: rollbackPort, isRollback: true, fromCommit: meta.fromCommit });
  } catch (err) {
    phases.push({ name: "restart", status: "fail", stderr: err.message });
    throw Object.assign(
      new Error(`rollback phase restart failed: ${err.message}`),
      { phases, target: target.path }
    );
  }

  // MED-8 (PR #221 review): the just-restored ~/.config/systemd/user/ocp-proxy.service is a
  // unit-FILE change, not just an EnvironmentFile edit — systemd caches the parsed unit
  // definition and does not pick up file content changes on `restart` alone. This exact
  // requirement is documented at docs/runbooks/tui-flip-rollback.md:13 and already followed
  // by setup.mjs (which calls the same command right after writing this same file).
  //
  // MED-E (PR #221 round-2 review): this used to run UNCONDITIONALLY on every non-darwin
  // rollback, BEFORE resolution — even when the resolved owner turned out to be a system unit
  // (whose config this daemon-reload has nothing to do with, and where the very next step
  // refuses anyway) and even as a hard failure that could abort the whole rollback. `systemctl
  // --user` needs a running user manager + XDG_RUNTIME_DIR, which a root or non-login-session
  // rollback (the #215 host's own shape) may not have — it died here with "rollback phase
  // daemon-reload failed" before ever reaching the informative refusal the operator actually
  // needed to see. Now: gated on actually being about to restart the USER-scope unit rollback
  // restores (the only case this command is even relevant to), computed AFTER resolution so it
  // never runs ahead of a refusal, and best-effort (a failure here is logged and the restart
  // attempt still proceeds — losing the "picks up the freshly-restored unit file" guarantee is
  // strictly better than aborting a rollback over it).
  if (restartPlan.plan.action === "user-unit" && rollbackPlatform !== "darwin") {
    // Same opts.run seam as resolveRestartPlan's own gathering code (mockExec-without-run is
    // "skip everything, this is a bookkeeping-only test"; an explicit opts.run means a test
    // wants to drive THIS specific command end to end without touching git/npm/the real
    // restart too — matching the convention MED-6 established rather than adding a third,
    // narrower mock flag).
    if (opts.mockExec && !opts.run) {
      phases.push({ name: "daemon-reload", cmd: "systemctl --user daemon-reload", status: "skipped-mock" });
    } else {
      const run = opts.run || execRun;
      try {
        run(`systemctl --user daemon-reload`);
        phases.push({ name: "daemon-reload", cmd: "systemctl --user daemon-reload", status: "ok" });
      } catch (err) {
        const detail = err.stderr?.toString().trim() || err.message;
        phases.push({ name: "daemon-reload", cmd: "systemctl --user daemon-reload", status: "warn", stderr: detail });
        console.error(`[rollback] warn: daemon-reload failed (best-effort, continuing): ${detail}`);
      }
    }
  }

  for (const w of restartPlan.plan.warnings) {
    console.error(w);
    phases.push({ name: "restart-resolve", status: "warn", note: w });
  }
  for (const c of restartPlan.plan.cmds) exec(c.cmd, c.label);

  return { path: "rollback", executed: true, changed: true, target: target.path, phases };
}

// CLI entrypoint — use fileURLToPath + realpath to handle symlinked install paths.
function _isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}
if (_isMain()) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const rollback = args.includes("--rollback");
  const list = args.includes("--list");
  const gc = args.includes("--gc");
  const targetIdx = args.indexOf("--target");
  const target = targetIdx !== -1 ? args[targetIdx + 1] : undefined;
  // First non-flag positional after --rollback is the snapshot path
  let snapshotPath;
  if (rollback) {
    const rb = args.indexOf("--rollback");
    const cand = args[rb + 1];
    if (cand && !cand.startsWith("--")) snapshotPath = cand;
  }

  // Issue #214's "restart" path: bash's _cmd_update_restart() calls `cmd_restart` itself
  // (richer fallback logic than belongs here) and then shells out to THIS one-shot mode to
  // verify the restart actually took, reusing postFlightOk() instead of a second predicate.
  // Distinct from the runUpgrade() flow below — no doctor call, no plan, just poll + exit code.
  const postFlightOnlyIdx = args.indexOf("--post-flight-only");
  if (postFlightOnlyIdx !== -1) {
    const postFlightTarget = args[postFlightOnlyIdx + 1];
    // Fail CLOSED on a missing/malformed target (PR #217 review, LOW): postFlightOk() treats
    // an empty/unknown target as "degrade to the auth-only check" by design (so a genuinely
    // unknown release target never blocks a good upgrade elsewhere) — but that same degrade
    // means an accidentally-omitted target here would report success against ANY version.
    // `ocp`'s bash caller always passes "v$target" explicitly, so this only guards a
    // hand-invoked or future misuse of the public flag, not anything reachable today.
    if (!postFlightTarget || postFlightTarget.startsWith("--")) {
      console.error(`✗ --post-flight-only requires a target version argument, e.g. --post-flight-only v3.26.0`);
      process.exit(1);
    }
    const result = await runPostFlightCheck(postFlightTarget);
    if (result.ok) {
      console.log(`✓ service now serving v${result.target}`);
      process.exit(0);
    } else {
      console.error(`✗ service did not reach v${result.target} within the post-flight budget`
        + (result.lastSeen ? ` (last saw version=${result.lastSeen} — a stale process may still hold the port; check \`ss -ltnp\` / \`lsof -i\`)` : " (unreachable)"));
      process.exit(1);
    }
  }

  // Issue #224: bash's cmd_restart() (ocp's restart phase — used directly by `ocp restart` and,
  // via _cmd_update_light/_cmd_update_restart, by BOTH `ocp update` paths) used to hard-code a
  // restart cascade with ZERO unit resolution — the exact defect class issue #215 reported,
  // still live on this path even after PR #221 fixed the two scripts/upgrade.mjs call sites
  // above (runFullUpgrade / runRollback) that already use resolveRestartPlan(). Per #224's own
  // recommended design, `cmd_restart` shells out to THIS one-shot mode instead of reimplementing
  // cgroup/ss parsing a second time in bash — there is ONE resolution implementation
  // (scripts/lib/restart-unit.mjs's resolveOwningUnit()/planRestart(), wired through
  // resolveRestartPlan() above), not two that can drift.
  //
  // Contract: on success, print the resolved restart command(s) to stdout, one per line, and
  // exit 0 — bash runs them verbatim. On failure (ambiguous owner, no-unit, nothing listening,
  // an unauthorized system-unit restart, etc.), print the actionable refusal message to stderr
  // and exit non-zero — bash surfaces it and refuses, never falling through to a guess. Neither
  // --dry-run nor --yes apply here: this mode never mutates anything itself, it only resolves
  // and reports what WOULD run.
  const resolveRestartIdx = args.indexOf("--resolve-restart");
  if (resolveRestartIdx !== -1) {
    const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
    try {
      const { plan } = resolveRestartPlan({ opts: {}, port });
      for (const w of plan.warnings) console.error(w);
      for (const c of plan.cmds) console.log(c.cmd);
      process.exit(0);
    } catch (err) {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    }
  }

  try {
    const result = await runUpgrade({ dryRun, yes, rollback, list, gc, snapshotPath, target });
    if (result.plan) for (const line of result.plan) console.log(line);
    if (result.phases) for (const p of result.phases) console.log(`[${p.name}] ${p.status}${p.cmd ? `: ${p.cmd}` : ""}`);
    if (result.steps) for (const s of result.steps) console.log(`  ${s.status === "ok" ? "✓" : s.status === "skipped-mock" ? "·" : "✗"} ${s.cmd}`);
    if (result.snapshots) {
      console.log(`Found ${result.snapshots.length} snapshots:`);
      for (const s of result.snapshots) console.log(`  ${s.name}`);
    }
    if (result.removed && result.kept) {
      console.log(`Snapshots: kept ${result.kept.length}, ${result.dryRun ? "would remove" : "removed"} ${result.removed.length}`);
      for (const s of result.removed) console.log(`  - ${s.name}`);
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
