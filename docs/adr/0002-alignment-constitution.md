# 0002 — Alignment Constitution

- **Date**: 2026-04-20
- **Status**: Accepted
- **Authors**: project maintainer (with AI drafting assistance)
- **Related**: PR #20, commit 2853088; supersedes implicit "keep the proxy honest" discipline

## Context

On 2026-04-11 an OCP commit (`b87992f`, "fix: use dedicated `/api/oauth/usage` endpoint for reliable plan data") was merged. The commit asserted that `/api/oauth/usage` was "the dedicated usage endpoint that Claude Code CLI uses." The assertion was false: the string `/api/oauth/usage` does not appear anywhere in `cli.js`. The endpoint was fabricated by an LLM-assisted authoring pass generalizing from adjacent OAuth paths, without anyone running `grep` against `cli.js`.

The hallucination was not an isolated slip. It persisted across nine days and two additional commits of compensation:

- `cb6c2a8` extended the stale cache to 15 minutes and added a fallback path on HTTP 429 — a workaround that masked the fabricated endpoint's 4xx failures rather than investigating them.
- The dashboard `/usage` progress bar was broken for the entire window (2026-04-11 through 2026-04-20).

Root cause analysis identified three structural gaps:

1. No binding rule that OCP must mirror `cli.js` behavior exactly. "Proxy-only" was aspirational, not enforced.
2. No CI check that would fail builds containing known-hallucinated tokens.
3. No reviewer gate that required the reviewer to verify the `cli.js` citation before approving.

Without all three, the same class of drift was re-occurrence-probable rather than preventable.

## Decision

Adopt `ALIGNMENT.md` as the project constitution. It encodes five binding Rules:

1. **Grep First** — before changing any endpoint/header/parameter/response shape, the author must `grep` `cli.js` and record the line numbers.
2. **No Invention** — OCP must not introduce surface area not present in `cli.js`. Speculative "Claude Code probably uses X" statements are prohibited.
3. **Match the Implementation** — where `cli.js` does perform the operation, OCP matches it byte-for-byte on the wire.
4. **Unalignable Features Are Deleted** — features that cannot be traced to a `cli.js` reference are removed, not deprecated, not feature-flagged.
5. **Cite Line Numbers in Commits** — every `server.mjs`-touching commit references `cli.js:NNNN` or `cli.js vE4 <functionName>`.

Supporting mechanisms:

- `CLAUDE.md` enshrines hard requirements for `server.mjs` PRs: `cli.js` citation, CI blacklist pass, independent reviewer who opens `cli.js` at the cited lines.
- `.github/workflows/alignment.yml` greps `server.mjs` on every PR for the known-hallucinated token set (`api/oauth/usage`, `api/usage`, et al.) and fails the build on any hit.
- `.github/PULL_REQUEST_TEMPLATE.md` makes the `cli.js` citation and the reviewer's cli.js-opened confirmation mandatory fields.
- A bootstrap audit pin: Claude Code `2.1.89`, `cli.js` SHA-256 `a9950ef6407fdc750bddb673852485500387e524a99d42385cb81e7d17128e01`, auditor: project maintainer, date 2026-04-20. The pin is refreshed annually on 11 April (the drift anniversary) or on any re-verification event.
- A documented Historical Lesson section in `ALIGNMENT.md` that names the drift commits by SHA, so the incident cannot be rewritten or quietly forgotten.

## Consequences

**Positive**

- Every `server.mjs` change is now provably aligned to a specific `cli.js` line range before merge.
- CI hard-fails any reintroduction of the specific hallucinated tokens; the failure mode is loud and immediate, not silent-and-cached.
- The reviewer gate makes self-approval a policy violation, which structurally prevents the "fix my own hallucination" cycle that produced `cb6c2a8`.
- The constitution becomes the foundation that later governance (iron rule v1.4, per-project release kit, cross-device dev system) builds on.

**Negative**

- `server.mjs` changes are meaningfully slower: the `grep` step and the reviewer's cli.js verification are real costs on every PR.
- New contributors face a steeper ramp — they must read `ALIGNMENT.md` fully before their first server-side PR will pass review.
- The CI blacklist is a moving target; as future drift patterns are discovered, the list grows, and each addition is governance work.

**Follow-ons**

- ADR 0003 (models.json SPOT) and ADR 0004 (OpenClaw auto-sync) both lean on the constitution's "one reviewable layer" structure.
- Annual audit on 11 April is a recurring calendar obligation; failure to perform it is itself an alignment violation.
- The `cli.js` bundle became opaque at v2.1.90 (binary packaging). Future audits require a different verification strategy — see Alternatives (b) below.

## Alternatives considered

**(a) Pure human discipline — no CI, no template, no ADR.** the maintainer would simply commit to grepping `cli.js` on every change, and reviewers would commit to verifying. Rejected: the 2026-04-11 drift already happened under exactly this regime. the maintainer is meticulous, and the drift still shipped. Social discipline alone cannot prevent LLM hallucination from slipping through, especially when the LLM's output is superficially plausible.

**(b) Automatic `cli.js` diff on every PR.** A CI step that diffs `server.mjs`'s network surface against a parsed `cli.js` AST, blocking on any mismatch. Rejected as too fragile: `cli.js` v2.1.90+ ships as a minified/obfuscated binary, making AST-level grep invalid without an unofficial unbundling step. Any such pipeline becomes a maintenance burden on Anthropic's release cadence, and would routinely false-positive. The blacklist approach is lower-precision but dramatically more robust.

**(c) Freeze OCP and fork a new `ocp-v2` from scratch.** Start over with alignment baked in from day one. Rejected: the existing user base depends on OCP, and the drift affected one endpoint, not the architecture. Retrofitting a constitution onto the existing repo is cheaper and preserves user trust.
