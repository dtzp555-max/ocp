# TUI-mode latency: measured floor, and the four things worth fixing

**Date**: 2026-07-13
**Status**: findings + backlog (no code changed yet)
**Measured on**: Mac mini / macOS 26.5.2 / Claude Code **v2.1.207** / Sonnet 5 / Claude Max subscription / **real-home mode** (no `CLAUDE_CODE_OAUTH_TOKEN`, no `OCP_TUI_HOME` in the service env)
**Evidence**: [`measurements.jsonl`](measurements.jsonl) — **n=15** (3 configs × 5) · banner captures [`billing-banner.txt`](billing-banner.txt) · harness [`floor.sh`](floor.sh)

## Why this exists

An external consumer (the 知音 AI project) benchmarked OCP's prompt path and measured
**TTFT p50 ≈ 30–32 s**, and excluded OCP as a backend on that basis. That number is real,
but it is *not* the model being slow — this document decomposes where the 30 seconds
actually go, and what OCP can do about it.

**The harness deliberately does not go through OCP.** It spawns `tmux` + `claude` directly
(session prefix `zhiyin-floor-`, never `ocp-tui-*`) and polls `tmux capture-pane` for
incremental render, so it measures the **true first-token time** of the underlying
subscription path — the floor OCP could reach if it were perfect.

---

## Measurements

All rows in [`measurements.jsonl`](measurements.jsonl); every number below is recomputable from it.

| Config | n | boot→input-ready (median) | **TTFT (median)** | TTFT range | full answer (median) |
|---|---|---|---|---|---|
| baseline (inherits global `effortLevel: xhigh`) | 5 | 1.07 s | **10.35 s** | 8.32 – 17.19 s | 11.32 s |
| **`--effort low`** | 5 | 1.03 s | **6.17 s** | **5.87 – 6.44 s** | 9.98 s |
| `--bare` | 5 | 0.44 s | **no answer at all** (5/5 `ttft_ms: -1`) | — | — |

> **Not from this harness**: the direct Anthropic API reference figure (TTFT 0.84–1.64 s, n=2)
> comes from the 知音 AI project's own smoke test, not from `measurements.jsonl`. It is quoted
> only to size the gap; do not look for it in the evidence file.

### Where the 30 seconds go

```
 ~1.0 s   spawn → claude's input bar is ready          ← NOT the bottleneck
 ~6-10 s  true TTFT (first token rendered in the pane)
 ~20 s    ████ waiting for the whole turn to finish ████  ← this is the 30s
```

`runTuiTurn` blocks on the native transcript until a terminal event (`lib/tui/session.mjs`
"Block on the native transcript … until terminal"; `readTuiTranscript` in
`lib/tui/transcript.mjs`; ADR 0007 step 4) — i.e. it waits for the **entire turn** to complete
before returning anything. There is no streaming path. The ~20 s delta between this harness's
real TTFT and OCP's reported 30–32 s is exactly that.

---

## ⚠️ Blocking constraint: `--bare` silently drops you off the subscription pool

Captured live ([`billing-banner.txt`](billing-banner.txt)) — the startup banner is the **only**
reliable indicator:

```
[]                     | Sonnet 5 with xhigh effort · Claude Max
[--effort low]         | Sonnet 5 with low effort  · Claude Max
[--bare]               | Sonnet 5 with xhigh effort · API Usage Billing     ← ❌
```

`--bare` ("skip hooks, LSP, plugin…") **also skips the subscription-credential resolution
path**. It really does cut boot to 0.43–0.45 s — but you are no longer on the subscription,
which defeats the entire purpose of TUI mode (ADR 0007 exists solely to reach the
subscription pool).

**The failure is silent.** All 5 `--bare` samples reached input-ready (boot 0.43–0.45 s), were
sent the prompt, and then produced **no answer at all** — 60 s timeout, no error, no crash, the
pane simply never rendered a token (the API-billing account had no credit balance). Nothing in
the transcript or the exit status reveals this.

**Anyone changing spawn flags must diff the banner line before and after.**

---

## Backlog — four items, ranked by value ÷ effort

### 1. Pass `--effort` explicitly on spawn — **do this first**

`buildTuiCmd` (`lib/tui/session.mjs`) does not pass `--effort` — `grep -rn -- "--effort\|effortLevel" lib/ server.mjs bin/`
returns zero hits. What the pane's `claude` ends up using therefore depends on **which HOME mode
`resolveTuiHome()` picked**:

