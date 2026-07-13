// TUI warm pane pool (docs/plans/2026-07-13-tui-latency backlog #3).
//
// WHAT IT IS: a small set of PRE-BOOTED `claude` panes, each already sitting at its
// input bar, so a request does not pay the cold boot. Opt-in: OCP_TUI_POOL_SIZE=0
// (default) disables it entirely and the request path is byte-for-byte today's.
//
// ── SINGLE-USE IS THE LOAD-BEARING RULE ─────────────────────────────────────
// A pooled pane serves EXACTLY ONE turn and is then killed and replaced in the
// background. Each pane carries its OWN fresh `--session-id`, fixed at boot, and the
// turn locates its transcript by that id. So OCP's one-session-per-request model is
// preserved: a session's transcript still holds exactly one logical exchange.
// That is what keeps lib/tui/transcript.mjs's extractLatestAssistantText (which returns
// the LAST text-bearing assistant entry in the whole file, not "text since the matching
// user line") correct — see the scoping note there. A pane MUST NEVER serve a second
// turn, and a session MUST NEVER be reset with /clear and reused: either would put two
// exchanges in one transcript and leak the earlier turn's text into the later turn's
// answer. Nothing here reuses a pane; keep it that way.
//
// ── WHY IT'S WORTH MORE THAN THE BOOT TIME ──────────────────────────────────
// Measured on this host (n=6 through OCP, Sonnet 4.6, --effort low): the cold path
// spends ~1.23 s reaching the input bar, but ALSO ~2.9 s inside the first turn beyond
// what claude itself reports as the turn duration — post-input-bar init that a pane
// which has been idle for a few seconds has already finished. A warm pane recovers both.
//
// ── COST (bounded, and paid whether or not a request arrives) ───────────────
// Each warm pane is a LIVE `claude` process (plus its tmux pane) sitting idle. Peak
// process count is (pool size) + (OCP_TUI_MAX_CONCURRENT in-flight turns) + (panes
// currently booting as replacements). Pool size is clamped to POOL_MAX_SIZE.
//
// Pure + injectable (bootPane / killPane / paneHealthy / now) so test-features.mjs can
// assert acquire / miss / refill / TTL / reaper-exemption with no tmux and no claude.

// Hard cap on OCP_TUI_POOL_SIZE. Each pane is an idle claude process; 4 is already a
// lot of resident memory on a small host (a Pi serving a family) for zero in-flight work.
export const POOL_MAX_SIZE = 4;

// A warm pane older than this is dropped on acquire rather than handed out. The periodic
// reap tick (server.mjs) drains the pool every 15 min anyway, so this only bites when
// that tick kept getting skipped because the TUI path was never idle. Guards against
// handing out a pane whose `claude` has been sitting so long it may have drifted
// (auto-compaction prompts, an idle-disconnect banner, an expired in-pane token).
export const POOL_MAX_AGE_MS = 10 * 60 * 1000;

// Clamp the operator-supplied size into [0, POOL_MAX_SIZE]. A garbage value disables the
// pool rather than guessing — an unparseable size must never silently boot 4 processes.
export function resolvePoolSize(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, POOL_MAX_SIZE);
}

