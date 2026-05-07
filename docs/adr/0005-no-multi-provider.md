# 0005 — OCP Stays Single-Provider; No Multi-Provider Refactor

- **Date**: 2026-05-06
- **Status**: Accepted
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0002 (Alignment Constitution), ADR 0003 (`models.json` SPOT)

## Context

OCP's `server.mjs` reached 1667 lines and now provides response cache, per-key quota, session tracking, model-level stats, and SSE heartbeat — all targeting a single backend path: `spawn` the locally installed `cli.js` and let it transact with `api.anthropic.com`. This architecture is the source of OCP's only real differentiator: **`cli.js` behavior-level alignment** (session create-vs-resume semantics, tool_use id reuse, SSE quirks, etc.) — none of which a generic LLM gateway has, because none of them speak this protocol.

The maintainer evaluated extending OCP to support OpenAI / Gemini / OpenRouter / Together / Groq / Ollama — i.e., turning OCP into a multi-provider gateway resembling Helicone, LiteLLM, OpenRouter, or Portkey. The motivation for that extension: reduce dependency on Anthropic, broaden OCP's commercial surface, and stop being grayscale-positioned (the `cli.js` spawn pattern depends on the local Pro/Max subscription, which Anthropic could fingerprint and disable).

The honest engineering estimate for that extension:

| Phase | Net New LOC | Calendar Time (part-time) |
|---|---|---|
| Provider abstraction + OpenAI | ~1230 + schema migration | 2 weeks |
| Add Gemini | ~550 | +1.5 weeks |
| OpenAI-compatible family (OpenRouter / Together / Groq) | ~300 | +1 week |
| Tests, docs, hardening | — | +1.5 weeks |
| **Multi-provider v1** | ~2080 | **~7 weeks focused** |

That number is not the real cost. The real cost is **strategic**:

1. **Loss of unique value.** `cli.js` behavior alignment is meaningless for OpenAI / Gemini / Ollama traffic. Going multi-provider means OCP's only moat applies to ~30% of its surface; the other 70% is generic gateway code already done better by Helicone / LiteLLM.

2. **Hybrid architecture awkwardness.** A multi-provider OCP would have two paths: `spawn(cli.js)` for Claude (still grayscale, depends on Pro subscription), and direct API call for everyone else (clean, BYOK). Customers asking "what is OCP?" would hear two different answers depending on which model they pick. This is worse than either pure path.

3. **Direct competition with funded incumbents.** Helicone (~$5M raised, YC W23), OpenRouter (~$1B valuation), LiteLLM (significant enterprise revenue), Portkey, Langfuse, Cloudflare AI Gateway — all already do multi-provider gateway with mature dashboards, audit logs, SOC2, and team features. OCP would enter that market 2+ years late with one engineer.

4. **The grayscale problem isn't solved by adding providers.** As long as OCP keeps the `cli.js` spawn path for Anthropic, it remains grayscale for that path; adding OpenAI alongside doesn't make the Anthropic path any less dependent on a Pro/Max subscription that wasn't licensed for proxying.

The maintainer's separate decision (recorded in personal notes, not this repo) is that **OCP itself will not be commercialized**; it will remain a personal power tool plus open-source contribution. Any commercial gateway work, if pursued, will start from a clean codebase with BYOK from day one — not from OCP.

Given that, the multi-provider extension would buy OCP nothing: not a moat, not commercial readiness, not even meaningfully better personal utility (the maintainer overwhelmingly uses Claude).

## Decision

OCP stays single-provider. Specifically:

1. **No new providers added to `server.mjs`.** The dispatch path remains `spawn(cli.js) → api.anthropic.com`. Pull requests that introduce a `providers/` directory or a model-to-provider router are declined on the basis of this ADR.

2. **`models.json` schema stays Anthropic-only.** No `provider` field, no per-model cost/capability metadata that anticipates other providers. If non-Anthropic models ever need to be referenced (e.g., for OpenClaw provider list completeness), they live in a separate file or in OpenClaw's own config — not in OCP's SPOT.

3. **Cache improvements are in scope.** The existing response cache (in `keys.mjs`: `cacheHash` / `getCachedResponse` / `setCachedResponse` / `clearCache`) is acceptable to upgrade with stream replay, stampede protection (singleflight), per-key isolation, and Anthropic `cache_control` awareness. These reinforce the single-provider position; they do not create provider-extension surface area.

4. **Anthropic alignment work continues to be encouraged.** Anything that deepens `cli.js` behavior alignment — session lifetime, tool_use id semantics, SSE behavior, multi-account routing, model-tier observability — is the project's actual value and should be prioritized over generic-gateway features.

5. **Commercial work, if pursued, starts elsewhere.** A separate repository, separate name, BYOK from day one, no `cli.js` spawn. That repo is out of scope for OCP and is not bound by this ADR.

## Consequences

**Positive**

- Project scope stays bounded. The maintainer can keep evolving OCP at part-time pace without the multi-provider maintenance burden (every provider's API breaks at some point and demands attention).
- The unique value (`cli.js` alignment) is preserved and continues to compound — every new alignment fix increases OCP's distance from generic gateways.
- Future contributors reading the code see one architecture, not a hybrid; debugging stays tractable.
- Decisions about commercialization are decoupled from OCP's technical evolution. OCP can stay grayscale-personal-tool indefinitely without that being a blocker for any future commercial product.

**Negative**

- OCP cannot serve any user who needs OpenAI / Gemini / local LLM access. Those users must route through a different gateway (Helicone, LiteLLM, OpenRouter) or call providers directly.
- If Anthropic substantially changes `cli.js` (e.g., adds client attestation, removes the spawn-and-forward pattern, or migrates `claude` to a non-CLI form factor), OCP's core architecture breaks and there is no second backend to fall back to.
- The maintainer must resist a recurring temptation: "while I'm in here, let me just add OpenAI." The whole point of this ADR is to make that temptation cost a documented amendment, not a quiet PR.

**Neutral**

- This ADR records a non-decision in code: nothing in `server.mjs` changes today. Its purpose is to make future contributors (including the maintainer) explain themselves before going against it. Per the project's PR template and Iron Rule 11, an amendment to this ADR is the gating step before any provider-extension PR.

## Trigger conditions for revisiting this ADR

This ADR should be revisited (and possibly amended or superseded) if any of the following occur:

1. Anthropic ships a feature that breaks the `cli.js` spawn pattern OCP depends on, and the maintainer wants to keep OCP useful.
2. The maintainer makes a deliberate decision to commercialize OCP (rather than start a separate codebase). This requires explicit re-scoping; "let me try" is not enough.
3. A genuine user need emerges — e.g., the maintainer themselves starts using OpenAI / Gemini frequently from Claude Code workflows — that single-provider OCP cannot serve.

In all three cases, the response is **first amend this ADR**, then write code. Order is not optional.
