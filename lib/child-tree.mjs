// Escalation timing for a child process tree that has been asked to die.
//
// #474 made every kill site signal the whole process GROUP (process.kill(-pid)) so that a
// grandchild which inherited the stdout pipe dies with its parent. Each of those sites arms a
// SIGKILL escalation 5 s after the initial SIGTERM. #500 is about that timer: two of the sites
// armed it with a bare setTimeout that was never cleared and never unref'd.
//
// WHY THIS MATTERS. killChildTree's group kill is a RAW syscall with no liveness check — unlike
// proc.kill(), which Node turns into a no-op once the child has been reaped. A process group
// outlives its leader (measured: with the parent reaped, kill(pid,0) gives ESRCH while
// kill(-pid,0) still reports the group alive), which is exactly why #474 works. But once the
// last member exits, the group is gone and its pgid is released for REUSE. An uncleared timer
// therefore fires a SIGKILL at a pgid that may by then belong to someone else, and a group kill
// on a pgid we do not own succeeds silently rather than throwing.
//
// Measured on the normal path: 'close' fires ~1 ms after the SIGTERM and the group is already
// ESRCH at that moment, so the timer would otherwise sit for the remaining ~4999 ms per request
// holding both a closure over `proc` and a stale pgid. Since #478 the tool-quiesce site runs on
// every agent request, so that was one such window per request.
//
// THE CANCEL CONDITION IS AN EMPTY GROUP, AND 'close' IS ONLY THE PROMPT TO RE-CHECK IT.
// Two wrong answers were considered and both are reachable:
//
//   'exit'  — fires while a pipe-holding grandchild is still alive, i.e. in the #474 stuck-pipe
//             shape itself. Clearing on 'exit' (what the disconnect site does, and the obvious
//             thing to copy) would cancel the one kill #474 exists for.
//   'close' — fires when the direct child is reaped AND its pipes are released. That is NOT the
//             same as "the group is empty": a member that redirected its fds away from the
//             inherited pipes (a backgrounded tool subprocess) survives 'close' and is precisely
//             what the escalation should still kill. Cancelling on 'close' alone would trade the
//             stale-pgid kill for a silent process leak. (Review finding on #501.)
//
// So 'close' wakes us and the group liveness check decides. That check is also the condition
// that releases the pgid, which is what makes cancelling safe rather than merely convenient.
//
// `kill` is injected rather than imported so this is reachable from the suite with a recording
// fake; production binds killChildTree, so behaviour is identical to the inline original.
//
// RULE 5 — the 5 000 ms default is not a tuned value: it mirrors what all four kill sites in
// server.mjs already used, and its only contract is "longer than a healthy child takes to die on
// SIGTERM". It stops being the right number if a kill site ever needs to outlive a child that
// legitimately takes longer to flush; at that point the caller passes its own ms rather than
// this default moving.
import { execFile } from "node:child_process";

// POSIX only. win32 has no process groups to ask about, so this returns false there and the
// timer is never cancelled on 'close' at the sites that arm it. That is safe only because killChildTree (below) declines
// to signal an exited child on win32: its `taskkill /PID` is, like the POSIX group kill, a raw
// call on a number that the OS may already have handed to someone else. An earlier version of
// this comment said win32 needed no gate because the fallback was proc.kill(); since #529 it is
// taskkill, and that statement became false (external review of 566b936, finding M1).
//
// EPERM is deliberately treated the same as ESRCH. If the pgid has been reused by a process we
// may not signal, "cannot signal it" and "it is gone" both mean the same thing for our purposes:
// do not send SIGKILL. The failure direction is toward NOT killing a stranger.
function defaultGroupEmpty(pid) {
  if (pid == null || process.platform === "win32") return false;
  try { process.kill(-pid, 0); return false; }  // somebody is still in our group
  catch { return true; }                        // ESRCH / EPERM: not ours to kill any more
}