export class TuiPanePool {
  // size:       target number of warm panes (0 = disabled).
  // maxAgeMs:   per-pane TTL (see POOL_MAX_AGE_MS).
  // mintPane:   () => ({ sessionId, name }) — mints the identity of the NEXT pane. The POOL,
  //             not the boot function, owns this: the tmux session springs into existence the
  //             instant bootPane starts, so the pool must already know its NAME (see
  //             _bootingPane below). Deriving the name from the sessionId also makes `tmux ls`
  //             correlate to the transcript file.
  // bootPane:   async (model, {sessionId, name}) => { name, sessionId, model, bootedAt } —
  //             boots ONE pane under exactly that identity and resolves only once it is
  //             input-ready; throws if it never becomes ready.
  // killPane:   (name) => void — tmux kill-session. MUST be synchronous (see drain).
  // paneHealthy:(name) => bool — pane still exists AND is still at its input bar.
  constructor({ size, maxAgeMs = POOL_MAX_AGE_MS, mintPane, bootPane, killPane, paneHealthy, now = Date.now, log = () => {} }) {
    this.size = Math.max(0, Math.min(parseInt(size, 10) || 0, POOL_MAX_SIZE));
    // Fail fast at CONSTRUCTION, not at request time. refill() is called synchronously from
    // the request path (runTuiTurn), so a missing collaborator would otherwise surface as a
    // 500 on a live request instead of a loud error at boot.
    if (this.size > 0) {
      for (const [k, fn] of [["mintPane", mintPane], ["bootPane", bootPane], ["killPane", killPane], ["paneHealthy", paneHealthy]]) {
        if (typeof fn !== "function") throw new TypeError(`TuiPanePool: ${k} must be a function`);
      }
    }
    this.maxAgeMs = maxAgeMs;
    this._mintPane = mintPane;
    this._bootPane = bootPane;
    this._killPane = killPane;
    this._paneHealthy = paneHealthy;
    this._now = now;
    this._log = log;

    this._panes = [];        // warm, available panes: { name, sessionId, model, bootedAt }
    // The pane currently BOOTING, BY NAME ({sessionId, name, model}) — or null.
    //
    // WHY A NAME AND NOT A COUNT (this is a fixed bug, don't regress it): bootTuiPane creates
    // the tmux session SYNCHRONOUSLY and only THEN waits up to POOL_BOOT_MS (20 s) for the
    // input bar. So for up to 20 s there is a LIVE pooled tmux session. When the pool tracked
    // only a count, it could not NAME that session, so:
    //   - liveNames() could not spare it and the periodic reap sweep KILLED it (and
    //     kill-server'd on top), leaving the pool empty with nothing scheduled and firing the
    //     very tui_pool_boot_failed WARN operators are told to alert on; and
    //   - drain() could not kill it, so on shutdown it ORPHANED a live authenticated `claude`
    //     (the boot's .then that was supposed to clean up never runs — gracefulShutdown calls
    //     process.exit in the same tick).
    // Both are fixed by holding the identity here, before the session exists.
    this._bootingPane = null;
    // Generation counter. Bumped whenever an in-flight boot is CANCELLED (drain / model
    // switch). A boot compares the generation it started under against the current one:
    // if they differ, its pane was already killed by us and its settle is inert — in
    // particular a rejection is a CANCELLATION, not an operator-visible boot failure.
    this._gen = 0;
    this._paused = false;    // true while drained; refill() is a no-op until resume()
    this.warmModel = null;   // the model the pool currently warms — learned from traffic (see acquire)

    this.hits = 0;           // requests served by a warm pane
    this.misses = 0;         // requests that fell back to the cold path
    this.boots = 0;          // panes successfully pre-booted
    this.bootFailures = 0;   // pre-boots that genuinely never reached the input bar
    this.cancelled = 0;      // in-flight boots WE killed (drain / model switch) — not failures
    this.dropped = 0;        // panes discarded unused (unhealthy / expired / wrong model / drained)
  }

  get enabled() { return this.size > 0; }
  get warm() { return this._panes.length; }
  get booting() { return this._bootingPane ? 1 : 0; }

  // The reaper's spare set: the EXACT names of every pane the pool currently owns and has NOT
  // handed out — the warm ones AND the one currently booting (whose tmux session is already
  // live; see _bootingPane). See the POOL/REAPER INVARIANT in lib/tui/session.mjs.
  // Fail-safe by construction: a pane leaves this set the instant it is acquired, dropped, or
  // cancelled, and if the pool is empty (or the process restarted) the set is empty — so an
  // orphaned pooled pane looks exactly like any other stale session and IS reaped.
  liveNames() {
    const names = new Set(this._panes.map((p) => p.name));
    if (this._bootingPane) names.add(this._bootingPane.name);
    return names;
  }

