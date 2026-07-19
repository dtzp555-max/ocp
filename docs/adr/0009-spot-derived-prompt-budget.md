# ADR 0009 — Prompt-char budget derives from the models.json SPOT

Date: 2026-07-18
Status: Accepted (maintainer directive, 2026-07-18: "37.5k 截断未免太短了吧 … 这个在现在还适用吗")

## Context

`MAX_PROMPT_CHARS` (the tail-first truncation guard in `messagesToPrompt`) defaulted to a
hand-set constant of 150,000 chars ≈ 37.5k English tokens — set in the 200k-window era as a
runaway-context guard. Meanwhile `models.json` advertises `contextWindow: 200000` for every
model (and the underlying CLI registry carries 1M native windows for Opus 4.8 / Sonnet 5), and
`scripts/sync-openclaw.mjs` feeds that 200k into OpenClaw's compaction budget. The result was
a standing dishonesty identified in the PR #152 review: **no advertised contextWindow value was
true**, because the proxy silently guillotined every request at ~37.5k tokens — roughly 5×
below the advertised window — logging only a server-side warning the client never sees.

Raising the constant to another hand-set number would rot the same way. Following the model's
native 1M directly is also wrong: chars ≠ tokens (CJK runs ~1–1.5 chars/token vs ~4 for
English, so a 1M-token char cap would let CJK text sail past the model's real window into an
upstream rejection), single near-window requests can consume a large fraction of a 5-hour
subscription quota window, and the TUI paste path is untested at megabyte scale.

## Decision

The default budget **derives from the SPOT** instead of being a constant:

```
MAX_PROMPT_CHARS (default) = max(models.json models[].contextWindow) × 3 chars/token
                            = 200000 × 3 = 600,000 chars today
```

Implemented as the pure `derivePromptCharBudget(models, {charsPerToken = 3, floor = 150000})`
in `lib/prompt.mjs` (unit-tested; floor guards degenerate SPOT states). The multiplier ×3 is
deliberately conservative: full window for English, and CJK text reaches the model's real
window at roughly the same point the cap fires — so OCP truncates gracefully (tail-first)
instead of the upstream rejecting outright.

`CLAUDE_MAX_PROMPT_CHARS` (env) and the runtime settings API remain **absolute overrides**;
the derivation applies only when neither is set.

## Consequences

- The advertised `contextWindow: 200000` becomes honest: the proxy now actually accepts
  prompts of that order (English ≈150–200k tokens) before truncating.
- If `models.json` ever advertises a larger window (e.g. 1M for the 1M-native models), the
  budget scales automatically — no code change. Whether to advertise 1M is a **separate,
  deliberate decision** (quota burn per request, OpenClaw compaction memory, TUI paste
  limits) and is explicitly NOT made by this ADR; the current recommendation is to keep
  200000 advertised until a real >200k use case appears.
- One-time behavior change: requests between 150k and 600k chars that were previously
  truncated now pass through whole — longer TTFT and higher quota consumption for those
  requests, by design.
- The truncation mechanism, logging, and the multimodal-path budget threading (PR #154's F2,
  pending) are unchanged — only the default value's provenance changed.
