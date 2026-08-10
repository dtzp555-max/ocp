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
- `scripts/b2-key-snapshot.mjs` + `docs/governance/b2-response-keys.json` — the per-release record of every grandfathered Class B.2 endpoint's **response key set**, read from the wire. `npm test` boots a real `server.mjs`, probes every B.2 endpoint+method pair in `ALIGNMENT.md`'s inventory, and fails on any key-path difference from the snapshot. **If you add a field to a B.2 response, the suite goes red until you regenerate the snapshot (`node scripts/b2-key-snapshot.mjs --write`) — and regenerating is not authorization: ADR 0012 condition 5 still requires the field names in the PR body and the CHANGELOG.** A removed or renamed key is not covered by ADR 0012 at all and needs its own ADR. Introduced by #346 to replace a CHANGELOG grep that could only ever see additions whose author wrote the marker. **Since #357 there are TWO configuration profiles** (`scripts/b2-key-snapshot.mjs` § `B2_PROFILES`), each with its own snapshot block, its own two-boot stability check and its own `ALIGNMENT.md` coverage check: `probes` (the default fleet configuration) and `probesTuiPool` (`CLAUDE_TUI_MODE=true`, `OCP_TUI_POOL_SIZE=1`, `CLAUDE_SKIP_PERMISSIONS=true`), which is what guards `/health`'s `tui.pool` counter bag. Neither profile ever runs a real `claude` pane: `OCP_TUI_TMUX_BIN` points at a stub `tmux` that logs its argv and exits 1, and the suite asserts from that log that the only invocation is `list-sessions` — established by feeding a fake `tmux` to the real `reapStaleTuiSessions`: with the real `tmux` a TUI-mode boot can `kill-session` a live legacy-named `ocp-tui-<8hex>` session, and reaches `kill-server` **only when no ordinary session is present** (`lib/tui/session.mjs`'s `!othersRemain` gate). The stub is justified by the reachable `kill-session`, not by the stronger claim. The snapshot's own `notCovered` block states what it cannot see; read it before treating a green run as coverage.
- `scripts/lib/install-dir.mjs` — the single answer to **"where is this OCP installed?"**, resolved from the code's own location (`fileURLToPath(import.meta.url)`) rather than `$HOME`. `doctor.mjs` and `upgrade.mjs` each used to answer it with `join(homedir(), "ocp")`, which is wrong on any install not at `$HOME/ocp` — and the one host that isn't is the *hardened* one, relocated to `/opt` under an unprivileged user to close #328's escalation chain, so hardening moved it off the only path the updater could see. Named `resolveInstallDir`, **not** `resolveOcpDir`: `keys.mjs` already owns that name for the `~/.ocp` **data** directory. Introduced by #350 (#348).
- `ALIGNMENT.md` — the constitution. Binding for any `server.mjs` change. See ADR 0002.
- `.github/workflows/alignment.yml` — CI blacklist grep; fails the build on known-hallucinated tokens.
- `CLAUDE.md` — Claude-Code-specific session instructions + release_kit overlay (Iron Rule 5.5).
- `docs/adr/` — Architecture Decision Records. Read these before proposing governance or SPOT changes. See `docs/adr/README.md` for the index.
- `docs/superpowers/plans/` — active spec-kit plans. `docs/superpowers/plans/shipped/` archives plans that have been delivered (don't propose changes against shipped plans — they're history). `docs/superpowers/specs/` holds long-lived design documents that other code references (e.g., the SSE heartbeat design referenced from `server.mjs`).
- `memory/constitution.md` — spec-kit's project constitution (its standard `memory/` location). Distinct from `~/.cc-rules/memory/` (cross-machine personal memory) and from this repo's `ALIGNMENT.md` (the OCP code-level constitution).

---

## Project-specific constraints

