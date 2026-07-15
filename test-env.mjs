// Imported FIRST by test-features.mjs, before keys.mjs, so this runs before anything can open
// the key store. ESM hoists imports and evaluates them in order, so a `process.env.X = ...`
// statement in the test's own body would run too late — hence a separate module.
//
// Why this exists: `npm test` used to write real, UNREVOKED api_keys rows into the operator's
// live ~/.ocp/ocp.db (the same database the running server reads) — two per run, unbounded.
// It also made the suite racy: two concurrent runs (e.g. review worktrees) shared one file, so
// `listKeys()` could miss "test-user-1" and the `in` check would throw on undefined.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_OCP_DIR = mkdtempSync(join(tmpdir(), "ocp-test-"));

// BOTH are required. keys.mjs honors OCP_DIR_OVERRIDE only when NODE_ENV === "test", so neither
// var alone redirects anything — a stray OCP_DIR_OVERRIDE in a production env is inert without
// NODE_ENV=test alongside it. (A daemon OCP launches never carries either: the service units and
// the `ocp` restart fallback strip both — see plist-merge NEVER_PRESERVE / keys.mjs's comment.)
process.env.NODE_ENV = "test";
process.env.OCP_DIR_OVERRIDE = TEST_OCP_DIR;

// Remove the scratch store on exit. Without this the fix would trade unbounded growth in
// ~/.ocp/ocp.db for unbounded growth in $TMPDIR — better, but still litter.
process.on("exit", () => {
  try { rmSync(TEST_OCP_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});
