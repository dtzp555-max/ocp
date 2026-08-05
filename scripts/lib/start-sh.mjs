// scripts/lib/start-sh.mjs — builds the standalone `start.sh` launcher setup.mjs writes
// (Step 4), and the small absolute-path-preference helper setup.mjs's Step 8 post-install
// bind-check reuses. Extracted out of setup.mjs so this port-check logic (issue #246) can
// be driven by injected fake lsof/netstat binaries in tests -- setup.mjs itself is the
// real installer and this repo's test suite must never execute it directly (see
// scripts/lib/install-autostart.mjs's own header for the identical rationale, and
// AGENTS.md's "NEVER run setup.mjs" constraint, which this file's own tests honor by
// never importing setup.mjs at all).
//
// Issue #246 (same defect family as #233/#236, found during the independent review of PR
// #240): the pre-#246 body called `lsof` BARE (no absolute path) at setup.mjs:293
// (embedded in this file's darwin branch below) and setup.mjs:426 (the JS bind-check --
// see resolveBinaryPath below), and :293 also redirected BOTH stdout+stderr to /dev/null
// (`&>/dev/null`). A restricted PATH (a launchd job's default environment, a minimal
// automation shell) can omit /usr/sbin entirely -- verified LIVE this session, in the
// exact shell driving this fix:
//   $ which lsof; echo $?        -> "lsof not found", 1
//   $ which netstat; echo $?     -> "netstat not found", 1
//   $ /usr/sbin/lsof -v          -> succeeds (prints version info)
// so bare `lsof`/`netstat` fail as "command not found" in exactly this kind of shell, and
// the original `if ! lsof ... &>/dev/null` could not tell that apart from lsof running
// cleanly and finding nothing -- both collapse to "not listening". :293's check gates
// whether start.sh launches a SECOND server.mjs via nohup, so a false "not listening"
// silently starts a duplicate process on top of a real (possibly root-owned) listener --
// the same failure class #233 fixed for scripts/upgrade.mjs's own restart-resolution lsof
// call (see that file's mapLsofFailureToProbeValue for the full live evidence table this
// fix's darwin branch below mirrors).
//
// Scope decision (this PR is explicitly asked to justify, not just copy #233 wholesale):
// darwin gets the FULL fix -- absolute lsof/netstat paths (each with a same-host
// existsSync-equivalent `[ -x ... ]` fallback to the bare name, so a host where
// /usr/sbin/lsof genuinely does not exist -- unverified here, out of scope -- is no worse
// off than the pre-fix behavior), PLUS the same netstat cross-check
// scripts/upgrade.mjs's mapLsofFailureToProbeValue uses for lsof's ambiguous (exit 1,
// empty stdout) signature, which is indistinguishable between "genuinely nothing
// listening" and "a listener lsof can't identify the owner of" (e.g. a root-owned OCP
// LaunchDaemon -- a supported shape; see scripts/doctor.mjs's multi-unit-risk check for
// /Library/LaunchDaemons). The cross-check earns its complexity here specifically because
// :293 gates an ACTION (spawning a second process) -- the same stakes that justified it in
// scripts/upgrade.mjs.
//
// non-darwin was left behaviorally unchanged by #246: this issue's own live verification and
// scripts/upgrade.mjs's established precedent (#233) both scoped the absolute-path fix to
// macOS. That paragraph closed by naming its own follow-up -- "left as a scope note for a
// follow-up issue if Linux's bare command here turns out to share this same restricted-PATH
// defect" -- and #298 is that follow-up: it does. `ss` lives at /usr/sbin/ss on Debian and
// Raspberry Pi OS, so a PATH without /usr/sbin loses it exactly as it loses lsof, and two of
// this project's four serving hosts are Linux. buildBindCheckCommand's linux branch now takes
// the same resolveBinaryPath treatment, with the same fallback direction.
//
// (Correcting this header's own earlier text while touching it: the pre-#298 note described
// the non-darwin branch as "still a bare `lsof` call". It never was -- the branch emits `ss`.
// The conclusion the sentence supported was right; the identifier in it was not, and #298's
// own filing had to correct the same slip in the review that prompted it.)
//
// What is deliberately NOT extended to Linux, and stays scoped out: the netstat cross-check.
// GNU netstat's `-p` means "show PID/program name", not BSD/macOS netstat's "protocol filter"
// `-p tcp` -- reusing the darwin cross-check's command shape unconditionally on Linux would
// misparse and could make netstat itself fail there, which (fail-closed) would make the
// FIRST-EVER start on a fresh Linux host -- the single most common invocation -- refuse to
// start. Absolute-path resolution carries no such risk: it is a path preference with a
// fallback to the exact prior behavior, not a new command shape.
//
// setup.mjs:426's JS bind-check is a DIFFERENT call path with different stakes (per this
// issue's own instruction to judge, not copy wholesale): it runs only AFTER the health
// check has already reported success (`res.ok`), its result is purely a cosmetic
// diagnostic line ("bind: ..."), and `verified` is set to `true` unconditionally right
// after it regardless of outcome -- a failure here can, at worst, leave that one line
// blank instead of populated. resolveBinaryPath below gives it the same absolute-path
// preference (which alone fixes the restricted-PATH case in the common, non-privilege-gap
// scenario -- the same scenario :293 fixes), but does NOT get the netstat cross-check:
// that would add real complexity for a text-only line whose failure mode is already
// non-functional, and the issue's own text agrees ("its own blast radius is smaller").
//
// Second half of issue #246 (this fix): the ABSOLUTE-PATH half of :426 was fixed alongside
// :293 above, but two things stayed broken there, matching the issue's own text verbatim:
// (1) BOTH branches of the bind-check command redirected the underlying tool's own stderr to
// /dev/null, and (2) the surrounding `catch {}` was completely empty, discarding a genuinely-
// nothing-there empty match and "lsof/ss itself could not run at all" identically. Verified
// independently (not just taken on the issue's word) by tracing every assignment to `verified`
// in setup.mjs's Step 8 block: it is set `true` unconditionally immediately after the bind-
// check's try/catch, regardless of what happened inside it -- nothing downstream ever branches
// on this block's outcome, confirming it stays a purely cosmetic diagnostic. Sized accordingly:
// buildBindCheckCommand()/classifyBindCheck() below turn "any failure -> total silence" into "a
// real tool-execution fault gets ONE honest diagnostic line, a genuine empty match stays exactly
// as silent as before" -- no netstat cross-check, no privilege-gap classifier, nothing that
// would only earn its complexity if something downstream actually acted on the distinction.

