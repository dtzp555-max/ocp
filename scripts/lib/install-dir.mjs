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
import { readdirSync, readFileSync, statSync } from "node:fs";

// This repo's own package.json `name`. Hardcoded rather than read at runtime because the whole
// point is to identify a FOREIGN directory, where reading "its" package.json is the question,
// not the answer. test-features.mjs asserts this constant still matches this repo's own
// package.json, so a rename cannot silently make every install unrecognizable.
export const OCP_PACKAGE_NAME = "open-claude-proxy";

// Top-level entry NAMES that only an OCP checkout has all of. Any TWO of them is treated as an
// OCP install even when package.json is missing or corrupt — a half-broken install is exactly
// the state fresh_install exists to repair, so requiring a pristine package.json would refuse
// the legitimate case. One alone is not enough: a stray `ocp` or `server.mjs` in a home
// directory should not license `rm -rf $HOME`.
//
// A marker must be a REGULAR FILE (issue #366). It used to be a name match against readdir's
// entry list with no stat, so a *directory* named `models.json/` scored the same as the file —
// measured before the fix: two empty directories named `ocp/` and `models.json/` produced
// safeToReplace=true. `/opt` itself was refused only because it scores exactly one marker, i.e.
// by the threshold of 2 rather than by anything checking what those entries are.
//
// The threshold is still load-bearing and this does not replace it — but note the two guard
// DIFFERENT cases, and it is easy to blur them. The threshold's case is a directory holding
// exactly one REAL marker file (a stray `server.mjs` in a home directory); mutation M2
// (>= 2 → >= 1) reddens exactly that, in the #348 test. The type check's case is an entry with a
// marker NAME that is not a file at all. `/opt` happens to be refused by both now — it scores 0
// after this change rather than the 1 it scored before — which is why the M2 row is worth
// keeping: without it, a later "simplification" of the threshold would look free.
const INSTALL_MARKERS = ["server.mjs", "setup.mjs", "ocp", "models.json"];

/**
 * What is `<dir>/<name>`? Returns one of three states, NOT a boolean (issue #366 review, F1).
 *
 *   "file"       — a regular file. The only state that counts as a marker.
 *   "not-a-file" — we looked, and it is not one: a directory, a socket, a DANGLING symlink
 *                  (statSync throws ENOENT, measured — it scored as a marker before this change).
 *   "unreadable" — we could NOT look. EACCES, EIO, ELOOP.
 *
 * A boolean was the first cut and it was wrong — not in the verdict, which is `false` either way,
 * but in what the caller can then SAY. Collapsing "this is not a file" into "I could not tell"
 * makes classifyInstallDir report a real install as "NOT an OCP install" and advise deleting it
 * by hand, which is the one action that loses it. This module's own header draws exactly that
 * distinction ("I could not confirm what this is must not license deleting it"); the boolean
 * collapsed it on the one path this change adds.
 *
 * `statSync` FOLLOWS symlinks, and that is a choice rather than an inherited default. It asks the
 * same question the package.json arm below already asks with readFileSync — "does reading this
 * name give me a file?" — so the two arms of the same function agree. (An earlier draft justified
 * it by claiming a symlinked marker is "a real shape that must keep working"; nothing supports
 * that. `git ls-files -s` has ZERO mode-120000 entries, all four markers are 100644/100755, and
 * installs come from `git clone`, which cannot produce one. The consistency argument is the real
 * one and stands alone.)
 *
 * NOT readdirSync(..., { withFileTypes: true }): measured on macOS APFS, a symlink's Dirent
 * reports isSymbolicLink() and isFile() === false, so it would answer a different question from
 * the package.json arm. NOT existsSync: it returns true for a directory, so it does not answer
 * this question at all.
 *
 * Never throws.
 */
