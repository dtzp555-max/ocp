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
 *
 * Independent review of the first version of this module (PR #221) found that
 * every classification collapsed ambiguity into a WRONG confident answer
 * instead of an honest "I don't know" — which matters because "I don't know"
 * must never be silently treated as "safe to guess". Three fixes below exist
 * because of that review; each is annotated where it applies:
 *   - a THREE-VALUED listener probe (listening / not-listening / unknown) —
 *     `ss`'s `users:(())` PID column is omitted entirely when the caller can't
 *     see the target process (e.g. a non-root updater against a root-owned
 *     unit — the default for a system unit with no `User=`). The old code
 *     read "row present, no PID" as "not listening" and fell through to the
 *     pre-#215 default command, silently reporting SUCCESS.
 *   - a leaf-to-root cgroup WALK instead of a leaf-only check, so custom
 *     `Slice=`, `Delegate=yes` payload scopes, and cgroup v1 hosts resolve
 *     correctly instead of hard-aborting with a false "not managed by any
 *     unit" diagnosis.
 *   - unit-name VALIDATION at the point a cgroup-derived string is accepted,
 *     closing a shell-injection path (an attacker-influenced cgroup segment
 *     like `a;id.service` or `a b c.service` must never reach a `sh -c` call).
 *
 * A second round of independent review (still PR #221) found that the refusal posture itself
 * introduced a regression and a residual gap, both fixed here:
 *   - HIGH-A: the "not-listening" refusal above is right for the UPGRADE path but wrong for
 *     ROLLBACK, whose whole point is restoring a down service and which has no health gate to
 *     protect. `planRestart`'s `opts.allowNotListeningFallback` (set only on the rollback call
 *     site in scripts/upgrade.mjs) falls through to the default unit with a loud warning
 *     instead of a refusal that would otherwise never clear on a re-run.
 *   - MED-C: `UNIT_NAME_RE` rejected shell metacharacters (MED-5) but still permitted a LEADING
 *     "-", which a getopt-style parser (systemctl included) treats as another OPTION wherever
 *     it appears in argv — `-Hattacker@example.com.service` becomes `-H`/`--host` (SSH to an
 *     attacker-chosen target), `-Mevil.service` becomes `-M`/`--machine`. Fixed by excluding
 *     "-" from the first character's class, plus `--` before the unit name at every shell-out
 *     site (defense in depth, matching MED-5's own posture).
 *   - MED-D: the SO_REUSEPORT multi-PID detection used a non-global regex match and silently
 *     under-counted the same-row case; see the note beside `classifySsListener`'s `matchAll`.
 *
 * A THIRD independent review (issue #233, filed after PR #221 merged) found the Linux/macOS
 * halves of this fix were not actually symmetric, despite `classifyLsofListener` below already
 * having the same three-valued shape as `classifySsListener`:
 *   - Defect 1: unlike `ss`, `lsof -iTCP:<port> -sTCP:LISTEN` EXITS NONZERO (status 1) on a clean
 *     "nothing matched" result, with empty stdout — verified live. The gather layer in
 *     scripts/upgrade.mjs had one `catch { lsofOutput = null }`, so that clean not-listening
 *     result and a genuinely missing/failing tool both became `null` -> `classifyLsofListener`'s
 *     "unknown" -> `planRestart` throwing unconditionally. This function's own null/""
 *     three-valued contract was never actually reachable end-to-end on macOS as a result — fixed
 *     at the gather layer (scripts/upgrade.mjs's `mapLsofFailureToProbeValue`), not here:
 *     `classifyLsofListener` already treated `""` and `null` correctly the whole time.
 *   - Defect 2 (macOS ownership/no-unit determination — a real listener existing is not proof
 *     the `dev.ocp.proxy` launchd job is the one holding it, analogous to Linux's `no-unit`
 *     state below): deliberately NOT part of this fix. Tracked in a follow-up issue rather than
 *     bundled here, per Iron Rule 11 (minimum reviewable unit) — a new pure classifier plus a
 *     cross-platform command-choice decision deserves its own dedicated review, separate from
 *     defect 1's contained, surgical exit-code fix. Until it lands, `resolveOwningUnit`'s darwin
 *     branch below still returns `kind: "launchd"` for ANY listener once one is confirmed to
 *     exist — it does not yet verify that listener is actually the launchd-managed process.
 *
 * A FOURTH independent review (HIGH-1, against PR #240 which shipped defect 1 above) found
 * defect 1's own fix had an unhandled ambiguity: `lsof`'s (status 1, empty stdout) signature is
 * not unique to "nothing is listening" — a non-root `lsof` probing a ROOT-OWNED listener produces
 * the identical signature (verified live). Pre-defect-1 this mapped to `null` -> refuse
 * (fail-closed, if wrongly-worded); post-defect-1 it mapped to `""` -> not-listening ->
 * (`--rollback`) `allowNotListeningFallback` -> bootout the user agent while the root daemon
 * still held the port. The failure direction inverted. Fixed by gating the `""` mapping behind a
 * positive `netstat` cross-check (see `classifyLsofListener`'s own comment above for the full
 * evidence and the resulting three-way split) — this function's job is just to forward the
 * cross-check's result through to it via `probe.netstatConfirmsListener` /
 * `probe.netstatProbeFailed`.
 *
 * Issue #237 (independent review of the `v3.26.0..main` batch, filed alongside #234) found a
 * different kind of gap than any of the four above: every prior fix made the resolver more
 * HONEST about what it found, but never verified that what it found is actually OCP. Once
 * `parseCgroupUnit` resolves a real, well-formed systemd unit name, `resolveOwningUnit` only ever
 * compares that NAME against the hard-coded `expectedUnit` — a mismatch (`owner.mismatched`)
 * produces a WARNING in `planRestart`, never a refusal. A port misconfigured onto a port some
 * unrelated systemd-managed service already holds (`nginx.service`, say) resolves exactly like a
 * legitimate but renamed OCP unit does: `kind: "system-unit"`, a real unit name, `mismatched:
 * true`. `planRestart` then proceeds to build `sudo systemctl restart -- nginx.service`. This is
 * the safety INVERSE of #215: #215 restarted the wrong thing because the resolver GUESSED at an
 * identity it had no basis for; #237 restarts the wrong thing because the resolver correctly
 * identifies a real unit that simply isn't ours, and acts on that identification anyway.
 *
 * Fix: `classifyCmdlineOwner` reads `/proc/<pid>/cmdline` (NUL-separated argv) for the SAME PID
 * the cgroup probe already resolved — gathered in the same probe pass in scripts/upgrade.mjs's
 * `resolveRestartPlan`, no separate resolution round-trip — and checks whether that process
 * actually invokes `server.mjs`, mirroring scripts/doctor.mjs's own #230 `fingerprintSystemdUnit`
 * serverArg check so the two "is this an OCP unit" tests can't drift apart. A CONFIRMED-foreign
 * process (cmdline read cleanly, no server.mjs anywhere in it) short-circuits `resolveOwningUnit`
 * straight to a new terminal `kind: "foreign-process"`, which `planRestart` refuses
 * unconditionally — before ever reaching the mismatch-warning/sudo/system-unit machinery below,
 * regardless of root or sudo authorization. An UNREADABLE cmdline (permission denied, PID raced)
 * is `kind: "unknown"`, the same fail-closed terminal state every other probe failure in this file
 * already uses — never treated as "confirmed foreign" (a false-confident answer) nor silently
 * skipped (which would defeat the point of the check).
 *
 * At the time #237 landed, macOS was deliberately NOT covered (same "minimum reviewable unit"
 * posture as defect 2 in the THIRD review above): `/proc/<pid>/cmdline` doesn't exist there, and
 * the darwin branch used to return `kind: "launchd"` for any confirmed listener without
 * identifying the actual process at all. That gap was originally reported as issue #233 defect 2;
 * #233 itself was CLOSED (split per Iron Rule 11 into its own dedicated review) and tracked
 * onward as issue #239.
 *
 * issue #239 (this fix): extends identity verification to macOS. The core asymmetry Linux and
 * macOS have to work around is structural, not incidental — Linux has a pid -> cgroup -> unit-name
 * REVERSE lookup (`/proc/<pid>/cgroup`), so resolution walks from "here's the pid holding the
 * port" to "here's what unit that is". launchd has no equivalent (there is no
 * `/proc/<pid>/launchd-label` file), so resolution has to run the OTHER direction: ask launchd
 * what pid it believes owns the ONE label this repo manages (`dev.ocp.proxy`, hardcoded — there's
 * no multi-label ambiguity to resolve the way Linux has system-vs-user scope) via `launchctl print
 * gui/<uid>/dev.ocp.proxy`, and compare that pid against the pid `lsof`/`netstat` found actually
 * holding the port. A mismatch — or the label not being registered, or registered but not
 * currently running — means the port's holder is not verified to be `dev.ocp.proxy`: the macOS
 * analogue of Linux's `no-unit`, via the same terminal `kind` (not a fourth, platform-only state).
 *
 * `classifyLaunchdJob` does that pid-and-argv extraction (verified live against the production
 * host — see its own comment for the exact `launchctl print` output shapes, both registered and
 * "Could not find service"). `classifyLaunchdArgv` then applies the SAME "does this argv invoke
 * server.mjs" predicate `classifyCmdlineOwner` uses on Linux (factored out as `findServerMjsArg`
 * below and called by both) to the job's own argv — mirroring #237's identity check, not
 * reinventing a third notion of "is this OCP": a hand-edited or compromised plist could register
 * the SAME label against a different program, and pid-matching alone would not catch that. A
 * confirmed pid match whose argv does NOT invoke server.mjs resolves to the same `foreign-process`
 * kind #237 introduced for Linux, reusing that terminal state and its refusal in `planRestart`
 * rather than adding a platform-specific twin.
 *
 * `probe.launchdPrintOutput === undefined` (as opposed to `null`) means the caller never attempted
 * this probe — same legacy/back-compat convention `probe.cmdlineContent` uses on the Linux side:
 * skip the check, preserve pre-#239 behavior, rather than newly refuse restarts that were "safe"
 * before this field existed. `planRestart`'s `no-unit` and `foreign-process` refusal messages are
 * platform-branched (`owner.platform === "darwin"`) since the Linux wording names `systemd`,
 * `/proc/<pid>/cgroup`, and `/proc/<pid>/cmdline` — none of which exist on macOS.
 */

// Anything accepted as a restart target must look like a real systemd unit name.
// This is the actual trust boundary: cgroup path segments are attacker-creatable
// under cgroup v2 delegation, and this module's whole job is deciding what string
// gets concatenated into a shell command downstream. A segment that fails this
// check is treated exactly like "no unit found here" — never partially trusted.
//
// MED-C (PR #221 round-2 review): the original character class (`[A-Za-z0-9:_.@-]+`)
// permits a LEADING "-", which closes the shell-injection path (MED-5) but leaves an
// argv-injection path wide open — `getopt`-style parsers (systemctl included) treat a
// leading-dash argv word as an OPTION regardless of where the parser is in the argument
// list, not as the unit name. `-Hattacker@example.com.service` turns `systemctl restart
// <that>` into `systemctl restart -Hattacker@example.com.service`, and `-H`/`--host`
// takes `[user@]host` and connects over SSH; `-Mevil.service` retargets `-M`/`--machine`
// to a container. Same threat model as MED-5 (the segment is cgroup-v2-delegation
// attacker-creatable) — different injection class, so it needs its own guard: the first
// character must come from a class that EXCLUDES "-", the rest may still include it.
const UNIT_NAME_RE = /^[A-Za-z0-9:_.@][A-Za-z0-9:_.@-]*\.service$/;

// --- Linux: classify `ss -lptn "sport = :<port>"` output ---
// Returns one of three states — never conflates "confirmed empty" with "couldn't tell":
//   "listening"      exactly one LISTEN row, exactly one distinct owning PID
//   "not-listening"  the tool ran and printed no LISTEN row at all for this port
//   "unknown"        the tool didn't run (ssOutput == null), OR a LISTEN row exists
//                     but no PID is attributable (foreign-uid process — the `ss`
//                     `users:(())` column requires visibility into the target's
//                     /proc/*/fd and is silently omitted otherwise), OR more than
//                     one distinct PID answers — across separate rows (dual-stack,
//                     e.g. one IPv4 + one IPv6 LISTEN row) OR within a SINGLE row's
//                     `users:(())` group (SO_REUSEPORT, several processes sharing one
//                     socket) — "which one" is issue #215's own diagnostic question,
//                     and picking the first match arbitrarily was the exact defect
//                     this replaces. (MED-D, PR #221 round-2 review: the first cut of
//                     this fix used a non-global `pid=` match, so only the same-row
//                     SO_REUSEPORT shape still silently returned the FIRST pid as if
//                     unambiguous — dual-stack's separate rows already worked. Both
//                     shapes now converge on "unknown" via matchAll below.)
export function classifySsListener(ssOutput) {
  if (ssOutput == null) {
    return { state: "unknown", pid: null, reason: "ss did not run (missing tool, or the probe exec itself failed)" };
  }
  const listenLines = String(ssOutput).split("\n").filter(l => /\bLISTEN\b/.test(l));
  if (listenLines.length === 0) {
    return { state: "not-listening", pid: null, reason: null };
  }
  const pids = new Set();
  // MED-D (PR #221 round-2 review): this was `line.match(/pid=(\d+)/)` — a NON-global match,
  // so only the FIRST "pid=" in each line was ever collected. That silently under-counted the
  // exact SO_REUSEPORT case this module exists to catch: multiple processes sharing one port
  // via SO_REUSEPORT appear as MULTIPLE "pid=" entries inside a SINGLE ss row's `users:(())`
  // group (e.g. `users:(("node",pid=100,fd=19),("node",pid=101,fd=19))`), not as multiple
  // separate rows. Dual-stack (IPv4 + IPv6, two separate rows) was already caught correctly,
  // since each row contributed its own single pid to the set — only the same-row multi-pid
  // shape was silently reported as "listening" with the FIRST pid, as if the row were
  // unambiguous. matchAll collects every "pid=" per line, so both shapes now converge on the
  // same "unknown" (2+ distinct pids) outcome instead of one being a false-confident answer.
  for (const line of listenLines) {
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(m[1]);
  }
  if (pids.size === 1) {
    return { state: "listening", pid: [...pids][0], reason: null };
  }
  if (pids.size === 0) {
    return {
      state: "unknown", pid: null,
      reason: "a LISTEN row exists but its owning PID is not visible — likely a process owned by a different user (ss only shows the PID when the caller can see the target's /proc/*/fd; try re-running with elevated privileges)",
    };
  }
  return {
    state: "unknown", pid: null,
    reason: `${pids.size} distinct PIDs (${[...pids].sort().join(", ")}) are listening on this port (dual-stack / SO_REUSEPORT) — cannot determine which one to restart`,
  };
}

// Shared identity predicate (issue #239): does this argv actually invoke server.mjs? Used by
// BOTH platforms' "is this OCP" checks — classifyCmdlineOwner below (Linux, argv sourced from
// /proc/<pid>/cmdline, NUL-separated) and classifyLaunchdArgv further down (macOS, argv sourced
// from `launchctl print`'s "arguments = { ... }" block, one token per line) — so "what counts as
// OCP" cannot silently drift into two different definitions across platforms. Mirrors
// scripts/doctor.mjs's own #230 fingerprintSystemdUnit / parsePlistCandidates serverArg check.
function findServerMjsArg(argv) {
  return argv.find(a => a === "server.mjs" || a.endsWith("/server.mjs"));
}

// --- macOS: classify `lsof -nP -iTCP:<port> -sTCP:LISTEN` output --- (same three states as ss)
//
// NOTE for callers (issue #233 defect 1): unlike `ss`, `lsof` with an `-i` filter that matches
// nothing EXITS 1, not 0 — a real, run-it-yourself-verified difference from `ss -lptn`, which
// always exits 0 and just prints no LISTEN row. That means the caller's `execSync` wrapper
// throws on a clean "not listening" result, and MUST distinguish that (exit 1, empty stdout)
// from a genuine failure before ever reaching this function — passing `""` for the former and
// `null` only for the latter. See scripts/upgrade.mjs's `mapLsofFailureToProbeValue`.
//
// HIGH-1 (independent review of PR #240, filed against this same issue): that (exit 1, empty
// stdout) signature is ALSO exactly what a non-root `lsof` produces when a ROOT-OWNED process
// holds the port — verified live as a non-root user against two known root-owned listeners:
// `lsof` reported (status 1, stdout "", stderr "") for BOTH, identical to the genuine no-match
// case. Unlike `ss` (whose LISTEN row survives with an empty `users:(())` PID column for a
// foreign-uid process — `classifySsListener`'s own "foreign uid" branch reads that straight out
// of `ssOutput`), `lsof` gives no partial row at all when it lacks permission, so there is
// nothing inside `lsofOutput` itself to detect this from. The caller cross-checks with
// `netstat`, which shows LISTEN rows for ANY owning uid without privilege (same live evidence),
// and passes the result in via `opts`:
//   opts.netstatConfirmsListener  netstat found a LISTEN row for this port despite lsof's empty
//                                 read — a listener exists, but lsof could not identify who owns
//                                 it (a privilege gap is the likely cause)
//   opts.netstatProbeFailed       the netstat cross-check itself could not run — lsof's
//                                 exit-1/empty-stdout result is left genuinely undecidable
// Both only matter when `lsofOutput` is `null`; a non-null (successful) `lsofOutput` needs no
// cross-check. A root-owned OCP deployment is not hypothetical: `scripts/doctor.mjs`'s
// multi-unit-risk check has a dedicated branch for `/Library/LaunchDaemons`, `scope:"system"`.
// Before this fix, this exact signature reached the `""` branch below unconditionally, so
// `--rollback` would read a live root-owned listener as "nothing is listening" and proceed to
// bootout+bootstrap the user agent while the root daemon still held the port.
export function classifyLsofListener(lsofOutput, opts = {}) {
  if (lsofOutput == null) {
    if (opts.netstatConfirmsListener) {
      return {
        state: "unknown", pid: null,
        reason: "a listener exists on this port (confirmed via netstat) but lsof could not identify its owner — likely a process owned by a different user (lsof only reports rows it has permission to see); re-run with elevated privileges to identify the owner",
      };
    }
    if (opts.netstatProbeFailed) {
      return {
        state: "unknown", pid: null,
        reason: "lsof's result (exit 1, no output) is ambiguous between \"nothing is listening\" and \"a listener exists but is owned by a different user\", and the netstat cross-check used to tell them apart also failed to run",
      };
    }
    return { state: "unknown", pid: null, reason: "lsof did not run (missing tool, or the probe exec itself failed)" };
  }
  const lines = String(lsofOutput).trim().split("\n").filter(Boolean).filter(l => !/^COMMAND\s/.test(l));
  if (lines.length === 0) {
    return { state: "not-listening", pid: null, reason: null };
  }
  const pids = new Set();
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols[1] && /^\d+$/.test(cols[1])) pids.add(cols[1]);
  }
  if (pids.size === 1) {
    return { state: "listening", pid: [...pids][0], reason: null };
  }
  if (pids.size === 0) {
    return { state: "unknown", pid: null, reason: "lsof returned a row with no numeric PID column" };
  }
  return {
    state: "unknown", pid: null,
    reason: `${pids.size} distinct PIDs (${[...pids].sort().join(", ")}) are listening on this port — cannot determine which one to restart`,
  };
}