- **`ALIGNMENT.md` is binding — and its five Rules are scoped to Class A.** `ALIGNMENT.md:17` limits Rules 1–5 to the `cli.js`-mirror surface. Every PR touching `server.mjs` declares its endpoint class and cites **that class's** authority in the commit body and PR description: `cli.js:NNNN` (or `cli.js vE4 <functionName>`) for Class A, the OpenAI spec section + ADR 0006 for B.1, the authorizing ADR for B.2. **Rule 2 is a prohibition, not an authorization** — it is the wrong authority for a Class B endpoint, and citing it as justification is a category error — recorded in the #193 thread as an independent-review finding the author accepted, which held that PR until the citation was corrected. Classification is a lookup in `ALIGNMENT.md` § "Current Class B inventory" plus the Hybrid note after it, not an argument. See `CLAUDE.md` § "Classify the change first" and ADR 0006. ADR 0002 records the constitution's provenance but predates the Class A/B split, so its universal framing of the citation rule is narrowed by ADR 0006 and by `ALIGNMENT.md:17`.
- **Alignment CI is not suppressible.** The `alignment.yml` workflow greps `server.mjs` for known-hallucinated tokens (currently blocking `api.anthropic.com/api/oauth/usage`). Adding new tokens is done via PR amendment to `alignment.yml`; removing entries requires an `ALIGNMENT.md` amendment PR.
- **No self-approval.** Implementation author cannot merge their own PR (Iron Rule 10). A fresh-context reviewer must independently confirm the declared class against the `ALIGNMENT.md` inventory, then open the reference that class demands — `cli.js` at the cited lines (A), the cited OpenAI spec section (B.1), or the authorizing ADR (B.2) — and name it in the review comment.
- **`models.json` is the only place to add/edit models.** Do not touch `MODEL_MAP` or `MODELS` arrays directly in `server.mjs` or `setup.mjs`. See ADR 0003.
- **OpenClaw boundary.** `scripts/sync-openclaw.mjs` only writes `models.providers["claude-local"].models` and `agents.defaults.models["claude-local/*"]` in `~/.openclaw/openclaw.json`. Do not expand scope. See ADR 0004.

---

## Testing: reaching faults inside `server.mjs`

`test-features.mjs` cannot `import` `server.mjs` (it calls `server.listen()` at top level), and that has twice led to the wrong conclusion that a class of bug is untestable. It isn't. Read this before writing "no regression test is possible here".

**There is a real live-server fixture.** `ltBoot(env, dir, nodeArgs)` (around `test-features.mjs:990`) spawns the actual `server.mjs` as a child with a **fake `claude` binary**, so integration tests cost no quota. `ltPost` / `ltPostStatus` / `ltWait` / `ltFreePort` round it out. It already covers boot gates, cache-epoch invalidation across two boots sharing one SQLite store, and system-prompt capture.

