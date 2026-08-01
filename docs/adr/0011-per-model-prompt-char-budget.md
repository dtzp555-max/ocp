# ADR 0011 — The prompt-char budget is per-model, not one global ceiling

- **Date**: 2026-08-02
- **Status**: Accepted
- **Supersedes**: ADR 0009's Decision (the `max(models[].contextWindow) × charsPerToken`
  derivation). ADR 0009's Context — why a hand-set constant was wrong and why the budget
  should follow the SPOT — stands unchanged and is the premise of this ADR.
- **Related**: issue #213; ADR 0003 (`models.json` as SPOT); ADR 0006 (Class A/B taxonomy,
  which governs the `/settings` contract change below); PR #195, PR #208 (the SPOT-tells-the-truth
  principle, applied to `maxTokens`)

## Context

ADR 0009 replaced a hand-set 150,000-char truncation constant with a value derived from the
`models.json` SPOT. It derived exactly one number for the whole process:

```
MAX_PROMPT_CHARS = max(models[].contextWindow) × 3 chars/token
```

That `max()` created a coupling between unrelated models. `models.json` therefore could not
state the truth: the CLI registry declares `claude-opus-5`, `claude-opus-4-8`,
`claude-opus-4-7` and `claude-sonnet-5` at a native 1M window, but all four were declared at
200000, because a single `1e6` entry would have raised the ceiling from 600,000 to 3,000,000
chars for **every** model — including `claude-haiku-4-5`, which really is 200k. For that model
a 3M-char prompt is not a longer prompt, it is an upstream API rejection replacing what had
been a clean, tail-first, OCP-side truncation.

ADR 0009 saw this and deferred it: *"If `models.json` ever advertises a larger window (e.g. 1M
for the 1M-native models), the budget scales automatically — no code change. Whether to
advertise 1M is a separate, deliberate decision … explicitly NOT made by this ADR."* This ADR
is that decision.

The cost of leaving it was a standing dishonesty in the opposite direction from the one ADR
0009 fixed. #195 and #208 established that every value in the SPOT should be the truth about
the model, and #208 pinned `maxTokens` per-model against the compiled registry. `contextWindow`
was the adjacent field and was under-declaring four models by 5x, so OCP truncated prompts the
model would have accepted.

### Verified per-model windows

Extracted id-anchored from the compiled Claude Code **2.1.220** binary
(sha256 `8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081`), each record bounded
at the next `{id:"` separator — a fixed-width window bleeds into the neighbouring record and
made the two 4-6 models read as `native_1m` when they are not:

| models.json id | registry id | `context.window` | `native_1m` |
|---|---|---|---|
| `claude-opus-5` | `claude-opus-5` | 1000000 | yes |
| `claude-opus-4-8` | `claude-opus-4-8` | 1000000 | yes |
| `claude-opus-4-7` | `claude-opus-4-7` | 1000000 | yes |
| `claude-opus-4-6` | `claude-opus-4-6` | 200000 | — |
| `claude-sonnet-5` | `claude-sonnet-5` | 1000000 | yes |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | 200000 | — |
| `claude-haiku-4-5-20251001` | `claude-haiku-4-5` | 200000 | — |

Cross-validated binary-wide and independently of the per-id slices: `native_1m:!0` occurs 6
times and `context:{window:1e6` occurs 6 times, over the same six records — the four above plus
`claude-fable-5` and `claude-mythos-5`, which OCP does not expose.

## Decision

**1. The budget is looked up for the model the request named.**

```
budget(model) = models.json[model].contextWindow × 3 chars/token
```

