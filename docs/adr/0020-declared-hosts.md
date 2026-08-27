# ADR 0020 — `OCP_ALLOWED_HOSTS`: which host names may vouch for a same-origin request

- **Status**: Accepted
- **Date**: 2026-08-27
- **Supersedes**: the DNS-rebinding limit recorded in [ADR 0019](0019-inbound-origin-gate.md) § "What this does not do"
- **Amends**: [ADR 0019](0019-inbound-origin-gate.md) (the inbound `Origin` gate)
- **Issue**: #446
- **Class**: Hybrid — the gate runs before routing, so it sits above Class A (`/v1/messages`), Class B.1 (`/v1/chat/completions`) and Class B.2 (`/api/keys`, `/cache`, `/settings`) alike. ADR 0006 route (b): this is a **semantics change** on grandfathered B.2 endpoints, so it carries its own authorization rather than the grandfather clause.

## Context

ADR 0019 closed a CSRF chain that ended in arbitrary command execution. Its gate refuses any request that carries a foreign `Origin` and is not GET/HEAD, with two admitting arms: the private-range allowlist, and **same-origin** — `new URL(origin).host === req.headers.host`.

The same-origin arm was added after an independent review caught that the first version broke every dashboard reached at an address the literal allowlist does not spell (`ocp-host.local`, `[::1]`, a Tailscale CGNAT address, a public IP, a TLS front). It broke them **silently**, because `dashboard.html`'s `apiPost`/`apiDelete` return `resp.json()` without reading the status — "revoke key" would confirm, refresh, and leave the key listed.

Two external-review findings then arrived that pull `Host` in **opposite directions**, and that is the whole reason this ADR exists.

**#446 — the arm is too generous.** DNS rebinding produces a request that is *genuinely* same-origin. The attacker serves their page on this port, flips the A record to `127.0.0.1`, and the browser sends their domain in **both** headers, equal by construction. Measured against a live default-configuration instance:

```
Host: r.attacker.example:PORT  +  Origin: http://r.attacker.example:PORT   -> 200   (admitted)
Host: r.attacker.example:PORT  +  Origin: http://r.attacker.example        -> 403   (real cross-origin)
```

**No `Origin` check can close this.** The property the gate keys on is true.

