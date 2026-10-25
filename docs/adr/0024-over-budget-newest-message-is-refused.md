# ADR 0024 — A newest message that cannot fit the prompt budget is refused, not truncated away

- **Status**: Proposed — awaiting maintainer sign-off (the maintainer marks it Accepted, with the date, before this PR merges)
- **Date**: 2026-10-25
- **Amends**: [ADR 0009](0009-spot-derived-prompt-budget.md) and [ADR 0011](0011-per-model-prompt-char-budget.md) — the truncation rule, for the one case where it dropped the question itself. Their budget (`contextWindow × 3`, per model, overridable) is unchanged.
- **Class**: B.1 (`/v1/chat/completions`). No request field and no response field is added. ADR 0011 recorded that OpenAI's specification does not govern the truncation rule in either direction; this ADR changes one *outcome* of that rule (serve a degraded prompt → refuse), so the only specification it leans on is the shape of the error object. ADR 0006 route: not a grandfathered B.2 endpoint, so no contract-change ADR is needed beyond this amendment.
- **Related**: external review of `6cf0198` (finding R4); the image-in-TUI refusal in `handleChatCompletions` (PR #154, F1), which is the same principle applied earlier

## Context

`messagesToPrompt` keeps system messages, then walks the rest newest-first keeping whole messages while they fit, and prepends a note saying how many older messages were dropped. ADR 0009 chose this over letting the upstream reject outright: *graceful, tail-first*.

The loop's degenerate case was never decided. When the **newest** message alone does not fit, nothing is kept, and the prompt is the note and nothing else. Measured on `566b936`, haiku (budget 600,000 characters), with a fake `claude` that records its stdin:

| request | HTTP | what the CLI received |
|---|---|---|
| one user message, 500,000 chars (control) | 200 | the message, whole |
| one user message, 700,000 chars | 200 | `[System] Note: 1 older messages were truncated to fit context limit.` — 68 characters |
| `[user "hi", assistant "yo", user 700,000 chars]` | 200 | the same note, counting the question as an "older message" |
| older message 700,000 chars, newest message short | 200 | note + the short newest message (the designed case) |
| newest user turn: 700,000 chars of text + one image | 200 | the **head** of the question cut off, a note in front |

The client gets a 200 and an answer to a question the model never saw. `handleChatCompletions` already refuses the same shape elsewhere: an image in TUI mode is a 400, not a 200 about a picture the model never saw (PR #154, F1). That code comment describes the outcome as one ALIGNMENT.md forbids; ALIGNMENT.md does not contain that sentence (grep, 2026-10-25), so this ADR rests on the precedent in code and on the Responses API's `truncation: disabled` default (400), not on a constitutional citation.

The behaviour was also load-bearing for the suite: the #213 per-model budget tests, their TUI twin and ADR 0011's `maxPromptChars` test all drive truncation with one oversized user message, because that was the cheapest input that logs `prompt_truncated` — and each one asserts the request still reaches the spawn.

## Decision

1. **History trimming is unchanged.** Older messages are still dropped oldest-first, with the in-band note.
2. **The newest non-system message is never trimmed.** If it cannot fit, the request is refused: HTTP **400**, body `{"error": {"message", "type": "invalid_request_error", "param": "messages", "code": "context_length_exceeded"}}`. All four fields are present because OpenAI's `Error` object (`components.schemas.Error`, openapi 2.3.0) requires all four. `code` is the string OpenAI's own clients key on for an over-long prompt; the openapi file does not enumerate codes, so that is OCP's choice of the established spelling, not a citation.
3. **The refusal happens before anything is spent.** It is decided in `handleChatCompletions` ahead of the quota gate, the counters, the cache and the spawn, so a refused request consumes nothing and `stream: true` gets a plain JSON 400 (no SSE headers are out yet). The suite pins "before the spawn" and the JSON 400 on `stream: true`; "before the quota gate, the counters and the cache" holds by the pre-flight's position in the handler and is not separately pinned. The pre-flight runs the lane's own builder with **the lane's own option objects** (`P_LANE_PROMPT_OPTS`, `TUI_LANE_PROMPT_OPTS`, `streamJsonBuildOpts`), not a restatement of them; on the TUI lane it includes the first structured-output attempt's steering instruction, which travels inline there. The builders refuse on their own as well, so a caller that skipped the pre-flight fails loudly rather than serving a prompt without its question. One case is refused late: in TUI mode a structured retry whose escalated instruction tips the prompt over the budget is refused (still the same 400, logged with `stage: "lane"`) after the earlier attempt ran. That mapping is checked at the function level in review, not by the suite: reaching it needs a model reply that fails JSON validation, which the suite's stubbed TUI lane cannot produce. The event is logged as `prompt_refused`, not `prompt_truncated`: a refusal is not a truncation.
   *Why the option objects are shared:* the first version of the pre-flight spelled the options out again and got two wrong — the image check counted a continuation note the `-p` lane never sends under `OCP_MULTIBLOCK_INPUT` (refusing a vision tool turn base served whole), and the TUI check left out the note and the structured instruction that lane does send (passing requests `callClaudeTui` then refused as a 500). Found by the independent review.
   *What the 400 says:* the budget, and the newest message's real room — the largest it could have been, everything else unchanged, and still be served. The budget alone is not the line once history, a continuation note or inline system text is present. When nothing else in the request leaves any room at all (TUI, where inline system text alone exceeds the budget), the 400 says that instead of printing a room.
4. **"Cannot fit" is stated per path, and the two differ on purpose:**
   - text path (`-p` text, TUI): once the whole conversation exceeds the budget, the newest message must satisfy `length + 2 ≤ maxChars − systemChars − 200`. A single message is served whole up to `maxChars` minus any continuation note the lane appends after it (TUI always; `-p` only with `OCP_MULTIBLOCK_INPUT=0`); above that, it is refused. In TUI mode system messages travel inline and count against the budget; on the `-p` path they travel in `--system-prompt-file` and do not.
   - image path (stream-json): the newest message's **text**, counting the two-character separator in front of it when it is not the first message, must not exceed `maxTextChars` — including the continuation note only when the lane sends one (with `OCP_MULTIBLOCK_INPUT=0`; by default the note travels in the system prompt). Images never count.
   So the text path's line sits 200 characters lower than the image path's (`max − system − 202` against `max − 2` for a non-first message): that is the room the text path keeps for its own truncation note, and the image path has none to keep.
5. **Operators move the line, not the rule.** `CLAUDE_MAX_PROMPT_CHARS` / `maxPromptChars` still override the derived budget (ADR 0011), and the `× 3` factor stands.
6. **Not decided here:** older history dropped by the budget is still invisible to the client (the note is in-band only). OpenAI's own Responses API names that choice (`truncation: auto`, dropping input items in the middle) and defaults to the opposite (`disabled` → 400). Whether OCP should refuse *any* over-budget conversation is a separate decision with a much larger blast radius, and nothing here pre-empts it.

## Consequences

- A request that used to return 200 with an answer about nothing now returns 400. Nobody was getting a correct answer from it, so the observable regression is one status code and a body.
- The budget is deliberately conservative (`× 3`): an English message of roughly 600,000–800,000 characters would fit the model's real window and is now refused where it was previously reduced to a note. The remedy is the existing one — raise the override — and the 400 says what the budget was.
- The request-size cap (`CLAUDE_MAX_BODY_SIZE`, 413) is unchanged and still applies first.
- Three tests used the silent behaviour as a probe and now use the designed case instead (an oversized *older* message with a short newest one); one pair of image-path unit tests that pinned the head-cut of a single newest message now pins the refusal, and the mid-block cut is pinned where it still applies — on the older message at the budget boundary.
- The image builder refuses on its own as well, as a backstop behind the handler's pre-flight. It is unreachable from the handler today (with images the pre-flight runs the same builder at the same budget; text-only, the text-path check is the stricter of the two), so no test reaches it; that is stated rather than pinned.

## Rejected alternatives

- **Pass the newest message whole, trim only history.** `CLAUDE_MAX_PROMPT_CHARS` stops being a ceiling for the one message that is usually the largest, leaving the 5 MiB body cap as the only runaway-context guard, and every such request becomes a billed spawn that the upstream may then reject.
- **Cut inside the newest message** (what the image path did). Still a 200 about a question the model only partly saw.
- **Signal the truncation in the response** (a header or an extra field). B.1 forbids inventing fields OpenAI's schema does not define.

## Expiry

The `200` reserve and the `× 3` factor are inherited from ADRs 0009/0011 and expire with them. The specification reading (openapi 2.3.0, 2026-10-21) describes the `Error` schema as read that day; re-read it if OCP ever advertises a different object.
