# Backlog #2 (real streaming): the prereq spike says **no**

**Date**: 2026-07-13
**Status**: negative result — evidence, not a decision. The maintainer chooses what to do with it.
**Scope**: this answers the prereq spike that [`README.md`](README.md) § "Backlog #2" demanded *before* any streaming design:

> **Prereq spike (do this before designing anything)**: does the transcript JSONL grow *during* a
> turn, or only at the end? If only at the end, (a) is dead and you are stuck with (b).

The spike was run. **Both (a) and (b) are dead**, and so is a third candidate the original backlog
did not consider. The conclusion is stronger than "streaming is hard": **the interactive `claude`
CLI does not expose its token stream to any observer.** It renders tokens to a terminal and records
the *finished* text. There is no byte-faithful incremental source for a proxy to forward.

**Measured on**: Mac mini / Claude Code **v2.1.207** / Sonnet 5 + Sonnet 4.6 / Claude Max /
real-home mode. Every claim below is reproducible from the commands given.

---

## The three candidate sources, and how each one dies

### (a) Incremental transcript reads — **dead: event granularity, not token granularity**

The transcript JSONL *does* grow during a turn, but it grows one **whole event at a time**, and the
assistant's text event is written as **one complete line** — it appears only ~0.3 s before the
terminal `turn_duration` event.

Observed (session `efd5b161`, `turn_duration: 7319 ms`, polling the file every 0.5 s):

```
bytes=64347 lines=13  →  64479 lines=14  →  92192 lines=21     (during the turn)

 #6  t+0.0s   type=user       (the prompt)
 #15 t+4.7s   type=assistant  blocks=thinking
 #16 t+7.0s   type=assistant  blocks=text      ← the ENTIRE answer, in one line
 #21 t+7.3s   type=system     subtype=turn_duration   ← terminal
```

Reading the transcript incrementally therefore buys ~0.3 s, not a token stream. The "clean option"
the backlog hoped for does not exist.

### (b) `tmux capture-pane` diffing — **dead: the pane is a RENDERED view, not the text**

This is the one the backlog expected to fall back to, noting it is "lossy for exact text (wrapping,
scrollback, spinner lines)". The loss is **worse than formatting noise: the pane does not contain
the answer's source bytes at all.** claude's TUI *renders* markdown, and `capture-pane -p` strips
the ANSI styling that rendering produced — so the source markers are gone, irrecoverably.

Same turn, same lines — authoritative transcript text vs. what the pane holds
(`capture-pane -p -J -S -500`, pane width 220):

```
TRANSCRIPT (authoritative T, via extractLatestAssistantText):
  '## Semaphore'
  ''
  'A **semaphore** is a synchronization primitive that controls access to a shared resource by …'
  ''
  '- Tracks available "permits" and decrements the count when a thread acquires access, …'

PANE (the same turn):
  ''
  '⏺ Semaphore'                                   ← '## ' heading became a bullet glyph
  ''
  '  A semaphore is a synchronization primitive that controls access to a shared resource by …'
  ''                                             ← '**' bold markers GONE; every line indented 2 sp
  '  - Tracks available "permits" and decrements the count when a thread acquires access, …'
```

Token-presence check **over the pane's answer region** (the prompt echo above it is excluded — it
does contain a literal `**`, because the prompt itself asked for bold):

