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
- `docs/adr/` — Architecture Decision Records. Read these before proposing governance or SPOT changes. See `docs/adr/README.md` for the index.
- `docs/superpowers/plans/` — active spec-kit plans. `docs/superpowers/plans/shipped/` archives plans that have been delivered (don't propose changes against shipped plans — they're history). `docs/superpowers/specs/` holds long-lived design documents that other code references (e.g., the SSE heartbeat design referenced from `server.mjs`).
- `memory/constitution.md` — spec-kit's project constitution (its standard `memory/` location). Distinct from `~/.cc-rules/memory/` (cross-machine personal memory) and from this repo's `ALIGNMENT.md` (the OCP code-level constitution).

---

## Project-specific constraints

- **`ALIGNMENT.md` is binding.** Any PR touching `server.mjs` must cite `cli.js:NNNN` (or `cli.js vE4 <functionName>`) in the commit body and PR description. See `CLAUDE.md` § "Hard requirements for `server.mjs` changes" and ADR 0002.
- **Alignment CI is not suppressible.** The `alignment.yml` workflow greps `server.mjs` for known-hallucinated tokens (currently blocking `api.anthropic.com/api/oauth/usage`). Adding new tokens is done via PR amendment to `alignment.yml`; removing entries requires an `ALIGNMENT.md` amendment PR.
- **No self-approval.** Implementation author cannot merge their own PR (Iron Rule 10). A fresh-context reviewer must open `cli.js` at the cited lines and confirm in the review comment.
- **`models.json` is the only place to add/edit models.** Do not touch `MODEL_MAP` or `MODELS` arrays directly in `server.mjs` or `setup.mjs`. See ADR 0003.
- **OpenClaw boundary.** `scripts/sync-openclaw.mjs` only writes `models.providers["claude-local"].models` and `agents.defaults.models["claude-local/*"]` in `~/.openclaw/openclaw.json`. Do not expand scope. See ADR 0004.

---

## Testing: reaching faults inside `server.mjs`

`test-features.mjs` cannot `import` `server.mjs` (it calls `server.listen()` at top level), and that has twice led to the wrong conclusion that a class of bug is untestable. It isn't. Read this before writing "no regression test is possible here".

**There is a real live-server fixture.** `ltBoot(env, dir, nodeArgs)` (around `test-features.mjs:990`) spawns the actual `server.mjs` as a child with a **fake `claude` binary**, so integration tests cost no quota. `ltPost` / `ltWait` / `ltFreePort` / `ltDiag` round it out. It already covers boot gates, cache-epoch invalidation across two boots sharing one SQLite store, and system-prompt capture.

**`--stack-size` is a fault lever.** `ltBoot`'s third argument passes V8 flags to the child, which puts recursion- and argument-count-limited failures in reach at a much smaller input. `#193` needed a *synchronous throw* deep inside `spawnClaudeProcess`; `buildCliArgs` does `args.push("--allowedTools", ...ALLOWED_TOOLS)`, and under `--stack-size=200` that spread throws at ~24k elements instead of ~124k — which is what brings the trigger under Linux's `MAX_ARG_STRLEN` (131072 bytes for a single env string) so the test runs in CI rather than skipping. **No production fault hook was needed.**

Three rules that made it hold up, all learned the hard way:

- **Discover the threshold in a child under the same flags**, never in the test process — the parent's stack is not the one that matters.
- **Assert that the fault actually fired**, not just that the outcome looks right. `#193` asserts HTTP 500 *and* that the body carries `call stack size exceeded`; a control mutation (trigger neutered, bug still present) proves the test fails rather than passing vacuously.
- **Wait for the thing you are about to assert**, not a proxy for it. Waiting on `listening on` and then asserting a different line is a race (`#199`); waiting on `exit` and then reading `stderr` is another (`#203` — use `closed`, which guarantees the pipes drained).

Allocate ports with `ltFreePort()`. Fixed ports have caused at least one flake here.

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
5. Any active plan under `docs/superpowers/plans/` (excluding `shipped/` which is the archive).
6. `~/.cc-rules/memory/auto/MEMORY.md` — cross-machine memory index.

Only after these should the session touch code.
