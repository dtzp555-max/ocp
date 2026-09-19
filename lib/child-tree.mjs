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
// POSIX only. On win32 a negative pid is not addressable and killChildTree falls back to
// proc.kill(), which Node turns into a no-op once the child is reaped — so win32 has no
// stale-pgid hazard and needs no gate. Returning false there keeps the pre-#500 shape.
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
