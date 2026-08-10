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
 *   fresh_install from-version < v3.4.0 (both --fresh-install AND --yes required, explicit --
 *                 issue #227: this path has never been execution-verified, so it is no longer
 *                 reachable off a bare --yes -- see runFreshInstall() below)
 *   rollback      restore from snapshot
 */
import { runDoctor, detectMultiUnitBootRace } from "./doctor.mjs";
import { resolveInstallDir, classifyInstallDir } from "./lib/install-dir.mjs";
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

// Issue #347: attempts per restart command. Same number `ocp`'s `_restart_exec_retry` is called
// with at ocp:1026 — the two `ocp update` paths must not disagree about how hard they try.
export const RESTART_ATTEMPTS = 3;

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
// only the no-override default changed.
//
// Issue #348 update: runFullUpgrade/runRollback no longer use `join(homedir(), "ocp")` either —
// they now call scripts/lib/install-dir.mjs's resolveInstallDir(), for the same reason stated
// above. This function deliberately does NOT call it: resolveInstallDir honors $OCP_DIR, and
// an override must never be able to answer "which tree is this process running from" — a wrong
// $OCP_DIR would then silently SUPPRESS the mismatch warning this function exists to raise
// instead of tripping it. The two questions look identical and are not.
//
// realpath'd where possible so a symlinked install dir
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
// Issue #290: probe BOTH launchd domains, not just `gui`. `ocp` installs a per-user LaunchAgent,
// so `gui/<uid>` is the common case — but a root LaunchDaemon is a supported deployment
// (scripts/doctor.mjs's own multi-unit-risk check looks for /Library/LaunchDaemons), and probing
// only `gui` made that shape a PERMANENT dead end: the label genuinely is not registered in `gui`,
// so the probe returned the "not-registered" sentinel, resolveOwningUnit reported no-unit, and the
// operator was told to bring up a service that was already running. Fail-closed and loud, but on a
// false premise.
//
// Extracted as a pure function over an injected `run` for the same reason classifyLaunchdJob and
// classifyCmdlineOwner are: the escalation RULE is the whole content of this fix, and a rule that
// can only be exercised through a full runUpgrade is a rule nobody can pin.
//
// The rule: escalate on the SPECIFIC "" signal — "gui says this label is not registered here" —
// and NEVER on `null`. `null` means the gui probe could not tell (launchctl missing, permission
// failure, an unrecognised error), and re-asking a different domain would convert an honest
// "unknown" into a confident claim about a domain we have no evidence for. That is exactly the
// distinction mapLaunchctlPrintFailureToProbeValue exists to preserve; spending it here would undo
// it. Returns `{ launchdPrintOutput, launchdDomain }`.
export function probeLaunchdDomains(run, expectedUnit) {
  let out, domain = "gui";
  try { out = run(`launchctl print gui/$(id -u)/${expectedUnit}`); }
  catch (err) { out = mapLaunchctlPrintFailureToProbeValue(err).launchdPrintOutput; }
  if (out === "") {
    let sys;
    try { sys = run(`launchctl print system/${expectedUnit}`); }
    catch (err) { sys = mapLaunchctlPrintFailureToProbeValue(err).launchdPrintOutput; }
    // "" from system too means the label is in neither domain — keep the gui answer and stay in the
    // `gui` domain, which is the right remediation target for "it isn't installed". A `null` IS
    // news: gui said not-here and system could not tell, so a system daemon cannot be ruled out,
    // and "unknown" is the honest verdict rather than "no-unit".
    if (sys !== "") { out = sys; domain = "system"; }
  }
  return { launchdPrintOutput: out, launchdDomain: domain };
}

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
        const probed = probeLaunchdDomains(run, expectedUnit);
        probe.launchdPrintOutput = probed.launchdPrintOutput;
        probe.launchdDomain = probed.launchdDomain;
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
// can serve AND is actually serving the TARGET version. The serving check alone is not enough:
// a stale process holding the port answers healthy while still running the OLD code — exactly
// what a nohup-fallback orphan did on 2026-07-17 (upgrade "succeeded", /health kept serving
// 3.21.1). Comparing /health.version to the checkout target catches orphan-holds-port,
// restart-didn't-take, and wrong-unit-restarted alike. `target` tolerates a leading "v"
// (doctor reports "v3.22.1"; /health reports "3.22.1"); an empty/unknown target degrades to
// the serving check alone rather than blocking an otherwise-good upgrade.
//
// The serving check reads `status`, NOT `auth.ok` (issue #289). ADR 0010 built `status` to
// answer exactly one question — "can this proxy serve?" — and that is precisely the question
// post-flight asks about the process now holding the port.
//
// Why `auth.ok === true` (the pre-#289 predicate) was wrong here. ADR 0010 classifies a probe
// that dies on a signal (its own timeout) or fails to spawn as INCONCLUSIVE, and an
// inconclusive probe preserves the last CONCLUSIVE verdict rather than recording one. But
// post-flight only ever runs against a process that was JUST restarted (ADR 0010 § "Downstream:
// `ocp update`'s post-flight check"), which has no last conclusive verdict — so on the loaded
// host ADR 0010 was written about, the first probe times out and `auth.ok` sits at `null` for a
// full CLAUDE_AUTH_CHECK_INTERVAL_MS (default 10 minutes) with no accelerated re-probe, while
// this predicate's retry budget is 10 × 1s. `null !== true`, so a SUCCESSFUL restart, update or
// rollback reported failure, and `runRollback` threw "restored tree may not be what's running"
// about a rollback that had worked. `status` has no such gap: it is recomputed on every request,
// and ADR 0010 deliberately does not let an inconclusive probe move it.
//
// This is not simply a weaker check. It is stronger in one direction and weaker in another,
// both deliberately:
//   - STRONGER: `status` is `degraded` when the `claude` binary is not executable, a real
//     serving precondition that `auth.ok` misses entirely (an unusable binary makes the probe
//     fail to spawn, which is INCONCLUSIVE, so a stale `auth.ok: true` survives it).
//   - WEAKER: a single conclusive rejection leaves `status` at "ok" (ADR 0010 degrades after
//     AUTH_DEGRADE_AFTER = 2). That is intended. ADR 0010 § "Why the threshold is 2" holds that
//     one rejection is a token-rotation race, not a condition — and post-flight, running against
//     a fresh process, sees exactly that first probe. On the UPDATE paths a genuine credential
//     outage is also caught before this point twice over: `runDoctor`'s FAIL on a conclusive
//     `auth.ok === false` clears `ready_to_upgrade` (the pre-flight guard below at "doctor
//     pre-flight"), and bash refuses `kind=fix_oauth` ahead of dispatch (`ocp` cmd_update).
//     Both key off `auth.ok`, which this change deliberately leaves FAILing, so neither gate
//     depends on the field being relaxed here.
//
//     ROLLBACK IS THE EXCEPTION, and it is deliberate rather than an oversight: `--rollback`
//     `exec`s straight past the doctor dispatch in `ocp` and returns from `runUpgrade`'s rollback
//     branch before the pre-flight guard ("no doctor needed; snapshot is authoritative"), because
//     rollback exists to restore a service that is already down — gating it on a health check it
//     is trying to repair would deadlock it. So on rollback, post-flight is the only check, and
//     what it must establish is that the RESTORED TREE is the one now serving: the version arm,
//     which this change does not touch. Credentials are out of scope there by construction.
//     Post-flight is not the layer that adjudicates credentials; it verifies a restart.
//
// Fail-closed by construction: a body with no `status` yields `undefined !== "ok"` → false, and
// an unreachable server never produces a body at all (the caller's try/catch retries). Verified
// present on /health continuously from v3.4.0 — doctor's `from_version_supported` floor — so
// rollback targets across the whole supported range still answer it.
// Parses `--flag value` and `--flag=value` into the same result, mirroring `ocp`'s own
// `_detect_target_flag` (which has handled both shapes since #272). Returns `seen` separately
// from `value` on purpose: "the flag was not typed" and "the flag was typed with nothing after
// it" are different situations, and collapsing them to `undefined` is what let a typed-but-empty
// pin be dropped in silence — the exact failure #260 exists to prevent. The first occurrence
// wins, matching the bash side's `break`.
//
// Only the two forms `ocp` itself documents are recognised. `--flagvalue` (no separator) is not
// a form of this flag and must not be treated as one: `--targetv3.27.0` is a typo, and silently
// honouring it would be a new way to pin something the user did not ask for.
export function parseFlagValue(args, flag) {
  const eq = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) return { seen: true, value: args[i + 1] };
    if (a.startsWith(eq)) return { seen: true, value: a.slice(eq.length) };
  }
  return { seen: false, value: undefined };
}

