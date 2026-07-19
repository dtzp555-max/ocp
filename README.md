# OCP — Open Claude Proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![GitHub release](https://img.shields.io/github/v/release/dtzp555-max/ocp)](https://github.com/dtzp555-max/ocp/releases) [![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-ffdd00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/dtzp555)

> **Already paying for Claude Pro/Max? Use your subscription as an OpenAI-compatible API — $0 extra cost.**

*Open source from day one, used daily by my family, maintained on nights and weekends. If OCP saves you money too, you can [☕ buy me a coffee](https://buymeacoffee.com/dtzp555) — [full story below](#support-ocp).*

*If OCP saves you a setup, a ⭐ helps other folks discover it. Issue reports are even more useful — that's the highest-quality feedback this project gets.*

OCP turns your Claude Pro/Max subscription into a standard OpenAI-compatible API on localhost. Any tool that speaks the OpenAI protocol can use it — no separate API key, no extra billing.

```
Cline          ──┐
OpenCode       ───┤
Aider          ───┼──→ OCP :3456 ──→ Claude CLI ──→ Your subscription
Continue.dev   ───┤
OpenClaw       ───┘
```

One proxy. Multiple IDEs. All models. **$0 API cost.**

## Contents

- [Why OCP?](#why-ocp) · [Supported Tools](#supported-tools)
- [Quickstart](#quickstart)
- [How It Works](#how-it-works)
- Reference: [Available Models](#available-models) · [API Endpoints](#api-endpoints) · [Environment Variables](#environment-variables)
- Modes & operations: [LAN & multi-user](#lan--multi-user) → [`docs/lan-mode.md`](docs/lan-mode.md) · [Subscription-pool (TUI) mode](#subscription-pool-tui-mode) → [`docs/tui-mode.md`](docs/tui-mode.md) · [Upgrading](#upgrading) → [`docs/upgrading.md`](docs/upgrading.md)
- [Built-in Usage Monitoring](#built-in-usage-monitoring) · [Response Cache](#response-cache) · [Structured Outputs](#structured-outputs-openai-response_format) · [Images / Multimodal](#images--multimodal-vision) · [OpenClaw Integration](#openclaw-integration)
- [Troubleshooting](#troubleshooting) → [`docs/troubleshooting.md`](docs/troubleshooting.md)
- [Repository Layout](#repository-layout) · [Security](#security) · [Governance](#governance) · [Support OCP](#support-ocp) · [License](#license)

## Why OCP?

There are several Claude proxy projects. OCP picks a specific lane: **align tightly with what `cli.js` actually does, observe + multiplex what's already there, don't extend the protocol.** What you get:

- **LAN multi-user keys** (v3.7.0) — reach one Claude Pro/Max subscription from your own devices across the LAN. Each device gets a per-key API token (no OAuth session leak), with independent usage tracking and one-line revocation. Pro/Max are **per-user** accounts — see [Sharing with family / a team — honest limits](docs/lan-mode.md#deployment-model--security-read-this) before extending access to other **people**.
- **`ocp-connect` one-shot client setup** — one command on the client machine auto-configures OpenClaw, and detects Cursor, Cline, Continue.dev, and opencode to print ready-to-paste setup hints for each. No hunting for where each tool keeps its `OPENAI_BASE_URL`.
- **Response cache with per-key isolation + singleflight** (v3.13.0). Optional SHA-256 prompt cache, isolated per API key (cross-user pollution is impossible by hash construction, not by application logic), with stampede protection on concurrent identical prompts. Off by default. ([PR #65](https://github.com/dtzp555-max/ocp/pull/65), [PR #66](https://github.com/dtzp555-max/ocp/pull/66))
- **Per-key request quotas** (v3.8.0). Daily / weekly / monthly limits per key — set a kid's iPad to 20/day, a partner's laptop to 100/week. ([PR #18](https://github.com/dtzp555-max/ocp/pull/18))
- **SSE heartbeat for long reasoning** ([v3.12.0](https://github.com/dtzp555-max/ocp/releases/tag/v3.12.0), opt-in). If you've ever watched your IDE die at the 60s idle mark during a long Claude tool-use pause — that's nginx/Cloudflare default behavior. OCP emits an SSE comment frame to keep the connection alive without polluting the response. ([PR #49](https://github.com/dtzp555-max/ocp/pull/49))
- **`cli.js` alignment + CI guardrail.** LLM-assisted code drifts easily — it's tempting to invent plausible-looking endpoints that `cli.js` doesn't actually use. [`ALIGNMENT.md`](./ALIGNMENT.md) is binding: every endpoint OCP exposes must cite a `cli.js` line. The [`alignment.yml`](./.github/workflows/alignment.yml) CI workflow blocks PRs that introduce known-hallucinated tokens. The payoff is boring: your setup keeps working when `cli.js` ships its next minor.
- **`models.json` single source of truth** (v3.11.0). Adding a model is one file edit; both `/v1/models` and the OpenClaw bootstrap derive from it. ([PR #30](https://github.com/dtzp555-max/ocp/pull/30))
- **Drives the official CLI as-is, no binary patching.** OCP spawns the official `claude` CLI (or hosts it in an interactive tmux pane for TUI mode) — it does not extract OAuth tokens from memory, patch the binary, or invent protocol extensions. Traffic therefore looks like genuine Claude Code to Anthropic's classifiers (`cc_entrypoint=cli`). See `ALIGNMENT.md` for why this constraint is load-bearing.

### Comparison

OCP and the alternatives serve adjacent but distinct needs. Pick the one that fits your use case:

| Feature | OCP | claude-code-router | anthropic-proxy |
|---|---|---|---|
| Forwards Claude Code subscription as OpenAI API | yes | yes | yes |
| Routes to multiple model backends (OpenAI, Gemini, etc.) | no | yes | partial |
| SSE heartbeat for long reasoning | yes (opt-in) | no | no |
| Per-key quota + LAN multi-user keys | yes | no | no |
| Response cache | yes (opt-in) | no | no |
| OpenClaw / IDE auto-config | yes | no | no |
| Model-routing rules / model-switching | no | yes | no |
| GitHub stars / ecosystem size | small | large | mid |
| Governance discipline (CI-enforced alignment with cli.js) | yes | n/a | n/a |

**Plain English**: `claude-code-router` is the routing-and-switching power tool — pick it if you want to mix Anthropic, OpenAI, Gemini, and local models behind one endpoint. `anthropic-proxy` is the minimal forwarder. **OCP focuses on disciplined `cli.js`-aligned forwarding plus subscription multiplexing** — pick it if you want to reach one Claude Pro/Max subscription from your own IDEs and devices, with LAN auth, quotas, and a governance contract that prevents endpoint drift.

### Related: OLP — Open LLM Proxy

OCP is Claude-only by design. If you want to spread across **multiple LLM providers** (not just Claude), see the sibling project **[OLP — Open LLM Proxy](https://github.com/dtzp555-max/olp)**: the same spawn-the-provider-CLI approach, but across several provider CLIs behind one OpenAI-compatible endpoint, with intelligent fallback chains. It grew out of OCP in response to Anthropic's 2026-06-15 billing split — the idea being to spread subscription/quota risk across more than one provider. OCP remains the focused, Claude-only option; OLP is the multi-provider one.

OCP is single-maintainer + LLM-assisted, currently pre-1.0. It runs the maintainer's daily Claude Code workflow. If something breaks, [open an issue](https://github.com/dtzp555-max/ocp/issues).

## Supported Tools

Any tool that accepts `OPENAI_BASE_URL` works with OCP:

| Tool | Configuration |
|------|--------------|
| **Cline** | Settings → `OPENAI_BASE_URL=http://127.0.0.1:3456/v1` |
| **OpenCode** | `OPENAI_BASE_URL=http://127.0.0.1:3456/v1` |
| **Aider** | `aider --openai-api-base http://127.0.0.1:3456/v1` |
| **Continue.dev** | config.json → `apiBase: "http://127.0.0.1:3456/v1"` |
| **OpenClaw** [^openclaw] | `setup.mjs` auto-configures |
| **Any OpenAI client** | Set base URL to `http://127.0.0.1:3456/v1` |

[^openclaw]: **OpenClaw** is an IDE-agnostic AI coding agent (sibling project to OCP). When OCP runs on the same machine, OpenClaw can use it as a local provider — see `scripts/sync-openclaw.mjs` and ADR 0004.

## Quickstart

The simplest path: ask your AI.

  Paste this prompt to Claude Code / Cursor / Copilot:

  ```
  Install OCP for me. Read README §Quickstart and follow it.
  Tell me when I need to run `claude auth login`.
  ```

The AI will run `git clone`, `npm install`, `node setup.mjs`, and tell you when to OAuth.

**Prerequisites:** macOS or Linux (Windows is not supported), Node.js 22.5+ (Node 23+ recommended), `git`, and the [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli), authenticated:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login   # prints a URL + code — open on any browser, sign in, paste code back
```

**Install** (Server role — runs the proxy):

```bash
git clone https://github.com/dtzp555-max/ocp.git
cd ocp
node setup.mjs
```

`setup.mjs` verifies the Claude CLI, starts the proxy on port 3456, and installs auto-start (launchd on macOS, systemd on Linux). The `ocp` CLI lands at `~/ocp/ocp` — symlink it onto your PATH (`sudo ln -sf ~/ocp/ocp /usr/local/bin/ocp`, or `ln -sf ~/ocp/ocp ~/.local/bin/ocp`) or alias it (`alias ocp=~/ocp/ocp`); the rest of the docs assume `ocp` is on your PATH.

**Verify** — should list 6 models:

```bash
curl http://127.0.0.1:3456/v1/models
# claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5-20251001
```

**Connect one IDE** — point any OpenAI-compatible tool at the proxy, then reload your shell and start a tool (Cline / Continue / Cursor / OpenCode):

```bash
export OPENAI_BASE_URL=http://127.0.0.1:3456/v1
```

See [Supported Tools](#supported-tools) for per-tool config.

**LAN / multi-user** — reach OCP from your own devices, with per-key auth, quotas, and anonymous access:

```bash
node setup.mjs --bind 0.0.0.0 --auth-mode multi
```

The full LAN server + client handbook, headless (Pi / NAS / VPS) OAuth, key/quota/anonymous-access management, AI-assisted install prompts, and the deployment/security model live in **[docs/lan-mode.md](docs/lan-mode.md)**. Claude Pro/Max are per-user accounts — read the [honest limits of sharing](docs/lan-mode.md#deployment-model--security-read-this) before extending access to other people.

### Uninstall

```bash
# From the cloned repo
node uninstall.mjs
```

Removes the launchd (macOS) or systemd (Linux) auto-start entry. Handles both legacy (`ai.openclaw.proxy` / `openclaw-proxy`) and current (`dev.ocp.proxy` / `ocp-proxy`) service names. Does not delete `~/.openclaw/`, `~/.ocp/`, or the cloned repo — remove those manually if desired.

## How It Works

```
Your IDE → OCP (localhost:3456) → claude --output-format stream-json CLI → Anthropic (via subscription)
```

OCP translates OpenAI-compatible `/v1/chat/completions` requests into `claude --output-format stream-json` CLI calls. Anthropic sees normal Claude Code usage — no API billing, no separate key needed.

> **Billing-policy status (as of 2026-07).** Anthropic announced (2026-05-14) that from 2026-06-15 the `claude -p` / Agent SDK path would move to a separate metered credit pool — then **paused the change on its effective date**: *"For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits"* ([official help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). So the default path above currently bills your subscription. Anthropic has said it will give notice before any future change; if the split re-lands, OCP's opt-in [subscription-pool (TUI) mode](docs/tui-mode.md#subscription-pool-tui-mode) is the ready-made hedge — see the billing table there.

### Client-tools boundary

OCP is a **text-prompt bridge** to the official `claude` CLI. It does **not** pass through OpenAI `tools`/`functions` payloads or Anthropic `tool_use` blocks to the client. Clients (Cline, Cursor, OpenClaw, etc.) pointed at OCP receive **assistant TEXT only** — they never get `tool_calls` to execute locally.

Any tool use happens server-side, under the `--allowedTools` set configured on the OCP host. In default mode (no `CLAUDE_NO_CONTEXT`), the `claude` CLI's own built-in tools are available to the model; in TUI mode, the operator controls the tool surface via `OCP_TUI_FULL_TOOLS`. Either way, the tools run under the operator's credentials on the server, and the client sees only the final text output.

**Client-local tool execution is not supported by design.** Supporting it would require bypassing the `claude` CLI to call the raw Anthropic API directly — that is a different product, and is out of scope per `ALIGNMENT.md` (every OCP endpoint must correspond to something `cli.js` actually does).

**What this means for choosing OCP (workload fit).** LAN/multi-device OCP is built for **chat-class** workloads — Q&A, translation, scripting against the API, chat frontends, home-automation backends — where text in/text out is the whole job. It is **not** the right tool for a coding agent running on a *client* machine that needs the AI to read and edit *that machine's* files: tools execute on the OCP host, so the model can never touch the client's filesystem. For that workload, run `claude` (or a local OCP) directly on the machine where the code lives.

## Available Models

| Model ID | Notes |
|----------|-------|
| `claude-opus-4-8` | Most capable (default for `opus` alias) |
| `claude-opus-4-7` | Previous Opus, retained for pinning |
| `claude-opus-4-6` | Older Opus, retained for pinning |
| `claude-sonnet-5` | Latest Sonnet (default for `sonnet` alias) |
| `claude-sonnet-4-6` | Previous Sonnet, retained for pinning |
| `claude-haiku-4-5-20251001` | Fastest, lightweight (default for `haiku` alias) |

The canonical list lives in [`models.json`](./models.json) — the single source of truth as of v3.11.0. Both `server.mjs` (the `/v1/models` endpoint) and `setup.mjs` (the OpenClaw registration) derive from it. Adding a new model is now a one-file edit:

```bash
# 1. Edit models.json — add an entry
# 2. Bump version, commit, tag, push
# 3. Users get it on next `ocp update`:
#    - OpenClaw: auto-synced via scripts/sync-openclaw.mjs
#    - Cline / Aider / Cursor / opencode: live /v1/models, picks up immediately
#    - Continue.dev: user edits their own config.json
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completion (streaming + non-streaming) |
| `/health` | GET | Comprehensive health check (includes a `tui` block for TUI-mode drift/concurrency monitoring) |
| `/usage` | GET | Plan usage limits + per-model stats |
| `/status` | GET | Combined overview (usage + health) |
| `/settings` | GET/PATCH | View or update settings at runtime |
| `/logs` | GET | Recent log entries (`?n=20&level=error`) |
| `/sessions` | GET/DELETE | List or clear active sessions |
| `/dashboard` | GET | Web dashboard (always public) |
| `/api/keys` | GET/POST | List or create API keys (admin only) |
| `/api/keys/:id` | DELETE | Revoke an API key (admin only) |
| `/api/keys/:id/quota` | GET/PATCH | View or set per-key quota (admin only) |
| `/api/usage` | GET | Per-key usage stats (`?since=&until=&hours=&limit=`); returns self only by default — pass `?all=true` (admin only) for all-keys data |
| `/cache/stats` | GET | Cache statistics (admin only) |
| `/cache` | DELETE | Clear response cache (admin only) |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `3456` | Listen port (server-side). Also consumed by the OpenClaw `ocp-plugin` to dial the local proxy. |
| `OCP_PROXY_URL` | *(unset)* | Plugin-side full URL override (e.g. `http://10.0.0.5:3456`). Wins over `CLAUDE_PROXY_PORT` when both are set. Read by `ocp-plugin/index.js` only — server ignores it. |
| `CLAUDE_BIND` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `CLAUDE_AUTH_MODE` | `none` | Auth mode: `none`, `shared`, or `multi` |
| `OCP_ADMIN_KEY` | *(unset)* | Admin key for key management (multi mode) |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `600000` | Request timeout (ms, default: 10 min) |
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` | Streaming SSE keepalive interval (ms). `0` = disabled. See ["Streaming heartbeat"](#streaming-heartbeat) below. |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes (`-p`/stream-json path) |
| `CLAUDE_MAX_QUEUE` | `16` | Max requests **waiting** for a `-p` concurrency slot. Beyond `CLAUDE_MAX_CONCURRENT`, requests queue (up to this cap) instead of being rejected; when the queue is **also** full, the request gets `HTTP 429` + `Retry-After` (not an opaque 500). Surfaced on `/health.concurrency` + `/health.stats.queueRejections`. |
| `CLAUDE_QUEUE_RETRY_AFTER` | `5` | Seconds advertised in the `Retry-After` header on a `-p` concurrency-overflow `429`. |
| `CLAUDE_MAX_PROMPT_CHARS` | *(derived)* | Prompt truncation limit in chars. Default derives from the models.json SPOT: `max(contextWindow) × 3` — currently **600,000** (≈150–200k tokens). Setting this env var (or the runtime settings API) overrides the derivation absolutely. See [ADR 0009](docs/adr/0009-spot-derived-prompt-budget.md). Note: very large prompts burn subscription-window quota quickly and slow TTFT; the TUI-mode paste path is untested beyond ~hundreds of KB. Applies to **text only** — image bytes bypass this budget (see [Images / Multimodal](#images--multimodal-vision)). |
| `OCP_STRUCTURED_MAX_ATTEMPTS` | `3` | Max attempts (initial + retries) to coerce a schema-valid JSON reply when a request uses OpenAI `response_format`. Fail-closed: a non-numeric value keeps the default. See [Structured Outputs](#structured-outputs-openai-response_format). |
| `CLAUDE_SESSION_TTL` | `3600000` | Session expiry (ms, default: 1 hour) |
| `CLAUDE_CACHE_TTL` | `0` | Response cache TTL (ms, 0 = disabled). Set to e.g. `300000` for 5-min cache. See [Response Cache](#response-cache). |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass all permission checks |
| `CLAUDE_MCP_CONFIG` | *(unset)* | Path to an MCP server config JSON, passed to the spawned `claude` as `--mcp-config` (both the `-p` path and TUI `OCP_TUI_FULL_TOOLS` panes) |
| `CLAUDE_MAX_BODY_SIZE` | `5242880` | Max request body size (bytes, default 5 MB). Base64 image payloads inflate ~33%; raise this to admit larger multimodal requests. Fail-closed parsing: a garbage value keeps the default. |
| `CLAUDE_IMAGE_ALLOW_URL` | `false` | Allow remote `http(s)` image URLs in `image_url` parts. **Off by default** (v1 supports base64 `data:` URIs only). When on, the URL is passed through to Anthropic as a `url` image source — **OCP does not fetch it** (no OCP-side SSRF surface); unreachable/blocked URLs surface as an API error. |
| `CLAUDE_MAX_IMAGE_BYTES` | `5242880` | Per-image decoded-byte cap (default 5 MB). Over-cap images get `HTTP 413`. |
| `CLAUDE_MAX_IMAGES` | `20` | Max image parts per request. Over-cap gets `HTTP 413`. |
| `CLAUDE_MAX_IMAGE_TOTAL_BYTES` | `20971520` | Aggregate decoded-byte cap across all images in a request (default 20 MB). Over-cap gets `HTTP 413`. |
| `CLAUDE_SYSTEM_PROMPT` | *(unset)* | Operator-wide system-prompt text appended (last) to every request's composed system prompt on the default `-p` path. TUI-mode panes are unaffected (they keep the interactive CLI's own system prompt). Echoed truncated on `/health.systemPrompt`. Note: changing this value and restarting auto-invalidates the response cache (the key carries a boot-config epoch, #177). |
| `CLAUDE_NO_CONTEXT` | `false` | Suppress CLAUDE.md and auto-memory injection (pure API mode) |
| `PROXY_API_KEY` | *(unset)* | Bearer token for shared-mode authentication |
| `PROXY_ANONYMOUS_KEY` | *(unset)* | Well-known anonymous key (multi mode) — this exact string bypasses `validateKey()` and grants public access. Exposed via `/health.anonymousKey` only to localhost, or to all callers when `PROXY_ADVERTISE_ANON_KEY=1`. Full setup + security notes: [docs/lan-mode.md § Anonymous Access](docs/lan-mode.md#anonymous-access-optional). |
| `PROXY_ADVERTISE_ANON_KEY` | *(unset)* | When `=1`, advertise `PROXY_ANONYMOUS_KEY` in the public `/health` body for remote zero-config discovery. Default off — `/health` is unauthenticated, so this exposes the shared key to any LAN-reachable device (issue #109). Localhost always sees it regardless. |
| `CLAUDE_TUI_MODE` | `false` | **Opt-in, single-user only.** Set to `"true"` to serve requests via interactive `claude` (`cc_entrypoint=cli`, subscription pool). Refuses to boot under `AUTH_MODE=multi`. See [Subscription-pool (TUI) mode](docs/tui-mode.md#subscription-pool-tui-mode). |
| `CLAUDE_CODE_OAUTH_TOKEN` | *(unset)* | OAuth bearer token — highest-precedence credential for the `-p` path, and the **recommended** credential for TUI-mode hosts (when set with `OCP_TUI_HOME` unset, OCP runs the TUI `claude` in a credential-isolated home). See [docs/tui-mode.md](docs/tui-mode.md#tui-other-vars) and the [permanent-401 fix](docs/troubleshooting.md#tui-401). |
| `OCP_SPAWN_REAL_HOME` | *(unset)* | Kill-switch for the default `-p`/stream-json **spawn-home isolation** (latency fix). When unset and an OAuth token is resolvable, OCP runs the per-request `claude` spawn in a **credential-free minimal scratch home** (`$HOME/.ocp/spawn-home`, no `.credentials.json`/`settings.json`/plugins) with a neutral cwd and the env token — so it loads none of the operator's heavy global `~/.claude` (plugins/skills/hooks) or the project `CLAUDE.md`, cutting per-request latency (measured ~10–28s → ~3–7s). Set to `"1"` to force the legacy real-`HOME` spawn (no cwd override) even when a token exists. With **no** resolvable token, OCP falls back to the real `HOME` automatically (zero regression). Active mode is shown at startup and on `/health.spawn`. |
| `CLAUDE_TUI_WALLCLOCK_MS` | `120000` | (TUI-mode) Maximum time in ms to wait for the native transcript to signal turn completion. Increase for long Opus thinking turns. |
| `OCP_TUI_CWD` | `$HOME/.ocp-tui/work` | (TUI-mode) Scratch working directory where interactive claude sessions run. Transcripts land under `<HOME>/.claude/projects/<encoded-cwd>/`. Created automatically. |
| `OCP_TUI_HOME` | *(auto)* | (TUI-mode) `HOME` claude runs under. When unset, OCP auto-picks a credential-isolated scratch home (env token set) or the real home (no token). Full home/credential strategy: [docs/tui-mode.md](docs/tui-mode.md#tui-other-vars). |
| `OCP_TUI_ENTRYPOINT` | `cli` | (TUI-mode) Billing-classifier labeling: `cli` pins `cc_entrypoint=cli`; `auto` self-classifies via TTY; `off` leaves inherited env untouched. See [docs/tui-mode.md](docs/tui-mode.md#tui-entrypoint). |
| `OCP_TUI_EFFORT` | `low` | (TUI-mode) `--effort` level for the interactive spawn (`low`/`medium`/`high`/`xhigh`/`max`/`inherit`). Explicit `low` cuts TTFT p50 ~40% vs an inherited `xhigh`; invalid values fall back to `low`. See [docs/tui-mode.md](docs/tui-mode.md#tui-other-vars). |
| `OCP_TUI_STREAM` | `0` (off) | (TUI-mode) `=1` emits real SSE `delta.content` chunks (block-level) from claude's `MessageDisplay` hook instead of buffering; transcript stays authoritative and divergent turns are refused. Caveats (tool-using turns, zero-delta detection) in [docs/tui-mode.md § `OCP_TUI_STREAM`](docs/tui-mode.md#ocp-tui-stream). |
| `OCP_TUI_STREAM_HOLDBACK` | `100` | (TUI-mode, streaming) Characters withheld before the first chunk — keeps the auth-banner gate alive and is the knob for tool-using turns. See [docs/tui-mode.md § `OCP_TUI_STREAM_HOLDBACK`](docs/tui-mode.md#ocp-tui-stream-holdback). |
| `OCP_TUI_STREAM_DIR` | `$HOME/.ocp-tui/stream` | (TUI-mode, streaming) Directory for the hook script/settings + per-session delta sink (one sink per session-id, so concurrent turns never interleave). See [docs/tui-mode.md](docs/tui-mode.md#ocp-tui-stream). |
| `OCP_TUI_STREAM_POLL_MS` | `100` | (TUI-mode, streaming) Interval at which OCP drains the delta sink; the hook fires at block granularity so a finer poll buys nothing. See [docs/tui-mode.md](docs/tui-mode.md#ocp-tui-stream). |
| `OCP_TUI_MAX_CONCURRENT` | `2` | (TUI-mode) Max concurrent interactive TUI turns, independent of `CLAUDE_MAX_CONCURRENT`. Excess turns queue (bounded); a full queue yields 503. See [docs/tui-mode.md](docs/tui-mode.md#tui-other-vars). |
| `OCP_TUI_POOL_SIZE` | `0` (off) | (TUI-mode) Number of pre-booted warm `claude` panes (max `4`) so a request skips the cold boot — measured p50 `10.17s` → `6.00s`. Each warm pane is a live idle process; panes are single-use. See [docs/tui-mode.md § `OCP_TUI_POOL_SIZE`](docs/tui-mode.md#ocp-tui-pool-size). |
| `OCP_SKIP_AUTH_TEST` | *(unset)* | When `=1`, skip the `claude -p` auth probe during `setup.mjs`. Under the announced (currently **paused**) 2026-06-15 billing split this probe would draw from the metered Agent SDK credit pool; set this to avoid burning a probe on re-installs or `ocp update` runs. Auth is validated at the first real request. |
| `OCP_TUI_FULL_TOOLS` | *(unset)* | (TUI-mode, **single-user only**) `=1` grants the interactive session the same tool surface as the `-p` path (`--allowedTools` + optional `--mcp-config`) so a trusted single operator can run a tool-using / MCP agent on the subscription pool. Safe because TUI refuses to boot under `AUTH_MODE=multi`. See [docs/tui-mode.md § `OCP_TUI_FULL_TOOLS`](docs/tui-mode.md#ocp-tui-full-tools). |

### Streaming heartbeat

When `CLAUDE_HEARTBEAT_INTERVAL` is set to a positive integer (milliseconds), OCP emits an SSE comment frame (`: keepalive\n\n`) on streaming responses whenever the stream has been idle for that duration. The timer resets on every real chunk, so heartbeats only fire during genuine silent windows (for example, Claude CLI tool-use pauses of 30s–5min, or a long "processing large contexts" delay before the first token).

Use cases: downstream HTTP clients or load balancers with idle-connection timeouts that would otherwise abort a slow-but-alive request. `CLAUDE_HEARTBEAT_INTERVAL=30000` (30s) is a reasonable starting value if your downstream has a 60s idle timeout.

Heartbeats are inert SSE comment lines — conforming SSE clients ignore them. If your downstream client's SSE parser crashes on comment frames, leave this disabled (the default) and file an issue so we can consider an alternate frame format.

OCP also sends `X-Accel-Buffering: no` on SSE responses so nginx-default proxy buffering does not hold heartbeats in an upstream buffer.

### Runtime settings (no restart needed)

Many tunables can be changed live via `ocp settings <key> <value>` (or `PATCH /settings`) without restarting:

```
$ ocp settings maxPromptChars 200000
✓ maxPromptChars = 200000

$ ocp settings maxConcurrent 4
✓ maxConcurrent = 4
```

## LAN & multi-user

Run OCP as a server on an always-on device and reach your one Claude Pro/Max subscription from your own laptops, phones, and Pis across the LAN — with per-key API tokens, per-key usage tracking + quotas, response-cache isolation, and one-command client setup (`ocp connect` / `ocp-connect`). A shared **anonymous key** covers simple trusted-family sharing.

```bash
node setup.mjs --bind 0.0.0.0 --auth-mode multi
ocp keys add laptop     # then: ocp lan  → prints the LAN IP + connect command
```

⚠️ The per-key modes give usage tracking, quotas, and cache separation — **not** a security isolation boundary. The spawned `claude` runs with the operator's filesystem access and is not sandboxed per key, so only share with people you fully trust, on a trusted network. Pro/Max are per-user accounts; pooling across distinct people may violate Anthropic's ToS.

Full server + client handbook, headless OAuth, AI-assisted install prompts, key/quota/anonymous-access management, monitoring dashboard, and the [deployment/security model & honest limits](docs/lan-mode.md#deployment-model--security-read-this): **[docs/lan-mode.md](docs/lan-mode.md)**.

## Subscription-pool (TUI) mode

**Opt-in, single-user only.** `CLAUDE_TUI_MODE=true` serves requests through interactive `claude` (no `-p`, `cc_entrypoint=cli`) so they bill the Pro/Max **subscription pool** instead of the metered Agent SDK path. Because `claude` runs with the operator's filesystem access, it is **single-operator only** — never enable it on a multi-user OCP (it refuses to boot under `AUTH_MODE=multi`).

> **⚠️ Status (as of 2026-07): a hedge, not a necessity.** The 2026-06-15 billing split that made this matter was announced, then **paused on its effective date** — the default `-p` path currently bills your subscription. TUI-mode is kept ready for if/when a reworked change lands (Anthropic has promised advance notice).

Setup, the ~6-second latency floor, real-SSE streaming (`OCP_TUI_STREAM`), the warm-pane pool (`OCP_TUI_POOL_SIZE`), full-tool mode (`OCP_TUI_FULL_TOOLS`), `/health` drift monitoring, and the flip/canary runbooks: **[docs/tui-mode.md](docs/tui-mode.md)**.

## Upgrading

Run **`ocp update`** — it smart-picks the path. A **patch bump** (e.g. `v3.21.0 → v3.21.1`) takes the light path (git pull + npm install + restart); a **cross-minor** jump (e.g. `v3.18 → v3.22`) takes the full path (pre-flight, snapshot, `setup.mjs` with plist env-merge, restart, post-flight `/health` + `/v1/models` verification). `ocp update --check` shows available updates without applying.

Manual flags, rollback (`ocp update --rollback`), snapshots, and the OpenClaw model auto-sync (v3.11.0+): **[docs/upgrading.md](docs/upgrading.md)**.

## Built-in Usage Monitoring

Check your subscription usage from the terminal:

```
$ ocp usage
Plan Usage Limits
─────────────────────────────────────
  Current session       21% used
                      Resets in 3h 12m  (Tue, Mar 28, 10:00 PM)

  Weekly (all models)   45% used
                      Resets in 4d 2h  (Tue, Mar 31, 12:00 AM)

  Extra usage         off

Model Stats
Model          Req   OK  Er  AvgT  MaxT  AvgP  MaxP
──────────────────────────────────────────────────────
opus             5    5   0   32s   87s   42K   43K
sonnet          18   18   0   20s   45s   36K   56K
Total           23

Proxy: up 6h 32m | 23 reqs | 0 err | 0 timeout
```

**Web Dashboard:** open `http://<host>:3456/dashboard` in any browser for real-time per-key usage, request history, plan utilization, and system health (screenshot + details in [docs/lan-mode.md § Monitoring](docs/lan-mode.md#monitoring-server-side)).

### All Commands

```
ocp usage              Plan usage limits & model stats
ocp usage --by-key     Per-key usage breakdown (LAN mode)
ocp status             Quick overview
ocp health             Proxy diagnostics
ocp keys               List all API keys (multi mode)
ocp keys add <name>    Create a new API key
ocp keys revoke <name> Revoke an API key
ocp connect <ip>       One-command LAN client setup
ocp doctor             Health & upgrade-readiness check; primary entry for AI-driven debugging. --json produces a next_action for AI agents.
ocp lan                Show LAN connection info & IP
ocp settings           View tunable settings
ocp settings <k> <v>   Update a setting at runtime
ocp logs [N] [level]   Recent logs (default: 20, error)
ocp models             Available models
ocp sessions           Active sessions
ocp clear              Clear all sessions
ocp restart            Restart proxy
ocp restart gateway    Restart gateway
ocp update             Update to latest version
ocp update --check     Check for updates without applying
ocp --help             Command reference
```

> **Note:** Terminal CLI uses `ocp <command>`; the OpenClaw gateway plugin exposes the same as `/ocp <command>` in Telegram/Discord (see [OpenClaw Integration](#openclaw-integration)).

## Response Cache

OCP can cache responses to avoid redundant Claude CLI calls for identical prompts — useful during development when the same prompt is sent repeatedly.

**Enable** by setting `CLAUDE_CACHE_TTL` (ms), or update at runtime with `ocp settings cacheTTL 300000`:

```bash
export CLAUDE_CACHE_TTL=300000   # cache responses for 5 minutes
```

**How it works:**
- Cache key = SHA-256 of `v2|<keyId or "anon">|model + messages + temperature + max_tokens + top_p`
- **Per-key isolation** — different API keys never share cache entries; anonymous callers share one `anon` pool
- Cache hits return instantly — no Claude CLI process spawned. **Streaming hits** are replayed as multiple SSE chunks (80 codepoints each), not one large delta, so incremental render is preserved
- **`cache_control` bypass** — a request carrying an Anthropic `cache_control` annotation (top-level or nested in `content[]`) skips OCP's cache entirely, so it doesn't interfere with Anthropic-side prompt caching
- **Singleflight stampede protection** — concurrent identical cache-miss requests share one upstream `cli.js` spawn; followers receive byte-identical responses (non-streaming path only; streaming-path singleflight is a known TODO)
- Multi-turn conversations (with `session_id`) are never cached; expired entries are reaped automatically every 10 minutes

**Management:**
```bash
curl http://127.0.0.1:3456/cache/stats   # { "entries": 42, "totalHits": 156, "sizeBytes": 284000, "inflight": 0, "requesters": 0 }
curl -X DELETE http://127.0.0.1:3456/cache   # clear all cached responses
ocp settings cacheTTL 0                       # disable at runtime
```

Cache is **disabled by default** (`CLAUDE_CACHE_TTL=0`). All data is stored locally in `~/.ocp/ocp.db`. **Hash format upgrade in v3.13.0:** legacy `v1` cache rows don't match new `v2`-format lookups; they orphan and are reaped by the TTL cleanup interval within one window — no migration script required.

## Structured Outputs (OpenAI `response_format`)

`/v1/chat/completions` honors OpenAI's [`response_format`](https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format) parameter so OpenAI-SDK clients that require machine-parseable JSON (Home Assistant AI Tasks, Honcho, BYO scripts) get JSON in `choices[].message.content` — not prose.

Supported shapes:

- `response_format: { "type": "json_schema", "json_schema": { "name", "strict", "schema" } }`
- `response_format: { "type": "json_object" }`
- `json_mode: true` — non-standard top-level alias honored by several OpenAI-compatible clients; treated as `json_object`.

When a structured request is detected, OCP:

1. Appends a strict JSON-only steering instruction to the request (no Markdown, no fences, no prose, must begin with `{` or `[`).
2. Extracts the JSON from the model reply (unwraps a stray code fence / prose via a string-aware balanced slice).
3. For `json_schema`, validates the result against the supplied schema (types, `required`, `enum`, `const`, `additionalProperties`, nullability, `items`, `min/maxItems`, and `$ref`/`$defs` + `allOf`/`anyOf`/`oneOf` composition — the shapes the official OpenAI SDK emits via `zodResponseFormat` / `client.beta.chat.completions.parse`). For `json_object`, the whole reply must parse as a single JSON value (a stray brace inside prose is not served as the answer).
4. On a parse/validation miss, retries with a stronger instruction that names the failure, up to `OCP_STRUCTURED_MAX_ATTEMPTS` (default 3).
5. If no valid JSON can be produced, returns OpenAI's assistant **`refusal`** field (`HTTP 200`, `message.content: null`, `message.refusal: "<reason>"`, `finish_reason: "stop"`) — the spec's own mechanism for "the model would not produce the required output" — rather than an invented error type or passing prose through. SDK clients take their written `refusal` branch.

A reply that carries **more than one** top-level JSON value (e.g. `Schema: {…}` then `Answer: {…}`) is rejected as ambiguous rather than silently serving the first — OCP never serves an unvalidated or arbitrarily-chosen extraction.

`message.content` for a structured request is the raw JSON string only — no fences, no reasoning, no wrapper. Non-structured requests are completely unaffected (normal conversational behaviour, streaming included). This is a Class B.1 endpoint extension authorized by ADR 0006; the pure logic lives in [`lib/structured-output.mjs`](./lib/structured-output.mjs) and is unit-tested in `test-features.mjs`.

**Caching & cost.** A structured request can cost up to `OCP_STRUCTURED_MAX_ATTEMPTS` metered `claude` spawns — each retry is a fresh spawn, burning subscription-window quota today and metered credits if the (currently **paused**) 2026-06-15 billing split re-lands (see the billing-policy status note in [How It Works](#how-it-works)) — so this feature adds cost-attack surface. Two guards bound it: (a) identical **concurrent** structured requests share one flight (single-flight dedup, so N callers ≠ N× spawns), and (b) when `CLAUDE_CACHE_TTL > 0`, a **validated** result is cached on a **structured-keyed** hash (the `response_format`/schema is folded into the key, so a JSON reply never collides with the conversational answer and different schemas never share a slot). A refusal is never cached. Operators concerned about cost can lower `OCP_STRUCTURED_MAX_ATTEMPTS` to `1` (no retries) or gate the surface behind per-key quotas (`/api/keys/:id/quota`).
## Images / Multimodal (Vision)

`POST /v1/chat/completions` accepts OpenAI-style multimodal `content` parts, so a
message can carry images alongside text and Claude will actually see them. This
follows OpenAI's [vision](https://platform.openai.com/docs/guides/vision) /
[chat-completions `image_url`](https://platform.openai.com/docs/api-reference/chat/create#chat-create-messages)
request shape — no OCP-invented fields. (Class B.1 endpoint; see ADR 0006.)

Under the hood, when a request carries an image OCP feeds the conversation to the
Claude CLI as Anthropic image blocks over `--input-format stream-json`. Text-only
requests are completely unaffected (unchanged code path).

### Supported input

- **Base64 data URIs** (default, recommended):
  `data:image/png;base64,<...>`. Media types: `image/jpeg`, `image/png`,
  `image/gif`, `image/webp`.
- **Remote `http(s)` URLs** — **off by default**. Set `CLAUDE_IMAGE_ALLOW_URL=1`
  to enable; the URL is passed through to Anthropic (OCP never fetches it itself,
  so there is no OCP-side SSRF surface).
- Images may appear in **any** message in the history (multi-turn), not just the
  last one.
- Non-image, non-text parts (audio, files) are **not** yet supported and are
  replaced with a `[non-text content omitted]` placeholder (deferred to a future
  version).

### Example (base64 data URI)

```bash
curl -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url",
          "image_url": { "url": "data:image/png;base64,iVBORw0KGgoAAA..." } }
      ]
    }]
  }'
```

### Not supported in TUI mode

Multimodal images require the default `-p` spawn path. In **TUI / subscription-pool
mode** (`CLAUDE_TUI_MODE=true`) the CLI is driven interactively and cannot carry
image blocks, so a request with an `image_url` part returns **`400
images_unsupported_in_tui_mode`** rather than silently dropping the image and
answering about something the model never saw. Remove the images, or run OCP
without TUI mode, to use vision.

Images must also live in a **user or assistant** message, not a `system` message
(system content is not forwarded to the CLI as image blocks). An `image_url` part
present only in a system message returns **`400 images_unsupported_in_system_messages`**
for the same reason — fail loudly rather than answer about an unseen image. This matches
the OpenAI vision spec, which does not place images in the system role.

### Limits

Images bypass the text `CLAUDE_MAX_PROMPT_CHARS` budget and are instead bounded by
their own byte/count caps. The **text** in a multimodal request is still subject to
`CLAUDE_MAX_PROMPT_CHARS` (older text is truncated exactly as on the text-only
path — only the image bytes are exempt). All numeric caps are parsed **fail-closed**:
a malformed value (e.g. `CLAUDE_MAX_BODY_SIZE=unlimited` or `=5MB`) is rejected with
a startup warning and the safe default is kept — a misconfigured cap can never
silently disable the guard. Requests that violate a cap get a clear `4xx` (never a
silent drop):

| Cap | Env var | Default | Error |
|-----|---------|---------|-------|
| Request body | `CLAUDE_MAX_BODY_SIZE` | 5 MB | `413` request body too large |
| Per-image bytes | `CLAUDE_MAX_IMAGE_BYTES` | 5 MB | `413` `image_too_large` |
| Total image bytes | `CLAUDE_MAX_IMAGE_TOTAL_BYTES` | 20 MB | `413` `images_too_large` |
| Image count | `CLAUDE_MAX_IMAGES` | 20 | `413` `too_many_images` |
| Unsupported media type | — | — | `400` `unsupported_image_type` |
| Malformed data URI | — | — | `400` `invalid_data_uri` |
| Remote URL while disabled | `CLAUDE_IMAGE_ALLOW_URL` | off | `400` `remote_url_disabled` |

Base64 payloads are large: a 5 MB image is ~6.7 MB as a data URI, so raise
`CLAUDE_MAX_BODY_SIZE` (and, if needed, `CLAUDE_MAX_IMAGE_BYTES`) to admit big
images. Vision support depends on the target model — request a current
vision-capable Claude model.

## OpenClaw Integration

OCP was originally built for [OpenClaw](https://github.com/openclaw/openclaw) and includes deep integration:

- **`setup.mjs`** auto-configures the `claude-local` provider in `openclaw.json` at install time
- **`ocp update`** auto-syncs the `claude-local` model registry from `models.json` (v3.11.0+) — no more stale model dropdowns after upgrades
- **Gateway plugin** registers `/ocp` as a native slash command in Telegram/Discord
- **Multi-agent** — 8 concurrent requests sharing one subscription
- **No conflicts** — uses neutral service names (`dev.ocp.proxy` / `ocp-proxy`) that don't trigger OpenClaw's gateway-like service detection

**Install the gateway plugin:**

```bash
cp -r ocp-plugin/ ~/.openclaw/extensions/ocp/
```

Add to `~/.openclaw/openclaw.json`, then `openclaw gateway restart`:
```json
{
  "plugins": {
    "allow": ["ocp"],
    "entries": { "ocp": { "enabled": true } }
  }
}
```

After installing, use `/ocp` slash commands in your chat: `/ocp status`, `/ocp usage`, `/ocp models`, `/ocp health`, `/ocp keys`, `/ocp keys add <name>`, `/ocp keys revoke <name>`.

## Troubleshooting

The simplest path: ask your AI — paste `Run `ocp doctor` and follow its `next_action`. Tell me if you hit anything that needs human input.` The doctor emits a JSON `next_action` with `ai_executable[]` (commands to run verbatim) and `human_required[]` (usually just OAuth).

**Most common issues:**

- **`EADDRINUSE: port 3456 already in use`** — an old OCP instance is bound. Find it (`lsof -nP -iTCP:3456 -sTCP:LISTEN`) and stop it (`launchctl bootout gui/$(id -u)/dev.ocp.proxy` on macOS, `systemctl --user stop ocp-proxy` on Linux). There is no `ocp stop` — the proxy is a service; `ocp restart` bounces it.
- **`node: command not found` / version error** — OCP needs Node.js 22.5+ (`node --version`).
- **`claude: command not found`** — install the Claude CLI, run `claude auth login`, then re-run `node setup.mjs`.
- **Usage shows "unknown" / 401** — usually an expired Claude CLI session: `claude auth login && ocp restart`. For the *permanent* TUI-mode `Please run /login · API Error: 401` that re-login can't fix, see [docs/troubleshooting.md § permanent TUI-mode 401](docs/troubleshooting.md#tui-401).

**Bootstrap quirks (one-time migrations):**

- **A TUI session vanished right after upgrading OCP** — if a pre-3.21.1 and a post-3.21.1 instance ran on the same host at the same time during an upgrade, the new instance's one-time boot reap can, once, kill an old-format (`ocp-tui-<8hex>`) live TUI session belonging to the still-running old instance. Restart the affected session (`ocp restart` or re-run your TUI turn) and it returns under the new instance's port-scoped naming.
- **OpenClaw shows old models after `ocp update` (v3.10→v3.11 only)** — the running shell had the old `cmd_update` cached, so the sync hook doesn't fire on that single jump. Run once: `node ~/ocp/scripts/sync-openclaw.mjs && openclaw gateway restart`. Every future update syncs automatically.

Full manual — setup failures, env-var-not-taking-effect-after-restart (launchd bootout+bootstrap vs `kickstart -k`), stuck sessions, "OpenClaw registry out of sync", and the two-layer TUI-mode 401 root cause + fix: **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Repository Layout

Top-level files a contributor or operator may need to know:

| Path | Role |
|------|------|
| `server.mjs` | The proxy itself; every request path lives here. Governed by `ALIGNMENT.md`. |
| `setup.mjs` | First-time installer — verifies Claude CLI, patches OpenClaw config, installs auto-start. |
| `uninstall.mjs` | Reverses the launchd / systemd auto-start install. |
| `keys.mjs` | API-key management module (multi-mode auth: create/list/revoke, quotas, usage tracking). |
| `models.json` | Single source of truth for model IDs, aliases, context windows. See ADR 0003. |
| `ocp` / `ocp-connect` | User-facing CLI wrappers (server-side / client-side respectively). |
| `dashboard.html` | Static dashboard served from `/dashboard`. |
| `scripts/sync-openclaw.mjs` | Idempotent OpenClaw registry sync invoked by `ocp update`. See ADR 0004. |
| `.claude/skills/` | Project-specific Claude Code skills. |
| `ocp-plugin/` | OpenClaw gateway plugin (optional installation). |
| `docs/lan-mode.md` | LAN & multi-user operations manual (server/client setup, keys, quotas, anonymous access, security model). |
| `docs/tui-mode.md` | Subscription-pool (TUI) mode: setup, latency, streaming, warm-pane pool, drift monitoring. |
| `docs/troubleshooting.md` | Full troubleshooting manual, including the permanent TUI-mode 401 root cause + fix. |
| `docs/upgrading.md` | Upgrade manual (`ocp update` paths, rollback, OpenClaw auto-sync). |
| `docs/adr/` | Architecture Decision Records. Read these before proposing governance or SPOT changes — see [`docs/adr/README.md`](docs/adr/README.md). |
| `ALIGNMENT.md` | The constitution. Binding for any `server.mjs` change. |
| `AGENTS.md` / `CLAUDE.md` | Agent and Claude-Code-specific session instructions. |

## Security

- **Localhost by default** — binds to `127.0.0.1`; set `CLAUDE_BIND=0.0.0.0` to enable LAN access
- **3-tier auth** — `none` (trusted network), `shared` (single key), `multi` (per-user keys with usage tracking)
- **Timing-safe key comparison** — prevents timing attacks on API keys and admin keys
- **Admin-only key management** — creating, listing, and revoking keys requires the admin key
- **Public endpoints** — `/health` and `/dashboard` are always accessible without auth
- **No API keys needed** — authentication goes through Claude CLI's OAuth session
- **Keys stored locally** — `~/.ocp/ocp.db` (SQLite), never sent to external services
- **Auto-start** — launchd (macOS) / systemd (Linux)

## Governance

OCP runs under a small set of binding documents so contributions stay aligned with what `cli.js` actually does, not what an LLM thinks it does:

- **[`ALIGNMENT.md`](./ALIGNMENT.md)** — the constitution. Every endpoint OCP exposes must correspond to something `cli.js` actually does, with a line-number citation. Background in [ADR 0002](./docs/adr/0002-alignment-constitution.md).
- **[`.github/workflows/alignment.yml`](./.github/workflows/alignment.yml)** — CI guardrail. Greps `server.mjs` for known-hallucinated tokens and fails the build on any hit. Not suppressible without an `ALIGNMENT.md` amendment PR.
- **[`AGENTS.md`](./AGENTS.md)** — guidelines any AI coding agent (Claude Code / Cursor / Copilot / Codex / Gemini) should read before touching this repo.
- **[`models.json`](./models.json)** — single source of truth for the model registry. See [ADR 0003](./docs/adr/0003-models-json-spot.md).
- **[`docs/adr/`](./docs/adr/)** — architecture decision records explaining why current structure exists.

If you want to contribute: read `ALIGNMENT.md` first, search `cli.js` for the operation you're proposing, and cite the line number in your PR.

## Support OCP

OCP has been **open source from day one** — not a freemium tool, not a commercial product turned open, just open. It will stay that way forever. No paid tiers, no premium features, no "Pro" version locked behind a paywall.

I built it because my family and I needed it. We use OCP every day across our own machines and IDEs — keeping one Claude Pro/Max subscription powering everything, saving the per-token API cost we'd otherwise pay. It's been quietly heartwarming to hear from users online who say OCP has saved them money the same way it saves ours. That's the whole point.

Behind every version are hundreds of hours that don't show up in commits: building it from scratch, adding new features as the Claude Code ecosystem evolves, debugging across Mac / Windows / Linux machines, validating against half a dozen IDEs (Claude Code, Cursor, Cline, OpenCode, Aider, Continue.dev, OpenClaw), tracking down `cli.js` drift, OAuth refresh edge cases, SSE streaming quirks, concurrency leaks, and the occasional incident that turns into a multi-day investigation (the [2026-04-11 alignment drift](./docs/adr/0002-alignment-constitution.md), the [v3.11.1 concurrency leak](./CHANGELOG.md), the v3.12 SSE replay regression).

**The commitment**: this project will keep being updated, keep getting new features, and will stay open source as long as I'm able to maintain it.

**Please try it.** If something breaks or could be better, [open an issue](https://github.com/dtzp555-max/ocp/issues) — feedback is genuinely what keeps the project moving.

And if OCP saves you (or your team, or your family) real money and you'd like to chip in toward the next debugging session:

- ☕ **[Buy me a coffee](https://buymeacoffee.com/dtzp555)**

Donations directly fund the time it takes to keep OCP saving the community money.

## License

MIT — see [`LICENSE`](LICENSE).
