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
- `models.schema.json` — the schema `models.json` declares in its `$schema`. CI validates the SPOT against it (`test-features.mjs`) using the repo's own `validateJsonSchema`, so a malformed entry fails the build instead of surfacing downstream in OpenClaw.
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

**There is a real live-server fixture.** `ltBoot(env, dir, nodeArgs)` (around `test-features.mjs:990`) spawns the actual `server.mjs` as a child with a **fake `claude` binary**, so integration tests cost no quota. `ltPost` / `ltPostStatus` / `ltWait` / `ltFreePort` round it out. It already covers boot gates, cache-epoch invalidation across two boots sharing one SQLite store, and system-prompt capture.

**`--stack-size` is a fault lever.** `ltBoot`'s third argument passes V8 flags to the child, which puts recursion- and argument-count-limited failures in reach at a much smaller input. `#193` needed a *synchronous throw* deep inside `spawnClaudeProcess`; `buildCliArgs` does `args.push("--allowedTools", ...ALLOWED_TOOLS)`, and under `--stack-size=200` that spread throws at ~24k elements instead of ~124k — which is what brings the trigger under Linux's `MAX_ARG_STRLEN` (131072 bytes for a single env string) so the test runs in CI rather than skipping. **No production fault hook was needed.**

Three rules that made it hold up, all learned the hard way:

- **Discover the threshold in a child under the same flags**, never in the test process — the parent's stack is not the one that matters.
- **Assert that the fault actually fired**, not just that the outcome looks right. `#193` asserts HTTP 500 *and* that the body carries `call stack size exceeded`; a control mutation (trigger neutered, bug still present) proves the test fails rather than passing vacuously.
- **Wait for the thing you are about to assert**, not a proxy for it. Waiting on `listening on` and then asserting a different line is a race (`#199`); waiting for the process to *exit* and then reading its `stderr` is another, because a terminated child's pipes may still hold unread data (`#203` — wait for the stdio to close, not for the exit).

Allocate ports with `ltFreePort()`. Fixed ports have caused at least one flake here.

## Testing discipline: what counts as a test

This has been enforced as a merge condition on recent test PRs (#207, #217, #218, #221) — review comments have said things like "a test that greps source is not a test" and "that antipattern is explicitly forbidden in this repo" — but until now the rule existed nowhere except inside issue #210, filed by the same person who was citing it as policy (#223). Write it down so it's citable, not remembered.

- **Behavioral, not textual.** A test that asserts on the *source text* of the thing it tests is not a test: it passes when the code is deleted and re-added wrong, and it fails on a pure reformat that changes nothing. Assert on behavior — call the function, run the process, read the output. `test-features.mjs`'s ocp-connect section (issue #210, PR #218, ~line 5690) is the model: it slices the real `model_meta` table and `get_model_meta()` out of `ocp-connect`'s own source and `exec()`s the slice in a child `python3`, rather than grepping for an expected number, because "a test that grepped ocp-connect's source text for an expected number ... would pin whatever string is on the page today, including a wrong one, and miss any regression that changes the computed VALUE without changing the literal text near it."

- **Mutation-prove every test.** An unmutated test is unverified — it may pass for the wrong reason, or always pass regardless of the code underneath it. Break the code the test guards, confirm it fails with an actionable message, restore **from a file backup** (`cp backup original`) — never `git checkout`, which operates on the whole tree and can discard uncommitted work outside the one file you meant to touch — then confirm green again. #218 and #221 both carry mutation tables in this exact shape (mutation / file / result before the fix / result after), each one reverted and the suite reconfirmed green before the next mutation; read either for the format to copy.

- **A control mutation must prove the test CAN fail.** A vacuous pass looks identical to a correct one from the green checkmark alone. #218's `py_compile`/`exec` harnesses slice `ocp-connect`'s source between two textual anchors; if the anchors are ever found in the wrong order, Python slicing silently returns `''`, and checking or executing an empty string trivially "succeeds" (`test-features.mjs` ~line 5727, documented there as "MED-1a"). Every harness in that section now asserts its slice is non-empty and contains what it must contain before doing anything else with it — write that assertion before trusting any check that depends on a slice, a filter, or a conditional having actually matched something.

- **Restoring after mutation must be diff-verified, not assumed.** After copying the backup back over the mutated file, `diff` it against the pre-mutation copy and confirm byte-identical before re-running the suite. #217, #218, and #221 all do this as standing protocol — "should be identical" is not a restore; a `diff` with no output is.

- **Guards on dynamic execution must bound capability, not scan text.** #218 went three rounds on exactly this failure shape, and `npm test` wrote a file to disk on all three while staying green. Round 1 shipped a "must not reach the next section" check on three of four python harnesses and missed it entirely on the fourth. Round 2 copied the check into the fourth, then — after a reviewer bypassed it with `open("<arbitrary path>", "w")`, which contains neither of its two known markers — broadened it to a blanket `'open(' not in blk and 'os.' not in blk` denylist across every harness. Round 3: that blanket denylist was bypassed too, by `pathlib.Path(...).write_text(...)`, which contains neither substring either — reproduced independently, file written, suite still green. The fix was structural, not another denylist: every harness that calls `exec(blk, ns)` now supplies its own minimal `ns["__builtins__"]` containing only the names the slice actually calls (`sorted`, `len`); bare names outside that dict — `open`, `__import__`, and anything reachable only through them — raise `NameError`/`ImportError` before a single byte moves. General form: if the claim is "this code cannot do X" and the implementation is "its text does not contain Y," the claim is false — a denylist is a property of source text, not of what the code can do at execution time. See `test-features.mjs`'s ocp-connect section (~line 5690 onward) for the worked example, including the scope note on what it deliberately does not defend against: it is a **drift guard, not an adversarial sandbox** — deliberate dunder traversal (`len.__self__.open(...)`) still reaches the filesystem, and that stays out of scope on purpose, because the threat model here is a slice accidentally growing into `ocp-connect`'s installer section via an ordinary edit, not a deliberate attacker.

- **Stubs for bash testing must be defined AFTER `source`, with a fake `$HOME`, and service commands (`launchctl`/`systemctl`/`pkill`/`nohup`) stubbed as failing functions.** #217's review took production OCP down: a reviewer defined a `cmd_restart` stub *before* `source`-ing the real `ocp` script, so sourcing silently overwrote the stub with the real function, and the real restart chain ran for real against a live host (`launchctl bootout` succeeded, `bootstrap` failed, the `nohup` fallback pointed at a scratch dir — the proxy stayed down until someone noticed). The corrected verification pass defines every stub *after* sourcing, never before. Give a bash harness that sources `ocp` the same isolation the JS suite already gets for free from `test-env.mjs` (`OCP_DIR_OVERRIDE` + `NODE_ENV=test`, redirecting the key store before anything can open it — #163, after `npm test` wrote real rows into the operator's live database): a scratch `$HOME`, so nothing resolves to real config. Any command that can mutate a running service (`launchctl`, `systemctl`, `pkill`, `nohup`) should be a stub that fails loudly by default, not a comment saying "don't call this for real." Constraints must be unreachable by construction, not stated as prohibitions.

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
