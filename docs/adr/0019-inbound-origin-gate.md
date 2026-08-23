# 0019 — Reject State-Changing Requests Carrying a Foreign `Origin`

- **Date**: 2026-08-23
- **Status**: Accepted
- **Authors**: project maintainer (with AI advisory drafting)
- **Related**: ADR 0006 (Class A/B taxonomy and the B.2 grandfather — this is route **(b)**, a semantics change), ADR 0007 (the per-request `claude -p` spawn this protects), external security review 2026-08-23

## Context

`server.mjs` had **no CSRF defense of any kind**, and none had been considered: `git grep -niE 'csrf|cross-site request'` over the whole worktree returns **zero** hits (exit 1), with `Allow-Origin` matching in **two** files as a positive control — `server.mjs` and one shipped plan doc. (The first draft said "one"; the control's own count was wrong, which is the smaller version of the mistake this whole ADR is about.) The one `Origin`-related line in the file decides *which value goes into the response header* and never rejects anything:

```js
const isAllowedOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|192\.168\.…|172\.…|10\.…)(:\d+)?$/.test(origin);
res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin ? origin : `http://127.0.0.1:${PORT}`);
```

### The chain, measured against a live default-configuration instance

Not reasoned about — executed, on 2026-08-23, against a service running the shipped defaults
(`CLAUDE_AUTH_MODE=none`, `CLAUDE_BIND=127.0.0.1`, no `CLAUDE_ALLOWED_TOOLS`, no `CLAUDE_SKIP_PERMISSIONS`):

| Link | Status |
|---|---|
| The server does not check the inbound `Content-Type` | **Measured.** `Content-Type: text/plain` with a malformed body returns `400 Invalid JSON`, **not `415`** — so the body reached `JSON.parse`. `text/plain` is CORS-safelisted, so a cross-origin POST carrying it needs **no preflight**. |
| The server does not reject on `Origin` | **Measured.** The same request carrying `Origin: https://evil.example.com` was processed identically. |
| Localhost is unconditionally admitted | The auth branch's own comment reads *"Localhost always allowed — try to identify key if provided, but never reject"*. |
| The default tool set includes `Bash`, `Write`, `Edit` | `ALLOWED_TOOLS` defaults to `Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Agent` when `CLAUDE_ALLOWED_TOOLS` is unset, and is passed as `--allowedTools`. |
| **The spawned `claude` executes those tools without prompting** | **Measured.** A nonce file was written locally, then a request was sent through the live proxy asking it to `cat` that file. The reply contained the nonce — an output only execution can produce. |

So the exposure is not the "blind CSRF can burn quota" the review classified it as. It is **blind
command execution on the operator's machine, as the operator, triggered by visiting a web page** —
the attacker cannot read the response and does not need to.

**Scope note.** This is *not* gated by LAN / multi-user mode, which is otherwise frozen. It applies
to the default single-user loopback deployment, which is what the README recommends and what the
reference fleet runs.

### The one link that was not measured, stated so it is not mistaken for one that was

Whether a browser lets a public page reach `127.0.0.1` at all. Chrome's Private Network Access
restricts this, it is version-dependent, and it was **not tested here**. The direction that matters
is the other one: **the server has no defense of its own, and the only thing standing between a
visited page and command execution is a browser mitigation this project neither implements nor can
depend on.**

## Decision

**If a request carries an `Origin` header whose value is not in the existing allowlist, and its
method is not `GET` or `HEAD`, respond `403` before auth and before routing.**

- **An absent `Origin` changes nothing.** Non-browser clients — `curl`, the OpenAI SDKs,
  `ocp-connect`, anything driving the proxy from a shell — send no `Origin`, and are unaffected.
  This is what makes the gate free: it adds no requirement to any request, so no client has to
  change and no request shape moves.
- **The allowlist is the one already in the file**, reused rather than redefined, so there is
  exactly one definition of "an origin this instance trusts".
- **`Origin: null`** — sandboxed iframes and `file://` pages — does not match the allowlist and is
  therefore rejected. That is the intended direction.
- **`OPTIONS` is gated too**, so a foreign preflight fails at the preflight rather than one round
  trip later. The behaviour is identical either way; this is just the earlier of the two.

### Why a `Content-Type: application/json` requirement is NOT part of this decision

It was designed, then dropped, and the reasoning is recorded because the omission would otherwise
look like an oversight to the next reader.

- **It is not necessary for this chain.** A cross-origin POST always carries `Origin`, so the gate
  above rejects the attack before content type is ever consulted. A `Content-Type` requirement
  defends a *different* threat — a client that sends no `Origin` — and a client that sends no
  `Origin` is not a browser and therefore not CSRF.
- **It is not free, and the cost lands on the test suite's evidence.** Measured: **31**
  `POST`/`PATCH`/`DELETE` senders in `test-features.mjs`, of which **4** set a `Content-Type` at the
  call site; the rest go through raw-socket helpers. Many of those deliberately send malformed
  bodies to assert `400 Invalid JSON`. Gating on content type first turns those into `415` and
  forces ~20 existing assertions to be rewritten — a large edit, to tests whose whole job is to
  pin a failure mode, in the same commit as a security fix. That is the shape this repo's own
  discipline warns about.
- **It would break a real client.** `dashboard.html` issues `DELETE` with an auth header and **no
  body and no `Content-Type`** (cache clear, key delete). Any method-based content-type rule
  refuses it.

If a `Content-Type` requirement is wanted later, it should be scoped to *requests that carry a
body*, land on its own, and pay for the test migration explicitly.

## Class mapping

This touches the shared request pipeline, so it is **Hybrid** and each class is answered separately.

- **Class A** (inbound `/v1/messages`, per `ALIGNMENT.md:17`). **The gate cannot affect any request
  `cli.js` would make.** `Origin` is a browser-set header; an HTTP client does not send one, and
  OCP's own audited Class A outbound call to `api.anthropic.com/v1/messages` sends
  `Authorization`, `anthropic-version`, `anthropic-beta` and `Content-Type` — and no `Origin`.
  Rules 2 and 3 are therefore not implicated: nothing about the mirrored wire operation changes,
  in either direction. Note also that `cli.js` is a **client** and has no inbound surface at all,
  so "what does `cli.js` do on its inbound route" has no answer to grep for; the reference build
  ships as a compiled Mach-O binary on the audit host, and the compiled-binary protocol of
  `ALIGNMENT.md` § "OAuth token-host verification" applies to any future question that does need it.
- **Class B.1** (`/v1/chat/completions`, `/v1/models`). ADR 0006. OpenAI's specification defines
  request and response *fields*; it does not define transport-level access control for a
  self-hosted, loopback-bound compatible server, and this adds no field, parameter, or response
  key. No field is invented.
- **Class B.2** (the grandfathered administrative endpoints). **This is a semantics change, not a
  behaviour-preserving refactor**: a request that previously executed now receives `403`. Under
  `ALIGNMENT.md` and ADR 0006 that requires its own authorization rather than the grandfather
  clause, which is what this ADR is. The change is deliberately *not* filed under ADR 0012 —
  0012 authorizes **additive read-only fields**, and this adds no field.

## Consequences

- A cross-origin browser request to any state-changing endpoint now fails closed. Previously every
  one of them executed.
- **No legitimate client has to change**, but the FIRST version of this decision got the reason
  wrong and would have broken one. It reasoned: `test-features.mjs` references `Origin` 0 times
  and `dashboard.html` is same-origin, therefore the allowlist admits it. Both measurements are
  true; **the inference is not.** "Same-origin" means the origin equals whatever the operator typed
  in the address bar — it says nothing about whether that string is in a *literal* allowlist. And
  browsers send `Origin` on **same-origin** requests too whenever the method is not `GET`/`HEAD`
  (Fetch Standard, *append a request `Origin` header*, step 3, which does not exclude the
  same-origin case). `dashboard.html` sets `BASE = window.location.origin` and `POST`s/`DELETE`s to
  it, so an operator reaching the dashboard at `ocp-host.local`, `[::1]`, a Tailscale CGNAT
  address, a public IP, or through a TLS reverse proxy — all of which `README.md` and
  `docs/lan-mode.md` tell them to do — would have had "add key" and "revoke key" start returning
  403. **Silently**: `apiPost`/`apiDelete` return `resp.json()` without looking at the status, so
  revoking a compromised key would show a confirm, refresh the list, and leave the key there with
  no error anywhere. A security control failing invisibly on the operator's side is the wrong
  failure. The gate therefore admits **same-origin** separately, by comparing the `Origin`'s host
  to the request's `Host` — strictly stronger than the allowlist, since a browser sets both itself
  and `Host` is a forbidden header name, so an attacker page cannot make them match unless it *is*
  that origin.
- The blast radius of a future widening of `ALLOWED_TOOLS` or of `CLAUDE_SKIP_PERMISSIONS` is
  reduced but **not removed**. This ADR closes the browser path; it does not make the spawned
  `claude` safe to expose by other means, and must not be cited as if it had.
- **What this does not do**, stated so a green gate is not read as a closed surface:
  - It does not defend against a **non-browser local process**, which can send requests with no
    `Origin` at all. Anything running as the operator can already reach the spawned `claude`
    directly; different threat model, out of scope.
  - **It does not stop DNS REBINDING, and this is the one boundary that is NOT pre-existing** —
    it is the shape the same-origin arm admits. An attacker who serves their page on this port and
    flips the A record to `127.0.0.1` produces a request the browser considers **genuinely
    same-origin**: `Host` and `Origin` both carry the attacker's domain and are equal by
    construction. Measured on a live instance: `Host: r.attacker.net:PORT` +
    `Origin: http://r.attacker.net:PORT` returns **200**; the same pair on *different* ports (a real
    cross-origin request) returns **403**. **No `Origin` check can close this** — rebinding's whole
    point is that the request is same-origin, so the property the gate keys on is genuinely true.
    Closing it requires validating `Host` against hostnames **the operator has declared**, which is
    configuration this project does not have; reusing the existing allowlist for `Host` would refuse
    exactly the hostname dashboards the same-origin arm was added to keep working, so the two cannot
    be reconciled without that declaration. Tracked as follow-up rather than folded in: this change
    is a **strict reduction** (before it, every cross-origin request executed; after it, only this
    shape does), and holding a strict reduction while designing a config surface is the worse trade.
    Found by external review; its rebuttal of the first draft's comment is exact — *under rebinding
    the attacker page genuinely IS that origin*.
  - It does not defend against a page served from an origin the allowlist **admits** — any other
    loopback port, or any host on the operator's LAN. `http://192.168.1.99:8080`, a compromised IoT
    device, or a router admin page with an XSS is both admitted here **and** echoed into
    `Access-Control-Allow-Origin`, so such a page can drive *and read* `POST /v1/chat/completions`.
    (`GET /api/keys` returns previews only, so key material is not exposed.) This is entirely
    pre-existing — the allowlist predates this ADR — but it is the honest boundary of the sentence
    "a page you merely visit cannot drive the proxy": a page on your LAN can.