**The mirror finding — the arm is too mean.** A reverse proxy that does not preserve `Host` (nginx's minimal `proxy_pass http://127.0.0.1:PORT;`; Caddy preserves) makes `Host` the *upstream's* address while `Origin` is the public name. They can never be equal, so the same-origin arm cannot fire and every dashboard mutation 403s — through the same silent path. ADR 0019's own comment listed "through a TLS reverse proxy" among the deployments the arm rescues; that is true only for Host-preserving proxies.

One field, two findings, opposite directions. Nothing readable from inside a request separates them.

## Decision

Add `OCP_ALLOWED_HOSTS` — a comma-separated list of `host[:port]` the operator declares — and use it in both arms.

**The discriminator is not "is this local". It is: could an attacker who controls public DNS point this name at `127.0.0.1`?** That question has a mechanical answer for exactly two families of name, and only those two are safe with no configuration:

| family | why it cannot be rebound | keeps working with no config |
|---|---|---|
| **IP literal** (v4, or bracketed v6) | reaching the server with `Host: 100.101.102.103` means the browser connected **without a DNS lookup**. There is no record to flip. | `[::1]`, Tailscale CGNAT, LAN address, public IP |
| **`localhost`, `*.localhost` (RFC 6761 §6.3), `*.local` (RFC 6762 §3)** | reserved names a resolver is required **not** to send to public DNS, so no public record exists | `ocp-host.local` mDNS dashboards |

Every other name is a public DNS name, and **from inside a request the operator's own domain and the attacker's are indistinguishable** — that is the mechanism of the attack, not a gap in the implementation. So the operator declares theirs and the attacker cannot.

Concretely:

1. **Same-origin arm** now additionally requires the `Host` to be rebind-safe *or* declared. `r.attacker.example` vouching for itself → **403**, reason `undeclared-host`.
2. **A declared origin is admitted outright**, checked *before* the same-origin arm — which is what rescues the Host-rewriting proxy, where the two headers can never match.
3. **`Access-Control-Allow-Origin` echoes a declared origin.** Without this the gate would admit the request and the *browser* would discard the response — the same invisible failure moved one layer out, where it is harder to diagnose rather than fixed.
4. An entry **without** a port matches any port; **with** a port, only that port.
5. The list splits on **comma only, never whitespace** — otherwise the typo `my host.tld` would silently declare `my`, an operator's slip *widening* the allowlist.
6. **A declared entry naming a default port (`:443`, `:80`) is kept but flagged at boot.** Measured: `Origin` never carries a default port and `new URL(origin).host` drops it, so `https://ocp.example.com` yields the bare host and a declaration of `ocp.example.com:443` **can never match** — the operator gets a 403 telling them to declare a host they *did* declare. The entry is kept exactly as written rather than normalised, because silently dropping the port would widen it to *any* port, which they did not ask for. The boot line says what to write instead. Found by checking the parse against a real `URL`, not by reading the code.
7. Unparseable entries are **reported at boot** and dropped. Not fatal: refusing to boot would take the proxy down to fix a misspelling. But not silent either — a dropped entry is a name the operator believes they declared, and the alternative first evidence is a 403 on somebody else's screen.

## Class mapping

Same shape as ADR 0019 — this amends that gate, in the same place in the shared request pipeline,
so it is **Hybrid** and each class is answered separately rather than by one blanket claim.

- **Class A** (inbound `/v1/messages`, per `ALIGNMENT.md:17`). **The change cannot affect any
  request `cli.js` would make.** Both headers this decision reads are browser-set: `Origin` is not
  sent by HTTP clients at all, and the gate is only reached when `Origin` is present — a request
  with no `Origin` returns `no-origin` and is admitted before `Host` is ever parsed. OCP's own
  audited Class A outbound call to `api.anthropic.com/v1/messages` sends `Authorization`,
  `anthropic-version`, `anthropic-beta` and `Content-Type`, and no `Origin`. Rules 2 and 3 are not
  implicated: nothing about the mirrored wire operation changes in either direction. As ADR 0019
  records, `cli.js` is a **client** with no inbound surface, so "what does `cli.js` do on its
  inbound route" has no answer to grep for.
- **Class B.1** (`/v1/chat/completions`, `/v1/models`). ADR 0006. OpenAI's specification defines
  request and response *fields*; it does not define transport-level access control for a
  self-hosted compatible server. No field, parameter or response key is added, removed or retyped.
- **Class B.2** (the grandfathered administrative endpoints). **A semantics change, not a
  behaviour-preserving refactor**: a same-origin request at an undeclared public DNS name
  previously executed and now receives `403`, and a declared origin now receives its own value in
  `Access-Control-Allow-Origin` where it previously received the loopback default. Under
  `ALIGNMENT.md` and ADR 0006 that requires its own authorization rather than the grandfather
  clause — which is what this ADR is. Deliberately **not** filed under ADR 0012: 0012 authorizes
  *additive read-only fields*, and this adds no field. Confirmed from the wire rather than by
  argument — `scripts/b2-key-snapshot.mjs` reports **no key-path change in either profile**, which
  is the evidence that no B.2 *response shape* moved even though its *semantics* did.

## Consequences

**Breaking, for exactly one deployment shape**: a dashboard reached at a real public DNS name that resolves straight to the box, with no proxy. That previously worked with no configuration and now needs one line. This is the *only* shape that regresses, and it is the same shape rebinding imitates — that is not a coincidence, it is the finding. The 403 body names `OCP_ALLOWED_HOSTS` and says why, so the fix is discoverable from the failure.

**Not affected**: loopback, LAN, `[::1]`, Tailscale, mDNS, `curl`, the OpenAI SDKs, `ocp-connect` (no `Origin` at all), and every Host-preserving TLS proxy fronting one of the above.

**What this still does not do:**

- **A resolver configured to forward `*.local` / `*.localhost` to public DNS** — some corporate split-horizon setups do — reopens rebinding for that name. OCP cannot detect this from inside a request. An operator in that position pins the dashboard to an IP literal or removes the forwarding.
- **A page served from an origin the private-range allowlist admits** — any other loopback port, any LAN host. Entirely pre-existing; ADR 0019 records it and this ADR does not change it.
- **A non-browser local process**, which sends no `Origin` at all. Different threat model.
- **GET side effects.** Still exempt, for ADR 0019's reason: `<img src>` reaches the same surface with no `Origin` at all, so gating GET would close the narrower shape and break cross-origin dashboards.

## Evidence

Both findings came from external review (`prime` / `stealth/ox-alpha` via OpenRouter). **That backend's vendor is undisclosed**, so this is "not the author's harness" rather than an established cross-vendor review, and it is recorded that way deliberately.

The three-way split is behavioural, in `test-features.mjs`: `ocp-host.local` admitted with no config, `r.attacker.example` refused, `ocp.example.com` admitted **only when declared** — plus a control on each that the gate has not simply become "refuse everything". Four mutation rows (drop the rebind-safety check; drop the CORS echo; split on whitespace; ignore the port) each produce attributable red in the named tests.
