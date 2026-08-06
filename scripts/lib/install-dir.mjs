// scripts/lib/install-dir.mjs — "where is this OCP installed?", and "is that directory
// actually an OCP install?", answered once.
//
// Named resolveInstallDir, not resolveOcpDir, deliberately: keys.mjs already has a
// `resolveOcpDir()` and it means the `~/.ocp` DATA directory (the key store). Two functions
// with one name and two meanings, both plausibly "the OCP directory", is a collision waiting
// to be miscalled. This module is only ever about the INSTALL TREE — the checkout that holds
// server.mjs and package.json.
//
// ── Issue #348: the resolution bug ────────────────────────────────────────────────────────
//
// scripts/doctor.mjs and scripts/upgrade.mjs both answered "where is the install" with
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
// that runs `rm -rf <ocpDir>`. It is correctly gated behind --fresh-install --yes, so nothing
// was destroyed, but the host could not take the release either. The host in question is at
// /opt/ocp *because* that relocation plus an unprivileged `User=` is the topology adopted to
// close #328's credential-escalation chain — so hardening moved the host off the only path the
// updater could see.
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
//
// ── Issue #348 review, HIGH-2: the escape hatch is an `rm -rf` argument ───────────────────
//
// Introducing $OCP_DIR created a capability that did not previously exist. Before it, there
// was NO reachable way to point doctor's fresh_install `rm -rf ${ocpDir}` at anything other
// than $HOME/ocp: `opts.ocpDir` is dead in production and no CLI flag sets it. With $OCP_DIR
// read, a typo'd-but-absolute value ("/", "/etc", "$HOME") resolves fine, has no package.json,
// fails current_version, selects kind="fresh_install", and becomes the argument to `rm -rf`.
// The consent gate the operator reads on the way through (--fresh-install --yes) is real, but
// consenting to "reinstall OCP" is not consenting to "delete /etc".
//
// classifyInstallDir() below is the answer: the destructive step is permitted only against a
// directory that is **absent, empty, or verifiably an OCP install**. Everything else is
// refused before it can become an argument, loudly, by both doctor (which stops emitting the
// step) and runFreshInstall (which re-derives the verdict itself rather than trusting the JSON
// handed to it — the thing that actually runs `rm -rf` does its own check).
//
// Note what this also buys on the DEFAULT path, which never had the guard either: a host whose
// $HOME/ocp is somebody's unrelated directory was always one `--fresh-install --yes` away from
// losing it. That was reachable before this PR. It is refused now.

import { dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readdirSync, readFileSync } from "node:fs";

// This repo's own package.json `name`. Hardcoded rather than read at runtime because the whole
// point is to identify a FOREIGN directory, where reading "its" package.json is the question,
// not the answer. test-features.mjs asserts this constant still matches this repo's own
// package.json, so a rename cannot silently make every install unrecognizable.
export const OCP_PACKAGE_NAME = "open-claude-proxy";

// Top-level files that only an OCP checkout has all of. Any TWO of them is treated as an OCP
// install even when package.json is missing or corrupt — a half-broken install is exactly the
// state fresh_install exists to repair, so requiring a pristine package.json would refuse the
// legitimate case. One alone is not enough: a stray `ocp` or `server.mjs` in a home directory
// should not license `rm -rf $HOME`.
const INSTALL_MARKERS = ["server.mjs", "setup.mjs", "ocp", "models.json"];