// --- Linux: map a PID's /proc/<pid>/cgroup content to a systemd unit ---
//
// Walks each candidate cgroup line LEAF -> ROOT and takes the first segment that
// ends in ".service" and isn't "user@<uid>.service" (the systemd --user manager's
// own unit — always a non-leaf ancestor on every user-scope path, never the actual
// owner; this is the trap the original naive "first .service after user.slice/"
// regex fell into). Walking instead of leaf-only also fixes Delegate=yes: a
// delegated unit's process cgroup is legitimately NESTED one or more levels below
// the unit itself (".../ocp.service/payload.scope"), so the leaf segment is a
// scope, not the unit — the walk finds ocp.service one level up instead of
// hard-aborting with "not managed by any unit".
//
// Every candidate LINE is tried in priority order (unified "0::" first, then the
// v1 "name=systemd" controller, then whatever else is present) until one yields a
// match — not just the first line that EXISTS. Preferring "0::" outright, as the
// original version did, made the advertised cgroup-v1 fallback unreachable dead
// code whenever a "0::/" line was present at all, even one that resolved to
// nothing (e.g. bare "0::/" on a host where systemd's unified-hierarchy view of
// this PID is uninformative but a v1 controller line is not).
//
// Returns one of three states:
//   "resolved"  { scope: "system"|"user", unit: "<name>.service" }
//   "no-unit"   content was readable, but no line yielded a recognizable unit —
//               a genuinely bare, unmanaged process
//   "unknown"   content could not be read at all (permission denied, e.g. a
//               non-root updater probing a root-owned PID's cgroup under
//               hidepid=2/invisible, or the PID exited between the ss/lsof probe
//               and this read) — this must NOT be reported as "no-unit": we
//               don't know, and a false "confirmed bare process" diagnosis is
//               exactly the wrong-but-confident answer this rewrite exists to
//               eliminate. Callers signal this by passing cgroupContent === null;
//               an empty string is treated the same way (a "successful" empty
//               read of this file is not a real-world case worth trusting).
export function parseCgroupUnit(cgroupContent) {
  if (cgroupContent == null) {
    return { state: "unknown", scope: null, unit: null, reason: "could not read /proc/<pid>/cgroup (permission denied, or the process exited between probes)" };
  }
  const text = String(cgroupContent).trim();
  if (!text) {
    return { state: "unknown", scope: null, unit: null, reason: "empty /proc/<pid>/cgroup read" };
  }

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const ordered = [];
  const zero = lines.find(l => l.startsWith("0::"));
  if (zero) ordered.push(zero);
  const systemdLine = lines.find(l => l.includes("name=systemd") && l !== zero);
  if (systemdLine) ordered.push(systemdLine);
  for (const l of lines) if (!ordered.includes(l)) ordered.push(l);

  for (const line of ordered) {
    const path = line.split(":").pop();
    const segments = path.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (!seg.endsWith(".service")) continue;
      if (/^user@\d+\.service$/.test(seg)) continue;
      if (!UNIT_NAME_RE.test(seg)) continue; // reject anything that isn't a well-formed unit name
      // Scope: "/user.slice/" is a reliable positive signal — it is the fixed root of every
      // systemd --user manager's cgroup tree and isn't something a unit can opt out of. The
      // converse is NOT reliable: a SYSTEM unit with a custom top-level `Slice=ocp.slice` has
      // no "/system.slice/" segment at all (review finding MED-3's own repro:
      // "0::/ocp.slice/ocp.service"). Since systemd's cgroup model has exactly two roots for
      // unit-owning processes — the user manager's tree (always under user.slice) and
      // everything the system manager owns (system.slice-nested OR a custom top-level slice)
      // — "system" is the correct default whenever "/user.slice/" is absent, not a fallback
      // that requires "/system.slice/" to be spelled out literally.
      const scope = path.includes("/user.slice/") ? "user" : "system";
      return { state: "resolved", scope, unit: seg, reason: null };
    }
  }
  return { state: "no-unit", scope: null, unit: null, reason: "no cgroup line yielded a recognizable systemd unit" };
}

