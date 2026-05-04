Inherits: @~/.cc-rules/AGENTS.md

# OCP — Open Claude Proxy — Agent Guidelines

**Scope**: the `dtzp555-max/ocp` repository.
**Audience**: any AI coding agent (Claude Code / Cursor / OpenCode / Copilot / Codex / Gemini) touching OCP source.

---

## What this project is

OCP (Open Claude Proxy) is an open-source HTTP gateway that sits between the Claude Code CLI (`cli.js`) and Anthropic's public API. It forwards, observes, and multiplexes traffic that `cli.js` already emits — it is explicitly **not** an extension layer. A secondary role: registering OCP as a local provider inside OpenClaw (a sibling IDE-agnostic tool), so that users running OpenClaw against OCP see the same model list as native Claude Code.

Runtime: Node.js (ESM, `.mjs` throughout). No build step. No bundler. `server.mjs` is the single executable entrypoint; `ocp` and `ocp-connect` are CLI wrappers.

---

## Stack

- Node.js >=18, native ESM modules
- `http`/`https` built-ins for the proxy core (no Express, no Fastify)
- `models.json` as the single source of truth for model metadata
- GitHub Actions for CI (`alignment.yml`, `release.yml`)
- `gh` CLI assumed for PR creation and release automation
- No TypeScript. No test framework beyond `test-features.mjs` (run via `npm test`; CI workflow `.github/workflows/test.yml`). Keep dependencies minimal.

---

## Key files to know

- `server.mjs` — the proxy itself; every request path lives here. Governed by `ALIGNMENT.md`.
- `models.json` — single source of truth for model IDs, aliases, and context windows. See ADR 0003.
- `setup.mjs` — first-time installer; reads `models.json` to derive bootstrap config.
- `scripts/sync-openclaw.mjs` — idempotent OpenClaw registry sync invoked by `ocp update`. See ADR 0004.
- `ocp` — user-facing CLI (install, update, start, stop, status, logs, etc.).
- `ALIGNMENT.md` — the constitution. Binding for any `server.mjs` change. See ADR 0002.
- `.github/workflows/alignment.yml` — CI blacklist grep; fails the build on known-hallucinated tokens.
- `CLAUDE.md` — Claude-Code-specific session instructions + release_kit overlay (Iron Rule 5.5).
- `docs/adr/` — Architecture Decision Records. Read these before proposing governance or SPOT changes.

---

## Project-specific constraints

- **`ALIGNMENT.md` is binding.** Any PR touching `server.mjs` must cite `cli.js:NNNN` (or `cli.js vE4 <functionName>`) in the commit body and PR description. See `CLAUDE.md` § "Hard requirements for `server.mjs` changes" and ADR 0002.
- **Alignment CI is not suppressible.** The `alignment.yml` workflow greps `server.mjs` for known-hallucinated tokens (including `api/oauth/usage`, `api/usage`). Adding to the blacklist is fine; removing entries requires an `ALIGNMENT.md` amendment PR.
- **No self-approval.** Implementation author cannot merge their own PR (Iron Rule 10). A fresh-context reviewer must open `cli.js` at the cited lines and confirm in the review comment.
- **`models.json` is the only place to add/edit models.** Do not touch `MODEL_MAP` or `MODELS` arrays directly in `server.mjs` or `setup.mjs`. See ADR 0003.
- **OpenClaw boundary.** `scripts/sync-openclaw.mjs` only writes `models.providers["claude-local"].models` and `agents.defaults.models["claude-local/*"]` in `~/.openclaw/openclaw.json`. Do not expand scope. See ADR 0004.

---

## Release protocol

OCP follows the machine-readable `release_kit:` overlay in `CLAUDE.md` (Iron Rule 5.5). Before any version bump or tag push, re-read that YAML block and walk every item in `new_feature_doc_expectations` and `bootstrap_quirk_policy`. Tag push triggers `.github/workflows/release.yml`, which creates the GitHub Release automatically — do not create the release manually.

Version is sourced from `package.json`; changelog from `CHANGELOG.md`; user-facing docs from `README.md`.

---

## Handoff expectations

A fresh session picking up OCP work should read, in order:

1. This file (`AGENTS.md`).
2. `ALIGNMENT.md` — constitution; non-optional.
3. `CLAUDE.md` — tool-specific instructions and release_kit overlay.
4. `docs/adr/` — most recent ADRs first; they explain why the current structure exists.
5. Any active spec under `docs/superpowers/specs/*/tasks.md` (if present).
6. `~/.cc-rules/memory/auto/MEMORY.md` — cross-machine memory index.

Only after these should the session touch code.