function classifyMarkerEntry(dir, name) {
  try {
    return statSync(join(dir, name)).isFile() ? "file" : "not-a-file";
  } catch (e) {
    // ENOENT is a real answer, not a failure to look: the name is there in readdir but resolves
    // to nothing, i.e. a dangling symlink. Reporting that as "unreadable" would send an operator
    // hunting for a permission problem that does not exist.
    return e.code === "ENOENT" ? "not-a-file" : "unreadable";
  }
}

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
 * `why` distinguishes those two reasons, and `unreadableMarkers` carries the same fact in a form
 * a caller can branch on. The verdict is identical either way; what differs is what an operator
 * is told to do next, and "this is not an OCP install, remove it yourself" is catastrophic advice
 * when the truth is that a permission bit stopped us reading a real install (#366 review, F1).
 *
 * Never throws.
 */
export function classifyInstallDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") {
      return { exists: false, empty: false, isInstall: false, markers: [], unreadableMarkers: [], safeToReplace: true,
               why: `${dir} does not exist yet` };
    }
    return { exists: true, empty: false, isInstall: false, markers: [], unreadableMarkers: [], safeToReplace: false,
             why: `${dir} could not be inspected (${e.code || e.message}) — refusing to treat it as an OCP install` };
  }

  if (entries.length === 0) {
    return { exists: true, empty: true, isInstall: false, markers: [], unreadableMarkers: [], safeToReplace: true,
             why: `${dir} exists but is empty` };
  }

  let namedPackage = false;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    namedPackage = !!pkg && pkg.name === OCP_PACKAGE_NAME;
  } catch { /* absent, unreadable, or not JSON — fall through to the marker count */ }

  // BOTH conditions, and the readdir one stays FIRST rather than being made redundant by the
  // stat (#366). They are not equivalent on a case-insensitive filesystem: measured on macOS
  // APFS, a directory holding `SERVER.MJS` + `SETUP.MJS` gives entries.includes("server.mjs")
  // === false while statSync(join(dir, "server.mjs")) succeeds with isFile() === true. Dropping
  // the entries test would therefore WIDEN what counts as an OCP install, on a guard whose
  // failure mode is `rm -rf` — the opposite of this fix's direction. The stat may only ever
  // narrow.
  //
  // Mutation M3 removes the entries test. READ ITS ROW BEFORE TRUSTING THIS: M3 is killed only on
  // a case-INSENSITIVE filesystem, and CI is ubuntu-latest/ext4, where `entries.includes` and
  // `statSync` agree and M3 SURVIVES. This conjunct is therefore unprotected by the only
  // automated gate, which is exactly why the case-fold test below reports itself as a SKIP on
  // ext4 rather than passing quietly.
  const markerStates = INSTALL_MARKERS
    .filter(m => entries.includes(m))
    .map(m => [m, classifyMarkerEntry(dir, m)]);
  const markers = markerStates.filter(([, s]) => s === "file").map(([m]) => m);
  // Marker names that ARE present but could not be stat'd. Kept separate from `markers` so the
  // verdict is unchanged and only the DIAGNOSIS improves (#366 review, F1).
  const unreadableMarkers = markerStates.filter(([, s]) => s === "unreadable").map(([m]) => m);
  const isInstall = namedPackage || markers.length >= 2;

  return {
    exists: true,
    empty: false,
    isInstall,
    markers,
    unreadableMarkers,
    safeToReplace: isInstall,
    why: isInstall
      ? `${dir} is an OCP install (${namedPackage ? `package.json name="${OCP_PACKAGE_NAME}"` : `markers: ${markers.join(", ")}`})`
      // "I could not look" is a DIFFERENT sentence from "I looked and it is not one", and this
      // branch exists because collapsing them told an operator with a permission-locked install
      // that it "is NOT an OCP install" and advised removing it by hand (#366 review, F1).
      //
      // The two are structurally exclusive, not merely observed to differ: statSync on a child
      // and readFileSync on package.json BOTH require search (x) permission on the directory, so
      // no permission state can fail the marker stats while leaving the package.json arm working.
      // Measured across modes 755/744/644/544/444/311/111: `stat=EACCES` never co-occurs with
      // `readFile(package.json)=ok`. Dropping x (644, 444) fails both; dropping r (311, 111)
      // fails readdirSync instead and is caught by the ENOTDIR/EACCES branch far above, which
      // already says "could not be inspected". The gap this fills is exactly r-without-x.
      : unreadableMarkers.length
        ? `${dir} could not be inspected: ${unreadableMarkers.length} marker name(s) are present ` +
          `but could not be read (${unreadableMarkers.join(", ")}) — this is a permission problem ` +
          `on the directory itself, not evidence about what it contains (stat needs SEARCH ` +
          `permission, which readdir does not). This may well BE an OCP install; this process ` +
          `cannot confirm it, so it is not something this tool may delete. Fix the permissions or ` +
          `re-run as the owner — do NOT delete it`
        : `${dir} exists and is NOT an OCP install (no package.json named "${OCP_PACKAGE_NAME}"` +
          `${markers.length ? `, only ${markers.length} of the marker files: ${markers.join(", ")}` : ", none of the marker files"}` +
          `) — it is not something this tool may delete`,
  };
}
