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
// non-darwin is left behaviorally UNCHANGED from the pre-#246 body (still a bare `lsof`
// call): this issue's own live verification and scripts/upgrade.mjs's own established
// precedent (#233) both scoped the absolute-path fix to macOS only -- Linux's equivalent
// listener check in restart-unit.mjs uses `ss`, not `lsof`, and was never audited for this
// defect. Inventing new, UNVERIFIED Linux-specific netstat-flag handling here risks a real
// regression: GNU netstat's `-p` flag means "show PID/program name", not "protocol filter"
// the way BSD/macOS netstat's `-p tcp` does -- reusing the darwin cross-check's command
// shape unconditionally on Linux would misparse and could make netstat itself fail there,
// which (fail-closed) would make the FIRST-EVER start on a fresh Linux host -- the single
// most common invocation -- refuse to start. Left as a scope note for a follow-up issue if
// Linux's bare `lsof`/`ss` here turns out to share this same restricted-PATH defect.
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

import { existsSync as realExistsSync } from "node:fs";

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
