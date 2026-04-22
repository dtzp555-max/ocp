# 0003 — `models.json` as Single Source of Truth

- **Date**: 2026-04-20
- **Status**: Accepted
- **Authors**: project maintainer (with AI drafting assistance)
- **Related**: PR #30, commit c6f7850; precursor to ADR 0004

## Context

OCP's model catalog (the mapping from short aliases like `sonnet` and `opus` to full model IDs with context-window metadata) had organically drifted into three independent locations:

1. `server.mjs` — `MODEL_MAP` and `MODELS` arrays, hardcoded at the top of the file. This was the runtime authority for `/v1/models` responses and alias resolution.
2. `setup.mjs` — a separate `MODELS` constant, unchanged since the v3.0 era. Used only at first-install time to seed user config; by v3.10 it was stale and listed no Claude 4.x models at all.
3. `~/.openclaw/openclaw.json` (on user machines) — written exactly once by `setup.mjs` during initial OCP install and never refreshed. A user who installed OCP in v3.0 and ran `ocp update` faithfully through v3.10 still had their OpenClaw config listing only three pre-Claude-4 models.

By the v3.10.0 release, Opus 4.7 was correctly present in location (1) and absent from (2) and (3). The symptom reaching users: native Claude Code saw the new model immediately (because it queries `/v1/models` live from server.mjs), but OpenClaw users saw nothing new, and new-installers via `setup.mjs` got an incomplete initial config. Three distinct bug reports in the two weeks following v3.10.0.

The drift was structural, not a bug in any one file. The files disagreed because there was no mechanism requiring them to agree.

## Decision

Extract all model metadata into `models.json` at the repo root. `server.mjs` and `setup.mjs` both read this file and derive their in-memory `MODEL_MAP`/`MODELS` structures from it. The file is committed to the repo; it is neither generated nor cached.

Shape (summarized):

- `models` — array of entries, each with `id` (full model ID), `alias` (short name), `context_window`, and flags where relevant.
- `default_alias` — which alias resolves when the client sends an unknown or empty model.

Migration approach:

1. Hand-populate `models.json` from the v3.10.0 `server.mjs` `MODEL_MAP` values.
2. Rewrite `server.mjs` to load and index `models.json` at startup.
3. Rewrite `setup.mjs` to derive its `MODELS` constant from the same file.
4. Verify byte-equivalence: the derived `MODEL_MAP` in v3.11.0 must be a byte-identical superset of the v3.10.0 hardcoded `MODEL_MAP`. This is checked by a one-shot comparison script during the refactor PR; no regression is permitted.

Post-refactor, the contract for adding a model is: edit `models.json`, open a PR, reviewer sanity-checks the `id` string against Anthropic's model announcement, merge. No other file changes.

## Consequences

**Positive**

- Single edit point eliminates the "updated one place, forgot the other" failure mode structurally.
- `setup.mjs`'s latent staleness is repaired as a side effect — new-installers now get a fresh model list.
- Opens the door to ADR 0004 (OpenClaw auto-sync), which requires a file-based SPOT to sync from.
- The `models.json` format is stable, Markdown-friendly JSON, easy to diff in code review.

**Negative**

- One additional file to load at server startup (negligible cost, but now a startup dependency).
- Schema drift risk: if anyone adds a new field to `models.json` that `server.mjs` or `setup.mjs` doesn't know about, the field is silently ignored. A future schema version tag may be warranted if the format grows.
- `models.json` parse failure is now a fatal startup error; previously, bad model config required editing source. Consider this a feature, not a regression.

**Follow-ons**

- ADR 0004 (OpenClaw auto-sync) consumes `models.json` directly in `scripts/sync-openclaw.mjs`.
- Future additions (per-model pricing, per-model capability flags, etc.) belong in `models.json`, not scattered back across `server.mjs`.
- The README "Available Models" table is now derived documentation and its source of truth should be pinned to `models.json` in the release_kit overlay.

## Alternatives considered

**(a) Keep the three locations, enforce sync by manual review discipline.** A reviewer checklist item: "did you update all three places?" Rejected: the drift had already demonstrated that manual discipline is insufficient when the three files are in unrelated sections of the diff. Human reviewers routinely miss the third file. The 2026-04-11 alignment drift had already taught the project that discipline-only approaches fail.

**(b) YAML with SOPS field-level encryption.** Some projects prefer YAML for multi-line string readability and use SOPS to encrypt sensitive fields. Rejected: OCP's model catalog contains no secrets — model IDs, aliases, and context windows are all public information published by Anthropic. YAML adds a parser dependency and SOPS adds a decryption step at startup, both for zero benefit. JSON is already native to Node, and `models.json` is easy to diff line-by-line in GitHub review UI.

**(c) Fetch the model list live from Anthropic at server start.** Rejected: `cli.js` does not perform this operation, so per `ALIGNMENT.md` Rule 2 it is out of scope for OCP. Additionally, a live fetch introduces a startup-time network dependency and an availability coupling to Anthropic that OCP is explicitly designed to avoid (OCP is the gateway, not another consumer).