export function postFlightOk(body, target) {
  if (body?.status !== "ok") return false;
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
// Issue #291. The probe lane used to swallow every failure into one bare `catch { /* retry */ }`,
// so a missing curl (exit 127), a refused connection (curl 7), an HTTP error (curl 22 under -f), a
// timeout (curl 28) and a non-JSON body all produced the identical outcome — and the caller then
// reported "(unreachable)", a statement about the SERVICE, for a fault that may be entirely local.
// That is the exact conflation the #261 → #267 → #273 → #278 → #286 arc removed from sixteen bash
// sites, still present in the function those bash sites now DELEGATE their final verdict to
// (`_cmd_update_light` and `_cmd_update_restart` both report whatever `--post-flight-only` says).
//
// Severity is diagnosis-quality, not outcome-inverting: post-flight has already failed by the time
// this text is composed. What it changes is whether the operator is sent to debug a healthy
// service or their own environment.
//
// `SyntaxError` is checked FIRST and on its own: JSON.parse is the only thing here that throws it,
// and it carries no `.status`, so the exit-code arms below would otherwise misfile it as a network
// condition.
export function classifyPostFlightProbeFailure(e) {
  if (e instanceof SyntaxError) {
    return { kind: "unparseable", detail: "/health responded but the body is not JSON" };
  }
  const status = e?.status;
  const text = String(e?.stderr || e?.message || "").trim();
  const first = text.split("\n")[0];
  // Same predicate as `ocp`'s `_curl_is_local_fault` and classifyBindCheck's could-not-run arm:
  // 127/126 are bash's own reserved codes (curl never produces them), and dash phrases a missing
  // command as "not found" without the word "command" at all.
  if (status === 127 || status === 126
      || /\bnot found\b|no such file or directory|permission denied|enoent/i.test(text)) {
    return { kind: "probe-could-not-run", detail: first || `exit ${status ?? "unknown"}` };
  }
  if (status === 22) return { kind: "http-error", detail: first || "curl exit 22 (server returned a non-2xx status)" };
  if (status === 28) return { kind: "timeout", detail: first || "curl exit 28 (operation timed out)" };
  if (status === 7) return { kind: "unreachable", detail: first || "curl exit 7 (failed to connect)" };
  return { kind: "unreachable", detail: first || (status != null ? `curl exit ${status}` : "unknown probe failure") };
}

// The operator-facing rendering of a post-flight failure. Exported and kept separate from the
// classifier so the text a real `ocp update` prints is assertable without a subprocess — #291's
// coverage note applies to the message every bit as much as to the classification, since the
// message is the entire deliverable of this fix.
//
// The `lastSeen` branch is deliberately byte-identical to the pre-#291 text: when a body WAS read,
// the old message was already correct and specific, and changing it would be churn.
// #347 review finding G1. The ONE invocation that actually accepts `--post-flight-only`.
//
// Both message sites used to say `ocp update --post-flight-only vX.Y.Z`. That flag does not exist
// on the bash CLI: `cmd_update` matches `--check` and `--rollback` and nothing else, so the flag is
// silently ignored and `ocp update …` runs a FULL UPDATE DISPATCH instead — on a host whose state
// is, by construction at both of these call sites, already unknown. An arm whose entire job is
// naming the right next action was naming one that does something else.
//
// Fixed by naming the invocation rather than teaching `cmd_update` a new flag. That alternative is
// a real option, but it adds user-facing CLI surface (a new accepted flag, its exit-code
// pass-through, its interaction with `--target`, a README entry per the release_kit overlay) and
// belongs in its own reviewable unit; this is a wrong-advice bug in a string, and the string is in
// this file. The form below is exactly what `ocp` itself already invokes at ocp:1629 and ocp:1684.
//
// Path comes from `import.meta.url`, never a hardcoded `~/ocp`: this module always lives at
// `<ocpDir>/scripts/upgrade.mjs`, and issue #348 is specifically about installs that are not under
// `$HOME/ocp`, where a guessed path would send the operator to a file that does not exist.
export function postFlightOnlyCommand(target) {
  let self;
  try { self = fileURLToPath(import.meta.url); } catch { self = "scripts/upgrade.mjs"; }
  return `node ${self} --post-flight-only ${target}`;
}

export function postFlightFailureSuffix(result) {
  if (result?.lastSeen) {
    return ` (last saw version=${result.lastSeen} — a stale process may still hold the port; check \`ss -ltnp\` / \`lsof -i\`)`;
  }
  const f = result?.lastFailure;
  if (!f) return " (unreachable)";
  switch (f.kind) {
    case "probe-could-not-run":
      return ` — the post-flight probe could not run on THIS machine (${f.detail}).`
        + ` That is a local environment fault and says nothing about the service:`
        + ` the upgrade may well have succeeded. Fix the local curl, then re-check with`
        + ` \`${postFlightOnlyCommand(`v${result.target}`)}\`.`;
    case "unparseable":
      return ` — ${f.detail}. Something is answering on the port, but it is not this proxy.`;
    case "http-error":
      return ` — the service answered with a non-2xx status (${f.detail}).`;
    case "timeout":
      return ` — the probe timed out (${f.detail}); the service may be starting but not yet responsive.`;
    default:
      return ` (unreachable — ${f.detail})`;
  }
}

// Issue #347. The bounded-retry primitive for ONE resolved restart command, ported from `ocp`'s
// `_restart_exec_retry` (ocp:173, shipped by #325) so the two `ocp update` paths agree.
//
// Why this exists at all, in this file, fifteen minutes after #325: `ocp update` does NOT go
// through bash's `cmd_restart`. It goes through runFullUpgrade below, whose restart phase was
// `for (const c of restartPlan.plan.cmds) exec(c.cmd, c.label)` — one shot, and `exec` THROWS on
// failure. On macOS the resolved plan is `launchctl bootout …` then `launchctl bootstrap …`; on
// production the bootout succeeded, the bootstrap returned EIO ("5: Input/output error"), the
// throw skipped the post-flight probe entirely, and a healthy proxy was left stopped for 2–3
// minutes. The identical bootstrap succeeded by hand on the first attempt, unchanged plist,
// unchanged domain, unchanged user — the signature of a transient fault racing the bootout that
// had just completed, which is exactly the shape a short rising backoff absorbs.
//
// Deliberately NOT applied to `exec` generally: a failing `git checkout` or `npm install` is not
// transient and must still fail fast on the first attempt. The retry is scoped to the restart
// commands, at their one call site, for the same reason #325 scoped it to `cmd_restart`'s loop.
//
// Returns a verdict instead of throwing — the caller has to keep going after a failure (to attempt
// restoration and then MEASURE), and a throw here would reintroduce the defect in a louder form.
// Same reasoning as `_restart_exec_retry`'s `|| rc=$?` under `set -euo pipefail`.
export async function execRestartRetry(cmd, {
  attempts = RESTART_ATTEMPTS,
  backoffMs = 1000,
  run,
  log = (m) => console.error(m),
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let detail = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      run(cmd);
      return { ok: true, attempts: i, detail: null };
    } catch (err) {
      detail = err?.stderr?.toString().trim() || err?.message || String(err);
      if (i < attempts) {
        // The delay is stated from the value actually used, not hard-coded as `${i}s` the way
        // `_restart_exec_retry` can afford to (its `sleep $i` is literally i seconds). Here the
        // backoff is a parameter, and a message that says "1s" while sleeping 0 is a small lie in
        // exactly the place an operator reads to judge how long the command has been trying.
        const delayMs = i * backoffMs;
        log(`    attempt ${i}/${attempts} failed (${detail}) — retrying in ${delayMs / 1000}s`);
        await sleep(delayMs);
      } else {
        log(`    attempt ${i}/${attempts} failed (${detail}) — giving up on this command`);
      }
    }
  }
  return { ok: false, attempts, detail };
}

// #347 review finding F5. The operator-facing recovery command list: what to run by hand to bring
// the service back. Every "the proxy may be down, run this" hint goes through here so they cannot
// drift apart from each other or from the restore pass.
//
// Why this is not simply `plan.cmds`: THIS PR is what creates the exposure. Before it, a failed
// restart ran the resolved command ONCE. Now it can run up to four times in about five seconds
// (attempts at t=0, t=1, t=3 under the rising backoff, plus the restoration pass at t=5), and on
// Linux every one of those is a `systemctl … restart`, which systemd counts as a start.
//
// The arithmetic, since it decides whether a hint is enough. `scripts/lib/install-autostart.mjs`
// writes `Restart=always` + `RestartSec=5` and sets NO `StartLimitIntervalSec`/`StartLimitBurst`,
// so systemd's defaults apply: 5 starts per 10 s. Our own four invocations stay under that on
// their own. They do not stay under it in the scenario that actually gets here — a unit that
// starts and immediately exits is why `systemctl restart` is failing in the first place, and
// `Restart=always` then schedules systemd's OWN restarts into the same 10 s window. Four of ours
// plus one or two of systemd's reaches or exceeds the burst.
//
// So spacing our attempts is NOT a sufficient fix, and that is why this takes the other route the
// review offered: systemd's contribution is not ours to schedule, and stretching the failure path
// past 10 s would slow the fleet-rollout command's worst case for a guarantee it still could not
// give. What matters is the END STATE. When the limit trips the unit latches `failed` with "start
// request repeated too quickly", and a plain `systemctl restart` KEEPS FAILING until the latch is
// cleared — which would make the hint's own re-run command fail, a worse outcome than the bug this
// PR fixes. `reset-failed` clears it, so the recovery command list leads with it.
//
// Derived by rewriting the plan's own command rather than re-deriving the unit name, the `--user`
// scope and the `sudo` prefix: every systemd shape planRestart emits contains ` restart -- `
// (restart-unit.mjs:993, :1094, :1106, :1113), so this inherits all three exactly. Launchd plans
// carry no such substring and are additionally excluded by the `action` guard — `launchctl` has no
// start limit and no equivalent command.
export function recoveryPlanCommands(restartPlan) {
  const cmds = (restartPlan?.plan?.cmds || []).map(c => c.cmd);
  const action = restartPlan?.plan?.action;
  if (action !== "user-unit" && action !== "system-unit") return cmds;
  const restartCmd = cmds.find(c => c.includes(" restart -- "));
  if (!restartCmd) return cmds;
  // #347 review finding G2: `|| true`, because the caller joins this list with " && ".
  //
  // Without it, a `reset-failed` that exits non-zero SUPPRESSES the restart behind it — which is
  // F5's own failure mode arriving one command earlier: the thing added to un-wedge a stuck unit
  // would itself prevent the recovery. And it genuinely can exit non-zero (no such unit under this
  // scope, no running user manager / missing XDG_RUNTIME_DIR — the same conditions runRollback's
  // MED-E note already documents for `systemctl --user daemon-reload`).
  //
  // Deliberately different from the rest of the chain, and that is the point: the launchd pair IS
  // sequential — `bootstrap` should not run if `bootout` genuinely failed — so " && " stays right
  // for it. This one command is best-effort housekeeping ahead of the real action. Written as a
  // suffix on the command rather than as a special separator in the join, so a future edit to the
  // joining code cannot silently drop it. Precedence is safe: `A || true && B` parses as
  // `(A || true) && B`, and `(A || true)` always succeeds, so B always runs. Same `|| true` idiom
  // the repo already uses on the resolved bootout (scripts/lib/restart-unit.mjs:865).
  return [`${restartCmd.replace(" restart -- ", " reset-failed -- ")} || true`, ...cmds];
}

