# ADR 0025 — `OCP_REQUIRE_KEY`: multi mode can refuse a caller that sends no key

- **Status**: Proposed
- **Date**: 2026-11-20
- **Amends**: the keyless arm of `AUTH_MODE=multi` (`69b2081`, "zero-config auth — keys optional, localhost is admin")
- **Class**: Hybrid — the check sits in the shared auth block of `handleRequest`, before routing, so it reaches Class B.1 (`/v1/chat/completions`, `/v1/models`), the Class B.2 endpoints and the synthesis layer of the Hybrid `/usage` alike. ADR 0006 route (b): a **semantics change**, off by default

## Context

Since `69b2081` (2026-04-11), `AUTH_MODE=multi` admits a non-loopback request **with no `Authorization` header** as `anonymous`. That was deliberate — family members on a home LAN start with no key setup — and a wrong key is still refused. A day later `38070fb` (#15) added `PROXY_ANONYMOUS_KEY` for clients that must send *some* key; `docs/lan-mode.md` calls that one "an opt-in to public access".

The keyless arm itself has no opt-out. That is fine on a LAN, and it is the wrong default for one deployment shape that the per-key features otherwise suit well: **OCP behind a reverse proxy on a public name**, serving several of one person's own applications, each with its own key so that one can be revoked and its usage read separately. There, "no key" means "anyone on the internet". Measured on v3.43.0 with `CLAUDE_AUTH_MODE=multi`, `CLAUDE_BIND=0.0.0.0` and no `PROXY_ANONYMOUS_KEY`: a `POST /v1/chat/completions` with no `Authorization` header from a non-loopback address returned **200** with a completion; the same request with a revoked key returned 401.

The workaround today is to make the reverse proxy refuse requests without a `Bearer` header. That leaves OCP itself open to every host that can reach its port, and it puts a security property of OCP in another program's configuration.

## Decision

Add `OCP_REQUIRE_KEY`. When it is `"1"` and `AUTH_MODE` is `multi`, a non-loopback request that carries no `Bearer` token receives **401** (`auth_error`, message naming the setting) instead of being admitted as `anonymous`.

1. **Default off.** Every existing deployment behaves exactly as before; the LAN zero-config path is the reason the arm exists.
2. **Only the keyless arm changes.** A valid key, the admin key and `PROXY_ANONYMOUS_KEY` (a token, so it is checked, not keyless) are admitted as before; an invalid key is refused as before.
3. **Loopback is unchanged** — still always admitted, by the `isLocalhost` branch that runs first. Deliberately out of scope: a reverse proxy on the same host reaches OCP from loopback, so an operator who needs this setting runs the proxy on another host or address. Recorded under Consequences rather than changed here, because loopback-is-admin is a separate decision with its own users.
4. **Outside multi mode it does nothing**, and says so at boot (`WARNING: OCP_REQUIRE_KEY=1 is set but AUTH_MODE is not 'multi'`). `shared` already refuses a missing key when `PROXY_API_KEY` is set; `none` has no keys.
5. **The boot banner states the arm's direction in multi mode**: `Keyless requests: refused (OCP_REQUIRE_KEY=1)`, or `admitted as anonymous (OCP_REQUIRE_KEY=1 refuses them)`, so an operator reading the log learns the default without reading the code.

## Class mapping

- **Class A.** `server.mjs` has no inbound Class A route, so no inbound `cli.js`-mirror request can reach this check; as ADR 0020 records, `cli.js` is a client with no inbound surface, so there is nothing to grep for. The outbound Class A calls (OAuth, the `/usage` wire call) are unaffected: the change only reads whether an inbound request carries a `Bearer` token.
- **Class B.1** (`/v1/chat/completions`, `/v1/models`). OpenAI's API reference, "Authentication" (https://platform.openai.com/docs/api-reference/authentication): requests carry the API key as `Authorization: Bearer`. Refusing a request without one is what that section describes; no request or response field is added, removed or retyped.
- **Hybrid `/usage`.** Its synthesis layer answers a keyless non-loopback caller with `401` instead of its previous response when the setting is on; its wire call is untouched.
- **Class B.2** (administrative endpoints). A semantics change, opt-in: with the setting on, a keyless non-loopback request that previously executed now receives 401. Not ADR 0012 (no field is added). No response shape changes.

## Consequences

- **Not affected** with the setting off: everything. With it on: loopback callers, keyed callers, `PROXY_ANONYMOUS_KEY` callers.
- **A reverse proxy on the same host** reaches OCP from loopback and is therefore still admitted without a key. Such an operator keeps the proxy-side check, or binds the proxy to a non-loopback address.
- **`ocp-connect` and clients without a key** stop working against an instance with the setting on, by design.
- **`PROXY_ANONYMOUS_KEY` with `PROXY_ADVERTISE_ANON_KEY=1` undoes the setting**: `/health` (unauthenticated) hands that key to anyone, who then sends it as a token. OCP warns at boot when all three are set; an operator who wants the instance closed does not advertise an anonymous key.

## Evidence

`test-features.mjs`, two behavioural tests against a real `server.mjs` child bound to `0.0.0.0` and reached at the machine's own non-internal IPv4 (loopback cannot reach the keyless arm, so a loopback-only test would pass on a build where the setting does nothing):

- with `OCP_REQUIRE_KEY=1`: keyless → 401 naming the setting; loopback → 200; a key created through `/api/keys` → 200 from the same address; banner says `refused`;
- without it: keyless → 200; banner says `admitted as anonymous`.

Mutation row: removing the `else if (REQUIRE_KEY)` branch turns the first test red (`keyless request … was not refused: 200`) and leaves the second green.