/**
 * Resolve the OCP install directory, in precedence order:
 *
 *   1. `opts.ocpDir`            — explicit programmatic override (tests, and any future CLI flag)
 *   2. `$OCP_DIR`               — the operator escape hatch (#348); absolute paths only
 *   3. this file's own location — correct by construction, immune to sudo's HOME
 *   4. `$HOME/ocp`              — last resort, only if import.meta.url is somehow unavailable
 *
 * Returns the directory, a machine-readable `source`, and `ignored` — a human-readable reason
 * when an $OCP_DIR was present but not usable. `ignored` is not decoration: #348's whole
 * failure mode was that a wrong answer here was invisible, and doctor raises its `install_dir`
 * check to WARN whenever it is non-empty, specifically so the line survives `ocp update`'s
 * WARN/INFO-only filter (`ocp`'s cmd_update) instead of being swallowed at PASS.
 *
 * A relative $OCP_DIR is refused rather than resolved against cwd — `git -C <relative>` and
 * `npm --prefix <relative>` would then mean different directories depending on who invoked the
 * command (`ocp` cd's to script_dir on some paths and not others).
 *
 * Never throws.
 */
export function resolveInstallDir(opts = {}) {
  if (opts.ocpDir) return { dir: opts.ocpDir, source: "opts.ocpDir", ignored: "" };

  const raw = process.env.OCP_DIR;
  const env = typeof raw === "string" ? raw.trim() : "";
  let ignored = "";
  if (env) {
    if (isAbsolute(env)) return { dir: env, source: "OCP_DIR", ignored: "" };
    ignored = `OCP_DIR=${JSON.stringify(env)} ignored: not an absolute path`;
  }

  try {
    // This file is installed at <ocpDir>/scripts/lib/install-dir.mjs — three dirname() calls
    // up. setup.mjs never relocates it; if this file ever moves, this count moves with it.
    return { dir: dirname(dirname(dirname(fileURLToPath(import.meta.url)))), source: "script", ignored };
  } catch {
    return { dir: join(homedir(), "ocp"), source: "fallback:homedir", ignored };
  }
}

/**
 * Decide whether `dir` may be handed to `rm -rf` as part of a fresh install.
 *
 * `safeToReplace` is true in exactly three cases, and the reasoning differs for each:
 *   - **absent** — `rm -rf` is a no-op and the subsequent `git clone` creates it. Nothing to lose.
 *   - **empty** — likewise nothing to lose, and this is the real shape of a pre-created target
 *     (`sudo mkdir -p /opt/ocp` before installing; `git clone` requires an empty destination).
 *   - **a verifiable OCP install** — deleting and re-cloning it is precisely what fresh_install
 *     is for.
 *
 * Everything else is false, INCLUDING the cases where we could not look: an unreadable
 * directory, or a path that is a file (ENOTDIR). Fail closed — "I could not confirm what this
 * is" must not license deleting it.
 *
 * Never throws.
 */
export function classifyInstallDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") {
      return { exists: false, empty: false, isInstall: false, markers: [], safeToReplace: true,
               why: `${dir} does not exist yet` };
    }
    return { exists: true, empty: false, isInstall: false, markers: [], safeToReplace: false,
             why: `${dir} could not be inspected (${e.code || e.message}) — refusing to treat it as an OCP install` };
  }

  if (entries.length === 0) {
    return { exists: true, empty: true, isInstall: false, markers: [], safeToReplace: true,
             why: `${dir} exists but is empty` };
  }

  let namedPackage = false;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    namedPackage = !!pkg && pkg.name === OCP_PACKAGE_NAME;
  } catch { /* absent, unreadable, or not JSON — fall through to the marker count */ }

  const markers = INSTALL_MARKERS.filter(m => entries.includes(m));
  const isInstall = namedPackage || markers.length >= 2;

  return {
    exists: true,
    empty: false,
    isInstall,
    markers,
    safeToReplace: isInstall,
    why: isInstall
      ? `${dir} is an OCP install (${namedPackage ? `package.json name="${OCP_PACKAGE_NAME}"` : `markers: ${markers.join(", ")}`})`
      : `${dir} exists and is NOT an OCP install (no package.json named "${OCP_PACKAGE_NAME}"` +
        `${markers.length ? `, only ${markers.length} of the marker files: ${markers.join(", ")}` : ", none of the marker files"}` +
        `) — it is not something this tool may delete`,
  };
}
