// TUI-path concurrency limiter (audit finding C-4).
//
// WHY THIS EXISTS, SEPARATE FROM server.mjs's MAX_CONCURRENT:
//   The global MAX_CONCURRENT gate lives in spawnClaudeProcess() (the -p / stream-json
//   path). callClaudeTui() NEVER calls spawnClaudeProcess — it calls runTuiTurn(), which
//   boots a full interactive `claude` inside a fresh tmux session. So nothing bounded the
//   TUI path: N concurrent TUI requests spawned N simultaneous cold-boot tmux+claude
//   processes. On a small host (a Pi 4 serving a family) a burst of ~5 is an OOM risk, and
//   it also multiplies subscription rate-limit pressure. This is an INDEPENDENT limiter for
//   the TUI path that mirrors MAX_CONCURRENT's intent without coupling to it (the two pools
//   are different shapes: a stream-json spawn is cheap and fast; a TUI turn is a heavy
//   cold-boot + up to 120s wallclock).
//
// QUEUE vs REJECT: we QUEUE (await a slot), mirroring the spirit of MAX_CONCURRENT's
//   intent not to drop requests, rather than rejecting immediately. To avoid unbounded
//   memory growth from a runaway client, the wait queue itself is bounded by maxQueue
//   (default: a generous multiple of the concurrency limit). When the queue is full, run()
//   rejects with a tui_queue_full error (the caller surfaces it as a 503) — a deterministic
//   backpressure signal rather than silent OOM.
//
// Pure + importable so test-features.mjs can assert the bound directly (no server boot).

// Thrown by acquire() when the caller-supplied AbortSignal fires before a slot was granted
// (audit finding F2 — a client that disconnects while queued must never receive a slot; the
// queue entry is spliced out, not just flagged, so `queued` accounting stays exact). Distinct
// `name` lets callers (server.mjs acquireClaudeSlot) tell "client went away" apart from
// "queue is full" without string-matching the message.
export class SemaphoreAbortError extends Error {
  constructor(message) { super(message); this.name = "SemaphoreAbortError"; }
}

export class TuiSemaphore {
  // limit: max concurrent slots. maxQueue: max waiters before run() rejects with backpressure.
  constructor(limit, { maxQueue } = {}) {
    this.limit = Math.max(1, parseInt(limit, 10) || 1);
    // Default queue cap: 32× the limit. Large enough that real family-burst traffic never
    // hits it, small enough that a pathological flood can't grow the queue without bound.
    this.maxQueue = Number.isFinite(maxQueue) ? maxQueue : this.limit * 32;
    this._inflight = 0;
    this._waiters = []; // FIFO queue of resolve callbacks waiting for a slot
  }

  get inflight() { return this._inflight; }
  get queued() { return this._waiters.length; }

  // Runtime-adjust the concurrency limit (audit finding F1 — a PATCH /settings maxConcurrent
  // change must actually take effect, not just be ignored until every currently-inflight task
  // happens to finish). Lowering the limit is handled lazily by release() (see below) — it
  // simply stops re-granting until inflight drains under the new, lower limit. Raising the
  // limit has immediate headroom, so we wake as many queued waiters as now fit.
  setLimit(limit) {
    this.limit = Math.max(1, parseInt(limit, 10) || 1);
    while (this._inflight < this.limit && this._waiters.length > 0) {
      const next = this._waiters.shift();
      this._inflight++;
      next();
    }
  }

