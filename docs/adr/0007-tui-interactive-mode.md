# ADR 0007 — TUI Interactive Mode (subscription-pool bridge)

**Date:** 2026-05-31
**Status:** Accepted — amended by PR-4 (entrypoint hardening), PR-B (observability + concurrency), PR-C (env-token auth + defunct-reaping), PR-D (credential-isolated home — corrects PR-C)
**Deciders:** project maintainer
**Authority:** claude CLI v2.1.158 interactive mode — verified live on the test host that sessions launched without `-p` / `--output-format` carry `cc_entrypoint=cli` (subscription pool), not `cc_entrypoint=sdk-cli` (Agent SDK credit pool). Mechanism verified on cli.js v2.1.104; live-confirmed on v2.1.158.

---

## Context

On 2026-05-14 Anthropic announced (effective 2026-06-15) a billing split that routes requests by `cc_entrypoint`:

| `cc_entrypoint` value | Billing pool |
|-----------------------|-------------|
| `cli` | Pro/Max subscription pool |
| `sdk-cli` | Agent SDK credit pool (~$20/mo on Pro = easily exhausted) |

OCP's existing path (`claude --output-format stream-json -p`) sets `cc_entrypoint=sdk-cli`. After 2026-06-15 every OCP request will draw from the Agent SDK pool rather than the subscription.

The structural response: add an opt-in mode that drives a real **interactive** `claude` session (no `-p`, no `--output-format`), which carries `cc_entrypoint=cli` and therefore bills against the subscription. The response text is read from claude's native JSONL transcript instead of from `stdout`.

This is a personal-use A-path feature (single-user, single-subscription host). It is **not** a multi-tenant isolation layer.

### Source-verified entrypoint mechanism (PR-4 amendment)

Claude CLI's `main()` calls a startup function (`t$A` in the compiled bundle) that sets
`process.env.CLAUDE_CODE_ENTRYPOINT` **only if unset** to:

```
(argv has -p/--print/--init-only/--sdk-url  OR  !process.stdout.isTTY) ? "sdk-cli" : "cli"
```

The billing header reads `cc_entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "unknown"`.
The `"unknown"` branch is dead code for any real `main()` spawn — the startup function always
sets a value on unset env. The **real risk** is not `"unknown"`: it is a **lost TTY** (e.g. stdout
redirected or a non-PTY spawn) silently flipping the self-classification to `"sdk-cli"` and
drawing from the metered pool.

`cc_entrypoint` is one of ~6 upstream run-mode signals. The **dominant discriminator** is the
system-prompt identity block ("official CLI" vs "Claude Agent SDK"), which is driven by genuine
interactivity (no `-p`, no `--output-format`, real PTY) and is overridable by no env var. This
is the real reason the tmux/no-`-p` approach works: the spawn is genuinely interactive, not just
labelled as such.

---

## Decision

Add `CLAUDE_TUI_MODE=true` as an opt-in flag in `server.mjs`.

### How it works

1. Each request spawns a fresh tmux session running `claude --model <M> --session-id <UUID> --strict-mcp-config --disallowedTools 'mcp__*'` (no `-p`, no `--output-format`).
2. The spawn result is checked immediately: if `tmux new-session` returns a non-zero exit status (or a falsy result), the request is aborted with `tui_spawn_failed: tmux session not created` **before** the boot sleep. This is the spawn/PTY gate — OCP must not issue a billing request without a verified interactive session.
3. The serialized prompt (from `messagesToPrompt`) is pasted via `tmux send-keys … "$(cat file)"` + a separate `Enter` key event.
4. The answer is read from claude's native JSONL transcript at `<HOME>/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, polling until a `turn_duration` system event or the wall-clock cap (`CLAUDE_TUI_WALLCLOCK_MS`, default 120 s).
5. The string answer is returned to OCP's existing downstream (singleflight → cache write-back → `completionResponse` / `streamStringAsSSE`) — **same contract as `callClaude`**.
6. Streaming requests are buffered then replayed as chunked SSE (no real token streaming — deliberate; "don't build fragile features"). **Superseded for `stream:true` when `OCP_TUI_STREAM=1` — see the 2026-07-13 amendment below. The buffered path remains the default and is unchanged.**