| token in the answer | in transcript `T` | in pane's answer region |
|---|---|---|
| `## ` (ATX heading) | yes | **no** — rendered as `⏺` |
| `**` (bold markers) | yes | **no** — rendered as ANSI bold, then stripped by `-p` |
| ` ```javascript ` (fence + language) | yes | **no** — fence gone, language tag gone |
| `- ` (list item) | yes | yes |

**`capture-pane -e` (keep the ANSI) does not rescue it — the inverse is provably non-unique.**
Minimal case, transcript `T` = ``"## Alpha\n\n**bravo**\n\n```javascript\nlet x=1;\n```"``:

```
⏺\e[39m \e[1mAlpha\n\n\e[0m  \e[1mbravo\n\n\e[0m  \e[34mlet\e[39m x=\e[32m1\e[39m;
```

`## Alpha` → **SGR 1 (bold)**. `**bravo**` → **SGR 1 (bold)**. *Identical ANSI* — an H2 and a bold
span are indistinguishable, never mind `**` vs `__`. The fence and its `javascript` tag are consumed
by the syntax highlighter into colours (`\e[34mlet`); recovering the tag would mean inverting a
highlighter, and `let x=1;` is valid in several languages. Marker check on the `-e` capture: `## `,
`**`, ```` ``` ````, ```` ```javascript ```` — **all absent**.

Consequence for any design built on pane diffing: with `S` = text streamed from the pane and `T` =
the transcript's authoritative text, the prefix invariant **`T.startsWith(S)` is false** — both raw
and with the 2-space indent stripped. Not "sometimes, on redraw" — **on essentially every answer
containing markdown**, which is most answers.

And it cannot be repaired:

- `capture-pane -e` (keep ANSI) recovers *styling*, never the *source spelling*: you cannot tell
  `**bold**` from `__bold__`, recover a fence's language tag, or distinguish an H2 from bold text.
- Reconstructing markdown from rendered output is a lossy inverse with no unique solution, and it
  would be pinned to one claude TUI version's theme.

A proxy that streams pane text is streaming **something the model did not say**. For OCP that is not
a quality trade-off, it is a correctness violation (`ALIGNMENT.md` Core Principle: forward what
`cli.js` emits; do not invent).

### (c) `--debug-file` — **dead: it logs stream *timing*, never stream *content***

Not considered in the original backlog; checked because it is the only other observable claude writes.

**There ARE mid-turn stream events in the debug log** — this is the one place a casual check
misleads, so it is worth stating precisely. The default log level is `debug`, which **suppresses
every `verbose` site**. Raise it and per-chunk lines appear, spread across the generation:

```bash
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose claude --debug-file /tmp/d.log …
```
```
05:51:11.088 [VERBOSE] [shoji-engine] yield stream_event/-     ← 16 of these, mid-turn,
05:51:11.537 [VERBOSE] [shoji-engine] yield stream_event/-        spread over ~3.9 s of generation
…
05:51:14.910 [VERBOSE] [shoji-engine] yield assistant/-
05:51:15.192 [DEBUG]   [shoji-engine] turn 1 end (usage in=575 out=255 api=6736ms stop=end_turn resultLen=857)
```

**But they carry no payload.** The format is `yield <type>/<subtype>` — a bare presence marker. At
verbose level, with every category filter, the log contains:

| event | count |
|---|---|
| `content_block_delta` | **0** |
| `text_delta` | **0** |
| `content_block_start` / `message_start` | **0** |

The only byte-exact text in the log is the **end-of-turn `Stop` hook payload**
(`"last_assistant_message":"## Title\n\n**alpha bravo charlie**"` — note `## ` and `**` survive, so
this *is* the real text), which is the same granularity as the transcript. So the debug log gives you
**when** tokens arrive, never **what** they are. It is also ~2.7 MB per turn.

*(An incremental "a token arrived" signal with no token in it cannot feed an SSE `delta.content`.)*

### Everything else that could plausibly carry tokens — also checked, also dead

An adversarial second pass (independent reviewer, tasked with *refuting* this document) enumerated
the rest of the search space rather than sampling it. Nothing survived:

| candidate | how it dies |
|---|---|
| **Hooks** — is there a per-message/per-chunk hook? | The hook registry was enumerated from the shipped binary: `PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted`. **No streaming/per-chunk hook exists.** |
| `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES=1` (undocumented env twin of the flag; bypasses flag validation) | Ran live in a TUI turn: transcript still had **1** assistant event, **0** partials. Interactive mode has no stream-json *sink* for it to write to. Banner stayed `· Claude Max`. |
| `sessionMirror` (undocumented) | Gated on `outputFormat === "stream-json"` → the `-p` family. |
| `--sdk-url` (hidden) | Forces stream-json + non-interactive → `sdk-cli` (metered pool). |
| `--input-format stream-json` | Live: `Error: --input-format=stream-json requires output-format=stream-json` → which requires `--print`. And it is an *input* format regardless. |
| `~/.claude/sessions/<pid>.json` (modified mid-turn) | Registry metadata only: `{pid, sessionId, cwd, status, version, entrypoint:"cli", kind:"interactive"}`. **No assistant text.** (Its `entrypoint:"cli"` is incidental independent confirmation that the TUI path stays on the subscription pool.) |
| `~/.claude/history.jsonl` (modified mid-turn) | Keys: `[display, pastedContents, timestamp, project, sessionId]` — **user prompts only**; the answer text is absent. |
| `~/.claude/settings.json` | No key for partial/streaming output. |
| **Ask the model to emit plain text** (so the pane render is faithful) | Would require OCP to **mutate the caller's prompt** — a correctness violation for a proxy (`ALIGNMENT.md`: forward what `cli.js` emits; do not invent), it would corrupt callers who legitimately want markdown or JSON, and it *still* would not be byte-faithful (the TUI keeps wrapping and 2-space indenting). Rejected. |

---

## What this means

**True token streaming is not achievable on the TUI path**, at any effort, with any flag combination
available in claude 2.1.207. The three observables are: a rendered terminal (lossy beyond
repair), a transcript written at event granularity (the answer lands whole, end-of-turn), and a debug
log that reports *when* tokens arrive but never *what* they are.
`--output-format stream-json` — the one interface that *does* emit `text_delta` events — works
**only with `--print`/`-p`**, and the `-p` path is precisely what TUI mode exists to avoid (it is
classified `cc_entrypoint=sdk-cli` → the metered credit pool, not the subscription pool). The
constraint is structural, not a missing feature.

**Therefore OCP's SSE on the TUI path is, and remains, replay-only**: the answer is buffered until
the turn is terminal and then replayed as SSE chunks (`server.mjs`, the `streamStringAsSSE` branch).
It is wire-valid OpenAI SSE; it is not progressive.

### What streaming would have bought — smaller than the backlog implied

Worth stating plainly, because it changes the value calculus:

- **Streaming never makes the answer arrive sooner.** It makes the *first byte* arrive sooner. A
  consumer that needs the *complete* answer before it can act — e.g. a JSON-card consumer parsing a
  structured reply, which is exactly the 知音 AI use case that motivated this whole investigation —
  gains **nothing at all** from streaming. Only a progressively-rendering consumer (a chat UI) gains.
- The backlog's "~20 s" for item #2 was inferred from an external report of 30–32 s, not measured
  through OCP. Measured through a real OCP instance (TUI mode, `claude-sonnet-4-6`, ~1850-token
  prompt, n=5): **median 11.30 s** before PR #156, **9.55 s** after.

  **Same-turn decomposition** (the honest form — one turn, both numbers): baseline row `i=5` took
  **11.563 s** end-to-end through OCP, and that same turn's transcript records
  `turn_duration: 7.319 s` of CLI-internal time. → **OCP's own overhead ≈ 4.2 s** (n=1, baseline
  `effort=high` config). Not 20 s.

  Two caveats, stated so the number is not over-trusted: this is **n=1**, and `turn_duration` is the
  *CLI's* internal duration on an **OCP-driven** turn (it is not a "native, non-OCP" baseline — the
  same interactive `claude` is doing the work either way). Do **not** subtract this 7.3 s
  (`effort=high`) from the 9.55 s `effort=low` median: a low-effort turn generates faster, so its own
  `turn_duration` would be lower, and mixing the two would *understate* the overhead. There is no
  `turn_duration` sample for the `effort=low` config.

  Either way the direction is settled: OCP's overhead is **single-digit seconds**, not the ~20 s the
  plan assumed. The rest of any large number is the model generating a long answer — which streaming
  hides but does not shorten. (A 30 s turn is a 30 s turn either way; the last token lands at the same
  wall-clock moment.)

The honest remaining levers on the TUI path are therefore: the **~6 s TTFT floor** (immovable — see
[`README.md`](README.md)), the **generation time** (a function of output length — not OCP's to
optimize), and OCP's **own ~4 s of overhead** (n=1 same-turn decomposition; per-request cold boot ≈1 s → backlog #3 warm pool;
plus readiness/paste/transcript poll granularity).

---

## Options for the maintainer (this document does not choose)

1. **Accept and document (recommended).** TUI mode cannot stream; its SSE is replay-only. Record the
   constraint next to the ~6 s TTFT floor already in `README.md`, and close backlog #2 as *not
   achievable honestly*. Redirect the effort to the overhead that *is* recoverable (#3).
2. **Ship lossy "rendered-text" streaming behind an explicit opt-in.** Technically possible; the
   client would receive the TUI's rendered view — headings as `⏺`, bold markers stripped, code
   fences gone, every line indented. **Recommended against**: it delivers bytes the model did not
   produce, silently corrupts structured replies (the JSON/marker protocols proxy consumers actually
   use), and pins OCP's output to a claude TUI theme. It also cannot be reconciled with the
   transcript afterwards — OpenAI SSE deltas cannot be un-sent.
3. **Reconstruct markdown from `capture-pane -e` ANSI styling.** High effort, brittle across claude
   versions, and *still* not byte-exact (no unique inverse). Recommended against.

## Reproduction

```bash
# (a) transcript growth granularity — poll a live turn's JSONL
#     watch bytes/lines while a TUI turn runs; dump event types + timestamps afterwards

# (b) pane vs transcript — the decisive one
#     spawn claude in tmux (prefix NOT ocp-tui-*, never kill-server), ask for markdown,
#     capture `tmux capture-pane -p -J -S -500` frames during the turn, then diff the pane's
#     answer region against extractLatestAssistantText() over the session's transcript JSONL.
#     Expect: T.startsWith(paneText) === false, '## ' and '**' and '```' absent from the pane.

# (c) debug log — NOTE: default level is `debug`, which SUPPRESSES the verbose stream sites.
#     Raise it, or you will wrongly conclude there are no mid-turn events at all.
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose \
  claude --model claude-sonnet-5 --session-id "$(uuidgen)" --effort low --debug-file /tmp/d.log
grep -c 'yield stream_event'          /tmp/d.log   # → 16 (mid-turn — timing exists!)
grep -cE 'content_block_delta|text_delta' /tmp/d.log   # → 0  (…but no text payload, ever)
grep -o 'last_assistant_message":"[^"]*' /tmp/d.log    # → byte-exact text, only at Stop-hook time
```

Banner check (mandatory for every spawn-flag change, per [`billing-banner.txt`](billing-banner.txt)):
every configuration used in this spike was verified to stay on `· Claude Max`.
