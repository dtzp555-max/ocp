// Imported FIRST by test-features.mjs, before keys.mjs, so this runs before anything can open
// the key store. ESM hoists imports and evaluates them in order, so a `process.env.X = ...`
// statement in the test's own body would run too late — hence a separate module.
//
// Why this exists: `npm test` used to write real, UNREVOKED api_keys rows into the operator's
// live ~/.ocp/ocp.db (the same database the running server reads) — two per run, unbounded.
// It also made the suite racy: two concurrent runs (e.g. review worktrees) shared one file, so
// `listKeys()` could miss "test-user-1" and the `in` check would throw on undefined.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_OCP_DIR = mkdtempSync(join(tmpdir(), "ocp-test-"));
process.env.OCP_DIR_OVERRIDE = TEST_OCP_DIR;
