# ADR 0007 — TUI Interactive Mode (subscription-pool bridge)

**Date:** 2026-05-31
**Status:** Accepted — amended by PR-4 (entrypoint hardening)
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
6. Streaming requests are buffered then replayed as chunked SSE (no real token streaming — deliberate; "don't build fragile features").

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

### Home strategy (real-home default)

`TUI_HOME = OCP_TUI_HOME || HOME` (defaults to the operator's real home).

- **Real-home (default, `OCP_TUI_HOME` unset):** claude runs with the operator's own `~/.claude/` — shared credentials, existing onboarding, no OAuth fork risk. `ensureTuiCwdTrusted` seeds the trust record for the scratch cwd in the real `~/.claude.json` (atomic write).
- **Scratch-home opt-in (`OCP_TUI_HOME=<path>`):** a dedicated `HOME` that symlinks `~/.claude/.credentials.json` from the real home (token is never copied) and seeds a stripped `~/.claude.json` (no project history, trusts only the scratch cwd). **Caveat:** claude rewrites `.credentials.json` on OAuth token refresh, replacing the symlink with a regular file — this forks the credentials. Use scratch-home only with a dedicated OAuth or for ephemeral testing.

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

## Provenance

TUI-mode originated in a prototype contributed via PR #101 (see the PR for author attribution). The productionization design is in `docs/superpowers/specs/2026-05-30-tui-mode-production-design.md`. Spikes S1–S6 / T1–T6 were validated live on the test host against `claude v2.1.158`.
