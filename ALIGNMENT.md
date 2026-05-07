# OCP Alignment Constitution

**Status:** Active. This document is the supreme source of truth for OCP scope decisions. Conflicts with other documents (README, issues, prior commit messages) resolve in favor of this file.

---

## Core Principle

OCP (Open Claude Proxy) is a **proxy layer** for the Claude Code CLI. It forwards, observes, and multiplexes the traffic that `cli.js` already emits. It is **not** an extension layer. If `cli.js` does not perform a given operation, or performs it differently, OCP does not invent one.

---

## Rules

1. **Rule 1 (Grep First).** Before adding, renaming, or changing any endpoint, header, parameter, or response shape, the author must `grep` the reference `cli.js` and record the exact line numbers in the commit message and PR body. An absent grep hit is itself a finding and must be declared.

2. **Rule 2 (No Invention).** OCP must not introduce endpoints, headers, request fields, or response fields that are not present in `cli.js`. Speculative "Claude Code probably uses X" statements are prohibited. If the behavior is not observable in `cli.js`, the feature is out of scope.

3. **Rule 3 (Match the Implementation).** When `cli.js` does perform a given operation, OCP must match it byte-for-byte on the wire: same path, same method, same headers (including casing and ordering constraints), same body schema, same auth scheme. Deviations require an explicit, reviewed exception recorded in this file.

4. **Rule 4 (Unalignable Features Are Deleted).** Any existing OCP feature that cannot be traced to a concrete `cli.js` reference is deleted. There is no "grandfathering" and no "keep it disabled." The policy is removal, not deprecation. See the Unalignable Policy section below.

5. **Rule 5 (Cite Line Numbers in Commits).** Every commit that touches `server.mjs` must reference `cli.js` by line number or function name in the form `cli.js:NNNN` or `cli.js vE4 <functionName>`. Commits asserting "Claude Code uses X" without such a citation are blocked by CI and must be reverted on detection.

---

## Golden Reference: `cli.js`

`cli.js` is the Claude Code CLI JavaScript bundle shipped inside the `@anthropic-ai/claude-code` npm package. It is the single source of truth for "what Claude Code actually does."

### Canonical paths per machine

| Machine / environment | Path |
| --- | --- |
| macOS (npm global) | `/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js` |
| macOS (nvm) | `~/.nvm/versions/node/*/lib/node_modules/@anthropic-ai/claude-code/cli.js` |
| Linux (npm global) | `/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js` |
| Linux (OCI opc user) | `~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js` |
| Windows (npm global) | `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js` |
| Raspberry Pi (nvm) | `~/.nvm/versions/node/*/lib/node_modules/@anthropic-ai/claude-code/cli.js` |

### Current audit pin

- **Claude Code version under audit:** `2.1.89`
- **`cli.js` SHA-256:** `a9950ef6407fdc750bddb673852485500387e524a99d42385cb81e7d17128e01`
- **Audit date:** `2026-04-20`
- **Auditor:** `project maintainer`

The audit pin is updated once per year (see Annual Alignment Audit) and whenever a drift incident forces a re-verification.

---

## Historical Lesson: The 2026-04-11 Drift

On 2026-04-11, commit `b87992f` ("fix: use dedicated /api/oauth/usage endpoint for reliable plan data") was merged. The commit message asserted that `/api/oauth/usage` was "the dedicated usage endpoint that Claude Code CLI uses."

**This assertion was false.** The string `/api/oauth/usage` does not appear in `cli.js` at any version shipped up to that date. The endpoint was fabricated by an LLM-assisted authoring pass that generalized from adjacent OAuth paths without verifying against `cli.js`. A follow-up commit `cb6c2a8` ("fallback to stale cache on usage API 429 + extend cache to 15min") compounded the error by caching the fabricated response to hide the 4xx failures.

**Impact:** The `/usage` progress bar in the dashboard was broken for nine days (2026-04-11 through 2026-04-20) before the drift was isolated.

**Root cause:** LLM hallucination accepted without `grep cli.js` verification, compounded by the absence of a CI blacklist and the absence of this constitution.

**Fix commit:** `fd7973a` (PR #21 — restored header-based `/usage`); follow-up `01e260c` (PR #24 — OAuth Bearer header correction)

**Lesson codified:** Rules 1, 2, and 5 of this document; the CI blacklist in `.github/workflows/alignment.yml`; and the PR template evidence section exist to make the 2026-04-11 drift structurally impossible to repeat.

---

## Unalignable Policy

A feature is **unalignable** if, after a good-faith search, it cannot be mapped to a specific `cli.js` line range or function.

- Unalignable features are **deleted**, not disabled, not feature-flagged, not deprecated.
- Deletion is the default outcome of an alignment audit finding. The burden of proof is on the feature, not on the auditor.
- A deletion PR does not require user-facing deprecation notice, because the feature was never legitimately in scope.
- If a user workflow depended on an unalignable feature, the correct remediation is to upstream the behavior into `cli.js` or to move it out of OCP into a separate tool. OCP does not retain it.

---

## Annual Alignment Audit

- **Date:** 11 April each year (the anniversary of the `b87992f` drift).
- **Scope:** Diff the current `cli.js` against the pinned SHA-256 in the Golden Reference section. For every network call in `server.mjs`, re-verify that the corresponding `cli.js` reference still exists at the cited line numbers (adjust citations if line numbers shifted across Claude Code versions).
- **Output:** A signed audit note committed to `docs/alignment-audits/YYYY-04-11.md`, updating the pin.
- **Failure mode:** Any audit finding that cannot be reconciled triggers an immediate deletion PR per the Unalignable Policy.

---

## Amendment Procedure

This constitution is amended only by a PR that (a) cites the evidence motivating the amendment, (b) is reviewed by an independent reviewer per CC Iron Rule 10, and (c) updates the Historical Lesson section if the amendment was driven by an incident. Amendments never retroactively legitimize previously unalignable features.
