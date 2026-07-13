# Backlog #2 (real streaming): **achievable** — via the `MessageDisplay` hook

**Date**: 2026-07-13
**Status**: prereq-spike result. **Streaming IS achievable on the TUI path**, byte-faithfully, on the
subscription pool. Three obvious sources are dead ends; a fourth one works.
**Scope**: answers the prereq spike that [`README.md`](README.md) § "Backlog #2" demanded *before* any
streaming design:

> **Prereq spike (do this before designing anything)**: does the transcript JSONL grow *during* a
> turn, or only at the end? If only at the end, (a) is dead and you are stuck with (b).

The answer: **(a) is dead, (b) is dead — and you are not stuck with either.** The CLI exposes its own
streaming interface as a **hook**, which the backlog did not consider.

**Measured on**: Mac mini / Claude Code **v2.1.207** / Sonnet 4.6 + Sonnet 5 / Claude Max /
real-home mode. Every claim below is reproducible from the commands given.

> **Honesty note on how this document was produced.** Its first version concluded the exact opposite —
> "streaming is not achievable; the CLI exposes no byte-faithful incremental source" — and was **wrong**.
> An adversarial reviewer, commissioned specifically to *refute* it, found `MessageDisplay` on a second
> pass; its own first pass had enumerated the hook registry with a truncated grep (it reported 21
> events — there are **30**). Both the wrong conclusion and its refutation are preserved here, because
> "we checked, it's impossible" is the most expensive kind of claim to get wrong: it closes a door and
> nobody re-opens it.

---

## ✅ The source that works: the `MessageDisplay` hook

`claude` fires a **`MessageDisplay`** hook as it renders each block of the assistant's reply. The
payload carries the **raw markdown source** of an incremental `delta`, plus a monotonic `index` and a
`final` flag:

```json
{ "hook_event_name": "MessageDisplay",
  "turn_id": "6cb31d21-…", "message_id": "84ab9832-…",
  "index": 0, "final": false, "delta": "## Mutex\n\n" }
```
*(payload also carries `session_id`, `transcript_path`, `prompt_id`, `cwd`)*

Registered as an ordinary command hook via `--settings` on a **plain interactive TUI spawn** (no `-p`,
no `--bare`), `claude-sonnet-4-6`, `--effort low`. Banner verified:
`▝▜█████▛▘ Sonnet 4.6 with low effort · Claude Max` — **subscription pool, not metered billing**.

One live turn — 7 fires, spread across generation:

```
index=0 final=false  len=  10  '## Mutex\n\n'
index=1 final=false  len= 140  'A **mutual exclusion lock** prevents concurrent access to a shar…'
index=2 final=false  len=  83  '- Acquiring a locked mutex blocks the caller until the current h…'
index=3 final=false  len= 163  '- Failing to release a mutex causes a deadlock, freezing all wai…'
index=4 final=false  len=  96  'let counter = 0;\n\nasync function increment() {\n  const release =…'
index=5 final=false  len=  84  '    counter++; // only one caller here at a time\n  } finally {\n …'
index=6 final=true   len=   3  '```'
```

**Every invariant a proxy needs — all hold:**

| requirement | result |
|---|---|
| **byte-faithful** — deltas are the model's *source*, not the rendered pane | ✅ `## `, `**`, ```` ```javascript ```` all present in the deltas |
| **exactness** — `concat(deltas) === T` (the transcript-authoritative text) | ✅ **true**, 579 == 579 bytes |
| **prefix-stable** — `T.startsWith(concat(deltas[0..n]))` at every n | ✅ **true at all 7 steps** |
| **incremental** — arrives during generation, not at the end | ✅ 7 fires spread across the turn |
| **no `-p`** — stays out of the metered `sdk-cli` pool | ✅ plain interactive TUI |
| **subscription pool** | ✅ banner `· Claude Max` |

This is exactly the contract a streaming design needs: deltas forward straight into SSE
`delta.content` chunks, and the transcript's final text `T` stays a cheap end-of-turn assertion
(`concat === T`) instead of a reconciliation problem.

### Caveats for the implementer

- **Block-level granularity, not token-level** — 5–7 chunks for a ~600-byte answer, not one per token.
  Plenty for SSE (`delta.content` has no minimum size), but do not promise token-by-token output.
- **⚠️ `forceSyncExecution: true` in the hook's source — `claude` BLOCKS on the hook.** A slow hook
  adds latency to *every* delta. The hook must write and exit immediately (e.g. write to a FIFO / unix
  socket that OCP reads; never work inline). **Measure the added per-delta latency.**
- Only `text` blocks fire it (`content.map(c => c.type === "text" ? c.text : "")`) — **thinking blocks
  are excluded**, which is what OCP wants.