### Billing-classifier labeling (`OCP_TUI_ENTRYPOINT`, PR-4)

`CLAUDE_CODE_ENTRYPOINT` on the spawn env is managed by `resolveTuiEntrypointEnv(env, mode)`
(exported from `lib/tui/session.mjs`, pure, testable). The function **always deletes any
inherited value first** so a stray env var from OCP's own parent process can never leak in and
mislabel the billing header. Then:

| `OCP_TUI_ENTRYPOINT` | Behaviour |
|----------------------|-----------|
| `cli` (default) | Sets `CLAUDE_CODE_ENTRYPOINT=cli` deterministically — subscription-pool classification. **Honest only because the spawn is a genuine interactive PTY** (tmux pane, no `-p`, stdout not redirected, `new-session` verified). |
| `auto` | Deletes the key → claude self-classifies via `t$A` (TTY → `cli`). Use to observe/diagnose the real TTY-derived value. |
| `off` | Leaves the env exactly as inherited — diagnostics / honesty audit only. |

**Governing rule (verbatim):** *OCP may make a true value deterministic; it may never assert a
value the spawn's real state contradicts. When it cannot make the claim true (e.g. cannot
guarantee a PTY), it fails/drops the request — it does not force the signal.*

This is why the spawn/PTY gate (step 2 above) is load-bearing for `mode="cli"`: if `new-session`
fails, there is no PTY, so asserting `cli` would be dishonest. Abort rather than lie.

OCP never suppresses the billing header (anti-fingerprinting: we do not mask the spawn).

### 2026-06-15 verification protocol

Run one quiesced canary request in TUI-mode and watch the **Agent SDK credit balance** (not the
request header). If the balance drops, the subscription pool is unreachable via spawn. Per the
constitution (`ALIGNMENT.md`), the response is to **drop the Anthropic provider** rather than
escalate spoofing.

Version caveat: mechanism verified on cli.js v2.1.104 + live on v2.1.158. Re-verify after any
major cli.js upgrade.

### Default behaviour is unchanged

When `CLAUDE_TUI_MODE` is unset (the default), no code path touches `callClaudeTui` or `runTuiTurn`. `upstreamCall === callClaude` and streaming uses `callClaudeStreaming` — byte-for-byte identical to the pre-TUI code path.

### Kill-switch

Unset `CLAUDE_TUI_MODE` (or set it to any value other than `"true"`) → stream-json path restored immediately on next restart.

### Home strategy

> **Superseded by the PR-D amendment below for the env-token case.** As of PR-D, `TUI_HOME`
> is computed by `resolveTuiHome()`: when `CLAUDE_CODE_OAUTH_TOKEN` is set (and `OCP_TUI_HOME`
> is unset) the default is a **credential-free scratch home**, not the real home. The
> descriptions below remain accurate for the **no-env-token** case and the **explicit
> `OCP_TUI_HOME` override** case.

- **Real-home (default when NO env token, `OCP_TUI_HOME` unset):** claude runs with the operator's own `~/.claude/` — shared credentials, existing onboarding, no OAuth fork risk. `ensureTuiCwdTrusted` seeds the trust record for the scratch cwd in the real `~/.claude.json` (atomic write).
- **Scratch-home opt-in (`OCP_TUI_HOME=<path>`, no env token):** a dedicated `HOME` that symlinks `~/.claude/.credentials.json` from the real home (token is never copied) and seeds a stripped `~/.claude.json` (no project history, trusts only the scratch cwd). **Caveat:** claude rewrites `.credentials.json` on OAuth token refresh, replacing the symlink with a regular file — this forks the credentials. Use this legacy symlink mode only with a dedicated OAuth or for ephemeral testing. (The PR-D env-token mode avoids this caveat entirely — no credentials file to fork.)

