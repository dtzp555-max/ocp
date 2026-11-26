# ADR 0027 — Key Identity, Privilege Separation, and Unambiguous Key Addressing

- **Status**: Accepted (maintainer sign-off 2026-11-26)
- **Date**: 2026-11-26
- **Issue**: #543
- **Class**: Class B.2 (grandfathered administrative endpoints: `/api/keys`, `/api/keys/:id`, `/api/keys/:id/quota`, `/api/usage`, plus admin-gated `/logs`, `/status`, `/settings`, `/cache*`, and the Class B synthesis layer of Hybrid `/usage`). ADR 0006 route (b): semantics and request-shape change, amending ADR 0017 for `POST /api/keys`.

## Context

Three coupled identity defects existed in key authentication and key management (measured on v3.43.0 in `multi` mode):

1. **Privilege derived from key name.** `handleRequest` computed `isAdmin = AUTH_MODE !== "multi" || authKeyName === "admin" || isTrustedLocal`, and `/api/usage` computed `isAnonCaller = callerName === "anonymous"`. Because the DB-key branch set `authKeyName = keyInfo.name` and `POST /api/keys` admitted `admin` and `anonymous`, any DB key named `admin` became a full administrator (able to call `/settings`, `/api/keys`, `/logs`, `/cache`, and `/api/usage?all=true`) from any remote address, and a key named `anonymous` collided with anonymous usage accounting. The other synthetic names (`local`, `remote`, `shared`) collided in `usage_log` the same way.
2. **Silent multi-row revocation and quota mutation.** `api_keys.name` has no `UNIQUE` constraint, and `revokeKey` / `updateKeyQuota` executed `WHERE id = ? OR name = ?`. With two keys named `team`, `DELETE /api/keys/team` silently revoked both. `updateKeyQuota` also lacked a `revoked = 0` filter, mutating already-revoked rows.
3. **ID / name namespace collision.** Because SQLite compares a text parameter against an `INTEGER PRIMARY KEY` with numeric affinity, `DELETE /api/keys/1` matched both key `id = 1` (named `guest`) and a separate key named `"1"`, revoking both.

## Decision

1. **Decide `isAdmin` and `isAnonCaller` from explicit authentication flags, never key names.**
   - Track `authIsAdmin` (true **only** when the timing-safe `OCP_ADMIN_KEY` comparison succeeds) and `authIsAnonymous` (true **only** when `PROXY_ANONYMOUS_KEY` matches or a `multi`-mode caller presents no token).
   - Compute `isAdmin = AUTH_MODE !== "multi" || authIsAdmin || isTrustedLocal` and `isAnonCaller = req._authIsAnonymous`.
   - Even a pre-existing legacy DB key named `admin` or `anonymous` created prior to this change immediately loses `isAdmin` and `isAnonCaller` privilege (cannot access admin endpoints or trigger `?all=true` bypass rules); `/api/usage` single-caller filtering (`scope.self`) still filters `usage_log` by `key_name`, so pre-upgrade keys bearing reserved names must still be revoked and re-created (see Consequences).

2. **Reserve synthetic caller names at `POST /api/keys` (amends ADR 0017).**
   - `RESERVED_KEY_NAMES = ["admin", "anonymous", "local", "remote", "shared"]`, checked case-insensitively after trimming (`isReservedKeyName` in `keys.mjs`).
   - `POST /api/keys` rejects any reserved name with `400` using the existing `{ error: { message, type: "invalid_request_error" } }` shape.

3. **Unambiguous key addressing on `DELETE /api/keys/:x`, `PATCH /api/keys/:x/quota`, and `GET /api/keys/:x/quota` (`resolveKeyTarget` in `keys.mjs`).**
   - Parse numeric ids strictly as canonical positive integers (`/^[1-9]\d*$/`) instead of relying on SQLite's implicit numeric affinity.
   - Refuse with **`409 Conflict`** (`{ error: "Ambiguous key identifier ..." }`, throwing `AmbiguousKeyError` in `keys.mjs`) and modify **zero** rows whenever an identifier matches more than one active key, or when a canonical numeric id matches an existing row (even if already revoked) while a different active row carries that string as its `name` (preventing an idempotent retry of `DELETE /api/keys/1` from silently revoking an active key named `"1"`).
   - Restrict `revokeKey` and `updateKeyQuota` to `WHERE id = ? AND revoked = 0`, so every mutation targets at most one active primary key and `PATCH /api/keys/:x/quota` returns `404` on revoked keys.
   - `GET /api/keys/:x/quota` resolves active matches first (409 on ambiguity), falling back to a single unambiguous revoked row so historical quota/usage remains readable.

4. **Dashboard client hardening (`dashboard.html`).**
   - Send `DELETE /api/keys/<id>` using `k.id` (`data-revoke-id`) instead of `k.name`, surface API error messages on create/revoke, and guard `refreshKeys()` on `Array.isArray(data.keys)` so a non-admin `403` does not reveal the key-management panel.

## Class Mapping

- **Class B.2** (`/api/keys`, `/api/keys/:id`, `/api/keys/:id/quota`, `/api/usage`, and all admin-gated B.2 endpoints) + **Class B synthesis half of Hybrid `/usage`**: ADR 0006 route (b).
- **B.2 response key-set snapshot**: unchanged — every 200/201 response keeps its exact existing key set.

## Consequences

- **Pre-existing DB keys named `admin` immediately stop working as admins** upon upgrade; operators must use `OCP_ADMIN_KEY` (or trusted loopback).
- **Pre-upgrade keys bearing reserved names should be rotated:** `/api/usage` still filters single-caller (`scope.self`) rows and `usage_log` by `key_name`, so pre-existing keys already named `admin`, `anonymous`, `local`, `remote`, or `shared` still share per-name usage grouping until revoked and re-created (`POST /api/keys` now prevents creating new ones).
- **No silent multi-row revokes or quota edits:** duplicate names and id/name collisions return `409 Conflict` listing the conflicting ids so the operator can re-issue with the unambiguous numeric id.
- **Unambiguous name workflows continue working:** `ocp keys revoke <unique-name>` and key rotation (one revoked old key + one active new key of the same name) remain unambiguous and succeed unchanged.