// --- macOS: classify `launchctl print gui/<uid>/dev.ocp.proxy` output --- (issue #239)
//
// Linux has a pid -> cgroup -> unit-name REVERSE lookup (/proc/<pid>/cgroup), so parseCgroupUnit
// above walks from "here's the pid holding the port" to "here's what unit that is". macOS/launchd
// has no equivalent (there is no /proc/<pid>/launchd-label file), and this repo manages exactly
// ONE label (dev.ocp.proxy, hardcoded — no multi-label ambiguity to resolve the way Linux has
// system-vs-user scope), so this runs the OTHER direction: ask launchd what pid IT believes owns
// the label, for resolveOwningUnit to compare against the pid lsof/netstat found actually holding
// the port.
//
// Verified live against the production host (read-only `launchctl print`, never mutated):
//   registered + running:  exit 0, a "pid = <N>" line, and an "arguments = { ... }" block with one
//                          argv token per line (no shell-splitting ambiguity — the same guarantee
//                          NUL-separation gives /proc/<pid>/cmdline on Linux, via a different
//                          mechanism: launchctl's own line-per-token rendering). Example, captured
//                          live against the real dev.ocp.proxy job on this host:
//                            pid = 55416
//                            arguments = {
//                                /opt/homebrew/Cellar/node/26.5.0/bin/node
//                                /Users/taodeng/ocp/server.mjs
//                            }
//   label not registered:  nonzero exit (113 observed on this host — Apple does not document
//                          launchctl's exit codes, so this is NOT asserted on anywhere in this
//                          codebase, matching this file's standing posture of trusting the MESSAGE
//                          over an undocumented exit code), EMPTY stdout, stderr:
//                            Bad request.
//                            Could not find service "<label>" in domain for user gui: <uid>
//                          — the gather layer (scripts/upgrade.mjs's
//                          mapLaunchctlPrintFailureToProbeValue) turns that SPECIFIC, expected
//                          failure into "" (this function's own not-registered sentinel), matching
//                          the same "the tool ran and told us something meaningful, but execSync
//                          still threw on the nonzero exit" shape lsof's own "nothing matched"
//                          case already has (defect 1 / PR #240).
//
// Returns one of four states — same "unknown must never be treated as safe-to-guess" posture as
// every other classifier in this file:
//   "unknown"          printOutput === null — the probe didn't run, or failed some way OTHER than
//                      the specific "not registered" signature above
//   "not-registered"   printOutput is a non-null string that trims to empty — the gather layer's
//                      sentinel for launchctl's "Could not find service" failure
//   "not-running"      printOutput is non-empty but no "pid = <N>" line was found — the label IS
//                      registered but has no live process right now (e.g. a mid-restart window);
//                      NOT proof the port's current holder is this job
//   "running"          a "pid = <N>" line was found; pid and argv (parsed from the
//                      "arguments = { ... }" block) are both returned for the caller to verify
//                      against the actual port-holding pid and against server.mjs identity
export function classifyLaunchdJob(printOutput) {
  if (printOutput == null) {
    return {
      state: "unknown", pid: null, argv: null,
      reason: "launchctl print did not run (missing tool, probe failed, or a failure other than \"not registered\")",
    };
  }
  const text = String(printOutput);
  if (!text.trim()) {
    return { state: "not-registered", pid: null, argv: null, reason: null };
  }
  const pidMatch = text.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  if (!pidMatch) {
    return { state: "not-running", pid: null, argv: null, reason: null };
  }
  const argsBlock = text.match(/\barguments\s*=\s*\{([^}]*)\}/);
  const argv = argsBlock ? argsBlock[1].split("\n").map(s => s.trim()).filter(Boolean) : [];
  return { state: "running", pid: pidMatch[1], argv, reason: null };
}