### Working directory

`TUI_CWD = OCP_TUI_CWD || $HOME/.ocp-tui/work` (dedicated scratch cwd). Transcripts land under `<HOME>/.claude/projects/<encoded-cwd>/` — a stable, single location separate from the operator's real project histories. The directory is created automatically on first request.

### MCP hard-disable

`--strict-mcp-config` (no `--mcp-config` argument) prevents account-attached managed MCP servers from connecting. Belt-and-braces: `--disallowedTools 'mcp__*'` blocks any MCP tool invocation even if a server were somehow loaded. Built-in tools (Bash, Read, etc.) are left enabled on the A-path (single-user, acceptable).

### Session namespace

All tmux sessions use the prefix `ocp-tui-`. The prefix-scoped reaper (`reapStaleTuiSessions`) kills only `ocp-tui-*` sessions, never `olp-tui-*` or any other prefix. A stale-session cleanup runs once at OCP boot when `TUI_MODE` is on.

---

## SECURITY — PROMINENT WARNING

**TUI-mode is SINGLE-USER / SINGLE-OPERATOR ONLY.**

`claude` runs as the OCP process owner with full filesystem access regardless of `HOME` setting. Home selection is **not** user isolation. If OCP is serving multiple users or guest API keys:

- A guest prompt would run `claude` with the **operator's** filesystem access.
- An adversarial prompt could exfiltrate files, run shell commands, or exhaust the subscription.

**Never enable `CLAUDE_TUI_MODE=true` on an OCP instance that serves untrusted callers or multiple users.**

The B-path (multi-tenant isolation) requires:
1. `--tools ""` (no built-in tools)
2. Per-key ephemeral `HOME` (isolated credentials + no cross-key project pollution)
3. Sandbox runtime (e.g. `@anthropic-ai/sandbox-runtime`)

B-path is **deferred** and is not implemented in this ADR. Until B-path lands, TUI-mode must only be enabled on a personal single-user OCP.

---

## Observability and concurrency (PR-B amendment)

**Date:** 2026-06-10
**Status:** Accepted — amends ADR 0007.
**Motivation:** the post-PR-A code audit, findings C-4 (P1) and C-5 (P1).

### C-4 — independent concurrency bound for the TUI path

The global `MAX_CONCURRENT` gate lives in `spawnClaudeProcess()` (the `-p` / stream-json
path). `callClaudeTui()` never calls `spawnClaudeProcess` — it calls `runTuiTurn()`, which
cold-boots a full interactive `claude` inside a fresh tmux session. So the TUI path had **no**
concurrency bound: N concurrent TUI requests spawned N simultaneous cold-boot tmux+claude
processes. On a small host (e.g. a Pi 4 serving a family) a burst of ~5 is an OOM risk and
also multiplies subscription rate-limit pressure.

PR-B adds an **independent** limiter for the TUI path (`lib/tui/semaphore.mjs`,
`TuiSemaphore`):

- **`OCP_TUI_MAX_CONCURRENT`, default `2`.** Rationale: a TUI turn is heavy — a per-request
  cold-boot of tmux+claude plus up to `CLAUDE_TUI_WALLCLOCK_MS` (120 s) of wallclock — so a
  small host cannot run many at once. `2` is the conservative default that keeps a Pi-class
  host alive under a family burst while still allowing some overlap. It is deliberately **not**
  the same knob as `MAX_CONCURRENT` (default 8): the two pools have different shapes (a
  stream-json spawn is cheap and fast; a TUI turn is a heavy cold-boot + long wallclock), so
  coupling them would mis-size one of the two paths.
- **Queue, don't reject.** The limiter **queues** (awaits a slot), mirroring the spirit of
  `MAX_CONCURRENT` — requests are not dropped on contention. To bound memory against a runaway
  client, the wait queue itself is capped (`maxQueue`, default 32× the limit); when the queue
  is full `run()` rejects with `tui_queue_full`, surfaced as a 503 — deterministic backpressure
  rather than silent OOM.