export async function runPostFlightCheck(target, opts = {}) {
  const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
  const attempts = opts.attempts ?? 10;
  const intervalMs = opts.intervalMs ?? 1000;
  // #291 coverage note, from the issue: every existing test drives `opts.mockProbe`, and the lane
  // that actually ships is the execSync one — so a fix verified only through mockProbe would be
  // verified on the lane that was never broken. `opts.execFn` makes the REAL lane drivable,
  // mirroring classifyBindCheck's own injection convention in scripts/lib/start-sh.mjs.
  const execFn = opts.execFn || execSync;
  const probe = opts.mockProbe || (() => {
    const out = execFn(`curl -sf --max-time 2 http://127.0.0.1:${port}/health`,
      { stdio: ["ignore", "pipe", "pipe"] }).toString();
    return JSON.parse(out);
  });
  let ok = false, lastSeen = null, lastFailure = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const body = probe();
      lastSeen = body.version;
      if (postFlightOk(body, target)) { ok = true; lastFailure = null; break; }
      // Reached the service and read a version, it is just not the one we are waiting for. That
      // is a different thing from not reaching it, and the caller can now say which.
      lastFailure = { kind: "version-mismatch", detail: `serving ${body?.version ?? "unknown"}` };
    } catch (e) {
      lastFailure = classifyPostFlightProbeFailure(e);
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, intervalMs));
  }
  return { ok, lastSeen, target: String(target || "").replace(/^v/, ""), lastFailure };
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
  // Issue #348 review round-2 MEDIUM-A: this was a bare `runDoctor()`, while runFullUpgrade,
  // runRollback and runFreshInstall all resolve their directory through
  // `resolveInstallDir(opts)`. Whenever opts.ocpDir was set the two disagreed -- doctor
  // describing one tree while the phase that mutates disk operated on another. That is the
  // same defect class this whole issue is about, one function apart, and it survived the first
  // revision because opts.ocpDir is dead in production so nothing ever diverged in practice.
  //
  // Forwarded deliberately narrowly rather than passing `opts` wholesale: these are the two
  // options that decide WHICH tree and host doctor is describing. runUpgrade's other opts
  // (`run`, `mockPlatform`, `mockExec`, `target`, ...) are about restart resolution and
  // execution, and several are names doctor ALSO reads for unrelated purposes -- handing it
  // the whole bag would silently repoint doctor's multi-unit probe at the restart tests' fake
  // command runner. Undefined values are inert: resolveInstallDir falls through to $OCP_DIR
  // and then its own file location exactly as before.
  const doctor = opts.mockDoctor || await runDoctor({ ocpDir: opts.ocpDir, skipNetwork: opts.skipNetwork });
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
      // Issue #348 review HIGH-2, follow-through: once the deletion guard can withhold the
      // plan, ai_executable[] is empty for a refused target -- and this loop then printed a
      // header with nothing under it. That is the exact invisible-failure shape this whole
      // issue is about, on the one command an operator runs specifically to find out what
      // WOULD happen. doctor puts the reason in human_required[]; print that instead.
      if (doctor.next_action.ai_executable.length === 0) {
        plan.push(`[plan] fresh-install: REFUSED -- no automated steps will be generated:`);
        const why = doctor.next_action.human_required || [];
        if (why.length === 0) plan.push(`  ! (no reason supplied by doctor -- run \`ocp doctor\` directly)`);
        for (const line of why) plan.push(`  ! ${line}`);
      } else {
        plan.push(`[plan] fresh-install ai_executable[]:`);
        for (const cmd of doctor.next_action.ai_executable) plan.push(`  - ${cmd}`);
      }
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
  // Issue #347 test seam. `opts.execFn(cmd)` — string in, throws on nonzero exit — replaces the
  // real `execSync` for every shell-form command this function runs. It exists because the ONE
  // seam this function had (`opts.mockExec`) makes `exec` a total no-op: under it no command can
  // FAIL, so the retry/restore behaviour this issue is about was unreachable from a test. It
  // follows the convention already established for `opts.run` (resolveRestartPlan's gathering) and
  // `opts.mockProbe` (runRollback's post-flight): plain `mockExec` with no injected function stays
  // bookkeeping-only and every pre-existing all-mock test is untouched; an explicit injection means
  // a test wants to drive this specific lane end to end.
  //
  // This is also what makes the #347 tests INCAPABLE of touching a real service rather than merely
  // unlikely to (AGENTS.md § "Constraints must be unreachable by construction"): the injected
  // runner is a plain JavaScript function, so no `launchctl`/`systemctl` string is ever handed to a
  // shell — not "the stub happens to intercept it", but no shell in the call path at all. In
  // production `opts.execFn` is undefined and this is the same `execSync` call as before.
  //
  // Name collision, deliberate and deliberately NOT forwarded: `runPostFlightCheck` has its own
  // `opts.execFn` (the execSync behind the post-flight curl, #291). Same conventional name for the
  // same kind of seam, but a different lane — this one answers "did the phase command succeed",
  // that one has to return a parseable /health body. The `runPostFlightCheck` call below passes
  // `opts.mockProbe` and never `opts.execFn`, because handing a runner that returns "" to the
  // probe would make every post-flight fail on a JSON parse.
  const runShell = opts.execFn || ((cmd) => execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString());
  const exec = (cmd, label) => {
    if (opts.mockExec && !opts.execFn) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    try {
      const out = runShell(cmd);
      phases.push({ name: label, cmd, status: "ok" });
      return out ?? "";
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
  // Issue #348: this is the git-checkout / npm-install / setup.mjs target — the directory this
  // function MUTATES. `join(homedir(), "ocp")` here meant a /opt/ocp install would have had its
  // upgrade applied to whatever happened to sit at $HOME/ocp (or, under sudo, /root/ocp — a
  // path that does not exist, so every phase would have failed). Resolved from this
  // installation's own files instead; see scripts/lib/install-dir.mjs.
  const { dir: ocpDir } = resolveInstallDir(opts);
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
    // Issue #347. This loop used to be `for (const c of restartPlan.plan.cmds) exec(c.cmd, c.label)`
    // — and `exec` throws, so the FIRST failing command aborted the function with the tear-down
    // half of the plan already executed and the post-flight probe below never reached. Three
    // changes, in the order they matter:
    //
    //   1. Each restart command gets `execRestartRetry` (see its own comment above) instead of one
    //      shot. Only the restart commands: phases 3 and 4 still use plain `exec` and still fail
    //      fast, because a broken checkout or a broken `npm install` is not a transient fault.
    //   2. A failure no longer throws. It records the failure and falls through, because the stop
    //      half of a stop/start pair has already run and the operator's actual question is "is the
    //      service up?", which a subcommand's exit status cannot answer. Same conclusion #325
    //      reached for `cmd_restart` (ocp:1029-1037).
    //   3. Before giving up, the commands from the failure point onward are re-run once, after a
    //      settle delay, as an explicit `restart-restore` phase. Those are the commands that would
    //      have brought the service back up; running them is the difference between reporting a
    //      down service and repairing one. It is bounded (one pass, no recursion) and safe to
    //      repeat: the plan's commands are the same idempotent bootout/bootstrap or `systemctl
    //      restart` pair the operator would run by hand, which is precisely what fixed the
    //      incident.
    const restartAttempts = opts.restartAttempts ?? RESTART_ATTEMPTS;
    const restartBackoffMs = opts.restartBackoffMs ?? 1000;
    const restartCmds = restartPlan.plan.cmds;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    let restartFailure = null;
    let restoreOutcome = null;

    if (opts.mockExec && !opts.execFn) {
      for (const c of restartCmds) phases.push({ name: c.label, cmd: c.cmd, status: "skipped-mock" });
    } else {
      for (let i = 0; i < restartCmds.length; i++) {
        const c = restartCmds[i];
        const r = await execRestartRetry(c.cmd, { attempts: restartAttempts, backoffMs: restartBackoffMs, run: runShell });
        phases.push({
          name: c.label, cmd: c.cmd, status: r.ok ? "ok" : "fail",
          attempts: r.attempts, ...(r.ok ? {} : { stderr: r.detail }),
        });
        if (!r.ok) { restartFailure = { index: i, cmd: c.cmd, detail: r.detail, attempts: r.attempts }; break; }
      }
    }

    if (restartFailure) {
      console.error(`[restart] "${restartFailure.cmd}" failed ${restartFailure.attempts} times: ${restartFailure.detail}`);
      console.error(`[restart] the tear-down half of this restart has already run — the service may be DOWN right now.`);
      console.error(`[restart] attempting to bring it back before giving up...`);
      await sleep(opts.restartRestoreDelayMs ?? 2000);
      // #347 review finding F2: this used to be `.slice(restartFailure.index)` — the commands
      // from the failure point onward. On macOS that re-ran `bootstrap` ALONE, while the hint
      // below told the operator to run `bootout && bootstrap`. The restore was therefore weaker
      // than the recovery it prescribes, and weaker than what actually ended the real incident,
      // which was the full pair. Re-run the WHOLE plan so the two agree by construction.
      //
      // Why re-running the tear-down is the right trade. CORRECTED after review (#347 finding G3):
      // an earlier version of this comment justified it by `restart-unit.mjs:865`'s
      // `2>/dev/null || true`. That argument does not hold. **`|| true` bounds the tear-down's exit
      // CODE, not its EFFECT.** If a partially-completed bootstrap had left the job loaded, this
      // `.slice(0)` re-runs `bootout` against a LIVE service — something `.slice(index)` structurally
      // could not do. The `|| true` would hide the exit status of exactly that.
      //
      // The real reason: by the time this line runs, the set-up half has failed `restartAttempts`
      // times in a row after a tear-down that already succeeded, so the service is almost certainly
      // already down — there is, in practice, nothing live left to tear down. And in the residual
      // case where something IS still loaded, `bootout` then `bootstrap` is precisely the restart
      // the operator would perform by hand; it does not leave the service worse off, it leaves it
      // restarted. That is a judgement about likely state and bounded downside, not a guarantee,
      // and it is stated as one so the next reader does not check a premise, find it true, and
      // conclude a safety property holds that never followed from it.
      //
      // `|| true` still matters, for the narrower thing it actually does: it keeps a no-op bootout
      // against an already-unloaded job from being recorded as a failed restore step.
      //
      // Every other plan shape is a single `systemctl … restart --` command, for which
      // `.slice(0)` and `.slice(index)` are identical.
      const restoreCmds = restartCmds.slice(0);
      restoreOutcome = { ok: true, cmds: [] };
      for (const c of restoreCmds) {
        const r = await execRestartRetry(c.cmd, { attempts: 1, backoffMs: 0, run: runShell });
        phases.push({
          name: "restart-restore", cmd: c.cmd, status: r.ok ? "ok" : "fail",
          ...(r.ok ? {} : { stderr: r.detail }),
        });
        restoreOutcome.cmds.push(c.cmd);
        if (!r.ok) { restoreOutcome.ok = false; break; }
      }
      console.error(restoreOutcome.ok
        ? `[restart] restoration commands ran without error — the probe below decides whether that worked.`
        : `[restart] restoration ALSO failed. The probe below reports what is actually serving.`);
    }

    // phase 6: post-flight. Now runs UNCONDITIONALLY after the restart phase, including after a
    // failed restart command (#347: the old `throw` from `exec` meant the one measurement that
    // could have detected the downed service never happened). Delegates to runPostFlightCheck —
    // the same polling loop and the same postFlightOk() acceptance predicate this function used to
    // hand-roll — so the failure CLASSIFICATION (`lastFailure`, issue #291) comes along with it.
    // That classification is load-bearing below, not decoration: a machine that cannot run curl
    // must never be told its proxy is dead.
    //
    // Issue #257's requirement is unchanged and carried through: verify against `upgradeTarget`
    // (the validated pin when given), not doctor.latest_version.
    //
    // Gate matches runRollback's own post-flight (#274): `opts.mockProbe || !opts.mockExec` — a
    // plain all-mock test still records "skipped-mock" exactly as before.
    let postFlight = { ok: true, lastSeen: null, target: String(upgradeTarget || "").replace(/^v/, ""), lastFailure: null };
    let postFlightMeasured = false;
    if (opts.mockProbe || !opts.mockExec) {
      postFlightMeasured = true;
      postFlight = await runPostFlightCheck(upgradeTarget, {
        mockProbe: opts.mockProbe,
        attempts: opts.postFlightAttempts,
        intervalMs: opts.postFlightIntervalMs,
      });
      phases.push({
        name: "post-flight", status: postFlight.ok ? "ok" : "fail",
        ...(postFlight.ok ? {} : {
          // Wording matches runRollback's sibling phase verbatim; the budget is a parameter now, so
          // the old hard-coded "within 10s" would be a claim this function no longer guarantees.
          message: `health did not return status=ok AND version=${upgradeTarget} within the post-flight budget`
            + postFlightFailureSuffix(postFlight),
        }),
      });
    } else {
      phases.push({ name: "post-flight", status: "skipped-mock" });
    }

    // The four outcome cells, mirroring `ocp`'s cmd_restart (ocp:1051-1127) so the two paths tell
    // the operator the same story. The ordering is the load-bearing part: the local-fault arm is
    // checked FIRST, because it is also a non-ok probe, and getting this backwards would tell a
    // machine with a broken curl that its proxy is dead — asserting a state nobody measured.
    const probeCouldNotRun = postFlight.lastFailure?.kind === "probe-could-not-run";
    // F5: single source for "what to run by hand", shared by every hint below.
    const recoveryCmds = recoveryPlanCommands(restartPlan).join(" && ");

    if (restartFailure && !postFlightMeasured) {
      // Only reachable from a test that injects execFn but no probe. Never claim success when a
      // restart command failed and nothing measured the result.
      throw Object.assign(
        new Error(`phase restart failed: ${restartFailure.detail} — and post-flight did not run, so the service state is UNKNOWN`),
        { phases, cmd: restartFailure.cmd, snapshotPath,
          hint: `THE SERVICE STATE IS UNKNOWN. A restart command failed and nothing probed /health.` }
      );
    }

    if (restartFailure && !postFlight.ok && probeCouldNotRun) {
      throw Object.assign(
        new Error(`phase restart failed: ${restartFailure.detail} — and this machine could not run the /health probe (${postFlight.lastFailure.detail})`),
        { phases, cmd: restartFailure.cmd, snapshotPath,
          hint: `THE SERVICE STATE IS UNKNOWN, and it may be DOWN: the stop half of the restart already ran. `
            + `This machine could not run curl, so nothing here is evidence about the proxy either way. `
            + `Check it by hand (\`curl -sf http://127.0.0.1:${port}/health\` from a working shell); if it is down, `
            + `re-run: ${recoveryCmds}` }
      );
    }

    if (restartFailure && !postFlight.ok) {
      // The incident, named. Service state leads; tree state is demoted to the second sentence,
      // because "run `ocp update --rollback`" was the ONLY thing the old hint said and version
      // state was not what mattered at 2am with the port dead.
      throw Object.assign(
        new Error(`phase restart failed: ${restartFailure.detail}`),
        { phases, cmd: restartFailure.cmd, snapshotPath,
          hint: `THE PROXY IS DOWN. A restart command failed after ${restartFailure.attempts} attempts, `
            + `${restoreOutcome?.ok ? "the restoration attempt ran but did not bring it back" : "the restoration attempt also failed"}, `
            + `and /health is not answering on 127.0.0.1:${port}. This command stopped the service and could not start it again — `
            + `nothing will start it on its own. Bring it back with: ${recoveryCmds}  `
            + `Then, and only then, consider the working tree: it may be at the new version, and \`ocp update --rollback\` restores from the snapshot.` }
      );
    }

    // #347 review finding F1: the `commands OK + probe could not RUN` cell. `ocp` has it
    // (ocp:1063-1067); this function did not, so it fell through to the generic post-flight
    // failure below and the CLI headline became "Run `ocp update --rollback`" — telling a host
    // whose CURL is broken to roll back an upgrade that may well have succeeded. That is the same
    // defect class #347 was filed for: the headline naming the wrong thing to do. The #291
    // classification was already correct in the phase message; only the headline contradicted it.
    //
    // Ordered after the restart-failure arms deliberately: those describe a service that may be
    // down, which outranks a broken probe. Reaching here means every restart command exited 0.
    if (!postFlight.ok && probeCouldNotRun) {
      throw Object.assign(
        new Error(`post-flight could not run on this machine (${postFlight.lastFailure.detail})`),
        { phases, snapshotPath, target: upgradeTarget,
          hint: `THE UPGRADE MAY HAVE SUCCEEDED — do NOT roll back on this evidence. Every restart command `
            + `exited 0, and the post-flight probe could not RUN here (${postFlight.lastFailure.detail}). `
            + `That is a local environment fault and says nothing about the service. Check by hand from a `
            + `working shell (\`curl -sf http://127.0.0.1:${port}/health\`), or fix the local curl and re-check `
            + `with \`${postFlightOnlyCommand(upgradeTarget)}\`. Only if the service is genuinely not `
            + `serving ${upgradeTarget} is \`ocp update --rollback\` the right move.` }
      );
    }

    if (!postFlight.ok) {
      // Restart commands all succeeded and the probe genuinely ran and said no (orphan holding the
      // port, wrong version serving, ...). Unchanged pre-#347 behaviour, including the generic
      // tree-state hint from the catch below, which is correct for this cell.
      throw new Error("post-flight failed");
    }

    if (restartFailure) {
      // A restart command failed and the proxy is nonetheless serving the right version. Not a
      // silent success: reporting a bare "✓" here trains operators to ignore the retry warnings
      // that are the early signal for the DOWN case above (same reasoning as ocp:1092-1099).
      phases.push({
        name: "restart", status: "warn",
        note: `"${restartFailure.cmd}" failed after ${restartFailure.attempts} attempts`
          + `${restoreOutcome?.ok ? " and the restoration pass brought the service back" : ""}; `
          + `post-flight confirms the service is UP and serving ${postFlight.target}. `
          + `Worth checking \`ocp doctor\` — this usually means the resolver's expected unit and the unit that actually owns the port have drifted apart.`,
      });
      console.error(`[restart] WARNING: a restart command failed after retries, but the service is UP and serving ${postFlight.target}. Run \`ocp doctor\`.`);
    }

    if (postFlightMeasured && !opts.mockProbe) {
      execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/v1/models > /dev/null`);
    }

    // Auto-GC old snapshots after successful upgrade (best-effort, never throws).
    //
    // Issue #347 (found while writing this issue's tests, reported in the PR body rather than left
    // silent): this is the ONE step on the success path that mutates real state — it `rmSync`es
    // directories under the REAL `homedir()` — and it was not gated on mockExec, so every all-mock
    // test that reaches a successful return has been running a real snapshot GC against whoever is
    // running `npm test`. It has not deleted anything to date only because gcSnapshots keeps
    // anything within `keepDays` (an OR, not an AND, with keepCount) and no developer has had a
    // >5-snapshot, >30-day-old collection. That is luck, not a constraint. Every other mutating
    // step in this function is already skipped under mockExec; this one now is too, which is what
    // makes the #347 tests below unable to touch real state rather than merely unlikely to.
    if (opts.mockExec) {
      phases.push({ name: "gc", status: "skipped-mock" });
    } else {
      try {
        const gc = gcSnapshots(homedir(), { keepCount: 5, keepDays: 30 });
        if (gc.removed.length > 0) {
          console.error(`[gc] removed ${gc.removed.length} old snapshots; kept ${gc.kept.length}`);
        }
      } catch (e) {
        console.error(`[gc] warn: snapshot GC failed: ${e.message}`);
      }
    }

    // `target` (issue #257): the ACTUAL version this upgrade landed on — the validated --target
    // pin when one was given, doctor.latest_version otherwise. Observable/testable independent
    // of the real (non-mockExec) git/curl branches above, which this suite never exercises for
    // real (see this file's own test-features.mjs coverage note).
    return { path: "upgrade", executed: true, changed: true, snapshotPath, phases, target: upgradeTarget };
  } catch (err) {
    // Issue #347: `hint` is now set at the throw site for the restart-failure cells, and that
    // hint leads with SERVICE state. This generic one is about TREE state — correct for a failed
    // checkout or a failed post-flight, and exactly the wrong headline when the proxy is down.
    // `err.hint ||` is what stops it overwriting the specific one; the `!err.snapshotPath` guard
    // above cannot be relied on for that, since a caller could set one without the other.
    if (snapshotPath && !err.snapshotPath) {
      Object.assign(err, {
        snapshotPath,
        phases,
        hint: err.hint || "Working tree may be at new version. Run `ocp update --rollback` to restore from snapshot."
      });
    }
    throw err;
  }
}

async function runFreshInstall({ doctor, opts }) {
  // Issue #227: doctor selecting kind="fresh_install" used to be enough, combined with the
  // SAME --yes flag every other non-interactive `ocp update` invocation already passes (see
  // `ocp update --yes` in `ocp`'s own help text, "AI agents pass this", and doctor.mjs's own
  // ai_executable suggestion for update/upgrade/restart -- `${ocpDir}/ocp update --yes`), to
  // run this arm's ai_executable[] for real: `mv ~/.ocp ...`, `rm -rf ${ocpDir}`, a fresh
  // `git clone`, and `node setup.mjs`. That chain has never been execution-verified -- not in
  // CI (this suite only ever reaches this function with opts.mockExec: true; see this file's
  // own test-features.mjs coverage) and not by hand -- since the arm was reconnected by #217.
  // A routine `ocp update --yes` run for an ordinary, well-tested upgrade must not silently
  // walk into this path just because doctor happened to classify the host as pre-v3.4.0; the
  // operator who wants THIS path has to say so, separately from the generic non-interactive
  // flag. `--fresh-install` is that separate, explicit opt-in -- both it and --yes are
  // required; --yes alone (the routine case) now refuses here instead of executing.
  // Issue #348 review, HIGH-1: this message used to hardcode `rm -rf ~/ocp`. That was true
  // while doctor's step was also hardcoded to $HOME/ocp; once doctor started building
  // `rm -rf ${ocpDir}` from the RESOLVED directory, the consent gate began naming a different
  // directory from the one that actually gets deleted -- on the /opt/ocp host this whole
  // change exists to serve, it would have said `~/ocp` and deleted `/opt/ocp`. The last thing
  // an operator reads before typing --fresh-install --yes must name the real target, so it is
  // interpolated from the same resolution doctor used, never restated as a constant.
  const { dir: freshDir, source: freshSource } = resolveInstallDir(opts);
  const freshTarget = classifyInstallDir(freshDir);

  // Issue #348 review, HIGH-2, and then round-2 MEDIUM-A which corrected this comment.
  //
  // WHAT THIS CHECK COVERS, exactly: the directory THIS FUNCTION resolves. It re-runs the
  // resolution and the classification itself instead of reading doctor's verdict out of the
  // JSON, so a resolution that lands on something unsafe is refused here even when the JSON
  // handed in says otherwise. That is a real, independent check and the "#348 HIGH-2 (defence
  // in depth)" test pins it: the fixture's mockDoctor asserts nothing about safety and the
  // refusal still fires.
  //
  // WHAT IT DOES NOT COVER, and the first revision of this comment wrongly implied it did:
  // the contents of ai_executable[]. Those strings are executed verbatim and are never
  // inspected. A caller that hands in a plan built for some OTHER directory gets that plan
  // run -- demonstrated by review with `mockDoctor: { ai_executable: ["rm -rf /etc/..."] }`,
  // which executed. Not production-reachable today (opts.mockDoctor is test-only and
  // opts.ocpDir is set by nothing in production; the `ocp` wrapper passes neither), but the
  // claim was false as written, and a comment promising protection is exactly where the next
  // maintainer stops looking.
  //
  // WHY IT IS NOT FIXED BY INSPECTING THE COMMANDS: ai_executable[] is arbitrary shell.
  // Deciding "this list cannot delete anything foreign" by pattern-matching its text is the
  // substring-denylist shape this repo has already had bypassed three times in one PR (#218,
  // recorded in AGENTS.md: "Guards on dynamic execution must bound capability, not scan text
  // ... Claiming 'this code cannot do X' while the implementation is 'its text doesn't contain
  // Y' is false"). A scan here would read as a stronger guarantee than the one above while
  // being weaker than it looks -- strictly worse than saying plainly what is checked.
  //
  // WHERE THE PROTECTION ACTUALLY LIVES: doctor is the only producer of ai_executable[] in
  // production, and it withholds every destructive step for an unsafe target (see its
  // fresh_install next_action). IF A SECOND PRODUCER IS EVER ADDED -- a new caller, an
  // imported plan, a --plan-file flag -- it does NOT inherit that, and this function will run
  // whatever it is given. Bounding a new producer is that change's job, not this one's.
  //
  // Checked BEFORE the --fresh-install/--yes gate below: a target this tool must not delete is
  // a refusal regardless of how much consent was given, and saying so first is more useful
  // than telling the operator to re-run with flags that will then also refuse.
  if (!freshTarget.safeToReplace) {
    throw new Error(
      `Refusing the fresh_install path: ${freshTarget.why}. The first destructive step would ` +
      `be \`rm -rf ${freshDir}\` (install dir resolved from ${freshSource}), and this tool only ` +
      `does that to a directory that is absent, empty, or verifiably an OCP install. ` +
      `If OCP is installed elsewhere, set an absolute OCP_DIR pointing at it; if you genuinely ` +
      `want this directory replaced, remove it yourself first, then re-run.`
    );
  }

  if (!opts.yes || !opts.freshInstall) {
    throw new Error(
      `doctor concluded kind="fresh_install" for this host (from-version is unsupported or ` +
      `unparseable -- run \`ocp doctor\` for the specific check). This path has never been ` +
      `execution-verified (issue #227): its ai_executable steps run \`rm -rf ${freshDir}\` ` +
      `(the resolved install dir, from ${freshSource}) and reinstall from scratch, and it is ` +
      `no longer reachable off a bare --yes. To proceed anyway, re-run with both flags: ` +
      `\`ocp update --fresh-install --yes\`. This is not a ` +
      `claim that the path is broken -- only that nobody has run it long enough to know either ` +
      `way; see docs/upgrading.md's "Old version (< v3.4.0)" section for what that means.`
    );
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

  // SECURITY (issue #262): meta.fromCommit is read back from from-commit.txt, written by
  // writeSnapshot() (scripts/lib/snapshot.mjs) from `git rev-parse HEAD`'s own output
  // (runFullUpgrade phase 2, below) -- never from a CLI flag or any other user-supplied string.
  // That is what makes interpolating it into a shell command safe TODAY, but the invariant was
  // written down nowhere and enforced by nothing: a hand-edited snapshot directory, a future
  // feature that lets an operator name/import a snapshot, or metadata restored from a backup
  // could all produce a value that is no longer a bare SHA. `git rev-parse HEAD` always prints
  // lowercase hex, 7 (short) to 40 (full) characters; anchored at both ends (matching the #257
  // precedent in `_targetSemverParts` for the same "validate before using in a command" shape)
  // so any value carrying anything else -- including shell metacharacters -- is refused before
  // it ever reaches a command, belt-and-braces alongside the execArgv conversion below.
  if (!/^[0-9a-f]{7,40}$/.test(meta.fromCommit)) {
    throw new Error(
      `snapshot ${target.path} has a malformed from-commit.txt (expected a git SHA, got: ${JSON.stringify(meta.fromCommit)})`
    );
  }

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

  // Issue #352 test seam, the same one #347 added to runFullUpgrade and for the same reason: the
  // ONE seam this function had (`opts.mockExec`) makes `exec` a total no-op, so under it no command
  // can FAIL and the retry/restore behaviour this issue is about was unreachable from a test.
  // `opts.execFn(cmd)` — string in, throws on nonzero exit — replaces the real `execSync` for every
  // shell-form command this function runs.
  //
  // This is part of what makes the #352 tests INCAPABLE of touching a real service rather than
  // merely unlikely to (AGENTS.md § "Constraints must be unreachable by construction") — but only
  // part, and the distinction is stated because an earlier draft of this comment got it wrong.
  // `execFn` covers exactly the lanes that route through `exec`/`execRestartRetry`: `npm install`
  // and every restart command, so no `launchctl`/`systemctl` restart string is handed to a shell —
  // not "the stub happens to intercept it", but no shell in the call path at all.
  //
  // It does NOT cover three other lanes, and `mockExec` is what holds those: the argv-form `git
  // checkout` (gated on plain `opts.mockExec` below), the `tryCopy` block that writes a real plist /
  // `~/.ocp/ocp.db` / `~/.ocp/admin-key`, and — the one the earlier draft missed — the MED-E
  // `systemctl --user daemon-reload`, which is a `systemctl` string gated on `opts.mockExec &&
  // !opts.run` and otherwise goes to the real `execRun`. Claiming "no systemctl string reaches a
  // shell" while that lane exists would have been the false-mechanism shape this repo has been
  // bitten by before. The test harness therefore pins `mockExec: true` structurally rather than
  // conventionally; see `_u352Opts` in test-features.mjs.
  //
  // In production `opts.execFn` is undefined and this is the same `execSync` call as before.
  //
  // Name collision, deliberate and deliberately NOT forwarded, identical to runFullUpgrade's own
  // note: `runPostFlightCheck` has its own `opts.execFn` (the execSync behind the post-flight curl,
  // #291). Same conventional name for the same kind of seam, different lane — this one answers "did
  // the phase command succeed", that one has to return a parseable /health body. The
  // `runPostFlightCheck` call below passes `opts.mockProbe` and never `opts.execFn`, because handing
  // a runner that returns "" to the probe would make every post-flight fail on a JSON parse.
  const runShell = opts.execFn || ((cmd) => execSync(cmd, { stdio: ["pipe", "pipe", "pipe"] }).toString());
  const exec = (cmd, label) => {
    if (opts.mockExec && !opts.execFn) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    try {
      runShell(cmd);
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
  // SECURITY (issue #262, matching the #259 pattern already used by runFullUpgrade's own
  // `execArgv` above): argv-form sibling of `exec`, for the one command in this function whose
  // argument is read back from disk rather than being a fixed string -- `meta.fromCommit`.
  // `execFileSync(file, args)` never invokes `/bin/sh`, so an argv element can never be
  // reinterpreted as shell syntax, regardless of its content. `cmd` (the human-readable display
  // string recorded into `phases`, matching every existing test's `.cmd.includes(...)`-style
  // assertions) is built via `.join(" ")` purely for bookkeeping/display -- it is NEVER itself
  // executed. Error/phase shape matches this function's own `exec` above (`{phases, target:
  // target.path}`), not runFullUpgrade's `execArgv` (`{phases, cmd}`) -- the two functions
  // already use different error shapes for their existing failure sites and this stays
  // consistent with runRollback's own convention rather than importing the sibling's.
  const execArgv = (file, args, label) => {
    const cmd = [file, ...args].join(" ");
    if (opts.mockExec) {
      phases.push({ name: label, cmd, status: "skipped-mock" });
      return "";
    }
    try {
      execFileSync(file, args, { stdio: ["pipe", "pipe", "pipe"] });
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

  // Issue #348: same as runFullUpgrade above — this is the directory rollback checks out into
  // and npm-installs, not a place to guess at. See scripts/lib/install-dir.mjs.
  const { dir: ocpDir } = resolveInstallDir(opts);
  // Issue #262: was `exec(\`git -C ${ocpDir} checkout ${meta.fromCommit}\`, "git-checkout")` --
  // a shell template string carrying a disk-read value. Now argv form; see execArgv above and
  // the SHA-shape validation above meta.fromCommit is first read.
  execArgv("git", ["-C", ocpDir, "checkout", meta.fromCommit], "git-checkout");

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
  // Issue #352. This was `for (const c of restartPlan.plan.cmds) exec(c.cmd, c.label)` — byte for
  // byte the one-shot loop #347 removed from runFullUpgrade, still here on the RECOVERY path: the
  // one `ocp update`'s own DOWN hint tells the operator to run when the forward path has already
  // failed. Same three changes as #347, plus one decision that is NOT a copy-paste (below):
  //
  //   1. Each restart command gets `execRestartRetry` instead of one shot. Only the restart
  //      commands: `git checkout`, `npm install` and the daemon-reload above are untouched, because
  //      a broken checkout or a broken install is not a transient fault.
  //   2. A failure no longer throws. `exec`'s throw did not merely lose the retry — it jumped past
  //      this function's OWN post-flight, the `runPostFlightCheck` call #274 added specifically so a
  //      rollback could not report success without confirming what is serving. On a restart-command
  //      failure that check was unreachable, so nothing measured whether the service came back and
  //      the operator was handed `rollback phase restart failed` — a statement about a command, on
  //      the one path where the only question is about the service.
  //   3. Before giving up, the whole plan is re-run once after a settle delay as a visible
  //      `restart-restore` phase.
  //
  // DOES A FAILED ROLLBACK AUTO-RESTORE? Yes — argued, not inherited. #347 restores on the forward
  // path with one stated reservation: re-running the tear-down could, in the residual case, hit a
  // service that is still live. Two reasons that reservation is outweighed HERE specifically:
  //   - It is the last automated step there is. The forward path can end by naming a next command
  //     (`ocp update --rollback`); this one has nothing after it, so declining to attempt the repair
  //     hands the operator a hint they have already followed once.
  //   - The commands bring up the OLD tree, already checked out and installed above. There is no
  //     "the wrong version came back up" hazard for the restore to reason about — the forward path
  //     does have one.
  // And it is bounded exactly as #347's is: one pass, no recursion.
  //
  // CORRECTED after independent review, because the first draft of this comment made the mistake
  // #347's own G3 correction (see `.slice(0)`, ~600 lines up) exists to prevent. It argued that
  // `resolveRestartPlan`'s `allowNotListeningFallback: isRollback` was a "code-level witness" that
  // the service is already down here, so the reservation could not bite. It is not. That flag
  // PERMITS the not-listening case; it does not establish it. `resolveRestartPlan` on a rollback
  // still reaches `owner.kind === "launchd"` and `"user-unit"` (restart-unit.mjs), and BOTH mean
  // something is listening — which is the ordinary rollback, a healthy service being reverted. On
  // that shape the tear-down re-run hits a live service with exactly the same force as on the
  // forward path. The two bullets above carry the decision; that sentence did not, and stating it
  // as a witness would have let the next reader check a true premise and conclude a safety property
  // that never followed from it.
  //
  // WHAT THE RESTORE PASS RUNS, and why it is NOT simply `restartCmds`. On the `user-unit` shape it
  // runs `recoveryPlanCommands(restartPlan)` — i.e. `systemctl --user reset-failed -- <unit> ||
  // true` ahead of the restart. Everything else runs the plan's own commands unchanged. This
  // diverges from #347's forward path deliberately, and the divergence was forced by the arithmetic
  // in `recoveryPlanCommands`'s own comment: this PR turns one restart into four in ~5s (t≈0,1,3,
  // plus this pass at ≈5), `install-autostart.mjs` writes `Restart=always`/`RestartSec=5` with no
  // `StartLimit*` override, and systemd's own restarts stack with ours into the same 10s window. If
  // the limit trips, the unit latches `failed` and a plain `systemctl restart` KEEPS FAILING. A
  // restoration pass that is the FOURTH such invocation is then, by that same argument, expected to
  // be a no-op — the repair would exist only in the printed hint. `reset-failed` is what makes the
  // executed pass able to do its job, and where the limit is not latched it is a harmless no-op.
  //
  // Scoped to `user-unit` rather than applied to every shape, and that boundary is load-bearing:
  //   - `launchd` — `recoveryPlanCommands` is a pass-through there (its own `action` guard), so the
  //     scoping changes nothing; launchctl has no start limit and no equivalent command.
  //   - `system-unit` — EXCLUDED, and this is the one that could hurt. There `recoveryPlanCommands`
  //     emits `sudo systemctl reset-failed -- <unit>`: a DIFFERENT sudo command from the `sudo
  //     systemctl restart -- <unit>` that planRestart verified with `sudo -n -l`, so a sudoers rule
  //     authorizing only the latter leaves this one prompting for a password — a hang, in a recovery
  //     path. Excluding it means no command this function EXECUTES can ever carry `sudo`, which is
  //     true by construction of the `user-unit` branch (planRestart emits no `sudo` on it) rather
  //     than by relying on `resolveRestartPlan`'s `isRollback && owner.kind === "system-unit"`
  //     refusal further up. That refusal does make `system-unit` unreachable here today — but it is
  //     a prohibition living in another function, and its shape has been revised twice already
  //     (MED-8, then MED-F, then #234 added a second identity-keyed refusal beside it), so it is not
  //     an invariant to hang an executed `sudo` on.
  // Both directions are pinned by test: the executed pass carries reset-failed on `user-unit`, and
  // no executed command anywhere carries `sudo`.
  const restartAttempts = opts.restartAttempts ?? RESTART_ATTEMPTS;
  const restartBackoffMs = opts.restartBackoffMs ?? 1000;
  const restartCmds = restartPlan.plan.cmds;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let restartFailure = null;
  let restoreOutcome = null;

  if (opts.mockExec && !opts.execFn) {
    for (const c of restartCmds) phases.push({ name: c.label, cmd: c.cmd, status: "skipped-mock" });
  } else {
    for (let i = 0; i < restartCmds.length; i++) {
      const c = restartCmds[i];
      const r = await execRestartRetry(c.cmd, { attempts: restartAttempts, backoffMs: restartBackoffMs, run: runShell });
      phases.push({
        name: c.label, cmd: c.cmd, status: r.ok ? "ok" : "fail",
        attempts: r.attempts, ...(r.ok ? {} : { stderr: r.detail }),
      });
      if (!r.ok) { restartFailure = { index: i, cmd: c.cmd, detail: r.detail, attempts: r.attempts }; break; }
    }
  }

  if (restartFailure) {
    console.error(`[rollback] "${restartFailure.cmd}" failed ${restartFailure.attempts} times: ${restartFailure.detail}`);
    // Only claim the tear-down ran when a tear-down actually ran. #347's line said this
    // unconditionally, and it is false in two reachable states: the failing command was index 0 (the
    // bootout itself — the loop breaks, so nothing was torn down), and every systemd shape is a
    // SINGLE `systemctl … restart` command with no separable tear-down half at all. The F5 test
    // exercises that second shape, so the unconditional wording printed there on every run.
    console.error(restartFailure.index > 0
      ? `[rollback] the tear-down half of this restart has already run — the service may be DOWN right now.`
      : `[rollback] the service may be DOWN right now.`);
    console.error(`[rollback] attempting to bring it back before giving up...`);
    await sleep(opts.restartRestoreDelayMs ?? 2000);
    // The WHOLE plan, matching #347's F2 finding: on macOS `.slice(restartFailure.index)` would
    // re-run `bootstrap` alone while the hint below prescribes `bootout && bootstrap`, making the
    // restore weaker than the recovery it recommends. Every non-launchd shape is a single command,
    // for which the two slices are identical anyway.
    //
    // On `user-unit` the pass runs `recoveryPlanCommands`' list instead, so the executed repair and
    // the printed one are the same commands — see the long note above for why that scoping is the
    // boundary, and why `system-unit` is deliberately not included.
    //
    // BEST-EFFORT MARKING, and why it is not left to the `|| true` the command already carries.
    // `recoveryPlanCommands` appends `|| true` to its `reset-failed` for #347's finding G2: joined
    // with " && " into a HINT, a non-zero reset-failed would suppress the restart behind it. That
    // suffix does its job only when something interprets it — true for `execSync`, which goes
    // through `/bin/sh`, and NOT true of the runner in general. Relying on it here would make the
    // executed pass's correctness depend on a shell being in the call path, and G2's own failure
    // mode — the un-wedge step preventing the recovery — would come straight back for any runner
    // that executes commands directly. So the step is marked best-effort in the EXECUTOR: a
    // non-zero exit is recorded as `warn` and the pass continues to the restart. The `|| true`
    // stays on the string so the executed list and the printed hint remain textually identical.
    //
    // Derived by set difference rather than by index, so a future addition to
    // `recoveryPlanCommands` is best-effort automatically instead of silently becoming able to
    // abort the restore: anything that is NOT one of the plan's own commands is an addition.
    const planCmdSet = new Set(restartCmds.map(c => c.cmd));
    const restoreCmds = (restartPlan.plan.action === "user-unit"
      ? recoveryPlanCommands(restartPlan)
      : restartCmds.map(c => c.cmd)
    ).map(cmd => ({ cmd, bestEffort: !planCmdSet.has(cmd) }));
    restoreOutcome = { ok: true, cmds: [] };
    for (const c of restoreCmds) {
      const r = await execRestartRetry(c.cmd, { attempts: 1, backoffMs: 0, run: runShell });
      phases.push({
        name: "restart-restore", cmd: c.cmd,
        status: r.ok ? "ok" : (c.bestEffort ? "warn" : "fail"),
        ...(r.ok ? {} : { stderr: r.detail }),
      });
      restoreOutcome.cmds.push(c.cmd);
      if (!r.ok && !c.bestEffort) { restoreOutcome.ok = false; break; }
    }
    console.error(restoreOutcome.ok
      ? `[rollback] restoration commands ran without error — the probe below decides whether that worked.`
      : `[rollback] restoration ALSO failed. The probe below reports what is actually serving.`);
  }

  // Issue #274 (split from #253's own item 2): unlike runFullUpgrade's phase 6, this used to
  // return success unconditionally once the restart phase's shell commands exited 0 -- a
  // rollback that "succeeded" while the restored tree was not what actually came back up had
  // nothing left to catch it. That is the same failure shape this file has hit three times
  // already: #214 (retry short-circuited into a no-op while the tree was new and the process
  // old -- only /health told the truth), #241 (the light path had no post-flight), and #232 (a
  // health verdict that did not track serving). Reuses runPostFlightCheck()/postFlightOk() --
  // the SAME acceptance predicate every other path in this file already uses -- rather than a
  // fourth hand-rolled check.
  //
  // Target is meta.fromVersion, deliberately NOT doctor.latest_version or any upgrade target:
  // rollback's entire point is restoring the OLDER version recorded in the snapshot's own
  // from-version.txt (writeSnapshot, scripts/lib/snapshot.mjs, writes fromVersion as
  // doctor.current_version at the time the snapshot was taken -- the version the just-restored
  // fromCommit actually served). Comparing against toVersion/doctor.latest_version would check
  // the rollback against the version it is trying to LEAVE, not the one it is restoring --
  // exactly backwards. See PR body for the fuller design-question writeup #274 asked for.
  //
  // opts.mockProbe: the SAME test hook runPostFlightCheck already exposes for its own callers
  // (not a new name) -- reused verbatim so this phase is independently testable without a live
  // server, the same way opts.run already lets resolveRestartPlan's own gathering be driven
  // end-to-end regardless of opts.mockExec. Under plain opts.mockExec with no mockProbe, this
  // phase is skipped like every other mutating phase above, so every existing all-mock rollback
  // test is unaffected. A real (non-mockExec) rollback always runs the real check.
  //
  // Issue #352: this now also runs after a FAILED restart command, which is the whole point — the
  // `exec` throw above used to make this block unreachable in exactly the case it was written for.
  // Its gate is unchanged.
  let postFlight = { ok: true, lastSeen: null, target: String(meta.fromVersion || "").replace(/^v/, ""), lastFailure: null };
  let postFlightMeasured = false;
  if (opts.mockProbe || !opts.mockExec) {
    postFlightMeasured = true;
    postFlight = await runPostFlightCheck(meta.fromVersion, {
      mockProbe: opts.mockProbe,
      attempts: opts.postFlightAttempts,
      intervalMs: opts.postFlightIntervalMs,
    });
    phases.push({
      name: "post-flight",
      status: postFlight.ok ? "ok" : "fail",
      ...(postFlight.ok ? {} : {
        message: `health did not return status=ok AND version=${postFlight.target} within the post-flight budget`
          + (postFlight.lastSeen
            // Kept byte-identical: when a body WAS read this text was already correct and specific,
            // and it is rollback's own wording, not runFullUpgrade's.
            ? ` (last saw version=${postFlight.lastSeen} — the restored tree may not be what's running; check \`ss -ltnp\` / \`lsof -i\`)`
            // Issue #352: was a flat `" (unreachable)"` — a statement about the SERVICE, emitted
            // for a broken local curl just as readily as for a dead proxy. `runPostFlightCheck`
            // has carried #291's classification all along; this phase was throwing it away.
            // `postFlightFailureSuffix` reduces to exactly `" (unreachable)"` when there is no
            // classification, so the pre-#352 text is preserved wherever it was the honest one.
            : postFlightFailureSuffix(postFlight)),
      }),
    });
  } else {
    phases.push({ name: "post-flight", status: "skipped-mock" });
  }

  // Issue #352: the outcome cells, structurally ported from runFullUpgrade's (which mirror `ocp`'s
  // cmd_restart at ocp:1051-1127) so all three paths tell the operator the same story. Ordering is
  // the load-bearing part: the local-fault arm is checked FIRST, because it is also a non-ok probe,
  // and getting it backwards tells a machine with a broken curl that its proxy is dead.
  //
  // Disclosure, since a reader will otherwise assume this is a shared helper: this block is a COPY
  // of runFullUpgrade's, not a call into one. #352's issue text predicted "the four-cell verdict
  // logic [is] already exported / in place from #347"; only `execRestartRetry`,
  // `recoveryPlanCommands`, `postFlightFailureSuffix` and `postFlightOnlyCommand` actually are. The
  // arm ordering is the load-bearing property and it is now duplicated rather than shared — an
  // extraction touches runFullUpgrade and belongs in its own reviewable unit (Iron Rule 11), so it
  // is filed rather than folded in here. The hint TAILS differ (below); the opening clauses of the
  // DOWN hint are byte-identical to the sibling's, and are not claimed to be re-derived.
  //
  // Where the wording genuinely diverges: runFullUpgrade's hints end by pointing at `ocp update
  // --rollback`; here that is the command already running, and repeating it would send an operator
  // round the same loop a second time. What is true on this path instead: the tree IS restored, and
  // the only thing missing is a running service.
  const probeCouldNotRun = postFlight.lastFailure?.kind === "probe-could-not-run";
  // #352 review finding MED-1. `postFlight.ok === false` covers FIVE distinct states, and one of
  // them is `version-mismatch`: curl connected, a body was read, `lastSeen` is populated, and the
  // service is answering — with the wrong version. On the rollback path that is the single most
  // likely non-fatal outcome, because a surviving pre-rollback process holding the port is exactly
  // the failure #274 built this post-flight to catch. Keying the DOWN cell on `!postFlight.ok`
  // alone would print "THE PROXY IS DOWN … /health is not answering" about a service that just
  // answered, in the same throw whose `post-flight` phase says `last saw version=…`.
  //
  // `ocp`'s cmd_restart, which the cells above cite as their authority, does NOT have this bug: its
  // DOWN cell keys on the curl exit code (`probe_rc -ne 0`), not on a version predicate.
  // `!postFlight.ok` is strictly broader, and the extra state is precisely the one where the
  // message becomes false — so this is the faithful port, not an embellishment of it.
  //
  // `lastSeen` is the discriminator because `runPostFlightCheck` assigns it only after `probe()`
  // returned a body (`lastSeen = body.version`, before the acceptance test). Non-null therefore
  // means "something answered on the port", which is the exact fact the DOWN wording denies.
  const serviceAnswered = postFlight.lastSeen != null;
  const recoveryCmds = recoveryPlanCommands(restartPlan).join(" && ");

  if (restartFailure && !postFlightMeasured) {
    // Only reachable from a test that injects execFn but no probe. Never claim success when a
    // restart command failed and nothing measured the result.
    throw Object.assign(
      new Error(`rollback phase restart failed: ${restartFailure.detail} — and post-flight did not run, so the service state is UNKNOWN`),
      { phases, target: target.path,
        hint: `THE SERVICE STATE IS UNKNOWN. A restart command failed and nothing probed /health.` }
    );
  }

  if (restartFailure && !postFlight.ok && probeCouldNotRun) {
    throw Object.assign(
      new Error(`rollback phase restart failed: ${restartFailure.detail} — and this machine could not run the /health probe (${postFlight.lastFailure.detail})`),
      { phases, target: target.path,
        hint: `THE SERVICE STATE IS UNKNOWN, and it may be DOWN: the stop half of the restart already ran. `
          + `This machine could not run curl, so nothing here is evidence about the proxy either way. `
          + `Check it by hand (\`curl -sf http://127.0.0.1:${rollbackPort}/health\` from a working shell); if it is down, `
          + `re-run: ${recoveryCmds}` }
    );
  }

  if (restartFailure && !postFlight.ok && serviceAnswered) {
    // MED-1's cell. A restart command failed AND something is answering on the port with the wrong
    // version — the surviving-old-process shape. Saying "THE PROXY IS DOWN" here would be false, and
    // saying nothing about the restart failure would lose the reason. This is #274's verdict with
    // the restart failure attached, not a new claim: the service is up, it is serving the wrong
    // thing, and a restart command is why.
    throw Object.assign(
      new Error(`rollback post-flight failed: restored tree may not be what's running — run \`ocp doctor\` before assuming the rollback succeeded`),
      { phases, target: target.path,
        hint: `THE PROXY IS UP BUT SERVING THE WRONG VERSION (${postFlight.lastSeen}, expected ${postFlight.target}). `
          + `A restart command failed after ${restartFailure.attempts} attempts, so the process holding 127.0.0.1:${rollbackPort} `
          + `is most likely the pre-rollback one that was never replaced. The working tree IS rolled back to `
          + `${meta.fromVersion || meta.fromCommit}; do not run \`ocp update --rollback\` again. Replace the running process with: `
          + `${recoveryCmds}  Then re-check with \`${postFlightOnlyCommand(meta.fromVersion)}\`, and run \`ocp doctor\` if it still `
          + `reports ${postFlight.lastSeen} — that means something other than this unit owns the port.` }
    );
  }

  if (restartFailure && !postFlight.ok) {
    // The cell this issue exists for, on the path an operator only reaches because something else
    // already failed. Reaching here means the probe RAN, reached nothing, and the fault is not a
    // local one — so "not answering" is measured, not assumed. Service state leads; and unlike
    // runFullUpgrade's version of this hint there is no "consider rolling back" tail, because this
    // IS the rollback.
    throw Object.assign(
      new Error(`rollback phase restart failed: ${restartFailure.detail}`),
      { phases, target: target.path,
        hint: `THE PROXY IS DOWN. A restart command failed after ${restartFailure.attempts} attempts, `
          + `${restoreOutcome?.ok ? "the restoration attempt ran without error but did not bring it back" : "the restoration attempt also failed"}, `
          + `and /health is not answering on 127.0.0.1:${rollbackPort}. This command stopped the service and could not start it again. `
          // LOW-1: NOT "nothing will start it on its own". install-autostart.mjs writes
          // `Restart=always`/`RestartSec=5` for the systemd unit, so on that shape systemd may well
          // start it — indeed `recoveryPlanCommands`' own note depends on it doing so. The launchd
          // plist has KeepAlive, but a SUCCEEDED bootout unloads the job, so there the claim holds.
          // Stated per shape instead of asserted for both.
          + `${restartPlan.plan.action === "launchd"
              ? `The job has been unloaded, so nothing will start it on its own.`
              : `The unit is configured Restart=always, so systemd may bring it back by itself — but it has not within the probe budget.`} `
          + `Bring it back with: ${recoveryCmds}  `
          + `The working tree is ALREADY rolled back to ${meta.fromVersion || meta.fromCommit} — do not run \`ocp update --rollback\` again; `
          + `the only thing missing is a running service.` }
    );
  }

  if (!postFlight.ok && probeCouldNotRun) {
    // #347's F1 cell, restated for this path. Every restart command exited 0 and the probe could
    // not RUN — a local environment fault that says nothing about the service. Without this arm the
    // generic throw below headlines "the restored tree may not be what's running" at a host whose
    // rollback most likely succeeded, which on the recovery path invites re-running or reinstalling
    // on no evidence at all.
    throw Object.assign(
      new Error(`rollback post-flight could not run on this machine (${postFlight.lastFailure.detail})`),
      { phases, target: target.path,
        hint: `THE ROLLBACK MAY HAVE SUCCEEDED — do NOT re-run it on this evidence. Every restart command `
          + `exited 0, and the post-flight probe could not RUN here (${postFlight.lastFailure.detail}). `
          + `That is a local environment fault and says nothing about the service. Check by hand from a `
          + `working shell (\`curl -sf http://127.0.0.1:${rollbackPort}/health\`), or fix the local curl and re-check `
          + `with \`${postFlightOnlyCommand(meta.fromVersion)}\`.` }
    );
  }

  if (!postFlight.ok) {
    // No further fallback to retry (#221's HIGH-A finding about permanent-refusal traps does
    // not apply here: the restart phase already ran, this only decides whether to REPORT
    // success truthfully) -- throw, matching runFullUpgrade's own post-flight-failure shape,
    // so operators get the same failure contract regardless of which path failed.
    throw Object.assign(
      new Error(`rollback post-flight failed: restored tree may not be what's running — run \`ocp doctor\` before assuming the rollback succeeded`),
      { phases, target: target.path }
    );
  }

  if (restartFailure) {
    // Issue #352, mirroring runFullUpgrade's fourth cell and ocp:1092: a restart command failed and
    // the proxy is nonetheless serving the restored version. Not a silent success — reporting a
    // bare "✓" trains operators to ignore the retry warnings that are the early signal for the DOWN
    // cell above.
    phases.push({
      name: "restart", status: "warn",
      // NIT-1: carries `.cmd` like every other `restart` phase. About twenty existing tests read
      // `phases.filter(p => p.name === "restart").map(p => p.cmd)`; none reaches this path today,
      // but one that did would have got `undefined` in that array.
      cmd: restartFailure.cmd,
      // LOW-2: `restoreOutcome.ok` means the restore COMMANDS exited 0 — not that they are why the
      // service is up (systemd's own `Restart=always` is an equally good explanation, and it may
      // never have gone down). The sibling `console.error` at the restore site is careful about
      // exactly this; this note used to say "brought the service back", asserting causation nobody
      // measured. It now reports what ran. The false branch is stated rather than omitted: a restore
      // pass that FAILED while the service is up is a fact worth having.
      note: `"${restartFailure.cmd}" failed after ${restartFailure.attempts} attempts`
        + `${restoreOutcome ? (restoreOutcome.ok
            ? " and the restoration pass ran without error"
            : " and the restoration pass ALSO failed") : ""}; `
        + `post-flight confirms the service is UP and serving ${postFlight.target}. `
        + `Worth checking \`ocp doctor\` — this usually means the resolver's expected unit and the unit that actually owns the port have drifted apart.`,
    });
    console.error(`[rollback] WARNING: a restart command failed after retries, but the service is UP and serving ${postFlight.target}. Run \`ocp doctor\`.`);
  }

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
  // Issue #227: explicit, separate opt-in required to execute the fresh_install path -- see
  // runFreshInstall()'s own comment. Has no effect on any other kind.
  const freshInstall = args.includes("--fresh-install");
  const rollback = args.includes("--rollback");
  const list = args.includes("--list");
  const gc = args.includes("--gc");
  // Issue #297: this was `args.indexOf("--target")` — the SEPARATE-token form only. `ocp`'s bash
  // layer forwards the user's argv verbatim (`exec node .../upgrade.mjs "$@"`, ocp:1289), and its
  // own `_detect_target_flag` has handled BOTH `--target vX.Y.Z` and `--target=vX.Y.Z` since #272,
  // so `ocp update --target=v9.9.9` arrived here with `target` undefined: the #272 refusal never
  // fired on fresh_install, and on the full/cross-minor path the #259 pin was silently not
  // applied — the upgrade went to doctor.latest_version instead. That is precisely the "user
  // believes they pinned a version and did not" failure #260 exists to prevent, reintroduced
  // through a layer boundary because #272's tests exercised the equals form only at the bash
  // layer, where its fix was.
  const targetFlag = parseFlagValue(args, "--target");
  const target = targetFlag.value;
  // Fail CLOSED when the flag is present but carries no value (`--target` as the last token,
  // `--target=`, `--target --dry-run`, `--target ""`). Both forms used to drop these silently to
  // `undefined`, which is the same silent-no-pin outcome #260 was filed about — the flag was
  // typed, so staying quiet is the one thing this must not do. Mirrors the identical guard
  // `--post-flight-only` already carries a few lines below, and the bash side's own
  // `_TARGET_SEEN`/`_TARGET_VAL` split, which exists for exactly this distinction.
  if (targetFlag.seen && (!target || target.startsWith("--"))) {
    console.error(`✗ --target requires a version argument, e.g. --target v3.27.0 (or --target=v3.27.0)`);
    process.exit(1);
  }
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
  // #297: routed through the same parser as `--target`. `ocp` only ever invokes this internally
  // with the separate-token form (ocp:1434, ocp:1489), so the equals form is not reachable from
  // the product and this is not a second instance of #297's defect — but keeping two different
  // parsers for the same flag shape in one file is how they drift, and the guard below already
  // says this exists to catch hand-invoked misuse, which is exactly where someone types `=`.
  const postFlightFlag = parseFlagValue(args, "--post-flight-only");
  if (postFlightFlag.seen) {
    const postFlightTarget = postFlightFlag.value;
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
      // #291: this used to print a bare "(unreachable)" for every non-lastSeen failure — a claim
      // about the SERVICE, printed just as readily when the fault was that curl could not run on
      // this machine. The probe now reports which of the five it was, and only the genuinely
      // remote ones are narrated as remote.
      console.error(`✗ service did not reach v${result.target} within the post-flight budget`
        + postFlightFailureSuffix(result));
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
    const result = await runUpgrade({ dryRun, yes, freshInstall, rollback, list, gc, snapshotPath, target });
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