- OCP already owns the spawn (isolated HOME, its own flags), so injecting `--settings` with a
  `MessageDisplay` hook sits inside the existing architecture.
- **`ALIGNMENT.md`**: this consumes `claude`'s **own** hook surface as emitted — forwarding, not
  inventing. Not a new endpoint, not a fabricated protocol. (Class B / ADR 0007 — the TUI spawn is
  OCP-owned; no `cli.js` citation applies.)

### Reproduce in 60 seconds

```bash
# hook script: append the payload (arrives on stdin) and exit immediately
printf '#!/bin/bash\ncat >> "$MD_LOG"; printf "\\n" >> "$MD_LOG"; exit 0\n' > /tmp/h.sh && chmod +x /tmp/h.sh
echo '{"hooks":{"MessageDisplay":[{"hooks":[{"type":"command","command":"MD_LOG=/tmp/deltas.jsonl /tmp/h.sh"}]}]}}' > /tmp/s.json

# plain interactive claude in tmux (prefix NOT ocp-tui-*, and never kill-server)
tmux new-session -d -s md-probe -x 220 -y 50 \
  "claude --model claude-sonnet-4-6 --effort low --session-id $(uuidgen) --settings /tmp/s.json"
# …wait for '? for shortcuts', paste a markdown-producing prompt, press Enter…

jq -r '"\(.index) \(.final) \(.delta|@json)"' /tmp/deltas.jsonl   # incremental raw-markdown deltas
# then assert: concat(deltas) == extractLatestAssistantText(<transcript>.jsonl)
```

---

## The three dead ends (still worth knowing — they say what NOT to build)

### (a) Incremental transcript reads — **dead: event granularity, not token granularity**

The transcript JSONL *does* grow during a turn, but one **whole event at a time**; the assistant's text
event is written as **one complete line**, appearing only ~0.3 s before the terminal `turn_duration`.

Observed (session `efd5b161`, `turn_duration: 7319 ms`):

```
 #6  t+0.0s   type=user       (the prompt)
 #15 t+4.7s   type=assistant  blocks=thinking
 #16 t+7.0s   type=assistant  blocks=text      ← the ENTIRE answer, in one line
 #21 t+7.3s   type=system     subtype=turn_duration   ← terminal
```

Cross-checked at **20 ms polling + `fs.watch`** (25× finer): a partial line **never touches disk** —
one write, `+1` line, carrying the complete answer. Also forced with the undocumented
`CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES=1`: still 1 assistant event, 0 partials (interactive mode has no
stream-json *sink* for it to write to).

**The transcript is still needed** — as the terminal-turn signal, as the authoritative `concat === T`
check, and as the input to the existing honesty gates (auth-banner detection, `truncated`). It is just
not the *streaming* source.

### (b) `tmux capture-pane` diffing — **dead: the pane is a RENDERED view, not the text**

The backlog expected to fall back to this, calling it "lossy … (wrapping, scrollback, spinner lines)".
The loss is far worse than formatting noise: **the pane does not contain the answer's source bytes at
all.** The TUI *renders* markdown, and `capture-pane -p` strips the ANSI that rendering produced.

Same turn, same lines:

```
TRANSCRIPT (authoritative T):          PANE (capture-pane -p -J -S -500):
  '## Semaphore'                         '⏺ Semaphore'                 ← heading marker gone
  ''                                     ''
  'A **semaphore** is a synchro…'        '  A semaphore is a synchro…' ← bold markers gone, indented
```