// --- Linux: classify /proc/<pid>/cmdline content as OCP's own server.mjs, or a foreign process ---
// (issue #237)
//
// parseCgroupUnit answers "what UNIT owns this port" — never "is the process behind that unit
// actually OCP's server.mjs". A well-formed, real systemd unit name (nginx.service, say) resolves
// cleanly through parseCgroupUnit exactly like a legitimately-renamed OCP unit does; nothing in
// that resolution path can tell the two apart. classifyCmdlineOwner reads /proc/<pid>/cmdline for
// the SAME pid parseCgroupUnit's cgroup content came from (NUL-separated argv — not
// space-separated, so a path containing a literal space is never misread as two tokens) and
// checks whether that process actually invokes server.mjs, using the exact same test
// scripts/doctor.mjs's #230 fingerprintSystemdUnit already uses for its own ExecStart argv[]
// check (`a === "server.mjs" || a.endsWith("/server.mjs")`) — so "doctor.mjs would recognize this
// as an OCP unit" and "this resolver treats it as a restart candidate" can't silently drift apart
// into two different definitions of the same question.
//
// Returns one of three states — same "unknown must never be treated as safe-to-guess" posture as
// every other classifier in this file:
//   "ocp"      cmdline contains an argv token that is exactly "server.mjs" or ends with
//              "/server.mjs".
//   "foreign"  cmdline was read successfully and contains NO such token — a confident, positive
//              "this is not us" signal (the nginx.service scenario issue #237 reports).
//   "unknown"  /proc/<pid>/cmdline could not be read at all (permission denied — a non-root
//              updater probing a root-owned PID under hidepid=2, the same gap parseCgroupUnit's
//              own "unknown" state exists for — or the PID exited between the cgroup read and
//              this one). Must NOT be read as "foreign": a false-confident "definitely not OCP"
//              diagnosis on a process we simply couldn't inspect is exactly the wrong-but-
//              confident answer this file's classifiers all exist to eliminate.
export function classifyCmdlineOwner(cmdlineContent) {
  if (cmdlineContent == null) {
    return { state: "unknown", reason: "could not read /proc/<pid>/cmdline (permission denied, or the process exited between probes)" };
  }
  const argv = String(cmdlineContent).split("\0").filter(Boolean);
  if (argv.length === 0) {
    return { state: "unknown", reason: "empty /proc/<pid>/cmdline read" };
  }
  const serverArg = findServerMjsArg(argv);
  if (!serverArg) {
    return {
      state: "foreign",
      reason: `owning process's argv (${argv.join(" ")}) does not invoke server.mjs at all — this is not an OCP process`,
    };
  }
  return { state: "ocp", reason: null };
}