  // Take a warm pane for `model`, or null (caller must fall back to the cold path — a MISS
  // is always safe, never an error). Synchronous: paneHealthy is a cheap tmux capture.
  //
  // The pool warms the MOST RECENTLY REQUESTED model (`warmModel`). There is no boot-time
  // pre-warm and no configured model: OCP cannot know which model the next caller wants, and
  // pre-booting a process for a model nobody asks for is pure waste. Consequence, stated
  // plainly: the FIRST request after start (and the first after a model switch) is always a
  // MISS. The pool pays off for the steady repeat traffic it exists to serve.
  acquire(model) {
    if (!this.enabled) return null;

    // Retarget on a model switch: --model is fixed at spawn, so panes for another model are
    // useless. Drop them now (they are replaced by the next refill) rather than holding
    // processes for a model that is no longer being asked for. This includes any pane
    // currently BOOTING for the old model — its tmux session already exists, so leaving it to
    // die on resolve would both hold a useless process and block the next refill (one boot at
    // a time) for up to POOL_BOOT_MS.
    if (model !== this.warmModel) {
      for (const p of this._panes) { this._drop(p, "model_switch"); }
      this._panes = [];
      this._cancelBooting("model_switch");
      this.warmModel = model;
    }

    while (this._panes.length) {
      const p = this._panes.shift();
      if (this._now() - p.bootedAt > this.maxAgeMs) { this._drop(p, "expired"); continue; }
      if (!this._paneHealthy(p.name)) { this._drop(p, "unhealthy"); continue; }
      this.hits++;
      return p; // caller OWNS it now: it is out of the registry (so out of the spare set),
                // and the caller's finally MUST kill it. Single-use — never returned here.
    }
    this.misses++;
    return null;
  }

  // Bring the pool back up to `size` warm panes for `warmModel`. Fire-and-forget: never
  // awaited on the request path and never throws into it.
  //
  // SLOT ACCOUNTING: a refill boot deliberately does NOT take a TuiSemaphore slot. Those
  // slots bound concurrent *turns* (each up to the 120 s wallclock) and belong to real
  // requests; charging a background pre-boot against them would let the pool starve the
  // traffic it exists to speed up. It cannot leak a slot either, because it never holds one.
  //
  // SERIALIZED, ONE BOOT AT A TIME (and re-kicked on success until the pool is at target).
  // An earlier version launched all `want` boots at once; live at size=2 that put two cold
  // `claude` boots plus an in-flight turn on the CPU together, and a refill overran even the
  // generous pool readiness cap (tui_pool_boot_failed). Booting sequentially keeps each boot
  // near its uncontended ~1.2 s, bounds the CPU burst the pool can cause, and still has the
  // replacement pane warm long before the next request arrives.
  //
  // A genuinely FAILED boot deliberately does NOT re-kick the chain — that is the backoff. A
  // persistently failing boot (bad claude binary, no auth) would otherwise spin, respawning
  // forever. The next natural trigger (the following request's refill, or the reap tick's
  // resume) retries it. A CANCELLED boot is different: we killed it on purpose, nothing is
  // wrong, and resume() is expected to start a fresh one immediately.
  refill() {
    if (!this.enabled || this._paused || !this.warmModel) return;
    if (this._bootingPane) return;                       // one boot in flight at a time
    if (this._panes.length >= this.size) return;         // already at target

    const model = this.warmModel;
    const gen = this._gen;
    // Mint the identity BEFORE booting: bootPane creates the tmux session synchronously, so
    // the pool must be able to name (and therefore spare, and kill) it from this moment on.
    const ident = this._mintPane();
    this._bootingPane = { ...ident, model };
    let enlisted = false;
    Promise.resolve()
      .then(() => this._bootPane(model, ident))
      .then((pane) => {
        // The world may have moved while we booted. If our generation was cancelled, our pane
        // was ALREADY killed by _cancelBooting — do not touch it, do not enlist it.
        if (gen !== this._gen) return;
        // Otherwise: still possible the pool filled or retargeted without a cancellation.
        if (this._paused || model !== this.warmModel || this._panes.length >= this.size) {
          this._drop(pane, "stale_boot");
          return;
        }
        this._panes.push(pane);
        this.boots++;
        enlisted = true;
      })
      .catch((e) => {
        // A rejection from a CANCELLED generation is not a fault: it is almost always
        // "tui_pane_not_ready", thrown because WE killed the pane out from under the boot.
        // Counting it as a bootFailure would fire the exact WARN operators are told to alert
        // on, for a completely healthy drain. Stay silent — _cancelBooting already counted
        // this as a cancellation, so do NOT count it again here.
        if (gen !== this._gen) return;
        this.bootFailures++;
        this._log("warn", "tui_pool_boot_failed", { model, error: e && e.message });
      })
      .finally(() => {
        // ONLY the current generation's boot owns the booting slot. A stale settle must not
        // clear a slot that a newer boot (started by resume()) already holds.
        if (gen === this._gen) this._bootingPane = null;
        if (enlisted) this.refill(); // continue toward target, still one at a time
      });
  }

