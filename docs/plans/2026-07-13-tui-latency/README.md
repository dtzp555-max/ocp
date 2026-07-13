# TUI-mode latency: measured floor, and the four things worth fixing

**Date**: 2026-07-13
**Status**: findings + backlog (no code changed yet)
**Measured on**: Mac mini / macOS 26.5.2 / Claude Code **v2.1.207** / Sonnet 5 / Claude Max subscription
**Evidence**: [`measurements.jsonl`](measurements.jsonl) (n=15) · harness [`floor.sh`](floor.sh)

## Why this exists

An external consumer (the 知音 AI project) benchmarked OCP's prompt path and measured
**TTFT p50 ≈ 30–32 s**, and excluded OCP as a backend on that basis. That number is real,
but it is *not* the model being slow — this document decomposes where the 30 seconds
actually go, and what OCP can do about it.

**The harness deliberately does not go through OCP.** It spawns `tmux` + `claude` directly
(session prefix `zhiyin-floor-`, never `ocp-tui-*`, so it cannot collide with OCP's reaper)
and polls `tmux capture-pane` for incremental render, so it measures the **true first-token
time** of the underlying subscription path — the floor OCP could reach if it were perfect.

---

## Measurements

| Config | n | boot→input-ready (median) | **TTFT (median)** | TTFT range | full answer (median) |
|---|---|---|---|---|---|
| baseline (inherits global `effortLevel: xhigh`) | 5 | 1.02 s | **9.70 s** | 7.85 – 13.07 s | 10.80 s |
| **`--effort low`** | 5 | 1.03 s | **6.17 s** | **5.87 – 6.44 s** | 9.98 s |
| `--bare` / `--effort low --bare` | 5 | 0.43 – 0.71 s | **no answer at all** | — | — |
| *reference: direct Anthropic API* | 2 | — | *0.84 – 1.64 s* | — | *3.98 – 8.25 s* |

### Where the 30 seconds go

```
 ~1.0 s   spawn → claude's input bar is ready          ← NOT the bottleneck
 ~6-10 s  true TTFT (first token rendered in the pane)
 ~20 s    ████ waiting for the whole turn to finish ████  ← this is the 30s
```

OCP reads the answer from claude's transcript JSONL and **polls until `turn_duration`
appears** (`docs/adr/0007-tui-interactive-mode.md` step 4) — i.e. it waits for the entire
turn to complete before returning anything. There is no streaming. The ~20 s delta between
this harness's real TTFT and OCP's reported 30–32 s is exactly that.

---

## ⚠️ Blocking constraint: `--bare` silently drops you off the subscription pool

The **only** reliable indicator is the startup banner line in the pane:

| flags | banner | pool |
|---|---|---|
| *(none)* | `Sonnet 5 with xhigh effort · **Claude Max**` | ✅ subscription |
| `--effort low` | `Sonnet 5 with low effort · **Claude Max**` | ✅ subscription |
| **`--bare`** | `Sonnet 5 with xhigh effort · **API Usage Billing**` | ❌ **metered credits** |
| `--effort low --bare` | `… · **API Usage Billing**` | ❌ metered credits |

`--bare` ("skip hooks, LSP, plugin…") **also skips the subscription-credential resolution
path**. It really does cut boot to 0.43–0.71 s — but you are no longer on the subscription,
which defeats the entire purpose of TUI mode (ADR 0007 exists solely to reach the
subscription pool).

**Failure mode is silent**: all 5 `--bare` samples produced *no answer at all* (60 s timeout,
no error, no crash — the pane simply never renders a token), because the API-billing account
had no credit balance. Nothing in the transcript or exit status reveals this. **Anyone
optimizing boot time must diff the banner line before and after.**

---

## Backlog — four items, ranked by value ÷ effort

### 1. Pass `--effort` explicitly on spawn — **do this first**

`lib/tui/session.mjs` → `buildTuiCmd` does not pass `--effort`, so the spawned `claude`
**inherits `~/.claude/settings.json`'s `effortLevel`**. On this host that is `xhigh`, so
every OCP request runs extended thinking — pure waste for the typical "generate this JSON"
request, and it makes latency depend on an unrelated global setting the operator may have
changed for their own interactive use.

- **Effect**: TTFT p50 **9.70 s → 6.17 s (−36 %)**, and the spread collapses from
  7.85–13.07 s to **5.87–6.44 s**. For a proxy, the variance reduction matters more than the median.
- **Cost**: one flag. Suggested: a new `OCP_TUI_EFFORT` env var (default `low`), documented in
  README § "Environment Variables" per `release_kit.new_feature_doc_expectations`.
- **Risk**: none — verified to stay on `Claude Max`.
- ⚠️ Do **not** reach for `--bare` to shave boot: see above.

### 2. Real streaming instead of `turn_duration` polling — **the big one (~20 s)**

Today `runTuiTurn` polls the transcript JSONL until the turn is *finished*. The pane is
already rendering tokens incrementally the whole time — this harness proves you can observe
first token at ~6 s by polling `tmux capture-pane`.

- **Effect**: turns a 30 s wall into a ~6 s TTFT with progressive output; enables SSE
  streaming on the OCP endpoint instead of a single blob at the end.
- **Cost**: real work. Pane capture is ANSI/redraw-based and lossy for exact text (wrapping,
  scrollback, spinner lines). Two candidate sources: (a) incremental reads of the transcript
  JSONL (if claude writes assistant deltas there — **verify first**, it may only write on
  completion), (b) `capture-pane` diffing with a stable start marker. (a) is much cleaner if
  it holds; check before designing around (b).
- **Prereq spike**: does the transcript JSONL grow *during* a turn, or only at the end?

### 3. Warm process pool — ~1 s

Every request spawns a fresh tmux session + `claude` (ADR 0007 step 1). Boot to
input-ready is ~1.0 s, paid on every request. A pool of pre-booted panes (single-use, replaced
in the background) amortizes it to zero for any workload below the pool refill rate.

- **Effect**: −1.0 s.
- **Cost**: moderate; interacts with the session reaper (`lib/tui/session.mjs`) and the
  per-port prefix scoping added in #148 — pooled panes must not look like zombies to the sweep.
- Lower priority than #1 and #2: it is the smallest slice.

### 4. Trim the prefill — **probably not worth it; know the floor**

After #1–#3, the floor is **~6 s**, and it does not go lower. `claude` always injects the full
Claude Code system prompt + tool definitions (thousands to tens of thousands of prefill
tokens) regardless of what you ask it. `--exclude-dynamic-system-prompt-sections` exists and
may shave some of it — **unmeasured**; worth one spike, but do not expect to reach the direct
API's 0.84–1.64 s.

**Consequence to accept, and to state in the README**: even fully optimized, TUI mode has a
**~6 s TTFT floor**, so it cannot serve real-time / interactive-latency consumers. It remains
appropriate for batch, background, and cost-insensitive-latency use. The 知音 AI project
excluded it on this basis (their prompt-latency budget is 2–4 s) *independently* of the ToS
question already documented in the README.

---

## Reproduction

```bash
# harness lives here; it never touches OCP's :3456 service or ocp-tui-* sessions
bash docs/plans/2026-07-13-tui-latency/floor.sh 5                       # baseline
TAG=effort-low EXTRA_ARGS="--effort low" \
  bash docs/plans/2026-07-13-tui-latency/floor.sh 5                     # +36% faster

# billing-pool check for ANY spawn-flag change — the banner is the only source of truth
tmux new-session -d -s probe -x 200 -y 50 -c "$HOME" \
  "claude --model claude-sonnet-5 --session-id $(uuidgen) <your-flags-here>"
sleep 6; tmux capture-pane -p -t probe | grep -E "Claude Max|API Usage Billing"
tmux kill-session -t probe
```

## Harness caveats (stated so the numbers are not over-trusted)

- **n=5 per config**, single host, single model (Sonnet 5), single prompt size (~1850 tokens).
  Enough to separate 6 s from 10 s from 30 s; **not** enough for a p95.
- TTFT is "marker visible in `capture-pane`", which includes tmux render latency (small,
  but nonzero) — it is an upper bound on the true first-token time.
- The first version of this harness reported TTFT **0.08 s** — a false positive: the prompt
  literally contained the marker string it was grepping for, so the match fired the instant the
  prompt was pasted. Fixed by describing the marker instead of spelling it. **The script exited 0
  and "successfully" produced 5 samples both times** — exit status proves nothing here.