import { existsSync as realExistsSync } from "node:fs";
import { execSync as realExecSync } from "node:child_process";

// Prefers `absolutePath` when it exists on this host, falling back to the bare
// `fallbackName` (relying on $PATH, exactly the pre-#246 behavior) otherwise -- so a host
// where the absolute path genuinely does not exist (e.g. an unverified Linux layout) is
// never worse off than before this fix. `existsSyncFn` is injectable so tests can drive
// both branches without touching the real filesystem.
export function resolveBinaryPath(absolutePath, fallbackName, existsSyncFn = realExistsSync) {
  return existsSyncFn(absolutePath) ? absolutePath : fallbackName;
}

// The darwin-only lsof+netstat listener check (issue #246). Returns a bash snippet that
// sets `listening` to 1 (something is there, or we cannot safely tell) or 0 (confirmed
// nothing is there). Column-4 extraction and the netstat LISTEN-row suffix match both use
// bash BUILTINS ONLY (`read`'s own word-splitting + a `case` glob) -- no `awk`, no other
// external command, no PATH lookup at all -- matching scripts/upgrade.mjs's own column-4
// "ends with .PORT" comparison (netstatHasListenerOnPort) one-for-one but in bash form.
// (An earlier revision used `awk '{print $4}'` here; independent review of PR #269 found
// that `awk` call was itself a bare external command inside this fail-closed cross-check,
// so a host missing `awk` made the WHOLE cross-check fail OPEN under exactly the
// restricted-PATH condition this fix exists to handle -- see the `read` line below for the
// full writeup.)
function darwinListeningCheck({ lsofPath, netstatPath }) {
  return `LSOF=${JSON.stringify(lsofPath)}
[ -x "$LSOF" ] || LSOF=lsof
NETSTAT=${JSON.stringify(netstatPath)}
[ -x "$NETSTAT" ] || NETSTAT=netstat

lsof_out=$("$LSOF" -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
lsof_status=$?

# Fail-closed default (issue #246, mirroring scripts/upgrade.mjs's mapLsofFailureToProbeValue):
# when genuinely unsure, assume something might be listening rather than risk a duplicate
# server.mjs. Only the two branches below can ever flip this to 0.
listening=1
if [ "$lsof_status" -eq 0 ] && [ -n "$lsof_out" ]; then
  listening=1
elif [ "$lsof_status" -eq 1 ] && [ -z "$lsof_out" ]; then
  # lsof's own "nothing matched" signature (exit 1, empty stdout) is indistinguishable
  # from a listener lsof cannot identify the owner of (e.g. a root-owned OCP process) --
  # cross-check with netstat, which reports LISTEN rows regardless of the owning uid.
  netstat_out=$("$NETSTAT" -an -p tcp 2>/dev/null)
  netstat_status=$?
  netstat_confirms=0
  if [ "$netstat_status" -eq 0 ]; then
    while IFS= read -r netstat_line; do
      case "$netstat_line" in
        *LISTEN*)
          # Column 4 (Local-Address) via bash's OWN word-splitting, not 'awk' (independent
          # review, PR #269): an 'awk' call here was itself a BARE external command inside
          # this fail-closed cross-check -- under the exact restricted-PATH condition this
          # whole fix exists to handle, 'awk' failing silently left netstat_col4 empty,
          # which never matches "*.$PORT" and made netstat_confirms stay 0 -- i.e. the
          # cross-check failed OPEN (concluded "not listening"), not closed, on a host
          # missing 'awk'. 'read' is a bash BUILTIN: no external binary, no PATH lookup, so
          # this cross-check now has zero remaining dependencies on anything resolvable
          # via $PATH at all. Extra fields beyond the 4th collect into the trailing
          # variable and are unused.
          read -r _netstat_proto _netstat_recvq _netstat_sendq netstat_col4 _netstat_rest <<<"$netstat_line"
          case "$netstat_col4" in
            *".$PORT") netstat_confirms=1 ;;
          esac
          ;;
      esac
    done <<<"$netstat_out"
  fi
  if [ "$netstat_status" -ne 0 ]; then
    listening=1 # netstat itself failed to run -- cannot confirm either way, fail closed
  elif [ "$netstat_confirms" -eq 1 ]; then
    listening=1 # privilege-gap case: a real listener lsof could not identify
  else
    listening=0 # netstat ran cleanly and found nothing -- genuinely not listening
  fi
fi`;
}

