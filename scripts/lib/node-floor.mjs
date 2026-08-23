// scripts/lib/node-floor.mjs — "is this Node new enough to run OCP?"
//
// WHY THIS EXISTS. `setup.mjs` gated on `parseInt(process.versions.node) < 18` — four major
// versions below what the code needs, and, because it parsed only the MAJOR, structurally unable
// to express the real constraint at all. `keys.mjs` does `import { DatabaseSync } from
// "node:sqlite"` at module load and `server.mjs` imports `keys.mjs` at module load, so a Node that
// still needs `--experimental-sqlite` cannot start the proxy — and nothing on any launch path
// passes that flag. The installer therefore reported "prerequisites OK" on 18.x, 20.x and
// 22.0–22.12, and the operator met the real constraint later, as an opaque `node:sqlite` error at
// first boot rather than as a prerequisite failure at install time.
//
// WHY IT IS A TABLE AND NOT A FLOOR. A single lower bound cannot say this. Node removed the flag
// on TWO lines at different points, so `>=22.13.0` — the obvious fix, and the one this file first
// shipped in draft — admits 23.0–23.3, which still need it. That is the same defect one version
// down: a threshold that cannot express the rule it is standing in for. The rule is Node's own
// history, so it lives here as data:
//
//   https://nodejs.org/api/sqlite.html § History
//     Added in: v22.5.0
//     v23.4.0, v22.13.0 — SQLite is no longer behind `--experimental-sqlite` but still experimental
//     v25.7.0           — SQLite is now a release candidate
//
// Note what is deliberately NOT encoded: "stable". `node:sqlite` is Release Candidate from 25.7
// and merely unflagged before that. UNFLAGGED is the property that decides whether OCP boots;
// stability is not, and an earlier CI comment that conflated the two is corrected in the same
// change as this file.
//
// EXPIRY CONDITION: these are Node's numbers, and Node does not rewrite its own history — so the
// rows below do not go stale. What CAN move is package.json's `engines.node`, which is why a test
// DERIVES that string from this table and fails if the two disagree, rather than trusting them to
// be updated together.

/**
 * Minimum version on each major line at which `node:sqlite` loads with no flag. A major absent
 * from this table and BELOW the lowest row is unsupported; a major above the highest row inherits
 * support (Node does not un-ship a module).
 */
export const NODE_SQLITE_UNFLAGGED = [
  { major: 22, minor: 13 },
  { major: 23, minor: 4 },
];

/**
 * The npm `engines.node` range that admits exactly the versions `rows` admits.
 *
 * THROWS on a table whose majors are not strictly increasing, and that is the point rather than
 * an inconvenience. Found by independent review as a latent divergence: with a repeated major —
 * `[{22,13},{22,20},{23,4}]` — the arm for the first row takes its upper bound from the NEXT row's
 * major and becomes `>=22.13.0 <22.0.0`, **an empty set**, so the range drops 22.13–22.19 while
 * `supportsUnflaggedSqlite` still answers `true` for them (its scan keeps the first row of a tied
 * major, because the comparison is a strict `>`). Measured, not reasoned: that exact table
 * produces `>=22.13.0 <22.0.0 || >=22.20.0 <23.0.0 || >=23.4.0` and the predicate says `true` at
 * 22.15.0.
 *
 * A tied major is MALFORMED INPUT — two rows cannot both say when major 22 became unflagged — so
 * the honest handling is to refuse it, not to pick a winner. This closes the last unstated
 * invariant: the predicate was already generalised for non-adjacent majors, and leaving the range
 * half resting on "the rows happen to be strictly increasing" would have made the module's own
 * claim of "correct for any table" half true. Throwing at module load is deliberate: a malformed
 * table should stop the build, not ship a range nobody checked.
 */
export function deriveEnginesRange(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].major <= rows[i - 1].major) {
      throw new Error(
        `NODE_SQLITE_UNFLAGGED majors must be strictly increasing; got ${rows[i - 1].major} then ` +
        `${rows[i].major}. A repeated major makes one arm of the derived range an empty set while ` +
        `supportsUnflaggedSqlite still admits those versions.`
      );
    }
  }
  return rows
    .map(({ major, minor }, i) => {
      const next = rows[i + 1];
      return next ? `>=${major}.${minor}.0 <${next.major}.0.0` : `>=${major}.${minor}.0`;
    })
    .join(" || ");
}

/** The npm `engines.node` range that admits exactly the versions the table above admits. */
export const ENGINES_NODE = deriveEnginesRange(NODE_SQLITE_UNFLAGGED);

/**
 * Can `version` (e.g. `process.versions.node`) load `node:sqlite` without `--experimental-sqlite`?
 *
 * Returns false — never throws — for a version string it cannot read: an unreadable running
 * version is a reason to REFUSE, not to crash with a different error than the operator needs.
 */
export function supportsUnflaggedSqlite(version, rows = NODE_SQLITE_UNFLAGGED) {
  const m = String(version ?? "").trim().match(/^v?(\d+)\.(\d+)\./);
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  // Highest row at or below this major. Written this way, and NOT as "is it the last row" plus an
  // exact-major lookup, because that earlier form silently disagreed with ENGINES_NODE for any
  // table whose rows are not ADJACENT majors: with rows [22.13, 23.4, 26.2] it answered false for
  // 24.x and 25.x while the derived range admitted them. The two are derivations of the same table
  // and must not depend on an unstated invariant nobody would think to preserve. `rows` is a
  // parameter so a test can hand in that exact table instead of the claim resting on reading.
  let row = null;
  for (const r of rows) if (r.major <= major && (!row || r.major > row.major)) row = r;
  if (!row) return false;                       // below every row
  return row.major === major ? minor >= row.minor : true;  // a later major inherits support
}