| token in the answer | in `T` | in the pane's answer region |
|---|---|---|
| `## ` (ATX heading) | yes | **no** — rendered as `⏺` |
| `**` (bold markers) | yes | **no** — rendered to ANSI bold, then stripped by `-p` |
| ` ```javascript ` (fence + language) | yes | **no** — fence and language tag both gone |
| `- ` (list item) | yes | yes |

*(A literal `**` does appear elsewhere in the pane — in the **prompt echo**, because the prompt asked
for bold. Not in the answer.)*

**`capture-pane -e` (keeping the ANSI) does not rescue it — the inverse is provably non-unique.**
With `T` = ``"## Alpha\n\n**bravo**\n\n```javascript\nlet x=1;\n```"``:

```
⏺\e[39m \e[1mAlpha\n\n\e[0m  \e[1mbravo\n\n\e[0m  \e[34mlet\e[39m x=\e[32m1\e[39m;
```

`## Alpha` → **SGR 1 (bold)**. `**bravo**` → **SGR 1 (bold)**. *Identical ANSI* — an H2 and a bold span
are indistinguishable, never mind `**` vs `__`. The fence and its `javascript` tag are consumed by the
syntax highlighter into colours; recovering the tag would mean inverting a highlighter, and
`let x=1;` is valid in several languages.

So `T.startsWith(paneText)` is **false** — raw and indent-stripped, on essentially every markdown
answer. A proxy streaming pane text would be streaming **something the model did not say**. With
`MessageDisplay` available there is no reason to go near it.

### (c) `--debug-file` — **dead: it logs stream *timing*, never stream *content***

Worth stating precisely, because a casual check misleads in **both** directions here.

The default log level is `debug`, which **suppresses every `verbose` site**. Raise it and per-chunk
lines *do* appear, spread across generation:

```bash
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose claude --debug-file /tmp/d.log …
```
```
05:51:11.088 [VERBOSE] [shoji-engine] yield stream_event/-     ← 16 of these, mid-turn,
05:51:11.537 [VERBOSE] [shoji-engine] yield stream_event/-        over ~3.9 s of generation
05:51:15.192 [DEBUG]   [shoji-engine] turn 1 end (usage in=575 out=255 api=6736ms stop=end_turn resultLen=857)
```

**But they carry no payload** — the format is `yield <type>/<subtype>`, a bare presence marker. Run with
no category filter (i.e. all categories) at verbose level: `content_block_delta` = **0**, `text_delta` =
**0**, `content_block_start` / `message_start` = **0**. The only byte-exact text in the log is the
end-of-turn `Stop` hook payload (`"last_assistant_message":"## Title\n\n**alpha bravo charlie**"`) —
transcript granularity. The log tells you **when** tokens arrive, never **what** they are. It is also
~2.7 MB per turn.

### Also checked, also not the answer

| candidate | outcome |
|---|---|
| `--output-format stream-json` (the one interface that emits `text_delta`) | **requires `--print`/`-p`** → `cc_entrypoint=sdk-cli` → the **metered** credit pool, which is exactly what TUI mode exists to avoid. Reproduced live. |
| `--input-format stream-json` | `Error: --input-format=stream-json requires output-format=stream-json` → same gate. |
| `CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES=1` (undocumented) | No stream-json sink in interactive mode → no partials. Banner stayed `· Claude Max`. |
| `sessionMirror` (undocumented) | Gated on `outputFormat === "stream-json"` → the `-p` family. |
| `--sdk-url` (hidden) | Forces stream-json + non-interactive → `sdk-cli`. *(inferred from the minified bundle; not banner-tested)* |
| `~/.claude/sessions/<pid>.json` | Registry metadata only (`{pid, sessionId, cwd, status, version, entrypoint:"cli", kind:"interactive"}`). No assistant text. *(Its `entrypoint:"cli"` incidentally confirms the TUI path stays on the subscription pool.)* |
| `~/.claude/history.jsonl` | User prompts only; the answer text is absent. |
| Asking the model to emit plain text (so the pane renders faithfully) | Would mean **mutating the caller's prompt** — a correctness violation for a proxy, and still not byte-faithful (wrapping + indent remain). Rejected. |

---

## Value: what streaming actually buys (read before building)

Streaming is *possible*. Whether it is *worth it* depends on the consumer, and the honest answer is
uncomfortable:

- **Streaming never makes the answer arrive sooner. It moves the *first* byte, not the *last*.** The
  final token lands at the same wall-clock moment either way.
- So a consumer that must have the **complete** answer before it can act — e.g. one parsing a structured
  JSON reply, **which is exactly the 知音 AI use case that motivated this entire investigation** — gains
  **nothing at all**. Only a **progressively-rendering** consumer (a chat UI) gains.

And the number the backlog attached to this item was wrong:

- The backlog's "~20 s" was inferred from an external 30–32 s report, **never measured through OCP**.
  Measured through a real OCP instance (TUI mode, `claude-sonnet-4-6`, ~1850-token prompt, n=5):
  **median 11.30 s** before [#156](https://github.com/dtzp555-max/ocp/pull/156), **9.55 s** after.
- **Same-turn decomposition** (baseline row `i=5`): **11.563 s** wall through OCP vs `turn_duration:
  7.319 s` of CLI-internal time on that same turn → **OCP's own overhead ≈ 4.2 s** (n=1, baseline
  `effort=high` config). *Caveats*: n=1; and `turn_duration` is the CLI's internal duration of an
  **OCP-driven** turn, not a separate "native" baseline. Do **not** subtract this `effort=high` 7.3 s
  from the `effort=low` 9.55 s median — a low-effort turn generates faster, so mixing them
  *understates* the overhead.
- So OCP's own overhead is **single-digit seconds**, not ~20 s. The rest of any large number is the
  model generating a long answer — which streaming hides but does not shorten.

**Recommendation**: build it — the contract is clean and the cost is small — but size the expectation
honestly. It is a *perceived-latency* feature for progressively-rendering consumers, not a throughput
win, and it does not move the **~6 s TTFT floor** ([`README.md`](README.md)) that rules TUI mode out for
interactive-latency consumers regardless.