// The pre-#246 non-darwin body, restructured (not rewritten) to funnel into the same
// shared `listening` variable the darwin branch above uses, so buildStartSh's final
// start/already-running block is written once instead of duplicated per platform.
// Functionally identical to the original `if ! lsof -i :$PORT -sTCP:LISTEN &>/dev/null`:
// lsof succeeding (exit 0, something matched) -> listening=1 -> "already running"; lsof
// failing for ANY reason (no match OR missing binary, exactly as before) -> listening=0 ->
// start. Deliberately NOT given the absolute-path treatment -- see this file's header.
function nonDarwinListeningCheck() {
  return `if lsof -i :"$PORT" -sTCP:LISTEN &>/dev/null; then
  listening=1
else
  listening=0
fi`;
}

// Builds the full start.sh text setup.mjs's Step 4 writes to disk. `platform` and the two
// binary paths are injectable (defaulting to production values) purely for testability --
// setup.mjs's own call site never overrides them.
export function buildStartSh({
  port,
  serverPath,
  logDir,
  platform = process.platform,
  lsofPath = "/usr/sbin/lsof",
  netstatPath = "/usr/sbin/netstat",
}) {
  const listeningCheck = platform === "darwin"
    ? darwinListeningCheck({ lsofPath, netstatPath })
    : nonDarwinListeningCheck();

  return `#!/bin/bash
# Start OCP (Open Claude Proxy) if not already running
PORT=\${CLAUDE_PROXY_PORT:-${port}}

${listeningCheck}

if [ "$listening" -eq 0 ]; then
  unset CLAUDECODE
  nohup node "${serverPath}" \\
    >> "${logDir}/claude-proxy.log" \\
    2>> "${logDir}/claude-proxy.err.log" &
  echo "claude-proxy started on port $PORT (pid $!)"
else
  echo "claude-proxy already running on port $PORT"
fi
`;
}