// `groupEmpty` is injected so the suite can drive both sides of the gate without real processes;
// production binds the syscall above (the makeResolveSpawnToken seam, lib/spawn-token.mjs).
export function makeKillEscalation({ groupEmpty = defaultGroupEmpty } = {}) {
  return function scheduleKillEscalation(proc, kill, ms = 5000) {
    // Arming against an already-released pgid would BE the defect this helper exists to prevent,
    // and a 'close' that has already fired will never fire again to clear it.
    if (groupEmpty(proc.pid)) return null;
    const timer = setTimeout(() => kill(proc, "SIGKILL"), ms);
    // A pending escalation must never be the reason the process stays alive; the shutdown sweep
    // owns that case and is itself unref'd. Mirrors the disconnect site (#111).
    timer.unref();
    // 'close' is the PROMPT to re-check, not the answer. It means the direct child is reaped and
    // its pipes are released — NOT that the group is empty: a member that redirected its fds away
    // from the inherited pipes survives 'close' and is exactly what the escalation should still
    // kill. Cancel only when the group is genuinely gone, which is the same condition that
    // releases the pgid. (Review finding, #501.)
    proc.once("close", () => { if (groupEmpty(proc.pid)) clearTimeout(timer); });
    return timer;
  };
}

export const scheduleKillEscalation = makeKillEscalation();

// #474: kill the child's ENTIRE process group, not just the direct child. Moved here from
// server.mjs so the win32 branch is reachable from the suite; the POSIX branch is unchanged.
//
// Why a group: with spawnOpts.detached (set in spawnClaudeProcess, POSIX only) the child
// is a session leader, so proc.pid doubles as its pgid and process.kill(-pid) reaches every
// process in that group — including a grandchild that inherited the stdout pipe. That grandchild
// is the exact shape that kept 'close' (and with it the client request) open forever: the
// timer's SIGTERM/SIGKILL landed on the parent, the parent died, the pipe stayed open, and the
// request hung until the client gave up (issue #474, measured on v3.37.0: client silent past
// 240 s while the log already showed request_timeout + claude_exit).
//
// A throw here means either the group was already fully reaped (the kill landed — nothing more
// to do) or the group was never created (detached failed to apply). In BOTH cases we fall
// through to the per-process kill below: in the first it is a harmless no-op, in the second it
// still reaches the direct child instead of leaking it. win32: `detached` means something
// different there and a negative pid is not killable, so the group path is POSIX-only.
//
// `platform`, `execFile` and `killGroup` are injected for the suite only; production binds the
// real ones, and a test pins that the exported binding does.
export function makeKillChildTree({
  platform = process.platform,
  execFile: runFile = execFile,
  killGroup = (pid, sig) => process.kill(-pid, sig),
} = {}) {
  return function killChildTree(proc, sig) {
    // win32 has no process groups: `taskkill /T` walks the tree by parent pid instead, so it must
    // run while claude.exe is still alive (its children are only found through it). Forced (/F)
    // whatever `sig` asked for, since Windows has no graceful-signal equivalent for a console-less
    // child. The per-process kill runs after it, as the fallback when taskkill itself fails.
    if (proc.pid != null && platform === "win32") {
      // Once the child has exited, proc.pid is just a number. Node sets exitCode/signalCode in
      // the same step that closes the process handle (measured: both null with the handle open
      // before 'exit', one set with the handle gone at 'exit'), and Windows may reuse a pid once
      // no handle to it remains — so after that point `taskkill /PID <pid> /T /F` can force-kill
      // an unrelated process and its whole tree. The escalation timer reaches this after a normal
      // exit at both sites that arm it (timeout, tool quiesce), because defaultGroupEmpty cannot
      // cancel it on win32. Nothing is lost by declining: the dead parent can no longer lead
      // taskkill to its children anyway (measured by the review on a Windows 11 VM: with the
      // parent exited, `taskkill /PID <parent> /T /F` exits 128 "not found" and a surviving
      // detached grandchild stays alive; with the parent alive, the same command kills it).
      if (proc.exitCode != null || proc.signalCode != null) return;
      proc.killed = true;
      runFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 },
        () => { try { proc.kill(sig); } catch { /* already gone */ } });
      return;
    }
    if (proc.pid != null) {
      try {
        killGroup(proc.pid, sig);
        proc.killed = true; // honor the flag's contract: a signal WAS sent (see the #111 guard)
        return;
      } catch {
        // ESRCH means EITHER the whole group was already reaped (the kill landed — nothing more to
        // do) OR the group was never created (detached failed to take effect and the child is
        // alive in its INHERITED group). In the second case giving up would be a silent leak, so
        // fall through to the per-process kill below: at least it reaches the direct child.
      }
    }
    try { proc.kill(sig); } catch { /* already gone */ }
  };
}

export const killChildTree = makeKillChildTree();
