@AGENTS.md
@~/.cc-rules/AGENTS.md

# OCP Project Session Instructions

> **WARNING — READ BEFORE WRITING ANY CODE IN THIS REPO**
>
> Before touching `server.mjs` or any network-facing surface, read [`./ALIGNMENT.md`](./ALIGNMENT.md) in full. The constitution is binding. Non-compliant commits are reverted.

---

## Before starting any task

1. Read `./ALIGNMENT.md`. Internalize the five Rules and the 2026-04-11 drift lesson.
2. Run `/dev-start <task description>` to get a pre-flight plan that incorporates the iron rules, `SKILL_ROUTING.md`, this file, and `ALIGNMENT.md`.
3. If the task touches `server.mjs`, locate the corresponding `cli.js` reference **before** drafting any code. No code is written ahead of the `grep cli.js` evidence.

---

## Hard requirements for `server.mjs` changes

Every PR that modifies `server.mjs` must satisfy all three of the following. A PR missing any one of them is blocked from merge.

1. **`cli.js` citation.** The commit message and PR body declare the corresponding `cli.js` function name and line number range, using the format `cli.js:NNNN` or `cli.js vE4 <functionName>`. If `cli.js` does not perform the operation, the PR must state this explicitly and justify scope under `ALIGNMENT.md` Rule 2 (in practice, this almost always means the PR should be closed).
2. **CI blacklist pass.** The `alignment.yml` workflow must pass. The workflow greps `server.mjs` for known-hallucinated tokens (including `api/oauth/usage` and `api/usage`) and fails the build on any hit. Do not suppress the workflow. Do not add allowlist entries without an amendment PR to `ALIGNMENT.md`.
3. **Independent reviewer (Iron Rule 10).** The implementation author may not self-approve. A separate reviewer — human or a subagent spawned with a fresh context — must read the diff, verify the `cli.js` citation by opening `cli.js` at the cited lines, and explicitly approve. A review comment that does not confirm the `cli.js` citation was checked is not a valid approval.

---

## Iron rules in force

This repo operates under the CC Development Iron Rules (CC 开发铁律) v1.3. Three rules are load-bearing for OCP work:

- **Iron Rule 10 (Code Review).** Every implementation phase has an independent reviewer. Self-review does not count. See `server.mjs` hard requirement #3 above.
- **Iron Rule 11 (Incremental Diff Review).** Non-trivial work is split into the minimum reviewable unit — one PR per layer per severity. `ALIGNMENT.md`, `CLAUDE.md`, the PR template, and the CI workflow are therefore shipped as the same constitutional PR (they are one layer: governance), but any subsequent `server.mjs` remediation lands as its own PR.
- **Iron Rule 12 (Pre-Brainstorm Prior-Art Search).** Before proposing any new endpoint or header, search GitHub, Anthropic docs, and the `cli.js` bundle. For OCP specifically, the `cli.js` grep is the decisive search: if it does not hit, Rule 2 of the constitution applies.

The full iron rules are at `~/.claude/CC_DEV_IRON_RULES.md` (symlinked from the cc-rules repo on the maintainer's workstations). Load them into session context with `/cc-rules` when needed.

---

## Skills relevant to this repo

- `/dev-start` — pre-flight planning, always first.
- `/cc-rules` — load the iron rules into context.
- `/agent-dispatch` — pick the correct model (opus for design and review, sonnet for straightforward edits, haiku for mechanical chores) before spawning any subagent.
- `/cc-mem search <keyword>` — look up cross-machine memory for prior decisions, especially prior drift incidents.

---

## Commit message conventions

- Subject line uses Conventional Commits (`fix:`, `feat:`, `docs:`, `refactor:`, `chore:`).
- Any assertion of the form "Claude Code uses X" or "cli.js uses X" in the body must be immediately followed by a citation in the form `cli.js:NNNN` or `cli.js vE4 <functionName>`. CI performs a soft check for this pattern on all commits in the PR.
- Co-author trailer is required for LLM-assisted commits (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`).

---

## Project-level escalation

If a design decision cannot be resolved by reference to `cli.js` and `ALIGNMENT.md`, escalate to the project maintainer via `/cc-chat` rather than guessing. Silent guessing is what produced the 2026-04-11 drift.

---

## Release kit overlay (CC 开发铁律 第五律 5.5)

This project's overlay per iron rule v1.4's 5.5. Machine-checkable declaration.

```yaml
release_kit:
  version_source: package.json
  changelog: CHANGELOG.md
  release_channel:
    type: github-release
    tag_format: v{semver}
    auto_create_on_tag_push: true   # via .github/workflows/release.yml
  docs_source: README.md
  resource_lists:
    - name: Available Models table
      location: README.md § "Available Models"
      source_of_truth: models.json
    - name: API Endpoints table
      location: README.md § "API Endpoints"
    - name: Environment Variables table
      location: README.md § "Environment Variables"
  new_feature_doc_expectations:
    - new CLI subcommand → README § "All Commands" + usage example
    - new env var → README § "Environment Variables" table
    - new auto-sync / hook → dedicated §, must document trigger + manual invocation + opt-out + any bootstrap quirk
    - new endpoint → README § "API Endpoints" table + any relevant Config/Troubleshooting §
    - new file / SPOT / schema → Architecture or contributor § with link
  bootstrap_quirk_policy:
    - any one-time migration quirk → README § "Troubleshooting"
```