// Pure command-string builder for setup.mjs's Step 8 post-install bind-check (issue #246,
// second half). No execution happens here -- classifyBindCheck() below is the only caller
// that actually runs the returned string -- so this is testable with a plain return-value
// assertion, no subprocess needed. Never appends `2>/dev/null` (or any other stderr redirect)
// on EITHER platform branch: that redirect is the literal remaining defect the issue
// describes for the old setup.mjs:426 body -- it threw the underlying tool's own stderr away,
// which is exactly what made "lsof/ss itself is broken" indistinguishable from "ran fine,
// found nothing" at the call site. `existsSyncFn` threads through to resolveBinaryPath() so
// tests can pick either branch deterministically regardless of what is actually installed on
// the host running the suite.
//
// Independent review round 1 (MED-2): the linux branch used to be `ss -tlnp | grep ':${port}'`.
// A `| grep` pipe reports GREP's own exit status, not `ss`'s -- verified live: `ssnotreal -tlnp
// | grep :N` under both bash and dash exits 1 (grep's own "no match" status), never 127, even
// though `ss` itself never ran. That made classifyBindCheck()'s exit-127/126 check dead code on
// Linux, and the port-match filtering is now done in JS (ssLineMatchesPort, below) against the
// UNFILTERED `ss -tlnp` output instead, so the real exit status of `ss` itself survives.
// (Rejected alternative, verified live and NOT viable: `sh -o pipefail` -- dash, which is
// `/bin/sh` on this project's own documented Linux hosts -- Debian/Ubuntu/Raspberry Pi OS --
// rejects `-o pipefail` outright ("Illegal option"), which would break the bind-check on every
// single run there, not just the missing-binary case.)
// Issue #298: `resolveBinaryPath` -- the restricted-PATH protection #246 added -- was applied to
// the darwin branch only; the linux branch emitted a bare `ss`. On Debian and Raspberry Pi OS
// `ss` lives at /usr/sbin/ss, so a PATH without /usr/sbin loses it, identical in shape to the
// `lsof` case #246 was filed for. classifyBindCheck() then reports "could-not-run" -- honest, but
// it is a diagnosis of the environment where an absolute path would simply have worked, and this
// is the branch that runs on the majority of this project's own serving hosts.
//
// The fallback direction matters and matches darwin's: prefer the absolute path when it exists,
// otherwise the bare name, so a host with a different layout is never worse off than before.
export function buildBindCheckCommand({ port, platform = process.platform, lsofPath = "/usr/sbin/lsof", ssPath = "/usr/sbin/ss", existsSyncFn = realExistsSync }) {
  return platform === "linux"
    ? `${resolveBinaryPath(ssPath, "ss", existsSyncFn)} -tlnp`
    : `${resolveBinaryPath(lsofPath, "lsof", existsSyncFn)} -nP -iTCP:${port} -sTCP:LISTEN`;
}

// Matches one line of `ss -tlnp` output against a target port (issue #246, second half, MED-2).
// `ss`'s "Local Address:Port" column format varies (IPv4 `0.0.0.0:PORT` / `*:PORT`, IPv6
// `[::]:PORT` / `*:PORT`), so this splits on the LAST ':' rather than assuming a fixed prefix
// shape -- correctly handles IPv6's own embedded colons. Anchored on the FULL numeric suffix
// (not a substring/`.includes(':PORT')` check), so an adjacent port that merely contains our
// port's digits (e.g. target port 8080 vs an unrelated real listener on 18080) is never misread
// as a match -- mirrors darwinListeningCheck()'s own netstat suffix-anchoring guard (the bash
// `case *".$PORT")` above) in JS form, applied to `ss`'s different column layout.
function ssLineMatchesPort(line, port) {
  const cols = line.trim().split(/\s+/);
  if (cols[0] !== "LISTEN") return false;
  const localAddr = cols[3];
  if (!localAddr) return false;
  const idx = localAddr.lastIndexOf(":");
  if (idx === -1) return false;
  return localAddr.slice(idx + 1) === String(port);
}