- **Slot released in a `finally`.** `TuiSemaphore.run(fn)` releases the slot in a `finally`, so
  any throw — PR-A's honesty gates (`tui_wallclock_truncated`, `tui_upstream_error`), a
  `tui_paste_not_landed`, or a `tui_spawn_failed` — can never leak a slot.

This limiter has **zero effect when `TUI_MODE` is off**: `callClaudeTui` is never reached, so
the semaphore is never entered. The default stream-json path is untouched.

### C-5 — operator-visible drift surface on `/health` (additive)

The `tui_entrypoint_mismatch` warning only reached journald. After the 2026-06-15 flip, a
silent `sdk-cli` drift (the documented top risk in this ADR — a lost TTY flipping the
self-classification to the metered Agent SDK pool) would drain metered credits **invisibly**.
PR-B adds a `tui` block to the `/health` JSON response so an operator can poll it:

```
tui: {
  enabled:              <TUI_MODE>,
  entrypointMode:       <OCP_TUI_ENTRYPOINT>,   // cli | auto | off
  lastEntrypoint:       <last observed cc_entrypoint, e.g. "cli", or null>,
  entrypointMismatches: <count of cli-expected-but-got-other turns>,
  inflight:             <current concurrent TUI turns>,
  queued:               <turns waiting for a slot>,
  maxConcurrent:        <OCP_TUI_MAX_CONCURRENT>
}
```

`lastEntrypoint` is recorded and `entrypointMismatches` incremented inside `callClaudeTui` in
the same mismatch branch that already emits the journald warning (via `recordTuiEntrypoint`).
`inflight` / `queued` / `maxConcurrent` come from the C-4 semaphore. When `TUI_MODE` is off the
block still appears with `enabled:false` (cheap, harmless) so the response shape is stable for
consumers regardless of mode.

### ALIGNMENT authorization for the `/health` change

`/health` is a **grandfathered B.2 endpoint** under ADR 0006, frozen at its v3.16.4 behaviour.
`ALIGNMENT.md`'s grandfather provision states: *"Any change to the contract (request shape,
response shape, semantics) of a grandfathered B.2 endpoint is treated as a new authorization
request and requires either a behaviour-preserving refactor PR or its own ADR."*

This amendment **is** that authorization. The argument:

- The change is **additive**: it adds one new top-level field (`tui`) containing only new
  sub-fields. **No existing `/health` field is changed, renamed, removed, or re-typed**, and no
  existing semantics change. Existing `/health` consumers (the dashboard, `ocp-connect`,
  monitoring) read the fields they already read and are unaffected — the change is
  **behaviour-preserving** for them, which is exactly the bar the grandfather provision sets for
  a non-ADR contract change.
- The TUI observability surface is an **intrinsic part of the TUI feature** whose authorizing
  authority is **this ADR (0007)**, not a brand-new B.2 endpoint. We are not adding a new B.2
  endpoint or a new method (which would each require their own fresh ADR under the New Class B
  endpoint procedure) — we are extending the response of an existing grandfathered endpoint with
  fields that report state owned by an ADR-0007 feature. ADR 0007 is the natural home for that
  authority, and this amendment records it explicitly.
- `cli.js` does not perform this operation — `/health` is OCP-owned (Class B), so no `cli.js`
  citation applies; the citation is this ADR + ADR 0006 (grandfathered B.2) per
  `ALIGNMENT.md`'s Class B citation requirement.

### `OCP_TUI_MAX_CONCURRENT` summary

| Env var | Default | Meaning |
|---|---|---|
| `OCP_TUI_MAX_CONCURRENT` | `2` | Max concurrent interactive TUI turns. Independent of `CLAUDE_MAX_CONCURRENT` (the stream-json path). Excess turns queue (bounded); a full queue yields a 503. |