**`ltBoot` pins `tmux`, and you do not get to opt out (#384).** `lib/tui/session.mjs:54` resolves `process.env.OCP_TUI_TMUX_BIN || "tmux"` at module load, so a `CLAUDE_TUI_MODE=true` boot with that variable unset runs whatever `tmux` PATH provides — on a workstation, the operator's real one. Its boot reap issues `kill-session` for every session matching this port's prefix **or the legacy `ocp-tui-<8hex>` shape**, which is reached *even with ordinary foreign sessions present* — that is the reachable harm and the one that justifies the pin. `kill-server` is gated on `!othersRemain && sparedLive === 0` (`lib/tui/session.mjs:154`), so it fires only when the operator has **only** legacy-shaped sessions, **none at all**, or just this instance's own — never alongside an ordinary foreign session. Two tests did exactly that until #384, invisibly, because CI has no `tmux`. `ltBoot` now writes a **refusing** stub into the test's own scratch dir and pins `OCP_TUI_TMUX_BIN` at it **after** the caller's `...env` spread, unconditionally — a per-site pin is a rule the next TUI test has to remember, and a pin gated on `CLAUDE_TUI_MODE` is the same hole one level down. **A test may supply its own stub, but only a file inside its own scratch dir** (`ltTmuxStub(dir, name)`); anything else throws rather than being silently ignored. Read what the harness invoked with `ltTmuxCalls(dir)` — that log is how the guard is asserted behaviourally rather than by grepping `ltBoot`'s source. **The override lane has a live consumer**: the #346 B.2 key-set test calls `ltBootFresh(fx.env, fx.dir)` with a fixture that already pins `OCP_TUI_TMUX_BIN` to `<fx.dir>/bin/tmux` (#382), so the containment check runs once per profile on every suite run — move that `bin/` outside `fx.dir` and the snapshot test starts throwing from `ltBoot`. **Do not make the stub succeed**: a `list-sessions` that exits 0 with no output reads as "server up, zero sessions" and fires `kill-server` (`lib/tui/session.mjs:154`), i.e. the permissive shape reproduces the hazard instead of removing it.

**`--stack-size` is a fault lever.** `ltBoot`'s third argument passes V8 flags to the child, which puts recursion- and argument-count-limited failures in reach at a much smaller input. `#193` needed a *synchronous throw* deep inside `spawnClaudeProcess`; `buildCliArgs` does `args.push("--allowedTools", ...ALLOWED_TOOLS)`, and under `--stack-size=200` that spread throws at ~24k elements instead of ~124k — which is what brings the trigger under Linux's `MAX_ARG_STRLEN` (131072 bytes for a single env string) so the test runs in CI rather than skipping. **No production fault hook was needed.**

Three rules that made it hold up, all learned the hard way:

- **Discover the threshold in a child under the same flags**, never in the test process — the parent's stack is not the one that matters.
- **Assert that the fault actually fired**, not just that the outcome looks right. `#193` asserts HTTP 500 *and* that the body carries `call stack size exceeded`; a control mutation (trigger neutered, bug still present) proves the test fails rather than passing vacuously.
- **Wait for the thing you are about to assert**, not a proxy for it. Waiting on `listening on` and then asserting a different line is a race (`#199`); waiting for the process to *exit* and then reading its `stderr` is another, because a terminated child's pipes may still hold unread data (`#203` — wait for the stdio to close, not for the exit).

Allocate ports with `ltFreePort()`. Fixed ports have caused at least one flake here.

## Testing discipline: what counts as a test

Enforced as a review condition on recent test PRs (#204, #205, #208, #216, #218, #221), never written down. Its only written form was inside #210: "This is behavioral, so a mutation to the table or the fallback fails it. A source-grep test would not — and per this repo's standing rule, a test that greps source is not a test." Written down now (#223). Line numbers below are `test-features.mjs` unless noted.

- **Behavioral, not textual.** A test asserting on the *source text* of the thing it tests is not a test — it passes when the code is deleted and re-added wrong, and breaks on reformatting. Assert on behavior: call the function, run the process, read the output. The ocp-connect section (#210, #218, ~5690) `exec()`s the real `model_meta`/`get_model_meta()` sliced from `ocp-connect`'s source instead of grepping for a number. Exception this suite relies on: a textual assertion is fine for a *premise of the harness or a slice boundary*, never the behavior under test — see the heredoc-quoting check (`:5992`) and the kept `os.makedirs`/`open(config_path` anchor-drift guards (`:5792-5793`).

- **Mutation-prove every test you add or change in a PR.** Break the code it guards, confirm an actionable failure, restore, confirm green — but restore from a **file backup**, diffed byte-identical against the pre-mutation copy, never `git checkout -- <file>`. Checkout restores the file's last *committed* state, not its pre-mutation state: if the file holds the uncommitted test you just wrote, checkout silently discards it along with the mutation; a file backup can't. #218's mutation table (mutation / file / result before / result after) is the format to copy; #221 uses a different shape for the same protocol.

- **A control mutation must prove the test CAN fail** — already stated above (#193); here's the specific way it's been missed. #218's `py_compile`/`exec` harnesses slice source between two anchors; found out of order, the slice is silently `''`, and checking an empty string trivially "succeeds" (`:5790`, "anchor drift"). Assert the slice is non-empty before trusting anything downstream of it.

- **Anchor drift has a second form that a length floor makes WORSE, not better** (#347). The note above prescribes "assert the slice is non-empty", which defends the `''` form correctly. It does not defend the inverted form, and the natural guard against one is actively wrong against the other. `String.indexOf` returns **`-1`** when a marker is absent, and `slice(start, -1)` is not an error and not empty — it runs to *one before the end of the string*. Measured, in this repo, on the #347 G2 test: with the end anchor intact the slice was **109 chars**; with the end anchor broken it was **185**. The guard in place was `chain.length > 40 && chain.includes("restart")` — written specifically to catch anchor drift — and it **passed**, so the control mutation came back green and the test it was meant to prove was never proven. An empty slice is conspicuous; a longer, richer-looking slice reads as healthier than the correct one, which is why this form survives the very check added to catch its sibling. **Prescription: assert both anchors by INDEX (`start > -1 && end > start`) before slicing at all. A length floor, a substring check, or any assertion on the resulting slice is not a substitute** — those are assertions about the output of a computation whose inputs you have not established. Found by a control mutation doing its job; recorded because the guard that failed was itself the anti-drift guard.

- **Guards on dynamic execution must bound capability, not scan text.** #218 took three rounds, `npm test` writing a real file while staying green each time: a narrow two-marker denylist was shown insufficient by the author's own mutation-proof of their own fix (`open("<path>", "w")`, matching neither marker); the blanket denylist that replaced it was bypassed too, by `pathlib.Path(...).write_text(...)`. Claiming "this code cannot do X" while the implementation is "its text doesn't contain Y" is false. Fix: restrict `__builtins__` in the `exec()` namespace to only the names each slice calls — a drift guard, not an adversarial sandbox (deliberate dunder traversal still escapes, by design). Full narrative, and the harness that shipped with no guard at all (harness 3, `_OC_PROVIDER_PY`): `:5725-5782`.

- **A claim of guaranteed behaviour must cite the mutation that proves it — and a NAME is a claim.** Any sentence of the form "X is pinned by test", "X holds by construction", "X cannot happen", or "this is a faithful port of Y" is an assertion about the code, and assertions about the code are the thing this repo keeps shipping wrong. Cite the mutation row that kills the test, in the comment, the PR body, or both. Written down after a single day in which **nine** review findings across two PRs were all of this shape and **none** was a behavioural bug: the code did what it should; the prose about the code did not. Five of the nine would have been stopped here.

  The failures ran deepest at the two places nobody thinks of as prose:

  - **A name is a claim.** `classifyPostFlightProbeFailure` stamps `kind: "version-mismatch"` on *any* post-body rejection, including `status: "degraded"` with the version completely correct. A remediation whose stated method was "re-key every cell on the classification so no sentence asserts more than was measured" applied it correctly to four kinds and wrote the fifth's semantics **from its name** — in the comment whose subject was that discipline (#371 round 3). Read what assigns the value, never what it is called.
  - **A predicate is a claim.** The recurring root cause across three rounds was **cells firing on a negation instead of on positive evidence**: `lastSeen !== target` is *satisfied by a missing operand*, so an unreadable snapshot produced `SERVING THE WRONG VERSION (3.10.0, expected )`. Ask of every branch: does this fire because something was **observed**, or because something was **absent**? Note that splitting the classifier — the obvious structural fix — would not have caught this one, because the defect was in the other operand.

  Two corollaries learned the same day. **Numbers are claims too**: a comment carried "a quiet loop finishes at 1.02x nominal and a stalled one at 7.53x", figures that appeared nowhere else in the repo and contradicted a comment 2,600 lines earlier in the same commit. And **a mutation table measured under a superseded predicate must be re-measured, not carried forward** — reusing rows whose predicate changed is this defect one document up.

- **A citation into ANOTHER file goes stale exactly when your own file does not change** (#393). A merge-forward that leaves your region byte-identical is the case with no prompt to re-check, and it is the case where `server.mjs:NNNN` in your comment silently starts pointing at the wrong line — #393's review found four such citations off by ~139 lines, with the reasoning still correct. Byte-identity of the region was the argument offered for the merge being safe; it is the condition under which this fails. **Lead with the greppable anchor and treat the number as decorative**, or pin it to a stated SHA so a reader knows which tree to check it against. The same applies to a mutation table: rows keyed on another file's line numbers cannot be re-derived later.

- **Constraints must be unreachable by construction, not stated as prohibitions.** #217's review took production OCP down: a `cmd_restart` stub defined *before* `source`-ing the real `ocp` script was silently overwritten once sourced, and it ran for real against a live host (bootout ok, bootstrap failed, nohup fallback wrote to a scratch dir — proxy down until noticed). Define stubs *after* sourcing, never before. New prescription, not existing practice: a bash harness sourcing `ocp` needs its own scratch `$HOME`, and any command that can mutate a running service (`launchctl`/`systemctl`/`pkill`/`nohup`) should be a stub that fails loudly by default.

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
