// scripts/lib/ocp-dir.mjs — "where is this OCP installed?", answered once.
//
// Issue #348: scripts/doctor.mjs and scripts/upgrade.mjs both answered this question with
// `opts.ocpDir || join(homedir(), "ocp")`. That default is wrong on any install that is not at
// $HOME/ocp, and `opts.ocpDir` is dead in every real invocation — the `ocp` bash wrapper calls
// `node "$script_dir/scripts/doctor.mjs" ...` positionally and no `--ocp-dir` flag exists
// anywhere (verified by reading `ocp` and both files' own argv parsers), so in production the
// default ALWAYS resolved to $HOME/ocp.
//
// Two things then compound on a hardened host, and they were observed together during the
// v3.29.0 fleet rollout:
//   1. the install lives at /opt/ocp, not $HOME/ocp; and
//   2. the command needs `sudo` (system unit), so homedir() is /root, and /root/ocp does not
//      exist at all.
// doctor's readFileSync then threw, current_version became "unknown", from_version_supported
// FAILed with "unknown < v3.4.0", and `ocp update` concluded kind="fresh_install" — the path
// that runs `rm -rf ~/ocp` and reinstalls. It is correctly gated behind --fresh-install --yes,
// so nothing was destroyed, but the host could not take the release either. The host in
// question is at /opt/ocp *because* that relocation plus an unprivileged `User=` is the
// topology adopted to close #328's credential-escalation chain — so hardening moved the host
// off the only path the updater could see.
//
// The bash half of the same tool never had this bug: `ocp` resolves `script_dir` from
// "${BASH_SOURCE[0]}" through a readlink loop and drives every node script from it. This module
// makes the .mjs half agree, using the same principle — the one fact the process can be certain
// of is where its own file lives — and the same precedent scripts/upgrade.mjs's #254
// resolveExpectedWorkingTree and doctor.mjs's own _isMain() already set with
// fileURLToPath(import.meta.url).
//
// Deliberately NOT applied to scripts/upgrade.mjs's resolveExpectedWorkingTree (#254). That
// function answers a different question — "which tree is THIS process running from" — for the
// purpose of comparing it against the tree the live service is actually running. Letting an
// operator-supplied OCP_DIR override a fact the process already knows for certain would
// reintroduce exactly the assumption #254 exists to remove, and would make a wrong OCP_DIR
// silently *suppress* the mismatch warning instead of tripping it.

import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/**
 * Resolve the OCP install directory, in precedence order:
 *
 *   1. `opts.ocpDir`            — explicit programmatic override (tests, and any future CLI flag)
 *   2. `$OCP_DIR`               — the operator escape hatch (#348); absolute paths only
 *   3. this file's own location — correct by construction, immune to sudo's HOME
 *   4. `$HOME/ocp`              — last resort, only if import.meta.url is somehow unavailable
 *
 * Returns BOTH the directory and how it was decided. The `source` is not decoration: #348's
 * whole failure mode was that a wrong answer here was invisible, so every caller that reports
 * to a human is expected to print it (doctor pushes an `install_dir` check carrying both).
 *
 * A relative $OCP_DIR is refused rather than resolved against cwd — `git -C <relative>` and
 * `npm --prefix <relative>` would then mean different directories depending on who invoked the
 * command (`ocp` cd's to script_dir on some paths and not others). Refusing is reported in
 * `source`, never silent: silently ignoring the operator's override is the same defect class as
 * silently assuming $HOME/ocp.
 *
 * Never throws.
 */
export function resolveOcpDir(opts = {}) {
  if (opts.ocpDir) return { dir: opts.ocpDir, source: "opts.ocpDir" };

  const raw = process.env.OCP_DIR;
  const env = typeof raw === "string" ? raw.trim() : "";
  let ignored = "";
  if (env) {
    if (isAbsolute(env)) return { dir: env, source: "OCP_DIR" };
    ignored = ` (OCP_DIR=${JSON.stringify(env)} ignored: not an absolute path)`;
  }

  try {
    // This file is installed at <ocpDir>/scripts/lib/ocp-dir.mjs — three dirname() calls up.
    // setup.mjs never relocates it; if this file ever moves, this count moves with it.
    return { dir: dirname(dirname(dirname(fileURLToPath(import.meta.url)))), source: `script${ignored}` };
  } catch {
    return { dir: join(homedir(), "ocp"), source: `fallback:homedir${ignored}` };
  }
}