`charsPerToken = 3` and the 150,000 floor are unchanged from ADR 0009, as is the rationale
(English ~4 chars/token, CJK ~1–1.5, so ×3 truncates gracefully at roughly the point CJK text
would otherwise reach the model's real window). Implemented as the pure
`promptCharBudgetFor(models, modelId, opts)` in `lib/prompt.mjs`; `server.mjs` resolves it from
the canonical model id at each of the three sites that bound prompt text (the `-p` text path,
the `-p` multimodal path, and the TUI path), plus the early multimodal validation pass.

**2. `models.json` now states each model's true window** — the table above. The SPOT is once
again the truth about the model, per ADR 0003 and the #195/#208 principle.

**3. A model id with no SPOT entry gets the SMALLEST known window × 3**, not the largest
(`fallbackPromptCharBudget`). For an unrecognised id the safe assumption is the most
conservative window OCP knows about; the alternative — reusing ADR 0009's `max()` — is exactly
the hazard this ADR removes. Today that is 600,000 chars. Note this path is unreachable from
`/v1/chat/completions`, which rejects unknown models with a 400 before any spawn; it exists so
the pure function is total and so a future caller cannot land an undefined ceiling.

**4. `CLAUDE_MAX_PROMPT_CHARS` and `PATCH /settings {maxPromptChars}` remain ABSOLUTE GLOBAL
overrides**, exactly as ADR 0009 specified them ("absolute overrides; the derivation applies
only when neither is set"). When either is set, that single number is the ceiling for every
model and no derivation happens. This ADR does not redefine them; it only makes the thing they
override per-model.

`GET /settings.maxPromptChars.value` reports the override when one is in force, and
`fallbackPromptCharBudget` otherwise. It stays a plain number. Because every non-1M entry is
still 200000, the unset-path value is **600,000 — the same number the field reported before
this ADR**; what changed is the rule that produces it (smallest window × 3, as the fallback
and floor) rather than the number.

## Class determination and authority

Per `CLAUDE.md` § "Classify the change first", by table lookup against `ALIGNMENT.md`
§ "Current Class B inventory":

- **`/settings` (GET, PATCH) — Class B.2**, grandfathered by ADR 0006 at v3.16.4 behaviour.
  `maxPromptChars` keeps its name, type and response shape, but **the rule that determines its
  value changes** (from "the one derived global ceiling" to "the global override, or the
  fallback budget"), and the meaning of *setting* it changes (it now overrides a per-model
  derivation). `CLAUDE.md` requirement 1's dividing question is *"does the field's documented
  meaning change?"*, not *"is the current value wrong?"* — and this is the worked example it
  names: same field, same type, new rule. That is a **contract change**, which
  `ALIGNMENT.md:114` and ADR 0006:39 / :109 make a new authorization request requiring its own
  ADR. **This ADR is that authorization**, cited alongside ADR 0006.

- **`/v1/chat/completions` — Class B.1.** No OpenAI-spec surface changes: no request field, no
  response field, no wire shape. Prompt truncation is an OCP-internal guard that OpenAI's
  specification does not govern in either direction, so B.1 imposes no additional citation
  here; the authority for the truncation *rule* is ADR 0009, which this ADR supersedes.

- **`/v1/models` — Class B.1, NOT touched.** Worth stating explicitly because "advertised
  context window" invites the assumption that it is: the handler emits only
  `{id, object, owned_by, created}` (`server.mjs`, `MODELS` is built as
  `{id, name: displayName}`), so `contextWindow` has never been on that wire. Changing it in
  `models.json` leaves the `/v1/models` response byte-identical, and no B.1 evidence is
  required for the SPOT edit.

Rule 2 is **not** cited anywhere in this change. It is a prohibition, not an authorization, and
citing it as permission is the category error recorded in the #193 thread.

## Consequences

- The four native-1M models accept prompts up to 3,000,000 chars instead of 600,000. Longer
  TTFT and materially higher quota burn per request is possible for callers that actually send
  such prompts — the same one-time trade ADR 0009 made at the 150k→600k step, one order of
  magnitude up. Operators who do not want it set `CLAUDE_MAX_PROMPT_CHARS` or
  `ocp settings maxPromptChars <n>`, which is precisely what those knobs are for.
- `claude-haiku-4-5-20251001`, `claude-opus-4-6` and `claude-sonnet-4-6` keep the 600,000-char
  ceiling they have today. This is the property the regression test pins, and it is what
  distinguishes this change from simply raising the ceiling.
- OpenClaw's compaction budget scales linearly off `contextWindow`, so syncing a 1M window
  raises OpenClaw's history budget for those models (`scripts/sync-openclaw.mjs`, ADR 0004).
  OpenClaw's own bundled registry hardcodes 200000 for Claude and upstream declined to raise it
  (openclaw#22979, closed not-planned), so OCP-registered `claude-local/*` models will now
  differ from OpenClaw's built-ins. That is the SPOT being honest, and it is the behaviour
  `ocp update` already promises.
- The three-argument coupling is gone: adding a model with any window no longer perturbs any
  other model's ceiling. The `models.schema.json` warning about the global side effect is
  removed because the side effect no longer exists.

## Rejected alternatives

**(a) Leave `models.json` at 200000 and document why it diverges.** The status quo, and issue
#213's option (a). Rejected: it keeps a 5x understatement in the SPOT that #195/#208 committed
to making truthful, and the divergence has to be re-explained in the schema, in a test comment,
and in every future review of the file. The comments were already there and were the largest
block in the schema.

**(b) Make the override a CEILING (clamp) rather than a replacement** — `min(perModel,
override)`. Rejected: it silently breaks a documented operation. `ocp settings maxPromptChars
1000000` today *raises* the budget above the derived 600,000; under a clamp it would resolve to
600,000 and appear to do nothing. It also contradicts ADR 0009's explicit "absolute overrides"
wording, which this ADR has no reason to relitigate.

**(c) Per-model overrides in the settings API** (e.g. `maxPromptChars.<model>`). Rejected as
new B.2 surface with no requester: it needs a new request shape and a new key namespace, and
would itself require an ADR under `ALIGNMENT.md` § "New Class B endpoint procedure". The
`ocp settings` client also formats a single scalar per key. If a real need appears, it is a
separate ADR.

**(d) Report a per-model map, or `null`, from `GET /settings`.** Rejected: `ocp` renders
`maxPromptChars` into a fixed-width column via `v.get('value','?')`, so a map renders as a dict
and `null` renders as `None`; and a response-shape change is a strictly larger contract change
than the semantic one this ADR already takes.

**(e) Widen the `maxPromptChars` PATCH range to 3,000,000** so an operator can express a global
override matching what a 1M model now derives. Rejected as out of scope here: it is an
independent request-validation contract change, nothing in #213 asks for it, and the range has
bounded the *override* — not the derivation — since before ADR 0009. The derivation is
deliberately not subject to that range, which is why a 1M model can exceed it.
