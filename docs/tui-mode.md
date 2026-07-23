Part of [OCP](../README.md) — subscription-pool (TUI) mode: serve requests through interactive `claude` so they bill the Pro/Max subscription pool instead of the metered Agent SDK path.

# Subscription-pool (TUI) mode

> **SECURITY — read before enabling.**  
> TUI-mode is **single-user / single-operator only**. `claude` runs with the OCP process owner's filesystem access regardless of `HOME` setting. If OCP serves multiple users or guest API keys, a guest prompt could exfiltrate files or exhaust the subscription. **Never enable `CLAUDE_TUI_MODE=true` on a multi-user OCP.**

## What it is and why

> **⚠️ Status (as of 2026-07): the billing split below is PAUSED.** Anthropic announced it for 2026-06-15, then paused it on the effective date — *"For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits"* ([official help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). While the pause holds, OCP's default `-p` path bills the subscription and **TUI-mode is a hedge, not a necessity**. The table describes the *announced* regime, kept here because Anthropic says a reworked change will return (with advance notice) — everything in this section is ready to flip on that day.

The announced routing keys `claude` invocations by `cc_entrypoint`:

| Launch method | `cc_entrypoint` | Billing pool (announced regime, currently paused) |
|---------------|-----------------|-------------|
| `claude -p` / `--output-format` (OCP default) | `sdk-cli` | Agent SDK credit pool (~$20/mo on Pro) |
| Interactive `claude` (no flags) | `cli` | Pro/Max subscription pool |

TUI-mode lets OCP serve requests via the interactive path so they bill against the subscription pool under that regime. The response is read from claude's native JSONL session transcript once the turn is complete, then replayed to the caller as a normal OpenAI completion or chunked SSE response.

<a id="tui-entrypoint"></a>
## Billing-classifier labeling (`OCP_TUI_ENTRYPOINT`)

`OCP_TUI_ENTRYPOINT` (default `cli`) controls how `CLAUDE_CODE_ENTRYPOINT` is set on the spawn
environment. The default (`cli`) pins the value deterministically — immune to a stray inherited
env var or a future stdout-redirect bug silently flipping it to `sdk-cli`. This label is honest
**only** when the spawn is a genuine interactive PTY (tmux pane, no `-p`, stdout not redirected,
and `tmux new-session` verified to succeed). If you need to observe the raw TTY-derived value, set
`OCP_TUI_ENTRYPOINT=auto`. See ADR 0007 for the full rationale and governing rule.

## Enabling TUI-mode (opt-in)

```bash
# Prerequisites
mkdir -p ~/.ocp-tui/work    # one-time scratch cwd setup
# tmux must be installed: brew install tmux  /  apt install tmux

# Enable
export CLAUDE_TUI_MODE=true
# STRONGLY RECOMMENDED on a TUI host — authenticate via the long-lived OAuth token.
# With this set (and OCP_TUI_HOME left UNSET), OCP runs the interactive claude in a
# credential-isolated home ($HOME/.ocp-tui/home, no credentials.json), so the env token
# is the only credential and is authoritative. This both stops a stale credentials.json
# from shadowing the token AND ends the refresh-token corruption that caused a permanent
# "Please run /login" 401 (no credentials file → claude never runs the refresh path).
# See the auth note below + ADR 0007 PR-D.
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# Optionally tune:
export CLAUDE_TUI_WALLCLOCK_MS=180000   # 3 min cap for long Opus turns
export OCP_TUI_CWD=$HOME/.ocp-tui/work  # default; override if needed
export OCP_TUI_ENTRYPOINT=cli           # default; use 'auto' to observe TTY-derived value
# Do NOT set OCP_TUI_HOME for the recommended setup — leaving it unset is what enables
# the credential-isolated home. Set it only to opt into the legacy symlinked-creds mode.
```

Then restart OCP. At boot you will see (with the env token set, isolated home auto-selected):

```
⚠️  TUI-mode ON — single-user only; do NOT enable on a multi-user OCP ...
  TUI-mode: ON home=/home/user/.ocp-tui/home cwd=/home/user/.ocp-tui/work auth=env-token (credential-isolated home — no credentials.json) wallclock=120000ms maxConcurrent=2
```

## What changes / what doesn't

- **Callers see no API change.** The response is a normal OpenAI completion object or chunked SSE — identical wire format.
- **Real streaming is opt-in (`OCP_TUI_STREAM=1`), and off by default.** By default TUI-mode buffers the full response and replays it as chunked SSE — you see a delay, then the complete response. Set `OCP_TUI_STREAM=1` and `stream:true` turns emit real SSE `delta.content` chunks as `claude` renders them, sourced from `claude`'s own `MessageDisplay` hook (byte-faithful raw markdown, on the subscription pool, no `-p`). Two honest caveats: granularity is **block-level** — the hook fires once per rendered block, so a handful of chunks per answer, scaling with length, not token-by-token; and it moves the **first** byte, not the last, so a consumer that must parse a complete reply gains nothing. The transcript stays authoritative: every streamed turn is asserted against it at the end, and a turn whose stream disagrees is **failed rather than served** (watch `tui.streamDivergences` on `/health`). Evidence: [`plans/2026-07-13-tui-latency/streaming-spike.md`](plans/2026-07-13-tui-latency/streaming-spike.md).
- **Cache and singleflight work normally.** TUI-mode writes the buffered response to the cache on success; cache-hits skip the interactive turn entirely.
- **The host's `CLAUDE.md` / auto-memory is never injected.** OCP is a proxy — the proxied client (OpenClaw / your IDE) owns its own context and memory. TUI-mode runs `claude` with `--safe-mode`, which disables all host customizations (CLAUDE.md, skills, plugins, hooks, MCP servers) while leaving auth, model selection, built-in tools, and permissions untouched — so a `CLAUDE.md` on the OCP host can never leak into a proxied turn and steer the answer, and the session still bills the subscription pool (`cc_entrypoint=cli`, unlike `--bare`). The `CLAUDE_CODE_DISABLE_CLAUDE_MDS` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env vars are kept as a fallback (see #4). Built-in tool schemas + the interactive system prompt remain (the inherent ~20–35K context floor of interactive mode); MCP is hard-disabled. **Exception:** the two opt-in modes that deliberately need a customization `--safe-mode` would strip — real streaming (`OCP_TUI_STREAM`, which registers a `MessageDisplay` **hook** via `--settings`) and `OCP_TUI_FULL_TOOLS` (which grants an **MCP** / skills surface) — run without `--safe-mode` and rely on the env-var suppression alone.
- **Authenticate via `CLAUDE_CODE_OAUTH_TOKEN` in a credential-isolated home (recommended).** tmux does not forward the parent process's env to the pane, so OCP sets the token explicitly on the spawned `claude` when `CLAUDE_CODE_OAUTH_TOKEN` is present. With the env token set and `OCP_TUI_HOME` unset, OCP runs claude in a **credential-isolated home** (`$HOME/.ocp-tui/home`) that has **no `credentials.json`** — so the env token is the only credential and is authoritative, and claude never runs the token-refresh path. This both stops a stale `credentials.json` from shadowing the token and ends the refresh-token corruption behind the permanent `Please run /login · API Error: 401` (full two-layer root cause, live proof, and fix in [Troubleshooting § the permanent TUI-mode 401](troubleshooting.md#tui-401)). Transcripts land under the same isolated home, so the answer-reader is unaffected. Without the env token, claude falls back to the real home's `credentials.json` (byte-for-byte the previous behaviour). (The token is visible in `ps` on the pane command — acceptable for the single-user A-path; the multi-user B-path is refused at boot.) See ADR 0007 PR-C / PR-D amendments.
- **Stale tmux sessions are reaped.** The pane's `claude` is a child of the tmux server (not OCP), so OCP cannot reap it directly; `claude` zombies can otherwise accumulate as `<defunct>` over a long-running host. OCP reaps them at boot and on a 15-min idle sweep by issuing `tmux kill-server` — but **only when no foreign tmux session remains** (it never disrupts a co-hosted `olp-tui-*` instance). See ADR 0007 PR-C amendment.
- **Default path unchanged.** Unset `CLAUDE_TUI_MODE` and restart → `callClaude` / `callClaudeStreaming` are used again, byte-for-byte identical to today.
- **Concurrency is bounded separately.** TUI turns are heavy (per-request cold-boot + long wallclock), so the TUI path has its own limiter — `OCP_TUI_MAX_CONCURRENT` (default `2`), independent of `CLAUDE_MAX_CONCURRENT`. Excess turns queue; a full queue returns a 503. Tune it up only on a host that can run more interactive `claude` sessions at once.
- **Optional warm pane pool (`OCP_TUI_POOL_SIZE`, default off).** Pre-boots panes so a request skips the cold boot — measured p50 `10.17s` → `6.00s` (−41%). Pooled panes are **single-use** (one turn, then killed and replaced in the background), each carrying its own fresh `--session-id`, so one session still means one exchange and no earlier-turn text can leak into a later answer. They are named `ocp-tui-<port>-p<hex>` and coexist with the reaper by design: the sweep **drains the pool first**, then reaps (so `kill-server` still flushes `<defunct>` zombies), then the pool refills in the background. Drain→reap→resume is synchronous, so no request can land mid-sweep; a request arriving while the pool is still re-booting simply misses it and cold-boots. A live pooled pane is never reaped — **including one that is still booting**, whose tmux session already exists — while an *orphaned* one (left by a previous process generation) still is.

## ⚠️ Latency: TUI mode has a ~6-second floor, and it is immovable

**TUI mode cannot serve real-time or interactive-latency consumers.** This is a hard property of the
path, stated plainly so you can rule it out before building on it:

| | measured |
|---|---|
| **TTFT floor (first token)** | **≈ 6 s** — immovable |
| cold boot → input bar ready | ~1 s (per request; not the bottleneck) |
| OCP's own overhead above the CLI | ~4 s (n=1 same-turn decomposition) |
| direct Anthropic API, same prompt (for scale) | 0.84–1.64 s |

The ~6 s floor is the `claude` CLI itself: it always injects the full Claude Code system prompt plus
its tool definitions before your prompt, on every turn, no matter what you ask. No flag removes it
(`--exclude-dynamic-system-prompt-sections` was measured: **no effect** on the floor). Extended
thinking is *not* the cause — `OCP_TUI_EFFORT` already defaults to `low`, which is what cuts a
formerly-inherited `xhigh` down to this floor and collapses its variance.

On top of the floor you pay the model's generation time (a function of output length). Progressive
output is not wired up **yet** (see "No real token streaming" above — it is achievable and planned),
so today a turn returns as one blob once generation completes. Note that streaming, when it lands,
will move the *first* byte earlier — it does **not** shorten the turn, and a consumer that needs the
complete answer gains nothing from it.

**Use TUI mode for**: batch, background, and latency-insensitive work where the subscription pool is
the point. **Do not use it for**: anything a person is waiting on interactively, or any consumer with
a sub-5-second budget. Full measurements and methodology:
[`plans/2026-07-13-tui-latency/`](plans/2026-07-13-tui-latency/).

## Monitoring drift via `/health`

`GET /health` includes a `tui` block so you can poll for a silent billing-pool drift (the top risk under the announced split, if it re-lands — a lost TTY flipping `cc_entrypoint` from `cli` to `sdk-cli` would still return answers but land in the metered pool). The block is **always present** (with `enabled:false` when TUI-mode is off):

```jsonc
"tui": {
  "enabled": true,             // CLAUDE_TUI_MODE === "true"
  "entrypointMode": "cli",     // OCP_TUI_ENTRYPOINT (cli | auto | off)
  "lastEntrypoint": "cli",     // last cc_entrypoint observed in a transcript, or null
  "entrypointMismatches": 0,   // count of cli-expected-but-got-other turns — ALERT if this climbs
  "inflight": 1,               // TUI turns running right now
  "queued": 0,                 // TUI turns waiting for a concurrency slot
  "maxConcurrent": 2,          // OCP_TUI_MAX_CONCURRENT
  "pool": {                    // warm pane pool — null when OCP_TUI_POOL_SIZE=0 (the default)
    "size": 2,                 // target warm panes (OCP_TUI_POOL_SIZE)
    "warm": 2,                 // panes ready right now — each is a LIVE idle claude process
    "booting": 0,              // replacement panes currently pre-booting
    "model": "claude-sonnet-4-6", // the model being warmed (the most recently requested one)
    "hits": 12,                // requests served by a warm pane
    "misses": 1,               // requests that fell back to the cold boot (the 1st is always one)
    "boots": 14,               // panes successfully pre-booted
    "bootFailures": 0,         // pre-boots that genuinely never reached the input bar — WATCH this
    "cancelled": 4,            // in-flight boots OCP killed on purpose (drain / model switch) — not faults
    "dropped": 8               // panes discarded unused (drain sweep / expired / unhealthy)
  }
}
```

Alert on `entrypointMismatches > 0` (or `lastEntrypoint !== "cli"`): it means a turn drew from the metered Agent SDK pool instead of the subscription. `inflight` / `queued` show how close the TUI path is to its concurrency cap.

With the pool on, `hits` / `misses` is the hit rate (a steady single-model consumer should sit near 100% after the first request), and `warm` is your standing idle-process cost. A climbing `bootFailures` means panes are not reaching their input bar — the pool then degrades safely to the cold path, but latency reverts to the un-pooled numbers. `cancelled` counts boots OCP killed *on purpose* (a drain, a model switch) and is **not** a fault signal — do not alert on it. A steadily climbing `dropped` is likewise normal: the 15-min reap sweep drains and re-boots the pool on every tick so `kill-server` can still flush `<defunct>` zombies.

## Kill-switch

```bash
unset CLAUDE_TUI_MODE
# restart OCP
```

The stream-json path is restored immediately. No other change is needed.

## Operator checklist for the (paused) billing split

> **Status:** the 2026-06-15 split never took effect — Anthropic paused it on the effective date (see the status note at the top of this section). **Nothing needs flipping while the pause holds.** The checklist is retained verbatim as the runbook for if/when a reworked change lands (Anthropic has promised advance notice).

Under the announced regime, every host serving traffic must be flipped to TUI-mode **and** canary-verified before the effective date, or it will bill the metered Agent SDK credit pool instead of the subscription.

- **[Flip/rollback runbook](runbooks/tui-flip-rollback.md)** — how to set `CLAUDE_TUI_MODE=true` on systemd (Linux) and launchd (macOS) hosts. Covers the `daemon-reload` requirement (systemd) and the `bootout`+`bootstrap` cycle requirement (launchd — `launchctl kickstart -k` does not reload plist env).
- **[615-canary runbook](runbooks/615-canary.md)** — after each flip, run one quiesced request and compare the Agent SDK credit balance before and after. `entrypoint:cli` in the transcript (the `cc_entrypoint` billing classifier) is necessary but not sufficient — only a stable credit balance confirms the subscription pool is being used. Balance check is a manual step (no known programmatic API for the Agent SDK credit pool balance).

## Architecture and design decisions

See [`adr/0007-tui-interactive-mode.md`](adr/0007-tui-interactive-mode.md) for the full rationale, home-strategy options, MCP-disable mechanism, coexistence rules, and the B-path (multi-tenant isolation) roadmap.

## TUI-mode environment variables

The README [Environment Variables](../README.md#environment-variables) table lists these as one-line pointers; the full behaviour of each lives here.

<a id="ocp-tui-stream"></a>
### `OCP_TUI_STREAM` — real SSE streaming (opt-in)

`OCP_TUI_STREAM` default `0` (off). When `=1`, `stream:true` requests emit **real SSE `delta.content` chunks as `claude` generates them**, instead of buffering the turn and replaying it. Deltas come from `claude`'s own `MessageDisplay` hook (registered with `--settings` on the ordinary interactive spawn — banner-verified to stay on the subscription pool, `· Claude Max`). Granularity is **block-level**, not token-level. The transcript remains authoritative: the streamed text is asserted equal to it at end-of-turn, the auth-banner and truncation gates still run before anything is committed, and only the transcript text is cached. A turn whose stream cannot be reconciled with the transcript is **refused** (SSE error frame, not cached) and counted as `tui.streamDivergences` on `/health`. A total hook failure (e.g. `--settings` stops registering it after a `claude` version bump) is a *different, silent* failure mode — every streamed turn still succeeds, fully buffered, with no divergence and no error — so it is counted separately as `tui.streamZeroDeltaTurns` (streamed turns where the hook fired **zero** times) and logged as `tui_stream_zero_deltas`; watch it alongside `streamDivergences`. Default off — the buffered path is unchanged and remains the stable default. ⚠️ **Tool-using turns:** the transcript keeps only the model's **last** assistant message, so if the model narrates before calling a tool ("I'll check that file…") and that narration exceeds `OCP_TUI_STREAM_HOLDBACK`, it has already been streamed and cannot be retracted — the turn is then **refused** rather than served (measured live: Opus narrated 475 chars before a `Bash` call). If your deployment lets the model use tools (the TUI default, and anything with `OCP_TUI_FULL_TOOLS=1`), either raise `OCP_TUI_STREAM_HOLDBACK` above the typical narration length — the narration then stays held back and is correctly discarded, at the cost of a later first chunk — or leave streaming off. Streaming is best suited to tool-light chat proxying. See ADR 0007 (2026-07-13 amendment).

Two related streaming knobs:

- **`OCP_TUI_STREAM_DIR`** (default `$HOME/.ocp-tui/stream`) — directory holding the static `MessageDisplay` hook script + settings file, and the per-session delta sink (`<session-id>.jsonl`, removed at turn teardown). One sink **per session-id** — this is what keeps concurrent TUI turns (`OCP_TUI_MAX_CONCURRENT` ≥ 2) from interleaving one client's deltas into another's stream.
- **`OCP_TUI_STREAM_POLL_MS`** (default `100`) — interval at which OCP drains the delta sink. The hook fires at block granularity (seconds apart), so a finer poll buys nothing.

<a id="ocp-tui-stream-holdback"></a>
### `OCP_TUI_STREAM_HOLDBACK`

`OCP_TUI_STREAM_HOLDBACK` default `100`. (TUI-mode, streaming) Characters withheld before the first chunk reaches the client. Two jobs. (1) It keeps the **auth-banner gate** alive under streaming, via a guarantee with two required halves: (i) nothing is emitted for a message until its trimmed accumulation exceeds 100 chars — past the default banner detector's reach, since real banners are ≤100 chars — and (ii) once a message boundary follows an emit, nothing further is ever emitted for the rest of the turn, and the turn is refused outright. Half (i) alone only covers a turn's first message; half (ii) is what covers an error banner rendered as a *later* message (e.g. after tool-using prose). Raise the holdback if you replace the detector via `CLAUDE_TUI_ERROR_PATTERNS` with patterns that can match longer messages — that only affects half (i); OCP warns at boot if you do. (2) It is the knob for **tool-using turns** — see the `OCP_TUI_STREAM` caveat above. Answers shorter than the holdback are simply delivered whole at end-of-turn, exactly as the buffered path does.

<a id="ocp-tui-pool-size"></a>
### `OCP_TUI_POOL_SIZE` — warm pane pool

`OCP_TUI_POOL_SIZE` default `0` (off). Number of **pre-booted warm `claude` panes** kept ready, so a request does not pay the cold boot. `0` disables the pool entirely — the request path is then exactly the cold-boot path. Max `4`; an unparseable value disables it rather than guessing. **Measured on a Mac mini (Sonnet 4.6, `--effort low`): end-to-end p50 `10.17s` (n=6, pool off) → `6.00s` (n=12 warm hits) — −4.2 s / −41%** — the pool recovers both the ~1.2 s boot *and* ~2.9 s of post-input-bar init that a pane which has been idle a moment has already finished. **Cost:** each warm pane is a *live idle `claude` process* held whether or not a request ever arrives (peak processes ≈ pool size + `OCP_TUI_MAX_CONCURRENT` + 1 booting replacement) — which is why it is opt-in. Panes are **single-use**: one turn, then killed and replaced in the background. The **first request after start (and after any model switch) is always a cold miss** — the pool warms the most recently requested model, since OCP cannot know which model the next caller wants. See [`plans/2026-07-13-tui-latency/`](plans/2026-07-13-tui-latency/).

<a id="ocp-tui-full-tools"></a>
### `OCP_TUI_FULL_TOOLS` — full tool surface (single-user only)

`OCP_TUI_FULL_TOOLS` default *(unset)*. (TUI-mode, **single-user only**) When `=1`, grant the interactive session the **same tool surface as the `-p` path** — `--allowedTools` (+ optional `--mcp-config`, read from `CLAUDE_ALLOWED_TOOLS` / `CLAUDE_MCP_CONFIG`) — instead of the default MCP-walled, built-in-tools-only set. Lets a trusted single-operator TUI deployment run a **tool-using / MCP agent** (e.g. an OpenClaw assistant) on the subscription pool. Safe because TUI **refuses to boot under `AUTH_MODE=multi`** (hard exit) — no guest key can ever reach the TUI path, so this gate cannot expose tools to an untrusted caller. (Under `AUTH_MODE=shared` + `OCP_TUI_ALLOW_LAN=1`, anyone holding the single shared key reaches it — that is the existing TUI trust model, unchanged.) Note: `--dangerously-skip-permissions` / `CLAUDE_SKIP_PERMISSIONS` is **not** supported for TUI — claude v2.1.x shows an interactive bypass-acceptance screen in headless tmux that cannot be answered, bricking the pane. Use scratch-home `settings.json` `additionalDirectories` instead. See ADR 0007.

<a id="tui-other-vars"></a>
### Other TUI-mode variables

- **`OCP_TUI_MAX_CONCURRENT`** (default `2`) — Max concurrent interactive TUI turns. **Independent** of `CLAUDE_MAX_CONCURRENT` (which bounds the `-p`/stream-json path; TUI never uses it). A TUI turn is heavy (per-request cold-boot of tmux+claude + up to `CLAUDE_TUI_WALLCLOCK_MS` wallclock), so the default is low to keep small hosts (e.g. a Pi 4) alive under a burst. Excess turns **queue** (bounded); a full queue yields a 503. See ADR 0007 PR-B amendment.
- **`OCP_TUI_ENTRYPOINT`** (default `cli`) — Billing-classifier labeling: `cli` (default) pins `cc_entrypoint=cli` deterministically; `auto` lets claude self-classify via TTY detection; `off` leaves the inherited env untouched. Honest only when the spawn is a genuine interactive PTY — see the "Billing-classifier labeling" section above and ADR 0007.
- **`OCP_TUI_EFFORT`** (default `low`) — Effort level passed to the interactive `claude` as an explicit `--effort` flag: `low` (default), `medium`, `high`, `xhigh`, `max`, or `inherit` to omit the flag (the pre-flag behaviour: the pane inherits a HOME-dependent effort — the operator's `~/.claude/settings.json` `effortLevel` in real-home mode, claude's built-in default in env-token scratch mode). Explicit `low` cuts measured TTFT p50 by ~40% and collapses run-to-run variance ~15× versus an inherited `xhigh` (see [`plans/2026-07-13-tui-latency/`](plans/2026-07-13-tui-latency/)); proxied requests rarely benefit from extended thinking. Banner-verified to stay on the subscription pool (`· Claude Max`). An invalid value logs a warning and falls back to `low`.
- **`OCP_TUI_HOME`** (default *(auto)*) — `HOME` claude runs under. **When unset, OCP picks it for you:** if `CLAUDE_CODE_OAUTH_TOKEN` is set → a **credential-isolated** scratch home `$HOME/.ocp-tui/home` (no `credentials.json`, env-token auth — **recommended**); if no env token → the operator's real home (legacy shared `credentials.json`). Setting this to an **explicit** path overrides the auto-default. The credential handling at that path still follows the env token: **with** the env token it is credential-free (env-token auth, no `credentials.json` written); **without** the env token (and the path ≠ real home) it uses the legacy symlinked-credentials scratch mode, which carries the credential-fork caveat — see ADR 0007. If you previously set this to the real home (or any home containing a `credentials.json`) and hit a permanent 401, unset it — see [Troubleshooting § the permanent TUI-mode 401](troubleshooting.md#tui-401).
- **`CLAUDE_TUI_WALLCLOCK_MS`** (default `120000`) — Maximum time in ms to wait for the native transcript to signal turn completion. Increase for long Opus thinking turns.
- **`OCP_TUI_CWD`** (default `$HOME/.ocp-tui/work`) — Scratch working directory where interactive claude sessions run. Transcripts land under `<HOME>/.claude/projects/<encoded-cwd>/`. Created automatically.
- **`CLAUDE_CODE_OAUTH_TOKEN`** — the recommended TUI credential; when set (and `OCP_TUI_HOME` unset) it selects the credential-isolated home. Full precedence and the 401 root cause it prevents are in [Troubleshooting § the permanent TUI-mode 401](troubleshooting.md#tui-401).
