// Which credential source wins when more than one is present? Pure; no I/O.
//
// WHY THIS EXISTS (#475). getOAuthCredentials() reads three sources in a fixed order -- the env var,
// ~/.claude/.credentials.json, the macOS keychain -- and returned the FIRST one that had a token.
// The file step is commented "Linux file-based credentials" and is not platform-gated, so on a Mac
// a stale copy of that file shadows the live keychain: MEASURED on 2026-09-15, the file's expiresAt
// was six days in the past while the keychain's was four hours in the future, and OCP signed its
// own API calls with the dead one. Chat kept working -- the spawned `claude` uses the keychain --
// so the only symptoms were /usage answering 502 (a 401 from upstream) and `spawn.reason` stuck on
// a promise ("self-heals on next refresh") that nothing on macOS could keep, because nothing on
// macOS rewrites that file.
//
// THE RULE: a source whose credential is ALREADY EXPIRED must not shadow one that is valid. That is
// platform-agnostic and covers the reverse case too. A source with no expiresAt (the env var) is
// "not known to be expired" and keeps its precedence -- an explicit operator override is still an
// override. If EVERY source is expired, the first is returned anyway, so the refresh path still
// gets its chance with the highest-precedence refresh token; returning nothing would turn a
// recoverable state into "No OAuth token found".
//
// EXPIRY of this design: it assumes a source's `expiresAt` is a unix-ms timestamp written by the
// same tool that wrote the token. If a future source stores it differently, `isExpired` is the one
// place to teach.

export function isExpired(creds, now = Date.now()) {
  if (!creds || typeof creds !== "object") return false;
  const at = creds.expiresAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  return at <= now;
}

// `candidates`: ordered [{ source, read }], highest precedence first, where `read` is a THUNK that
// returns the source's creds (or null). Thunks, not values, and the difference is a review finding:
// the first version took values, which meant the caller had to READ EVERY SOURCE before choosing --
// so the keychain was exec'd even when the env var had already won, and a locked keychain (or one
// whose ACL prompts) could block a spawn path that never used to touch it. Reading lazily restores
// the original short-circuit: a source is read only if every higher-precedence one was absent or
// expired. The unit rows include a thunk that THROWS if called, so the laziness is a claim the
// suite checks rather than a comment.
//
// Returns { source, creds, skipped, allExpired }:
//   skipped     the sources that HAD a token and were passed over as expired IN FAVOUR OF the
//               winner -- so the caller can log why the usual winner lost. Empty when nothing was
//               passed over, including the all-expired case, where nobody made way for anybody.
//   allExpired  true when every present source is expired and the first was returned anyway.
export function selectCredential(candidates, now = Date.now()) {
  const skipped = [];
  const expired = [];
  for (const c of candidates || []) {
    if (!c || typeof c.read !== "function") continue;
    let creds = null;
    try { creds = c.read(); } catch { creds = null; }
    if (!creds || !creds.accessToken) continue;
    if (isExpired(creds, now)) {
      skipped.push(c.source);
      expired.push({ source: c.source, creds });
      continue;
    }
    return { source: c.source, creds, skipped, allExpired: false };
  }
  if (expired.length) {
    // All present sources were expired. Return the highest-precedence one that CAN refresh -- one
    // carrying a refreshToken -- and only if none can, the first. Review caught the earlier "the
    // first, so its refresh token is tried" rationale overstating what that guaranteed: a file
    // entry can carry an accessToken and expiresAt with no refreshToken at all, in which case the
    // first would have been handed to a refresh that could not succeed while a lower source
    // could. Nobody was passed over in favour of a winner here, so `skipped` is empty.
    const refreshable = expired.find((e) => typeof e.creds.refreshToken === "string" && e.creds.refreshToken);
    const pick = refreshable || expired[0];
    return { source: pick.source, creds: pick.creds, skipped: [], allExpired: true };
  }
  return { source: null, creds: null, skipped: [], allExpired: false };
}
