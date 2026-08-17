// scripts/lib/release-notes.mjs — build the GitHub Release body for a tag, from CHANGELOG.md.
//
// ── Issue #441: v3.29.3 shipped with no Release ───────────────────────────────────────────
//
// `.github/workflows/release.yml` used to pipe the CHANGELOG section verbatim into
// `gh release create --notes-file`. GitHub caps a release body at 125 000 characters.
// v3.29.3's section is 169 670 bytes — 36 % over — so the API answered
// `HTTP 422: Validation Failed … body is too long` and NO RELEASE WAS CREATED. The tag, the
// code and the fleet were all correct; only the Releases page was wrong, and it stayed wrong
// for a day showing v3.29.2 as Latest.
//
// It was invisible because every mechanism that would have noticed looks somewhere else:
// `scripts/doctor.mjs` resolves `latest_version` from `git show origin/main:package.json`, not
// from GitHub Releases, so `ocp update` was unaffected and the whole fleet took 3.29.3
// correctly. The only remaining observer was a human reading the Releases page.
//
// **The fix is not to shorten the record.** The section is 5x v3.29.2's (31 964 bytes) because
// this cycle's entries carry the measurements behind each change; that convention is working
// and the next cycle has no reason to be smaller. So the body becomes a PREFIX plus a pointer,
// and only when it has to be.
//
// ── Why the budget is counted in BYTES when GitHub's cap is in characters ─────────────────
//
// A UTF-8 byte count is never SMALLER than a character count, under either meaning of
// "character": a code point costs 1-4 bytes, and a UTF-16 code unit costs at least 1. So
// `byteLength(body) <= 125000` implies the body is under the cap however GitHub counts it,
// while the reverse does not hold. Measured on the v3.29.3 section, which is full of em dashes
// and arrows: 169 670 bytes against 168 661 code points and 168 661 UTF-16 units. Counting
// bytes is therefore the conservative direction, and it is the one instrument (`wc -c`,
// `Buffer.byteLength`) that agrees with itself in bash and in node.
//
// This costs headroom, never correctness. If GitHub ever counts code points, this refuses a
// body it could have accepted; it never accepts one it should have refused.
//
// ── Why the cut snaps to a BLOCK boundary and not to a heading ────────────────────────────
//
// Measured on the v3.29.3 section (56 block starts — `^#{1,6} ` or a top-level list marker):
//
//   snap to a block start   -> last boundary at or under 125 000 is byte 123 714 (a `- **…`
//                              entry start), so 1 286 bytes of the budget go unused
//   snap to a heading only  -> falls all the way back to `### Changed` at byte 89 829, throwing
//                              away 33 885 bytes of notes for nothing
//   no snap at all          -> the cut lands mid-sentence, and in this CHANGELOG mid-bold-run,
//                              which renders as a broken entry rather than a short one
//
// Entries in this CHANGELOG are single enormous `- **…**` bullets, so a bullet start IS the
// semantic boundary here; headings are far too coarse to be the unit.
//
// ── What this deliberately does NOT do ────────────────────────────────────────────────────
//
// The footer links to CHANGELOG.md AT THE TAG, not to an anchor inside it. A GitHub heading
// anchor has to be derived from the heading text by a slug algorithm this file would then own a
// copy of; the copy has no test that can notice when GitHub changes the algorithm, and a
// silently-wrong anchor lands the reader at the top of the file anyway — which is where the
// plain file link lands them, without the pretence. `## Unreleased` is the only thing above the
// newest section.

import { Buffer } from "node:buffer";

// GitHub's documented release-body cap. EXPIRY CONDITION: this is a server-side limit that this
// repo does not control. It stops being true the moment GitHub changes it — in either
// direction. What makes that survivable is that the number is never the thing being trusted:
// `assertWithinLimit` below turns a wrong value here into a LOUD, NAMED build failure at
// release time rather than into a silently-oversized body, and the API's own 422 remains the
// backstop behind that. If a release ever fails with `body is too long` while this file says it
// checked, this constant is the first thing to re-read against GitHub's current documentation.
export const GITHUB_RELEASE_BODY_LIMIT = 125000;

