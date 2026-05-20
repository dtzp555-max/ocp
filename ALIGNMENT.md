# OCP Alignment Constitution

**Status:** Active. This document is the supreme source of truth for OCP scope decisions. Conflicts with other documents (README, issues, prior commit messages) resolve in favor of this file.

---

## Core Principle

OCP (Open Claude Proxy) is a **proxy layer** for the Claude Code CLI. It forwards, observes, and multiplexes the traffic that `cli.js` already emits. It is **not** an extension layer. If `cli.js` does not perform a given operation, or performs it differently, OCP does not invent one.

This Core Principle applies in full to **Class A** endpoints (the `cli.js`-mirror surface). A second class of endpoint — **Class B**, the OCP-owned compatibility surface — has its own scope discipline anchored to its own specification authority. See "Scope Clarification: OCP-Owned Compatibility Endpoints (Class B)" below and ADR 0006.

---

## Rules

The following Rules apply to **Class A operations** (the `cli.js`-mirror surface — the inbound `/v1/messages` forwarding route, the outbound `/v1/messages` wire call used by `handleUsage()` for rate-limit-header extraction, the OAuth bearer machinery, and any future operations OCP forwards from `cli.js` to Anthropic). For the Class B mapping of each rule, see the Class B section below.

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

A feature is **unalignable** if, after a good-faith search, it cannot be mapped to a specific `cli.js` line range or function (Class A) or to a specific OpenAI specification section AND an authorizing ADR (Class B).

- Unalignable features are **deleted**, not disabled, not feature-flagged, not deprecated.
- Deletion is the default outcome of an alignment audit finding. The burden of proof is on the feature, not on the auditor.
- A deletion PR does not require user-facing deprecation notice, because the feature was never legitimately in scope.
- If a user workflow depended on an unalignable feature, the correct remediation is to upstream the behavior into `cli.js` (Class A) or into OpenAI's spec (Class B) or to move it out of OCP into a separate tool. OCP does not retain it.

---

## Scope Clarification: OCP-Owned Compatibility Endpoints (Class B)

OCP has two classes of endpoint. Rules 1–5 above were drafted in the aftermath of the 2026-04-11 forwarding drift and are written in the language of a one-to-one proxy; they apply verbatim to **Class A** endpoints. **Class B** endpoints — the OCP-owned compatibility surface where `cli.js` is not the wire authority — have their own scope discipline, anchored to their own specification authority. The full rationale lives in **ADR 0006 (OpenAI Shim Scope)**.

**Class A** — `cli.js`-mirror endpoints. The endpoint exists because `cli.js` performs the equivalent operation and OCP forwards, observes, or multiplexes that operation. Rules 1–5 above apply verbatim. Citation format: `cli.js:NNNN` or `cli.js vE4 <functionName>`.

**Class B** — OCP-owned compatibility endpoints. The endpoint exists because OCP itself surfaces it, with no `cli.js` analogue. Two sub-buckets: **B.1** (OpenAI-compatibility surface — protocol authority is OpenAI's `/v1/chat/completions` specification) and **B.2** (OCP-administrative surface — authority is the ADR that authorized the endpoint's existence).

### Grandfather provision for existing B.2 inventory

ADR 0006 retroactively authorizes the B.2 endpoints listed in the inventory table below, **frozen at their current behaviour as of v3.16.4**. This is a one-time provision; it does not extend to new B.2 endpoints or to B.1 endpoints. Any change to the contract (request shape, response shape, semantics) of a grandfathered B.2 endpoint is treated as a new authorization request and requires either a behaviour-preserving refactor PR or its own ADR. Any new B.2 endpoint, or any new method on a grandfathered B.2 endpoint, requires its own ADR before merge.

### Current Class B inventory

| Endpoint | Method | Sub-bucket | Authorizing ADR |
|---|---|---|---|
| `/v1/chat/completions` | POST | B.1 (OpenAI-compat) | ADR 0006 |
| `/v1/models` | GET | B.1 (OpenAI-compat) | ADR 0006; content sourced from `models.json` per ADR 0003 |
| `/health` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/dashboard` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/sessions` | GET, DELETE | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/logs` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/status` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/settings` | GET, PATCH | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/keys` | GET, POST | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/keys/:id` | DELETE | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/keys/:id/quota` | GET, PATCH | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/api/usage` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/cache/stats` | GET | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |
| `/cache` | DELETE | B.2 (administrative) | ADR 0006 (grandfathered as of v3.16.4) |

