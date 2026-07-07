// Pure, dependency-injected primitives for the `-p` spawn-token resolution + HOME-isolation
// layer. Extracted from server.mjs (findings F3 / F5 / F6, 2026-07-07) so the concurrency,
// caching and expiry logic is unit-testable WITHOUT booting the server or mocking execFileSync /
// child_process.spawn / fs. server.mjs owns all I/O (macOS keychain exec, process spawn, fs);
// this module owns only pure decision logic.
//
// ALIGNMENT NOTE: none of this touches the OAuth wire machinery (no endpoint / header / body).
// OCP still NEVER performs a refresh_token grant itself — these helpers only READ + GATE a token
// that some other process (the operator's real claude, or a spawned claude under the real HOME)
// refreshes. That property is load-bearing (issue #112) and preserved.

// Promise-chain mutex. `acquire()` resolves to a `release()` fn; the NEXT `acquire()` does not
// resolve until the current holder calls its `release()`. Serializes async critical sections
// without busy-waiting. release() is idempotent.
export function createSerialMutex() {
  let tail = Promise.resolve();
  return {
    acquire() {
      let release;
      const gate = new Promise((r) => { release = r; });
      const prev = tail;
      tail = tail.then(() => gate);
      // Hand the caller its release fn only after the previous holder has released.
      return prev.then(() => {
        let released = false;
        return function releaseMutex() { if (!released) { released = true; release(); } };
      });
    },
  };
}

// Short-TTL memo. `get(produce, now)` returns the cached value while `now - storedAt < ttlMs`,
// otherwise calls `produce()` and re-stores. A miss that produces null/undefined is STILL stored
// (so a genuinely-absent source is not re-probed on every call within the TTL window). `now` is
// injectable for testing.
export function createTtlCache({ ttlMs }) {
  let value;
  let at = -Infinity;
  let has = false;
  return {
    get(produce, now = Date.now()) {
      if (has && now - at < ttlMs) return value;
      value = produce();
      at = now;
      has = true;
      return value;
    },
    clear() { has = false; value = undefined; at = -Infinity; },
  };
}

// Pure expiry gate. Returns true when `creds` carries a known expiry that is at/within `bufferMs`
// of `now`. Creds WITHOUT `expiresAt` (e.g. long-lived env tokens) are never treated as expiring.
// This gate is applied to the CACHED creds on EVERY use — which is precisely why a short-TTL
// keychain cache (createTtlCache) cannot reintroduce the #146 forever-stale-token regression: the
// cache bounds how often we re-READ the keychain, but the expiry decision is recomputed per use.
export function isTokenExpiring(creds, now = Date.now(), bufferMs = 300000) {
  return !!(creds && creds.expiresAt && now + bufferMs >= creds.expiresAt);
}

// Order candidate keychain labels so the last-known-good label is tried first (avoids the
// wrong-label miss that doubles the `security` exec count on the hot path). Pure: performs no
// read. Returns a fresh array; input is not mutated.
export function orderLabelsLastGoodFirst(labels, lastGood) {
  if (!lastGood || !labels.includes(lastGood)) return labels.slice();
  return [lastGood, ...labels.filter((l) => l !== lastGood)];
}