---

## Authentication + defunct-reaping (PR-C amendment)

**Date:** 2026-06-13
**Status:** Accepted — amends ADR 0007.
**Motivation:** the PI231 production incident — TUI-mode returned `Please run /login · API Error: 401` for days; re-login never stuck.

### How the TUI `claude` authenticates

The spawned interactive `claude` obtains its OAuth bearer in one of two ways, in this order of preference:

1. **`CLAUDE_CODE_OAUTH_TOKEN` in env (PREFERRED).** If the env var is set on the OCP process, `buildTuiCmd` adds `CLAUDE_CODE_OAUTH_TOKEN=<shq-escaped token>` to the pane command's `env` prefix. claude then authenticates via this long-lived token and **never touches the credentials-refresh path**. This is the stable mode — it is exactly how the oracle and Mac-mini hosts already run (and how `server.mjs`'s own `getOAuthCredentials()` takes the same env at highest precedence). cli.js is **not** the authority here: this is a Class B, OCP-owned TUI spawn — see the Class B citation below.
2. **`<HOME>/.claude/.credentials.json` (FALLBACK).** When the env var is unset, claude falls back to the credentials file and its short-lived access token, renewing via the single-use refresh token.

The token MUST be set explicitly in `buildTuiCmd` because **tmux does not forward the parent process's environment to the pane** (verified live 2026-06-01 — the same reason the whole env is delivered as an `env` prefix). A token sitting in the OCP process env is invisible to the pane unless `buildTuiCmd` re-emits it.

### Why the fallback path corrupts (the PI231 incident)

When the env token is absent, every per-request spawn drives claude through the credentials.json refresh path. OAuth refresh tokens are **single-use / rotating**: a refresh consumes the old refresh token and writes a new one. The per-request `kill-session` teardown can race / interrupt claude mid-rotation, and over many spawn+kill cycles the refresh token ended up an **empty string** — at which point renewal is impossible and the host returns a permanent 401. Re-login writes a fresh token, but the next spawn re-corrupts it. **Proof the env-token fix works:** on the broken PI231 host, `CLAUDE_CODE_OAUTH_TOKEN=<oat01 token> claude -p ...` returned a real answer *despite* the corrupt credentials.json (control without the env token = 401).

**Operator guidance:** set `CLAUDE_CODE_OAUTH_TOKEN` on any TUI-mode host. The credentials.json fallback is retained only for hosts that intentionally rely on it; it is not recommended for a long-running TUI deployment.

**Security note:** with the token in the pane command, it is visible in `ps`. This is acceptable for the **single-user A-path** (it mirrors the existing plaintext-token practice for `server.mjs`), and the **multi-user B-path is already refused at boot** (`CLAUDE_TUI_MODE=true` + `AUTH_MODE=multi` is a hard FATAL), so a guest can never reach this spawn.

### Defunct `<claude>` reaping

The connected leak: the pane's `claude` process is a child of the long-lived **tmux server** daemon, not of the OCP node process (`tmux new-session -d` returns the instant the server forks the pane). Node can therefore never `waitpid()`/reap it — a SIGKILL still needs the *parent* (the tmux server) to reap. `kill-session` destroys the session but leaves the pane's `claude` (and its grandchildren) as `<defunct>` zombies that only the server reaps; over 30 days on PI231 this accumulated to **25 defunct `<claude>`** (a live `tmux kill-server` dropped it 25→3).

The node-reachable action that *actually reaps* — rather than merely re-signalling — is to stop the tmux server: on server exit the kernel reparents survivors to init (PID 1), which reaps them. `reapStaleTuiSessions` therefore, after killing our own `ocp-tui-*` sessions, issues `kill-server` **only when no foreign session of any prefix remains** (coexistence: never disrupt a co-hosted `olp-tui-*` instance). This runs at boot (existing) and now on a 15-min periodic interval gated on TUI-mode and on the TUI path being idle (`inflight === 0 && queued === 0`) so a live turn's pane is never torn down. Residual: a request whose pane is created in the narrow window between the idle-check and `kill-server` would fail cleanly via the existing honesty gates (rare; documented in the server comment).