// Runs buildBindCheckCommand()'s command via an injectable execFn (defaulting to the real
// execSync) and classifies the outcome into exactly three kinds (issue #246, second half).
// setup.mjs's Step 8 bind-check used to collapse every failure -- a genuine empty match AND
// lsof/ss itself failing to execute -- into the same silent blank line, via a bare `catch {}`
// sitting on top of a command that had already thrown its own stderr away with
// `2>/dev/null`. This restores the distinction the operator needs WITHOUT changing anything
// downstream: see this function's call site in setup.mjs, where `verified` is set true
// unconditionally right after this block runs regardless of its outcome (traced end-to-end
// for this fix -- nothing reads this function's return value except the one console.log/
// warn() line at that call site), which is why this intentionally does NOT get
// darwinListeningCheck()'s netstat privilege-gap cross-check above: that earns its complexity
// only when something downstream actually acts on the distinction, and here nothing does.
//
//   - "found":         the tool ran and matched something -- print `line`.
//   - "empty":         the tool ran fine and found nothing -- unchanged from today's silence.
//   - "could-not-run": the tool itself never produced a real "no match" -- surface `detail`.
//
// `stdio: ["ignore", "pipe", "pipe"]` is REQUIRED here, not decorative (independent review
// round 1, MED-1): Node's execSync, given no `stdio` option at all, inherits the child's
// stderr to THIS process's own real stderr in addition to (on the throw path) capturing it
// into `e.stderr` -- verified live, on BOTH the success and throw paths, with plain
// `execSync(cmd, { encoding: "utf-8" })`. Left as the default, that silently broke the
// "empty" contract documented two paragraphs up: an "empty" or even "found" classification is
// NOT actually silent if the underlying tool wrote anything to its own stderr along the way
// (a permission warning, a deprecation notice, anything) -- it leaks straight to the
// installer's console, unprefixed, indistinguishable from real program output. Explicit
// `stdio: ["pipe","pipe","pipe"]`-equivalent options fully suppress the inherit path while
// leaving `e.stderr` capture on the throw path and the stdout return value on success both
// intact (verified live, same script).
//
// The empty/could-not-run boundary is inherently heuristic: Node's execSync collapses "tool
// ran, exited nonzero with nothing to say" (lsof/grep's own plain "no match" exit) and "the
// shell could not even start the tool" into the same thrown-error shape. Classified here by
// exit status 127/126 (POSIX "command not found" / "found but not executable") or a small set
// of shell-level phrases in the surfaced text -- the same style scripts/upgrade.mjs's
// mapLsofFailureToProbeValue already uses for this repo's other lsof-failure classifiers.
// The phrase list matches bare `\bnot found\b`, not only `"command not found"` (independent
// review round 1, MED-2): dash -- `/bin/sh` on this project's own documented Linux hosts --
// phrases a missing command as `sh: 1: ssnotreal: not found`, WITHOUT the word "command" at
// all, verified live against a real `/bin/dash`; the narrower phrase silently missed exactly
// the single most realistic could-not-run case on Linux (`ss` not installed).
// Anything else (including no status at all, e.g. lsof/grep's own plain "no match" exit)
// stays "empty" -- the unchanged, pre-#246(second-half) silent case.
export function classifyBindCheck({ port, platform = process.platform, lsofPath = "/usr/sbin/lsof", ssPath = "/usr/sbin/ss", existsSyncFn = realExistsSync, execFn = realExecSync }) {
  const cmd = buildBindCheckCommand({ port, platform, lsofPath, ssPath, existsSyncFn });
  try {
    const out = execFn(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (platform === "linux") {
      const match = out.split("\n").find((line) => ssLineMatchesPort(line, port));
      return match ? { kind: "found", line: match.trim() } : { kind: "empty" };
    }
    return out ? { kind: "found", line: out.split("\n")[0] } : { kind: "empty" };
  } catch (e) {
    const text = String(e.stderr || e.message || "").trim();
    const couldNotRun = e.status === 127 || e.status === 126
      || /\bnot found\b|no such file or directory|permission denied|enoent/i.test(text);
    return couldNotRun
      ? { kind: "could-not-run", detail: text.split("\n")[0] || (e.status != null ? `exit ${e.status}` : "unknown error") }
      : { kind: "empty" };
  }
}