// A line that may start a truncated body's final block. `^#{1,6} ` is a markdown heading;
// `^- ` / `^* ` / `^+ ` are the three top-level list markers CommonMark accepts. Indented
// continuation lines are deliberately NOT boundaries — cutting inside a bullet's own nested
// list produces the same broken-entry render as cutting mid-sentence.
const BLOCK_START = /^(#{1,6} |[-*+] )/;

/**
 * The bytes of `s` as UTF-8. One name for the one instrument, so no call site can drift onto
 * `s.length` (UTF-16 units) and quietly compare two different units.
 */
function bytes(s) {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Extract the `## v<version>` section of a CHANGELOG, up to the next `## v` heading or EOF.
 *
 * Returns "" when there is no such section — an empty string is the caller's signal to fall
 * back to minimal notes, exactly as the awk this replaces did.
 *
 * `version` is accepted with or without its leading `v`, because the workflow derives it as
 * `${GITHUB_REF#refs/tags/v}` (no `v`) while every heading in CHANGELOG.md carries one.
 *
 * ONE DELIBERATE BEHAVIOUR CHANGE from the awk (`$0 ~ "^## " ver`): that pattern is a regex
 * with an unbounded right edge, so `v3.29.3` also matches the heading `## v3.29.30` — it would
 * have picked whichever came first in the file. Here the character after the version must not
 * continue it (`[0-9.]`). Nothing in this repo's history hit that; it is fixed because this
 * function is now testable and the test costs one case.
 *
 * The terminator stays `^## v` rather than `^## ` for exact fidelity with the awk. Widening it
 * would be a second behaviour change on a release-critical path in the same commit, with
 * nothing asking for it: `## Unreleased` is above the newest section, never inside one.
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== "string" || !changelog) return "";
  const ver = "v" + String(version).replace(/^v/, "");
  const lines = changelog.split("\n");
  const out = [];
  let found = false;
  for (const line of lines) {
    if (!found) {
      if (line.startsWith("## " + ver) && !/[0-9.]/.test(line.charAt(3 + ver.length))) {
        found = true;
        out.push(line);
      }
      continue;
    }
    if (line.startsWith("## v")) break;
    out.push(line);
  }
  return found ? out.join("\n") : "";
}

/**
 * The pointer appended to a truncated body. Kept as its own function because its LENGTH is part
 * of the budget arithmetic below — the cut point has to be chosen knowing what will be glued on
 * after it, and a footer built after the cut would be the classic off-by-a-footer overflow.
 */
function truncationFooter({ version, repo, sectionBytes, limit }) {
  const tag = "v" + String(version).replace(/^v/, "");
  const where = repo
    ? `https://github.com/${repo}/blob/${tag}/CHANGELOG.md`
    : `CHANGELOG.md at ${tag}`;
  return (
    `\n\n---\n\n` +
    `*Release notes truncated to fit GitHub's ${limit.toLocaleString("en-US")}-character ` +
    `release-body cap — the full ${tag} section of CHANGELOG.md is ` +
    `${sectionBytes.toLocaleString("en-US")} bytes. Full notes: ${where}*\n`
  );
}

/**
 * Build the release body for `version`.
 *
 * `changelog` is the file's contents, or null/"" when there is no CHANGELOG.md at all — the
 * caller reads the file so that "absent" and "empty" are its problem, not this function's.
 *
 * Returns `{ body, kind, boundary, sectionBytes, bodyBytes, limit }`:
 *
 *   kind "minimal:no-changelog" — no CHANGELOG contents were supplied
 *   kind "minimal:no-section"   — a CHANGELOG, but no heading for this version
 *   kind "section"              — the section fits; `body` is it, BYTE-IDENTICAL
 *   kind "truncated"            — a prefix of the section plus the pointer footer
 *
 * `boundary` says how the cut was chosen when kind is "truncated": "block" (a heading or
 * top-level list marker — the normal case), "line" (no block start fit, so the last whole line
 * that did), or "hard" (not even one line fit, so a byte-safe prefix of the first line).
 *
 * The "line" and "hard" arms are not decoration. A section whose FIRST entry is itself over the
 * budget has no interior block start to snap to, and this function's contract is that the body
 * it returns is always within the limit — a contract with an unreachable-looking exception is
 * the shape that shipped #324. Both arms are tested directly.
 *
 * Never throws.
 */