| mode | HOME | effort the pane gets |
|---|---|---|
| **real-home** (legacy default — *current* service config: no `CLAUDE_CODE_OAUTH_TOKEN`, no `OCP_TUI_HOME`) | `~` | **inherits the operator's `~/.claude/settings.json` → `effortLevel: xhigh` on this host** |
| env-token scratch (`CLAUDE_CODE_OAUTH_TOKEN` set — the direction #146/#150 pushed) | `~/.ocp-tui/home` | that settings.json contains only `permissions.additionalDirectories`; `prepareTuiHome()` never writes `effortLevel` → **claude's built-in default** |

So today, on the production config, **every OCP request runs extended thinking** — pure waste
for the typical "generate this JSON" request, and it makes latency depend on an unrelated global
setting the operator may have changed for their own interactive use. And the mode split means
the effort level silently changes if the operator ever switches to env-token mode.
**Passing `--effort` explicitly fixes both problems at once.**

- **Effect (real-home, measured)**: TTFT p50 **10.35 s → 6.17 s (−40 %)**, and the spread
  collapses from 8.32–17.19 s to **5.87–6.44 s**. For a proxy, the variance reduction matters
  more than the median.
- **Cost**: one flag. Suggested: a new `OCP_TUI_EFFORT` env var (default `low`), documented in
  README § "Environment Variables" per `release_kit.new_feature_doc_expectations`.
- **Risk**: none — banner confirms it stays on `Claude Max` (see `billing-banner.txt`).
- ⚠️ Do **not** reach for `--bare` to shave boot: see above.

### 2. Real streaming instead of blocking on turn-terminal — **the big one (~20 s)**

Today `runTuiTurn` blocks on the transcript until the turn is *finished*. The pane is already
rendering tokens incrementally the whole time — this harness proves you can observe first token
at ~6 s by polling `tmux capture-pane`.

- **Effect**: turns a 30 s wall into a ~6 s TTFT with progressive output; enables SSE streaming
  on the OCP endpoint instead of a single blob at the end.
- **Cost**: real work. Pane capture is ANSI/redraw-based and lossy for exact text (wrapping,
  scrollback, spinner lines). Two candidate sources: (a) incremental reads of the transcript
  JSONL, (b) `capture-pane` diffing with a stable start marker. (a) is much cleaner **if it
  holds**.
- **Prereq spike (do this before designing anything)**: does the transcript JSONL grow *during*
  a turn, or only at the end? If only at the end, (a) is dead and you are stuck with (b).

### 3. Warm pane pool — ~1 s

Every request spawns a fresh tmux session + `claude` (`randomUUID()` + `new-session`, then
`kill-session` in `finally`; `grep -rn "pool\|warm\|reuse" lib/tui/*.mjs` → zero hits). Boot to
input-ready is ~1.0 s, paid on every request. A pool of pre-booted panes (single-use, replaced in
the background) amortizes it to zero for any workload below the pool refill rate.

- **Effect**: −1.0 s.
- **Cost**: moderate; interacts with the session reaper and the per-port prefix scoping added in
  #148 — pooled panes must not look like zombies to the sweep.
- Lower priority than #1 and #2: it is the smallest slice.

### 4. Trim the prefill — **probably not worth it; know the floor**

After #1–#3, the floor is **~6 s**, and it does not go lower. `claude` always injects the full
Claude Code system prompt + tool definitions (thousands to tens of thousands of prefill tokens)
regardless of what you ask it. `--exclude-dynamic-system-prompt-sections` exists and may shave
some of it — **unmeasured**; worth one spike, but do not expect to reach the direct API's
~1 s.

**Consequence to accept, and to state in the README**: even fully optimized, TUI mode has a
**~6 s TTFT floor**, so it cannot serve real-time / interactive-latency consumers. It remains
appropriate for batch, background, and cost-insensitive-latency use. The 知音 AI project
excluded it on this basis (their prompt-latency budget is 2–4 s) *independently* of the ToS
question already documented in the README.

---

## Reproduction

```bash
# harness never touches OCP's :3456 service or ocp-tui-* sessions, and never kill-server
bash docs/plans/2026-07-13-tui-latency/floor.sh 5                                  # baseline
TAG=effort-low EXTRA_ARGS="--effort low" bash .../floor.sh 5                       # −40 %
TAG=bare       EXTRA_ARGS="--bare"       bash .../floor.sh 5                       # the trap

# billing-pool check for ANY spawn-flag change — the banner is the only source of truth
tmux new-session -d -s probe -x 200 -y 50 -c "$HOME" \
  "claude --model claude-sonnet-5 --session-id $(uuidgen) <your-flags-here>"
sleep 6; tmux capture-pane -p -t probe | grep -E "Claude Max|API Usage Billing"
tmux kill-session -t probe
```

## Interaction with OCP while the harness runs

- **Kill direction is safe both ways**: `reapStaleTuiSessions()` only `kill-session`s names
  matching `ocp-tui-<port>-`, which `zhiyin-floor-*` never matches; and the harness only
  `kill-session`s its own single session — it contains **no `kill-server`**.
- **One benign interaction**: OCP's periodic `kill-server` (zombie reaping) is gated on
  `othersRemain` — *any* foreign-prefixed tmux session suppresses it. So while the harness is
  running, that sweep is skipped. This is the coexistence guard working as designed; it resumes
  on the next tick.

## Harness caveats (stated so the numbers are not over-trusted)

- **n=5 per config**, single host, single model (Sonnet 5), single prompt size (~1850 tokens).
  Enough to separate 6 s from 10 s from 30 s; **not** enough for a p95.
- TTFT is "marker visible in `capture-pane`", which includes tmux render latency (small, but
  nonzero) — it is an upper bound on the true first-token time.
- **The harness's readiness marker is not OCP's.** `floor.sh` waits for `│ >|❯|Try "`; OCP's
  `tuiInputReady()` matches `/\? for shortcuts/`. These are different events, so the ~1.0 s
  boot figure is **not** directly comparable to OCP's `BOOT_MS` gate (default cap 4000 ms). It
  does not affect the conclusions (1 s ≪ 6 s TTFT), but it is not apples-to-apples.
- The first version of this harness reported TTFT **0.08 s** — a false positive: the prompt
  literally contained the marker string it was grepping for, so the match fired the instant the
  prompt was pasted. Fixed by describing the marker instead of spelling it. **The script exited 0
  and "successfully" produced 5 samples both times** — exit status proves nothing here.
