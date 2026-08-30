// Boot-time capability probe for the `claude` CLI (#455).
//
// THE PROBLEM. OCP spawns `claude` on every request and has no version or capability gate for it.
// #453 sharpened that by depending on `--system-prompt-file`, which does not appear in the option
// list of `claude --help` at all -- so a reader cannot even confirm it exists. If a host's `claude`
// lacks any flag OCP passes, EVERY request 500s. The failure is loud and self-naming (the child's
// stderr reaches the client verbatim), but it is loud PER REQUEST and silent AT BOOT: the proxy
// starts happily, and the first person to notice is a user rather than the operator.
//
// WHY A CAPABILITY PROBE AND NOT A VERSION FLOOR. A version floor is a hard-coded number, and
// 规则 5 asks what makes it stop being true. Nobody has measured the actual minimum -- doing so
// means installing old CLI builds -- so any floor written today would be a guess wearing a
// number. It would also be blind to the case that matters most: an upstream release that keeps
// the version climbing while REMOVING or RENAMING a flag. A capability probe asks the question
// the code actually depends on, and cannot go stale.
//
// THE INSTRUMENT. `claude` parses options before it validates their values, so pointing
// `--system-prompt-file` at a path that does not exist gives two cleanly distinguishable
// outcomes -- and both are `exit 1`, so THE MESSAGE DISCRIMINATES AND THE EXIT CODE DOES NOT.
// Measured on claude 2.1.250, all three argv shapes OCP can build:
//
//   every flag known        -> `Error: System prompt file not found: <path>`      0.18-0.21s
//   any flag unknown        -> `error: unknown option '--no-session-persistenceX'`  0.11s
//
// No model turn is started -- the CLI stops at argument validation -- so the probe costs no
// quota. That was measured rather than assumed: the run returns in ~0.2s, which is not enough
// for an upstream call.
//
// FAIL-CLOSED ONLY ON POSITIVE EVIDENCE. There are three verdicts, not two, and the asymmetry is
// deliberate. `absent` requires an OBSERVED `unknown option` naming a flag; everything else that
// is not a recognised success -- a missing binary, a timeout, an unrecognised message -- is
// `inconclusive`, which warns and boots. So a future `claude` that reworded the file-not-found
// message degrades this gate to a warning rather than bricking a fleet. Ask of every branch
// whether it fires because something was OBSERVED or because something was ABSENT (AGENTS.md);
// the only branch that refuses a boot here fires on observation.
//
// EXPIRY CONDITION for the two literals below: they are `claude`'s wording, not OCP's. If
// upstream rewords either, this classifier returns `inconclusive` and OCP still boots, with the
// unrecognised text in the warning -- which is the signal to update them. The gate degrading to a
// warning is the designed failure, not a bug to be discovered.

const UNKNOWN_OPTION = /error: unknown option '(-[^']*)'/;
const FILE_NOT_FOUND = /System prompt file not found/;

/**
 * Classify one capability-probe run. Pure: takes the spawn result, returns a verdict.
 *
 * @param {{stdout?: string, stderr?: string, error?: Error|null, status?: number|null,
 *          timedOut?: boolean}} result
 * @returns {{verdict: "present"|"absent"|"inconclusive", flag?: string, reason?: string,
 *            detail?: string}}
 */
export function classifyCapabilityProbe(result = {}) {
  const { stdout = "", stderr = "", error = null, timedOut = false } = result;

  // Ordered before the text checks: a spawn that never ran produces empty output, and empty
  // output must not be readable as any verdict about the binary's flags.
  if (error) return { verdict: "inconclusive", reason: "spawn-failed", detail: error.message };
  if (timedOut) return { verdict: "inconclusive", reason: "timeout" };

  const text = `${stderr}\n${stdout}`;

  // ABSENT is checked FIRST. It is the only verdict that can refuse a boot, so it must not be
  // reachable by falling through the success check -- and if both strings somehow appeared, the
  // unknown option is the one that decides.
  const unknown = text.match(UNKNOWN_OPTION);
  if (unknown) return { verdict: "absent", flag: unknown[1] };

  if (FILE_NOT_FOUND.test(text)) return { verdict: "present" };

  const firstLine = text.split("\n").map(l => l.trim()).find(Boolean) || "(no output)";
  return { verdict: "inconclusive", reason: "unrecognised-output", detail: firstLine.slice(0, 200) };
}

/**
 * The message an operator sees when the probe refuses the boot. Kept here, beside the classifier,
 * so a test can assert the text names the flag rather than only the fact of a failure -- the whole
 * point of this gate is that the operator learns WHICH flag at boot instead of a user learning it
 * per request.
 */
export function capabilityBootError({ flag, bin }) {
  return (
    `this build of \`claude\` does not support ${flag}, which OCP passes on every request.\n` +
    `  Probed: ${bin}\n` +
    `  Every request would fail with an "unknown option" error from the child process.\n` +
    `  Upgrade \`claude\` (npm i -g @anthropic-ai/claude-code), or set OCP_SKIP_CAPABILITY_PROBE=1\n` +
    `  to boot anyway and accept that failure mode. See docs/adr/ and README § "Environment Variables".`
  );
}