export function buildReleaseBody({ changelog, version, repo = "", limit = GITHUB_RELEASE_BODY_LIMIT } = {}) {
  const tag = "v" + String(version).replace(/^v/, "");
  const minimal = (kind, sectionBytes = 0) => ({
    body: `Release ${tag}\n`,
    kind,
    boundary: null,
    sectionBytes,
    bodyBytes: bytes(`Release ${tag}\n`),
    limit,
  });

  if (typeof changelog !== "string" || !changelog) return minimal("minimal:no-changelog");

  const section = extractChangelogSection(changelog, version);
  if (!section) return minimal("minimal:no-section");

  const sectionBytes = bytes(section);
  if (sectionBytes <= limit) {
    return { body: section, kind: "section", boundary: null, sectionBytes, bodyBytes: sectionBytes, limit };
  }

  const footer = truncationFooter({ version, repo, sectionBytes, limit });
  const budget = limit - bytes(footer);
  // A limit so small that the pointer alone does not fit. Nothing useful can be said inside it,
  // so say the one true thing that does fit. Reachable only from a caller-supplied `limit`;
  // tested, because "can't happen" is not a property this file gets to assert about its callers.
  // Its own `kind`, NOT "minimal:no-section": those two states differ in what an operator should
  // go look at, and collapsing them would report a present section as an absent one.
  if (budget <= 0) return minimal("minimal:limit-too-small", sectionBytes);

  // Byte offset at which each line of the section starts. Built once; every arm below indexes
  // into it rather than re-measuring a growing prefix, which is what makes this O(n) on a
  // 170 KB input instead of O(n^2).
  const lines = section.split("\n");
  const offsets = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = off;
    off += bytes(lines[i]) + 1; // +1 for the "\n" that split() removed
  }

  // Prefer the last BLOCK start that fits; fall back to the last whole LINE that fits. Index 0
  // is excluded from both: it is the `## v…` heading itself, and cutting there yields an empty
  // body plus a footer, which is strictly worse than the hard-cut arm below.
  let cut = -1;
  let boundary = null;
  for (let i = lines.length - 1; i > 0; i--) {
    if (offsets[i] <= budget && BLOCK_START.test(lines[i])) { cut = i; boundary = "block"; break; }
  }
  if (cut === -1) {
    for (let i = lines.length - 1; i > 0; i--) {
      if (offsets[i] <= budget) { cut = i; boundary = "line"; break; }
    }
  }

  let kept;
  if (cut > 0) {
    // offsets[cut] is where line `cut` STARTS, so slicing the joined lines above it drops that
    // line and everything after it. Rebuilt from the array rather than sliced by byte offset,
    // because a byte offset cannot be applied to a JS string without re-encoding.
    kept = lines.slice(0, cut).join("\n");
  } else {
    // Not one whole line fit. Take a byte-safe prefix of the section: the largest prefix, cut on
    // a CODE POINT boundary, whose UTF-8 encoding fits. Slicing by `String.prototype.slice`
    // alone can split a surrogate pair and produce a lone half; iterating code points cannot.
    boundary = "hard";
    const cps = Array.from(section);
    let used = 0;
    let end = 0;
    for (let i = 0; i < cps.length; i++) {
      const w = bytes(cps[i]);
      if (used + w > budget) break;
      used += w;
      end = i + 1;
    }
    kept = cps.slice(0, end).join("");
  }

  const body = kept + footer;
  return { body, kind: "truncated", boundary, sectionBytes, bodyBytes: bytes(body), limit };
}

/**
 * Throw unless `body` fits the limit, with a message that names the issue and both numbers.
 *
 * WHAT THIS IS, STATED HONESTLY: `buildReleaseBody` already guarantees its result fits, so on
 * today's code path this never fires. It is a BACKSTOP against a future change to the builder,
 * and it exists because #441's actual cost was that the only thing checking the size was the
 * GitHub API — a `422 Validation Failed` inside a red workflow run on a tag ref, which nothing
 * routinely reads. Turning that into a named, local failure is the whole ask.
 *
 * Because it is unreachable through the builder, it is tested DIRECTLY with an over-limit
 * string rather than through `buildReleaseBody`. A guard whose only test drives it through a
 * caller that cannot reach it is a guard nobody has ever seen fire.
 */
export function assertWithinLimit(body, limit = GITHUB_RELEASE_BODY_LIMIT) {
  const n = bytes(body);
  if (n > limit) {
    throw new Error(
      `release body is ${n} bytes, over the ${limit}-byte budget by ${n - limit} — refusing to ` +
      `call the GitHub API, which would answer "422 Validation Failed: body is too long" (#441)`
    );
  }
  return n;
}
