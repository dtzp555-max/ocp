// Pure, dependency-injected token-resolution primitive extracted from server.mjs (issue #343).
//
// server.mjs's `resolveSpawnToken()` re-applies `isTokenExpiring` to CACHED credentials on every
// use — the expiry gate that is the whole reason a short-TTL keychain cache (F5) cannot reintroduce
// the #146 forever-stale-token shape. The #343 sweep found that gate to be the ONE correctness wire
// with no test driving it: server.mjs cannot be imported by the suite (it calls `listen()` at top
// level), so a mutation deleting the gate leaves the suite green while silently resurrecting #146.
//
// The gate logic is extracted here — pure, with an injectable `isExpiring` and a fixed `now` — so
// it can be driven by a unit test. server.mjs delegates to a module-scope instance built with NO
// injection, which keeps production behaviour byte-for-byte identical to the inline gate it replaces.
//
// ALIGNMENT NOTE: same as spawn-auth.mjs — this never touches the OAuth wire machinery. It only
// READS + GATES a token that some other process refreshes (issue #112); that property is preserved.
import { isTokenExpiring as defaultIsTokenExpiring } from "./spawn-auth.mjs";

// Build the token resolver. `isExpiring` (default: the real isTokenExpiring from spawn-auth.mjs)
// and `now` (default: Date.now(), evaluated per call) are injectable for tests; production passes
// NEITHER. Returns resolveToken(creds): null when there is no access token or the token is within the
// expiry buffer, otherwise the access token itself.
export function makeResolveSpawnToken({ isExpiring = null, now = null } = {}) {
  return function resolveToken(creds) {
    if (!creds?.accessToken) return null;
    if ((isExpiring || defaultIsTokenExpiring)(creds, now ?? Date.now())) return null;
    return creds.accessToken;
  };
}