  // Kill the in-flight boot's pane, SYNCHRONOUSLY, and invalidate its generation. Returns 1
  // if there was one, else 0. The tmux session already exists (bootPane created it before it
  // started waiting for readiness), so this is a real kill, not a cancellation flag.
  _cancelBooting(reason) {
    if (!this._bootingPane) return 0;
    this._gen++;                              // the in-flight boot's settle is now inert
    this._drop(this._bootingPane, reason);    // synchronous kill-session
    this._bootingPane = null;
    this.cancelled++;
    return 1;
  }

  // Kill every pane the pool owns — warm AND currently booting — and stop refilling. Returns
  // how many were killed.
  //
  // Called (a) before the periodic reap sweep — reapStaleTuiSessions can only reap defunct
  // `claude` zombies via kill-server, and kill-server is suppressed while any live pooled pane
  // exists (including a booting one), so without this drain the pool would permanently disable
  // zombie reaping; and (b) on graceful shutdown, so no pane outlives the process as an orphan.
  //
  // EVERY KILL HERE IS SYNCHRONOUS, and that is load-bearing. It is NOT safe to leave the
  // booting pane to clean itself up on resolve: gracefulShutdown calls process.exit() in the
  // same tick as this drain (TUI panes are children of the tmux SERVER, not of node, so
  // node's activeProcesses set is empty on a TUI host and the "wait for children" path exits
  // immediately). A .then()/.catch() scheduled here would never run, and the pane would
  // survive as an orphaned, authenticated, idle `claude`.
  drain() {
    this._paused = true;
    let n = this._panes.length;
    for (const p of this._panes) this._drop(p, "drain");
    this._panes = [];
    n += this._cancelBooting("drain_booting");
    return n;
  }

  // Undo drain() and start refilling again. Because drain() CANCELLED the in-flight boot
  // (rather than leaving it pending), the booting slot is free and this really does start a
  // fresh boot — the pool is never left empty with nothing scheduled.
  resume() {
    this._paused = false;
    this.refill();
  }

  // /health surface (additive).
  stats() {
    return {
      size: this.size,
      warm: this._panes.length,
      booting: this.booting,
      model: this.warmModel,
      hits: this.hits,
      misses: this.misses,
      boots: this.boots,
      bootFailures: this.bootFailures,
      cancelled: this.cancelled,
      dropped: this.dropped,
    };
  }

  _drop(pane, reason) {
    this.dropped++;
    try { this._killPane(pane.name); } catch { /* already gone */ }
    this._log("info", "tui_pool_pane_dropped", { name: pane.name, reason });
  }
}
