#!/usr/bin/env node
// scripts/release-notes.mjs — the CLI `.github/workflows/release.yml` calls to produce the
// `--notes-file` it hands to `gh release create`.
//
// Why this is a script in the repo and not more shell inside the workflow (#441): the workflow
// step CANNOT BE RUN except by cutting a tag, and a tag is not re-cuttable. The logic that
// decides what goes in a release body therefore has to live somewhere `npm test` can reach it,
// or the only test available is the release itself — which is exactly the position #441 left
// this project in. `test-features.mjs` imports scripts/lib/release-notes.mjs directly AND
// executes this file's own argv path AND executes the workflow's `run:` block verbatim.
//
// The awk that used to do the extraction inline is gone; its two degrade-to-minimal-notes
// behaviours are preserved and are now tested rather than asserted:
//   - no CHANGELOG.md at all           -> "Release v<version>"
//   - no `## v<version>` heading in it -> "Release v<version>"
// Both still WRITE THE FILE. That is #202: the create step consumes a file, so an early exit
// that skipped the write turned "degrade to minimal notes" into a failed release job.
//
// Node API floor: this file and scripts/lib/release-notes.mjs use only `node:fs`, `node:buffer`,
// `node:process` and ES2020 syntax, so they run on whatever `node` the GitHub-hosted runner
// image ships without a `setup-node` step. That is a constraint on what may be written here, not
// a claim about a version number — if this ever needs a newer API, the workflow needs a
// `setup-node` step in the same commit.

import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { buildReleaseBody, assertWithinLimit, GITHUB_RELEASE_BODY_LIMIT } from "./lib/release-notes.mjs";

const USAGE =
  "usage: node scripts/release-notes.mjs --version <x.y.z> --out <path> " +
  "[--changelog <path>] [--repo <owner/name>] [--limit <bytes>]";

export function parseArgs(argv) {
  const opts = { version: "", out: "", changelog: "CHANGELOG.md", repo: "", limit: GITHUB_RELEASE_BODY_LIMIT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // An unknown flag is an ERROR, never a shrug. A typo'd `--limit` that is silently ignored
    // leaves the default in place and the run goes green having checked something other than
    // what was asked for — the shape this whole file exists to stop.
    switch (a) {
      case "--version": opts.version = argv[++i] ?? ""; break;
      case "--out": opts.out = argv[++i] ?? ""; break;
      case "--changelog": opts.changelog = argv[++i] ?? ""; break;
      case "--repo": opts.repo = argv[++i] ?? ""; break;
      case "--limit": opts.limit = Number(argv[++i]); break;
      default: throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    }
  }
  if (!opts.version) throw new Error(`--version is required\n${USAGE}`);
  if (!opts.out) throw new Error(`--out is required\n${USAGE}`);
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error(`--limit must be a positive integer, got ${JSON.stringify(opts.limit)}\n${USAGE}`);
  }
  return opts;
}

export function main(argv) {
  const opts = parseArgs(argv);

  // ENOENT is a documented outcome, not a failure: a repo with no CHANGELOG.md still gets a
  // release. Every OTHER read error (EACCES, EISDIR) rethrows — "I could not look" must not
  // degrade to "there is nothing there", which would ship minimal notes for a release whose
  // CHANGELOG was merely unreadable.
  let changelog = null;
  try {
    changelog = readFileSync(opts.changelog, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const r = buildReleaseBody({ changelog, version: opts.version, repo: opts.repo, limit: opts.limit });

  // Write BEFORE the assert, deliberately: if the assert fires, the job fails and nothing
  // consumes the file, but the oversized body is on disk for whoever reads the failed run.
  writeFileSync(opts.out, r.body);

  console.log(
    `[release-notes] v${String(opts.version).replace(/^v/, "")} kind=${r.kind}` +
    (r.boundary ? ` boundary=${r.boundary}` : "") +
    ` section=${r.sectionBytes}B body=${r.bodyBytes}B limit=${r.limit}B -> ${opts.out}`
  );
  if (r.kind === "truncated") {
    console.log(
      `[release-notes] the ${opts.changelog} section is over the limit; the body is a prefix ` +
      `plus a pointer. This is expected — see issue #441, not a defect.`
    );
  }

  assertWithinLimit(r.body, opts.limit);
  return r;
}

// Guarded rather than a bare top-level call, so test-features.mjs can import parseArgs/main
// without the module running on import. Same shape as scripts/doctor.mjs:1443.
function _isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}

if (_isMain()) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // The named, local failure #441 asks for. `gh release create` is never reached: the step
    // exits non-zero and the workflow stops, instead of the API answering 422 inside a red run
    // on a tag ref that nothing routinely reads.
    console.error(`FATAL: ${e.message}`);
    process.exit(1);
  }
}
