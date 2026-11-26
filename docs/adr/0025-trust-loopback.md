# ADR 0025 — `OCP_TRUST_LOOPBACK`: Opt-Out of Implicit Loopback Trust Behind a Same-Host Reverse Proxy

- **Status**: Accepted (maintainer sign-off 2026-11-26)
- **Date**: 2026-11-26
- **Issue**: #542
- **Class**: Hybrid — governs the shared auth, admin, and `/health` gate in `handleRequest`, reaching Class B.1 (`/v1/chat/completions`, `/v1/models`), Class B.2 administrative endpoints, and the Hybrid `/usage` synthesis layer. ADR 0006 route (b): a **semantics change**, off by default.

## Context

`handleRequest` determines `isLocalhost` solely from `req.socket.remoteAddress` (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). A loopback peer bypasses `shared` and `multi` Bearer-token rejection, is unconditionally granted `isAdmin = true`, and receives `anonymousKey` in `GET /health`.

When an operator places a TLS reverse proxy (nginx, Caddy) on the **same host** — a deployment explicitly anticipated by ADR 0019, ADR 0020, and `README.md` § Troubleshooting — every forwarded remote client connects to OCP from `127.0.0.1`. Shared/multi auth and every admin gate silently stop enforcing while every request returns `200`, including `/settings`, `/logs`, `/api/keys`, and `/v1/chat/completions` (which in `none`/`shared` mode grants pre-approved local tools).

Parsing `X-Forwarded-For` against a `OCP_TRUSTED_PROXIES` allowlist was rejected as the primary mechanism: a misconfigured proxy that omits or forwards an untrusted `X-Forwarded-For` header fails **open** (treating a remote caller as a trusted local admin), and maintaining CIDR / IPv6-mapped / multi-hop header parsing adds security-critical complexity when OCP already authenticates callers via Bearer tokens.

## Decision

1. **Add `OCP_TRUST_LOOPBACK` (default `"1"`, opt-out via `"0"`).**
   - When unset or any value other than `"0"`: behaviour is unchanged; loopback stays trusted for local single-user and LAN-admin workflows.
   - When `"0"`: loopback peers are **not** implicitly trusted (`isTrustedLocal = isLocalhost && TRUST_LOOPBACK` is `false`). Loopback callers go through the exact same `AUTH_MODE` validation, `isAdmin` check, and `/health` `anonymousKey` gate as non-loopback callers.
2. **Boot-time observability and safety warnings.**
   - When `OCP_TRUST_LOOPBACK=0`, the boot banner logs `Loopback trust: disabled (OCP_TRUST_LOOPBACK=0 — loopback callers must authenticate)`.
   - Warn at boot when `OCP_TRUST_LOOPBACK=0` is combined with:
     - `AUTH_MODE=none` (no auth is configured to enforce);
     - `AUTH_MODE=shared` with `PROXY_API_KEY` unset (requests still pass unauthenticated);
     - `AUTH_MODE=multi` with `OCP_ADMIN_KEY` unset (admin endpoints become unreachable until `OCP_ADMIN_KEY` is set).
3. **One-shot runtime detection when default trust is still on.**
   - While `TRUST_LOOPBACK` is enabled and `AUTH_MODE !== "none"`, the first loopback request carrying an `X-Forwarded-For` or `Forwarded` header emits one `warn` log event (`loopback_forwarded_header_seen`) advising the operator to set `OCP_TRUST_LOOPBACK=0`. This changes no HTTP status or response body.
4. **Documentation.**
   - Update `ALIGNMENT.md` § Cross-cutting authorizations, `docs/adr/README.md`, `README.md`, `docs/lan-mode.md`, and `CHANGELOG.md`.

## Class Mapping

- **Class A**: `server.mjs` has no inbound Class A route, and `cli.js` is a client with no inbound surface (same declaration as ADR 0020 / ADR 0023). Outbound Class A calls (OAuth token refresh, the `/usage` wire call) are unaffected.
- **Class B.1** (`/v1/chat/completions`, `/v1/models`): OpenAI API Reference, "Authentication" (`https://platform.openai.com/docs/api-reference/authentication` — `Authorization: Bearer`); no request or response field is added, removed, or retyped.
- **Class B.2** (grandfathered administrative endpoints) & **Hybrid `/usage`**: ADR 0006 route (b) — opt-in semantics change (`401`/`403` on loopback when `OCP_TRUST_LOOPBACK=0`, and `/health` omits `anonymousKey` on loopback unless `PROXY_ADVERTISE_ANON_KEY=1`). Under default settings, the B.2 wire key-set snapshot is byte-identical.

## Consequences

- **Default deployments unchanged:** leaving `OCP_TRUST_LOOPBACK` unset preserves existing loopback trust, adding only a one-shot log warning if a same-host proxy forwards `X-Forwarded-For` / `Forwarded` while auth is enabled.
- **Same-host reverse proxies are fail-closed with `OCP_TRUST_LOOPBACK=0`:** even if the proxy omits or mangles forwarding headers, OCP still enforces Bearer auth and admin checks on every request.
- **Local tools on a hardened host must authenticate:** the `ocp` CLI already sends `Authorization: Bearer` from `OCP_ADMIN_KEY` or `~/.ocp/admin-key`; in `shared` mode with `OCP_TRUST_LOOPBACK=0`, local `ocp` invocations pass `OCP_ADMIN_KEY="$PROXY_API_KEY"` (or operators use `multi` mode).
- **`/health` and `/dashboard` stay public** (`isPublicEndpoint`), unchanged; `/health` stops exposing `anonymousKey` on loopback unless `PROXY_ADVERTISE_ANON_KEY=1`, and `/dashboard` prompts for a Bearer key when API calls return 401/403.
- **Composes with keyless refusal in `multi` mode:** once `multi` mode also supports refusing keyless callers (#547), combining `CLAUDE_AUTH_MODE=multi` + `OCP_TRUST_LOOPBACK=0` + `OCP_ADMIN_KEY` locks down a same-host reverse proxy end-to-end without relying on proxy-side header filtering.
