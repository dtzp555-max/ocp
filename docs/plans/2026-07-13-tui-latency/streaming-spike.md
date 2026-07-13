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

Token-presence check over the whole final frame:

| token in the answer | in transcript `T` | in pane |
|---|---|---|
| `## ` (ATX heading) | yes | **no** — rendered as `⏺` |
| `**` (bold markers) | yes | **no** — rendered as ANSI bold, then stripped by `-p` |
| ` ```javascript ` (fence + language) | yes | **no** — fence gone, language tag gone |
| `- ` (list item) | yes | yes |

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

### (c) `--debug-file` — **dead: byte-exact, but only at end-of-turn**

Not considered in the original backlog; checked for completeness because it is the only other
observable claude writes.

`claude --debug-file <path>` does contain the **byte-exact raw markdown** — but only inside
**end-of-turn hook payloads**:

```
[DEBUG] Hooks: Parsed initial response: {… "hook_event_name":"Stop", …
        "last_assistant_message":"## Title\n\n**alpha bravo charlie**" …}
```

Note `## ` and `**` survive here — this is the real text. But it arrives with the `Stop` hook, i.e.
the same end-of-turn granularity as the transcript. Grepping the log for streaming events
(`content_block_delta` / `text_delta`) finds **zero**. The log is also ~2.7 MB per turn, which rules
it out as a production mechanism regardless.

---

## What this means

**True token streaming is not achievable on the TUI path**, at any effort, with any flag combination
available in claude 2.1.207. The three observables are: a rendered terminal (lossy beyond repair), a
transcript written at event granularity (end-of-turn), and a debug log written at end-of-turn.
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
  prompt, n=5): **median 11.30 s** before PR #156, **9.55 s** after — against a native
  `turn_duration` of ~7.3 s for a comparable turn. So OCP's own overhead over the CLI is roughly
  **2–4 s**, not 20 s; the rest of any large number is the model generating a long answer, which
  streaming hides but does not shorten. (A 30 s turn is a 30 s turn either way — the last token
  lands at the same wall-clock moment.)

The honest remaining levers on the TUI path are therefore: the **~6 s TTFT floor** (immovable — see
[`README.md`](README.md)), the **generation time** (a function of output length — not OCP's to
optimize), and OCP's **own 2–4 s of overhead** (per-request cold boot ≈1 s → backlog #3 warm pool;
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

# (c) debug log
claude --model claude-sonnet-5 --session-id "$(uuidgen)" --effort low --debug-file /tmp/d.log
grep -cE 'content_block_delta|text_delta' /tmp/d.log     # → 0
grep -o 'last_assistant_message":"[^"]*' /tmp/d.log      # → byte-exact text, at Stop-hook time
```

Banner check (mandatory for every spawn-flag change, per [`billing-banner.txt`](billing-banner.txt)):
every configuration used in this spike was verified to stay on `· Claude Max`.
