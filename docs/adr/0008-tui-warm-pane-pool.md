# ADR 0008 — TUI Warm Pane Pool

**Date:** 2026-07-13
**Status:** Proposed
**Extends:** [ADR 0007](0007-tui-interactive-mode.md) (TUI interactive mode). This ADR does not
change ADR 0007's billing-pool argument, security posture, or kill-switch — it adds a latency
optimization *inside* the TUI spawn machinery ADR 0007 owns.

---

## Context

TUI mode (ADR 0007) serves every request by cold-booting a fresh `tmux` session running an
interactive `claude`, submitting one prompt, reading the native transcript, and killing the
session. That cold boot is paid on **every** request.

[`docs/plans/2026-07-13-tui-latency/`](../plans/2026-07-13-tui-latency/README.md) measured the
TUI path and listed a warm pane pool as backlog item #3, costed at "**~1.0 s**" (the observed
boot-to-input-bar time). Instrumenting the real request path showed that estimate is **~4×
too low**. Phase decomposition of the cold path (n=6 medians, Sonnet 4.6, `--effort low`,
through a real OCP instance):

| Phase | Median |
|---|---|
| prep (trust cwd, write prompt file) | 2 ms |
| `tmux new-session` | 27 ms |
| **boot → input bar ready** | **1232 ms** |
| paste (`load-buffer` + `paste-buffer`) | 8 ms |
| paste-verify poll | 426 ms |
| **submit → transcript terminal** | **8458 ms** |
| teardown | 8 ms |
| **total** | **10162 ms** |
| *claude's own reported `turn_duration`* | *5539 ms* |
| **OCP-side overhead** | **4490 ms** |

The `submit → terminal` phase exceeds claude's own `turn_duration` by **~2.9 s**. That gap is
**post-input-bar initialization inside `claude`** — work that a pane which has merely *sat idle
for a few seconds* has already completed. A direct spike confirmed it: an identical pane, idle
12 s before receiving the same prompt, completed its turn in a median 5537 ms versus 7980 ms
cold.

So a warm pane recovers **~1.26 s of boot *and* ~2.9 s of in-`claude` cold start** — not the
~1.0 s the plan predicted.

The reason this was worth a pool rather than a "keep one session and reuse it" cache is a
hazard already flagged in the code. `lib/tui/transcript.mjs` returns the **last text-bearing
assistant entry in the whole transcript file**, which is correct *only* under OCP's
one-session-per-request model, and it says so:

> *"If a future warm-pool ever reuses a session WITHOUT a fresh session-id / clear, earlier-turn
> text could leak — that author must add user-line scoping here."*

Reusing a pane for a second turn puts two exchanges in one transcript and would leak the earlier
turn's text into the later turn's answer — a **cross-request data leak**, not merely a bug.

---

## Decision

Add an **opt-in pool of pre-booted, single-use `claude` panes**, `OCP_TUI_POOL_SIZE` (default
`0` = off, max `4`). Implementation: `lib/tui/pool.mjs`.

### 1. Panes are SINGLE-USE. This is the load-bearing rule.

A pooled pane serves **exactly one turn**, then is killed and replaced in the background. Each
pane is booted with its **own fresh `--session-id`**, fixed at spawn, and the turn locates its
transcript by that id.

This preserves one-session-per-request exactly, so the `transcript.mjs` hazard above **does not
arise** and no user-line scoping was needed. The warning in `transcript.mjs` is deliberately
left standing, now annotated: it still binds anyone who later wants a pane to serve a second
turn, or to reset a session with `/clear` and reuse it. **Neither is permitted without first
adding user-line scoping to the transcript reader.**

Rejected alternative — *reuse a pane for N turns, `/clear` between* — is strictly cheaper
(no re-boot per request) and was rejected on exactly this basis. The latency win is not worth a
cross-request text-leak surface guarded only by a `/clear` that we cannot verify landed.

### 2. The pool is keyed by model, and a MISS is always safe.

`--model` is fixed at spawn, so a pane can only serve the model it booted with. A pool miss
falls back to the existing cold-boot path with **zero behavioural difference**. There is no
boot-time pre-warm and no configured model: OCP cannot know which model the next caller wants,
so the pool warms the **most recently requested** model. Consequence, stated plainly: **the
first request after start, and the first after any model switch, is always a cold miss.**

### 3. The pool and the session reaper coexist by an explicit invariant.

This is the subtle part. `reapStaleTuiSessions()` kills every session matching this instance's
`ocp-tui-<port>-` prefix, and issues `tmux kill-server` when no foreign session remains (the
only mechanism that can reap `<defunct>` `claude` zombies — the pane's `claude` is a child of
the tmux *server*, not of node). A warm pooled pane **is** one of our own sessions, alive and
idle **by design** — and the periodic sweep runs precisely **when the instance is idle**, i.e.
exactly when the pool is full.

The invariant, stated in a comment above `reapStaleTuiSessions` and pinned by tests:

1. **A live pooled pane is never reaped — including one that is still BOOTING.** The reaper
   takes a `spare` set of **exact session names** supplied by the pool's live registry.
2. **An orphaned pooled pane IS still reaped.** Membership is by **exact name from a live
   in-memory registry, never by name shape**. A pane the pool no longer owns — handed out,
   dropped, cancelled, or left behind by a previous process generation (whose registry died with
   it) — is absent from `spare` and is killed like any other stale session. **Fail-safe:
   omitting `spare` reaps *more*, never less.** Pool panes are named `ocp-tui-<port>-p<hex>`
   purely for operator legibility; that shape is *not* the exemption mechanism.
