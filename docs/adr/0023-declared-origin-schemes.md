# ADR 0023 — `OCP_ALLOWED_ORIGIN_SCHEMES`: admitting browser-extension origins by scheme

- **Status**: Proposed
- **Date**: 2026-09-30
- **Amends**: [ADR 0019](0019-inbound-origin-gate.md) (the inbound `Origin` gate), [ADR 0020](0020-declared-hosts.md) (declared hosts)
- **Class**: Hybrid, for the reason ADR 0020 gives — the gate runs before routing, so it sits above Class A, B.1 and B.2 alike. ADR 0006 route (b): a **semantics change** on grandfathered B.2 endpoints, so it carries its own authorization rather than the grandfather clause.

## Context

Browser extensions are OpenAI-compatible clients too: chat sidebars and "use your own endpoint" extensions in Firefox and Chromium POST to `/v1/chat/completions` from the extension's background or popup page. Their requests carry an `Origin`, so ADR 0019's gate applies, and the origin is neither private-range nor same-origin:

```
Origin: moz-extension://<uuid>           (Firefox: a random UUID per install, per profile)
Origin: chrome-extension://abcdefghij…    (Chromium: 32 letters derived from the extension key)
```

The gate answers `403 forbidden_origin` with reason `foreign-origin` — correct under ADR 0019, and the extension's user has no way to tell from the error which setting would admit it.

**What works today, and why it is not enough.** `OCP_ALLOWED_HOSTS` admits one extension: ADR 0020's declared-origin arm compares `parseAuthority(new URL(origin).host)` with the declaration, and for `moz-extension://<uuid>` that host is the UUID, which `parseAuthority` accepts as a DNS-shaped name. Measured: declaring the UUID admits that extension (`declared-origin`) and still refuses any other `moz-extension://` origin (`foreign-origin`). It works by accident rather than by design, and it breaks in the way users actually hit:

- Firefox assigns the UUID **per install and per profile**. Reinstalling the extension, or using it in a second profile, produces a new origin and the 403 returns.
- The declaration is scheme-blind (ADR 0020 §6), so declaring the UUID also admits `http://<uuid>` and `https://<uuid>` — harmless in practice, but not what the operator meant.
- Nothing in the 403, the README or the boot output tells an operator that an extension id belongs in a variable documented as "host names this proxy is served on".

## Decision

Add `OCP_ALLOWED_ORIGIN_SCHEMES` — a comma-separated list of origin **schemes** the operator declares — and admit any origin of a declared scheme.

1. **A new admitting arm in `evaluateOriginGate`**, after the no-origin and GET/HEAD exemptions and before the declared-host, private and same-origin arms. A match is admitted with reason **`declared-scheme`**, distinct from `declared-origin`, so a log line says which setting let a request in.
2. **The comparison is on `new URL(origin).protocol`**, never on the origin string: `https://moz-extension.example` does not match `moz-extension`. An opaque (`null`) or unparseable origin never matches.
3. **`http` and `https` are refused as entries**, reported at boot and dropped. Declaring either would admit every web page and undo ADR 0019 entirely; there is no deployment that needs it, because a web origin is admitted by being private-range, same-origin or declared as a host.
4. **Parsing mirrors ADR 0020's rules where they apply**: split on comma only, entries trimmed, case folded, duplicates collapsed. A trailing `:` or `://` is accepted, so a value pasted from the address bar (`moz-extension://`) works. Anything that is not an RFC 3986 scheme (`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`) is reported at boot and dropped — not fatal, for ADR 0020 §7's reason.
5. **`Access-Control-Allow-Origin` echoes a declared-scheme origin**, as ADR 0020 §3 does for declared hosts: without it the gate admits the request and the browser discards the response.
6. **Unset by default.** With the variable empty the gate's behaviour is byte-for-byte unchanged.
7. **Boot prints the admitted schemes**, so an operator can see the widened surface without reading the environment.

`OCP_ALLOWED_HOSTS` remains the way to admit **one** extension and is not changed; this ADR adds the class-wide option beside it.

## Class mapping

- **Class A** — unaffected, for ADR 0020's reason: the gate is reached only when `Origin` is present, and neither `cli.js` nor OCP's outbound call to `api.anthropic.com` sends one.
- **Class B.1** — OpenAI's specification defines request and response fields, not transport-level access control for a self-hosted server. No field is added, removed or retyped.
- **Class B.2** — a **semantics change**: with the variable set, a POST from a declared-scheme origin that previously received `403` now executes, and receives its own origin in `Access-Control-Allow-Origin`. That needs its own authorization (ADR 0006 route (b)), which is this ADR. Not ADR 0012: no field is added. No response key path changes; `scripts/b2-key-snapshot.mjs` is expected to report no difference (see Evidence).

## Consequences

**Trust widens to every extension of the declared scheme.** `moz-extension` admits every extension installed in every Firefox profile of that user, not only the one the operator meant. With the default `ALLOWED_TOOLS` (`Bash`, `Write`, `Edit`, …) any of them can drive tool execution on the host — the exposure ADR 0019 measured, now reachable by installed extension code instead of by web pages. That is an operator opt-in with a smaller population than "the web" (extensions are installed deliberately and reviewed by the browser vendors), but it is the operator's call, and the README says so next to the variable. An operator who wants one extension declares its id in `OCP_ALLOWED_HOSTS` instead.

**Not affected**: every deployment that does not set the variable; `curl`, the OpenAI SDKs and `ocp-connect` (no `Origin`); every origin already admitted by ADR 0019/0020.

**What this does not do:**

- **Distinguish extensions within a scheme.** Allowlisting individual Chromium extension ids works through `OCP_ALLOWED_HOSTS` today because their ids are stable; Firefox ids are not, which is the gap this ADR closes at the cost of granularity.
- **Change GET handling.** GET and HEAD stay exempt for ADR 0019's reason.
- **Cover non-browser local processes**, which send no `Origin` and were never gated.

## Evidence

- Unit tests in `test-features.mjs`: parsing keeps `moz-extension` / `chrome-extension` and reports `http`, `https://` and a non-scheme; the gate admits any id of a declared scheme with reason `declared-scheme`, refuses the same origin without the declaration (control), and refuses another scheme, a web page, `null`, and a web host whose name contains the scheme. Removing the new gate line turns the admission test red.
- Existing ADR 0019 / ADR 0020 tests pass unchanged.
- Live, on Windows: with `OCP_ALLOWED_ORIGIN_SCHEMES=moz-extension`, a POST from an arbitrary `moz-extension://…` origin returned `200` with that origin echoed in `Access-Control-Allow-Origin`; `Origin: https://evil.example` still returned `403`.
- **Not yet run:** `scripts/b2-key-snapshot.mjs`, whose fixture is a `/bin/sh` fake `claude` and cannot run on the Windows host this was developed on; CI (`ubuntu-latest`) runs it via `npm test`.
