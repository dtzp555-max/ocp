# Architecture Decision Records

This directory holds the OCP Architecture Decision Records (ADRs) — short documents that capture the **why** behind structural choices.

Read these before proposing governance, SPOT (single-source-of-truth), or process changes.

## Numbering

ADRs start at `0002`. The first one (`0001`) was reserved for an early
internal proposal that was superseded before publication; `0002` is
deliberately the first published record so the archived `0001` slot
remains a placeholder rather than being silently renumbered.

New ADRs increment from the highest existing number. Filenames are
`NNNN-<short-slug>.md`.

## Index

| ADR | Title | What it covers |
|---|---|---|
| [0002](0002-alignment-constitution.md) | Alignment Constitution | The `ALIGNMENT.md` constitution: why every `server.mjs` change requires `cli.js` citation + independent reviewer + CI blacklist pass. Background: the 2026-04-11 drift incident. |
| [0003](0003-models-json-spot.md) | `models.json` as SPOT | Why model IDs / aliases / context windows live in a single JSON file (not duplicated in `server.mjs` and `setup.mjs` arrays). v3.11.0 refactor. |
| [0004](0004-openclaw-auto-sync.md) | OpenClaw Auto-Sync | Why `scripts/sync-openclaw.mjs` runs on `ocp update`, what its scope boundary is (writes only `models.providers["claude-local"].models` and `agents.defaults.models["claude-local/*"]`), and the idempotency contract. |
| [0005](0005-no-multi-provider.md) | No Multi-Provider | Why OCP stays single-provider (Anthropic-via-cli.js) and does not extend to OpenAI / Gemini / OpenRouter. Cost estimate: ~7 weeks for a v1 that buys neither moat nor commercial readiness. Separate commercial work starts in a separate repo. |

## When to write a new ADR

Open one whenever:

- A structural rule is being added or changed (e.g., new SPOT, new boundary, new CI guardrail).
- A decision encodes a lesson from an incident or drift.
- A future contributor reading the code alone could plausibly undo or re-litigate the choice.

Skip ADRs for routine implementation choices (algorithm pick, naming) — those belong in commit messages.

## Format

Keep ADRs short — Context / Decision / Consequences is the standard skeleton. Cite incidents, PRs, or commits where useful.