### ALIGNMENT authorization (Class B)

Both changes are **Class B** (OCP-owned TUI spawn). `cli.js` does not perform either operation — there is no `cli.js` analogue for "how the TUI pane authenticates" or "reaping tmux-server-owned zombies"; this surface is authorized by **this ADR (0007)** per `ALIGNMENT.md`'s Class B citation requirement. No Class A wire surface, no endpoint shape, no `alignment.yml` blacklist token, and no `models.json` entry is touched.

---

## Credential-isolated home for env-token auth (PR-D amendment)

**Date:** 2026-06-13
**Status:** Accepted — amends ADR 0007. **Corrects** the PR-C rationale and the original "Home strategy" section's scratch-home caveat.
**Motivation:** PR-C's env-token passing alone did **not** fix the PI231 401. Decisive live evidence (claude 2.1.104, PI231):

| Condition | Result |
|---|---|
| env token passed + a broken `~/.claude/.credentials.json` present | **401** (`Please run /login · API Error: 401`) |
| env token passed + `credentials.json` moved aside | **works** (real answer) |

### Corrected root cause

**Interactive `claude` PREFERS `~/.claude/.credentials.json` over the `CLAUDE_CODE_OAUTH_TOKEN` env var.** A stale/corrupt `credentials.json` therefore **shadows** the env token. (This is *unlike* `-p` mode, where the env token wins — which is why `server.mjs`'s own `getOAuthCredentials()` is unaffected and why PR-C's premise looked sufficient.) So passing the token (PR-C, `buildTuiCmd`) is **necessary but insufficient**: the TUI `claude` must additionally run in a HOME that has **no `credentials.json`**, so the env token is the only credential and is authoritative.

This also fixes the original incident at the **root**, more completely than PR-C claimed: with no `credentials.json` in the home, claude never runs the token-refresh path at all, so the single-use refresh token can never be rotated — and therefore never corrupted — by the spawn+`kill-session` cycle. The 25-zombie / empty-refresh-token failure mode becomes structurally impossible, not merely avoided.

### Decision

When `CLAUDE_CODE_OAUTH_TOKEN` is set, the TUI `claude` runs in a **credential-free scratch home** by default:

- `resolveTuiHome({ realHome, configuredHome, envTokenSet })` (exported from `lib/tui/session.mjs`, pure) decides the home:
  - **`OCP_TUI_HOME` set** → that path (explicit override, back-compat — an operator who configured it keeps exactly that home).
  - **else env token set** → `<realHome>/.ocp-tui/home` — a dedicated scratch home seeded with a minimal `.claude.json` (`hasCompletedOnboarding=true` + trust **only** the scratch cwd) and its own `projects/` dir, and **deliberately NO `.credentials.json`** (no symlink, no copy).
  - **else (no env token)** → the operator's real home — **byte-for-byte the pre-fix behaviour** for hosts that intentionally rely on `credentials.json`.
- `prepareTuiHome(realHome, tuiHome, cwd, { envTokenMode })` gates the credential handling: in `envTokenMode` it creates the scratch `projects/` dir and seeds the minimal trusted `.claude.json` but **never** creates the credentials symlink. `runTuiTurn` sets `envTokenMode = !!CLAUDE_CODE_OAUTH_TOKEN && ehome !== realHome`.
- `readTuiTranscript` reads from the **same** home claude runs under (`ehome`), so transcripts land under `<scratch home>/.claude/projects/` and `findTranscriptPath` globs them there — the home is threaded through consistently. (We chose scratch-`HOME` over `CLAUDE_CONFIG_DIR`: the binary supports `CLAUDE_CONFIG_DIR`, but it relocates the transcript root to `<CONFIG_DIR>/projects/` rather than `<HOME>/.claude/projects/`, which would fork the transcript-resolution rule across modes for no benefit. The scratch-HOME lever reuses the existing, tested `prepareTuiHome`/`ehome` plumbing.)

