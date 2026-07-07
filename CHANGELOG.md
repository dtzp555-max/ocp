# Changelog

## v3.21.1 — 2026-07-07

Patch release: three bug fixes from an independent concurrency/session-lifecycle audit, each its own PR with a fresh-context reviewer (Iron Rule 10). No new `cli.js` wire behavior, no new endpoint, header, or env var; the `/health` field set is unchanged (only value truthfulness improved).

### Fixed

- **TUI session-scope / boot-reap (#148)** — `lib/tui/session.mjs`'s tmux session prefix is now scoped per-instance by listen port (`ocp-tui-<port>-`) instead of a bare host-wide `ocp-tui-` constant, so a second OCP instance on the same host (e.g. a temporary verification instance) can no longer have its live TUI sessions reaped or `kill-server`'d by another instance's boot/periodic sweep. The one-time boot reap also claims exact-shape legacy `ocp-tui-<8hex>` sessions (pre-fix naming) once, to clean up zombies left behind across an in-place upgrade.
- **`-p` spawn-token mutex + keychain caching (#150)** — the real-HOME token fallback used when the keychain token is within its 5-minute expiry window is now serialized behind a mutex, so concurrent `-p` spawns no longer race the same single-use refresh token against each other (the credential-fork hazard). Added a 30s TTL cache + last-good-label memoization for the keychain read, cutting per-spawn event-loop blocking. The isolation decision (`/health` isolated/real-home reporting) is now re-evaluated per spawn instead of memoized forever, so `/health` no longer misreports a stale decision. New module `lib/spawn-auth.mjs` extracts the pure, unit-testable primitives (mutex, TTL cache, expiry gate, label ordering).
- **Concurrency queue / disconnect handling (#149)** — the shared semaphore now honors a runtime-lowered `maxConcurrent` immediately (previously a decrease was silently ignored until in-flight tasks finished on their own) and wakes queued waiters right away when the limit is raised. Queued `-p`/TUI requests are now linked to the client's HTTP connection via `AbortSignal`; a client that disconnects while queued is spliced out of the queue instead of still spawning `claude` once a slot frees. A singleflight follower whose leader disconnected now retries instead of inheriting a spurious 500, and a queued-then-disconnected request is no longer recorded as a usage failure or logged as an error (quiet disconnect handling).

## v3.21.0 — 2026-06-25

Cleanup + docs release: TUI dead-code removal, docs honesty, and release prep. No new `cli.js` wire behavior; the default path (`CLAUDE_TUI_MODE` unset) is byte-for-byte unchanged.

### TUI dead-code / footgun cleanup

- **A1 — removed inert entrypoint-env path** (`lib/tui/session.mjs`): deleted `resolveTuiEntrypointEnv()` and the redundant env-strip block in `runTuiTurn`. The `{env}` object passed to `spawnSync` (tmux itself) was the wrong target — tmux does NOT forward the spawning process's environment to the pane; the pane's `claude` gets its env exclusively from the `env` prefix string built inside `buildTuiCmd` (verified live 2026-06-01). The spawnSync env is now intentionally minimal (`HOME` only). Behavior is unchanged: `buildTuiCmd` already handled all claude-specific env vars via its prefix string.
- **A2 — removed test-only transcript helpers** (`lib/tui/transcript.mjs`): deleted `encodeCwd()` and `transcriptPath()` exports and the tests that pinned them. Production resolves transcripts exclusively via `findTranscriptPath()` (glob by session-id), which is immune to the exact path-encoding rule. No non-test importers existed (grep confirms). A `// TODO` comment near `findTranscriptPath()` notes that a CI fixture-contract test would make claude-schema drift fail loudly.
- **A3 — removed headless-unusable `--dangerously-skip-permissions` branch** (`lib/tui/session.mjs` + `README.md`): `OCP_TUI_FULL_TOOLS=1` now always takes the `--allowedTools` path. The removed branch pushed `--dangerously-skip-permissions` when `CLAUDE_SKIP_PERMISSIONS=true`; on claude v2.1.x this triggers an interactive bypass-acceptance screen that a headless tmux pane cannot answer → the turn hangs to the wallclock cap and bricks the pane. The working path is `--allowedTools` + scratch-home `settings.json` `additionalDirectories`. `CLAUDE_SKIP_PERMISSIONS` for the `-p` path is unchanged (still used in `server.mjs`).

### Docs

- **Client-tools boundary** (README `§ How It Works`): OCP is a text-prompt bridge only — it does not pass OpenAI `tools`/`functions` or Anthropic `tool_use` blocks to the client. Clients receive assistant TEXT only; client-local tool execution is not supported by design (bypassing `cli.js` = out of scope per `ALIGNMENT.md`).
- **ToS honesty** (README `§ Deployment model & security`): pooling one Claude subscription across multiple distinct people may violate Anthropic's Consumer ToS and risk account suspension by the abuse classifier. The defensible framing is "one person, your own devices" — friends/team sharing is not. The prior language ("account terms are your call") was accurate but understated the risk.
- **"Why OCP" posture** (README `§ Why OCP?`): new bullet making explicit that OCP drives the official `claude` CLI as-is — no OAuth token extraction, no binary patching, no protocol invention — so traffic looks like genuine Claude Code (`cc_entrypoint=cli`).
- **Promotion plan** (`docs/PROMOTION.md`): "stable & visible" strategy covering goal (polish + low-key OSS visibility, NOT growth-hacking given the live ToS/billing risk), pre-requisites (stability first), honest ToS disclosure requirement, items explicitly skipped (multi-backend routing → OLP; gateway model-discovery; raw API passthrough → ALIGNMENT.md scope), TUI toggle as billing-split insurance, and low-key visibility actions. Framed as a recommendation for the maintainer to review, not a committed plan.

### Previously shipped (v3.20.x) — documented here for completeness

- **Default `-p` spawn-home isolation** (v3.20.0 / PR-A): per-request `claude` spawns run in a credential-free minimal scratch HOME (`$HOME/.ocp/spawn-home`, no `.credentials.json`/`settings.json`/plugins) with a neutral cwd and the env token, cutting per-request latency (measured ~10–28s → ~3–7s). Kill-switch: `OCP_SPAWN_REAL_HOME=1`. Active mode shown at startup and on `/health.spawn`.
- **Bounded concurrency wait-queue** (v3.20.0 / PR-B): excess `-p` requests queue (up to `CLAUDE_MAX_QUEUE`, default 16) instead of being rejected; a full queue returns `HTTP 429` + `Retry-After` (not an opaque 500). New env vars: `CLAUDE_MAX_QUEUE`, `CLAUDE_QUEUE_RETRY_AFTER`. Surfaced on `/health.concurrency` + `/health.stats.queueRejections`.
- **`ocp restart`** macOS `bootout`+`bootstrap` (v3.20.0 / PR-B): safe restart command that forces launchd to re-read the plist (unlike `kickstart -k` which reuses the cached env).
- **`/ocp` plugin OpenClaw-2026.5.27 compat** (v3.20.0 / PR-C): gateway plugin updated for the current OpenClaw API version.

## v3.20.1 — 2026-06-13

TUI-mode auth hardening: fixes the recurring `Please run /login · API Error: 401` (the PI231 incident) and reaps leaked defunct `claude` sessions. ([#141](https://github.com/dtzp555-max/ocp/pull/141))

### Fixed

- **TUI 401 / credential corruption (#141)** — interactive `claude` prefers `~/.claude/.credentials.json` over the `CLAUDE_CODE_OAUTH_TOKEN` env var (unlike `-p` mode, where the env token wins). OCP TUI's per-request spawn + `kill-session` cycle raced claude's single-use refresh-token rotation, corrupting the refresh token to an empty string → permanent 401 that `claude /login` couldn't fix (each new spawn re-corrupted it). This bit Linux/file-based hosts specifically (macOS reads credentials from the Keychain, so Mac mini was immune). **Fix:** when `CLAUDE_CODE_OAUTH_TOKEN` is set, the TUI claude now runs in a credential-free scratch HOME (`<HOME>/.ocp-tui/home`, overridable by `OCP_TUI_HOME`) seeded with onboarding + cwd-trust but **no `.credentials.json`**, so the env token is the only credential and claude never runs the refresh path. Recurrence-proof — a later `claude login` can no longer break TUI. Also: `buildTuiCmd` passes `CLAUDE_CODE_OAUTH_TOKEN` to the spawn, and `reapStaleTuiSessions` reaps defunct `claude` sessions (tmux-server-owned zombies) via `kill-server` when no foreign session remains, plus a 15-min idle-gated periodic reap. When the env token is unset, behaviour is byte-for-byte unchanged (real-home + credentials.json). Two independent fresh-context reviewers (Iron Rule 10) + a live PI231 portability test (works with a corrupt credentials.json present). Authorized by the ADR 0007 PR-D amendment (Class B).

### Environment variables

- `CLAUDE_CODE_OAUTH_TOKEN` — when set on a TUI host, TUI authenticates via this long-lived token in a credential-isolated home (recommended; immune to credentials.json corruption).
- `OCP_TUI_HOME` — overrides the TUI scratch home; if you previously pointed it at your real home, unset it to get the credential-isolated default.

## v3.20.0 — 2026-06-10

TUI-mode billing-safety hardening for the 2026-06-15 Anthropic billing split. A 5-dimension multi-agent audit (adversarial verification + live tests on all three hosts — PI231 / Oracle / Mac mini, claude 2.1.104 / 2.1.114 / 2.1.170) found the TUI subscription-pool path could silently bill the metered Agent SDK pool or poison the cache under realistic failure modes. Three PRs, each with a fresh-context reviewer (Iron Rule 10) and CI; the default path (`CLAUDE_TUI_MODE` unset) is byte-for-byte unchanged.

### TUI — honesty & cache correctness (#137)

- **C-1** — `callClaudeTui` now throws on a claude-CLI auth-failure banner (e.g. `Please run /login · API Error: 401 …`, `Failed to authenticate. API Error: 401 …`) instead of returning it as a real answer, so it is never cached, singleflight-shared, or counted as a model success. Conservative detector (whole trimmed text ≤100 chars + `API Error: 4xx` + auth keyword + no code/quote char); overridable via `CLAUDE_TUI_ERROR_PATTERNS`. Live-reproduced on PI231.
- **C-2** — `readTuiTranscript` distinguishes a complete turn from a wallclock-truncated partial (`truncated` flag); `callClaudeTui` throws `tui_wallclock_truncated` so a partial is never cached or counted as success.
- **C-3** — `verifyEntrypoint` reads the `entrypoint` field from any transcript line, not just `{system, turn_duration}` — some claude builds emit zero turn_duration lines (live-confirmed on Oracle's claude 2.1.114), which previously left the billing-drift assertion blind on those builds.
- **C-4 (paste)** — short prompts (e.g. `hi`) could never pass paste-landing detection; threshold lowered. Live-reproduced on PI231.

### TUI — concurrency & observability (#139)

- **Concurrency** — `OCP_TUI_MAX_CONCURRENT` (default 2) bounds concurrent interactive `claude` boots via a queuing semaphore (`lib/tui/semaphore.mjs`); the slot is released on throw so honesty-gate / spawn failures never leak it; bounded wait-queue → `tui_queue_full` (503). Independent of the global `MAX_CONCURRENT` (8) — a TUI turn is a heavy per-request cold-boot of tmux+claude + up to 120s wallclock.
- **Observability** — additive `/health` `tui` block (`enabled` / `entrypointMode` / `lastEntrypoint` / `entrypointMismatches` / `inflight` / `maxConcurrent`) so an operator can poll for a silent `sdk-cli` metered-pool drift (the audit's top risk) instead of grepping journald. Authorized by the ADR 0007 PR-B amendment under the ALIGNMENT grandfather provision (additive, behaviour-preserving — every pre-existing `/health` field unchanged).

### Operations (#138)

- `docs/runbooks/615-canary.md` — the 2026-06-15 credit-balance canary: quiesce, read the Agent SDK credit balance (manual — no programmatic API exists for that pool; OCP's `/usage` headers are subscription rate-limit data, not the credit pool), one TUI canary turn, confirm `entrypoint:cli` in the transcript, green/red decision tree, periodic auto-mode self-classification mini-canary.
- `docs/runbooks/tui-flip-rollback.md` — flip/rollback per deployment (systemd `daemon-reload`; launchd `bootout`/`bootstrap`, not `kickstart -k`).
- `setup.mjs` auth quick-test gated behind `OCP_SKIP_AUTH_TEST=1` (the `claude -p` probe draws from the metered Agent SDK pool after 6/15).

### New environment variables

- `OCP_TUI_MAX_CONCURRENT` — max concurrent interactive TUI turns (default 2) (#139).
- `OCP_SKIP_AUTH_TEST` — skip the `claude -p` auth probe in `setup.mjs` (default off) (#138).

## v3.19.0 — 2026-06-02

TUI-mode reliability + proxy-purity release. Two fixes diagnosed and verified live on both test hosts (PI231 / Oracle, claude 2.1.104 / 2.1.114), each its own PR with a fresh-context reviewer (Iron Rule 10), then an adversarial multi-host test battery (0 hangs / 0 crashes / 0 injection / 0 leaks). The default path (`CLAUDE_TUI_MODE` unset) is byte-for-byte unchanged.

### TUI

- **#130** — Fixed the "stuck typing" hang on large multi-line prompts. Three root causes: (1) terminal-turn detection only recognized `{system, turn_duration}`, which older claude builds (e.g. 2.1.114) don't emit → the reader ran to the wallclock and returned partial text; now also accepts an `assistant` line with a final `stop_reason` (`end_turn`/`stop_sequence`/`max_tokens`), while `tool_use` stays non-terminal. (2) Large prompts pasted via `send-keys -l` delivered embedded newlines as separate Enter events → the prompt never landed; now uses `tmux load-buffer` + `paste-buffer -p` (bracketed paste, atomic). (3) The paste-landed check false-positived on claude's empty curly-quote placeholder → Enter fired into an empty box; now positive-signal-only (`[Pasted text]` / prompt text) with a readiness/paste-verify poll + fast-fail (deterministic ~5s error instead of a 120s wallclock hang).
- **#4** — TUI-mode never injects the host's `CLAUDE.md` / auto-memory into proxied turns. OCP is a proxy: the proxied client (OpenClaw / an IDE) owns its own context and memory. `buildTuiCmd` now always sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (unconditional — proxy purity is not an opt-in). Verified live with a marker `CLAUDE.md`: obeyed by the proxied turn before the fix, blocked after, on both hosts. Residual host-context vectors (managed-policy / `settings.json` / output-styles) tracked in #133. The env is delivered via an `env`-prefix on the tmux pane command (tmux does not forward the spawning process's environment, and `new-session -e` requires tmux ≥3.2 while the cloud host runs 2.7).

## v3.18.0 — 2026-06-01

Hardening release from a multi-agent code audit (1 P0 + 14 P2 + 2 P3 findings, each adversarially verified and independently reviewed) plus three follow-ups (#123–#125). Every change shipped as its own PR with a fresh-context reviewer (Iron Rule 10). The single-user default path (`AUTH_MODE=none`, no TUI) is behavior-identical **except** the `/health` change in #109.

### Security

- **#109 (P0)** — `/health` no longer advertises `PROXY_ANONYMOUS_KEY` to remote callers by default. The `anonymousKey` field is gated behind a new `PROXY_ADVERTISE_ANON_KEY=1` opt-in env var; localhost callers are always exempt. Prevents any LAN-reachable device from harvesting a working, quota-spending bearer credential from the unauthenticated `/health` endpoint. **Behavior change:** `ocp-connect` zero-config Path A now requires the server to set `PROXY_ADVERTISE_ANON_KEY=1`; otherwise pass `--key` or use anonymous access.
- **#114** — Dashboard escapes all DB-sourced strings (key names, usage rows) before `innerHTML`; the revoke button uses a `data-` attribute + listener instead of an inline `onclick` a quote could break out of; `POST /api/keys` validates key names server-side (`[A-Za-z0-9 ._-]{1,64}`).
- **#124** — Dashboard status/plan summary cards escaped too (uniform defense-in-depth over all `innerHTML` sinks).
- **#111** — Streaming error paths strip filesystem paths from claude error text / stderr before sending them to clients (`sanitizeError`), matching the non-streaming path.

### Reliability / correctness

- **#110** — Non-array `messages` is rejected with a 400 (was silently hanging the connection until socket timeout); OpenAI array `content` is flattened into the prompt instead of dumped as raw JSON; a streamed upstream error now emits an SSE `error` frame instead of a success-looking `finish_reason:"stop"`.
- **#111** — `res.on("close")` escalates SIGTERM→SIGKILL on client disconnect (closes a narrow re-occurrence of the #37 concurrency-slot leak on the hottest exit path); `overallTimer` is cleared on semantic completion so a slow-exiting child can't record a spurious post-success timeout; per-key quota is documented as best-effort (bounded overshoot ≤ `MAX_CONCURRENT`, cache hits uncounted).
- **#113** — CLI/installer hardening: `ocp-plugin` restart uses the live uid + `dev.ocp.proxy`/`ocp-proxy` labels and drops the unsafe `pkill` fallback; `ocp-connect` quotes + `chmod 600`s the persisted key; `setup.mjs` XML-escapes and newline-validates injected service-unit secrets.

### Alignment / governance

- **#112** — OAuth token-refresh host (`platform.claude.com/v1/oauth/token`) re-verified against the compiled cli.js v2.1.154 (`strings`, no live probe) and recorded in `ALIGNMENT.md`; usage-probe and default request model now derive from `models.json` (ADR 0003 SPOT) instead of hardcoded IDs.
- **#123** — The legacy `console.anthropic.com/v1/oauth/token` host is pinned in the `alignment.yml` blacklist so a future OAuth-host drift hard-fails CI; the blacklist now documents its dual purpose (known hallucinations + pinned wrong-host variants of a verified Class A endpoint).

### TUI

- **#115** — The TUI LAN gate refuses any non-loopback bind (not just literal `0.0.0.0`); the achieved `cc_entrypoint` is asserted each turn and a `tui_entrypoint_mismatch` warning is logged on a silent degrade to the metered sdk-cli pool.

### Refactor

- **#125** — `isLoopbackBind` extracted to `lib/net.mjs`, shared by `server.mjs` and the test suite (was duplicated via a copy-paste mirror).

### New environment variables

- `PROXY_ADVERTISE_ANON_KEY` — opt-in (default off); advertise `PROXY_ANONYMOUS_KEY` on the public `/health` body for remote zero-config discovery (#109).

## v3.17.1 — 2026-05-31

### Fix — code-audit P1/P2 hardening

Fixes from a multi-agent code audit (3 P1 + 5 P2, adversarially verified). The single-user default path (`AUTH_MODE=none`, no TUI) is behavior-identical.

**Availability / correctness (P1):**
- Guard `proc.stdin` against EPIPE — a fast-failing spawned `claude` (auth error, bad model, large prompt) no longer crashes the single-process daemon.
- Add `unhandledRejection`/`uncaughtException`/`clientError` safety nets + wrap all request-body read loops — a client aborting mid-upload no longer crashes the daemon.
- TUI transcript reader: only `turn_duration` is terminal (was also `tool_use`), which silently truncated any TUI turn that used a built-in tool.

**Security gates / cache integrity (P2):**
- `AUTH_MODE=multi`: the default spawn now passes `--disallowedTools` (Bash/Read/Write/Edit/…) so a guest prompt cannot drive operator-filesystem tools. Single-user path unchanged.
- `/sessions` (DELETE), `/settings` (PATCH), `/logs`, `/usage`, `/status` are now admin-gated (were dispatched before the admin check).
- Streaming path no longer caches an `is_error` response as success (cache-poisoning fix).
- TUI fail-loud guard extended to `none`+`0.0.0.0` (unless `OCP_TUI_ALLOW_LAN=1`) and `+ PROXY_ANONYMOUS_KEY`.
- TUI `send-keys` paste uses `-l` (literal) so a prompt equal to a tmux key token (e.g. `C-c`) is typed, not interpreted.

---

## v3.17.0 — 2026-05-31

### Provider — default claude invocation ported to stream-json + `--system-prompt` (Phase 6c)

OCP's default (non-TUI) claude spawn moves from `claude -p --output-format text` to `claude --output-format stream-json --verbose --no-session-persistence --system-prompt <wrapper>` (no `-p`). The NDJSON event stream is parsed into the assembled response. Benefits: ~64% per-request cost reduction and anti-hallucination via `--system-prompt` tool-use suppression. Clients see no API change — the OpenAI-compatible request/response shapes are identical. Faithful port of OLP's production-verified implementation; covered by 17 new stream-json parser tests.

⚠️ **Billing note:** from 2026-06-15 this default path carries `cc_entrypoint=sdk-cli` and bills against the Agent SDK credit pool. Use the new opt-in `CLAUDE_TUI_MODE` (below) to keep traffic on the Pro/Max subscription pool.

---

### feat(tui): opt-in CLAUDE_TUI_MODE — serve via interactive claude (cc_entrypoint=cli / subscription pool), single-user only; default stream-json path unchanged

From 2026-06-15 Anthropic routes `claude -p` / `--output-format` invocations to the Agent SDK credit pool (`cc_entrypoint=sdk-cli`). This feature adds an opt-in bridge: when `CLAUDE_TUI_MODE=true`, OCP serves each request via a real interactive `claude` session (no `-p`, no `--output-format`) so it carries `cc_entrypoint=cli` and bills against the Pro/Max subscription.

The complete string response is read from claude's native JSONL session transcript and replayed to callers as a normal OpenAI completion or chunked SSE. Clients see no API change. The default stream-json path is byte-for-byte unchanged when `CLAUDE_TUI_MODE` is unset.

**Security:** single-user / single-operator only. Never enable on a multi-user OCP. See ADR 0007 and README § "Subscription-pool (TUI) mode".

New env vars: `CLAUDE_TUI_MODE`, `CLAUDE_TUI_WALLCLOCK_MS`, `OCP_TUI_CWD`, `OCP_TUI_HOME`.
New ADR: `docs/adr/0007-tui-interactive-mode.md`.
New modules: `lib/tui/transcript.mjs`, `lib/tui/session.mjs` (shipped in preceding commits on this branch).

---

### Model — add claude-opus-4-8

Add `claude-opus-4-8` as the newest Opus to `models.json` (index 0, newest first). Repoint `aliases.opus` from `claude-opus-4-7` to `claude-opus-4-8`. `claude-opus-4-7` remains in the list callable by literal id. `legacyAliases.claude-opus-4` left pointing at `claude-opus-4-7` (no change — legacy alias tracks the prior generation). README Available Models table and model-count references updated accordingly.

---

## v3.16.4 — 2026-05-13

### Refactor — port-literal SPOT + CI guardrail

Closes the structural side of the port-drift cascade addressed by v3.16.2
and v3.16.3. Those two releases reverted plist / plugin / scripts back to
3456 line-by-line, but the underlying invitation to drift — a hardcoded
port literal scattered across six source files — was still intact.

Changes:

- **New `lib/constants.mjs`** — single source of truth for shared literals.
  Exports `DEFAULT_PORT = 3456`, `LOCAL_HOST = "127.0.0.1"`,
  `OPENAI_API_BASE = "/v1"`, `LOCAL_PROXY_URL`.
- **`server.mjs:127`, `setup.mjs:36`, `scripts/upgrade.mjs:137`,
  `scripts/doctor.mjs:84` + `:205`, `scripts/sync-openclaw.mjs:73`** —
  all replaced with imports from `lib/constants.mjs`. Behavior is
  identical; the literal `3456` now exists in exactly one place per
  language (`lib/constants.mjs` for `.mjs`, `ocp` + `ocp-connect` for
  bash, `test-features.mjs` for pinned historical-port tests).
- **`.github/workflows/alignment.yml`** — extended the path filter to
  `setup.mjs`, `scripts/**`, `lib/**`, `ocp`, `ocp-connect`. Added a new
  `port-spot` hard-fail job that greps for any hardcoded `3478` or `3456`
  literal in `.mjs/.js/.ts/.json` outside the EXEMPT_REGEX (which lists
  `lib/constants.mjs`, `test-features.mjs`, the bash CLIs, docs, and the
  workflow itself). Any future PR re-introducing a hardcoded port
  literal will be blocked at CI before it can cascade.
- Doc comments in `server.mjs` env-var summary and `setup.mjs` usage
  banner reworded so the literal `3456` no longer appears as
  documentation text (CI grep is intentionally aggressive — it does not
  parse comments — so doc strings reference `DEFAULT_PORT from
  lib/constants.mjs` instead).

No behavior change for any user. `CLAUDE_PROXY_PORT` env var remains
the runtime override; the only difference is the unset-env fallback
now flows through one shared constant.

ALIGNMENT.md hard-requirements: this PR modifies `server.mjs` (one-line
import + one literal swap, mechanical). No cli.js operation changed;
the citation requirement does not apply. SPOT principle (Rule 2 spirit)
is the entire motivation.

## v3.16.3 — 2026-05-13

### Fixes — completes v3.16.2 port-drift revert

v3.16.2 reverted the plugin / `openclaw.plugin.json` / README / Mac mini
plist back to `3456` (the historical source default since `593d0dc`), but
missed three places in `scripts/` that still defaulted to `3478`. Those
three lines were the residual cascade source: every time `ocp doctor` or
`ocp upgrade` ran without `CLAUDE_PROXY_PORT` in the env, they probed
`3478`, reported "OCP not responding" against a healthy 3456 instance,
and (in the case of OpenClaw sync follow-ups on the maintainer's host)
re-introduced 3478 into downstream config.

Changes:

- `scripts/upgrade.mjs:137` — default port `3478` → `3456`.
- `scripts/doctor.mjs:84` — default port `3478` → `3456`.
- `scripts/doctor.mjs:205` — default port `3478` → `3456`.

No behavior change for users who set `CLAUDE_PROXY_PORT` explicitly; env
still takes precedence. The fix only affects the unset-env fallback,
which now matches `server.mjs:126` and the rest of the codebase.

Test plan: existing `test-features.mjs` cases that pin
`CLAUDE_PROXY_PORT=3478` continue to pass — they use the env path, not
the default.

## v3.16.2 — 2026-05-12

### Fixes — corrects v3.16.1

The v3.16.1 fix was directionally correct (plugin now reads env first, falls back to a hardcoded default) but **the narrative and the hardcoded default were both wrong**.

What v3.16.1 said: "OCP server moved to 3478 default in v3.14+; plugin lagged at 3456."
What is actually true:
- **OCP server source default has been `3456` since `593d0dc` (initial release) and has never changed.** Every line in `server.mjs`, `setup.mjs`, and the `ocp` CLI still uses `3456` as the documented and code-level default.
- The single OCP installation observed on `3478` is the maintainer's Mac mini, whose plist was rewritten with `--port 3478` during a PR #71 dogfood smoke-test accident on 2026-05-08 (see `~/.cc-rules/memory/learnings/subagent_setup_mjs_prod_host_collision.md`). The plist drift was never reconciled back to source default, and v3.16.1 incorrectly canonised the post-accident value as if it had been a release decision.

This release:
- Restores the plugin fallback to `http://127.0.0.1:3456` to match server source default.
- Updates `openclaw.plugin.json` `configSchema.proxyUrl.default` back to `3456`.
- Restores README §"Environment Variables" `CLAUDE_PROXY_PORT` default to `3456`.
- Plugin reads `OCP_PROXY_URL` env (full URL) first, then `CLAUDE_PROXY_PORT` env (port only), then falls back to `3456`. Hosts whose OCP plist injects a non-default port must also inject the same `CLAUDE_PROXY_PORT` into the OpenClaw plist for the plugin to follow.
- Maintainer's Mac mini plist was reverted from `3478` to `3456` as part of this release deploy (no source change reflects this; it was a one-host correction).

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.

## v3.16.1 — 2026-05-12 (superseded — narrative incorrect; see v3.16.2 erratum)

### Fixes (as shipped — note erratum above)

- **OCP plugin port lag** — `ocp-plugin/index.js` hard-coded `http://127.0.0.1:3456`. ~~While OCP server moved to 3478 in v3.14+,~~ **(corrected v3.16.2: no such move ever happened.)** The Mac mini's plist was on `3478` only as residue from a dogfood accident. Result: `/ocp` slash commands from the home Telegram bot returned "OCP error: fetch failed". v3.16.1 changed the plugin default to `3478` (wrong direction; v3.16.2 reverts to `3456`).

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.

## v3.16.0 — 2026-05-10

### Features

- **`ocp doctor --check oauth`** (PR #93) — fast path that runs only the OAuth check, skipping
  version detection / from-version / git operations / models endpoint. ~50ms vs. full doctor's
  ~200-500ms. Use cases: AI agent repair loops, post-`claude auth login` verify, quick health
  gates. Help text in `cmd_doctor_help` now reflects working behaviour.
- **`ocp update --rollback --gc`** — manually garbage-collect old upgrade snapshots.
  Retention policy: keep last 5 snapshots OR snapshots newer than 30 days OR the single most
  recent (always-keep safety net). `--dry-run` previews. Successful `ocp update` runs auto-GC
  at the end of the full path; light path does not (no snapshot created there).

### Behavior changes

- After a successful cross-minor `ocp update`, the auto-GC emits `[gc] removed N old snapshots`
  to stderr if any were collected. Safe to ignore; manual gc is `ocp update --rollback --gc`.

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.
- PR #93 (--check oauth) merged separately; this release bundles it with the GC feature.

## v3.15.1 — 2026-05-10

### Fixes

- **doctor: dynamic `latest_version` from `origin/main:package.json`** — v3.15.0 doctor used a hard-coded `latest = "v3.14.0"` fallback, which made any v3.15.0+ install report `kind = upgrade` (against a stale value). `ocp update` would then attempt `git checkout v3.14.0` — a downgrade. Doctor now fetches `git -C ~/ocp show origin/main:package.json` to determine the actual latest version; on failure (offline, fresh clone with no remote), falls back to `currentVersion` so `kind = noop` instead of recommending a downgrade.

## v3.15.0 — 2026-05-10

### Features

- **`ocp doctor`** — health & upgrade-readiness check; primary entry for AI-driven debugging.
  `--json` mode emits a `next_action` with `ai_executable[]` for agents to run verbatim
  and `human_required[]` for steps requiring the user (typically only OAuth).
- **`ocp update` cross-version path** — for cross-minor jumps (e.g. v3.10 → v3.14),
  `ocp update` now runs doctor → snapshot → `setup.mjs` (with the plist env-merge from
  PR #90) → service restart → post-flight `/health` + `/v1/models` verification.
  Same-patch updates retain the existing light path; users see no change for routine
  patch bumps.
- **`ocp update --rollback`** — restore the most recent (or specified) upgrade snapshot.
  Snapshots are saved to `~/.ocp/upgrade-snapshot-<ISO-ts>/` and never auto-deleted.
- **Fresh-install routing** — `ocp update` on installations < v3.4.0 routes to a fresh-install
  flow (with `--yes` to skip confirmation; AI agents pass this). OAuth survives via Claude
  Code's credential store; users do not re-OAuth unless their token was independently broken.
- **AI prompt blocks in README** — §Installation, §Upgrading, and §Troubleshooting each
  start with a copy-paste prompt for Claude Code / Cursor / Copilot, so users can drive
  install / setup / upgrade through their existing AI assistant.

### Behavior changes

- `ocp update` may take 10–30s longer when a cross-minor jump triggers the full path
  (snapshot + post-flight). Patch bumps are unchanged.
- Pre-v3.4.0 installs are routed to fresh-install rather than failing silently or
  half-migrating.

### Governance

- No `cli.js` citation needed (no `server.mjs` change). ALIGNMENT.md Rule 2 not engaged.
- Depends on PR #90 (plist env merge bug fix; merged before this release).

## v3.14.0 — 2026-05-10

### Features (security hardening)

- **Per-key session isolation** (PR #86, S1) — the `sessions` Map in `server.mjs` is now keyed by `${keyName}|${conversationId}` instead of bare `conversationId`. Before this fix, two clients using distinct API keys but the same `session_id` value (e.g. both defaulting to `"default"`) would share the same `cli.js` subprocess and conversation history, creating a cross-tenant leak path. Post-fix each (key, session) pair is isolated end-to-end, extending the per-key cache isolation shipped in v3.13.0 D1 to the session layer.
- **On-disk credential file modes 0700/0600** (PR #87, S2) — `setup.mjs` now creates `~/.ocp` at mode 0700 and both `admin-key` and `ocp.db` at mode 0600. An idempotent `reconcileFileModes()` call in `server.mjs` startup tightens any existing installation to these modes automatically on every launch, so existing prod boxes fix themselves without manual `chmod`. Before this fix, all three files were created at the process's default umask (typically world-readable 0644 / 0755), leaving plaintext credentials readable by other local users.
- **`/api/usage` default scope = self; admin all-keys requires `?all=true`** (PR #88, S3) — the usage endpoint now applies a least-privilege default: anonymous callers receive only their own rows, non-admin authenticated callers receive only their own rows, and admin callers receive only their own rows unless they explicitly pass `?all=true`. When `?all=true` is used, an audit log line is emitted. Before this fix, any admin-token holder could silently enumerate usage data for every key on the server.

### Behavior changes

- **Breaking change for admin tooling**: `/api/usage` no longer returns all-keys data by default. Existing cron jobs, dashboards, or scripts that rely on the admin token seeing all-keys output must add `?all=true` to their request URL after upgrading to v3.14.0.
- **File mode reconcile at server startup** logs a one-line notice per path when mode is tightened (e.g. `[security] tightened ~/.ocp/ocp.db → 0600`). No action is required from the operator; the reconcile is idempotent and silent when modes are already correct.
- **`sessions` Map key is now `${keyName}|${conversationId}` internally.** No client-visible wire change — the `session_id` field in request/response is unchanged.

### Verification

- Stress-test pass: 11/11 phases including S1/S2/S3 security regression checks (Phase E, I, J). 35-minute sustained run, 60 calls, 0 errors, 0 timeouts. RSS dropped 51→47 MB across the window. Per-key cache isolation, singleflight, cache_control bypass, quota enforcement, file-mode reconcile, and scope guard against escalation all verified against running code.

### Governance

- All three PRs (#86, #87, #88) include the explicit `cli.js`-citation-not-applicable disclaimer (per PR #75 pattern) since they are OCP-internal access-control, session-state, and file-permission changes with no corresponding `cli.js` operation to cite.

### No new env vars / no public API surface change beyond the documented breaking change

This release adds no new env vars or endpoints. The only externally visible change is the `/api/usage` scope guard (breaking for admin all-keys consumers; see Behavior changes above).

## v3.13.0 — 2026-05-07

### Features (cache layer hardening)

- **Per-key cache isolation** (D1) — the cache key now includes the API key id, so distinct keys never share cache entries. Anonymous/unauthenticated callers share one `anon` pool. Hash format upgraded to `v2`; legacy v1-format rows orphan and are reaped by the existing TTL cleanup interval (no migration script).
- **`cache_control` bypass** (D2) — when a request carries an Anthropic `cache_control` annotation (top-level or nested in a content array), OCP skips its own cache entirely. The caller is using Anthropic-side prompt caching deliberately, and OCP must not interfere. A `cache_skipped{reason: cache_control_present}` log line is emitted on bypass.
- **Chunked stream replay** (D3) — when a streaming request hits the cache, the cached content is now emitted as multiple SSE chunks (80 codepoints/chunk, codepoint-safe via `Array.from()`) instead of a single large delta. Multibyte characters (CJK / emoji) stay intact.
- **Singleflight stampede protection** (D4) — concurrent identical cache-miss requests now share one upstream `cli.js` spawn instead of spawning N processes. Followers receive byte-identical responses to what the leader returns. All-or-nothing failure semantics: if the leader errors, all followers receive the same error. Streaming-path singleflight is explicitly out of scope (TODO left for follow-up).

### Behavior changes

- `/cache/stats` response now includes additive fields `inflight` and `requesters` (current in-flight singleflight entries and total waiting callers). Existing fields `entries`, `totalHits`, `sizeBytes` are preserved unchanged.

### Governance

- New ADR [`docs/adr/0005-no-multi-provider.md`](docs/adr/0005-no-multi-provider.md): OCP stays single-provider (Anthropic via `cli.js` spawn). Multi-provider gateway refactor explicitly out of scope; cache improvements are explicitly in scope.
- Design spec for this release: [`docs/superpowers/specs/2026-05-07-cache-upgrade-design.md`](docs/superpowers/specs/2026-05-07-cache-upgrade-design.md).

### No new env vars / no public API surface change

This release adds no new env vars or endpoints. All four improvements are internal correctness/concurrency upgrades to the existing `CLAUDE_CACHE_TTL`-gated cache layer. No client-observable wire shape change.

## v3.12.0 — 2026-04-25

### Features

- **Streaming heartbeat** — opt-in SSE comment frame (`: keepalive\n\n`) emitted during silent windows on the streaming response. Controlled by `CLAUDE_HEARTBEAT_INTERVAL` env var (ms; `0` = disabled, default). Covers both pre-first-byte and mid-stream tool-use pauses. Addresses #47. See [design doc](docs/superpowers/specs/2026-04-25-47-sse-heartbeat-design.md).
- **`X-Accel-Buffering: no`** response header added to SSE responses so heartbeats survive nginx/Cloudflare default buffering.

### Behavior changes

- SSE headers are now sent immediately after the claude CLI spawns successfully, not on first stdout byte. The rare "spawn succeeded but subprocess died before any byte" path now closes the SSE stream cleanly rather than returning a JSON error.

### Config additions

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` (disabled) | Interval in ms for SSE keepalive comment frames on streaming path. Resets on every real frame. |

## v3.11.1 — 2026-04-21

### Fixes
- Concurrency slot leak on subprocess timeout (#37). The request-timeout handler called `proc.kill("SIGTERM")` without decrementing `stats.activeRequests`. A subprocess stuck in a syscall that ignored SIGTERM would hold its slot until (or beyond) the 5s SIGKILL escalation actually reaped it. Slot release is now wired to `proc.once("exit", cleanup)` so every termination path — normal close, error, SIGTERM, SIGKILL — releases the slot exactly once.

## v3.11.0 — 2026-04-20

### Features
- `ocp update` now automatically syncs OpenClaw's registry with the latest models (scripts/sync-openclaw.mjs)
- Server logs warn if OpenClaw registry drifts from models.json

### Refactor
- models.json is now the single source of truth for model list
- server.mjs and setup.mjs derive MODEL_MAP/MODELS from models.json
- Adding a new model is now a one-file edit

### Fixes
- OpenClaw's model dropdown now shows all 4 current models (opus-4-7, opus-4-6, sonnet-4-6, haiku-4.5) on existing installs after `ocp update`. Previously setup.mjs only wrote the registry at install time.
