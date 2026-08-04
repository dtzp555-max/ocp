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
| [0002](0002-alignment-constitution.md) | Alignment Constitution | The `ALIGNMENT.md` constitution: why every `server.mjs` change requires `cli.js` citation + independent reviewer + CI blacklist pass. Background: the 2026-04-11 drift incident. **Note:** the `cli.js` citation requirement was later narrowed to Class A by ADR 0006 — see that row. |
| [0003](0003-models-json-spot.md) | `models.json` as SPOT | Why model IDs / aliases / context windows live in a single JSON file (not duplicated in `server.mjs` and `setup.mjs` arrays). v3.11.0 refactor. |
| [0004](0004-openclaw-auto-sync.md) | OpenClaw Auto-Sync | Why `scripts/sync-openclaw.mjs` runs on `ocp update`, what its scope boundary is (writes only `models.providers["claude-local"].models` and `agents.defaults.models["claude-local/*"]`), and the idempotency contract. |
| [0005](0005-no-multi-provider.md) | No Multi-Provider | Why OCP stays single-provider (Anthropic-via-cli.js) and does not extend to OpenAI / Gemini / OpenRouter. Cost estimate: ~7 weeks for a v1 that buys neither moat nor commercial readiness. Separate commercial work starts in a separate repo. |
| [0006](0006-openai-shim-scope.md) | OpenAI Shim Scope | The Class A / Class B taxonomy. Class A endpoints (`cli.js`-mirror) keep Rules 1–5 verbatim; Class B endpoints (OCP-owned compatibility surface — `/v1/chat/completions`, `/v1/models`, admin endpoints) are anchored to OpenAI's spec (B.1) or to an authorizing ADR (B.2). Triggered by PR #99 (external `response_format` honoring). Grandfathers the existing B.2 inventory at v3.16.4. |
| [0007](0007-tui-interactive-mode.md) | TUI Interactive Mode | Why TUI-mode spawns an interactive `claude` in a tmux pane (no `-p`) to reach the **subscription** billing pool (`cc_entrypoint=cli`) rather than the metered Agent SDK pool. Owns the TUI spawn machinery: entrypoint labeling, credential-isolated home, MCP hard-disable, session namespace + defunct-session reaping, the independent concurrency bound, and the `/health` `tui` block. **Single-user only** — hard FATAL on multi-user configs. |
| [0008](0008-tui-warm-pane-pool.md) | TUI Warm Pane Pool | Why `OCP_TUI_POOL_SIZE` pre-boots **single-use** `claude` panes (one turn each, own `--session-id`) — and why reuse is forbidden (`transcript.mjs` returns the last assistant entry in the file, so a reused session leaks the earlier turn's text). Measured −41% end-to-end. Defines the pool↔reaper invariant (exemption by exact name from a live registry; drain before every sweep so `kill-server` zombie reaping survives) and the standing idle-process cost. Extends ADR 0007. |
| [0009](0009-spot-derived-prompt-budget.md) | SPOT-Derived Prompt Budget | Why the prompt budget derives from `models.json` instead of a hand-set constant — the old 150k silently under-delivered the advertised window ~5×. ×3 is the CJK-safe multiplier; env/settings stay absolute overrides. **Its `max(contextWindow)` derivation was superseded by ADR 0011**; the Context (follow the SPOT, not a constant) still stands, and the "whether to advertise 1M windows is a separate decision" it defers is the decision ADR 0011 makes. |
| [0010](0010-health-verdict-semantics.md) | `/health` + `/status` Verdict Semantics | What `degraded` means on the two grandfathered B.2 endpoints: "can this proxy serve?" — an unusable `claude` binary, or **2 consecutive conclusive** auth rejections. Inconclusive probes (timeout / spawn failure) never move the verdict, because a timeout measures host load, not credentials (production served a 200 in the same minute `/health` said `degraded`). Authorizes the semantics change required by ADR 0006 ¶39/¶109, records why the auth signal is kept (`dashboard.html` has no fallback), and flags the downstream effect on `ocp update`'s post-flight check. Issue #232. **Its "Consumers of `status`" enumeration was corrected in place by issue #289** — post-flight now reads `status` rather than `auth.ok`, three of the files it listed as `auth.ok` readers never read that field, and it omitted `ocp-plugin/index.js:97`, which does. |
| [0011](0011-per-model-prompt-char-budget.md) | Per-Model Prompt-Char Budget | Why the truncation ceiling is looked up for the model the request named (`contextWindow × 3`) instead of ADR 0009's single `max()` across the registry — that `max()` forced `models.json` to under-declare every native-1M model at 200000, because one `1e6` entry would have raised the ceiling to 3M for the genuinely-200k models too and turned OCP-side truncation into upstream rejections. Declares the true registry windows (verified id-anchored against compiled CLI 2.1.220). Authorizes the Class B.2 contract change to `/settings.maxPromptChars`, which stays an **absolute global** override. Issue #213. |
| [0012](0012-additive-fields-on-grandfathered-b2.md) | Additive Fields on Grandfathered B.2 | Why adding a read-only field to an already-grandfathered Class B.2 response does not need its own ADR, the six conditions that bound that standing authorization, and the four already-shipped additions it retroactively records. |
| [0013](0013-no-openai-tool-calling.md) | No OpenAI Tool Calling | Why OCP does not emit `tool_calls`: the CLI owns its agentic loop and executes its own tools, while OpenAI's protocol is stateless and the CLIENT owns the loop — no CLI flag delegates execution back to the caller. Refuses only a FORCING `tool_choice` (which the spec says must yield `finish_reason: "tool_calls"`); a permissive `tools` list still gets a completion, because refusing that would break every client that offers tools and accepts text. Issue #311. |

## When to write a new ADR

Open one whenever:

- A structural rule is being added or changed (e.g., new SPOT, new boundary, new CI guardrail).
- A decision encodes a lesson from an incident or drift.
- A future contributor reading the code alone could plausibly undo or re-litigate the choice.

Skip ADRs for routine implementation choices (algorithm pick, naming) — those belong in commit messages.

## Format

Keep ADRs short — Context / Decision / Consequences is the standard skeleton. Cite incidents, PRs, or commits where useful.