### This RESOLVES — not reintroduces — the scratch-home caveat

The original "Home strategy" section and PR-C's `prepareTuiHome` comment warned that scratch-home is unsafe because *claude rewrites a **symlinked** `.credentials.json` on token refresh → forks/corrupts the OAuth credentials*. **That caveat does not apply to env-token mode**: there is no `credentials.json` in the home to fork, and claude never refreshes (it uses the long-lived env token), so there is no rotation and no corruption. The fork risk was inherent to the *symlink* approach; removing the credentials file entirely removes the risk. The legacy symlink mode is retained **only** for an operator who explicitly sets `OCP_TUI_HOME` without an env token, and its caveat is preserved for exactly that path.

### ALIGNMENT authorization (Class B)

**Class B** (OCP-owned TUI spawn). `cli.js` has no analogue for the TUI pane's auth/home strategy; authorized by **this ADR (0007)** per `ALIGNMENT.md`'s Class B citation requirement. `server.mjs` is touched only to compute `TUI_HOME` via `resolveTuiHome()` (TUI wiring) and to surface the auth mode in the boot log — no Class A wire surface, no endpoint shape, no `alignment.yml` blacklist token, and no `models.json` entry is touched.

---

## Consequences

### Positive

- After 2026-06-15, requests in TUI-mode bill against the Pro/Max subscription pool (`cc_entrypoint=cli`) rather than the Agent SDK credit pool.
- Kill-switch is immediate (unset env var + restart); zero code change required.
- Default stream-json path is untouched — no regression risk for existing deployments.

### Negative / trade-offs

- **No token streaming:** responses are buffered then replayed as chunked SSE. Clients see a delay then the full response arrives; real-time token streaming is not available in TUI-mode.
- **Billing unmeasurable until 2026-06-15:** the `cc_entrypoint=cli` signal is verified, but the credit deduction from the correct pool cannot be confirmed until the billing split activates.
- **tmux dependency:** the host must have `tmux` installed. CI / Docker images that lack tmux cannot use TUI-mode (the default stream-json path is unaffected).
- **Wall-clock cap:** long Opus thinking turns may hit the 120 s cap. Increase `CLAUDE_TUI_WALLCLOCK_MS` if needed (no quiescence heuristic — the reader polls until terminal marker or cap).
- **Grey-area usage:** running an interactive `claude` session headlessly to serve HTTP requests is not an officially documented use case. If Anthropic policy changes to block this pattern, OCP must fall back to the stream-json path (unset `CLAUDE_TUI_MODE`).

### Coexistence

- tmux prefix `ocp-tui-` is registered. Any co-hosted OLP test instance must use `olp-tui-`. Never run two TUI proxies on the same OAuth concurrently — stop one instance during integration testing.

---

## Amendment (2026-07-13) — real SSE streaming via the `MessageDisplay` hook (`OCP_TUI_STREAM`)

**Supersedes**: Request-flow step 6 above ("no real token streaming — deliberate"), for `stream:true`
requests when `OCP_TUI_STREAM=1`. The buffered path stays the default and is byte-for-byte unchanged.

**Context.** Step 6 was written when the interactive CLI appeared to expose no byte-faithful
incremental source. A prereq spike (`docs/plans/2026-07-13-tui-latency/streaming-spike.md`) confirmed
three obvious sources are dead ends — the transcript JSONL grows one *whole event* at a time (the
answer lands as a single line ~0.3 s before the terminal marker); `tmux capture-pane` yields a
*rendered* view whose markdown source is unrecoverable (an H2 and a bold span produce identical ANSI);
`--debug-file` logs stream *timing*, never stream *content*. Every interface that does emit
`text_delta` (`--output-format stream-json`) requires `-p`, which moves the request to the **metered**
`sdk-cli` pool — precisely what TUI-mode exists to avoid.