  // Acquire a slot. Resolves once a slot is free (immediately if under the limit, otherwise
  // when an in-flight task releases). Rejects synchronously-ish if the wait queue is full.
  // `signal` (optional AbortSignal, F2) lets the caller cancel a QUEUED wait — e.g. wired to
  // a client's socket "close" event so a request that disconnects before a slot is granted
  // is removed from the queue instead of eventually being handed a slot for a dead socket.
  // If `signal` is already aborted, reject immediately without ever touching the queue.
  acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(new SemaphoreAbortError("acquire aborted before requesting a slot"));
    }
    if (this._inflight < this.limit) {
      this._inflight++;
      return Promise.resolve();
    }
    if (this._waiters.length >= this.maxQueue) {
      return Promise.reject(new Error(
        `tui_queue_full: TUI concurrency limit (${this.limit}) reached and wait queue ` +
        `(${this.maxQueue}) is full`));
    }
    return new Promise((resolve, reject) => {
      let waiter; // the FIFO entry — captured so onAbort can find + splice exactly this one
      const onAbort = () => {
        const idx = this._waiters.indexOf(waiter);
        if (idx === -1) return; // already granted a slot (shifted out by release()/setLimit) — too late to cancel
        this._waiters.splice(idx, 1); // remove, not just flag — keeps `queued` accounting exact
        reject(new SemaphoreAbortError("acquire aborted while queued"));
      };
      waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this._waiters.push(waiter);
    });
  }

  // Release a slot. Always frees the caller's own slot first, then re-grants it to the next
  // waiter ONLY if the (post-decrement) inflight count is still under the current limit (F1
  // fix). This is what makes a runtime-lowered limit actually bite: if the limit was lowered
  // while over-subscribed, releases stop re-granting and inflight drains toward the new limit
  // instead of a freed slot being handed straight back out at the old, higher occupancy.
  release() {
    if (this._inflight > 0) this._inflight--;
    if (this._inflight < this.limit) {
      const next = this._waiters.shift();
      if (next) {
        this._inflight++;
        next();
      }
    }
  }

  // Run fn() under one slot. Releases in a finally so a throw (PR-A's honesty gates,
  // wallclock truncation, paste-not-landed, tmux spawn failure) NEVER leaks a slot.
  // `signal` (optional, F2) is forwarded to acquire() so a queued run() can be cancelled.
  async run(fn, signal) {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ── TUI drift observability (audit C-5) — pure helpers, importable for testing ──

// Record an observed cc_entrypoint into the (mutable) tuiStats counter. Sets lastEntrypoint
// unconditionally and increments entrypointMismatches when the spawn was supposed to be
// subscription-pool ("cli") but the transcript reported something else (a silent drift to
// the metered Agent SDK pool — the audit's top risk after the 6/15 billing flip).
// Returns true iff this observation was a mismatch (so the caller can also emit a log).
export function recordTuiEntrypoint(tuiStats, observed, expectedMode = "cli") {
  tuiStats.lastEntrypoint = observed ?? null;
  const mismatch = expectedMode === "cli" && observed !== "cli";
  if (mismatch) tuiStats.entrypointMismatches++;
  return mismatch;
}

// Build the additive /health `tui` block (ADR 0007 PR-B amendment). Pure: given the
// config + live counters, returns the exact object embedded in /health. New fields only —
// behaviour-preserving for existing /health consumers (grandfathered B.2 under ADR 0006).
//
// `pool` (optional, warm pane pool — lib/tui/pool.mjs): a TuiPanePool, or null/undefined
// when the pool is off (the default). Reported as `pool: null` when off so the block's
// shape stays stable, and as the pool's stats (size / warm / hits / misses / …) when on —
// the operator's window onto both the hit rate and the standing idle-process cost.
//
// Streaming fields (backlog #2, OCP_TUI_STREAM) are ADDITIVE too:
//   streamEnabled       — is real (MessageDisplay-hook) SSE streaming on for TUI turns?
//   streamTurns         — streamed turns ATTEMPTED, counted before the truncation/auth-banner
//                         gates run (F6) — so a turn REFUSED by those gates still shows up
//                         here, which is exactly the turn an operator most wants visible.
//                         Counting only turns that survived the gates would silently exclude
//                         a turn's worst-case outcome from its own denominator.
//   streamDeltas        — MessageDisplay hook fires OBSERVED, including held-back ones (F6) —
//                         NOT only the ones forwarded to a client. This is what makes
//                         streamZeroDeltaTurns meaningful: a turn can have streamDeltas
//                         incrementing while still emitting nothing to the client (fully held
//                         back, e.g. a short answer), which is healthy, vs. a hook that fired
//                         zero times at all, which is not (see streamZeroDeltaTurns).
//   streamTopUps        — turns where the delta stream was a safe PREFIX of the transcript but
//                         not equal to it; OCP topped up from the transcript and served T.
//                         Benign but worth watching — a persistent rate means the hook is
//                         losing fires.
//   streamDivergences   — turns REFUSED because emitted bytes were not a prefix of the
//                         transcript. THE field to alert on for CORRECTNESS: it means the hook
//                         and the transcript disagreed and OCP chose to fail rather than serve
//                         unverifiable text.
//   streamZeroDeltaTurns — streamed turns where the hook fired ZERO times (F7). THE field to
//                         alert on for AVAILABILITY: streamTopUps climbing is one fire dropped
//                         here and there (benign); this climbing means the hook is not firing
//                         AT ALL — e.g. `--settings` silently stopped registering it (a claude
//                         version bump), or F3's truncated-script failure mode — and every
//                         streamed turn is quietly degrading to fully-buffered with no error.
export function buildTuiHealthBlock({ enabled, entrypointMode, maxConcurrent, streamEnabled = false }, tuiStats, semaphore, pool = null) {
  return {
    enabled,
    entrypointMode,                                  // cli | auto | off
    lastEntrypoint: tuiStats.lastEntrypoint,         // last observed cc_entrypoint, or null
    entrypointMismatches: tuiStats.entrypointMismatches,
    inflight: semaphore.inflight,                    // current concurrent TUI turns
    queued: semaphore.queued,                        // turns waiting for a slot
    maxConcurrent,
    pool: pool ? pool.stats() : null,                // warm pane pool, or null when disabled
    streamEnabled,
    streamTurns: tuiStats.streamTurns ?? 0,
    streamDeltas: tuiStats.streamDeltas ?? 0,
    streamTopUps: tuiStats.streamTopUps ?? 0,
    streamDivergences: tuiStats.streamDivergences ?? 0,
    streamZeroDeltaTurns: tuiStats.streamZeroDeltaTurns ?? 0,
  };
}