**Hybrid note.** `/usage` is a hybrid endpoint: the underlying call to `api.anthropic.com/v1/messages` (used to extract `anthropic-ratelimit-unified-*` headers, per the in-file comment block at `server.mjs` line 845–849) is Class A and requires the standard `cli.js` citation; the local synthesis layer that adds `proxy:` stats and `models:` snapshot is Class B and is authorized by ADR 0006. A PR touching only the wire-call layer is Class A; a PR touching only the synthesis layer is Class B; a PR touching both must satisfy both citation requirements.

### Class B citation requirement

Class B PRs cite **the relevant specification section + the authorizing ADR**, in place of `cli.js:NNNN`. Examples:

- B.1: "OpenAI `chat/completions` API, `response_format` parameter (https://platform.openai.com/docs/api-reference/chat/create), authorized by ADR 0006."
- B.2 (grandfathered): "Authorized by ADR 0006 (grandfathered as of v3.16.4)."
- B.2 (with its own ADR): "Authorized by ADR 00NN (the ADR that originally authorized the endpoint)."

### Rule mapping for Class B

| Class A rule | Class B mapping |
|---|---|
| Rule 1 (Grep First) | Read the cited OpenAI spec section (B.1) or the authorizing ADR (B.2) before writing code. Record the spec URL and ADR number in the PR body. |
| Rule 2 (No Invention) | OCP must not introduce fields or behaviour not present in OpenAI's spec for the endpoint (B.1) or outside the scope of the authorizing ADR (B.2). For grandfathered B.2 endpoints, "scope" is the v3.16.4 behaviour snapshot. |
| Rule 3 (Match the Implementation) | Match OpenAI's spec wire-format (B.1) or the ADR's specified behaviour (B.2). |
| Rule 4 (Unalignable Features Are Deleted) | A Class B endpoint that maps to nothing in OpenAI's spec **and** lacks an authorizing ADR (including not being in the grandfather inventory) is unalignable and is deleted on the same terms as a Class A unalignable feature. |
| Rule 5 (Cite Line Numbers in Commits) | Cite the OpenAI spec section URL + authorizing ADR number in the commit body (B.1) or the authorizing ADR number alone (B.2). |

### New Class B endpoint procedure

Any new Class B endpoint, or any new method on an existing Class B endpoint (including grandfathered ones), requires its own ADR before merge. An "ADR-less" new Class B endpoint is itself an alignment finding under Rule 4.

---

## Annual Alignment Audit

- **Date:** 11 April each year (the anniversary of the `b87992f` drift).
- **Scope (Class A):** Diff the current `cli.js` against the pinned SHA-256 in the Golden Reference section. For every network call in `server.mjs`, re-verify that the corresponding `cli.js` reference still exists at the cited line numbers (adjust citations if line numbers shifted across Claude Code versions).
- **Scope (Class B):** Audit B.1 endpoints against OpenAI's current `/v1/chat/completions` specification snapshot. Audit B.2 endpoints against their authorizing ADR — for grandfathered endpoints, verify the endpoint behaviour still matches its v3.16.4 snapshot; for ADR-specific endpoints, verify behaviour still matches the ADR. The B.1 specification pin lives in `docs/openai-compat-pin.md` (created alongside the first B.1 audit; not required for ADR 0006 to land).
- **Output:** A signed audit note committed to `docs/alignment-audits/YYYY-04-11.md`, updating the Class A pin and (once `docs/openai-compat-pin.md` exists) the B.1 pin.
- **Failure mode:** Any audit finding that cannot be reconciled triggers an immediate deletion PR per the Unalignable Policy.

---

## Amendment Procedure

This constitution is amended only by a PR that (a) cites the evidence motivating the amendment, (b) is reviewed by an independent reviewer per CC Iron Rule 10, and (c) updates the Historical Lesson section if the amendment was driven by an incident. Amendments never retroactively legitimize previously unalignable features.