**Decision.** Consume `claude`'s own **`MessageDisplay`** hook, registered via `--settings` on the
ordinary interactive spawn (no `-p`, no `--bare`). Each fire delivers the **raw markdown source** of an
incremental `delta` on the hook's stdin. Verified live (claude 2.1.207, sonnet-4-6): banner stays
`· Claude Max` and the transcript `entrypoint` stays `cli` (subscription pool); `concat(deltas) === T`
byte-exactly; `T.startsWith(concat(deltas[0..n]))` at every *n*. This is **forwarding, not inventing**
— ALIGNMENT.md **Class B**. No `cli.js` citation applies: the TUI spawn is OCP-owned surface (this
ADR), the hook payload is claude's own published contract, and the SSE wire shapes are the OpenAI
chat/completions streaming spec adopted by **ADR 0006** (the emitters are literally the `-p` path's).

**The transcript remains authoritative.** It is still the terminal-turn signal, still the source of the
returned/cached text `T`, and still the input to the honesty gates (auth-banner detection C-1,
`truncated` C-2). The delta stream is a low-latency **mirror**, never a replacement. At end of turn OCP
asserts the streamed bytes against `T`: equal → serve; a strict *prefix* of `T` → top up from the
transcript (client still receives exactly `T`); **not** a prefix → **refuse the turn** (SSE error frame,
no cache, `tui.streamDivergences++`). Serving text the transcript disagrees with is the failure class
ALIGNMENT.md exists to prevent, so streaming fails loud rather than degrading quietly.

**Consequences / constraints recorded for future authors:**

- **Opt-in, default OFF.** The buffered path is stable production; streaming does not change it.
- **Per-`session_id` sink is mandatory, not an optimization.** `OCP_TUI_MAX_CONCURRENT` defaults to
  **2** — two `claude` panes already run concurrently. A single shared sink would interleave one
  client's deltas into another's stream. The hook writes to `<dir>/<session_id>.jsonl`, the path
  delivered through the *pane's own env* (`OCP_TUI_STREAM_FILE`); OCP reads only its own turn's file.
  Verified with two concurrent streamed turns (ALPHA/BRAVO): zero cross-contamination.
- **Warm-pool compatible (a separate in-flight PR depends on this).** The hook script and the settings
  file are **static** — nothing request-specific is baked in at spawn time. The sink path derives from
  the session-id, which for a pre-booted pane is fixed at boot.
- **The hook is synchronous** (`forceSyncExecution: true` — `claude` *blocks* on it). The hook script
  must write and exit; it does one `cat` append and nothing else. Measured: p50 **7.2 ms** per fire,
  ~50 ms across a whole turn — noise against a 6–10 s turn. Do not add work to it.
- **Thinking blocks do not fire the hook** — verified on a substantive Opus/`xhigh` reasoning turn (see
  the PR evidence), not merely inferred from the `final:true` call site. This must be **re-verified** if
  the hook is ever pointed at a new model/effort tier: a thinking delta reaching a client would be
  unretractable, and the `concat === T` assertion can only *detect* that after the fact, never prevent
  it. The first-bytes **holdback** (`OCP_TUI_STREAM_HOLDBACK`, default 100 chars) is the same
  prevention-not-detection reasoning applied to the auth-banner gate.
- **Block-level granularity**, scaling with answer length — not token-level. Do not promise otherwise.
- **It moves the first byte, not the last.** Only a progressively-rendering consumer benefits; it does
  not move TUI-mode's ~6 s TTFT floor.

## Provenance

TUI-mode originated in a prototype contributed via PR #101 (see the PR for author attribution). The productionization design is in `docs/superpowers/specs/2026-05-30-tui-mode-production-design.md`. Spikes S1–S6 / T1–T6 were validated live on the test host against `claude v2.1.158`.
