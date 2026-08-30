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
- **`cli.js` alignment + CI guardrail.** LLM-assisted code drifts easily — it's tempting to invent plausible-looking endpoints that `cli.js` doesn't actually use. [`ALIGNMENT.md`](./ALIGNMENT.md) is binding: every endpoint OCP forwards from `cli.js` (Class A) must cite a `cli.js` line. OCP's own compatibility surface — the OpenAI-compatible and administrative endpoints, which have no `cli.js` analogue — is Class B: it cites OpenAI's published specification (the OpenAI-compatible endpoints) or its authorizing ADR (the administrative ones), under the same anti-invention discipline ([ADR 0006](./docs/adr/0006-openai-shim-scope.md)). The [`alignment.yml`](./.github/workflows/alignment.yml) CI workflow blocks PRs that introduce known-hallucinated tokens. The payoff is boring: your setup keeps working when `cli.js` ships its next minor.
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

**Prerequisites:** macOS or Linux (Windows is not supported), Node.js 22.13+ or 23.4+ (Node 24+ is what CI and the reference fleet run), `git`, and the [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) — new enough to have `--system-prompt-file`, which OCP passes on every spawn since v3.32.0. There is still no *version* floor — no minimum has been established, so this statement is deliberately version-free — but since [#455](https://github.com/dtzp555-max/ocp/issues/455) OCP **checks the capability at boot** and refuses to start if your CLI rejects a flag it passes, so you will find out at startup rather than on your first request — authenticated:

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

**Verify** — should list 7 models:

```bash
curl http://127.0.0.1:3456/v1/models
# claude-opus-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-5, claude-sonnet-4-6, claude-haiku-4-5-20251001
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

**Offering tools is fine; *forcing* a tool call gets a 400.** Because OCP never emits `tool_calls`, a request that *requires* one cannot be answered correctly, so it is refused rather than answered with prose that claims the turn ended normally:

| Request | OCP |
|---|---|
| `tools` with no `tool_choice`, or `tool_choice` `"auto"` / `"none"` / `allowed_tools` `mode: "auto"` | **served normally** — text, `finish_reason: "stop"` |
| `tool_choice` `"required"`, `{"type":"function"}`, `{"type":"custom"}`, or `allowed_tools` `mode: "required"` | **`400`** — `error.code: "unsupported_parameter"`, `error.param: "tool_choice"` |
| legacy `function_call: {"name": …}` | **`400`**, same shape, `error.param: "function_call"` |

Simply sending a tool list is never an error — that is the common case (every OpenClaw turn carries one) and it is unchanged. Only the instruction OCP cannot obey is refused, and it is refused loudly so a client can fall back to another provider or retry with `"auto"` instead of silently receiving a wrong answer. See [ADR 0013](docs/adr/0013-no-openai-tool-calling.md) for why this is a refusal rather than an implementation.

Any tool use happens server-side, under the `--allowedTools` set configured on the OCP host. In default mode (no `CLAUDE_NO_CONTEXT`), the `claude` CLI's own built-in tools are available to the model; in TUI mode, the operator controls the tool surface via `OCP_TUI_FULL_TOOLS`. Either way, the tools run under the operator's credentials on the server, and the client sees only the final text output. Note that on the `-p` path OCP prepends a system-prompt wrapper telling the model it has **no** local access (right for a shared gateway) — a single-user loopback instance whose model *should* use its tools can flip this with `OCP_LOCAL_TOOLS=1` (see Environment Variables).

**Client-local tool execution is not supported by design.** Supporting it would require bypassing the `claude` CLI to call the raw Anthropic API directly — that is a different product, and is out of scope per `ALIGNMENT.md` (every OCP endpoint must correspond to something `cli.js` actually does).

**What this means for choosing OCP (workload fit).** LAN/multi-device OCP is built for **chat-class** workloads — Q&A, translation, scripting against the API, chat frontends, home-automation backends — where text in/text out is the whole job. It is **not** the right tool for a coding agent running on a *client* machine that needs the AI to read and edit *that machine's* files: tools execute on the OCP host, so the model can never touch the client's filesystem. For that workload, run `claude` (or a local OCP) directly on the machine where the code lives.

## Available Models

| Model ID | Context window | Notes |
|----------|---------------:|-------|
| `claude-opus-5` | 1M | Most capable (default for `opus` alias) |
| `claude-opus-4-8` | 1M | Previous Opus, retained for pinning |
| `claude-opus-4-7` | 1M | Older Opus, retained for pinning |
| `claude-opus-4-6` | 200k | Older Opus, retained for pinning |
| `claude-sonnet-5` | 1M | Latest Sonnet (default for `sonnet` alias) |
| `claude-sonnet-4-6` | 200k | Previous Sonnet, retained for pinning |
| `claude-haiku-4-5-20251001` | 200k | Fastest, lightweight (default for `haiku` alias) |

Context windows match the Claude Code CLI registry. Each model's prompt truncation ceiling is
derived from its own window (`contextWindow × 3` chars) — see [ADR 0011](docs/adr/0011-per-model-prompt-char-budget.md)
and `CLAUDE_MAX_PROMPT_CHARS` in [Environment Variables](#environment-variables).

The canonical list lives in [`models.json`](./models.json) — the single source of truth as of v3.11.0, validated in CI against [`models.schema.json`](./models.schema.json). Both `server.mjs` (the `/v1/models` endpoint) and `setup.mjs` (the OpenClaw registration) derive from it. Adding a new model is now a one-file edit:

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
| `/health` | GET | Comprehensive health check (includes a `tui` block for TUI-mode drift/concurrency monitoring, an `auth` block — see § "What `auth.ok` means" — and `instanceName` — see § "Running more than one instance on a host") |
| `/usage` | GET | Plan usage limits + per-model stats |
| `/status` | GET | Combined overview (usage + health) |
| `/settings` | GET/PATCH | View or update settings at runtime |
| `/logs` | GET | Recent log entries (`?n=20&level=error`) |
| `/dashboard` | GET | Web dashboard (always public) |
| `/api/keys` | GET/POST | List or create API keys (admin only). `POST` body must be a JSON object — `{}` auto-names, `{"name":"…"}` names; anything else is `400` ([ADR 0017](./docs/adr/0017-api-keys-request-shape.md)) |
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
| `OCP_ALLOWED_HOSTS` | *(empty)* | Comma-separated `host[:port]` this proxy is served on. Only needed when a browser reaches it at a **public DNS name** — IP literals, `localhost` and `*.local` need no declaration because neither can be pointed at loopback by public DNS. Also required behind a reverse proxy that rewrites `Host` (nginx's default `proxy_pass`; Caddy preserves it). See [ADR 0020](docs/adr/0020-declared-hosts.md). |
| `CLAUDE_AUTH_MODE` | `none` | Auth mode: `none`, `shared`, or `multi` |
| `OCP_ADMIN_KEY` | *(unset)* | Admin key for key management (multi mode) |
| `CLAUDE_BIN` | *(auto-detect)* | Path to claude binary |
| `CLAUDE_TIMEOUT` | `600000` | Request timeout (ms, default: 10 min) |
| `CLAUDE_HEARTBEAT_INTERVAL` | `0` | Streaming SSE keepalive interval (ms). `0` = disabled. See ["Streaming heartbeat"](#streaming-heartbeat) below. |
| `CLAUDE_MAX_CONCURRENT` | `8` | Max concurrent claude processes (`-p`/stream-json path) |
| `CLAUDE_MAX_QUEUE` | `16` | Max requests **waiting** for a `-p` concurrency slot. Beyond `CLAUDE_MAX_CONCURRENT`, requests queue (up to this cap) instead of being rejected; when the queue is **also** full, the request gets `HTTP 429` + `Retry-After` (not an opaque 500). Surfaced on `/health.concurrency` + `/health.stats.queueRejections`. |
| `CLAUDE_QUEUE_RETRY_AFTER` | `5` | Seconds advertised in the `Retry-After` header on a `-p` concurrency-overflow `429`. |
| `CLAUDE_MAX_PROMPT_CHARS` | *(derived per model)* | Prompt truncation limit in chars. By default there is **no single limit**: each request is bounded by the named model's own `contextWindow × 3` from the models.json SPOT — **3,000,000** for the native-1M models (`claude-opus-5`, `-4-8`, `-4-7`, `claude-sonnet-5`) and **600,000** for the 200k models (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Setting this env var (or `ocp settings maxPromptChars`) overrides the derivation absolutely, applying that one number to **every** model. See [ADR 0011](docs/adr/0011-per-model-prompt-char-budget.md) (supersedes [ADR 0009](docs/adr/0009-spot-derived-prompt-budget.md)'s single global ceiling). Note: very large prompts burn subscription-window quota quickly and slow TTFT; the TUI-mode paste path is untested beyond ~hundreds of KB. Applies to **text only** — image bytes bypass this budget (see [Images / Multimodal](#images--multimodal-vision)). |
| `OCP_STRUCTURED_MAX_ATTEMPTS` | `3` | Max attempts (initial + retries) to coerce a schema-valid JSON reply when a request uses OpenAI `response_format`. Fail-closed: a non-numeric value keeps the default. See [Structured Outputs](#structured-outputs-openai-response_format). |
| `CLAUDE_AUTH_CHECK_INTERVAL_MS` | `600000` | How often the background `claude auth status` probe runs (ms, default: 10 min). Lower it for faster detection of a real credential outage — the verdict needs **2 consecutive** conclusive rejections, so onset is reported within roughly one interval. Fail-closed parsing: an empty/garbage value keeps the default. Probe outcome is surfaced on `/health.auth.lastOutcome` (`authenticated`/`token-present`/`rejected`/`timeout`/`unavailable`) and the running tally on `/health.auth.consecutiveFailures`, so an operator can tell a host-load timeout from a real credential rejection. **`token-present` is not `authenticated`** — see § "What `auth.ok` means". See [ADR 0010](docs/adr/0010-health-verdict-semantics.md) and [ADR 0014](docs/adr/0014-auth-verdict-measures-what-it-measured.md). |
| `CLAUDE_AUTH_CHECK_TIMEOUT_MS` | `10000` | Per-probe timeout for that same probe (ms). The probe runs **asynchronously** and never blocks request serving; this only bounds a stuck child. A probe killed by this timeout is **inconclusive** — it measures host load, not credentials, so it never changes `/health.status` or `auth.ok`. Fail-closed parsing: an empty/garbage value keeps the default. |
| `CLAUDE_CACHE_TTL` | `0` | Response cache TTL (ms, 0 = disabled). Set to e.g. `300000` for 5-min cache. See [Response Cache](#response-cache). |
| `CLAUDE_ALLOWED_TOOLS` | `Bash,Read,...,Agent` | Comma-separated tools to pre-approve |
| `CLAUDE_SKIP_PERMISSIONS` | `false` | Bypass all permission checks |
| `CLAUDE_MCP_CONFIG` | *(unset)* | Path to an MCP server config JSON, passed to the spawned `claude` as `--mcp-config` (both the `-p` path and TUI `OCP_TUI_FULL_TOOLS` panes) |
| `CLAUDE_MAX_BODY_SIZE` | `5242880` | Max request body size, counted in **characters** (UTF-16 code units), not bytes — the body is accumulated as a JS string, so a multi-byte payload can be several times this size on the wire and still be admitted (5,242,880 CJK characters is ~15 MB). Base64 image payloads are ASCII, so for those the two counts coincide and the ~33% base64 inflation applies as written; raise this to admit larger multimodal requests. Fail-closed parsing: a garbage value keeps the default. |
| `CLAUDE_IMAGE_ALLOW_URL` | `false` | Allow remote `http(s)` image URLs in `image_url` parts. **Off by default** (v1 supports base64 `data:` URIs only). When on, the URL is passed through to Anthropic as a `url` image source — **OCP does not fetch it** (no OCP-side SSRF surface); unreachable/blocked URLs surface as an API error. |
| `CLAUDE_MAX_IMAGE_BYTES` | `5242880` | Per-image decoded-byte cap (default 5 MB). Over-cap images get `HTTP 413`. |
| `CLAUDE_MAX_IMAGES` | `20` | Max image parts per request. Over-cap gets `HTTP 413`. |
| `CLAUDE_MAX_IMAGE_TOTAL_BYTES` | `20971520` | Aggregate decoded-byte cap across all images in a request (default 20 MB). Over-cap gets `HTTP 413`. |
| `CLAUDE_SYSTEM_PROMPT` | *(unset)* | Operator-wide system-prompt text appended (last) to every request's composed system prompt on the default `-p` path. TUI-mode panes are unaffected (they keep the interactive CLI's own system prompt). Echoed truncated on `/health.systemPrompt`. Note: changing this value and restarting auto-invalidates the response cache (the key carries a boot-config epoch, #177). |
| `OCP_LOCAL_TOOLS` | *(unset)* | **Single-user, loopback only.** `=1` swaps the default *"you have no local filesystem/shell access"* system-prompt wrapper for a positive one telling the model it **may** use its tools. These are the **server-side `claude` tools** OCP spawns via `-p` (`--allowedTools`) — which, on a loopback instance, run on the operator's own machine, i.e. *local* tools. For a personal instance (e.g. an **OpenClaw** agent on its own local OCP) the default wrapper otherwise makes the model refuse to use tools it legitimately has. Changes **only the prompt**, never the tool surface (governed by `--allowedTools`/`--disallowedTools`; multi-tenant passes `--tools ""`, which empties the built-in tool schema outright rather than enumerating what to deny). **Does not** enable client-side `tool_calls` for OpenClaw/Cline/etc. — that remains unsupported by design (see § How tools work). Fail-closed: OCP **refuses to boot** if `=1` is combined with `CLAUDE_AUTH_MODE=multi`, a non-loopback bind, or `PROXY_ANONYMOUS_KEY` (mirrors `OCP_TUI_FULL_TOOLS`, ADR 0007). **Inert in TUI mode** (the `-p` wrapper is unused there; the TUI tool surface is `OCP_TUI_FULL_TOOLS`) — a warning is logged. Off by default → the default path is byte-for-byte unchanged. Toggling it auto-invalidates the standard response cache (boot-config epoch, #177). |
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
| `OCP_INSTANCE_NAME` | *(empty)* | Operator label for a NON-primary instance, reported on `/health` as `instanceName`. Empty means the primary. The **server** never branches on the value; `ocp doctor` reads the declaration off the unit file to tell a deliberate second instance from a leftover duplicate — see § "Running more than one instance on a host". |
| `OCP_TUI_STREAM_HOLDBACK` | `100` | (TUI-mode, streaming) Characters withheld before the first chunk — keeps the auth-banner gate alive and is the knob for tool-using turns. See [docs/tui-mode.md § `OCP_TUI_STREAM_HOLDBACK`](docs/tui-mode.md#ocp-tui-stream-holdback). |
| `OCP_TUI_STREAM_DIR` | `$HOME/.ocp-tui/stream` | (TUI-mode, streaming) Directory for the hook script/settings + per-session delta sink (one sink per session-id, so concurrent turns never interleave). See [docs/tui-mode.md](docs/tui-mode.md#ocp-tui-stream). |
| `OCP_TUI_STREAM_POLL_MS` | `100` | (TUI-mode, streaming) Interval at which OCP drains the delta sink; the hook fires at block granularity so a finer poll buys nothing. See [docs/tui-mode.md](docs/tui-mode.md#ocp-tui-stream). |
| `OCP_TUI_MAX_CONCURRENT` | `2` | (TUI-mode) Max concurrent interactive TUI turns, independent of `CLAUDE_MAX_CONCURRENT`. Excess turns queue (bounded); a full queue yields 503. See [docs/tui-mode.md](docs/tui-mode.md#tui-other-vars). |
| `OCP_TUI_POOL_SIZE` | `0` (off) | (TUI-mode) Number of pre-booted warm `claude` panes (max `32`) so a request skips the cold boot — measured p50 `10.17s` → `6.00s`. Each warm pane is a live idle process; panes are single-use. Keep it small on a small host. See [docs/tui-mode.md § `OCP_TUI_POOL_SIZE`](docs/tui-mode.md#ocp-tui-pool-size). |
| `CLAUDE_CAPABILITY_PROBE_TIMEOUT_MS` | `10000` | Budget for the boot-time capability probe ([#455](https://github.com/dtzp555-max/ocp/issues/455)). ~50× the measured cost (0.17–0.21 s), sized generously on purpose: overrunning it yields `inconclusive`, which **warns and boots**, so a tight value would silently turn the gate off on a loaded host rather than failing visibly. |
| `OCP_SKIP_CAPABILITY_PROBE` | *(unset)* | When `=1`, skip the boot-time `claude` capability probe ([#455](https://github.com/dtzp555-max/ocp/issues/455)). The probe spawns `claude` once at startup with OCP's **real** spawn argv and a deliberately missing `--system-prompt-file`, and refuses to start only if the CLI answers `unknown option '--<flag>'` — i.e. only on observed absence. It costs no quota (no model turn; measured 0.18–0.21 s) and anything it cannot classify is logged as a warning and boots. Set this if you want to run against a CLI you know is missing a flag, and accept that every request will fail. |
| `OCP_SKIP_AUTH_TEST` | *(unset)* | When `=1`, skip the `claude -p` auth probe during `setup.mjs`. Under the announced (currently **paused**) 2026-06-15 billing split this probe would draw from the metered Agent SDK credit pool; set this to avoid burning a probe on re-installs or `ocp update` runs. Auth is validated at the first real request. |
| `OCP_TUI_FULL_TOOLS` | *(unset)* | (TUI-mode, **single-user only**) `=1` grants the interactive session the same tool surface as the `-p` path (`--allowedTools` + optional `--mcp-config`) so a trusted single operator can run a tool-using / MCP agent on the subscription pool. Safe because TUI refuses to boot under `AUTH_MODE=multi`. See [docs/tui-mode.md § `OCP_TUI_FULL_TOOLS`](docs/tui-mode.md#ocp-tui-full-tools). |
| `OCP_TUI_TOOLS` | *(unset)* | (TUI-mode) Restrict which **built-in** tools the interactive pane may use, via `claude --tools` (e.g. `Read,Glob,Grep,WebSearch,WebFetch`). `--tools` is the tool-*availability* registry, not a permission layer, so an omitted tool is simply never offered and cannot hang a headless pane on an unanswerable permission prompt. Unset, empty or whitespace-only = all built-in tools available (default). Applies to the default MCP-walled surface only (not `OCP_TUI_FULL_TOOLS`, whose surface is `CLAUDE_ALLOWED_TOOLS` or its hardcoded default set). Narrows what the model is *offered*; it is not a trust boundary. See [docs/tui-mode.md § `OCP_TUI_TOOLS`](docs/tui-mode.md#ocp-tui-tools). |
| `OCP_DIR` | *(auto)* | **Tooling only — the server never reads it.** Absolute path to the OCP install directory, used by `ocp doctor` and `ocp update`. Normally unnecessary: the maintenance scripts resolve the install from their own file location, so an install at `/opt/ocp`, or one driven under `sudo` (where `$HOME` is `/root`), is found without configuration. Set it only to override that resolution. A **relative** value is refused (and the `install_dir` check is raised to WARN so you see the refusal). `ocp doctor` prints the directory it actually used — and where that answer came from — on its `install_dir` line either way. **Not a free-form path:** the fresh-install path starts with `rm -rf <install dir>`, so a directory is only accepted as a deletion target when it is absent, empty, or verifiably an OCP install (`package.json` named `open-claude-proxy`, or ≥2 of `server.mjs`/`setup.mjs`/`ocp`/`models.json`); anything else is refused before any step runs. See [Troubleshooting § "`ocp update` wants a fresh install"](docs/troubleshooting.md#update-fresh-install). |

### What `auth.ok` means

`/health`'s `auth` block answers "can this proxy authenticate", and it is deliberately conservative about saying yes. Two pairs of fields, deliberately separate: **`okSource` / `okAt`** say how and when `auth.ok` was established, while **`lastOutcome` / `lastCheck`** describe the last probe. A probe that cannot conclude updates only the second pair.

**The table is keyed on `okSource`**, because that is the field the verdict's meaning turns on. `lastOutcome` describes the probe, and the probe is not always what set `auth.ok`.

| `okSource` | `auth.ok` | `lastOutcome` | what was actually established |
|---|---|---|---|
| `none` | `null` | `none` | no probe has completed yet — the state at boot |
| `probe` | `true` | `authenticated` | the probe ran and the child resolved its own credential from a file or the keychain |
| `probe` | `null` | `token-present` | a token was in the child's environment and the probe exited 0. **That proves presence, not validity** |
| `probe` | `false` | `rejected` | the probe ran to completion and the credential was refused |
| `request` | `true` | *preserved* | a real completion succeeded — the strongest evidence available, and free |
| `expired` | `null` | *preserved* | a request established it, but longer ago than the freshness window: "it worked; we do not know now" |

**`lastOutcome` is not part of the request-verified verdict, and that is deliberate.** A completed request sets `okSource: "request"` and leaves `lastOutcome` exactly as the probe last set it — overwriting it would make `/health` claim a probe ran when none did. So on a host that supplies the token through the environment, the **steady state is `okSource: "request"` + `lastOutcome: "token-present"`**, and that pairing is normal rather than contradictory. It is also the state three of the four instances in the reference fleet spend most of their time in.

> **There is no `lastOutcome: "verified-by-request"`.** Earlier revisions of this table, of ADR 0014 and of the CHANGELOG all promised one; the server has never emitted it and by design never will (see the paragraph above). A monitor written against that value could not match any real response. **Key on `okSource: "request"`.** Corrected in #342.

**Inconclusive probes are not a row here**, because they leave the verdict alone: a `timeout` or `unavailable` writes `lastOutcome`, `lastCheck`, `message` and `consecutiveInconclusive`, and leaves `ok`, `okSource` and `okAt` untouched. That is the point — a probe killed by host load measured load, not the credential.

**Why `token-present` is not `authenticated`.** `claude auth status` exits 0 whenever a token is present, without checking it: a fabricated token yields exit 0 and `loggedIn: true`. On a host that supplies `CLAUDE_CODE_OAUTH_TOKEN` through a systemd `EnvironmentFile` or an inlined unit — which is how OCP is normally deployed on Linux — the probe therefore cannot distinguish a working credential from an expired one. Reporting `authenticated` there is what issue #308 found: `/health` asserting the proxy was authenticated while every request failed on authentication. See [ADR 0014](docs/adr/0014-auth-verdict-measures-what-it-measured.md).

**A `null` is not a failure.** It means no conclusive verdict, `ocp doctor` reports it as WARN rather than FAIL, and it does not block `ocp update`. On such a host the first successful request moves it to `true`.

**`auth.ok` never moves `status`.** `proxyHealthStatus` reads `consecutiveFailures` and never `ok`, so no verdict in the table above can flip a host to `degraded`.

**The tally it reads is a different matter, and this is the part worth knowing.** Conclusive probe *rejections* raise `consecutiveFailures` (ADR 0010), and **any successful request clears it** — a deliberate restoration of ADR 0010's self-heal, unqualified by which lane served the request (see [ADR 0014](docs/adr/0014-auth-verdict-measures-what-it-measured.md) § Consequences). So a host reporting `degraded` can return to `ok` on the first request that succeeds, with no probe having run in between. If you are debugging `status` — `ocp update`'s post-flight check and the dashboard's status card both read it, and the dashboard has no other auth signal — do not assume it is probe-driven only.

*(This paragraph said "**`status` is unaffected by any of this** … never by `auth.ok`" until #361. The second clause was true and the bolded headline was not: it read as though nothing in this section could touch `status`, while a successful request has always cleared the tally that decides it.)*
### Running more than one instance on a host

`DEFAULT_PORT` (3456) is the primary and never changes — it is the single source of truth in `lib/constants.mjs`, and CI hard-fails any other port literal in source. A host that needs a **second** instance takes `DEFAULT_PORT + n` in allocation order, and **must declare itself**:

```ini
# /etc/systemd/system/ocp-<name>.service
Environment=OCP_INSTANCE_NAME=<name>
Environment=CLAUDE_PROXY_PORT=3457
Environment=CLAUDE_BIND=127.0.0.1
User=<the identity this instance's spawns should have>
```

The name appears on `/health` as `instanceName` (empty string on the primary), so an instance is discoverable from the outside rather than only by reading the box's unit files.

**The reason a second instance exists at all is Unix identity, not load.** OCP spawns a `claude` child per request and that child inherits the *service's* identity. An agent that answers untrusted users therefore needs its own instance under its own user — otherwise a prompt injection runs with whatever the primary's account can do. This cannot be solved inside one process: the spawn identity comes from the unit's `User=`, so it is one identity per unit.

**Two things this convention exists to prevent**, both of which happened:

- A version sweep that probes only `:3456` reports the fleet clean while a second instance sits a release behind. Enumerate declared instances, not hosts.
- `ocp doctor`'s multi-unit check could not tell a deliberate second instance from a leftover duplicate, so it warned on a correct configuration every run — and a warning that always fires is one people learn to skip. On the host that reported this, a genuine leftover duplicate was sitting next to the intended instance and the permanent false alarm is what buried it.

**What `ocp doctor` does with the declaration.** The multi-unit check reads `OCP_INSTANCE_NAME` **from each unit file** — `Environment=` on systemd, the `EnvironmentVariables` dict in a launchd plist — never from `/health`. That is deliberate: `doctor` runs before and around a restart, and a leftover duplicate is typically *enabled but not running*, so the live endpoint cannot see the one thing the check exists to find. A host's enabled OCP units are **resolved** when every unit is distinguishable from every other by both the port it binds and the identity it claims. On a host with **more than one** enabled OCP unit, `doctor` then reports one of three things (a host with one unit, or none, says nothing — the question never arises):

| What it finds | What it says |
|---|---|
| Two or more units on the **same port** | WARN — a boot race, exactly as before. A declaration never silences this: two processes cannot share a port however well they are labelled. |
| Two or more units claiming the **same identity** on different ports | WARN — undeclared multiplicity. Both can start, so nothing breaks loudly; the host simply cannot say which is intended. An absent `OCP_INSTANCE_NAME` **is** a claim to be the primary, so two undeclared units collide here. |
| Every unit distinct on both | INFO — a one-line inventory (`"ocp.service" :3456 (primary), "ocp-wifibot.service" :3457 ("wifibot")`), so "verified correct" and "nothing looked" are not the same silence. |

Declaring the extra instance is therefore the cheaper of the two remedies — it costs one `Environment=` line and loses nothing — and disabling the unit you did not want is the other. `doctor` nominates neither: which one is intended is not something it can know.

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

`maxPromptChars` is a **global** override: setting it pins the truncation ceiling to that one
number for every model, replacing the per-model derivation. Left unset, `ocp settings` reports
the fallback (600,000) and each model uses its own `contextWindow × 3`. There is no way to
clear the override back to per-model derivation over `PATCH` — restart without
`CLAUDE_MAX_PROMPT_CHARS` to do that. See [ADR 0011](docs/adr/0011-per-model-prompt-char-budget.md).

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

Run **`ocp update`** — it smart-picks the path. If the tree is already at the latest release but the **running service** is stale (e.g. a previous update was interrupted before it restarted), it takes a **restart-only** path: no git/npm changes, just a restart + post-flight `/health` verification. A **patch bump** (e.g. `v3.21.0 → v3.21.1`) takes the light path (git pull + npm install + restart); a **cross-minor** jump (e.g. `v3.18 → v3.22`) takes the full path (pre-flight, snapshot, `setup.mjs --reconfigure-only` — writes the service unit/plist with env-merge but does not itself start anything — then a dedicated restart phase, then post-flight `/health` + `/v1/models` verification). `ocp update --check` shows available updates without applying.

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

Cache is **disabled by default** (`CLAUDE_CACHE_TTL=0`). All data is stored locally in `~/.ocp/ocp.db`. **Cache keys resolve model aliases as of v3.25.0:** a request for an alias (`opus`, `sonnet`, `haiku`, or a legacy alias like `claude-haiku-4-5`) is now keyed on the canonical model it resolves to, not on the string the client sent. Two consequences, both one-time and self-healing: rows written before the upgrade don't match the new lookups, so they orphan and are reaped by the TTL cleanup interval within one window — no migration script required; and an alias now correctly shares a cache slot with its canonical id, since both produce an identical spawn. Scope: for the **normal** cache only alias-addressed rows rekey — rows keyed on a literal model id keep matching, *unless* you run `OCP_LOCAL_TOOLS=1`, in which case the whole normal cache rekeys once because v3.25.0 also reworded that wrapper and the wrapper text feeds the config epoch. **Every structured-output row rekeys regardless**, since the same change folds the config epoch into the structured key, which it previously omitted. This is what makes an alias repoint (such as v3.25.0's `opus` → `claude-opus-5`) take effect immediately instead of being masked by the cache until TTL expiry. **Hash format upgrade in v3.13.0:** legacy `v1` cache rows don't match new `v2`-format lookups; they orphan and are reaped by the TTL cleanup interval within one window — no migration script required.

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
| Request body | `CLAUDE_MAX_BODY_SIZE` | 5,242,880 characters | `413` request body too large |
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
- **`node: command not found` / version error** — OCP needs Node.js 22.13+ (`node --version`). The floor is 22.13 and not 22.5 because `keys.mjs` imports `node:sqlite` at module load and `server.mjs` imports `keys.mjs` at module load, so a Node that needs `--experimental-sqlite` cannot start OCP at all — and nothing on the launch path passes that flag. Node removed the flag requirement in **v22.13.0** and **v23.4.0** (see nodejs.org/api/sqlite.html § History) — so **23.0–23.3 are also excluded**, which is why the declared range is `>=22.13.0 <23.0.0 || >=23.4.0` and not a single floor.
- **`claude: command not found`** — install the Claude CLI, run `claude auth login`, then re-run `node setup.mjs`.
- **OCP refuses to start with `FATAL: this build of \`claude\` does not support --<flag>`** — your Claude CLI is missing a flag OCP passes on every request, so every request would 500. Run `claude update` (or reinstall the CLI) and start OCP again. This is the **boot-time capability probe** ([#455](https://github.com/dtzp555-max/ocp/issues/455)): OCP builds its real spawn argv, points `--system-prompt-file` at a path that does not exist, and reads which of the two errors comes back — `System prompt file not found` (every flag known) or `unknown option '--x'` (one is not). It costs no quota, because the CLI stops at argument validation without starting a model turn. **Only an observed `unknown option` refuses the boot**; a missing binary, a slow host, or an unfamiliar message logs `claude_capability_probe_inconclusive` and starts normally, so the gate can never brick a fleet on an ambiguous reading. Set `OCP_SKIP_CAPABILITY_PROBE=1` to disable it.
- **Every request returns 500 with `error: unknown option '--system-prompt-file'`** — the same cause, on an instance where the probe is disabled or inconclusive. OCP passes the system prompt as a file rather than on the command line (see [Security](#security)); the flag is measured working on `claude` **2.1.233+** and is absent from `claude --help`'s option list, so you cannot confirm it there. Run `claude update` and restart OCP.
- **Stray `ocp-sysprompt-*.txt` files in your temp directory** — OCP writes the system prompt to a `0600` temp file per request (it is passed as `--system-prompt-file`, not in argv — see [Security](#security)) and removes it when the turn ends. A **hard kill** of the proxy (`SIGKILL`, a crash, a power loss) skips that cleanup, so one file per in-flight request can survive. They are owner-only and harmless; delete them if you like. Normal restarts, timeouts, spawn failures and client disconnects all clean up.
- **Usage shows "unknown" / 401** — usually an expired Claude CLI session: `claude auth login && ocp restart`. For the *permanent* TUI-mode `Please run /login · API Error: 401` that re-login can't fix, see [docs/troubleshooting.md § permanent TUI-mode 401](docs/troubleshooting.md#tui-401).
- **`ocp update` refuses to restart** (`could not determine what ... owns the OCP port`, `not managed by any systemd unit`, `nothing is currently listening`, a sudo message, or a rollback-scope message) — deliberate: the restart phase resolves which unit actually owns the port and refuses rather than guesses when it can't tell, or when guessing would be unsafe. See [docs/troubleshooting.md § restart refusal](docs/troubleshooting.md#restart-target-refusal) for what each message means and how to proceed.

- **The dashboard's "add key" / "revoke key" silently does nothing, or returns 403 `forbidden_origin`** — you are reaching OCP at a **public DNS name** (`ocp.example.com`), or through a reverse proxy that rewrites `Host`. Declare the name you serve it on:

  ```
  OCP_ALLOWED_HOSTS=ocp.example.com
  ```

  Write the **bare host** when the scheme's own default port is in use — `Origin` omits it, so `ocp.example.com:443` will not match an `https://ocp.example.com` dashboard (OCP flags this at boot). It *is* correct if you serve **plain HTTP on 443**, which is why OCP warns rather than rejects: a declaration carries no scheme, so OCP cannot tell the two apart. Use `host:port` for any non-default port.

  Loopback, LAN addresses, `[::1]`, Tailscale addresses, `localhost` and `*.local` names need **no** declaration — none of them can be pointed at your loopback by public DNS, which is the thing this setting exists to stop ([ADR 0020](docs/adr/0020-declared-hosts.md)). Behind nginx you likely also want `proxy_set_header Host $host;`; Caddy preserves `Host` already.

**Bootstrap quirks (one-time migrations):**

- **Every request started returning 500 `error: unknown option '--system-prompt-file'` after upgrading to v3.32.0** — v3.32.0 stopped putting the system prompt on the command line, because argv is world-readable on Linux (`/proc/<pid>/cmdline`), and passes it as a `0600` file instead ([#453](https://github.com/dtzp555-max/ocp/issues/453)). Your Claude CLI predates the `--system-prompt-file` flag. Run `claude update` (or reinstall the CLI) and restart OCP. Measured working on `claude` **2.1.233+**; the flag is absent from `claude --help`'s option list, so you cannot confirm it there, and since [#455](https://github.com/dtzp555-max/ocp/issues/455) OCP **refuses to start** rather than failing per request when it detects this: the boot log carries `FATAL: this build of `claude` does not support --system-prompt-file`. If you are seeing per-request 500s instead, the boot probe was skipped (`OCP_SKIP_CAPABILITY_PROBE=1`) or returned `claude_capability_probe_inconclusive`.
- **Dashboard mutations started returning 403 after upgrading to v3.31.0** — v3.31.0 stopped letting an **undeclared public DNS name** vouch for itself, because that shape is indistinguishable from DNS rebinding ([ADR 0020](docs/adr/0020-declared-hosts.md), #446). If your dashboard lives at a real domain, set `OCP_ALLOWED_HOSTS` to it once and restart. Nothing reached by IP, `localhost`, `*.local` or Tailscale is affected.
- **A TUI session vanished right after upgrading OCP** — if a pre-3.21.1 and a post-3.21.1 instance ran on the same host at the same time during an upgrade, the new instance's one-time boot reap can, once, kill an old-format (`ocp-tui-<8hex>`) live TUI session belonging to the still-running old instance. Restart the affected session (`ocp restart` or re-run your TUI turn) and it returns under the new instance's port-scoped naming.
- **OpenClaw shows old models after `ocp update` (v3.10→v3.11 only)** — the running shell had the old `cmd_update` cached, so the sync hook doesn't fire on that single jump. Run once: `node ~/ocp/scripts/sync-openclaw.mjs && openclaw gateway restart`. Every future update syncs automatically.
- **Response-cache hit rate drops once after upgrading to v3.25.0** — only if you run with the cache on (`CLAUDE_CACHE_TTL > 0`; it is off by default). v3.25.0 keys the cache on the resolved model instead of the string the client sent, so alias-addressed rows (and *all* structured-output rows) orphan and are reaped by the TTL cleanup within one window. **No action required.** Details: [docs/troubleshooting.md#cache-rekey-v3250](docs/troubleshooting.md#cache-rekey-v3250).
- **`ocp update`'s fresh-install path (pre-v3.4.0 hosts) is execution-unverified and now requires an explicit `--fresh-install` flag, dated 2026-08-01 (issue #227)** — this path (`rm -rf ~/ocp`, a fresh `git clone`, `node setup.mjs`) was dead on `main` until #217 reconnected it as a side effect of an unrelated fix; its kind-detection logic and its `--yes` gate are unit-tested, but the real commands it runs have never executed, in CI or by hand. `ocp update --yes` alone no longer runs it — see [docs/upgrading.md § Old version (< v3.4.0)](docs/upgrading.md) for exactly what is and isn't verified, and run `ocp update --fresh-install --yes` only once you've read that.
- **`start.sh` keeps its pre-issue-#246 bare-`lsof` port check on a host that only ever takes patch bumps** — `start.sh` (the manual launcher; the auto-start service unit/plist never calls it) is regenerated only by `setup.mjs`, which only the full (cross-minor) upgrade path and a fresh install run — `ocp update`'s light/patch-bump path (`_cmd_update_light`) never calls `setup.mjs` and so never rewrites `start.sh`. A host that stays on patch bumps for a while therefore keeps whatever `start.sh` it last got from a full upgrade or install, even after `ocp update`s that already fixed the underlying `scripts/lib/start-sh.mjs` generator. Force a regeneration with `node setup.mjs --reconfigure-only` (writes `start.sh` without enabling/starting the service), or just wait for the next cross-minor upgrade.

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
| `lib/constants.mjs` | Shared constants (default port, loopback host, local proxy URL) — one definition for `server.mjs`, `setup.mjs`, the `scripts/` helpers and `lib/tui/`. The bash CLIs cannot import it and carry a keep-in-sync note instead. |
| `lib/env.mjs` | Fail-closed positive-integer parsing for the numeric env caps (body size, image bytes, …). |
| `lib/multimodal.mjs` | OpenAI `image_url` content parts → Anthropic image blocks for `claude -p --input-format stream-json`. See § "Images / Multimodal (Vision)". |
| `lib/net.mjs` | `isLoopbackBind()` — true only for addresses that **cannot** be reached from another host; anything else (`0.0.0.0`, `::`, a concrete LAN/Tailscale IP) counts as network-exposed. Gates TUI mode (`OCP_TUI_ALLOW_LAN`) and the `OCP_LOCAL_TOOLS` boot check, both of which fail closed on a non-loopback bind. |
| `lib/prompt.mjs` | Pure system-prompt assembly: operator append, per-model truncation budget, wrapper selection. See ADR 0011. |
| `lib/spawn-auth.mjs` | Pure primitives for `-p` spawn-token resolution and HOME isolation (serial mutex, TTL cache, expiry, label ordering). |
| `lib/structured-output.mjs` | OpenAI `response_format` helpers — detection, JSON-Schema validation, payload extraction. Class B.1, ADR 0006. |
| `lib/tool-support.mjs` | `classifyToolRequest()` — which `tools` / `tool_choice` / `function_call` shapes OCP must refuse. See ADR 0013. |
| `lib/tui/` | Subscription-pool (TUI) mode internals: warm-pane pool, semaphore, session, stream, transcript. |
| `scripts/sync-openclaw.mjs` | Idempotent OpenClaw registry sync invoked by `ocp update`. See ADR 0004. |
| `scripts/b2-key-snapshot.mjs` | Records every grandfathered Class B.2 endpoint's response **key set** from the wire (boots a real `server.mjs` against a fixture, probes each endpoint+method pair in `ALIGNMENT.md`'s inventory, records key paths but never values). Two configuration profiles since #357 — `probes` (the default fleet config) and `probesTuiPool` (`CLAUDE_TUI_MODE=true`, `OCP_TUI_POOL_SIZE=1`, `CLAUDE_SKIP_PERMISSIONS=true`), which is what guards `/health`'s `tui.pool` counter bag; both get all 14 pairs and their own coverage check. No real `claude` pane is ever booted: `OCP_TUI_TMUX_BIN` points at a stub `tmux`, and the suite asserts from its log that the only invocation is `list-sessions`. `npm test` fails on any difference from the checked-in snapshot. Run standalone with `node scripts/b2-key-snapshot.mjs`, or `--write` to regenerate after a deliberate, authorized addition (every command covers every profile). |
| `docs/governance/b2-response-keys.json` | The checked-in snapshot, one block per profile. Its git history is the per-release record of how B.2 surface actually grew — `git log -p docs/governance/b2-response-keys.json`. Its `notCovered` block states what the mechanism cannot see; read it before treating a green run as coverage. |
| `scripts/lib/service-mode.mjs` | Pure decision layer for `setup.mjs`'s auto-start step — first install vs. `--reconfigure-only` (issue #226). |
| `scripts/lib/install-autostart.mjs` | Injectable `installAutoStart()` — setup.mjs's auto-start install (legacy-unit migration, unit write, enable/start/bootstrap), extracted so tests can observe real run/fs calls instead of asserting on source text (issue #226). |
| `scripts/lib/restart-unit.mjs` | Resolves which systemd unit (Linux) or launchd job (macOS) actually owns the OCP port before the upgrade/rollback restart phase touches anything — refuses rather than guesses when it can't tell. The two platforms verify different things (issue #239): Linux discovers whichever unit actually holds the port via a `/proc/<pid>/cgroup` walk and compares that discovery against the expected unit; macOS only checks whether its one hard-coded expected job (`dev.ocp.proxy`, gui-domain only) is the port's holder, and cannot identify an unexpected job if that check fails — a root-owned `dev.ocp.proxy` LaunchDaemon hits a permanent refusal there today (issue #290). The working-tree comparison that distinguishes a second local OCP checkout from the production install (issue #254) is Linux-only (`/proc/<pid>/cwd` has no macOS equivalent), and the darwin branch is exercised nowhere in this repo's CI (Linux-only runners) — verified only live, read-only, against a real host. See [docs/upgrading.md § Restart target resolution](docs/upgrading.md#restart-target-resolution). |
| `scripts/lib/start-sh.mjs` | Builds the standalone `start.sh` launcher `setup.mjs` writes (issue #246) — extracted so this logic can be driven by injected fake binaries in tests, since `setup.mjs` itself must never be executed by the test suite. Two distinct port checks live here, each with its own Linux/macOS split, and they are not symmetric with each other: `start.sh`'s own nohup-gating check (`darwinListeningCheck`/`nonDarwinListeningCheck`) uses absolute-path `lsof`/`netstat` plus a `netstat` cross-check for `lsof`'s privilege-gap ambiguity on macOS (a restricted `PATH`, e.g. a launchd job's default environment, can omit `/usr/sbin` entirely), and a bare, non-absolute-path `lsof` on Linux, deliberately; the separate post-install bind check (`buildBindCheckCommand`) uses absolute-path `lsof` only — no `netstat` cross-check — on macOS, and a bare `ss -tlnp` on Linux. |
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
- **Cross-origin requests refused** — a request carrying an `Origin` header outside the loopback/private-range allowlist is rejected `403` on any method except `GET`/`HEAD`, before auth and before routing. Browsers always send `Origin` cross-origin, so this closes the ordinary path by which a web page you merely *visit* could drive the proxy — which, with the default tool set, means running commands as you. **It does not close DNS rebinding**, which produces a genuinely same-origin request that no `Origin` check can distinguish; see [ADR 0019](./docs/adr/0019-inbound-origin-gate.md) § "What this does not do". Same-origin requests are admitted by comparing `Origin` to `Host`, so reaching the dashboard by hostname, `[::1]`, a Tailscale address or through a TLS proxy keeps working. It does **not** wall off a page served from an origin the allowlist admits — any other loopback port, or any host on your LAN. Clients that send no `Origin` (curl, the OpenAI SDKs, `ocp-connect`) are unaffected and need no change. See [ADR 0019](./docs/adr/0019-inbound-origin-gate.md)
- **The system prompt is not in argv** — it is written to a `0600` temp file and passed as `--system-prompt-file`, because argv is world-readable on Linux (`/proc/<pid>/cmdline` is mode `-r--r--r--`, and a default `/proc` mount carries no `hidepid`). Before this, any local account on the host could read every system prompt the proxy handled — the client's `system` messages plus `CLAUDE_SYSTEM_PROMPT` — for the lifetime of each request. The conversation already went over **stdin** and the OAuth token over the child's **env** (`/proc/<pid>/environ` is `-r--------`), so this was the one sensitive channel still in the open. The file is removed when the turn ends; a hard kill of the proxy can leave one behind, which at `0600` is litter rather than a leak.
- **Admin-only key management** — creating, listing, and revoking keys requires the admin key
- **Public endpoints** — `/health` and `/dashboard` are always accessible without auth
- **No API keys needed** — authentication goes through Claude CLI's OAuth session
- **Keys stored locally** — `~/.ocp/ocp.db` (SQLite), never sent to external services
- **Auto-start** — launchd (macOS) / systemd (Linux)

## Governance

OCP runs under a small set of binding documents so contributions stay aligned with what `cli.js` actually does, not what an LLM thinks it does:

- **[`ALIGNMENT.md`](./ALIGNMENT.md)** — the constitution. Every Class A endpoint (the `cli.js`-mirror surface) must correspond to something `cli.js` actually does, with a line-number citation. Class B endpoints — OCP's OpenAI-compatible and administrative surface, where `cli.js` is not the wire authority — cite OpenAI's specification or their authorizing ADR instead. Background in [ADR 0002](./docs/adr/0002-alignment-constitution.md) and [ADR 0006](./docs/adr/0006-openai-shim-scope.md).
- **[`.github/workflows/alignment.yml`](./.github/workflows/alignment.yml)** — CI guardrail. Greps `server.mjs` for known-hallucinated tokens and fails the build on any hit. Not suppressible without an `ALIGNMENT.md` amendment PR.
- **[`AGENTS.md`](./AGENTS.md)** — guidelines any AI coding agent (Claude Code / Cursor / Copilot / Codex / Gemini) should read before touching this repo.
- **[`docs/governance/b2-response-keys.json`](./docs/governance/b2-response-keys.json)** — a per-release record of every grandfathered Class B.2 endpoint's response key set, taken from the wire rather than from prose, and enforced by `npm test`. Adding a field to `/health`, `/status`, `/cache/stats` or any other B.2 response fails the suite until the snapshot is updated and the addition is authorized under [ADR 0012](./docs/adr/0012-additive-fields-on-grandfathered-b2.md). Replaces the CHANGELOG grep that used to serve this role; see [ADR 0012](./docs/adr/0012-additive-fields-on-grandfathered-b2.md) and `CLAUDE.md` § `governance_audits`.
- **[`models.json`](./models.json)** — single source of truth for the model registry. See [ADR 0003](./docs/adr/0003-models-json-spot.md).
- **[`docs/adr/`](./docs/adr/)** — architecture decision records explaining why current structure exists.

If you want to contribute: read `ALIGNMENT.md` first, then classify the change before writing anything — Class A (the `cli.js`-mirror surface) needs a `cli.js:NNNN` line citation; Class B.1 (`/v1/chat/completions`, `/v1/models`) needs the relevant OpenAI specification section plus ADR 0006; Class B.2 (`/health`, `/dashboard`, `/logs`, `/status`, `/settings`, `/api/keys*`, `/api/usage`, `/cache*`) needs the endpoint's authorizing ADR. See `CLAUDE.md` § "Classify the change first" for the full table.

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