3. **`kill-server` is suppressed while any pane is spared** (it would kill a live child of the
   tmux server). Therefore **the pool is DRAINED immediately before every sweep**, so `spare` is
   empty on the normal tick and `kill-server` still fires. Without the drain, a permanently-full
   pool would **permanently disable zombie reaping** — the pool would silently break the thing
   the sweep exists to do. The drain costs one pane re-boot per tick (15 min).

The `spare` mechanism is belt-and-braces given the drain: it makes it impossible for a reap call
site that *forgets* to drain to kill a live pane.

### 4. The pool tracks its in-flight boot BY NAME, not as a count.

`bootTuiPane` creates the tmux session **synchronously** and only *then* waits (up to
`POOL_BOOT_MS`, 20 s) for the input bar. So **a pooled tmux session can be live for ~20 s before
its boot resolves.** A pool that tracked in-flight boots as a *count* could not name that
session, and this produced two real bugs (both caught in review, both now regression-tested):

- the periodic sweep **killed the booting pane** (it could not be spared), then left the pool
  empty with nothing scheduled, and logged the exact `tui_pool_boot_failed` warning operators are
  told to alert on — for a completely healthy drain;
- graceful shutdown **orphaned a live, authenticated, idle `claude`**: `gracefulShutdown` calls
  `process.exit(0)` in the same tick as the drain (TUI panes are tmux children, so node's
  `activeProcesses` set is empty and the "wait for children" path exits immediately), so any
  cleanup deferred to a `.then()` never ran.

The pool therefore **mints each pane's identity up front** (`{sessionId, name}`, name derived
from the session-id so `tmux ls` correlates to the transcript file) and holds it in
`_bootingPane`. `liveNames()` includes it; `drain()` kills it **synchronously**. A generation
counter distinguishes *"cancelled by us"* from *"genuinely failed"*, so a drain never inflates
`bootFailures` and `resume()` reliably starts a fresh boot.

### 5. Refills take no concurrency slot, and are serialized.

A refill boot deliberately does **not** take a `TuiSemaphore` slot: those slots bound concurrent
*turns* and belong to real requests, and charging a background pre-boot against them would let
the pool starve the traffic it exists to speed up. It cannot leak a slot either, since it never
holds one. Boots are **serialized** (one at a time): two cold boots racing an in-flight turn were
observed to overrun even the generous pool readiness cap. A genuinely failed boot does **not**
re-kick the chain (backoff — a broken `claude` must not respawn forever).

Background boots get a more generous readiness cap (`POOL_BOOT_MS` = 5 × `BOOT_MS`): `BOOT_MS` is
tight because a *client* is blocked on it, which is not true of a pre-boot. Slow ≠ broken.

---

## Consequences

### Cost — standing processes, paid whether or not a request arrives

**A warm pane is a live idle `claude` process.** Peak process count is
`OCP_TUI_POOL_SIZE` + `OCP_TUI_MAX_CONCURRENT` + 1 (booting replacement). This is the whole
reason the pool is **default-off**: an operator must opt into holding processes for traffic that
may never come. Size is clamped to `POOL_MAX_SIZE` = 4; an unparseable value **disables** the
pool rather than guessing.

Panes carry a 10-minute TTL and are health-checked at hand-out; a dead or degraded pane becomes
a **miss** (cold path), never a hung turn.

### Benefit

Measured end-to-end through a real OCP instance (Sonnet 4.6, `--effort low`):
**p50 10.17 s (n=6, pool off) → 6.00 s (n=12 warm hits) — −4.2 s / −41%.**

### The floor is unchanged

The pool does not touch the **~6 s TTFT floor** documented in the latency plan (claude always
prefills the full Claude Code system prompt). TUI mode remains unsuitable for interactive /
real-time consumers; it is for batch and background work. This ADR does not change that
conclusion.

### Observability

`/health`'s `tui` block gains a `pool` sub-object (`null` when off): `size`, `warm`, `booting`,
`model`, `hits`, `misses`, `boots`, `bootFailures`, `cancelled`, `dropped`. A climbing
`bootFailures` means panes are not reaching their input bar — the pool then degrades safely to
the cold path, but latency reverts to the un-pooled numbers. A steadily climbing `dropped` is
**normal** (the 15-min sweep drains and re-boots the pool on every tick, by design — see
Decision 3).

### ALIGNMENT authorization

- **Class B / OCP-owned.** The warm pool is process management around the `claude` CLI — the
  same category as the existing tmux session lifecycle and the defunct-session reaper it extends.
  **`cli.js` does not perform this operation, and no `cli.js` citation applies**; the authority
  is ADR 0007 (which owns the TUI spawn machinery) plus this ADR. This is `ALIGNMENT.md` Rule 2's
  Class B citation requirement, discharged explicitly rather than by silence.
- **The `/health` extension** adds sub-fields to the `tui` block. That block is **owned by ADR
  0007** and post-dates ADR 0006's v3.16.4 grandfather snapshot, so it is not part of the frozen
  B.2 inventory. The change is additive — every pre-existing `/health` field keeps a
  byte-identical value, and `pool` is `null` unless the operator opts in — which is the
  behaviour-preserving bar ADR 0006 sets. This ADR records that authorization.
- **No spawn argument changed.** `buildTuiCmd` is byte-identical; the pool calls it with the same
  arguments. Banner-verified on live pooled panes: `· Claude Max`, never `API Usage Billing`
  (the `--bare` trap documented in the latency plan).

### What a future contributor must not undo

- **Do not let a pane serve a second turn** (or `/clear`-and-reuse one) without first adding
  user-line scoping to `lib/tui/transcript.mjs`. That is a cross-request text leak, not a perf
  tweak. See Decision 1.
- **Do not remove the drain-before-sweep.** It is what keeps `kill-server` zombie reaping alive.
  See Decision 3.
- **Do not go back to counting in-flight boots.** The pool must be able to *name* a session that
  exists but has not finished booting. See Decision 4.
