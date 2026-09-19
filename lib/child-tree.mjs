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
// 'CLOSE', NOT 'EXIT' — this is the load-bearing choice and the reason this helper exists rather
// than a copy of the disconnect site's `proc.once("exit", …)`. In the #474 stuck-pipe shape the
// parent has ALREADY exited while the grandchild still holds the pipe; that is precisely when the
// escalation must still fire. Clearing on 'exit' would cancel it in the one case it was written
// for. 'close' fires only when the stdio streams are closed too, i.e. when the whole tree has
// drained — which is both the condition that makes the escalation pointless and the condition
// that releases the pgid.
//
// `kill` is injected rather than imported so this is reachable from the suite with a recording
// fake; production binds killChildTree, so behaviour is identical to the inline original.
//
// RULE 5 — the 5 000 ms default is not a tuned value: it mirrors what all four kill sites in
// server.mjs already used, and its only contract is "longer than a healthy child takes to die on
// SIGTERM". It stops being the right number if a kill site ever needs to outlive a child that
// legitimately takes longer to flush; at that point the caller passes its own ms rather than
// this default moving.
export function scheduleKillEscalation(proc, kill, ms = 5000) {
  const timer = setTimeout(() => kill(proc, "SIGKILL"), ms);
  // A pending escalation must never be the reason the process stays alive; the shutdown sweep
  // owns that case and is itself unref'd. Mirrors the disconnect site (#111), which has always
  // unref'd its timer.
  timer.unref();
  proc.once("close", () => clearTimeout(timer));
  return timer;
}