// --- macOS: classify a launchd job's argv as OCP's own server.mjs, or a foreign process ---
// (issue #239, mirroring classifyCmdlineOwner's #237 check)
//
// classifyLaunchdJob (above) answers "is a process running under the dev.ocp.proxy label, and
// what pid/argv does launchd say it has" — it does NOT answer "does that argv actually invoke
// server.mjs". A hand-edited or compromised plist could register the SAME label against a
// DIFFERENT program; nothing about classifyLaunchdJob's own contract catches that — the same gap
// classifyCmdlineOwner exists to close for a real-but-foreign systemd unit name (#237). Takes the
// pre-parsed argv classifyLaunchdJob already extracted from the "arguments = { ... }" block (one
// token per line — no separate probe or parse pass) and applies the EXACT SAME "does this argv
// invoke server.mjs" predicate classifyCmdlineOwner uses on Linux (findServerMjsArg, this file's
// top) — deliberately reusing that function rather than reimplementing the check, so "what counts
// as OCP" cannot drift into a third definition across platforms.
//
// Returns the same two terminal states classifyCmdlineOwner uses: "ocp" / "foreign".
export function classifyLaunchdArgv(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const serverArg = findServerMjsArg(list);
  if (!serverArg) {
    return {
      state: "foreign",
      reason: `owning process's argv (${list.join(" ")}) does not invoke server.mjs at all — this is not an OCP process`,
    };
  }
  return { state: "ocp", reason: null };
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
 *   ssOutput       raw `ss -lptn "sport = :<port>"` stdout, or null if the
 *                   probe itself failed to run (Linux)
 *   lsofOutput     raw `lsof -nP -iTCP:<port> -sTCP:LISTEN` stdout, or null (macOS)
 *   netstatConfirmsListener  macOS only, only meaningful when lsofOutput is null: netstat
 *                   found a LISTEN row for this port despite lsof's empty read (HIGH-1 on
 *                   PR #240 — see classifyLsofListener's own comment)
 *   netstatProbeFailed       macOS only: the netstat cross-check itself could not run
 *   cgroupContent  raw `/proc/<pid>/cgroup` content for the resolved PID, or
 *                   null if unreadable (Linux)
 *   cmdlineContent raw `/proc/<pid>/cmdline` content for the resolved PID (Linux only; issue
 *                   #237). Three states, same convention as cgroupContent:
 *                     a string     classified via classifyCmdlineOwner
 *                     null         the probe was ATTEMPTED and failed to read — treated as
 *                                  "unknown" (see classifyCmdlineOwner)
 *                     undefined    the caller never attempted this probe at all — the check is
 *                                  SKIPPED entirely, preserving pre-#237 behavior. This is the
 *                                  legacy/back-compat lane: scripts/upgrade.mjs's own gather
 *                                  layer always populates this field one way or another now, so
 *                                  in real production use it is a string or null, never
 *                                  undefined — "undefined" only arises from a caller (or test)
 *                                  that hasn't been wired to this check, and must not newly
 *                                  refuse restarts that were safe before this field existed.
 *   launchdPrintOutput  raw `launchctl print gui/<uid>/<expectedUnit>` stdout for the ONE label
 *                   this repo manages (macOS only; issue #239). Same three-state convention as
 *                   cmdlineContent above:
 *                     a string     classified via classifyLaunchdJob (then, if "running",
 *                                  classifyLaunchdArgv against its argv)
 *                     null         the probe was ATTEMPTED and failed some way other than the
 *                                  specific "not registered" signature — treated as "unknown"
 *                     undefined    the caller never attempted this probe at all — the check is
 *                                  SKIPPED entirely, preserving pre-#239 behavior. Legacy/
 *                                  back-compat lane, same convention as cmdlineContent's: real
 *                                  production use (scripts/upgrade.mjs's gather layer) always
 *                                  populates this field one way or another; "undefined" only
 *                                  arises from a caller (or test) not yet wired to this check.
 *
 * Returns { kind, platform, pid, unit, scope?, mismatched, reason? }, kind one of:
 *   "system-unit"      Linux, port owned by a system-scope systemd unit
 *   "user-unit"        Linux, port owned by a user-scope systemd unit
 *   "launchd"          macOS, port is held by a process CONFIRMED to be the dev.ocp.proxy launchd
 *                      job (issue #239 — pid match against launchd's own bookkeeping, plus an
 *                      argv check; see classifyLaunchdJob/classifyLaunchdArgv)
 *   "no-unit"          a PID holds the port but isn't verified to be managed by any (systemd
 *                      unit | the dev.ocp.proxy launchd job) — a bare `node server.mjs`, most
 *                      likely, but on macOS also covers "label not registered", "label registered
 *                      but not running", and "label running under a DIFFERENT pid than the one
 *                      holding the port" — all collapse to this same terminal state rather than
 *                      each getting its own platform-only kind
 *   "foreign-process"  a real unit/job owns the port but its process is CONFIRMED not to be OCP's
 *                      server.mjs (issue #237 on Linux — e.g. nginx.service; issue #239 on macOS —
 *                      a launchd label whose registered argv doesn't invoke server.mjs)
 *   "not-listening"    the tool ran cleanly and found nothing bound to the port
 *   "unknown"          could not determine ownership (see `reason`) — must never
 *                       be treated as equivalent to "not-listening"
 */
export function resolveOwningUnit(probe = {}) {
  const platform = probe.platform || process.platform;
  const expectedUnit = probe.expectedUnit;

  if (platform === "darwin") {
    const listener = classifyLsofListener(probe.lsofOutput, {
      netstatConfirmsListener: !!probe.netstatConfirmsListener,
      netstatProbeFailed: !!probe.netstatProbeFailed,
    });
    if (listener.state === "unknown") {
      return { kind: "unknown", platform, pid: null, unit: null, mismatched: false, reason: listener.reason };
    }
    if (listener.state === "not-listening") {
      return { kind: "not-listening", platform, pid: null, unit: null, mismatched: false };
    }

    // issue #239: a confirmed listener is not proof it's dev.ocp.proxy — ask launchd what pid it
    // believes owns the ONE label this repo manages and compare against the pid actually holding
    // the port. probe.launchdPrintOutput === undefined means the caller never attempted this
    // probe at all — same legacy/back-compat convention as probe.cmdlineContent on the Linux side
    // (issue #237): skip the check, preserve pre-#239 behavior, instead of newly refusing
    // restarts that were "safe" before this field existed.
    if (probe.launchdPrintOutput === undefined) {
      return { kind: "launchd", platform, pid: listener.pid, unit: expectedUnit || "dev.ocp.proxy", mismatched: false };
    }
    const job = classifyLaunchdJob(probe.launchdPrintOutput);
    if (job.state === "unknown") {
      return { kind: "unknown", platform, pid: listener.pid, unit: null, mismatched: false, reason: job.reason };
    }
    if (job.state !== "running" || String(job.pid) !== String(listener.pid)) {
      // Not registered, registered-but-not-running, or registered with a DIFFERENT live pid — in
      // every case the process holding the port is not verified to be dev.ocp.proxy. Collapses to
      // the same "no-unit" terminal state Linux uses for "a pid holds the port but isn't in any
      // (verified) unit" — deliberately not a fourth, macOS-only kind.
      return { kind: "no-unit", platform, pid: listener.pid, unit: null, mismatched: false };
    }

    // issue #239 (mirroring #237): the label being registered and its pid matching the port's
    // holder is still not proof that process actually runs server.mjs — a hand-edited or
    // compromised plist could register the SAME label to launch a different program. Check the
    // job's own argv (from the SAME `launchctl print` call above — no separate probe) exactly
    // like classifyCmdlineOwner does for the Linux cgroup-resolved unit.
    const argvResult = classifyLaunchdArgv(job.argv);
    if (argvResult.state === "foreign") {
      return {
        kind: "foreign-process", platform, pid: listener.pid, unit: expectedUnit || "dev.ocp.proxy", mismatched: false,
        reason: `"${expectedUnit || "dev.ocp.proxy"}" (launchd, pid ${job.pid}) owns the OCP port, but its process is not OCP's server.mjs — ${argvResult.reason}`,
      };
    }

    return { kind: "launchd", platform, pid: listener.pid, unit: expectedUnit || "dev.ocp.proxy", mismatched: false };
  }

  const listener = classifySsListener(probe.ssOutput);
  if (listener.state === "unknown") {
    return { kind: "unknown", platform, pid: null, unit: null, mismatched: false, reason: listener.reason };
  }
  if (listener.state === "not-listening") {
    return { kind: "not-listening", platform, pid: null, unit: null, mismatched: false };
  }

  const cgroupResult = parseCgroupUnit(probe.cgroupContent);
  if (cgroupResult.state === "unknown") {
    return { kind: "unknown", platform, pid: listener.pid, unit: null, mismatched: false, reason: cgroupResult.reason };
  }
  if (cgroupResult.state === "no-unit") {
    return { kind: "no-unit", platform, pid: listener.pid, unit: null, mismatched: false };
  }

  // issue #237: a well-formed systemd unit name is not proof the process behind it is OCP's own
  // server.mjs — verify the actual running process before ever treating this as a restart
  // candidate. probe.cmdlineContent === undefined means the caller never attempted this probe at
  // all (skip the check, preserve pre-#237 behavior for callers not yet wired to it); a string or
  // null means it WAS attempted, and gets classified/treated-as-unknown respectively. See
  // classifyCmdlineOwner's own comment for the full three-state rationale.
  if (probe.cmdlineContent !== undefined) {
    const cmdlineResult = classifyCmdlineOwner(probe.cmdlineContent);
    if (cmdlineResult.state === "unknown") {
      return {
        kind: "unknown", platform, pid: listener.pid, unit: cgroupResult.unit, mismatched: false,
        reason: `resolved unit "${cgroupResult.unit}" via cgroup, but could not confirm the owning process is OCP's server.mjs — ${cmdlineResult.reason}`,
      };
    }
    if (cmdlineResult.state === "foreign") {
      return {
        kind: "foreign-process", platform, pid: listener.pid, unit: cgroupResult.unit, mismatched: false,
        reason: `"${cgroupResult.unit}" (${cgroupResult.scope}-scope) owns the OCP port, but its process is not OCP's server.mjs — ${cmdlineResult.reason}`,
      };
    }
  }

  const mismatched = !!expectedUnit && cgroupResult.unit !== expectedUnit;
  return {
    kind: cgroupResult.scope === "system" ? "system-unit" : "user-unit",
    platform,
    pid: listener.pid,
    unit: cgroupResult.unit,
    scope: cgroupResult.scope,
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
 * Throws — refusing to restart anything — for every case where guessing would
 * repeat issue #215 or worse:
 *   - "unknown": we could not determine what (if anything) owns the port. This
 *     used to not exist as a distinct outcome; ambiguous cases fell through to
 *     "not-listening" and silently ran the default command anyway.
 *   - "no-unit": something we can't identify holds the port; restarting a named
 *     unit here spawns a second process that can't bind — issue #215 itself.
 *   - "not-listening": review finding MED-7 on PR #221. This looks like the
 *     SAFEST case (nothing to collide with) but is actually the most dangerous:
 *     if the real production listener is a SYSTEM unit that happens to be down
 *     right now, falling back to the hard-coded default starts the OTHER
 *     (typically loopback-only) unit instead — and post-flight, which only
 *     curls 127.0.0.1, reports a clean SUCCESS while the host has silently lost
 *     LAN reachability. The one case this tooling cannot self-verify gets a
 *     refusal, not a convenient guess.
 *   - "system-unit" without a working, correctly-scoped privilege escalation
 *     path: restarting the user-level unit instead would again leave the real
 *     (system) listener untouched.
 *
 * opts.isRoot / opts.sudoAuthorized (review finding MED-4): NOPASSWD sudoers
 * entries are per-command ("deploy ALL=(root) NOPASSWD: /bin/systemctl restart
 * ocp.service"), so a generic `sudo -n true` probe is the wrong question and
 * both false-negatives (a correctly least-privilege-scoped sudoers rule fails
 * `sudo -n true`, aborting an upgrade that would have worked) and false to a
 * confusing remediation message. The caller is expected to have already asked
 * the RIGHT question — `sudo -n -l systemctl restart <unit>` for the SPECIFIC
 * resolved unit — and pass the answer in as `sudoAuthorized`. `isRoot` short-
 * circuits entirely: a process already running as uid 0 needs no sudo prefix
 * at all (and telling it to run `sudo` is actively wrong on a minimal image
 * that doesn't have sudo installed).
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

  if (owner.kind === "unknown") {
    throw new Error(
      `restart aborted: could not determine what (if anything) owns the OCP port — ${owner.reason}. ` +
      `Verify manually (\`ss -lptn\` / \`lsof -iTCP\` / \`cat /proc/<pid>/cgroup\` on Linux, ` +
      `\`launchctl print gui/$(id -u)/${opts.expectedUnit}\` on macOS, with elevated privileges if ` +
      `needed) before retrying. Guessing here is exactly issue #215's failure mode.`
    );
  }

  if (owner.kind === "not-listening") {
    // HIGH-A (PR #221 round-2 review): this refusal is correct for the UPGRADE path (below),
    // where a silent fallback risks starting the WRONG unit — the real LAN listener could be a
    // SYSTEM unit that's merely down, and post-flight (127.0.0.1-only) can't tell the
    // difference. On ROLLBACK the calculus inverts: the single most common reason to roll back
    // IS "the service is down"; the rollback path has no doctor health gate at all (unlike
    // upgrade); and rollback's own snapshot only ever restores opts.expectedUnit's config in
    // the first place (scripts/lib/snapshot.mjs) — there is no "other" unit it could
    // accidentally start instead of the real one. Refusing unconditionally here left a rollback
    // PERMANENTLY stuck: re-running hits this exact same "nothing is listening" state forever
    // (nothing about re-running changes it), and the message's own advice — "start the intended
    // unit manually" — named exactly the question this state has no way to answer. So on
    // rollback specifically (opts.allowNotListeningFallback), fall through to starting the
    // default unit with a loud warning instead of a permanent refusal; the upgrade path's
    // refusal is untouched.
    if (opts.allowNotListeningFallback) {
      warnings.push(
        `[restart] WARNING: nothing was listening on the OCP port before this rollback restart. ` +
        `Starting the default unit ("${opts.expectedUnit}") anyway: unlike the upgrade path, ` +
        `rollback has no doctor health gate and its own snapshot only ever restores ` +
        `"${opts.expectedUnit}"'s config in the first place (scripts/lib/snapshot.mjs), so there ` +
        `is no other candidate unit to weigh this against — refusing here would leave the ` +
        `rollback stuck (re-running hits this identical state). If a different unit is meant to ` +
        `own this port long-term, start it manually instead and ignore this one.`
      );
      if (owner.platform === "darwin") {
        return { action: "launchd", warnings, cmds: launchdCmds(opts) };
      }
      return { action: "user-unit", warnings, cmds: [{ cmd: `systemctl --user restart -- ${opts.expectedUnit}`, label: "restart" }] };
    }
    throw new Error(
      `restart aborted: nothing is currently listening on the OCP port, so there is nothing to ` +
      `confirm the correct restart target against. This is deliberately a refusal, not a fallback ` +
      `to the default unit ("${opts.expectedUnit}"): if the real production listener is a unit that ` +
      `happens to be down right now (e.g. a SYSTEM unit bound to a LAN address), silently starting ` +
      `the default (often loopback-only) unit instead would pass post-flight — which only checks ` +
      `127.0.0.1 — while silently losing LAN reachability. Start the intended unit manually and ` +
      `re-run, or confirm "${opts.expectedUnit}" really is correct here.`
    );
  }

  if (owner.kind === "no-unit") {
    // issue #239: on macOS this state ALSO covers "label not registered", "label registered but
    // not running", and "label running under a different pid than the port's holder" (all
    // collapsed into the same terminal kind by resolveOwningUnit's darwin branch) — the Linux
    // wording below names "systemd" and recommends a "/proc/<pid>/cgroup"-shaped remedy, neither
    // of which exists on macOS, so the message is platform-branched rather than reused verbatim.
    if (owner.platform === "darwin") {
      throw new Error(
        `restart aborted: PID ${owner.pid} holds the OCP port but is not confirmed to be managed ` +
        `by the "${opts.expectedUnit}" launchd job (issue #239 — a confirmed listener alone is not ` +
        `proof it's ours; launchd's own bookkeeping for that label either doesn't show it running, ` +
        `or shows a DIFFERENT pid than the one actually holding the port). Restarting ` +
        `"${opts.expectedUnit}" here would spawn a second, orphaned process that cannot bind the ` +
        `port — exactly issue #215. Stop PID ${owner.pid} manually (or bring it under launchd as ` +
        `"${opts.expectedUnit}") and re-run the upgrade.`
      );
    }
    throw new Error(
      `restart aborted: PID ${owner.pid} holds the OCP port but is not managed by any systemd unit ` +
      `(a bare "node server.mjs"?). Restarting "${opts.expectedUnit}" here would spawn a second, ` +
      `orphaned process that cannot bind the port — exactly issue #215. Stop PID ${owner.pid} manually ` +
      `(or bring it under systemd) and re-run the upgrade.`
    );
  }

  // issue #237 (Linux) / issue #239 (macOS): a real, well-formed unit/job name is not proof it's
  // OCP's own. Unlike `mismatched` (a NAME comparison against the hard-coded expectedUnit, which
  // only ever warns — see the warnings.push at the top of this function), this is a POSITIVE
  // confirmation from the owning process's own argv (read from /proc/<pid>/cmdline on Linux, from
  // `launchctl print`'s "arguments = { ... }" block on macOS — see classifyCmdlineOwner /
  // classifyLaunchdArgv) that it is definitely not server.mjs. This is the safety inverse of #215:
  // #215 restarted the wrong thing because the resolver guessed at an identity it had no basis
  // for; this restarts the wrong thing because the resolver correctly identifies a real unit/job
  // that simply isn't ours — bouncing an unrelated production service (nginx.service, or a
  // relabeled non-OCP launchd job) is outside OCP's legitimate blast radius regardless of
  // root/sudo authorization, so this refuses unconditionally, before any of the
  // system-unit/user-unit/launchd machinery below ever runs.
  if (owner.kind === "foreign-process") {
    // owner.reason (built by resolveOwningUnit) already names the unit/job, its scope, and the
    // argv evidence — no need to re-preface it with another "the OCP port is owned by X" here.
    // The verification commands are platform-branched: /proc/<pid>/cmdline and `ss` don't exist
    // on macOS, and lsof/launchctl don't exist on Linux.
    const verifyCmd = owner.platform === "darwin"
      ? `\`lsof -nP -iTCP:<port> -sTCP:LISTEN\` / \`launchctl print gui/$(id -u)/${opts.expectedUnit}\``
      : `\`ss -lptn\` / \`cat /proc/${owner.pid}/cmdline\``;
    throw new Error(
      `restart aborted: ${owner.reason}. Restarting an unrelated service this tooling does not ` +
      `manage is outside OCP's legitimate blast radius — refusing rather than repeating issue ` +
      `#215's failure mode in the opposite direction (see issue #237 / #239). Verify what's ` +
      `actually bound to this port (${verifyCmd}) and either free the port for OCP or point ` +
      `CLAUDE_PROXY_PORT elsewhere.`
    );
  }

  if (owner.kind === "launchd") {
    return { action: "launchd", warnings, cmds: launchdCmds(opts) };
  }

  if (owner.kind === "system-unit") {
    if (!UNIT_NAME_RE.test(owner.unit)) {
      // Unreachable given parseCgroupUnit's own validation, but this is the actual point
      // where the unit name is about to be concatenated into a shell command — re-checking
      // right here, not just upstream, is the point (review finding MED-5).
      throw new Error(`restart aborted: resolved unit name "${owner.unit}" failed validation — refusing to shell out with it.`);
    }
    if (opts.isRoot) {
      // MED-C (PR #221 round-2 review): "--" stops systemctl's getopt-style parser from
      // treating a leading-dash unit name (e.g. "-Hattacker@example.com.service") as another
      // OPTION rather than the restart argument. UNIT_NAME_RE already rejects a leading "-" —
      // this is defense in depth at the actual shell-out boundary, the same posture MED-5 took
      // for shell-metacharacter injection.
      return { action: "system-unit", warnings, cmds: [{ cmd: `systemctl restart -- ${owner.unit}`, label: "restart" }] };
    }
    if (!opts.sudoAuthorized) {
      throw new Error(
        `restart aborted: "${owner.unit}" is a SYSTEM unit and requires ` +
        `"sudo systemctl restart -- ${owner.unit}", but that specific command is not authorized ` +
        `non-interactively ("sudo -n -l systemctl restart -- ${owner.unit}" failed). Run it ` +
        `manually and re-run the upgrade, or grant it explicitly (e.g. "deploy ALL=(root) ` +
        `NOPASSWD: /bin/systemctl restart -- ${owner.unit}") — restarting the user-level unit ` +
        `instead would repeat issue #215.`
      );
    }
    return { action: "system-unit", warnings, cmds: [{ cmd: `sudo systemctl restart -- ${owner.unit}`, label: "restart" }] };
  }

  if (owner.kind === "user-unit") {
    if (!UNIT_NAME_RE.test(owner.unit)) {
      throw new Error(`restart aborted: resolved unit name "${owner.unit}" failed validation — refusing to shell out with it.`);
    }
    return { action: "user-unit", warnings, cmds: [{ cmd: `systemctl --user restart -- ${owner.unit}`, label: "restart" }] };
  }

  throw new Error(`restart aborted: unrecognized owner.kind "${owner.kind}"`);
}
