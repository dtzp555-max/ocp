#!/usr/bin/env node
/**
 * Integration test for Quota + Cache features.
 * Tests database layer functions directly — no server needed.
 */
// MUST come before keys.mjs: redirects the key store to a scratch dir (see test-env.mjs).
import { TEST_OCP_DIR } from "./test-env.mjs";
import { getDb, getDbPath, createKey, listKeys, validateKey, recordUsage, checkQuota, updateKeyQuota, getKeyQuota, findKey, cacheHash, getCachedResponse, setCachedResponse, clearCache, getCacheStats, closeDb, hasCacheControl, singleflight, getInflightStats } from "./keys.mjs";
import { isLoopbackBind } from "./lib/net.mjs";
import { createSerialMutex, createTtlCache, isTokenExpiring, orderLabelsLastGoodFirst } from "./lib/spawn-auth.mjs";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

process.env.HOME = homedir(); // normalize HOME so homedir()-derived paths are stable across shells

// The scaffolding that used to live here CLAIMED to use "a test database to avoid corrupting
// real data" by setting an env var before the first getDb(). It never worked: keys.mjs read no
// env var, and ESM hoisting meant the assignment ran after the import anyway. The redirect is
// now real, and lives in test-env.mjs (imported above, before keys.mjs). This test proves it.

let passed = 0;
let failed = 0;

// Pending promises from tests declared `async` but registered through the SYNC `test()` helper.
// 44 tests in this file are written that way. Before this, `test()` called fn(), got a promise back,
// and immediately printed ✓ and incremented `passed` — WITHOUT AWAITING IT. So for every async test:
//   - ✓ meant "did not throw synchronously", NOT "passed";
//   - a failed assertion escaped as an unhandled rejection, which crashes the process (CI still goes
//     red on the non-zero exit) but is NOT counted, so the summary could print "N passed, 0 failed"
//     and be wrong.
// The suite's own headline number was therefore not evidence for any async test — including the
// regression guards in this PR. Collected here and awaited before the summary prints.
const pendingAsync = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      // Async body: settle it before counting. Do NOT print ✓ yet.
      pendingAsync.push(
        r.then(
          () => { passed++; console.log(`  ✓ ${name}`); },
          (e) => { failed++; console.log(`  ✗ ${name}: ${e.message}`); },
        ),
      );
      return;
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

console.log("\n=== OCP Feature Tests (Quota + Cache) ===\n");

// Initialize DB
const db = getDb();

// ── Quota Tests ──
console.log("Quota:");

const key1 = createKey("test-user-1");
const key2 = createKey("test-user-2");

test("createKey returns id, key, name", () => {
  assert.ok(key1.id);
  assert.ok(key1.key.startsWith("ocp_"));
  assert.equal(key1.name, "test-user-1");
});

test("listKeys includes quota fields", () => {
  const keys = listKeys();
  assert.ok(keys.length >= 2);
  const k = keys.find(k => k.name === "test-user-1");
  assert.ok("quota_daily" in k);
  assert.ok("quota_weekly" in k);
  assert.ok("quota_monthly" in k);
  assert.equal(k.quota_daily, null);
});

test("checkQuota returns null when no quota set", () => {
  const result = checkQuota(key1.id, key1.name);
  assert.equal(result, null);
});

test("checkQuota returns null for null keyId", () => {
  assert.equal(checkQuota(null, "anon"), null);
  assert.equal(checkQuota(undefined, "anon"), null);
});

test("updateKeyQuota sets daily quota (partial update)", () => {
  const ok = updateKeyQuota(key1.id, { daily: 5 });
  assert.ok(ok);
  const quota = getKeyQuota(key1.id);
  assert.equal(quota.daily.limit, 5);
  assert.equal(quota.weekly.limit, null); // not touched
  assert.equal(quota.monthly.limit, null);
});

test("updateKeyQuota partial update preserves existing values", () => {
  updateKeyQuota(key1.id, { weekly: 20 });
  const quota = getKeyQuota(key1.id);
  assert.equal(quota.daily.limit, 5);  // preserved from previous call
  assert.equal(quota.weekly.limit, 20);
});

test("checkQuota passes when under limit", () => {
  // Record 3 usages (limit is 5 daily)
  for (let i = 0; i < 3; i++) {
    recordUsage({ keyId: key1.id, keyName: key1.name, model: "sonnet", promptChars: 100, responseChars: 50, elapsedMs: 1000, success: true });
  }
  const result = checkQuota(key1.id, key1.name);
  assert.equal(result, null);
});

test("checkQuota returns exceeded when at limit", () => {
  // Record 2 more to hit limit (3 + 2 = 5)
  for (let i = 0; i < 2; i++) {
    recordUsage({ keyId: key1.id, keyName: key1.name, model: "sonnet", promptChars: 100, responseChars: 50, elapsedMs: 1000, success: true });
  }
  const result = checkQuota(key1.id, key1.name);
  assert.ok(result);
  assert.equal(result.period, "daily");
  assert.equal(result.limit, 5);
  assert.equal(result.used, 5);
  assert.ok(result.resetsIn);
});

test("checkQuota ignores failed requests in count", () => {
  // key2 has quota of 2 daily
  updateKeyQuota(key2.id, { daily: 2 });
  recordUsage({ keyId: key2.id, keyName: key2.name, model: "sonnet", promptChars: 100, responseChars: 0, elapsedMs: 500, success: false });
  recordUsage({ keyId: key2.id, keyName: key2.name, model: "sonnet", promptChars: 100, responseChars: 50, elapsedMs: 1000, success: true });
  const result = checkQuota(key2.id, key2.name);
  assert.equal(result, null); // only 1 successful, limit is 2
});

test("getKeyQuota returns correct used counts", () => {
  const quota = getKeyQuota(key1.id);
  assert.equal(quota.daily.used, 5);
  assert.equal(quota.daily.limit, 5);
});

test("findKey works by id and name", () => {
  const byId = findKey(String(key1.id));
  assert.ok(byId);
  assert.equal(byId.name, "test-user-1");
  const byName = findKey("test-user-1");
  assert.ok(byName);
  // Compare by name since auto-increment IDs may vary across runs
  assert.equal(byName.name, "test-user-1");
  assert.equal(findKey("nonexistent"), null);
});

// ── Cache Tests ──
console.log("\nCache:");

// Clean slate for cache tests
clearCache();

const msgs1 = [{ role: "user", content: "Hello world" }];
const msgs2 = [{ role: "user", content: "Different prompt" }];

test("cacheHash is deterministic", () => {
  const h1 = cacheHash("sonnet", msgs1);
  const h2 = cacheHash("sonnet", msgs1);
  assert.equal(h1, h2);
});

test("cacheHash differs for different models", () => {
  const h1 = cacheHash("sonnet", msgs1);
  const h2 = cacheHash("opus", msgs1);
  assert.notEqual(h1, h2);
});

test("cacheHash differs for different messages", () => {
  const h1 = cacheHash("sonnet", msgs1);
  const h2 = cacheHash("sonnet", msgs2);
  assert.notEqual(h1, h2);
});

test("cacheHash includes temperature in hash", () => {
  const h1 = cacheHash("sonnet", msgs1, {});
  const h2 = cacheHash("sonnet", msgs1, { temperature: 0.5 });
  const h3 = cacheHash("sonnet", msgs1, { temperature: 1.0 });
  assert.notEqual(h1, h2);
  assert.notEqual(h2, h3);
});

// ── configEpoch (#176): a boot-config change must invalidate the persistent cache ──
// Mutation-proof: drop the `ce:` fold in keys.mjs and the first test goes green-to-red.
test("cacheHash: different configEpoch → different key (config change invalidates)", () => {
  const h1 = cacheHash("sonnet", msgs1, { configEpoch: "aaaa000011112222" });
  const h2 = cacheHash("sonnet", msgs1, { configEpoch: "bbbb000011112222" });
  assert.notEqual(h1, h2);
});

test("cacheHash: same configEpoch is stable; absent epoch hashes byte-identically to pre-#176", () => {
  const e1 = cacheHash("sonnet", msgs1, { configEpoch: "aaaa000011112222" });
  const e2 = cacheHash("sonnet", msgs1, { configEpoch: "aaaa000011112222" });
  assert.equal(e1, e2);
  // absent-epoch calls (older callers, all pre-existing tests) must not change behavior
  assert.equal(cacheHash("sonnet", msgs1, {}), cacheHash("sonnet", msgs1));
  assert.notEqual(e1, cacheHash("sonnet", msgs1), "epoch-carrying key differs from legacy key");
});

test("cacheHash includes max_tokens in hash", () => {
  const h1 = cacheHash("sonnet", msgs1, {});
  const h2 = cacheHash("sonnet", msgs1, { max_tokens: 100 });
  assert.notEqual(h1, h2);
});

test("getCachedResponse returns null for miss", () => {
  const hash = cacheHash("sonnet", msgs1);
  const result = getCachedResponse(hash, 3600000);
  assert.equal(result, null);
});

test("setCachedResponse + getCachedResponse roundtrip", () => {
  const hash = cacheHash("sonnet", msgs1);
  setCachedResponse(hash, "sonnet", "Hello! I am Claude.");
  const result = getCachedResponse(hash, 3600000);
  assert.ok(result);
  assert.equal(result.response, "Hello! I am Claude.");
  assert.equal(result.hits, 1);
});

test("getCachedResponse increments hit counter", () => {
  const hash = cacheHash("sonnet", msgs1);
  const r1 = getCachedResponse(hash, 3600000);
  const r2 = getCachedResponse(hash, 3600000);
  assert.equal(r1.hits, 2);
  assert.equal(r2.hits, 3);
});

test("getCachedResponse respects TTL (expired entry)", () => {
  // Insert a backdated cache entry directly
  const d = getDb();
  const oldHash = "test_expired_hash_12345";
  d.prepare("INSERT OR REPLACE INTO response_cache (hash, model, response, created_at) VALUES (?, ?, ?, datetime('now', '-2 hours'))").run(oldHash, "sonnet", "Old response");
  // TTL of 1 hour should not return a 2-hour-old entry
  const result = getCachedResponse(oldHash, 3600000);
  assert.equal(result, null);
  // Clean up the backdated entry so it doesn't affect subsequent tests
  d.prepare("DELETE FROM response_cache WHERE hash = ?").run(oldHash);
});

test("getCacheStats returns correct counts", () => {
  const stats = getCacheStats();
  assert.equal(stats.entries, 1);
  assert.ok(stats.totalHits >= 3);
  assert.ok(stats.sizeBytes > 0);
});

test("setCachedResponse upserts on conflict", () => {
  const hash = cacheHash("sonnet", msgs1);
  setCachedResponse(hash, "sonnet", "Updated response!");
  const result = getCachedResponse(hash, 3600000);
  assert.equal(result.response, "Updated response!");
  assert.equal(result.hits, 1); // reset after upsert
});

test("clearCache removes all entries", () => {
  // Add another entry
  const hash2 = cacheHash("sonnet", msgs2);
  setCachedResponse(hash2, "sonnet", "Another response");
  const statsBefore = getCacheStats();
  assert.equal(statsBefore.entries, 2);

  const cleared = clearCache();
  assert.equal(cleared, 2);

  const statsAfter = getCacheStats();
  assert.equal(statsAfter.entries, 0);
});

test("clearCache with TTL only removes old entries", () => {
  // Add fresh entry
  const hash = cacheHash("sonnet", msgs1);
  setCachedResponse(hash, "sonnet", "Fresh response");

  // Clear with TTL of 1 hour — fresh entry should survive
  const cleared = clearCache(3600000);
  assert.equal(cleared, 0);

  const stats = getCacheStats();
  assert.equal(stats.entries, 1);

  // Clean up
  clearCache();
});

// ── PR-A: Per-key isolation (D1), cache_control bypass (D2), chunked replay (D3) ──
console.log("\nPR-A Cache Upgrade:");

const msgsBase = [{ role: "user", content: "Shared prompt text" }];

test("D1: cacheHash with two distinct keyIds produces different hashes", () => {
  const h1 = cacheHash("sonnet", msgsBase, { keyId: "key-aaa" });
  const h2 = cacheHash("sonnet", msgsBase, { keyId: "key-bbb" });
  assert.notEqual(h1, h2);
});

test("D1: cacheHash with keyId=undefined and keyId='anon' produce the same hash", () => {
  const hUndef = cacheHash("sonnet", msgsBase, { keyId: undefined });
  const hAnon  = cacheHash("sonnet", msgsBase, { keyId: "anon" });
  assert.equal(hUndef, hAnon);
});

test("D1: cacheHash with keyId=null and keyId='anon' produce the same hash", () => {
  const hNull = cacheHash("sonnet", msgsBase, { keyId: null });
  const hAnon = cacheHash("sonnet", msgsBase, { keyId: "anon" });
  assert.equal(hNull, hAnon);
});

test("D1: v2 prefix — hash differs from a v1-style baseline (no prefix)", () => {
  // Reproduce a v1-style hash manually to confirm v2 differs
  const v1 = createHash("sha256")
    .update("sonnet")
    .update(msgsBase[0].role)
    .update(msgsBase[0].content)
    .digest("hex");
  const v2 = cacheHash("sonnet", msgsBase, { keyId: "anon" });
  assert.notEqual(v1, v2);
});

test("D1: cacheHash is reproducible for same keyId (determinism)", () => {
  const h1 = cacheHash("sonnet", msgsBase, { keyId: "key-xyz" });
  const h2 = cacheHash("sonnet", msgsBase, { keyId: "key-xyz" });
  assert.equal(h1, h2);
});

test("D2: hasCacheControl returns true for top-level cache_control on message", () => {
  const msgs = [{ role: "user", cache_control: { type: "ephemeral" }, content: "hello" }];
  assert.equal(hasCacheControl(msgs), true);
});

test("D2: hasCacheControl returns true for nested cache_control in content array", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }];
  assert.equal(hasCacheControl(msgs), true);
});

test("D2: hasCacheControl returns false for plain string content", () => {
  const msgs = [{ role: "user", content: "plain string" }];
  assert.equal(hasCacheControl(msgs), false);
});

test("D2: hasCacheControl returns false for content array without cache_control", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "x" }] }];
  assert.equal(hasCacheControl(msgs), false);
});

test("D2: hasCacheControl handles null/empty input gracefully", () => {
  assert.equal(hasCacheControl(null), false);
  assert.equal(hasCacheControl([]), false);
  assert.equal(hasCacheControl([null, undefined]), false);
});

// D3: chunked stream replay — verify the logic by simulating what server.mjs does
test("D3: 160-char cached response produces 2 chunks at 80 codepoints/chunk", () => {
  const content = "a".repeat(160);
  const CACHE_REPLAY_CHUNK_SIZE = 80;
  const codepoints = Array.from(content);
  const chunks = [];
  for (let i = 0; i < codepoints.length; i += CACHE_REPLAY_CHUNK_SIZE) {
    chunks.push(codepoints.slice(i, i + CACHE_REPLAY_CHUNK_SIZE).join(""));
  }
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 80);
  assert.equal(chunks[1].length, 80);
});

test("D3: chunked replay uses Array.from — multibyte codepoints stay intact", () => {
  // Each Chinese character is 1 codepoint but 3 UTF-8 bytes
  const chinese = "你好世界".repeat(25); // 100 codepoints
  const CACHE_REPLAY_CHUNK_SIZE = 80;
  const codepoints = Array.from(chinese);
  const chunks = [];
  for (let i = 0; i < codepoints.length; i += CACHE_REPLAY_CHUNK_SIZE) {
    chunks.push(codepoints.slice(i, i + CACHE_REPLAY_CHUNK_SIZE).join(""));
  }
  assert.equal(chunks.length, 2);
  assert.equal(Array.from(chunks[0]).length, 80);
  assert.equal(Array.from(chunks[1]).length, 20);
  // Verify each character is a complete codepoint (no mojibake)
  for (const chunk of chunks) {
    for (const cp of Array.from(chunk)) {
      assert.equal(cp.length <= 2, true); // surrogate pairs are length 2, single chars length 1
    }
  }
});

// ── PR-B Singleflight tests (async) ──
async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

async function runSingleflightTests() {
  console.log("\nPR-B Singleflight:");

  // 1. Basic dedup: 10 concurrent calls with same hash execute fn only once.
  await asyncTest("basic dedup: 10 concurrent callers execute fn only once", async () => {
    let callCount = 0;
    const fn = () => new Promise(resolve => {
      callCount++;
      setTimeout(() => resolve("result-A"), 20);
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => singleflight("sf-dedup-1", fn)));
    assert.equal(callCount, 1, `fn called ${callCount} times, expected 1`);
    assert.ok(results.every(r => r === "result-A"), "all 10 callers should receive the same return value");
  });

  // 2. Failure fan-out: all followers reject when leader rejects.
  await asyncTest("failure fan-out: all followers reject with leader error", async () => {
    let callCount = 0;
    const fn = () => new Promise((_, reject) => {
      callCount++;
      setTimeout(() => reject(new Error("upstream-fail")), 20);
    });
    const promises = Array.from({ length: 10 }, () => singleflight("sf-fail-1", fn));
    const results = await Promise.allSettled(promises);
    assert.equal(callCount, 1, `fn called ${callCount} times, expected 1`);
    assert.ok(results.every(r => r.status === "rejected"), "all 10 should be rejected");
    assert.ok(results.every(r => r.reason?.message === "upstream-fail"), "all should share the same error message");
  });

  // 3a. Map cleanup after success: inflight count returns to 0 after promise resolves.
  await asyncTest("map cleanup after success: inflight=0 after promise settles", async () => {
    const fn = () => new Promise(resolve => setTimeout(() => resolve("done"), 10));
    await singleflight("sf-cleanup-ok", fn);
    const stats = getInflightStats();
    assert.equal(stats.inflight, 0, `expected inflight=0 after settlement, got ${stats.inflight}`);
  });

  // 3b. Map cleanup after failure: inflight count returns to 0 after promise rejects.
  await asyncTest("map cleanup after failure: inflight=0 after promise rejects", async () => {
    const fn = () => new Promise((_, reject) => setTimeout(() => reject(new Error("fail")), 10));
    try { await singleflight("sf-cleanup-fail", fn); } catch {}
    const stats = getInflightStats();
    assert.equal(stats.inflight, 0, `expected inflight=0 after rejection, got ${stats.inflight}`);
  });

  // 4. Different hashes don't share: two parallel calls with distinct hashes both execute.
  await asyncTest("different hashes do not share a singleflight entry", async () => {
    let countA = 0;
    let countB = 0;
    const fnA = () => new Promise(resolve => { countA++; setTimeout(() => resolve("A"), 20); });
    const fnB = () => new Promise(resolve => { countB++; setTimeout(() => resolve("B"), 20); });
    const [rA, rB] = await Promise.all([singleflight("sf-hash-A", fnA), singleflight("sf-hash-B", fnB)]);
    assert.equal(countA, 1);
    assert.equal(countB, 1);
    assert.equal(rA, "A");
    assert.equal(rB, "B");
  });

  // 5. getInflightStats shape: returns { inflight: number, requesters: number }.
  await asyncTest("getInflightStats returns correct shape", async () => {
    // Verify shape against a settled state (inflight=0 is still the right shape).
    const stats = getInflightStats();
    assert.equal(typeof stats.inflight, "number", "inflight should be a number");
    assert.equal(typeof stats.requesters, "number", "requesters should be a number");
    // Also verify live counts: start a pending fn, check inflight>0, then resolve.
    const { promise: blocker, resolve: resolveBlocker } = Promise.withResolvers();
    const fn = () => blocker;
    const p = singleflight("sf-stats-shape", fn);
    const liveStats = getInflightStats();
    assert.ok(liveStats.inflight >= 1, `expected inflight>=1, got ${liveStats.inflight}`);
    resolveBlocker("ok");
    await p;
  });

  // 6. Sequential calls don't share: singleflight is for concurrent dedup only.
  await asyncTest("sequential calls with same hash each execute fn independently", async () => {
    let callCount = 0;
    const fn = () => new Promise(resolve => { callCount++; setTimeout(() => resolve(callCount), 10); });
    const r1 = await singleflight("sf-sequential", fn);
    const r2 = await singleflight("sf-sequential", fn);
    assert.equal(callCount, 2, `fn should have been called twice, got ${callCount}`);
    assert.equal(r1, 1);
    assert.equal(r2, 2);
  });

  // 7. M1: leader disconnect while queued must not poison live followers. server.mjs passes
  // retryIf = (err) => err instanceof RequestDisconnectedError && !res.destroyed — here we
  // model that with a tagged error class. The leader (no retryIf on its own promise — the
  // rejection is ITS OWN disconnect) sees the error; the live follower re-executes its OWN
  // fn and gets a real result instead of a spurious inherited failure.
  await asyncTest("M1: leader disconnects while queued → live follower re-executes and gets a real result", async () => {
    class FakeDisconnectError extends Error {}
    const leaderGate = Promise.withResolvers();
    let leaderRuns = 0;
    let followerRuns = 0;
    const leaderFn = async () => { leaderRuns++; await leaderGate.promise; throw new FakeDisconnectError("leader client gone"); };
    const followerFn = async () => { followerRuns++; return "real-execution"; };
    const retryIf = (err) => err instanceof FakeDisconnectError;

    const leaderP = singleflight("sf-m1-leader-dc", leaderFn);             // becomes leader
    const followerP = singleflight("sf-m1-leader-dc", followerFn, retryIf); // joins as follower
    leaderGate.resolve(); // leader "disconnects" while holding the flight

    await assert.rejects(leaderP, FakeDisconnectError, "the leader itself still sees its own disconnect");
    assert.equal(await followerP, "real-execution", "follower got a REAL execution, not the leader's disconnect");
    assert.equal(leaderRuns, 1, "leader fn ran once");
    assert.equal(followerRuns, 1, "follower re-executed exactly once (as the new leader)");
    assert.equal(getInflightStats().inflight, 0, "map fully cleaned up after the retry flight settles");
  });

  // 8. M1 guard: a follower whose retryIf returns false (server.mjs: its OWN client is also
  // gone) inherits the rejection unchanged — no retry, no masked error. And a follower with
  // NO retryIf keeps the exact pre-M1 share-everything behavior (test 2 pins the fan-out;
  // this pins the predicate=false path specifically for the disconnect error).
  await asyncTest("M1: follower with retryIf=false (own client also gone) inherits the leader's rejection, no retry", async () => {
    class FakeDisconnectError extends Error {}
    const gate = Promise.withResolvers();
    let followerRuns = 0;
    const leaderFn = async () => { await gate.promise; throw new FakeDisconnectError("leader client gone"); };
    const followerFn = async () => { followerRuns++; return "should-never-run"; };

    const leaderP = singleflight("sf-m1-both-dc", leaderFn);
    const followerP = singleflight("sf-m1-both-dc", followerFn, () => false); // own client dead → no retry
    gate.resolve();

    await assert.rejects(leaderP, FakeDisconnectError);
    await assert.rejects(followerP, FakeDisconnectError, "rejection propagates unchanged when retryIf says no");
    assert.equal(followerRuns, 0, "follower fn never executed — no wasted spawn for a dead client");
    assert.equal(getInflightStats().inflight, 0);
  });
}

await runSingleflightTests();

// ── Plist Env Merge Tests ──
import { mergePlistEnv, mergeSystemdEnv, NEVER_PRESERVE } from "./scripts/lib/plist-merge.mjs";

console.log("\nPlist env merge:");

const SAMPLE_TEMPLATE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ocp.proxy</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_PROXY_PORT</key>
    <string>3478</string>
    <key>CLAUDE_BIND</key>
    <string>127.0.0.1</string>
    <key>CLAUDE_AUTH_MODE</key>
    <string>multi</string>
  </dict>
</dict>
</plist>`;

const SAMPLE_EXISTING_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ocp.proxy</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_PROXY_PORT</key>
    <string>3456</string>
    <key>CLAUDE_BIND</key>
    <string>127.0.0.1</string>
    <key>CLAUDE_AUTH_MODE</key>
    <string>none</string>
    <key>CLAUDE_HEARTBEAT_INTERVAL</key>
    <string>2000</string>
    <key>CLAUDE_CACHE_TTL</key>
    <string>600</string>
  </dict>
</dict>
</plist>`;

test("mergePlistEnv preserves unknown user keys", () => {
  const merged = mergePlistEnv(SAMPLE_EXISTING_PLIST, SAMPLE_TEMPLATE_PLIST);
  assert.match(merged, /<key>CLAUDE_HEARTBEAT_INTERVAL<\/key>\s*<string>2000<\/string>/);
  assert.match(merged, /<key>CLAUDE_CACHE_TTL<\/key>\s*<string>600<\/string>/);
});

test("mergePlistEnv overrides known template keys", () => {
  const merged = mergePlistEnv(SAMPLE_EXISTING_PLIST, SAMPLE_TEMPLATE_PLIST);
  assert.match(merged, /<key>CLAUDE_PROXY_PORT<\/key>\s*<string>3478<\/string>/);
  assert.match(merged, /<key>CLAUDE_AUTH_MODE<\/key>\s*<string>multi<\/string>/);
});

test("mergePlistEnv first-install returns template unchanged when existing is null", () => {
  const merged = mergePlistEnv(null, SAMPLE_TEMPLATE_PLIST);
  assert.equal(merged, SAMPLE_TEMPLATE_PLIST);
});

test("mergePlistEnv first-install returns template unchanged when existing is empty", () => {
  const merged = mergePlistEnv("", SAMPLE_TEMPLATE_PLIST);
  assert.equal(merged, SAMPLE_TEMPLATE_PLIST);
});

const SAMPLE_TEMPLATE_SYSTEMD = `[Unit]
Description=OCP — Open Claude Proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /home/u/ocp/server.mjs
Environment=CLAUDE_PROXY_PORT=3478
Environment=CLAUDE_BIND=127.0.0.1
Environment=CLAUDE_AUTH_MODE=multi
Restart=always
`;

const SAMPLE_EXISTING_SYSTEMD = `[Unit]
Description=OCP — Open Claude Proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /home/u/ocp/server.mjs
Environment=CLAUDE_PROXY_PORT=3456
Environment=CLAUDE_BIND=127.0.0.1
Environment=CLAUDE_AUTH_MODE=none
Environment=CLAUDE_HEARTBEAT_INTERVAL=2000
Environment=CLAUDE_CACHE_TTL=600
Restart=always
`;

test("mergeSystemdEnv preserves unknown user Environment lines", () => {
  const merged = mergeSystemdEnv(SAMPLE_EXISTING_SYSTEMD, SAMPLE_TEMPLATE_SYSTEMD);
  assert.match(merged, /Environment=CLAUDE_HEARTBEAT_INTERVAL=2000/);
  assert.match(merged, /Environment=CLAUDE_CACHE_TTL=600/);
});

test("mergeSystemdEnv overrides known template keys", () => {
  const merged = mergeSystemdEnv(SAMPLE_EXISTING_SYSTEMD, SAMPLE_TEMPLATE_SYSTEMD);
  assert.match(merged, /Environment=CLAUDE_PROXY_PORT=3478/);
  assert.match(merged, /Environment=CLAUDE_AUTH_MODE=multi/);
});

test("mergeSystemdEnv first-install returns template unchanged", () => {
  assert.equal(mergeSystemdEnv(null, SAMPLE_TEMPLATE_SYSTEMD), SAMPLE_TEMPLATE_SYSTEMD);
  assert.equal(mergeSystemdEnv("", SAMPLE_TEMPLATE_SYSTEMD), SAMPLE_TEMPLATE_SYSTEMD);
});

test("mergePlistEnv is idempotent", () => {
  const r1 = mergePlistEnv(SAMPLE_EXISTING_PLIST, SAMPLE_TEMPLATE_PLIST);
  assert.equal(mergePlistEnv(r1, SAMPLE_TEMPLATE_PLIST), r1);
});

// ── A4: security denylist — test-only key-store redirection vars must NEVER survive a setup
// re-run, even when a prior unit already carried them. Mutation-proof: drop the
// `!NEVER_PRESERVE.has(k)` guard in either merge fn and these fail (the vars get preserved).
test("NEVER_PRESERVE denylists exactly the two key-store redirection vars", () => {
  assert.ok(NEVER_PRESERVE.has("NODE_ENV") && NEVER_PRESERVE.has("OCP_DIR_OVERRIDE"));
  assert.equal(NEVER_PRESERVE.size, 2, "exactly two — a new entry needs its own rationale + test");
});

const PLIST_EXISTING_WITH_TEST_VARS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.ocp.proxy</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_PROXY_PORT</key>
    <string>3456</string>
    <key>CLAUDE_CACHE_TTL</key>
    <string>600</string>
    <key>NODE_ENV</key>
    <string>test</string>
    <key>OCP_DIR_OVERRIDE</key>
    <string>/tmp/scratch-store</string>
  </dict>
</dict>
</plist>`;

test("mergePlistEnv strips test-only redirection vars (A4) but keeps legit user keys", () => {
  const merged = mergePlistEnv(PLIST_EXISTING_WITH_TEST_VARS, SAMPLE_TEMPLATE_PLIST);
  assert.match(merged, /<key>CLAUDE_CACHE_TTL<\/key>\s*<string>600<\/string>/, "a legit user key is still preserved");
  assert.doesNotMatch(merged, /<key>NODE_ENV<\/key>/, "NODE_ENV must never reach a service unit");
  assert.doesNotMatch(merged, /OCP_DIR_OVERRIDE/, "OCP_DIR_OVERRIDE must never reach a service unit (key or value)");
});

test("mergePlistEnv: an existing unit whose ONLY extras are denylisted → template unchanged", () => {
  const existing = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_PROXY_PORT</key>
    <string>3456</string>
    <key>NODE_ENV</key>
    <string>test</string>
    <key>OCP_DIR_OVERRIDE</key>
    <string>/tmp/scratch-store</string>
  </dict>
</dict>
</plist>`;
  assert.equal(mergePlistEnv(existing, SAMPLE_TEMPLATE_PLIST), SAMPLE_TEMPLATE_PLIST, "nothing left to preserve → clean template");
});

const SYSTEMD_EXISTING_WITH_TEST_VARS = `[Unit]
Description=OCP — Open Claude Proxy

[Service]
ExecStart=/usr/bin/node /home/u/ocp/server.mjs
Environment=CLAUDE_PROXY_PORT=3456
Environment=CLAUDE_CACHE_TTL=600
Environment=NODE_ENV=test
Environment=OCP_DIR_OVERRIDE=/tmp/scratch-store
Restart=always
`;

test("mergeSystemdEnv strips test-only redirection vars (A4) but keeps legit user keys", () => {
  const merged = mergeSystemdEnv(SYSTEMD_EXISTING_WITH_TEST_VARS, SAMPLE_TEMPLATE_SYSTEMD);
  assert.match(merged, /Environment=CLAUDE_CACHE_TTL=600/, "a legit user key is still preserved");
  assert.doesNotMatch(merged, /Environment=NODE_ENV=/, "NODE_ENV must never reach a service unit");
  assert.doesNotMatch(merged, /OCP_DIR_OVERRIDE/, "OCP_DIR_OVERRIDE must never reach a service unit");
});

test("mergeSystemdEnv is idempotent", () => {
  const r1 = mergeSystemdEnv(SAMPLE_EXISTING_SYSTEMD, SAMPLE_TEMPLATE_SYSTEMD);
  assert.equal(mergeSystemdEnv(r1, SAMPLE_TEMPLATE_SYSTEMD), r1);
});

// ── Doctor JSON Contract Tests ──
import { runDoctor } from "./scripts/doctor.mjs";

console.log("\nDoctor:");

test("doctor --json shape: required top-level keys", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.10.0", mockLatest: "v3.14.0" });
  for (const k of ["schema_version", "ready_to_upgrade", "current_version", "latest_version",
                   "from_version_supported", "fail_count", "warn_count", "checks", "next_action"]) {
    assert.ok(k in result, `missing key: ${k}`);
  }
  assert.equal(result.schema_version, "1");
});

test("doctor detects from-version < v3.4.0 → fresh_install", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.2.0", mockLatest: "v3.14.0" });
  assert.equal(result.from_version_supported, false);
  assert.equal(result.next_action.kind, "fresh_install");
  assert.ok(Array.isArray(result.next_action.ai_executable));
  assert.ok(result.next_action.ai_executable.length > 0);
});

test("doctor next_action.kind enum is one of allowed values", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.10.0", mockLatest: "v3.14.0" });
  const ALLOWED = ["noop", "update", "upgrade", "fresh_install", "fix_oauth", "fix_service"];
  assert.ok(ALLOWED.includes(result.next_action.kind), `kind=${result.next_action.kind} not in enum`);
});

test("doctor noop when current==latest", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.14.0", mockLatest: "v3.14.0" });
  assert.equal(result.next_action.kind, "noop");
  assert.equal(result.ready_to_upgrade, true);
});

test("doctor patch-bump same minor → update kind", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.14.0", mockLatest: "v3.14.1" });
  assert.equal(result.next_action.kind, "update");
});

test("doctor cross-minor → upgrade kind", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.10.0", mockLatest: "v3.14.0" });
  assert.equal(result.next_action.kind, "upgrade");
});

test("doctor OAuth FAIL → fix_oauth kind", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.10.0",
    mockLatest: "v3.14.0",
    mockHealth: { status: 200, body: { auth: { ok: false, message: "ENOEXEC" } } }
  });
  assert.equal(result.next_action.kind, "fix_oauth");
  assert.ok(result.next_action.ai_executable.some(c => c.includes("install.cjs")));
});

test("doctor service down → fix_service kind", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.10.0",
    mockLatest: "v3.14.0",
    mockHealth: { error: "ECONNREFUSED" }
  });
  assert.equal(result.next_action.kind, "fix_service");
});

test("doctor unparseable version → fresh_install", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "garbage", mockLatest: "v3.14.0" });
  assert.equal(result.from_version_supported, false);
  assert.equal(result.next_action.kind, "fresh_install");
});

test("doctor empty health body → fix_service (not fix_oauth)", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.10.0",
    mockLatest: "v3.14.0",
    mockHealth: { status: 200, body: null }
  });
  assert.equal(result.next_action.kind, "fix_service");
});

test("doctor falls back to currentVersion when origin/main unreachable (no stale latest)", async () => {
  // Use a non-existent ocpDir so git command fails; without the fix this would still
  // hard-code v3.14.0 as latest and recommend a downgrade for a future v3.15.0+ user.
  const result = await runDoctor({
    skipNetwork: true,
    mockVersion: "v3.15.0",
    ocpDir: "/nonexistent-ocp-dir-for-test"
  });
  assert.equal(result.latest_version, "v3.15.0");
  assert.equal(result.next_action.kind, "noop");
});

// ── System-prompt operator append (CLAUDE_SYSTEM_PROMPT wiring) ─────────────
// The var was documented + echoed on /health but never reached a request (dead
// since APPEND_SYSTEM_PROMPT was retired — caught in PR #170 review). The wiring
// contract lives in lib/prompt.mjs. Mutation-proof: make appendOperatorPrompt
// return `base` unconditionally and the first test fails; make it stop trimming
// and the whitespace test fails.
import { appendOperatorPrompt, derivePromptCharBudget, resolvePromptCharBudget, selectPromptWrapper, localToolsSafetyError } from "./lib/prompt.mjs";

console.log("\nPrompt-char budget (ADR 0009 — SPOT-derived):");

// Mutation-proof: drop the ×charsPerToken and the first test fails; drop the
// Math.max floor guard and the floor tests fail; use min() instead of max() over
// windows and the largest-window test fails.
test("derivePromptCharBudget: LARGEST contextWindow × 3 chars/token", () => {
  const models = [{ contextWindow: 200000 }, { contextWindow: 100000 }];
  assert.equal(derivePromptCharBudget(models), 600000);
});

test("derivePromptCharBudget: matches the live models.json SPOT (200k → 600k today)", () => {
  const spot = JSON.parse(tuiReadFileSync(new URL("./models.json", import.meta.url), "utf8"));
  assert.equal(derivePromptCharBudget(spot.models), 600000);
});

test("derivePromptCharBudget: floor wins over a tiny/absent window; empty input → floor", () => {
  assert.equal(derivePromptCharBudget([{ contextWindow: 1000 }]), 150000, "3k chars would truncate everything — floor guards it");
  assert.equal(derivePromptCharBudget([]), 150000);
  assert.equal(derivePromptCharBudget(undefined), 150000);
  assert.equal(derivePromptCharBudget([{ id: "x" }, { contextWindow: "junk" }, { contextWindow: -5 }]), 150000);
});

test("derivePromptCharBudget: charsPerToken and floor are tunable parameters", () => {
  assert.equal(derivePromptCharBudget([{ contextWindow: 1000000 }], { charsPerToken: 3 }), 3000000);
  assert.equal(derivePromptCharBudget([], { floor: 42 }), 42);
});

// PR #179 review regression: EMPTY env value must mean "use the default" (the old
// `parseInt(env || "150000")` contract). Mutation-proof: switch the resolver's
// truthiness check to `!= null` and the empty-string test fails (NaN ≠ 600000).
test("resolvePromptCharBudget: empty/unset env → SPOT-derived default, never NaN", () => {
  const models = [{ contextWindow: 200000 }];
  assert.equal(resolvePromptCharBudget("", models), 600000, "CLAUDE_MAX_PROMPT_CHARS= (empty) must fall back to derived");
  assert.equal(resolvePromptCharBudget(undefined, models), 600000);
});

test("resolvePromptCharBudget: a set env value overrides the derivation absolutely", () => {
  const models = [{ contextWindow: 200000 }];
  assert.equal(resolvePromptCharBudget("300000", models), 300000);
  assert.equal(resolvePromptCharBudget("150000", models), 150000, "explicit legacy value wins over the bigger derived default");
});

console.log("\nSystem-prompt operator append:");

test("appendOperatorPrompt: appends the operator prompt LAST, blank-line separated", () => {
  assert.equal(appendOperatorPrompt("WRAPPER\n\nclient", "Answer in Chinese."), "WRAPPER\n\nclient\n\nAnswer in Chinese.");
});

test("appendOperatorPrompt: unset/empty/whitespace-only → base returned BYTE-IDENTICAL", () => {
  const base = "WRAPPER\n\nclient sys";
  assert.equal(appendOperatorPrompt(base, undefined), base);
  assert.equal(appendOperatorPrompt(base, ""), base);
  assert.equal(appendOperatorPrompt(base, "   \n "), base, "a stray space in a service unit must not inject anything");
  assert.equal(appendOperatorPrompt(base, null), base);
});

test("appendOperatorPrompt: operator value is trimmed before appending", () => {
  assert.equal(appendOperatorPrompt("W", "  hi  "), "W\n\nhi");
});

// ── OCP_LOCAL_TOOLS wrapper selection + safety gate (lib/prompt.mjs) ──────────
console.log("\nOCP_LOCAL_TOOLS wrapper + safety gate:");

const NEG = "You do NOT have access to any local filesystem";
const POS = "You have full access to the local filesystem";

test("selectPromptWrapper: default (disabled) returns the negative wrapper BYTE-IDENTICAL", () => {
  // Mutation-proof: flip the ternary and the default path leaks the positive wrapper.
  assert.equal(selectPromptWrapper(false, NEG, POS), NEG);
});

test("selectPromptWrapper: enabled returns the positive (local-tools) wrapper", () => {
  assert.equal(selectPromptWrapper(true, NEG, POS), POS);
});

test("localToolsSafetyError: disabled → null regardless of an otherwise-unsafe deploy", () => {
  // The gate must not fire when the flag is off — the default path is never blocked.
  assert.equal(localToolsSafetyError({ enabled: false, authMode: "multi", loopbackBind: false, anonymousKey: true }), null);
});

test("localToolsSafetyError: enabled on a safe single-user loopback instance → null (boots)", () => {
  assert.equal(localToolsSafetyError({ enabled: true, authMode: "none", loopbackBind: true, anonymousKey: false }), null);
  assert.equal(localToolsSafetyError({ enabled: true, authMode: "shared", loopbackBind: true, anonymousKey: false }), null);
});

test("localToolsSafetyError: enabled + AUTH_MODE=multi → fatal (guest could be told it has FS)", () => {
  const e = localToolsSafetyError({ enabled: true, authMode: "multi", loopbackBind: true, anonymousKey: false });
  assert.ok(e && /multi/.test(e), `expected a multi-tenant fatal, got: ${e}`);
});

test("localToolsSafetyError: enabled + non-loopback bind → fatal (network-exposed)", () => {
  const e = localToolsSafetyError({ enabled: true, authMode: "none", loopbackBind: false, anonymousKey: false });
  assert.ok(e && /loopback/.test(e), `expected a loopback fatal, got: ${e}`);
});

test("localToolsSafetyError: enabled + anonymous key → fatal (unnamed callers)", () => {
  const e = localToolsSafetyError({ enabled: true, authMode: "none", loopbackBind: true, anonymousKey: true });
  assert.ok(e && /ANONYMOUS/i.test(e), `expected an anonymous-key fatal, got: ${e}`);
});

test("localToolsSafetyError: multi is checked before loopback/anon (most severe first)", () => {
  // A deploy that trips several conditions reports the multi-tenant one — the strongest signal.
  const e = localToolsSafetyError({ enabled: true, authMode: "multi", loopbackBind: false, anonymousKey: true });
  assert.ok(/multi/.test(e));
});

// ── OCP_LOCAL_TOOLS INTEGRATION: boot real server.mjs, observe the -p spawn ──────────
// The unit tests above prove the pure helpers. These close the INTEGRATION SEAM the suite
// otherwise can't reach (server.mjs boots a listener on import): a fake `claude` captures the
// exact --system-prompt OCP spawns it with, so we assert the SELECTED wrapper actually reaches
// a request — and boot-gate refusals are asserted by the process exit code. Without these, the
// wiring (extractSystemPrompt using SYSTEM_PROMPT_WRAPPER, the boot gate, the epoch fold) can be
// silently reverted with the unit suite still green — the maintainer's #1 rejection pattern.
import { spawn as _ltSpawn } from "node:child_process";
import { writeFileSync as _ltWrite, chmodSync as _ltChmod, readFileSync as _ltRead, existsSync as _ltExists, rmSync as _ltRm, mkdtempSync as _ltMkdtemp } from "node:fs";
import { tmpdir as _ltTmp } from "node:os";
import { fileURLToPath as _ltF2P } from "node:url";

const LT_SERVER = _ltF2P(new URL("./server.mjs", import.meta.url));
const LT_POSIX = process.platform !== "win32"; // fake is a /bin/sh script; CI is POSIX
const LT_NEG_MARK = "You do NOT have access to any local filesystem";
const LT_POS_MARK = "You have full access to the local filesystem";
// Fake claude: record the --system-prompt it was spawned with, bump an optional spawn counter,
// then emit a minimal valid stream-json response so the request completes (and caches).
const LT_FAKE = `#!/bin/sh
prev=""
for a in "$@"; do
  if [ "$prev" = "--system-prompt" ]; then printf '%s' "$a" > "$SP_CAPTURE"; fi
  prev="$a"
done
if [ -n "$SP_COUNTER" ]; then c=$(cat "$SP_COUNTER" 2>/dev/null || echo 0); echo $((c+1)) > "$SP_COUNTER"; fi
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}'
printf '%s\\n' '{"type":"result"}'
exit 0
`;

function ltMkdir() { return _ltMkdtemp(join(_ltTmp(), "ocp-lt-")); }
function ltFake(dir) { const p = join(dir, "claude"); _ltWrite(p, LT_FAKE); _ltChmod(p, 0o755); return p; }
function ltBoot(env, dir) {
  const child = _ltSpawn(process.execPath, [LT_SERVER], {
    env: { ...process.env, NODE_ENV: "test", OCP_DIR_OVERRIDE: dir, OCP_SKIP_AUTH_TEST: "1",
           CLAUDE_BIND: "127.0.0.1", CLAUDE_AUTH_MODE: "none", CLAUDE_CACHE_TTL: "0", CLAUDE_TIMEOUT: "4000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const buf = { out: "", err: "", exit: undefined };
  child.stdout.on("data", d => { buf.out += d; });
  child.stderr.on("data", d => { buf.err += d; });
  child.on("exit", code => { buf.exit = code; });
  return { child, buf };
}
async function ltWait(cond, ms = 9000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, 40)); }
  return false;
}
async function ltPost(port, body) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { /* the fake may close the socket; the spawn (and capture) already happened */ }
}

console.log("\nOCP_LOCAL_TOOLS integration (boot server.mjs):");

test("integration: OCP_LOCAL_TOOLS=1 → the -p spawn receives the POSITIVE wrapper (kills the no-op mutation)", async () => {
  if (!LT_POSIX) return; // sh fake — skip on Windows CI
  const dir = ltMkdir(); const cap = join(dir, "sp.txt"); const fake = ltFake(dir);
  const { child, buf } = ltBoot({ OCP_LOCAL_TOOLS: "1", CLAUDE_BIN: fake, CLAUDE_PROXY_PORT: "39321", SP_CAPTURE: cap }, dir);
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on") || buf.exit != null), `server did not start: ${buf.err.slice(0,200)}`);
    await ltPost(39321, { model: "sonnet", messages: [{ role: "user", content: "hi" }] });
    assert.ok(await ltWait(() => _ltExists(cap)), "fake claude was spawned and captured --system-prompt");
    const sp = _ltRead(cap, "utf8");
    assert.ok(sp.includes(LT_POS_MARK), `expected POSITIVE wrapper in --system-prompt, got: ${sp.slice(0,90)}`);
    assert.ok(!sp.includes(LT_NEG_MARK), "positive wrapper must REPLACE the negative one, not append");
  } finally { child.kill("SIGKILL"); _ltRm(dir, { recursive: true, force: true }); }
});

test("integration: flag OFF → the -p spawn receives the EXACT negative wrapper (default path byte-for-byte)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const cap = join(dir, "sp.txt"); const fake = ltFake(dir);
  const { child, buf } = ltBoot({ CLAUDE_BIN: fake, CLAUDE_PROXY_PORT: "39322", SP_CAPTURE: cap }, dir); // OCP_LOCAL_TOOLS unset
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on") || buf.exit != null), `server did not start: ${buf.err.slice(0,200)}`);
    await ltPost(39322, { model: "sonnet", messages: [{ role: "user", content: "hi" }] });
    assert.ok(await ltWait(() => _ltExists(cap)), "fake claude captured --system-prompt");
    const sp = _ltRead(cap, "utf8");
    // No system messages + no CLAUDE_SYSTEM_PROMPT → the wrapper is passed verbatim.
    assert.equal(sp, `You are accessed via the OCP HTTP proxy. You do NOT have access to any local filesystem, working directory, shell, git status, or machine environment. Do not infer or invent such information from any context you observe. Respond only based on the conversation provided.`);
  } finally { child.kill("SIGKILL"); _ltRm(dir, { recursive: true, force: true }); }
});

test("integration: boot gate REFUSES each unsafe config (multi / non-loopback / anon key)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  const cases = [
    { label: "multi", env: { CLAUDE_AUTH_MODE: "multi" } },
    { label: "non-loopback", env: { CLAUDE_BIND: "0.0.0.0" } },
    { label: "anon", env: { PROXY_ANONYMOUS_KEY: "pub" } },
  ];
  try {
    for (const [i, c] of cases.entries()) {
      const { child, buf } = ltBoot({ OCP_LOCAL_TOOLS: "1", CLAUDE_BIN: fake, CLAUDE_PROXY_PORT: String(39330 + i), ...c.env }, dir);
      try {
        assert.ok(await ltWait(() => buf.exit != null), `[${c.label}] expected the process to exit`);
        assert.notEqual(buf.exit, 0, `[${c.label}] must exit non-zero`);
        assert.ok(/FATAL[\s\S]*OCP_LOCAL_TOOLS/.test(buf.err), `[${c.label}] expected a local-tools FATAL, got: ${buf.err.slice(0,160)}`);
      } finally { child.kill("SIGKILL"); }
    }
  } finally { _ltRm(dir, { recursive: true, force: true }); }
});

test("integration: safe single-user config BOOTS past the gate and announces local tools", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  const { child, buf } = ltBoot({ OCP_LOCAL_TOOLS: "1", CLAUDE_BIN: fake, CLAUDE_PROXY_PORT: "39340" }, dir); // loopback + none
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on")), `safe config must boot, got: ${buf.err.slice(0,200)}`);
    assert.ok(buf.out.includes("Local tools: ON"), "startup must announce local tools when active");
  } finally { child.kill("SIGKILL"); _ltRm(dir, { recursive: true, force: true }); }
});

test("integration: TUI mode → flag is announced INERT (not 'ON'), boot not refused", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  // Non-loopback would normally trip the local-tools gate; under TUI the flag is inert so the
  // gate must NOT fire on its behalf. Use loopback here to isolate TUI's own guards from ours.
  const { child, buf } = ltBoot({ OCP_LOCAL_TOOLS: "1", CLAUDE_TUI_MODE: "true", CLAUDE_BIN: fake, CLAUDE_PROXY_PORT: "39341" }, dir);
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on") || buf.exit != null), `did not start: ${buf.err.slice(0,200)}`);
    assert.ok(!buf.out.includes("Local tools: ON"), "must NOT claim local tools are ON in TUI mode (the wrapper is unused there)");
    assert.ok(/ignored in TUI mode/.test(buf.out + buf.err), "must warn that OCP_LOCAL_TOOLS is inert under TUI");
  } finally { child.kill("SIGKILL"); _ltRm(dir, { recursive: true, force: true }); }
});

test("integration: toggling OCP_LOCAL_TOOLS invalidates the standard response cache (epoch fold)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir); const counter = join(dir, "spawns.txt");
  const req = { model: "sonnet", messages: [{ role: "user", content: "epoch-probe" }] };
  const bootOnce = async (env, port) => {
    const { child, buf } = ltBoot({ CLAUDE_BIN: fake, CLAUDE_PROXY_PORT: String(port), CLAUDE_CACHE_TTL: "60000", SP_COUNTER: counter, ...env }, dir);
    try {
      assert.ok(await ltWait(() => buf.out.includes("listening on")), `did not start: ${buf.err.slice(0,160)}`);
      _ltWrite(counter, "0"); // reset AFTER boot so boot-time spawns (if any) don't count
      await ltPost(port, req);
      await ltWait(() => (Number(_ltRead(counter, "utf8")) || 0) >= 1, 3000); // give the spawn a beat
      return Number(_ltRead(counter, "utf8")) || 0;
    } finally { child.kill("SIGKILL"); }
  };
  try {
    const off = await bootOnce({}, 39350);                       // caches "OK" under epoch(negative)
    const on = await bootOnce({ OCP_LOCAL_TOOLS: "1" }, 39351);  // same DB, epoch(positive) → must MISS → re-spawn
    assert.equal(off, 1, "first request (cache empty) must spawn claude");
    assert.equal(on, 1, "after toggling the flag the identical request must NOT be served from the old cache (epoch differs → re-spawn)");
  } finally { _ltRm(dir, { recursive: true, force: true }); }
});

// ── Upgrade Tests ──
import { runUpgrade, postFlightOk } from "./scripts/upgrade.mjs";

console.log("\nUpgrade:");

// ── postFlightOk (issue #173) — the acceptance predicate for phase 6 ─────────
// Mutation-proof: revert the version comparison to auth-only and the "stale process
// still holds the port" test below goes green-to-red (that case is the 2026-07-17
// Oracle incident: orphan answered auth.ok=true while serving the OLD version).
test("postFlightOk: rejects a healthy-looking probe that serves the WRONG version (orphan case)", () => {
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.21.1" }, "v3.22.1"), false);
});

test("postFlightOk: accepts auth.ok + exact target version, tolerating the leading v", () => {
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.22.1" }, "v3.22.1"), true);
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.22.1" }, "3.22.1"), true);
});

test("postFlightOk: auth failure rejects regardless of version", () => {
  assert.equal(postFlightOk({ auth: { ok: false }, version: "3.22.1" }, "v3.22.1"), false);
  assert.equal(postFlightOk({ version: "3.22.1" }, "v3.22.1"), false);
  assert.equal(postFlightOk(null, "v3.22.1"), false);
});

test("postFlightOk: unknown/empty target degrades to the auth-only check (never blocks)", () => {
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.22.1" }, ""), true);
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.22.1" }, undefined), true);
});

test("upgrade --dry-run prints plan, no side effects", async () => {
  const result = await runUpgrade({
    dryRun: true,
    yes: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" }
  });
  assert.equal(result.executed, false);
  assert.ok(result.plan.length > 0);
  assert.ok(result.plan.some(line => line.toLowerCase().includes("snapshot")));
});

test("upgrade noop returns early when current==latest", async () => {
  const result = await runUpgrade({
    yes: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "noop" }, current_version: "v3.14.0", latest_version: "v3.14.0" }
  });
  assert.equal(result.path, "noop");
  assert.equal(result.executed, true);
  assert.equal(result.changed, false);
});

test("upgrade aborts on doctor FAIL", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true,
      mockDoctor: { ready_to_upgrade: false, fail_count: 1, next_action: { kind: "fix_oauth" } }
    });
  }, /doctor FAIL/);
});

test("upgrade full path executes 5 phases", async () => {
  const result = await runUpgrade({
    yes: true,
    dryRun: false,
    mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" }
  });
  assert.equal(result.path, "upgrade");
  // Plan asks for 6 phases by name; verify each appears as a phase entry
  const phaseNames = result.phases.map(p => p.name);
  for (const expected of ["pre-flight", "snapshot", "fetch+install", "reconfigure", "restart", "post-flight"]) {
    assert.ok(phaseNames.includes(expected), `missing phase: ${expected}; got ${phaseNames.join(",")}`);
  }
});

// ── Snapshot Tests ──
import { writeSnapshot, readSnapshot, listSnapshots, gcSnapshots } from "./scripts/lib/snapshot.mjs";
import { mkdtempSync, rmSync, mkdirSync as tMkdirSync, writeFileSync as testWriteFile, existsSync as testExistsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as testJoin } from "node:path";

console.log("\nSnapshot:");

const portableSnapshotName = (isoTimestamp) => `upgrade-snapshot-${isoTimestamp.replace(/:/g, "-")}`;
const legacyMixedSnapshot = "upgrade-snapshot-2026-05-11T09:05:00Z";
const portableMixedSnapshot = "upgrade-snapshot-2026-05-11T09-47-00Z";

function runMixedSnapshotScenario() {
  // NTFS rejects the legacy ':' name, so exercise the real exported functions
  // in an isolated process whose built-in fs bindings expose both formats.
  const moduleUrl = new URL("./scripts/lib/snapshot.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const names = ${JSON.stringify([legacyMixedSnapshot, portableMixedSnapshot])};
    const deleted = [];
    fs.existsSync = () => true;
    fs.readdirSync = () => [...names];
    fs.statSync = () => ({ mtimeMs: 0 });
    fs.rmSync = (path) => { deleted.push(path); };
    syncBuiltinESMExports();
    const { listSnapshots, gcSnapshots } = await import(${JSON.stringify(moduleUrl)});
    const listed = listSnapshots("/virtual-home").map(snapshot => snapshot.name);
    const gc = gcSnapshots("/virtual-home", {
      keepCount: 1,
      keepDays: 0,
      now: new Date("2026-05-12T00:00:00Z")
    });
    process.stdout.write(JSON.stringify({
      listed,
      kept: gc.kept.map(snapshot => snapshot.name),
      removed: gc.removed.map(snapshot => snapshot.name),
      deleted
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" }));
}

test("writeSnapshot creates dir + manifest files", () => {
  const root = mkdtempSync(testJoin(tmpdir(), "ocp-snap-test-"));
  const dotOcp = testJoin(root, ".ocp");
  tMkdirSync(dotOcp, { recursive: true });
  testWriteFile(testJoin(dotOcp, "ocp.db"), "fake-sqlite-bytes");

  const path = writeSnapshot({
    homeDir: root,
    fromCommit: "abc1234",
    fromVersion: "v3.10.0",
    toVersion: "v3.14.0",
    extraFiles: []
  });
  const m = readSnapshot(path);
  assert.equal(m.fromCommit, "abc1234");
  assert.equal(m.fromVersion, "v3.10.0");
  rmSync(root, { recursive: true, force: true });
});

test("listSnapshots returns sorted by ISO timestamp", () => {
  const root = mkdtempSync(testJoin(tmpdir(), "ocp-snap-list-"));
  const dotOcp = testJoin(root, ".ocp");
  tMkdirSync(dotOcp, { recursive: true });
  for (const ts of ["2026-05-01T10:00:00Z", "2026-05-02T10:00:00Z", "2026-05-03T10:00:00Z"]) {
    tMkdirSync(testJoin(dotOcp, portableSnapshotName(ts)));
  }
  const list = listSnapshots(root);
  assert.equal(list.length, 3);
  assert.ok(list[0].path.includes("2026-05-01"));
  assert.ok(list[2].path.includes("2026-05-03"));
  rmSync(root, { recursive: true, force: true });
});

test("listSnapshots sorts mixed legacy and Windows-safe names chronologically", () => {
  const result = runMixedSnapshotScenario();
  assert.deepEqual(result.listed, [legacyMixedSnapshot, portableMixedSnapshot]);
});

test("gcSnapshots keeps the newer Windows-safe snapshot across the format boundary", () => {
  const result = runMixedSnapshotScenario();
  assert.deepEqual(result.kept, [portableMixedSnapshot]);
  assert.deepEqual(result.removed, [legacyMixedSnapshot]);
  assert.equal(result.deleted.length, 1);
  assert.ok(result.deleted[0].endsWith(legacyMixedSnapshot));
});

test("upgrade error after snapshot carries snapshotPath + hint", async () => {
  // Use mockExec=true so no real commands are run.
  // Verify the success path returns a snapshotPath (Fix B regression guard).
  const result = await runUpgrade({
    yes: true,
    dryRun: false,
    mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" }
  });
  assert.ok(result.snapshotPath, "successful upgrade returns snapshotPath");
  assert.equal(result.path, "upgrade");
  assert.equal(result.executed, true);
});

test("upgrade fresh_install requires --yes for non-interactive", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      yes: false,
      mockExec: true,
      mockDoctor: { ready_to_upgrade: false, from_version_supported: false,
                    next_action: { kind: "fresh_install", ai_executable: ["echo would-rm-rf"] },
                    current_version: "v3.2.0", latest_version: "v3.14.0" }
    });
  }, /requires --yes/);
});

test("upgrade fresh_install with --yes runs ai_executable", async () => {
  const result = await runUpgrade({
    yes: true,
    mockExec: true,
    mockDoctor: { ready_to_upgrade: false, from_version_supported: false,
                  next_action: { kind: "fresh_install",
                                 ai_executable: ["echo step-1", "echo step-2", "echo step-3"] },
                  current_version: "v3.2.0", latest_version: "v3.14.0" }
  });
  assert.equal(result.path, "fresh_install");
  assert.equal(result.steps.length, 3);
});

test("rollback --list returns snapshots", async () => {
  const result = await runUpgrade({
    rollback: true,
    list: true,
    mockSnapshots: [
      { name: "upgrade-snapshot-2026-05-01T10:00:00Z", path: "/tmp/snap-1" },
      { name: "upgrade-snapshot-2026-05-02T10:00:00Z", path: "/tmp/snap-2" }
    ]
  });
  assert.equal(result.path, "rollback-list");
  assert.equal(result.snapshots.length, 2);
});

test("rollback with no snapshots fails clearly", async () => {
  await assert.rejects(async () => {
    await runUpgrade({ rollback: true, dryRun: true, mockSnapshots: [] });
  }, /no upgrade snapshots/);
});

test("rollback --dry-run produces a plan without mutation", async () => {
  const result = await runUpgrade({
    rollback: true,
    dryRun: true,
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" }
  });
  assert.equal(result.path, "rollback-dry-run");
  assert.equal(result.executed, false);
  assert.ok(result.plan.length > 0);
});

test("rollback latest snapshot restores files (mockExec)", async () => {
  const result = await runUpgrade({
    rollback: true,
    yes: true,
    mockExec: true,
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" }
  });
  assert.equal(result.path, "rollback");
  assert.equal(result.executed, true);
  assert.ok(result.phases.some(p => p.name === "git-checkout"));
});

test("gcSnapshots keeps last N regardless of age", () => {
  const root = mkdtempSync(testJoin(tmpdir(), "ocp-gc-test-"));
  const dotOcp = testJoin(root, ".ocp");
  tMkdirSync(dotOcp, { recursive: true });
  for (const ts of ["2026-04-01T10:00:00Z", "2026-04-15T10:00:00Z", "2026-04-30T10:00:00Z", "2026-05-01T10:00:00Z", "2026-05-10T10:00:00Z"]) {
    tMkdirSync(testJoin(dotOcp, portableSnapshotName(ts)));
  }
  const result = gcSnapshots(root, { keepCount: 3, keepDays: 0, now: new Date("2026-05-11T00:00:00Z") });
  assert.equal(result.kept.length, 3);
  assert.equal(result.removed.length, 2);
  assert.ok(result.kept[0].name.includes("2026-04-30"));
  assert.ok(result.kept[2].name.includes("2026-05-10"));
  rmSync(root, { recursive: true, force: true });
});

// ── setup.mjs helpers: xmlEscape + assertSafeInjectValue ──
// setup.mjs cannot be imported (top-level side effects run the installer).
// Replicated verbatim from setup.mjs for unit-testing — keep in sync with source.
console.log("\nsetup.mjs inject helpers:");

function xmlEscape(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function assertSafeInjectValueTest(name, v) {
  if (v == null) return v;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(String(v))) {
    throw new Error(`FATAL: ${name} contains a newline or control character`);
  }
  return v;
}

test("xmlEscape encodes all five special XML chars", () => {
  assert.equal(xmlEscape('a<b>&"\''), "a&lt;b&gt;&amp;&quot;&apos;");
});

test("xmlEscape leaves normal ocp_ token untouched", () => {
  assert.equal(xmlEscape("ocp_abc123"), "ocp_abc123");
});

test("assertSafeInjectValue rejects value with newline", () => {
  assert.throws(() => assertSafeInjectValueTest("OCP_ADMIN_KEY", "a\nb"), /FATAL/);
});

test("assertSafeInjectValue rejects value with carriage return", () => {
  assert.throws(() => assertSafeInjectValueTest("OCP_ADMIN_KEY", "a\rb"), /FATAL/);
});

test("assertSafeInjectValue rejects value with a tab (control char)", () => {
  assert.throws(() => assertSafeInjectValueTest("OCP_ADMIN_KEY", "a\tb"), /FATAL/);
});

test("assertSafeInjectValue ACCEPTS a path with a space (CLAUDE_BIN may legitimately contain one)", () => {
  assert.equal(assertSafeInjectValueTest("CLAUDE_BIN", "/Users/x/My Apps/node"), "/Users/x/My Apps/node");
});

test("assertSafeInjectValue accepts normal ocp_ token", () => {
  assert.doesNotThrow(() => assertSafeInjectValueTest("OCP_ADMIN_KEY", "ocp_abc123"));
});

test("assertSafeInjectValue accepts null (omit path)", () => {
  assert.doesNotThrow(() => assertSafeInjectValueTest("OCP_ADMIN_KEY", null));
});

test("plist-merge round-trips XML-escaped value correctly via mergePlistEnv", () => {
  // A value written with xmlEscape must survive a merge cycle — the [^<]* regex in
  // parsePlistEnv only sees the escaped form (no raw < reaches it), so round-trip is safe.
  const escaped = xmlEscape("a<b>&\"'");  // "a&lt;b&gt;&amp;&quot;&apos;"
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_AUTH_MODE</key>
    <string>${escaped}</string>
  </dict>
</dict>
</plist>`;
  // mergePlistEnv with no existing plist returns template unchanged.
  const merged = mergePlistEnv(null, template);
  assert.ok(merged.includes(escaped), "escaped value should survive unchanged through plist merge");
});

test("gcSnapshots keeps snapshots newer than keepDays regardless of count", () => {
  const root = mkdtempSync(testJoin(tmpdir(), "ocp-gc-days-"));
  const dotOcp = testJoin(root, ".ocp");
  tMkdirSync(dotOcp, { recursive: true });
  for (const ts of ["2026-04-01T10:00:00Z", "2026-04-15T10:00:00Z", "2026-04-30T10:00:00Z", "2026-05-01T10:00:00Z", "2026-05-10T10:00:00Z"]) {
    tMkdirSync(testJoin(dotOcp, portableSnapshotName(ts)));
  }
  // keepCount=1 but keepDays=15 means anything from after 2026-04-26 is kept too
  const result = gcSnapshots(root, { keepCount: 1, keepDays: 15, now: new Date("2026-05-11T00:00:00Z") });
  // Kept: 2026-04-30 (within 15 days), 2026-05-01 (within 15 days), 2026-05-10 (within 15 days)
  assert.ok(result.kept.length >= 3);
  // Removed: 2026-04-01, 2026-04-15
  assert.ok(result.removed.some(s => s.name.includes("2026-04-01")));
});

test("gcSnapshots never deletes the most recent snapshot", () => {
  const root = mkdtempSync(testJoin(tmpdir(), "ocp-gc-recent-"));
  const dotOcp = testJoin(root, ".ocp");
  tMkdirSync(dotOcp, { recursive: true });
  tMkdirSync(testJoin(dotOcp, portableSnapshotName("2026-01-01T10:00:00Z")));
  // Even with keepCount=0 and keepDays=0, the most recent must survive
  const result = gcSnapshots(root, { keepCount: 0, keepDays: 0, now: new Date("2026-05-11T00:00:00Z") });
  assert.equal(result.kept.length, 1);
  assert.equal(result.removed.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("gcSnapshots --dry-run reports plan without deleting", () => {
  const root = mkdtempSync(testJoin(tmpdir(), "ocp-gc-dryrun-"));
  const dotOcp = testJoin(root, ".ocp");
  tMkdirSync(dotOcp, { recursive: true });
  for (const ts of ["2026-04-01T10:00:00Z", "2026-04-15T10:00:00Z", "2026-05-10T10:00:00Z"]) {
    tMkdirSync(testJoin(dotOcp, portableSnapshotName(ts)));
  }
  const result = gcSnapshots(root, { keepCount: 1, keepDays: 0, dryRun: true, now: new Date("2026-05-11T00:00:00Z") });
  assert.equal(result.dryRun, true);
  assert.equal(result.removed.length, 2);
  // Files still exist
  assert.ok(testExistsSync(testJoin(dotOcp, portableSnapshotName("2026-04-01T10:00:00Z"))));
  rmSync(root, { recursive: true, force: true });
});

// ── Doctor --check oauth fast path tests ──
console.log("\nDoctor --check oauth:");

await asyncTest("doctor --check oauth runs only oauth check (skips version/from-version)", async () => {
  const result = await runDoctor({
    checkOnly: "oauth",
    mockVersion: "v3.10.0",
    mockLatest: "v3.14.0",
    mockHealth: { status: 200, body: { auth: { ok: true, message: "authenticated" } } }
  });
  // Should still produce a valid result object
  assert.equal(result.schema_version, "1");
  // checks[] should only contain oauth_ok (no current_version, no from_version_supported)
  const ids = result.checks.map(c => c.id);
  assert.deepEqual(ids, ["oauth_ok"]);
  assert.equal(result.next_action.kind, "noop");
});

await asyncTest("doctor --check oauth + OAuth FAIL → fix_oauth", async () => {
  const result = await runDoctor({
    checkOnly: "oauth",
    mockHealth: { status: 200, body: { auth: { ok: false, message: "ENOEXEC" } } }
  });
  const ids = result.checks.map(c => c.id);
  assert.deepEqual(ids, ["oauth_ok"]);
  assert.equal(result.next_action.kind, "fix_oauth");
  assert.equal(result.fail_count, 1);
});

await asyncTest("doctor --check oauth + service down → fix_service", async () => {
  const result = await runDoctor({
    checkOnly: "oauth",
    mockHealth: { error: "ECONNREFUSED" }
  });
  const ids = result.checks.map(c => c.id);
  assert.deepEqual(ids, ["oauth_ok"]);
  assert.equal(result.next_action.kind, "fix_service");
  assert.equal(result.fail_count, 1);
});

await asyncTest("doctor --check oauth + 200 with null body → fix_service", async () => {
  const result = await runDoctor({
    checkOnly: "oauth",
    mockHealth: { status: 200, body: null }
  });
  const ids = result.checks.map(c => c.id);
  assert.deepEqual(ids, ["oauth_ok"]);
  assert.equal(result.next_action.kind, "fix_service");
  assert.equal(result.fail_count, 1);
});

// ── Stream-JSON parser tests ──────────────────────────────────────────────
// MIRRORS server.mjs parseStreamJsonLines/parseStreamJsonEvent — keep in sync.
// Copied verbatim to avoid importing server.mjs (top-level server.listen() would
// start a live HTTP server). The logEvent stub silences observability side-effects.
console.log("\nStream-JSON parsers:");

function logEvent() {} // stub — observability side-effect not needed in tests

function parseStreamJsonLines(buffered) {
  const lines = buffered.split("\n");
  const remainder = lines.pop(); // last element is the incomplete trailing line
  const events = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      console.error("[claude] NDJSON parse error on line:", trimmed.slice(0, 120));
      events.push({ type: "parse_error", raw: trimmed });
    }
  }
  return { events, remainder: remainder ?? "" };
}

function parseStreamJsonEvent(event, sawTextDelta) {
  const t = event?.type;

  // system/* — first-event init + other system meta (api_retry etc.)
  if (t === "system") return null;
  // user — echo of user message; consumed
  if (t === "user") return null;

  // stream_event — contains nested content_block_delta
  if (t === "stream_event") {
    const inner = event.event ?? event;
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { text: inner.delta.text ?? "", fromDelta: true };
    }
    // Other stream_event sub-types (content_block_start, message_delta, etc.) — consumed
    return null;
  }

  // assistant — aggregate message. Without --include-partial-messages each assistant message
  // arrives as its own aggregate event; an agentic turn emits several (preamble + tool rounds +
  // final answer), so accumulate EVERY one. Only guard the delta+aggregate double-count case:
  // if streaming deltas were already seen (sawTextDelta), the aggregate duplicates them.
  // Reference: OLP commit 65f945c (assistant-aggregate fallback, fold-in).
  if (t === "assistant") {
    if (!sawTextDelta) {
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter(b => b && b.type === "text" && typeof b.text === "string")
          .map(b => b.text)
          .join("");
        if (text) return { text };
      }
    }
    return null;
  }

  // result — terminal event
  if (t === "result") {
    if (event.is_error === true) {
      return { error: event.error_message ?? event.result ?? "claude returned is_error" };
    }
    return { stop: true };
  }

  // rate_limit_event / usage — log for observability, don't forward
  if (t === "rate_limit_event" || t === "usage") {
    logEvent("info", "claude_stream_event", { type: t, data: JSON.stringify(event).slice(0, 200) });
    return null;
  }

  // control_request — per Anthropic stream-json docs
  if (t === "control_request") {
    console.error("[claude] stream_json control_request event (ignored):", JSON.stringify(event).slice(0, 120));
    return null;
  }

  // parse_error — already logged by parseStreamJsonLines
  if (t === "parse_error") return null;

  // Unknown event type — log + skip; future-proof for new claude CLI events
  if (t !== undefined) {
    console.error("[claude] unknown stream_json event type:", t);
  }
  return null;
}

// (a) content_block_delta deltas + assistant-aggregate fallback → assembled text with NO double-count
test("parseStreamJsonEvent: stream_event content_block_delta yields text", () => {
  const event = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }
  };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { text: "Hello", fromDelta: true });
});

test("parseStreamJsonEvent: assistant-aggregate used when no delta seen (sawTextDelta=false)", () => {
  const event = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Short answer." }] }
  };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { text: "Short answer." });
});

test("parseStreamJsonEvent: assistant-aggregate skipped when a delta was seen (sawTextDelta=true, no double-count)", () => {
  const event = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Short answer." }] }
  };
  const result = parseStreamJsonEvent(event, true);
  assert.equal(result, null);
});

test("parseStreamJsonEvent: stream_event + assistant → assembled without double-count", () => {
  // Simulate receiving a content_block_delta first, then an assistant aggregate
  const delta = {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Streaming text." } }
  };
  const agg = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Streaming text." }] }
  };
  // First event: no delta seen yet → yields text and marks fromDelta
  const r1 = parseStreamJsonEvent(delta, false);
  assert.deepEqual(r1, { text: "Streaming text.", fromDelta: true });
  // Second event (aggregate): a delta was seen (sawTextDelta=true) → duplicate, null
  const r2 = parseStreamJsonEvent(agg, true);
  assert.equal(r2, null);
});

// REGRESSION (agentic turns): without --include-partial-messages a tool-using turn emits SEVERAL
// aggregate `assistant` events (preamble, then the final answer after tool use) and NO deltas.
// Every one must be captured — the old first-only guard dropped the final answer.
test("parseStreamJsonEvent: multi-message agentic turn captures preamble AND final answer", () => {
  const preamble = {
    type: "assistant",
    message: { content: [
      { type: "text", text: "I'll find the homepage repo and remove the calendar." },
      { type: "tool_use", id: "t1", name: "Bash" },
    ] }
  };
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } };
  const finalMsg = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Done — removed the calendar widget and pushed." }] }
  };
  // No deltas are ever emitted in aggregate mode, so sawTextDelta stays false throughout.
  const r1 = parseStreamJsonEvent(preamble, false);
  assert.deepEqual(r1, { text: "I'll find the homepage repo and remove the calendar." });
  const r2 = parseStreamJsonEvent(toolResult, false); // user/tool_result echo — consumed
  assert.equal(r2, null);
  const r3 = parseStreamJsonEvent(finalMsg, false);   // <- old code returned null here (bug)
  assert.deepEqual(r3, { text: "Done — removed the calendar widget and pushed." });
});

// (b) aggregate-only short response → assembles correctly
test("parseStreamJsonEvent: aggregate-only multi-block response assembles all text blocks", () => {
  const event = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Part one." },
        { type: "tool_use", id: "x" }, // non-text block — should be filtered
        { type: "text", text: " Part two." }
      ]
    }
  };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { text: "Part one. Part two." });
});

// (c) JSON line split across two parseStreamJsonLines calls → partial-line buffering
test("parseStreamJsonLines: partial line carried as remainder", () => {
  const chunk1 = '{"type":"system","subtype":"init"}\n{"type":"stream_ev';
  const { events: ev1, remainder: rem1 } = parseStreamJsonLines(chunk1);
  assert.equal(ev1.length, 1);
  assert.equal(ev1[0].type, "system");
  assert.equal(rem1, '{"type":"stream_ev');

  const chunk2 = rem1 + 'ent","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}\n';
  const { events: ev2, remainder: rem2 } = parseStreamJsonLines(chunk2);
  assert.equal(ev2.length, 1);
  assert.equal(ev2[0].type, "stream_event");
  assert.equal(rem2, "");
  // Verify the reassembled event parses through parseStreamJsonEvent correctly
  const parsed = parseStreamJsonEvent(ev2[0], false);
  assert.deepEqual(parsed, { text: "Hi", fromDelta: true });
});

test("parseStreamJsonLines: empty input returns no events and empty remainder", () => {
  const { events, remainder } = parseStreamJsonLines("");
  assert.equal(events.length, 0);
  assert.equal(remainder, "");
});

// (d) is_error result event → surfaces the error
test("parseStreamJsonEvent: result is_error=true surfaces error_message", () => {
  const event = { type: "result", is_error: true, error_message: "Rate limit hit" };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { error: "Rate limit hit" });
});

test("parseStreamJsonEvent: result is_error=true falls back to result field when no error_message", () => {
  const event = { type: "result", is_error: true, result: "error detail" };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { error: "error detail" });
});

test("parseStreamJsonEvent: result is_error=true falls back to default string when no detail", () => {
  const event = { type: "result", is_error: true };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { error: "claude returned is_error" });
});

test("parseStreamJsonEvent: result is_error=false yields stop", () => {
  const event = { type: "result", is_error: false, result: "success" };
  const result = parseStreamJsonEvent(event, false);
  assert.deepEqual(result, { stop: true });
});

// (e) malformed/non-JSON line → skipped without throwing
test("parseStreamJsonLines: malformed JSON line becomes parse_error event without throwing", () => {
  const input = '{"type":"system"}\nnot-valid-json\n{"type":"result","is_error":false}\n';
  const { events, remainder } = parseStreamJsonLines(input);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "system");
  assert.equal(events[1].type, "parse_error");
  assert.equal(events[1].raw, "not-valid-json");
  assert.equal(events[2].type, "result");
});

test("parseStreamJsonEvent: parse_error event returns null without throwing", () => {
  const event = { type: "parse_error", raw: "garbage" };
  const result = parseStreamJsonEvent(event, false);
  assert.equal(result, null);
});

// Additional edge cases
test("parseStreamJsonEvent: system event returns null", () => {
  const result = parseStreamJsonEvent({ type: "system", subtype: "init" }, true);
  assert.equal(result, null);
});

test("parseStreamJsonEvent: user event returns null", () => {
  const result = parseStreamJsonEvent({ type: "user", message: {} }, true);
  assert.equal(result, null);
});

test("parseStreamJsonEvent: stream_event non-text-delta (content_block_start) returns null", () => {
  const event = { type: "stream_event", event: { type: "content_block_start", index: 0 } };
  const result = parseStreamJsonEvent(event, true);
  assert.equal(result, null);
});

test("parseStreamJsonEvent: unknown event type returns null", () => {
  const result = parseStreamJsonEvent({ type: "future_event_type" }, false);
  assert.equal(result, null);
});
// ── Suite: streamStringAsSSE wire-format ────────────────────────────────
// streamStringAsSSE is not exported from server.mjs (internal helper), so we
// test the wire format contract using a local implementation with the same
// logic.  This validates the protocol shape (role chunk → content chunks →
// stop → [DONE]) that both the cache-hit replay and TUI streaming paths rely on.
console.log("\nstreamStringAsSSE wire-format:");

function _testSendSSE(res, data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

function _testStreamStringAsSSE(res, id, model, content) {
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  _testSendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const CHUNK = 80;
  const codepoints = Array.from(content);
  for (let i = 0; i < codepoints.length; i += CHUNK) {
    _testSendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: codepoints.slice(i, i + CHUNK).join("") }, finish_reason: null }] });
  }
  _testSendSSE(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

function _makeFakeRes() {
  const writes = [];
  let headsSent = false;
  return {
    writes,
    writeHead(status, headers) { headsSent = true; this._status = status; this._headers = headers; },
    write(s) { writes.push(s); },
    end() { this._ended = true; },
  };
}

test("streamStringAsSSE emits role chunk + content chunks + stop + [DONE]", () => {
  const res = _makeFakeRes();
  const content = "hello world";
  _testStreamStringAsSSE(res, "test-id", "claude-haiku", content);
  assert.ok(res._status === 200, "writeHead(200) called");
  assert.ok(res._ended, "res.end() called");
  // First write: role delta
  const firstEvent = JSON.parse(res.writes[0].replace(/^data: /, "").trim());
  assert.equal(firstEvent.choices[0].delta.role, "assistant");
  assert.equal(firstEvent.choices[0].finish_reason, null);
  // Since content < 80 chars it fits in one chunk
  const secondEvent = JSON.parse(res.writes[1].replace(/^data: /, "").trim());
  assert.equal(secondEvent.choices[0].delta.content, content);
  // Second-to-last: stop chunk
  const stopEvent = JSON.parse(res.writes[res.writes.length - 2].replace(/^data: /, "").trim());
  assert.equal(stopEvent.choices[0].finish_reason, "stop");
  // Last: [DONE]
  assert.equal(res.writes[res.writes.length - 1], "data: [DONE]\n\n");
});

test("streamStringAsSSE splits content at 80 codepoints per chunk", () => {
  const res = _makeFakeRes();
  const content = "x".repeat(200); // 3 chunks: 80+80+40
  _testStreamStringAsSSE(res, "test-id-2", "claude-haiku", content);
  // writes: [role_chunk, content_chunk_1, content_chunk_2, content_chunk_3, stop_chunk, [DONE]]
  assert.equal(res.writes.length, 6);
  const c1 = JSON.parse(res.writes[1].replace(/^data: /, "").trim());
  assert.equal(c1.choices[0].delta.content.length, 80);
  const c2 = JSON.parse(res.writes[2].replace(/^data: /, "").trim());
  assert.equal(c2.choices[0].delta.content.length, 80);
  const c3 = JSON.parse(res.writes[3].replace(/^data: /, "").trim());
  assert.equal(c3.choices[0].delta.content.length, 40);
});

test("streamStringAsSSE empty content: role + stop + [DONE] only", () => {
  const res = _makeFakeRes();
  _testStreamStringAsSSE(res, "test-id-3", "claude-haiku", "");
  // writes: [role_chunk, stop_chunk, [DONE]]
  assert.equal(res.writes.length, 3);
  const stop = JSON.parse(res.writes[1].replace(/^data: /, "").trim());
  assert.equal(stop.choices[0].finish_reason, "stop");
  assert.equal(res.writes[2], "data: [DONE]\n\n");
});

// ── Suite: TUI transcript reader ────────────────────────────────────────
import { findTranscriptPath, parseTranscriptLines, isTerminalLine, extractLatestAssistantText, verifyEntrypoint, detectTuiUpstreamError } from "./lib/tui/transcript.mjs";
import { readFileSync as tuiReadFileSync, mkdtempSync as tuiMkdtemp0, mkdirSync as tuiMkdir0, writeFileSync as tuiWrite0 } from "node:fs";
import { tmpdir as tuiTmp0 } from "node:os";

console.log("\nTUI transcript — path formula:");

test("findTranscriptPath locates <sid>.jsonl across projects subdirs by UUID", () => {
  const home = tuiMkdtemp0(`${tuiTmp0()}/tui-home-`);
  const sid = "11111111-2222-3333-4444-555555555555";
  const proj = `${home}/.claude/projects/-some--weird-encoding`;
  tuiMkdir0(proj, { recursive: true });
  tuiWrite0(`${proj}/${sid}.jsonl`, "{}\n");
  assert.equal(findTranscriptPath(home, sid), `${proj}/${sid}.jsonl`);
  assert.equal(findTranscriptPath(home, "no-such-uuid"), null);
  assert.equal(findTranscriptPath(null, sid), null);
});

console.log("\nTUI transcript — parsing + terminal detection:");

test("parseTranscriptLines skips blank + malformed/partial lines", () => {
  const evs = parseTranscriptLines('{"a":1}\n\n{bad json\n{"b":2}\n');
  assert.equal(evs.length, 2);
  assert.equal(evs[1].b, 2);
});
test("isTerminalLine true on turn_duration", () => {
  assert.equal(isTerminalLine({ type: "system", subtype: "turn_duration" }), true);
});
test("isTerminalLine false on stop_reason tool_use (message-wrapped) — tool_use is mid-turn in TUI mode", () => {
  assert.equal(isTerminalLine({ type: "assistant", message: { stop_reason: "tool_use" } }), false);
});
test("isTerminalLine false on stop_reason tool_use (flat) — claude continues after tool, turn not done", () => {
  assert.equal(isTerminalLine({ stop_reason: "tool_use" }), false);
});
test("isTerminalLine false on ordinary assistant text line", () => {
  assert.equal(isTerminalLine({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), false);
});
// issue #130 cloud/server-side: claude builds (e.g. 2.1.114) that DON'T emit
// turn_duration mark turn-end via assistant message.stop_reason — must be terminal.
test("isTerminalLine true on assistant stop_reason end_turn (version-robust, e.g. 2.1.114)", () => {
  assert.equal(isTerminalLine({ type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } }), true);
});
test("isTerminalLine true on assistant stop_reason stop_sequence / max_tokens", () => {
  assert.equal(isTerminalLine({ type: "assistant", message: { stop_reason: "stop_sequence" } }), true);
  assert.equal(isTerminalLine({ type: "assistant", message: { stop_reason: "max_tokens" } }), true);
});
test("extractLatestAssistantText concatenates text blocks of LAST assistant entry", () => {
  const evs = [
    { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
    { type: "user", message: { content: "..." } },
    { type: "assistant", message: { content: [{ type: "text", text: "A" }, { type: "thinking", thinking: "x" }, { type: "text", text: "B" }] } },
  ];
  assert.equal(extractLatestAssistantText(evs), "AB");
});
test("extractLatestAssistantText ignores thinking-only assistant entries", () => {
  // Fixture shape: thinking block and text block are SEPARATE top-level entries sharing same msg id
  const evs = [
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } },
  ];
  assert.equal(extractLatestAssistantText(evs), "PONG");
});
test("real complete fixture: parseTranscriptLines yields >0 events", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  assert.ok(evs.length > 0, "fixture must parse to events");
});
test("real complete fixture: at least one isTerminalLine", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  assert.ok(evs.some(isTerminalLine), "fixture must contain a terminal line");
});
test("real complete fixture: extractLatestAssistantText returns non-empty text", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  assert.ok(extractLatestAssistantText(evs).length > 0, "fixture must yield assistant text");
});
test("real complete fixture: extractLatestAssistantText returns the FINAL text, not the first", () => {
  // The fixture's first assistant text is "PONG"; it is followed by 8 later refusal
  // turns. Pinning the exact FINAL string guards the overwrite-to-last semantic —
  // a regression that returned the first text block would still pass a length check.
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  assert.equal(extractLatestAssistantText(evs), "I'm moving on. If you have a genuine task, let me know.");
});
test("real complete fixture: verifyEntrypoint returns 'cli'", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  assert.equal(verifyEntrypoint(evs), "cli");
});

// ── C-3 (#133): verifyEntrypoint is version-robust ───────────────────────
// Some claude builds do NOT emit a turn_duration line; entrypoint lives on
// ordinary lines on BOTH emitting and non-emitting builds. Reading ONLY
// turn_duration made the server.mjs tui_entrypoint_mismatch assertion get null
// every turn on non-emitting builds. verifyEntrypoint must fall back to ANY line.
console.log("\nTUI transcript — verifyEntrypoint version-robustness (C-3, #133):");

test("verifyEntrypoint PREFERS the turn_duration line's entrypoint", () => {
  // turn_duration says "cli"; an earlier ordinary line says "sdk-cli" — the
  // authoritative turn_duration value must win, not last-writer-wins on the fallback.
  const evs = [
    { type: "assistant", entrypoint: "sdk-cli", message: { content: [{ type: "text", text: "x" }] } },
    { type: "system", subtype: "turn_duration", entrypoint: "cli" },
  ];
  assert.equal(verifyEntrypoint(evs), "cli");
});
test("verifyEntrypoint falls back to entrypoint on an ordinary assistant line when no turn_duration", () => {
  const evs = [
    { type: "user", entrypoint: "cli", message: { content: "hi" } },
    { type: "assistant", entrypoint: "cli", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } },
  ];
  assert.equal(verifyEntrypoint(evs), "cli");
});
test("verifyEntrypoint returns null when NO line carries an entrypoint", () => {
  const evs = [
    { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } },
  ];
  assert.equal(verifyEntrypoint(evs), null);
});
test("real no-turn_duration fixture: verifyEntrypoint still resolves 'cli' (was null before C-3)", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/no-turn-duration.jsonl", "utf8"));
  // Sanity: the fixture genuinely lacks a turn_duration line (so this exercises the fallback).
  assert.ok(!evs.some((e) => e && e.type === "system" && e.subtype === "turn_duration"), "fixture must NOT emit turn_duration");
  assert.equal(verifyEntrypoint(evs), "cli");
});

// ── C-1 (#133): honest AUTH-FAILURE banner detection ─────────────────────
// The interactive claude CLI renders in-session errors as ordinary assistant text.
// C-1 catches the R-1 case: expired/invalid creds, where EVERY turn returns the same
// one-line auth-failure banner and OCP would cache it as a real answer. The detector
// is deliberately NARROW/conservative: a false-positive (killing a real long answer
// that merely DISCUSSES an API error) costs the user a missing answer + a double-burn
// retry, which is worse than the rare false-negative (caching one transient error for
// the 5-min TTL). Signal = ALL of: SHORT whole-message (≤100; live samples 69/73) AND
// "API Error: 4xx" AND an auth keyword (authenticat | /login | credential) AND NO
// backtick/quote char. When unsure → PASS. The earlier generalised rule
// (^<short-prefix>?API Error:\d{3}.*$) was TOO BROAD: its unbounded .* tail killed
// legit long answers; this block encodes the full narrowed matrix.
console.log("\nTUI transcript — auth-failure banner detection (C-1, #133):");

// ---- Required matrix: MUST detect (kill) ----
test("C-1 KILL: live /login 401 auth banner", () => {
  const banner = "Please run /login · API Error: 401 Invalid authentication credentials";
  assert.equal(detectTuiUpstreamError(banner), banner);
});
test("C-1 KILL: live 'Failed to authenticate.' 401 banner variant", () => {
  // Second real PI231 banner: a different short auth-failure prefix before the same
  // "API Error: 4xx" core. Still short, still 4xx, still has 'authenticate'/'credentials'.
  const banner = "Failed to authenticate. API Error: 401 Invalid authentication credentials";
  assert.equal(detectTuiUpstreamError(banner), banner);
});

// ---- Required matrix: MUST NOT kill (pass) ----
test("C-1 PASS: long answer discussing a 500 (not 4xx, too long)", () => {
  // The exact false-positive the over-broad .* rule produced. 166 chars; 5xx.
  const legit = "API Error: 500 happened because the server was overloaded. To fix this, retry with exponential backoff and verify your rate limits before resending the request again.";
  assert.equal(detectTuiUpstreamError(legit), null);
});
test("C-1 PASS: long answer with 'API Error: 401 details' (too long, no auth keyword)", () => {
  // 142 chars; the literal word 'authenticate'/'credential'/'/login' never appears, and
  // it is far over the length cap — rejected on length AND keyword.
  const legit = "Failed to parse the config. Here are the API Error: 401 details you asked about: the token expired and must be refreshed before the next call.";
  assert.equal(detectTuiUpstreamError(legit), null);
});
test("C-1 PASS: 'To debug a 401 … API Error: 401 Unauthorized' (no auth keyword)", () => {
  // 91 chars (short!) and 4xx, but 'Unauthorized' is authoriz-, not authenticat-, and
  // there is no /login or credential — the auth-keyword signal rejects it.
  const legit = "To debug a 401: the server returns API Error: 401 Unauthorized, then you refresh the token.";
  assert.equal(detectTuiUpstreamError(legit), null);
});
test("C-1 PASS: handler answer logging 'API Error: 503' (not 4xx)", () => {
  const legit = "Here is the handler you asked for. It logs the string API Error: 503 on failure and retries.";
  assert.equal(detectTuiUpstreamError(legit), null);
});
test("C-1 PASS: short instructional answer quoting `API Error: 401` + /login (has backtick)", () => {
  // 75 chars: short, 4xx, has '/login' — passes signals 1-3. Rejected ONLY by the
  // backtick/quote constraint: it QUOTES the error in code formatting, it is not the banner.
  const legit = "You'll see `API Error: 401` when your token expires — run /login to fix it.";
  assert.equal(detectTuiUpstreamError(legit), null);
});
test("C-1 PASS: bare HTTP-status sentence (no 'API Error:' core)", () => {
  assert.equal(detectTuiUpstreamError("HTTP 401 means unauthorized."), null);
});
test("C-1 PASS: plain unrelated answer", () => {
  assert.equal(detectTuiUpstreamError("The capital of France is Paris."), null);
});

// ---- Supporting / regression coverage ----
test("C-1 PASS: transient 5xx banner is NOT detected (narrowed to 4xx auth only)", () => {
  // The old rule flagged any 3-digit code; the narrowed detector is 4xx-only by design
  // (5xx is transient/server-side, not the R-1 auth case). Accepted false-negative.
  assert.equal(detectTuiUpstreamError("API Error: 500 Internal Server Error"), null);
});
test("C-1 PASS: bare 4xx with no auth keyword is NOT detected", () => {
  // 'API Error: 403 Forbidden' alone — 4xx and short, but no authenticat/login/credential.
  assert.equal(detectTuiUpstreamError("API Error: 403 Forbidden"), null);
});
test("detectTuiUpstreamError trims surrounding whitespace before matching", () => {
  const out = detectTuiUpstreamError("\n\n  Please run /login · API Error: 401 credential boom  \n");
  assert.equal(out, "Please run /login · API Error: 401 credential boom");
});
test("detectTuiUpstreamError is case-insensitive on the banner keywords", () => {
  // lower-cased: /login + api error: 401 + 'credential' keyword, short, no code char.
  assert.ok(detectTuiUpstreamError("please run /login · api error: 401 bad credential") !== null);
});
test("detectTuiUpstreamError does NOT match prose that mentions an API error mid-paragraph (#133 regression guard)", () => {
  // A long, legit answer that merely discusses an API error — rejected on length alone.
  const para = "When integrating with the upstream service you may occasionally hit an API Error: 401 response if the bearer token has lapsed; the recommended remediation is to re-run the login flow and retry the request with a fresh credential, after which the 401 should clear.";
  assert.equal(detectTuiUpstreamError(para), null);
});
test("detectTuiUpstreamError does NOT match a long plain-text auth answer with NO code chars (length cap is load-bearing)", () => {
  // 226 chars, no backtick/quote, has 4xx + /login + credential + authenticate — passes
  // signals 2-4. ONLY the length cap rejects it. Guards against dropping the cap.
  const para = "If you call the endpoint without a bearer token the API Error: 401 response tells you the credential is missing; just authenticate again with /login and the request will succeed on the next attempt without any further changes.";
  assert.equal(detectTuiUpstreamError(para), null);
});
test("detectTuiUpstreamError returns null on empty / whitespace / non-string", () => {
  assert.equal(detectTuiUpstreamError(""), null);
  assert.equal(detectTuiUpstreamError("   \n  "), null);
  assert.equal(detectTuiUpstreamError(null), null);
  assert.equal(detectTuiUpstreamError(undefined), null);
  assert.equal(detectTuiUpstreamError(42), null);
});
test("detectTuiUpstreamError respects CLAUDE_TUI_ERROR_PATTERNS override (custom banner)", () => {
  // Override with a single custom pattern; the default 401 banner no longer matches,
  // but the custom one does (anchored whole-text).
  assert.equal(detectTuiUpstreamError("Please run /login · API Error: 401 x", "Session expired, please re-auth"), null);
  assert.equal(detectTuiUpstreamError("Session expired, please re-auth", "Session expired, please re-auth"), "Session expired, please re-auth");
});
test("detectTuiUpstreamError with an empty override disables detection (escape hatch)", () => {
  assert.equal(detectTuiUpstreamError("API Error: 500 boom", ""), null);
  assert.equal(detectTuiUpstreamError("API Error: 500 boom", "   "), null);
});
test("detectTuiUpstreamError override accepts '||'-separated patterns", () => {
  const raw = "First banner||Second banner";
  assert.equal(detectTuiUpstreamError("First banner", raw), "First banner");
  assert.equal(detectTuiUpstreamError("Second banner", raw), "Second banner");
  assert.equal(detectTuiUpstreamError("Third", raw), null);
});
test("real error fixture: latest assistant text IS the banner and detectTuiUpstreamError flags it", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/error-401.jsonl", "utf8"));
  const text = extractLatestAssistantText(evs);
  assert.equal(text, "Please run /login · API Error: 401 Invalid authentication credentials");
  assert.ok(detectTuiUpstreamError(text) !== null, "error fixture's final turn must be flagged as an upstream error");
});
test("real error fixture (Failed-to-authenticate variant): final turn is flagged (#133 runtime gap)", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/error-401-failauth.jsonl", "utf8"));
  const text = extractLatestAssistantText(evs);
  assert.equal(text, "Failed to authenticate. API Error: 401 Invalid authentication credentials");
  assert.ok(detectTuiUpstreamError(text) !== null, "Failed-to-authenticate banner must be flagged as an upstream error");
});
test("real complete fixture: final answer is NOT flagged as an upstream error", () => {
  const evs = parseTranscriptLines(tuiReadFileSync("./lib/tui/fixtures/complete-haiku.jsonl", "utf8"));
  const text = extractLatestAssistantText(evs);
  assert.equal(detectTuiUpstreamError(text), null);
});

// ── TUI transcript — polling reader (async) ──────────────────────────────
import { readTuiTranscript } from "./lib/tui/transcript.mjs";
import { mkdtempSync as tuiMkdtemp, writeFileSync as tuiWriteFile } from "node:fs";
import { tmpdir as tuiTmpdir } from "node:os";

console.log("\nTUI transcript — polling reader:");

await asyncTest("readTuiTranscript returns assistant text when terminal marker present", async () => {
  const dir = tuiMkdtemp(`${tuiTmpdir()}/tui-`);
  const p = `${dir}/s.jsonl`;
  tuiWriteFile(p, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello world" }] } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1200, entrypoint: "cli" }),
  ].join("\n") + "\n");
  const out = await readTuiTranscript({ transcriptPath: p, wallclockMs: 2000, pollMs: 50 });
  assert.equal(out.text, "hello world");
  assert.equal(out.entrypoint, "cli");
});

// C-2 (#133): the terminal-marker path must signal a COMPLETE turn.
await asyncTest("readTuiTranscript signals truncated:false when a terminal marker is hit (complete turn)", async () => {
  const dir = tuiMkdtemp(`${tuiTmpdir()}/tui-`);
  const p = `${dir}/s.jsonl`;
  tuiWriteFile(p, [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1200, entrypoint: "cli" }),
  ].join("\n") + "\n");
  const out = await readTuiTranscript({ transcriptPath: p, wallclockMs: 2000, pollMs: 50 });
  assert.equal(out.truncated, false);
});

// C-2 (#133): cap-with-partial-text must be DISTINGUISHABLE from a complete turn.
// Previously both returned {text, entrypoint} identically and the partial was cached
// + returned as finish_reason:stop. The cap path now returns truncated:true so the
// caller (callClaudeTui) can throw instead of serving a cut-off answer.
await asyncTest("readTuiTranscript honours wall-clock cap and flags partial text truncated:true", async () => {
  const dir = tuiMkdtemp(`${tuiTmpdir()}/tui-`);
  const p = `${dir}/s.jsonl`;
  // No terminal marker → reader will spin to the cap then return the partial.
  tuiWriteFile(p, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }) + "\n");
  const out = await readTuiTranscript({ transcriptPath: p, wallclockMs: 300, pollMs: 50 });
  assert.equal(out.text, "partial");
  assert.equal(out.truncated, true);
});

await asyncTest("readTuiTranscript against real fixture: entrypoint is 'cli'", async () => {
  const out = await readTuiTranscript({ transcriptPath: "./lib/tui/fixtures/complete-haiku.jsonl", wallclockMs: 2000, pollMs: 50 });
  assert.equal(out.entrypoint, "cli");
});

await asyncTest("readTuiTranscript throws when no text and cap elapses", async () => {
  const dir = tuiMkdtemp(`${tuiTmpdir()}/tui-`);
  const p = `${dir}/missing.jsonl`;
  let threw = false;
  try { await readTuiTranscript({ transcriptPath: p, wallclockMs: 200, pollMs: 50 }); }
  catch { threw = true; }
  assert.ok(threw, "must throw on empty timeout");
});

// ── TUI session reaper ───────────────────────────────────────────────────
import { reapStaleTuiSessions, sessionPrefixForPort, LEGACY_SESSION_PREFIX, LEGACY_SESSION_NAME_RE, buildTuiCmd } from "./lib/tui/session.mjs";

console.log("\nTUI session reaper:");

// F7 fix: the session prefix is instance-scoped by listen port so a second OCP
// instance on the same host (different port) is never mistaken for "ours".
test("sessionPrefixForPort embeds the port (F7 instance scoping)", () => {
  assert.equal(sessionPrefixForPort(3456), "ocp-tui-3456-");
  assert.equal(sessionPrefixForPort(4000), "ocp-tui-4000-");
  assert.notEqual(sessionPrefixForPort(3456), sessionPrefixForPort(4000));
});

test("LEGACY_SESSION_NAME_RE matches only the exact old bare-prefix shape, never the new shape", () => {
  assert.ok(LEGACY_SESSION_NAME_RE.test(`${LEGACY_SESSION_PREFIX}a1b2c3d4`), "legacy 8-hex shape matches");
  assert.ok(!LEGACY_SESSION_NAME_RE.test("ocp-tui-3456-a1b2c3d4"), "new port-scoped shape must NOT match legacy regex");
  assert.ok(!LEGACY_SESSION_NAME_RE.test("ocp-tui-a1b2c3"), "too-short suffix must not match");
  assert.ok(!LEGACY_SESSION_NAME_RE.test("ocp-tui-a1b2c3d4extra"), "trailing extra chars must not match");
});

console.log("\nTUI command construction (proxy-purity / #4):");

test("buildTuiCmd suppresses host CLAUDE.md + auto-memory (proxy purity, #4)", () => {
  const cmd = buildTuiCmd("/usr/bin/claude", "claude-haiku", "sid-1", "/home/u", "cli");
  // OCP is a proxy: the host's CLAUDE.md / auto-memory must never leak into the proxied turn.
  // Primary mechanism is --safe-mode (env vars alone stopped suppressing on newer claude);
  // the env vars remain as belt-and-braces.
  assert.ok(/(^| )--safe-mode( |$)/.test(cmd), "default pane must pass --safe-mode (disables host CLAUDE.md/skills/plugins/hooks)");
  assert.ok(/(^| )CLAUDE_CODE_DISABLE_CLAUDE_MDS=1( |$)/.test(cmd), "must disable CLAUDE.md injection");
  assert.ok(/(^| )CLAUDE_CODE_DISABLE_AUTO_MEMORY=1( |$)/.test(cmd), "must disable auto-memory injection");
});

test("buildTuiCmd omits --safe-mode when a customization it would strip is in use", () => {
  const save = process.env.OCP_TUI_FULL_TOOLS;
  try {
    delete process.env.OCP_TUI_FULL_TOOLS;
    // streaming registers a MessageDisplay HOOK via --settings; --safe-mode would kill the hook
    // (zero deltas), so it must be omitted on the streaming pane.
    const streaming = buildTuiCmd("/usr/bin/claude", "m", "sid-s", "/home/u", "cli", { file: "/d/sid-s.jsonl", settings: "/d/s.json" });
    assert.ok(!/--safe-mode/.test(streaming), "streaming pane must NOT pass --safe-mode (would disable the MessageDisplay hook)");
    assert.ok(streaming.includes("--settings '/d/s.json'"), "streaming pane keeps its --settings hook");

    // OCP_TUI_FULL_TOOLS grants an MCP/skills surface --safe-mode disables wholesale.
    process.env.OCP_TUI_FULL_TOOLS = "1";
    const full = buildTuiCmd("/usr/bin/claude", "m", "sid-f", "/home/u", "cli");
    assert.ok(!/--safe-mode/.test(full), "full-tools pane must NOT pass --safe-mode (would disable MCP/skills)");
  } finally {
    if (save === undefined) delete process.env.OCP_TUI_FULL_TOOLS; else process.env.OCP_TUI_FULL_TOOLS = save;
  }
});

test("buildTuiCmd keeps version pin + entrypoint label + MCP wall", () => {
  const cli = buildTuiCmd("/usr/bin/claude", "m", "sid-2", "/home/u", "cli");
  assert.ok(cli.includes("DISABLE_AUTOUPDATER=1"), "version pin retained");
  assert.ok(cli.includes("CLAUDE_CODE_ENTRYPOINT=cli"), "cli mode labels the subscription pool");
  assert.ok(cli.includes("--strict-mcp-config") && cli.includes('mcp__*'), "MCP wall retained");
  // 'auto' mode must NOT pin the entrypoint (claude self-classifies via TTY).
  const auto = buildTuiCmd("/usr/bin/claude", "m", "sid-3", "/home/u", "auto");
  assert.ok(!/CLAUDE_CODE_ENTRYPOINT=/.test(auto), "auto mode leaves entrypoint unset");
  assert.ok(/-u CLAUDE_CODE_ENTRYPOINT/.test(auto), "auto mode unsets any inherited entrypoint");
});

// CLAUDE_CODE_OAUTH_TOKEN passthrough (PI231 401 incident): tmux doesn't forward the parent
// env to the pane, so the token must be set explicitly on the pane command or the TUI claude
// falls back to credentials.json (whose refresh token gets corrupted by the spawn/kill cycle).
test("buildTuiCmd passes CLAUDE_CODE_OAUTH_TOKEN when the env is set (shq-escaped)", () => {
  const save = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-abc123";
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-tok", "/home/u", "cli");
    // shq wraps in single quotes; a plain token renders as 'token'.
    assert.ok(cmd.includes("CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-abc123'"),
      "token must be set on the pane command, shq-escaped");
  } finally {
    if (save === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = save;
  }
});

test("buildTuiCmd does NOT add CLAUDE_CODE_OAUTH_TOKEN when the env is unset", () => {
  const save = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-notok", "/home/u", "cli");
    assert.ok(!/CLAUDE_CODE_OAUTH_TOKEN/.test(cmd),
      "no token added when env unset (credentials.json-only hosts unaffected)");
  } finally {
    if (save === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = save;
  }
});

test("buildTuiCmd shq-escapes a token containing shell metacharacters (no injection)", () => {
  const save = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    // A token with a single quote must be escaped via the '\'' idiom so it can't break out
    // of the shell string tmux runs via sh -c.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok'; rm -rf /;'";
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-inj", "/home/u", "cli");
    assert.ok(cmd.includes(`CLAUDE_CODE_OAUTH_TOKEN='tok'\\''; rm -rf /;'\\'''`),
      "single quote must be shq-escaped, not left bare");
    assert.ok(!/CLAUDE_CODE_OAUTH_TOKEN=tok'; rm/.test(cmd), "raw unescaped token must NOT appear");
  } finally {
    if (save === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = save;
  }
});

// OCP_TUI_EFFORT (TUI latency, docs/plans/2026-07-13-tui-latency): the pane's claude
// must get an EXPLICIT --effort so its effort never depends on which HOME mode
// resolveTuiHome() picked (real-home inherits the operator's settings.json effortLevel;
// env-token scratch inherits claude's built-in default).
test("buildTuiCmd passes --effort low by default (OCP_TUI_EFFORT unset)", () => {
  const save = process.env.OCP_TUI_EFFORT;
  try {
    delete process.env.OCP_TUI_EFFORT;
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-eff1", "/home/u", "cli");
    assert.ok(cmd.includes("--effort low"), "default must pin --effort low");
  } finally {
    if (save === undefined) delete process.env.OCP_TUI_EFFORT;
    else process.env.OCP_TUI_EFFORT = save;
  }
});

test("buildTuiCmd honors an explicit OCP_TUI_EFFORT level (case/space-normalized)", () => {
  const save = process.env.OCP_TUI_EFFORT;
  try {
    process.env.OCP_TUI_EFFORT = " XHigh ";
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-eff2", "/home/u", "cli");
    assert.ok(cmd.includes("--effort xhigh"), "explicit level must be passed, normalized");
    assert.ok(!cmd.includes("--effort low"), "default must not also appear");
  } finally {
    if (save === undefined) delete process.env.OCP_TUI_EFFORT;
    else process.env.OCP_TUI_EFFORT = save;
  }
});

test("buildTuiCmd OCP_TUI_EFFORT=inherit omits --effort entirely (pre-flag argv)", () => {
  const save = process.env.OCP_TUI_EFFORT;
  try {
    process.env.OCP_TUI_EFFORT = "inherit";
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-eff3", "/home/u", "cli");
    assert.ok(!/--effort/.test(cmd), "inherit must not add --effort");
  } finally {
    if (save === undefined) delete process.env.OCP_TUI_EFFORT;
    else process.env.OCP_TUI_EFFORT = save;
  }
});

test("buildTuiCmd falls back to --effort low on an invalid OCP_TUI_EFFORT (never reaches argv)", () => {
  const save = process.env.OCP_TUI_EFFORT;
  const savedErr = console.error;
  try {
    process.env.OCP_TUI_EFFORT = "ludicrous'; rm -rf /;'";
    let warned = "";
    console.error = (...a) => { warned = a.join(" "); };
    const cmd = buildTuiCmd("/usr/bin/claude", "m", "sid-eff4", "/home/u", "cli");
    assert.ok(cmd.includes("--effort low"), "invalid value must fall back to low");
    assert.ok(!cmd.includes("ludicrous"), "invalid raw value must NOT reach the shell string");
    assert.ok(/invalid OCP_TUI_EFFORT/.test(warned), "must log a warning");
  } finally {
    console.error = savedErr;
    if (save === undefined) delete process.env.OCP_TUI_EFFORT;
    else process.env.OCP_TUI_EFFORT = save;
  }
});

test("buildTuiCmd OCP_TUI_FULL_TOOLS=1 grants -p-equivalent tool surface (single-user opt-in)", () => {
  const save = { ...process.env };
  const restore = () => {
    for (const k of ["OCP_TUI_FULL_TOOLS", "CLAUDE_MCP_CONFIG", "CLAUDE_ALLOWED_TOOLS"]) {
      if (k in save) process.env[k] = save[k]; else delete process.env[k];
    }
  };
  try {
    // default (gate off) keeps the MCP wall, no --allowedTools
    delete process.env.OCP_TUI_FULL_TOOLS;
    const off = buildTuiCmd("/usr/bin/claude", "m", "s", "/home/u", "cli");
    assert.ok(off.includes("--strict-mcp-config") && !off.includes("--allowedTools"), "gate off = MCP wall");

    // gate on: --allowedTools (default set incl Bash), MCP wall dropped
    process.env.OCP_TUI_FULL_TOOLS = "1";
    delete process.env.CLAUDE_MCP_CONFIG;
    delete process.env.CLAUDE_ALLOWED_TOOLS;
    const full = buildTuiCmd("/usr/bin/claude", "m", "s", "/home/u", "cli");
    assert.ok(full.includes("--allowedTools") && full.includes("Bash"), "full-tools grants --allowedTools incl Bash");
    assert.ok(!full.includes("--strict-mcp-config") && !/--disallowedTools/.test(full), "full-tools drops the MCP wall");
    assert.ok(!full.includes("--dangerously-skip-permissions"), "skip-permissions branch is removed (bricks headless TUI)");

    // mcp-config threaded through
    process.env.CLAUDE_MCP_CONFIG = "/tmp/mcp.json";
    const mcp = buildTuiCmd("/usr/bin/claude", "m", "s", "/home/u", "cli");
    assert.ok(/--mcp-config '\/tmp\/mcp.json'/.test(mcp), "mcp-config passed through (shq'd)");

    // operator-supplied scoped tool specifiers must be shell-quoted (no injection via ()*~)
    delete process.env.CLAUDE_MCP_CONFIG;
    process.env.CLAUDE_ALLOWED_TOOLS = "Bash(npm run test:*),Read";
    const scoped = buildTuiCmd("/usr/bin/claude", "m", "s", "/home/u", "cli");
    assert.ok(scoped.includes("'Bash(npm run test:*)'"), "scoped tool tokens are shq'd in the shell string");
    assert.ok(!/--allowedTools Bash\(npm/.test(scoped), "scoped token must NOT appear unquoted");
  } finally {
    restore();
  }
});

test("reaper kills ONLY this instance's own port-scoped sessions, never olp-tui-", () => {
  const killed = [];
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nolp-tui-bbbb\nmisc\nocp-tui-3456-cccc\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 2);
  assert.equal(killed.join(","), "ocp-tui-3456-aaaa,ocp-tui-3456-cccc");
  assert.ok(!killed.includes("olp-tui-bbbb"), "olp-tui-bbbb must never be killed");
});

// F7 fix: a second OCP instance on the same host (different port) must be treated exactly
// like a foreign product prefix — never reaped, never allowed to trigger kill-server.
test("reaper treats a sibling OCP instance on a DIFFERENT port as foreign (F7)", () => {
  const killed = [];
  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nocp-tui-9999-bbbb\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 1, "killed only the own-port session");
  assert.equal(killed.join(","), "ocp-tui-3456-aaaa");
  assert.ok(!killed.includes("ocp-tui-9999-bbbb"), "sibling instance's session (port 9999) must NEVER be killed");
  assert.ok(!calls.includes("kill-server"), "kill-server MUST NOT fire — sibling instance's session still live");
});

test("reaper returns 0 when tmux status !== 0 (no server)", () => {
  const fakeTmux = (_args) => ({ status: 1, stdout: "" });
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 0);
});

test("reaper returns 0 for empty session list", () => {
  const killed = [];
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 0);
  assert.equal(killed.length, 0);
});

// Defunct-zombie reaping (PI231 incident): the pane's claude is a child of the tmux server,
// so only kill-server actually reaps it. We kill-server ONLY when no foreign session remains.
console.log("\nTUI defunct-zombie reaping (kill-server):");

test("reaper kill-servers when the server is ours-only (flush defunct claude zombies)", () => {
  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nocp-tui-3456-bbbb\n" };
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 2, "killed both of our sessions");
  assert.ok(calls.includes("kill-server"), "kill-server fired — reaps the defunct backlog");
});

test("reaper does NOT kill-server when a foreign (non-ocp) session remains (coexistence)", () => {
  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nolp-tui-bbbb\n" };
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 1, "killed only our own session");
  assert.ok(!calls.includes("kill-server"), "kill-server MUST NOT fire — would disrupt olp-tui-*");
});

test("reaper does NOT kill-server when there is no server (status !== 0)", () => {
  const calls = [];
  const fakeTmux = (args) => { calls.push(args.join(" ")); return { status: 1, stdout: "" }; };
  reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.ok(!calls.includes("kill-server"), "no server → no kill-server (early return)");
});

// Legacy migration (F7): pre-fix versions created bare-prefix `ocp-tui-<uuid8>` sessions with
// no port segment. includeLegacy is the boot-only opt-in that claims these as our own leftover
// zombies; the periodic sweep never sets it, so a lingering legacy session cannot trigger
// kill-server on a routine 15-minute tick.
console.log("\nTUI legacy-prefix migration (boot-only reap, F7):");

test("reaper leaves legacy bare-prefix sessions untouched by default (includeLegacy unset)", () => {
  const killed = [];
  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nocp-tui-deadbeef\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 1, "killed only the own-port session");
  assert.ok(!killed.includes("ocp-tui-deadbeef"), "legacy session must NOT be reaped without includeLegacy");
  assert.ok(!calls.includes("kill-server"), "legacy session blocks kill-server when not claimed");
});

test("reaper claims legacy bare-prefix sessions when includeLegacy=true (boot-time migration)", () => {
  const killed = [];
  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nocp-tui-deadbeef\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456, includeLegacy: true });
  assert.equal(n, 2, "both own-port and legacy sessions reaped");
  assert.ok(killed.includes("ocp-tui-deadbeef"), "legacy session claimed as our own leftover");
  assert.ok(calls.includes("kill-server"), "kill-server fires once no foreign/unclaimed session remains");
});

test("reaper with includeLegacy=true still spares a sibling instance's port-scoped session", () => {
  const killed = [];
  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\nocp-tui-deadbeef\nocp-tui-9999-zzzz\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456, includeLegacy: true });
  assert.equal(n, 2, "own-port + legacy reaped, sibling instance untouched");
  assert.ok(!killed.includes("ocp-tui-9999-zzzz"), "sibling instance session must never be claimed as legacy");
  assert.ok(!calls.includes("kill-server"), "sibling instance's live session still blocks kill-server");
});

// ── TUI warm pane pool (docs/plans/2026-07-13-tui-latency #3) ────────────
import { TuiPanePool, resolvePoolSize, POOL_MAX_SIZE, POOL_MAX_AGE_MS } from "./lib/tui/pool.mjs";
import { poolPaneName as poolName } from "./lib/tui/session.mjs";

// A pool wired to fakes: no tmux, no claude. bootPane resolves on the microtask queue; use
// `await settle()` after a refill() to let the SERIALIZED boot chain run to target.
// `live` models the real tmux server: bootTuiPane creates the session SYNCHRONOUSLY and only
// THEN waits (up to POOL_BOOT_MS) for the input bar, so the fake boot registers the session
// immediately and only afterwards resolves. `opts.hold` keeps a boot in that mid-flight window
// so tests can act on a pane that is live-but-not-yet-warm — the state that hid two bugs.
function makeFakePool(opts = {}) {
  const killed = [];
  const booted = [];
  const live = new Set();   // "tmux sessions" that currently exist
  let seq = 0;
  let clock = 1_000_000;
  const healthy = new Set();
  // FIFO gate queue — one entry per in-flight held boot. A single `release` slot would be
  // OVERWRITTEN by a later boot, so releasing "the first boot" would silently release the
  // second instead (and mask the stale-settle bug this harness exists to test).
  const gates = [];
  const pool = new TuiPanePool({
    size: opts.size ?? 2,
    maxAgeMs: opts.maxAgeMs ?? POOL_MAX_AGE_MS,
    now: () => clock,
    mintPane: () => {
      const n = ++seq;
      return { sessionId: `sid-${n}`, name: `ocp-tui-3456-p${String(n).padStart(8, "0")}` };
    },
    bootPane: async (model, { sessionId, name }) => {
      live.add(name);                                     // session exists NOW
      booted.push({ name, model });
      if (opts.hold) {
        await new Promise((r) => gates.push(r));          // ...stuck waiting for readiness
      }
      if (opts.bootThrows) { live.delete(name); throw new Error("boom"); }
      // A pane whose session was killed while booting can never become ready — exactly what
      // the real bootTuiPane does (it throws tui_pane_not_ready).
      if (!live.has(name)) throw new Error("tui_pane_not_ready");
      healthy.add(name);
      return { name, sessionId, model, bootedAt: clock };
    },
    killPane: (name) => { killed.push(name); healthy.delete(name); live.delete(name); },
    paneHealthy: (name) => healthy.has(name),
  });
  return {
    pool, killed, booted, healthy, live,
    releaseBoot: () => { const r = gates.shift(); if (r) r(); },  // release the OLDEST held boot
    advance: (ms) => { clock += ms; }, at: () => clock,
  };
}
const tick = () => new Promise((r) => setImmediate(r));
// Refills are SERIALIZED (one boot at a time, re-kicked on success), so settling the pool
// takes a chain of microtask turns, not one. 40 is far more than POOL_MAX_SIZE needs.
const settle = async () => { for (let i = 0; i < 40; i++) await tick(); };

console.log("\nTUI warm pane pool (acquire / miss / refill / TTL / reaper exemption):");

test("resolvePoolSize: default/garbage/negative disable the pool; size is clamped to POOL_MAX_SIZE", () => {
  assert.equal(resolvePoolSize(undefined), 0, "unset => off (byte-for-byte today's cold path)");
  assert.equal(resolvePoolSize("0"), 0);
  assert.equal(resolvePoolSize("-3"), 0);
  assert.equal(resolvePoolSize("banana"), 0, "garbage disables rather than guessing a size");
  assert.equal(resolvePoolSize("2"), 2);
  assert.equal(resolvePoolSize("99"), POOL_MAX_SIZE, "clamped — never boot an unbounded number of idle claudes");
});

test("pool size 0 is inert: acquire always misses and refill never boots", async () => {
  const { pool, booted } = makeFakePool({ size: 0 });
  assert.equal(pool.enabled, false);
  assert.equal(pool.acquire("m1"), null, "disabled pool always MISSES → caller cold-boots");
  pool.refill();
  await settle();
  assert.equal(booted.length, 0, "a disabled pool must never spawn a process");
});

test("acquire MISSES on an empty pool, and the miss refills for the requested model", async () => {
  const { pool, booted } = makeFakePool({ size: 2 });
  assert.equal(pool.acquire("sonnet"), null, "first request is always a MISS (no boot-time pre-warm)");
  assert.equal(pool.misses, 1);
  pool.refill();
  await settle();
  assert.equal(pool.warm, 2, "refilled to target");
  assert.deepEqual(booted.map((b) => b.model), ["sonnet", "sonnet"], "warmed for the model that missed");
});

test("acquire HITS a warm pane, hands it out ONCE, and never returns it (single-use)", async () => {
  const { pool } = makeFakePool({ size: 2 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  assert.equal(pool.warm, 2);

  const a = pool.acquire("sonnet");
  assert.ok(a && a.name && a.sessionId, "warm pane handed out");
  assert.equal(pool.hits, 1);
  assert.equal(pool.warm, 1, "the pane LEAVES the registry when acquired");

  const b = pool.acquire("sonnet");
  assert.notEqual(b.name, a.name, "a pane is NEVER handed out twice — single-use");
  assert.notEqual(b.sessionId, a.sessionId, "each pane carries its OWN fresh session-id (transcript.mjs scoping)");
  assert.equal(pool.warm, 0);
  assert.equal(pool.acquire("sonnet"), null, "exhausted pool MISSES rather than reusing a pane");
});

test("refill is bounded: never more than `size` panes, and concurrent refills do not overshoot", async () => {
  const { pool, booted } = makeFakePool({ size: 2 });
  pool.acquire("sonnet");
  pool.refill(); pool.refill(); pool.refill(); // hammer it
  await settle();
  assert.equal(pool.warm, 2, "still exactly `size` warm panes");
  assert.equal(booted.length, 2, "the _booting guard prevented duplicate boots");
});

// Live finding at size=2: two cold `claude` boots racing an in-flight turn made a refill
// overrun even the generous pool readiness cap. Boots are therefore SERIALIZED.
test("refill boots panes ONE AT A TIME (never two claude cold-boots racing each other)", async () => {
  let concurrent = 0, peak = 0;
  let seq = 0;
  const pool = new TuiPanePool({
    size: 3,
    mintPane: () => { const n = ++seq; return { sessionId: `s${n}`, name: `p${n}` }; },
    bootPane: async (model, { sessionId, name }) => {
      concurrent++; peak = Math.max(peak, concurrent);
      await new Promise((r) => setImmediate(r)); // simulate boot latency
      concurrent--;
      return { name, sessionId, model, bootedAt: Date.now() };
    },
    killPane: () => {},
    paneHealthy: () => true,
  });
  pool.acquire("sonnet");
  pool.refill();
  await settle();
  assert.equal(pool.warm, 3, "chain still reaches the target size");
  assert.equal(peak, 1, "at most ONE boot in flight at any moment");
});

test("a FAILED boot does not re-kick the chain (backoff — a broken claude must not spin)", async () => {
  const { pool, booted } = makeFakePool({ size: 3, bootThrows: true });
  pool.acquire("sonnet");
  pool.refill();
  await settle();
  assert.equal(pool.bootFailures, 1, "counted as a genuine failure (nobody cancelled it)");
  assert.equal(booted.length, 1, "exactly ONE attempt — a failure stops the chain, it does not respawn forever");
  assert.equal(pool.warm, 0);
  assert.equal(pool.booting, 0, "and the booting slot is released, so the next trigger can retry");
});

test("acquire drops an UNHEALTHY warm pane (kills it) and falls through to a MISS", async () => {
  const { pool, killed, healthy, booted } = makeFakePool({ size: 1 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  const dead = booted[0].name;
  healthy.delete(dead); // pane died / stopped being input-ready while idle

  assert.equal(pool.acquire("sonnet"), null, "a dead pane must MISS, never hang a turn");
  assert.ok(killed.includes(dead), "the dead pane is killed, not leaked");
  assert.equal(pool.misses, 2);
});

test("acquire drops an EXPIRED warm pane (older than maxAgeMs)", async () => {
  const { pool, killed, booted, advance } = makeFakePool({ size: 1, maxAgeMs: 60_000 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  advance(60_001);
  assert.equal(pool.acquire("sonnet"), null, "a pane past its TTL is not handed out");
  assert.ok(killed.includes(booted[0].name), "expired pane is killed");
});

test("a model switch drops the wrong-model panes and retargets the pool (--model is fixed at spawn)", async () => {
  const { pool, killed, booted } = makeFakePool({ size: 2 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  const sonnetPanes = booted.map((b) => b.name);

  assert.equal(pool.acquire("opus"), null, "different model => MISS (a sonnet pane cannot serve opus)");
  assert.equal(pool.warm, 0, "sonnet panes dropped");
  for (const p of sonnetPanes) assert.ok(killed.includes(p), "wrong-model pane killed, not leaked");
  assert.equal(pool.warmModel, "opus", "pool retargeted to the model actually being asked for");

  pool.refill(); await settle();
  assert.deepEqual(booted.slice(2).map((b) => b.model), ["opus", "opus"], "refilled for the NEW model");
});

test("a boot that resolves AFTER a drain kills its own pane instead of enlisting it", async () => {
  const { pool, live } = makeFakePool({ size: 1 });
  pool.acquire("sonnet");
  pool.refill();          // boot is in flight...
  pool.drain();           // ...pool drained before it resolves (shutdown / reap sweep)
  await settle();
  assert.equal(pool.warm, 0, "the late pane must NOT be enlisted into a drained pool");
  // Assert LIVENESS, not the kill-call COUNT. This assertion used to read
  // `assert.equal(killed.length, 1)` — and it PASSED while the orphan it is named after was
  // actually present: _cancelBooting kills BY NAME, and at drain time the tmux session does not
  // exist yet (bootPane runs on a microtask), so that kill is a NO-OP which still increments the
  // counter. "kill was called once" and "a live session is orphaned" were both true at the same
  // time. The only honest question is whether the session is dead.
  assert.equal(live.size, 0, "it kills itself — no orphan process left behind");
});

test("bootPane failure is counted, never thrown into the request path, and does not wedge refill", async () => {
  const { pool } = makeFakePool({ size: 1, bootThrows: true });
  pool.acquire("sonnet");
  pool.refill();
  await settle();
  assert.equal(pool.warm, 0);
  assert.equal(pool.bootFailures, 1);
  assert.equal(pool.booting, 0, "the _booting counter is released on failure (else refill wedges forever)");
  assert.equal(pool.acquire("sonnet"), null, "and the caller just MISSES → cold path");
});

test("drain kills every warm pane and pauses refills; resume restarts them", async () => {
  const { pool, killed } = makeFakePool({ size: 2 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  assert.equal(pool.warm, 2);

  assert.equal(pool.drain(), 2, "drain reports how many it killed");
  assert.equal(pool.warm, 0);
  assert.equal(killed.length, 2, "both panes killed — none outlive the drain");

  pool.refill(); await settle();
  assert.equal(pool.warm, 0, "refill is a NO-OP while drained (paused)");

  pool.resume(); await settle();
  assert.equal(pool.warm, 2, "resume refills");
});

// ── The crux: pool ↔ reaper coexistence (POOL/REAPER INVARIANT, lib/tui/session.mjs) ──
console.log("\nTUI warm pool ↔ session reaper coexistence:");

test("INVARIANT 1: a LIVE pooled pane is NEVER reaped (it is in the spare set)", () => {
  const killed = [];
  const live = "ocp-tui-3456-pdeadbeef";
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: `${live}\nocp-tui-3456-aaaa\n` };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456, spare: new Set([live]) });
  assert.equal(n, 1, "only the stale turn session was reaped");
  assert.ok(!killed.includes(live), "the live warm pane must survive the sweep");
  assert.ok(killed.includes("ocp-tui-3456-aaaa"), "a genuinely stale own session is still reaped");
});

test("INVARIANT 2: an ORPHANED pooled pane (pool-shaped but NOT in the spare set) IS reaped", () => {
  const killed = [];
  // ocp-tui-3456-porphan01 LOOKS pooled but the live registry does not claim it — e.g. left
  // behind by a previous process generation, whose in-memory registry died with it.
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-porphan01\nocp-tui-3456-plive0001\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456, spare: new Set(["ocp-tui-3456-plive0001"]) });
  assert.equal(n, 1);
  assert.deepEqual(killed, ["ocp-tui-3456-porphan01"], "exemption is by EXACT NAME, never by name shape");
});

test("INVARIANT 2b: with NO spare set (the pre-pool call shape) pool-shaped panes are reaped — fail-safe", () => {
  const killed = [];
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-pdeadbeef\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux, port: 3456 });
  assert.equal(n, 1, "omitting `spare` reaps MORE, never less — forgetting it can't leak panes");
  assert.deepEqual(killed, ["ocp-tui-3456-pdeadbeef"]);
});

test("INVARIANT 3: kill-server is SUPPRESSED while a live pooled pane is spared", () => {
  const calls = [];
  const live = "ocp-tui-3456-plive0001";
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: `${live}\nocp-tui-3456-aaaa\n` };
    return { status: 0, stdout: "" };
  };
  reapStaleTuiSessions({ tmux: fakeTmux, port: 3456, spare: new Set([live]) });
  assert.ok(!calls.includes("kill-server"), "kill-server would kill the live pane (a child of the tmux server)");
});

test("INVARIANT 3b: after a DRAIN the spare set is empty, so kill-server fires again (zombie reaping preserved)", async () => {
  // This is the whole reason server.mjs drains BEFORE the periodic sweep: a permanently-full
  // pool would otherwise permanently suppress the only mechanism that reaps defunct claudes.
  const { pool } = makeFakePool({ size: 2 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  assert.equal(pool.liveNames().size, 2, "pool is full → the sweep would be suppressed");

  pool.drain();
  assert.equal(pool.liveNames().size, 0, "drain empties the live registry");

  const calls = [];
  const fakeTmux = (args) => {
    calls.push(args.join(" "));
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-3456-aaaa\n" };
    return { status: 0, stdout: "" };
  };
  reapStaleTuiSessions({ tmux: fakeTmux, port: 3456, spare: pool.liveNames() });
  assert.ok(calls.includes("kill-server"), "kill-server fires post-drain — defunct zombies still get reaped");
});

// ── MID-BOOT: the state that hid M1a + M1b ────────────────────────────────────────────
// bootTuiPane creates the tmux session SYNCHRONOUSLY, then waits up to POOL_BOOT_MS (20s)
// for the input bar. So a pooled session can be LIVE for ~20s before its boot resolves.
// Every reaper test above uses a pool that is either full or drained — never mid-boot.
// That gap is exactly why both bugs shipped past the first round of tests.

test("M1a: a reap tick during an IN-FLIGHT BOOT must not orphan-kill the booting pane", async () => {
  const { pool, live } = makeFakePool({ size: 1, hold: true });
  pool.acquire("sonnet");
  pool.refill();
  await tick();                                    // boot started; session live; NOT yet warm
  assert.equal(pool.warm, 0, "not warm yet");
  assert.equal(pool.booting, 1, "a boot is in flight");
  assert.equal(live.size, 1, "...and its tmux session ALREADY EXISTS");

  const bootingName = [...live][0];
  assert.ok(pool.liveNames().has(bootingName),
    "REGRESSION GUARD: the booting pane MUST be nameable, or the sweep cannot spare it " +
    "(the pool used to track in-flight boots as a COUNT and this was empty)");
});

test("M1a: the reap tick's drain kills the booting pane, and resume() starts a FRESH boot", async () => {
  const warns = [];
  const { pool, live, releaseBoot } = makeFakePool({ size: 1, hold: true });
  pool._log = (lvl, ev) => { if (lvl === "warn") warns.push(ev); };
  pool.acquire("sonnet");
  pool.refill();
  await tick();
  const first = [...live][0];

  // The reap tick, as server.mjs runs it: drain -> reap -> resume.
  const drained = pool.drain();
  assert.equal(drained, 1, "drain accounts for the booting pane");
  assert.equal(live.size, 0, "its tmux session is killed — kill-server can now flush zombies");
  assert.equal(pool.liveNames().size, 0, "nothing left to spare, so kill-server is not suppressed");

  pool.resume();
  await tick();
  assert.equal(pool.booting, 1, "resume() started a FRESH boot — the pool is not left empty with nothing scheduled");
  assert.notEqual([...live][0], first, "and it is a NEW pane, not the killed one");

  // Now let the ORIGINAL (cancelled) boot settle. It rejects with tui_pane_not_ready because
  // we killed its session — but that is OUR doing, not a fault.
  releaseBoot();
  await settle();
  assert.equal(pool.bootFailures, 0,
    "a cancelled boot must NOT be counted as a bootFailure — that is the WARN operators alert on");
  assert.deepEqual(warns, [], "and it must not log tui_pool_boot_failed for a healthy drain");
  assert.equal(pool.cancelled, 1, "it is counted as a cancellation instead (counted exactly once)");
});

test("M1b: shutdown drain kills the booting pane SYNCHRONOUSLY — no orphaned claude", async () => {
  const { pool, live } = makeFakePool({ size: 1, hold: true });
  pool.acquire("sonnet");
  pool.refill();
  await tick();
  assert.equal(live.size, 1, "a live pooled session exists");

  // gracefulShutdown: drain() then process.exit(0) IN THE SAME TICK (TUI panes are tmux
  // children, not node children, so activeProcesses is empty and the exit is immediate).
  // Nothing scheduled on the microtask queue can run. So we assert WITHOUT awaiting.
  pool.drain();
  assert.equal(live.size, 0,
    "REGRESSION GUARD: the pane must be dead BEFORE any await. A .then()-based cleanup would " +
    "never run before process.exit and would orphan a live authenticated `claude`.");
});

// M1b, second costume: drain() in the SAME synchronous block as refill(). The tmux session does
// not exist yet at drain time (bootPane runs on a microtask), so _cancelBooting's kill-by-name is
// a no-op — and a `.then` that merely `return`s on a stale generation would then let the boot
// CREATE the session and walk away from it. Not reachable from any current call site, but ADR 0008
// and the reap-tick comment both contemplate a boot-time pre-warm, which is exactly this shape.
// NOTE: deliberately NOT `hold: true`. A held boot never settles, so its `.then` never runs and
// the guard would vacuously pass — the test must let the boot actually SUCCEED, because the bug is
// precisely that a SUCCESSFUL boot on a cancelled generation walks away from its live session.
test("M1b': a boot cancelled BEFORE its session existed is still killed when it settles", async () => {
  const { pool, live } = makeFakePool({ size: 1 });
  pool.acquire("sonnet");                 // miss → learns the model

  pool.refill();   // mints the identity; bootPane is queued on a microtask — no session YET
  pool.drain();    // SAME sync block: kill-by-name finds nothing to kill (no-op), bumps the gen
  assert.equal(live.size, 0, "precondition: the session genuinely did not exist at cancel time");

  await tick();    // NOW the boot microtask runs, CREATES the session, and settles on a stale gen
  await tick();

  assert.equal(live.size, 0,
    "REGRESSION GUARD: a stale-generation boot must KILL its pane, not assume _cancelBooting " +
    "already did. _cancelBooting kills BY NAME, and the tmux session does not exist until the " +
    "boot microtask runs — so a cancellation landing first is a no-op, and a bare `return` here " +
    "orphans a live authenticated `claude` that nothing owns.");
});

test("a stale boot settling after drain+resume must not clear the NEW boot's slot", async () => {
  const { pool, releaseBoot } = makeFakePool({ size: 1, hold: true });
  pool.acquire("sonnet");
  pool.refill();
  await tick();
  pool.drain();                 // cancels boot #1 (generation bumped)
  pool.resume();
  await tick();
  assert.equal(pool.booting, 1, "boot #2 owns the slot");
  releaseBoot();                // boot #1 finally settles (rejects)
  await settle();
  assert.equal(pool.booting, 1, "boot #2 STILL owns the slot — a stale settle must not free it");
});

test("a model switch cancels an in-flight boot for the OLD model (kills it, frees the slot)", async () => {
  const { pool, live, killed } = makeFakePool({ size: 1, hold: true });
  pool.acquire("sonnet");
  pool.refill();
  await tick();
  const sonnetPane = [...live][0];

  pool.acquire("opus");         // retarget mid-boot
  assert.ok(killed.includes(sonnetPane), "the old model's booting pane is killed, not left to linger");
  assert.equal(pool.booting, 0, "and its slot is freed immediately, so the new model can boot now");
  assert.equal(pool.warmModel, "opus");

  pool.refill();
  await tick();
  assert.equal(pool.booting, 1, "a boot for the NEW model starts without waiting out the old one");
});

test("a pane handed out for a turn leaves the spare set immediately (so its teardown is authoritative)", async () => {
  const { pool } = makeFakePool({ size: 2 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  const taken = pool.acquire("sonnet");
  assert.ok(!pool.liveNames().has(taken.name),
    "an acquired pane is the CALLER's — the pool must not also claim it live, or a crashed turn's pane would be spared forever");
});

test("N1: the pool mints ONE identity — the tmux name's hex is the transcript session-id's hex", async () => {
  // Without this, `tmux ls` shows a pane whose name has no relation to any transcript file,
  // so a live pane cannot be correlated to <HOME>/.claude/projects/*/<sessionId>.jsonl.
  const seen = [];
  const pool = new TuiPanePool({
    size: 1,
    mintPane: () => {
      const sessionId = "deadbeef-1111-2222-3333-444444444444";
      return { sessionId, name: poolName(3456, sessionId) };
    },
    bootPane: async (model, ident) => {
      seen.push(ident);
      return { ...ident, model, bootedAt: Date.now() };
    },
    killPane: () => {},
    paneHealthy: () => true,
  });
  pool.acquire("sonnet");
  pool.refill();
  await settle();
  assert.equal(seen.length, 1, "bootPane received the pool-minted identity");
  assert.equal(seen[0].name, "ocp-tui-3456-pdeadbeef");
  assert.ok(seen[0].name.endsWith(seen[0].sessionId.slice(0, 8)),
    "the tmux session name carries the session-id's own hex — `tmux ls` correlates to the transcript");
  const pane = pool.acquire("sonnet");
  assert.equal(pane.sessionId, seen[0].sessionId,
    "and the turn reads the transcript under THAT session-id — one identity end to end");
});

test("pool pane names are port-scoped (reapable as ours) and never match the legacy shape", () => {
  const name = poolName(3456, "deadbeef-1111-2222-3333-444444444444");
  assert.ok(name.startsWith(sessionPrefixForPort(3456)), "pool panes are OURS → reapable when orphaned");
  assert.equal(name, "ocp-tui-3456-pdeadbeef");
  assert.ok(!LEGACY_SESSION_NAME_RE.test(name), "must never be mistaken for a legacy bare-prefix session");
  assert.ok(!poolName(9999, "aaaaaaaa-0000-0000-0000-000000000000").startsWith(sessionPrefixForPort(3456)),
    "a sibling instance's pool pane is foreign to us");
});

test("buildTuiHealthBlock reports pool:null when off, and the pool's stats when on", async () => {
  const st = { lastEntrypoint: "cli", entrypointMismatches: 0 };
  const sem = { inflight: 0, queued: 0 };
  const off = buildTuiHealthBlock({ enabled: true, entrypointMode: "cli", maxConcurrent: 2 }, st, sem, null);
  assert.equal(off.pool, null, "pool disabled → explicit null (stable /health shape)");

  const { pool } = makeFakePool({ size: 2 });
  pool.acquire("sonnet"); pool.refill(); await settle();
  const on = buildTuiHealthBlock({ enabled: true, entrypointMode: "cli", maxConcurrent: 2 }, st, sem, pool);
  assert.equal(on.pool.size, 2);
  assert.equal(on.pool.warm, 2);
  assert.equal(on.pool.misses, 1);
  assert.equal(on.pool.model, "sonnet");
});

// ── TUI home preparation (scratch vs real) ───────────────────────────────
import { prepareTuiHome, ensureTuiCwdTrusted } from "./lib/tui/session.mjs";
import { mkdtempSync as hMkdtemp, mkdirSync as hMkdir, writeFileSync as hWrite, readFileSync as hRead, existsSync as hExists, readlinkSync as hReadlink } from "node:fs";
import { tmpdir as hTmp } from "node:os";

console.log("\nTUI home preparation:");

test("prepareTuiHome scratch mode: symlinks creds, seeds onboarded config, trusts cwd, strips history", () => {
  const realHome = hMkdtemp(testJoin(hTmp(), "real-"));
  hMkdir(testJoin(realHome, ".claude"), { recursive: true });
  hWrite(testJoin(realHome, ".claude", ".credentials.json"), '{"token":"x"}');
  hWrite(testJoin(realHome, ".claude.json"), JSON.stringify({ theme: "dark", projects: { "/old/secret/project": { hasTrustDialogAccepted: true } } }));
  const tuiHome = hMkdtemp(testJoin(hTmp(), "tui-"));
  const cwd = testJoin(tuiHome, "work");
  prepareTuiHome(realHome, tuiHome, cwd);
  // credentials symlinked (token never copied)
  assert.equal(hReadlink(testJoin(tuiHome, ".claude", ".credentials.json")), testJoin(realHome, ".claude", ".credentials.json"));
  const seed = JSON.parse(hRead(testJoin(tuiHome, ".claude.json"), "utf8"));
  assert.equal(seed.hasCompletedOnboarding, true);
  assert.equal(seed.theme, "dark");                                   // onboarded config carried over
  assert.equal(seed.projects[cwd].hasTrustDialogAccepted, true);      // scratch cwd trusted
  assert.equal(seed.projects["/old/secret/project"], undefined);      // user project history stripped
  assert.ok(hExists(testJoin(tuiHome, ".claude", "projects")));    // own projects dir
});

test("prepareTuiHome real mode (tuiHome===realHome): no symlink, just trusts cwd in real config", () => {
  const realHome = hMkdtemp(`${hTmp()}/real2-`);
  hWrite(`${realHome}/.claude.json`, JSON.stringify({ projects: {} }));
  const cwd = `${realHome}/work`;
  prepareTuiHome(realHome, realHome, cwd);
  assert.ok(!hExists(`${realHome}/.claude/.credentials.json`));        // no scratch symlink created
  const j = JSON.parse(hRead(`${realHome}/.claude.json`, "utf8"));
  assert.equal(j.projects[cwd].hasTrustDialogAccepted, true);         // cwd trusted in real config
});

// ── PR-D: env-token-only credential-isolated home (PI231 401 root fix) ──────
// Interactive claude PREFERS ~/.claude/.credentials.json over CLAUDE_CODE_OAUTH_TOKEN, so a
// stale/corrupt credentials.json SHADOWS the env token (proven live on PI231 — env token +
// broken creds = 401; env token + creds moved aside = works). The fix runs the TUI claude in
// a home with NO credentials.json so the env token is authoritative (and no refresh ever
// happens → the single-use token can't be corrupted by the spawn+kill cycle).
test("prepareTuiHome env-token mode: NO credentials.json (no symlink, no copy), .claude.json seeded", () => {
  const realHome = hMkdtemp(`${hTmp()}/realT-`);
  hMkdir(`${realHome}/.claude`, { recursive: true });
  hWrite(`${realHome}/.claude/.credentials.json`, '{"token":"real-oauth"}');  // real creds DO exist…
  hWrite(`${realHome}/.claude.json`, JSON.stringify({ theme: "dark", oauthAccount: { uuid: "secret" }, projects: { "/old/secret": { hasTrustDialogAccepted: true } } }));
  const tuiHome = hMkdtemp(`${hTmp()}/scratchT-`);
  const cwd = `${tuiHome}/work`;
  prepareTuiHome(realHome, tuiHome, cwd, { envTokenMode: true });
  // …but the scratch home has NO credentials file at all — neither symlink nor copy.
  assert.ok(!hExists(`${tuiHome}/.claude/.credentials.json`), "env-token home must have NO .credentials.json (the whole point — no shadowing, no refresh)");
  // .claude.json IS seeded: onboarding complete + ONLY the scratch cwd trusted (no dialog hang).
  const seed = JSON.parse(hRead(`${tuiHome}/.claude.json`, "utf8"));
  assert.equal(seed.hasCompletedOnboarding, true, "onboarding pre-completed → no onboarding dialog");
  assert.equal(seed.projects[cwd].hasTrustDialogAccepted, true, "scratch cwd pre-trusted → no trust dialog");
  // Minimal config: the credential-isolated home does NOT inherit the operator's account state.
  assert.equal(seed.theme, undefined, "env-token home is minimal — real config not copied in");
  assert.equal(seed.oauthAccount, undefined, "real account state not carried into the isolated home");
  assert.equal(seed.projects["/old/secret"], undefined, "operator project history not carried in");
  assert.ok(hExists(`${tuiHome}/.claude/projects`), "own projects/ dir for transcripts under the same home");
});

console.log("\nresolveTuiHome (env-token credential isolation, PR-D):");
import { resolveTuiHome, DEFAULT_TUI_SCRATCH_HOME } from "./lib/tui/session.mjs";

test("resolveTuiHome: env token set + OCP_TUI_HOME unset → credential-free scratch home", () => {
  const h = resolveTuiHome({ realHome: "/home/u", configuredHome: undefined, envTokenSet: true });
  assert.equal(h, DEFAULT_TUI_SCRATCH_HOME("/home/u"));
  assert.equal(h, "/home/u/.ocp-tui/home");
  assert.notEqual(h, "/home/u", "must NOT be the real home — real home has the shadowing credentials.json");
});

test("resolveTuiHome: env token UNSET → real home (legacy credentials.json path, unchanged)", () => {
  const h = resolveTuiHome({ realHome: "/home/u", configuredHome: undefined, envTokenSet: false });
  assert.equal(h, "/home/u", "no env token → real home, byte-for-byte the pre-fix behaviour");
});

test("resolveTuiHome: explicit OCP_TUI_HOME wins regardless of env token (back-compat)", () => {
  assert.equal(resolveTuiHome({ realHome: "/home/u", configuredHome: "/custom/home", envTokenSet: true }), "/custom/home");
  assert.equal(resolveTuiHome({ realHome: "/home/u", configuredHome: "/custom/home", envTokenSet: false }), "/custom/home");
});

// ── TUI concurrency limiter + drift observability (PR-B: audit C-4 / C-5) ──
import { TuiSemaphore, SemaphoreAbortError, recordTuiEntrypoint, buildTuiHealthBlock } from "./lib/tui/semaphore.mjs";

console.log("\nTUI concurrency limiter (C-4):");

const deferred = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };

await asyncTest("limit=1 serializes two overlapping calls (second waits for the first)", async () => {
  const sem = new TuiSemaphore(1);
  const order = [];
  const g1 = deferred();
  // First task acquires the only slot and blocks on g1.
  const t1 = sem.run(async () => { order.push("t1-start"); await g1.p; order.push("t1-end"); });
  await new Promise((r) => setImmediate(r)); // let t1 acquire
  assert.equal(sem.inflight, 1, "t1 holds the only slot");
  // Second task must QUEUE — it has not started yet.
  const t2 = sem.run(async () => { order.push("t2-start"); });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "t2 is queued, not running");
  assert.deepEqual(order, ["t1-start"], "t2 has not started while t1 holds the slot");
  // Release t1 → t2 runs.
  g1.resolve();
  await t1; await t2;
  assert.deepEqual(order, ["t1-start", "t1-end", "t2-start"], "t2 ran only after t1 finished");
  assert.equal(sem.inflight, 0, "all slots released");
  assert.equal(sem.queued, 0, "queue drained");
});

await asyncTest("limit=2 allows two concurrent, queues the third", async () => {
  const sem = new TuiSemaphore(2);
  const g = [deferred(), deferred(), deferred()];
  const started = [];
  const tasks = g.map((d, i) => sem.run(async () => { started.push(i); await d.p; }));
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 2, "exactly 2 run concurrently");
  assert.equal(sem.queued, 1, "the third is queued");
  assert.deepEqual(started.sort(), [0, 1], "only the first two started");
  g.forEach((d) => d.resolve());
  await Promise.all(tasks);
  assert.equal(sem.inflight, 0);
});

await asyncTest("slot is RELEASED on throw (finally) — a rejecting task never leaks its slot", async () => {
  const sem = new TuiSemaphore(1);
  await assert.rejects(sem.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(sem.inflight, 0, "throwing task released its slot");
  // Prove the slot is reusable: a subsequent task acquires immediately.
  let ran = false;
  await sem.run(async () => { ran = true; });
  assert.equal(ran, true);
  assert.equal(sem.inflight, 0);
});

await asyncTest("wait queue is bounded — run() rejects with tui_queue_full when full (backpressure, not OOM)", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 1 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; });          // holds the slot
  await new Promise((r) => setImmediate(r));
  const t2 = sem.run(async () => {});                        // fills the 1-deep queue
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "queue is full");
  await assert.rejects(sem.run(async () => {}), /tui_queue_full/, "third request rejects");
  g1.resolve();
  await t1; await t2;
  assert.equal(sem.inflight, 0);
});

console.log("\n-p concurrency wait-queue (FIX ⑥ — same TuiSemaphore reused for the -p path):");

// server.mjs reuses TuiSemaphore as `claudeSemaphore = new TuiSemaphore(MAX_CONCURRENT,
// { maxQueue: CLAUDE_MAX_QUEUE })` and wraps acquire()/release() in acquireClaudeSlot(). These
// tests assert the contract that the 429-mapping depends on: requests beyond the limit QUEUE
// (not reject), only an overflow past the queue rejects (→ HTTP 429 in server.mjs), and a
// released slot is reusable (the #37/#40 slot-leak guard — no leak on normal completion).
await asyncTest("FIX ⑥: requests beyond MAX_CONCURRENT queue, not reject (limit=1, queue=1)", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 1 });   // mirrors CLAUDE_MAX_CONCURRENT=1, CLAUDE_MAX_QUEUE=1
  const g1 = deferred();
  const inflightP = sem.run(async () => { await g1.p; });   // request 1 — holds the only slot
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 1, "req1 inflight");
  const queuedP = sem.run(async () => {});                  // request 2 — WAITS (queued), does NOT reject
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "req2 queued (waits), not rejected → would be served, not 429");
  // request 3 — queue full → reject (server.mjs maps this single case to 429 + Retry-After)
  await assert.rejects(sem.run(async () => {}), /tui_queue_full|queue/, "req3 overflows → reject (→429)");
  g1.resolve();
  await inflightP; await queuedP;
  assert.equal(sem.inflight, 0, "all slots released after drain (no leak)");
  assert.equal(sem.queued, 0, "queue fully drained");
});

await asyncTest("FIX ⑥: slot released on normal completion is immediately reusable (no #37/#40 leak)", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });   // mirrors default CLAUDE_MAX_QUEUE=16
  for (let i = 0; i < 5; i++) {
    await sem.run(async () => { /* a normal, completing turn */ });
    assert.equal(sem.inflight, 0, `slot released after turn ${i}`);
  }
  // Prove the limit still binds after many acquire/release cycles.
  const g = deferred();
  const held = sem.run(async () => { await g.p; });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 1, "limit still enforced after reuse cycles");
  g.resolve(); await held;
  assert.equal(sem.inflight, 0);
});

// ── Audit F1 — runtime-lowered/raised limit must actually bite ──────────────
// server.mjs reuses this same TuiSemaphore as `claudeSemaphore`; a PATCH /settings
// maxConcurrent update now calls `claudeSemaphore.setLimit(value)` (see applySettingUpdate's
// "maxConcurrent" case). These tests pin the semaphore-level contract that fix depends on.
console.log("\nF1 — runtime concurrency-limit changes (setLimit / release honoring the current limit):");

await asyncTest("F1: lowering the limit mid-load — release() stops re-granting until inflight drains under the new limit", async () => {
  const sem = new TuiSemaphore(3, { maxQueue: 16 });
  const g = [deferred(), deferred(), deferred()];
  const held = g.map((d) => sem.run(async () => { await d.p; }));
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 3, "3 tasks hold the 3 slots");
  // A 4th arrives while at capacity — it queues.
  const g4 = deferred();
  const queued4 = sem.run(async () => { await g4.p; });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "4th request queued");

  // Operator lowers maxConcurrent from 3 to 1 while all 3 original slots are still inflight
  // (mirrors a PATCH /settings maxConcurrent=1 hitting server.mjs mid-burst).
  sem.setLimit(1);
  assert.equal(sem.limit, 1);

  // Releasing one of the 3 original holders must NOT hand the freed slot to the queued 4th
  // request — before the F1 fix, release() handed slots off unconditionally, so inflight
  // would have stayed pinned at the OLD higher occupancy forever.
  g[0].resolve();
  await held[0];
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 2, "inflight drains toward the new limit, not re-granted");
  assert.equal(sem.queued, 1, "4th request is STILL queued — not over-admitted");

  g[1].resolve();
  await held[1];
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 1, "inflight now exactly at the new limit (1)");
  assert.equal(sem.queued, 1, "still queued — inflight(1) is not < limit(1), so no grant yet");

  // Releasing the LAST original holder finally drops inflight under the new limit — only
  // now does the queued 4th request get granted.
  g[2].resolve();
  await held[2];
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 1, "queued 4th request now holds the single slot");
  assert.equal(sem.queued, 0, "queue drained");
  g4.resolve();
  await queued4;
  assert.equal(sem.inflight, 0);
});

await asyncTest("F1: raising the limit wakes queued waiters immediately, up to the new headroom", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; }); // holds the only slot
  await new Promise((r) => setImmediate(r));
  const started = [];
  const g2 = deferred(), g3 = deferred();
  const t2 = sem.run(async () => { started.push(2); await g2.p; });
  const t3 = sem.run(async () => { started.push(3); await g3.p; });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 2, "both queue behind the single holder");
  assert.deepEqual(started, [], "neither queued task has started");

  // Operator raises maxConcurrent from 1 to 3 (2 units of new headroom) — BOTH queued
  // waiters must be woken immediately, without waiting for t1 to release.
  sem.setLimit(3);
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 3, "t1 + both newly-woken waiters now hold slots");
  assert.equal(sem.queued, 0, "queue drained by the limit raise");
  assert.deepEqual(started.sort(), [2, 3], "both queued tasks started without waiting for t1's release");

  g1.resolve(); g2.resolve(); g3.resolve();
  await Promise.all([t1, t2, t3]);
  assert.equal(sem.inflight, 0);
});

await asyncTest("F1: raising the limit wakes only as many waiters as the new headroom allows (FIFO)", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; });
  await new Promise((r) => setImmediate(r));
  const started = [];
  const g2 = deferred(), g3 = deferred();
  const t2 = sem.run(async () => { started.push(2); await g2.p; });
  const t3 = sem.run(async () => { started.push(3); await g3.p; });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 2);

  sem.setLimit(2); // only 1 unit of new headroom (1 -> 2) — exactly one queued waiter wakes
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 2);
  assert.equal(sem.queued, 1, "one waiter still queued — only one slot of headroom existed");
  assert.deepEqual(started, [2], "FIFO: the earlier-queued waiter (t2) wakes, not t3");

  // Freeing t1's slot afterward still honors the (now current) limit of 2 via release()'s
  // normal path — the still-queued t3 gets in once a slot actually frees.
  g1.resolve();
  await t1;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, [2, 3], "t3 granted once a slot frees, honoring the raised limit");
  assert.equal(sem.queued, 0);

  g2.resolve(); g3.resolve();
  await t2; await t3;
  assert.equal(sem.inflight, 0);
});

// ── Audit F2 — queued waiters must be cancellable on client disconnect ──────
// server.mjs wires an AbortSignal derived from the client's res "close" event into
// claudeSemaphore.acquire()/tuiSemaphore.acquire() (see closeSignalFor + acquireClaudeSlot /
// callClaudeTui). These tests pin the semaphore-level cancellation contract that depends on.
console.log("\nF2 — queued-wait cancellation via AbortSignal (client disconnect while queued):");

await asyncTest("F2: aborting a QUEUED waiter rejects with SemaphoreAbortError and SPLICES it out (queued drops immediately, not just flagged)", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; }); // holds the only slot
  await new Promise((r) => setImmediate(r));
  const controller = new AbortController();
  const acquire2 = sem.acquire(controller.signal); // queues behind t1
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "second acquire queued");

  controller.abort(); // simulates the client disconnecting while still queued
  await assert.rejects(acquire2, SemaphoreAbortError, "cancelled waiter rejects with SemaphoreAbortError");
  assert.equal(sem.queued, 0, "cancelled waiter is REMOVED — queue length drops immediately");
  assert.equal(sem.inflight, 1, "t1's slot is untouched by the cancellation");

  // Prove the cancelled waiter never later acquires a slot: free t1's slot and confirm
  // nobody is waiting to receive it (the queue is genuinely empty, not just decremented).
  g1.resolve();
  await t1;
  assert.equal(sem.inflight, 0, "slot freed with nobody queued — the cancelled waiter never got it");
});

await asyncTest("F2: an already-aborted signal rejects acquire() immediately, never touching the wait queue", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; }); // holds the only slot
  await new Promise((r) => setImmediate(r));

  const controller = new AbortController();
  controller.abort(); // client already gone before this request ever tries to acquire
  await assert.rejects(sem.acquire(controller.signal), SemaphoreAbortError);
  assert.equal(sem.queued, 0, "never entered the wait queue at all");

  g1.resolve(); await t1;
});

await asyncTest("F2: cancelling one queued waiter preserves FIFO order for the others", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; });
  await new Promise((r) => setImmediate(r));

  const started = [];
  const cA = new AbortController();
  const cB = new AbortController();
  const accA = sem.acquire(cA.signal).then(() => started.push("A"));
  const accB = sem.acquire(cB.signal).then(() => started.push("B"));
  const g3 = deferred();
  const t3 = sem.run(async () => { started.push("C"); await g3.p; });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 3, "A, B, C all queued behind t1");

  cB.abort(); // B (the middle waiter) disconnects
  await assert.rejects(accB, SemaphoreAbortError);
  assert.equal(sem.queued, 2, "B removed; A and C remain, in original relative order");

  g1.resolve();
  await t1;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["A"], "A (queued first, still present) is granted next — FIFO preserved after B's removal");
  assert.equal(sem.inflight, 1);
  assert.equal(sem.queued, 1, "C still waiting");

  sem.release(); // A was acquired directly (not via run()) — free its slot manually
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["A", "C"], "C granted next");
  g3.resolve();
  await t3;
  assert.equal(sem.inflight, 0);
});

await asyncTest("F2/L2: abort AFTER grant is a no-op — waiter keeps its slot, no rejection, slot released exactly once", async () => {
  const sem = new TuiSemaphore(1, { maxQueue: 16 });
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; }); // holds the only slot
  await new Promise((r) => setImmediate(r));

  const controller = new AbortController();
  let granted = false;
  const acq = sem.acquire(controller.signal).then(() => { granted = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.queued, 1, "waiter queued behind t1");

  // t1 finishes → release() shifts the waiter out and grants it the slot (waiter() detaches
  // the abort listener before resolving).
  g1.resolve();
  await t1;
  await acq;
  assert.equal(granted, true, "waiter was granted the slot");
  assert.equal(sem.inflight, 1, "granted waiter holds the slot");
  assert.equal(sem.queued, 0);

  // The client disconnects AFTER the grant — the abort-after-grant race. onAbort must be a
  // no-op (the waiter is no longer in _waiters; idx===-1 guard): no rejection materializes,
  // the queue is untouched, and the slot is still owned by the (already-resolved) acquirer.
  controller.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(sem.inflight, 1, "abort after grant did NOT revoke or double-free the slot");
  assert.equal(sem.queued, 0, "abort after grant did not corrupt queue accounting");

  // The slot is released exactly once via the normal path and is immediately reusable.
  sem.release();
  assert.equal(sem.inflight, 0, "slot released exactly once via the normal path");
  await sem.run(async () => {}); // prove the semaphore is fully healthy afterward
  assert.equal(sem.inflight, 0);
});

console.log("\nTUI drift observability (C-5):");

test("recordTuiEntrypoint: observed 'cli' is NOT a mismatch and sets lastEntrypoint", () => {
  const ts = { lastEntrypoint: null, entrypointMismatches: 0 };
  const mism = recordTuiEntrypoint(ts, "cli", "cli");
  assert.equal(mism, false);
  assert.equal(ts.lastEntrypoint, "cli");
  assert.equal(ts.entrypointMismatches, 0);
});

test("recordTuiEntrypoint: expected cli but observed 'sdk-cli' increments the mismatch counter (drift)", () => {
  const ts = { lastEntrypoint: null, entrypointMismatches: 0 };
  assert.equal(recordTuiEntrypoint(ts, "sdk-cli", "cli"), true);
  assert.equal(ts.lastEntrypoint, "sdk-cli");
  assert.equal(ts.entrypointMismatches, 1);
  // A second drift increments again (counter accumulates across turns).
  assert.equal(recordTuiEntrypoint(ts, "sdk-cli", "cli"), true);
  assert.equal(ts.entrypointMismatches, 2);
});

test("recordTuiEntrypoint: null observation → lastEntrypoint null, counts as mismatch when expected cli", () => {
  const ts = { lastEntrypoint: "cli", entrypointMismatches: 0 };
  assert.equal(recordTuiEntrypoint(ts, null, "cli"), true);
  assert.equal(ts.lastEntrypoint, null);
  assert.equal(ts.entrypointMismatches, 1);
});

test("recordTuiEntrypoint: non-cli expected mode (auto) never counts a mismatch", () => {
  const ts = { lastEntrypoint: null, entrypointMismatches: 0 };
  assert.equal(recordTuiEntrypoint(ts, "sdk-cli", "auto"), false);
  assert.equal(ts.lastEntrypoint, "sdk-cli");
  assert.equal(ts.entrypointMismatches, 0);
});

test("buildTuiHealthBlock: shape + live counters (the additive /health tui block)", () => {
  const sem = new TuiSemaphore(2);
  const ts = { lastEntrypoint: "cli", entrypointMismatches: 3 };
  const block = buildTuiHealthBlock(
    { enabled: true, entrypointMode: "cli", maxConcurrent: 2 }, ts, sem);
  // Shape is ADDITIVE-only: the seven original keys must all still be present (existing
  // /health consumers are grandfathered, ADR 0006), plus `pool` (warm pane pool) and the
  // stream* fields (backlog #2). Asserting CONTAINMENT plus an exact added-set — rather than
  // one flat deepEqual — is what makes "additive" itself the thing under test: a future field
  // that silently REPLACED an original key would pass a flat equality check that was updated
  // alongside it, but cannot pass this one.
  const ORIGINAL_KEYS = ["enabled", "entrypointMismatches", "entrypointMode", "inflight", "lastEntrypoint", "maxConcurrent", "queued"];
  const keys = Object.keys(block);
  for (const k of ORIGINAL_KEYS) assert.ok(keys.includes(k), `original /health key must survive: ${k}`);
  assert.deepEqual(keys.filter((k) => !ORIGINAL_KEYS.includes(k)).sort(),
    ["pool", "streamDeltas", "streamDivergences", "streamEnabled", "streamTopUps", "streamTurns", "streamZeroDeltaTurns"],
    "only the documented pool + streaming fields may be added");
  assert.equal(block.pool, null, "no pool passed → null (the default, pool disabled)");
  assert.equal(block.enabled, true);
  assert.equal(block.entrypointMode, "cli");
  assert.equal(block.lastEntrypoint, "cli");
  assert.equal(block.entrypointMismatches, 3);
  assert.equal(block.inflight, 0);
  assert.equal(block.queued, 0);
  assert.equal(block.maxConcurrent, 2);
});

test("buildTuiHealthBlock: TUI off → enabled:false but block still present (stable shape)", () => {
  const sem = new TuiSemaphore(2);
  const ts = { lastEntrypoint: null, entrypointMismatches: 0 };
  const block = buildTuiHealthBlock(
    { enabled: false, entrypointMode: "cli", maxConcurrent: 2 }, ts, sem);
  assert.equal(block.enabled, false);
  assert.equal(block.lastEntrypoint, null);
  assert.equal(block.entrypointMismatches, 0);
});

await asyncTest("buildTuiHealthBlock reflects live inflight/queued while turns are in flight", async () => {
  const sem = new TuiSemaphore(1);
  const ts = { lastEntrypoint: null, entrypointMismatches: 0 };
  const g1 = deferred();
  const t1 = sem.run(async () => { await g1.p; });
  const t2 = sem.run(async () => {}); // queued behind t1
  await new Promise((r) => setImmediate(r));
  const block = buildTuiHealthBlock({ enabled: true, entrypointMode: "cli", maxConcurrent: 1 }, ts, sem);
  assert.equal(block.inflight, 1, "one turn in flight");
  assert.equal(block.queued, 1, "one turn queued");
  g1.resolve();
  await t1; await t2;
});

// ── TUI session driver: runTuiTurn (live-only, guarded) ──────────────────
console.log("\nTUI session driver:");

if (process.env.OCP_TUI_LIVE === "1") {
  await asyncTest("runTuiTurn drives a real interactive turn and returns text", async () => {
    const { runTuiTurn } = await import("./lib/tui/session.mjs");
    const out = await runTuiTurn({
      prompt: "Reply with exactly the word PONG and nothing else.",
      model: "claude-haiku-4-5-20251001",
      claudeBin: process.env.OCP_TUI_CLAUDE_BIN || "claude",
      home: process.env.HOME,
      cwd: `${process.env.HOME}/.ocp-tui/work`,
      wallclockMs: 120000,
    });
    assert.ok(/PONG/i.test(out.text), `expected PONG, got: ${out.text.slice(0, 200)}`);
  });
} else {
  test("runTuiTurn (live) — SKIPPED (set OCP_TUI_LIVE=1 on PI231 to run)", () => {
    assert.ok(true);
  });
}

// ── TUI readiness / paste-verify predicates (issue #130) ────────────────────
// Replicates tuiInputReady, tuiPromptLanded verbatim from lib/tui/session.mjs.
// Keep in sync with the definitions there.
function _tuiInputReady(pane) {
  return /\? for shortcuts/.test(pane);
}
function _tuiPromptLanded(pane, prompt) {
  const flatPane = pane.replace(/\s+/g, " ");
  if (flatPane.includes("[Pasted text")) return true;
  const firstLine = String(prompt).split("\n").map(s => s.trim()).find(Boolean) || "";
  const needle = firstLine.replace(/\s+/g, " ").slice(0, 24);
  return needle.length >= 2 && flatPane.includes(needle); // C-4 (#133): 3 → 2 (see lib/tui/session.mjs)
}

// Real captured pane samples (empirically confirmed via live capture-pane on PI231,
// claude v2.1.114 and v2.1.159). Source: issue #130 spec.
const TUI_READY_PANE = `❯ Try "how does <filepath> work?"
  ? for shortcuts · ← for agents`;

const TUI_LANDED_PANE = `❯ Reply with exactly: PONG_TEST
  ? for shortcuts · ← for agents`;

// Welcome splash shown before input bar is rendered — no `? for shortcuts`.
const TUI_BOOT_PANE = `╭─ Claude Code v2.1.114 ─ Welcome back Tao! ─╮\n│ Tips for getting started │`;

console.log("\nTUI readiness + paste-verify predicates (issue #130):");

test("tuiInputReady(READY_PANE) === true  (input bar rendered)", () => {
  assert.equal(_tuiInputReady(TUI_READY_PANE), true);
});
test("tuiInputReady(LANDED_PANE) === true  (input bar still present after paste)", () => {
  assert.equal(_tuiInputReady(TUI_LANDED_PANE), true);
});
test("tuiInputReady(BOOT_PANE) === false  (welcome splash, no input bar yet)", () => {
  assert.equal(_tuiInputReady(TUI_BOOT_PANE), false);
});

test("tuiPromptLanded(READY_PANE, 'Reply with exactly: PONG_TEST') === false  (still placeholder)", () => {
  assert.equal(_tuiPromptLanded(TUI_READY_PANE, "Reply with exactly: PONG_TEST"), false);
});
test("tuiPromptLanded(LANDED_PANE, 'Reply with exactly: PONG_TEST') === true  (prompt prefix visible)", () => {
  assert.equal(_tuiPromptLanded(TUI_LANDED_PANE, "Reply with exactly: PONG_TEST"), true);
});
test("tuiPromptLanded(READY_PANE, 'ping') === false  (prompt text absent from placeholder pane)", () => {
  assert.equal(_tuiPromptLanded(TUI_READY_PANE, "ping"), false);
});
test("tuiPromptLanded('❯ ping\\n  ? for shortcuts', 'ping') === true  (needle present, no placeholder)", () => {
  assert.equal(_tuiPromptLanded("❯ ping\n  ? for shortcuts", "ping"), true);
});
// C-4 (#133): short prompts (1–2 char first line) MUST be able to land. Threshold
// lowered 3 → 2. A 2-char prompt ("hi") present in the pane now lands instead of
// 5s-failing with tui_paste_not_landed every time (live-reproduced: "hi").
test("tuiPromptLanded('❯ hi\\n  ? for shortcuts', 'hi') === true  (2-char prompt lands — C-4)", () => {
  assert.equal(_tuiPromptLanded("❯ hi\n  ? for shortcuts", "hi"), true);
});
// False-positive guard for the lowered threshold: a 2-char needle ABSENT from the
// still-empty placeholder pane must NOT land (no spurious Enter into an empty box).
test("tuiPromptLanded(READY_PANE, 'hi') === false  (2-char prompt not yet visible — no false positive)", () => {
  assert.equal(_tuiPromptLanded(TUI_READY_PANE, "hi"), false);
});
// issue #130 root cause: a big bracketed paste shows "[Pasted text #N +M lines]" — must be landed.
test("tuiPromptLanded(bracketed-paste pane, big prompt) === true", () => {
  assert.equal(_tuiPromptLanded("❯ [Pasted text #1 +301 lines]\n  ? for shortcuts", "[System] Context 0."), true);
});
// issue #130 false-positive guard: the EMPTY placeholder uses a CURLY quote (“) and randomized
// example text — the old placeholder-gone heuristic wrongly reported landed=true here, so Enter
// fired into an empty box. Must be FALSE (no positive signal: not [Pasted text], prompt not shown).
test("tuiPromptLanded(curly-quote placeholder, big prompt) === false  (no false-positive)", () => {
  assert.equal(_tuiPromptLanded("❯ Try “how do I log an error?”\n  ? for shortcuts", "[System] Context 0."), false);
});

// ── /health anonymousKey gate (issue #109) ──────────────────────────────────
// MIRRORS the predicate in server.mjs (search ADVERTISE_ANON_KEY) — copied
// verbatim to avoid importing server.mjs (top-level server.listen() would
// start a live HTTP server, per the stream-JSON parser tests convention above).
console.log("\n/health anonymousKey gate (issue #109):");

// Replicate the gating predicate from server.mjs line ~286/1927:
//   ...((isLocalhost || ADVERTISE_ANON_KEY) ? { anonymousKey: ... } : {})
function shouldAdvertiseAnonKey(isLocalhost, advertise) { return isLocalhost || advertise; }

test("(localhost=false, flag=false) → omit key", () => {
  assert.equal(shouldAdvertiseAnonKey(false, false), false);
});
test("(localhost=true, flag=false) → include key (localhost always exempt)", () => {
  assert.equal(shouldAdvertiseAnonKey(true, false), true);
});
test("(localhost=false, flag=true) → include key (opt-in set)", () => {
  assert.equal(shouldAdvertiseAnonKey(false, true), true);
});
test("(localhost=true, flag=true) → include key (both true)", () => {
  assert.equal(shouldAdvertiseAnonKey(true, true), true);
});

// ── contentToText helper tests (issue #110) ──────────────────────────────────
// MIRRORS server.mjs contentToText — copied verbatim to avoid importing server.mjs
// (top-level server.listen() would start a live HTTP server).
// Keep in sync with the definition in server.mjs above messagesToPrompt.
console.log("\ncontentToText helper (issue #110):");

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p =>
      p && p.type === "text" && typeof p.text === "string" ? p.text : "[non-text content omitted]"
    ).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

test("contentToText: string input returned unchanged", () => {
  assert.equal(contentToText("hello"), "hello");
});

test("contentToText: array of text parts concatenated", () => {
  assert.equal(
    contentToText([{ type: "text", text: "hello" }, { type: "text", text: " world" }]),
    "hello world"
  );
});

test("contentToText: non-text part (image_url) replaced with placeholder", () => {
  assert.equal(
    contentToText([{ type: "image_url", image_url: { url: "https://example.com/img.png" } }]),
    "[non-text content omitted]"
  );
});

test("contentToText: empty array returns empty string", () => {
  assert.equal(contentToText([]), "");
});

test("contentToText: null returns empty string", () => {
  assert.equal(contentToText(null), "");
});

// ── multimodal image transform (issue #110) ──────────────────────────────────
// OpenAI image_url parts → Anthropic image blocks for `claude -p --input-format
// stream-json`. lib/multimodal.mjs is a PURE module (no server.listen()), so it is
// imported directly here. Class B.1: shape per OpenAI vision spec, authorized by
// ADR 0006. Mechanism verified live: a base64 PNG fed as an Anthropic image block
// via --input-format stream-json is correctly described by the model.
import {
  hasImageContent as mmHasImageContent,
  buildImageBlocks as mmBuildImageBlocks,
  buildStreamJsonInput as mmBuildStreamJsonInput,
  MultimodalError as MmError,
  SUPPORTED_IMAGE_TYPES as MM_SUPPORTED,
} from "./lib/multimodal.mjs";
import { parsePositiveInt } from "./lib/env.mjs";

console.log("\nmultimodal image transform (issue #110):");

// A short, valid base64 string (charset-valid; not decoded by the transform).
const MM_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAG7buVgAAAABJRU5ErkJggg==";
const dataUri = (mt = "image/png") => `data:${mt};base64,${MM_B64}`;
const imgPart = (mt) => ({ type: "image_url", image_url: { url: dataUri(mt) } });
const txtPart = (t) => ({ type: "text", text: t });

test("hasImageContent: plain string message → false (text path preserved)", () => {
  assert.equal(mmHasImageContent([{ role: "user", content: "hello" }]), false);
});

test("hasImageContent: array of text-only parts → false", () => {
  assert.equal(mmHasImageContent([{ role: "user", content: [txtPart("a"), txtPart("b")] }]), false);
});

test("hasImageContent: message with an image_url part → true", () => {
  assert.equal(mmHasImageContent([{ role: "user", content: [txtPart("q"), imgPart()] }]), true);
});

test("hasImageContent: image anywhere in history (not just last) → true", () => {
  const msgs = [
    { role: "user", content: [txtPart("look"), imgPart()] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "and now?" },
  ];
  assert.equal(mmHasImageContent(msgs), true);
});

// ── PR #154 review round 2, gap (b): image ONLY in a system message must not silently drop ──
// The handler detects multimodal on the FULL list but extraction/spawn filter system messages out.
// The guard fires exactly when the full list has an image but the non-system list does not — proven
// here against the same predicate the guard uses, so a system-only image is rejected (400) rather
// than falling to the text path and returning a 200 hallucinated answer.
test("hasImageContent: image ONLY in a system message → true on full list, false after system filter (guard fires)", () => {
  const msgs = [
    { role: "system", content: [txtPart("context"), imgPart()] },
    { role: "user", content: "describe it" },
  ];
  assert.equal(mmHasImageContent(msgs), true, "detected as multimodal on the full list");
  assert.equal(mmHasImageContent(msgs.filter(m => m.role !== "system")), false, "no image survives the system filter → guard must 400");
});
test("hasImageContent: image in a USER message survives the system filter (legitimate request not rejected)", () => {
  const msgs = [
    { role: "system", content: "you are helpful" },
    { role: "user", content: [txtPart("describe it"), imgPart()] },
  ];
  assert.equal(mmHasImageContent(msgs.filter(m => m.role !== "system")), true, "user image survives → normal multimodal path");
});

test("buildImageBlocks: data-URI parsed into an Anthropic base64 image block", () => {
  const { blocks, stats } = mmBuildImageBlocks([{ role: "user", content: [txtPart("what is this?"), imgPart("image/png")] }]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "text");
  assert.equal(blocks[0].text, "what is this?");
  assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: MM_B64 } });
  assert.equal(stats.imageCount, 1);
  assert.ok(stats.totalImageBytes > 0);
});

test("buildImageBlocks: media_type carried through (jpeg/gif/webp)", () => {
  for (const mt of ["image/jpeg", "image/gif", "image/webp"]) {
    const { blocks } = mmBuildImageBlocks([{ role: "user", content: [imgPart(mt)] }]);
    assert.equal(blocks.find(b => b.type === "image").source.media_type, mt);
  }
});

test("buildImageBlocks: multiple images in one message both emitted", () => {
  const { blocks, stats } = mmBuildImageBlocks([{ role: "user", content: [txtPart("compare"), imgPart(), imgPart()] }]);
  const imgs = blocks.filter(b => b.type === "image");
  assert.equal(imgs.length, 2);
  assert.equal(stats.imageCount, 2);
});

test("buildImageBlocks: text/image/text ordering preserved", () => {
  const { blocks } = mmBuildImageBlocks([{ role: "user", content: [txtPart("A"), imgPart(), txtPart("B")] }]);
  assert.deepEqual(blocks.map(b => (b.type === "text" ? b.text : "IMG")), ["A", "IMG", "B"]);
});

test("buildImageBlocks: image-first message keeps ordering (image before text)", () => {
  const { blocks } = mmBuildImageBlocks([{ role: "user", content: [imgPart(), txtPart("caption")] }]);
  assert.deepEqual(blocks.map(b => (b.type === "text" ? b.text : "IMG")), ["IMG", "caption"]);
});

test("buildImageBlocks: multi-turn history — role prefixes + separators preserved", () => {
  const msgs = [
    { role: "user", content: "first q" },
    { role: "assistant", content: "prior answer" },
    { role: "user", content: [txtPart("now this"), imgPart()] },
  ];
  const { blocks } = mmBuildImageBlocks(msgs);
  assert.equal(blocks[0].text, "first q");
  assert.equal(blocks[1].text, "\n\n[Assistant] prior answer");
  assert.equal(blocks[2].text, "\n\nnow this");
  assert.equal(blocks[3].type, "image");
});

test("buildImageBlocks: image in an EARLIER turn is carried (history image)", () => {
  const msgs = [
    { role: "user", content: [txtPart("here"), imgPart()] },
    { role: "assistant", content: "got it" },
    { role: "user", content: "thanks" },
  ];
  const { blocks, stats } = mmBuildImageBlocks(msgs);
  assert.equal(stats.imageCount, 1);
  assert.equal(blocks.filter(b => b.type === "image").length, 1);
});

test("buildImageBlocks: image_url as bare string is accepted (client leniency)", () => {
  const { blocks } = mmBuildImageBlocks([{ role: "user", content: [{ type: "image_url", image_url: dataUri() }] }]);
  assert.equal(blocks.find(b => b.type === "image").source.data, MM_B64);
});

test("buildStreamJsonInput: emits one newline-terminated user envelope", () => {
  const { payload } = mmBuildStreamJsonInput([{ role: "user", content: [txtPart("hi"), imgPart()] }]);
  assert.ok(payload.endsWith("\n"));
  const env = JSON.parse(payload.trim());
  assert.equal(env.type, "user");
  assert.equal(env.message.role, "user");
  assert.equal(env.message.content[1].type, "image");
});

// ── malformed / policy / oversized handling (clean 4xx, never a silent drop) ──
test("buildImageBlocks: unsupported media type → 400 unsupported_image_type", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [imgPart("image/tiff")] }]),
    (e) => e instanceof MmError && e.code === "unsupported_image_type" && e.status === 400
  );
});

test("buildImageBlocks: non-base64 data URI → 400 invalid_data_uri", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png,notbase64" } }] }]),
    (e) => e instanceof MmError && e.code === "invalid_data_uri" && e.status === 400
  );
});

test("buildImageBlocks: malformed data URI (no comma) → 400 invalid_data_uri", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64" } }] }]),
    (e) => e instanceof MmError && e.code === "invalid_data_uri"
  );
});

test("buildImageBlocks: image_url part missing a URL → 400 invalid_image_url", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [{ type: "image_url", image_url: {} }] }]),
    (e) => e instanceof MmError && e.code === "invalid_image_url"
  );
});

test("buildImageBlocks: oversized single image → 413 image_too_large", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [imgPart()] }], { maxImageBytes: 4 }),
    (e) => e instanceof MmError && e.code === "image_too_large" && e.status === 413
  );
});

test("buildImageBlocks: too many images → 413 too_many_images", () => {
  const many = Array.from({ length: 3 }, () => imgPart());
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: many }], { maxImages: 2 }),
    (e) => e instanceof MmError && e.code === "too_many_images" && e.status === 413
  );
});

test("buildImageBlocks: aggregate image bytes over cap → 413 images_too_large", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [imgPart(), imgPart()] }], { maxTotalImageBytes: 100, maxImageBytes: 1000 }),
    (e) => e instanceof MmError && e.code === "images_too_large" && e.status === 413
  );
});

test("buildImageBlocks: remote http(s) URL disabled by default → 400 remote_url_disabled", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }]),
    (e) => e instanceof MmError && e.code === "remote_url_disabled" && e.status === 400
  );
});

test("buildImageBlocks: remote URL passthrough when allowRemoteUrl=true (url source, OCP does not fetch)", () => {
  const { blocks } = mmBuildImageBlocks(
    [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
    { allowRemoteUrl: true }
  );
  assert.deepEqual(blocks.find(b => b.type === "image").source, { type: "url", url: "https://example.com/a.png" });
});

test("buildImageBlocks: unsupported URL scheme → 400 unsupported_url_scheme", () => {
  assert.throws(
    () => mmBuildImageBlocks([{ role: "user", content: [{ type: "image_url", image_url: { url: "ftp://x/y.png" } }] }], { allowRemoteUrl: true }),
    (e) => e instanceof MmError && e.code === "unsupported_url_scheme"
  );
});

test("buildImageBlocks: non-image parts (audio/file) fall back to placeholder text", () => {
  const { blocks } = mmBuildImageBlocks([{ role: "user", content: [txtPart("hear this"), { type: "input_audio", input_audio: {} }] }]);
  assert.deepEqual(blocks.map(b => b.text), ["hear this", "[non-text content omitted]"]);
});

test("SUPPORTED_IMAGE_TYPES: exactly the four Anthropic vision types", () => {
  assert.deepEqual([...MM_SUPPORTED].sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
});

test("buildImageBlocks: pure-text conversation still yields text blocks (untouched-path parity)", () => {
  // hasImageContent would be false for this input in server.mjs (text path taken),
  // but the transform must still be well-defined for a text-only turn.
  const { blocks, stats } = mmBuildImageBlocks([{ role: "user", content: "just text" }]);
  assert.deepEqual(blocks, [{ type: "text", text: "just text" }]);
  assert.equal(stats.imageCount, 0);
  assert.equal(stats.truncated, false);
});

// ── F2 (PR #154 review): text char budget is enforced on the multimodal path ──
// Regression guard: without maxTextChars, attaching one tiny image let unbounded
// text bypass MAX_PROMPT_CHARS entirely (the text path truncates; the image path
// did not). server.mjs passes maxTextChars: MAX_PROMPT_CHARS into this transform.
console.log("\nmultimodal text-budget enforcement (PR #154 F2):");

test("buildImageBlocks: text under budget → not truncated, blocks unchanged", () => {
  const { blocks, stats } = mmBuildImageBlocks(
    [{ role: "user", content: [txtPart("short"), imgPart()] }],
    { maxTextChars: 1000 }
  );
  assert.equal(stats.truncated, false);
  assert.equal(stats.textChars, "short".length);
  assert.equal(blocks.filter(b => b.type === "image").length, 1);
});

test("buildImageBlocks: text over budget → truncated, keeps most-recent tail + note", () => {
  const big = "A".repeat(300) + "TAIL_MARKER";
  const { blocks, stats } = mmBuildImageBlocks(
    [{ role: "user", content: [txtPart(big)] }],
    { maxTextChars: 50 }
  );
  assert.equal(stats.truncated, true);
  assert.equal(stats.originalTextChars, big.length);
  // The most recent characters (the tail) survive; the oldest 'A's are dropped.
  const joined = blocks.filter(b => b.type === "text").map(b => b.text).join("");
  assert.ok(joined.includes("TAIL_MARKER"), "tail text must be kept");
  assert.ok(joined.includes("truncated to fit"), "a truncation note must be present");
  assert.ok(stats.originalTextChars > stats.textChars, "post-truncation text is smaller");
});

test("buildImageBlocks: F2 exact scenario — 500k chars + one image → text bounded, image preserved", () => {
  const { blocks, stats } = mmBuildImageBlocks(
    [{ role: "user", content: [txtPart("Z".repeat(500000)), imgPart()] }],
    { maxTextChars: 150000 }
  );
  assert.equal(stats.truncated, true);
  assert.ok(stats.textChars <= 150000 + 200, "text char count is bounded by the budget (+note)");
  // The image bypasses the text budget and is NOT dropped by truncation.
  assert.equal(blocks.filter(b => b.type === "image").length, 1);
});

test("buildImageBlocks: default (no maxTextChars) never truncates — pure module standalone", () => {
  const { stats } = mmBuildImageBlocks([{ role: "user", content: [txtPart("x".repeat(10000))] }]);
  assert.equal(stats.truncated, false);
  assert.equal(stats.textChars, 10000);
});

// ── F3 (PR #154 review): fail-closed positive-int env parsing ────────────────
// A misconfigured numeric cap must NEVER silently disable a guard (`x > NaN` is
// always false) or brick the proxy with a nonsense value. parsePositiveInt keeps
// the default and reports ok:false so the caller can warn.
console.log("\nfail-closed env-cap parsing (PR #154 F3):");

test("parsePositiveInt: missing/empty → default, ok", () => {
  assert.deepEqual(parsePositiveInt(undefined, 42), { value: 42, ok: true });
  assert.deepEqual(parsePositiveInt("", 42), { value: 42, ok: true });
});

test("parsePositiveInt: valid positive integer → parsed value", () => {
  assert.equal(parsePositiveInt("5000000", 42).value, 5000000);
  assert.equal(parsePositiveInt("5000000", 42).ok, true);
});

test("parsePositiveInt: 'unlimited' → NaN rejected, default kept (would drop the cap)", () => {
  const r = parsePositiveInt("unlimited", 5 * 1024 * 1024);
  assert.equal(r.value, 5 * 1024 * 1024);
  assert.equal(r.ok, false);
});

test("parsePositiveInt: '5MB' → unit suffix rejected (naive parseInt would give 5 bytes)", () => {
  const r = parsePositiveInt("5MB", 5 * 1024 * 1024);
  assert.equal(r.value, 5 * 1024 * 1024);
  assert.equal(r.ok, false);
});

test("parsePositiveInt: '0' and '-1' → non-positive rejected", () => {
  assert.equal(parsePositiveInt("0", 20).ok, false);
  assert.equal(parsePositiveInt("0", 20).value, 20);
  assert.equal(parsePositiveInt("-1", 20).ok, false);
});

test("parsePositiveInt: '20.5' → fractional/ambiguous rejected", () => {
  assert.equal(parsePositiveInt("20.5", 20).ok, false);
});

test("parsePositiveInt: surrounding whitespace tolerated", () => {
  assert.deepEqual(parsePositiveInt("  20  ", 5), { value: 20, ok: true });
});

// ── PR #154 review round 2, gap (a): MAX_PROMPT_CHARS must fail closed like the other caps ──
// server.mjs now derives MAX_PROMPT_CHARS via parseIntEnv → parsePositiveInt (was a raw parseInt).
// CLAUDE_MAX_PROMPT_CHARS=unlimited previously → NaN → enforceTextBudget's `!(NaN > 0)` early-return
// → 500k chars passed unbounded, defeating F2's text-budget guarantee. The default must be kept.
test("parsePositiveInt: CLAUDE_MAX_PROMPT_CHARS='unlimited' → default kept, cap not lost to NaN (gap a)", () => {
  const r = parsePositiveInt("unlimited", 150000);
  assert.equal(r.ok, false);
  assert.equal(r.value, 150000, "the 150k text budget must survive a bad config, not become NaN");
});
test("parsePositiveInt: CLAUDE_MAX_PROMPT_CHARS valid override honored", () => {
  assert.deepEqual(parsePositiveInt("200000", 150000), { value: 200000, ok: true });
});

// ── messages guard predicate truth-table (issue #110) ────────────────────────
// Mirrors the guard at server.mjs line ~1650: Array.isArray(x) && x.length > 0
console.log("\nmessages guard predicate (issue #110):");

function isValidMessages(x) { return Array.isArray(x) && x.length > 0; }

test("messages guard: string 'x' → invalid (non-array)", () => {
  assert.equal(isValidMessages("x"), false);
});

test("messages guard: empty array [] → invalid", () => {
  assert.equal(isValidMessages([]), false);
});

test("messages guard: [{role:'user',content:'hi'}] → valid", () => {
  assert.equal(isValidMessages([{ role: "user", content: "hi" }]), true);
});

// ── sanitizeError helper (issue #111) ────────────────────────────────────
// Replicated verbatim from server.mjs (cannot import server.mjs).
// The SIGKILL-escalation and timer changes are process-lifecycle and are not
// unit-testable here (no live-server harness).
console.log("\nsanitizeError (issue #111):");

function sanitizeError(msg) {
  return String(msg || "Internal error").replace(/\/[\w/.\-]+/g, "[path]");
}

test("sanitizeError: strips home-dir path from message", () => {
  const result = sanitizeError("failed at /Users/foo/.claude/creds.json");
  assert.ok(result.includes("[path]"), `expected [path] in: ${result}`);
  assert.ok(!result.includes("/Users/foo"), `expected /Users/foo stripped, got: ${result}`);
});

test("sanitizeError: null input returns 'Internal error'", () => {
  assert.equal(sanitizeError(null), "Internal error");
});

test("sanitizeError: message with no path passes through unchanged", () => {
  assert.equal(sanitizeError("no path here"), "no path here");
});

test("sanitizeError: multiple paths all stripped", () => {
  const result = sanitizeError("err /a/b and /c/d");
  assert.ok(!result.includes("/a/b"), `expected /a/b stripped, got: ${result}`);
  assert.ok(!result.includes("/c/d"), `expected /c/d stripped, got: ${result}`);
  assert.ok(result.includes("[path]"), `expected [path] in: ${result}`);
});

// ── models.json SPOT wiring (issue #112) ────────────────────────────────────
// Asserts that the alias values used by server.mjs (usage probe + default model)
// match the expected IDs. A future alias rename that silently breaks these
// code paths is caught here.
import { readFileSync as spotReadFileSync } from "node:fs";
import { fileURLToPath as spotFileURLToPath } from "node:url";
import { dirname as spotDirname, join as spotJoin } from "node:path";

console.log("\nmodels.json SPOT aliases (issue #112):");

const _spotDir = spotDirname(spotFileURLToPath(import.meta.url));
const _spotModels = JSON.parse(spotReadFileSync(spotJoin(_spotDir, "models.json"), "utf8"));

test("models.json aliases.haiku === 'claude-haiku-4-5-20251001' (usage-probe SPOT)", () => {
  assert.equal(_spotModels.aliases.haiku, "claude-haiku-4-5-20251001");
});

test("models.json aliases.sonnet === 'claude-sonnet-5' (default-request-model SPOT)", () => {
  assert.equal(_spotModels.aliases.sonnet, "claude-sonnet-5");
});

// ── Referential integrity (PR #152 review) ──────────────────────────────────
// The value-mirror assertions above only prove the alias equals a string literal —
// they pass even if that literal points at a model that does not exist in
// models[]. A one-line slip (edit an alias, forget the models[] entry) would leave
// /v1/models missing the model while every `model: "<alias>"` request passes
// validation and then fails at CLI spawn. VALID_MODELS keys on alias *names*, so
// nothing else checks alias *targets*. This is the guard with teeth.
const _spotModelIds = new Set(_spotModels.models.map(m => m.id));

test("models.json: claude-sonnet-5 is present in models[] (the entry this PR adds)", () => {
  assert.ok(_spotModelIds.has("claude-sonnet-5"), "claude-sonnet-5 must exist as a models[].id");
});

test("models.json: every aliases value resolves to a real models[].id (referential integrity)", () => {
  for (const [name, target] of Object.entries(_spotModels.aliases)) {
    assert.ok(_spotModelIds.has(target), `aliases.${name} -> '${target}' is a dangling alias (no matching models[].id)`);
  }
});

test("models.json: every legacyAliases value resolves to a real models[].id (referential integrity)", () => {
  for (const [name, target] of Object.entries(_spotModels.legacyAliases || {})) {
    assert.ok(_spotModelIds.has(target), `legacyAliases.${name} -> '${target}' is a dangling alias (no matching models[].id)`);
  }
});

// ── escapeHtml + key-name validator (issue #114) ────────────────────────────
// Replicated verbatim from dashboard.html so tests run without a browser.
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const KEY_NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

console.log("\nescapeHtml (issue #114):");

test("escapeHtml: XSS payload → &lt;img not <img", () => {
  const out = escapeHtml('<img src=x onerror=alert(1)>');
  assert.ok(out.includes("&lt;img"), `expected &lt;img in: ${out}`);
  assert.ok(!out.includes("<img"), `expected no raw <img in: ${out}`);
});

test("escapeHtml: single-quote, double-quote, ampersand all escaped", () => {
  assert.equal(escapeHtml("a'b\"c&d"), "a&#39;b&quot;c&amp;d");
});

test("escapeHtml: null → empty string", () => {
  assert.equal(escapeHtml(null), "");
});

console.log("\nKey-name validator (issue #114):");

test("KEY_NAME_RE: 'wife-laptop' → valid", () => {
  assert.ok(KEY_NAME_RE.test("wife-laptop"));
});

test("KEY_NAME_RE: 'key-1700000000000' → valid", () => {
  assert.ok(KEY_NAME_RE.test("key-1700000000000"));
});

test("KEY_NAME_RE: '<script>' → invalid", () => {
  assert.ok(!KEY_NAME_RE.test("<script>"));
});

test("KEY_NAME_RE: \"a'); DROP\" → invalid", () => {
  assert.ok(!KEY_NAME_RE.test("a'); DROP"));
});

test("KEY_NAME_RE: empty string → invalid", () => {
  assert.ok(!KEY_NAME_RE.test(""));
});

test("KEY_NAME_RE: 65-char string → invalid", () => {
  assert.ok(!KEY_NAME_RE.test("x".repeat(65)));
});

// ── isLoopbackBind helper (issue #115, extracted to lib/net.mjs via #125) ──────
// Tests the imported lib/net.mjs helper — the real shared definition used by server.mjs.
console.log("\nisLoopbackBind helper (issue #115):");

test("isLoopbackBind: '127.0.0.1' → true", () => {
  assert.equal(isLoopbackBind("127.0.0.1"), true);
});
test("isLoopbackBind: '::1' → true", () => {
  assert.equal(isLoopbackBind("::1"), true);
});
test("isLoopbackBind: 'localhost' → true", () => {
  assert.equal(isLoopbackBind("localhost"), true);
});
test("isLoopbackBind: '127.0.0.5' → true (127.x.x.x range)", () => {
  assert.equal(isLoopbackBind("127.0.0.5"), true);
});
test("isLoopbackBind: '0.0.0.0' → false (any-interface)", () => {
  assert.equal(isLoopbackBind("0.0.0.0"), false);
});
test("isLoopbackBind: '192.168.1.5' → false (LAN IP)", () => {
  assert.equal(isLoopbackBind("192.168.1.5"), false);
});
test("isLoopbackBind: '::' → false (IPv6 any-interface)", () => {
  assert.equal(isLoopbackBind("::"), false);
});
test("isLoopbackBind: '100.64.0.1' → false (Tailscale IP)", () => {
  assert.equal(isLoopbackBind("100.64.0.1"), false);
});

// ── Spawn-auth primitives (F3 / F5 / F6, lib/spawn-auth.mjs) ──
// Pure, dependency-injected primitives extracted from server.mjs so the spawn-token concurrency /
// caching / expiry logic is testable without booting the server or mocking execFileSync/spawn.
console.log("\nSpawn-auth (F3 mutex / F5 TTL cache + label memo / F6 expiry gate):");

// F5: expiry gate — the load-bearing invariant that lets a short-TTL keychain cache stay safe.
test("isTokenExpiring: creds within 5-min buffer → true", () => {
  assert.equal(isTokenExpiring({ expiresAt: 1000 }, 1000 - 300000, 300000), true); // exactly at buffer edge
  assert.equal(isTokenExpiring({ expiresAt: 1000 }, 900, 300000), true);           // past the edge
});
test("isTokenExpiring: creds well beyond buffer → false", () => {
  assert.equal(isTokenExpiring({ expiresAt: 10_000_000 }, 0, 300000), false);
});
test("isTokenExpiring: no expiresAt (long-lived env token) → never expiring", () => {
  assert.equal(isTokenExpiring({ accessToken: "x" }, Date.now(), 300000), false);
  assert.equal(isTokenExpiring(null, Date.now(), 300000), false);
});

// F5: last-good label ordering — one exec instead of two on the steady-state keychain path.
test("orderLabelsLastGoodFirst: last-good label is tried first", () => {
  const labels = ["A", "B"];
  assert.deepEqual(orderLabelsLastGoodFirst(labels, "B"), ["B", "A"]);
});
test("orderLabelsLastGoodFirst: null/unknown last-good → original order, fresh array", () => {
  const labels = ["A", "B"];
  assert.deepEqual(orderLabelsLastGoodFirst(labels, null), ["A", "B"]);
  assert.deepEqual(orderLabelsLastGoodFirst(labels, "Z"), ["A", "B"]);
  assert.notEqual(orderLabelsLastGoodFirst(labels, null), labels); // does not mutate/alias input
});

// F5: TTL cache — bounds how often we RE-READ the keychain (not how often we re-decide expiry).
test("createTtlCache: serves cached value within TTL, re-produces after TTL", () => {
  const cache = createTtlCache({ ttlMs: 30000 });
  let calls = 0;
  const produce = () => { calls++; return `v${calls}`; };
  assert.equal(cache.get(produce, 0), "v1");
  assert.equal(cache.get(produce, 10000), "v1"); // within TTL → cached, producer NOT called
  assert.equal(calls, 1);
  assert.equal(cache.get(produce, 40000), "v2"); // past TTL → re-produced
  assert.equal(calls, 2);
});
test("createTtlCache: caches a null miss (absent source not re-probed within TTL)", () => {
  const cache = createTtlCache({ ttlMs: 30000 });
  let calls = 0;
  const produce = () => { calls++; return null; };
  assert.equal(cache.get(produce, 0), null);
  assert.equal(cache.get(produce, 5000), null);
  assert.equal(calls, 1); // the null was cached, not re-probed
});

// F5 core safety property: a short-TTL cache CANNOT reintroduce the #146 forever-stale bug because
// the expiry gate is applied to the CACHED creds on every use. The cache keeps returning the same
// creds object, but isTokenExpiring flips to true the moment the clock crosses the expiry buffer.
test("TTL cache respects expiry gate: cached creds still rejected once clock passes expiry", () => {
  const cache = createTtlCache({ ttlMs: 30000 });
  const creds = { accessToken: "tok", expiresAt: 1_000_000 };
  // t=980_000: cached AND not yet within the 5-min (300_000) buffer → usable.
  const c1 = cache.get(() => creds, 980_000 - 300_000 - 1);
  assert.equal(isTokenExpiring(c1, 980_000 - 300_000 - 1, 300000), false);
  // t=800_000 later: SAME cached object returned (within TTL of the second read window), but now
  // within the expiry buffer → gate rejects it → caller falls back to real HOME. No forever-stale.
  const c2 = cache.get(() => creds, 990_000);
  assert.equal(c2, c1, "cache returns the same creds object");
  assert.equal(isTokenExpiring(c2, 990_000, 300000), true, "expiry gate still fires on cached creds");
});

// ── Async: F3 real-HOME fallback serialization mutex ──
async function runAsyncTests() {
  await testAsync("createSerialMutex: second waiter blocks until first holder releases", async () => {
    const mutex = createSerialMutex();
    const order = [];
    const rel1 = await mutex.acquire();
    order.push("h1-enter");
    let secondEntered = false;
    const p2 = mutex.acquire().then((rel2) => { secondEntered = true; order.push("h2-enter"); return rel2; });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(secondEntered, false, "second waiter must NOT enter while first holds the mutex");
    order.push("h1-release");
    rel1();
    const rel2 = await p2;
    assert.equal(secondEntered, true, "second waiter enters only after release");
    rel2();
    assert.deepEqual(order, ["h1-enter", "h1-release", "h2-enter"]);
  });

  await testAsync("createSerialMutex: N acquires run strictly in FIFO order, never overlapping", async () => {
    const mutex = createSerialMutex();
    const events = [];
    let active = 0;
    async function critical(id) {
      const rel = await mutex.acquire();
      active++;
      assert.equal(active, 1, `only one holder at a time (id=${id})`);
      events.push(`start${id}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end${id}`);
      active--;
      rel();
    }
    await Promise.all([critical(1), critical(2), critical(3)]);
    assert.deepEqual(events, ["start1", "end1", "start2", "end2", "start3", "end3"]);
  });

  await testAsync("createSerialMutex: release() is idempotent (double-release does not double-admit)", async () => {
    const mutex = createSerialMutex();
    const rel1 = await mutex.acquire();
    rel1();
    rel1(); // second call must be a no-op
    const rel2 = await mutex.acquire(); // should acquire cleanly, exactly once
    let thirdEntered = false;
    const p3 = mutex.acquire().then((r) => { thirdEntered = true; return r; });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thirdEntered, false, "double-release must not have leaked an extra admit slot");
    rel2();
    (await p3)();
  });
}

// ── TUI real streaming: MessageDisplay hook sink (backlog #2) ───────────────
// Pure-logic coverage for lib/tui/stream.mjs: sink parsing, the concat===T assertion,
// prefix-stability, the auth-banner holdback, message scoping, and the error paths.
import { TuiDeltaAssembler, parseDeltaChunk, buildStreamSettings, streamFilePath, HOOK_SCRIPT, prepareStreamHook, resolveStreamHoldback, DEFAULT_HOLDBACK_CHARS } from "./lib/tui/stream.mjs";

test("stream: parseDeltaChunk consumes only COMPLETE lines (a torn write stays unread)", () => {
  const p = (i, d, final = false) => JSON.stringify({ hook_event_name: "MessageDisplay", session_id: "s", message_id: "m", index: i, final, delta: d });
  // second payload is mid-write — no trailing newline yet
  const partial = `${p(0, "## A\n\n")}\n${p(1, "body").slice(0, 20)}`;
  const r1 = parseDeltaChunk(partial, 0);
  assert.equal(r1.deltas.length, 1, "only the terminated line is consumed");
  assert.equal(r1.consumed, 1);
  // now it lands complete
  const whole = `${p(0, "## A\n\n")}\n${p(1, "body")}\n`;
  const r2 = parseDeltaChunk(whole, r1.consumed);
  assert.equal(r2.deltas.length, 1, "the once-partial line is picked up exactly once");
  assert.equal(r2.deltas[0].delta, "body");
  assert.equal(r2.consumed, 2);
  // idempotent: nothing new
  assert.equal(parseDeltaChunk(whole, r2.consumed).deltas.length, 0);
});

test("stream: parseDeltaChunk skips blank/garbage lines and foreign hook events", () => {
  const md = JSON.stringify({ hook_event_name: "MessageDisplay", message_id: "m", index: 0, final: true, delta: "ok" });
  const other = JSON.stringify({ hook_event_name: "Stop", message_id: "m", delta: "nope" });
  const text = `\n{not json\n${other}\n${md}\n`;
  const { deltas } = parseDeltaChunk(text, 0);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].delta, "ok");
});

// The live-verified contract (claude 2.1.207): deltas are the raw markdown source and
// concat(deltas) === extractLatestAssistantText(transcript), byte-exactly.
const mdFire = (i, delta, { final = false, mid = "m1" } = {}) =>
  ({ hook_event_name: "MessageDisplay", session_id: "s1", message_id: mid, index: i, final, delta });

test("stream: concat(deltas) === T → exact, no top-up, prefix-stable at every n", () => {
  const chunks = ["## Mutex\n\n", "A **mutual exclusion lock** prevents concurrent access.\n\n", "```javascript\nconst m = new Mutex();\n```"];
  const T = chunks.join("");
  const a = new TuiDeltaAssembler({ holdbackChars: 10 });
  let acc = "";
  chunks.forEach((c, i) => {
    const out = a.push(mdFire(i, c, { final: i === chunks.length - 1 }));
    if (out) acc += out;
    assert.ok(T.startsWith(a.full), `prefix-stable at n=${i}`);
  });
  const rec = a.finalize(T);
  assert.equal(rec.ok, true);
  assert.equal(rec.exact, true, "concat(deltas) === T");
  assert.equal(acc + rec.tail, T, "client's assembled stream === T");
  assert.equal(a.deltas, 3);
});

test("stream: holdback withholds the first chars so the auth-banner gate can still fire", () => {
  const banner = "Please run /login · API Error: 401 Invalid authentication credentials"; // 69 chars, a real one
  const a = new TuiDeltaAssembler(); // default holdback 100
  const out = a.push(mdFire(0, banner, { final: true }));
  assert.equal(out, null, "a banner-length message must NEVER reach the client");
  assert.equal(a.emitted, "", "nothing emitted");
  // and the whole-message detector still classifies it — the gate runs on T, before any flush
  assert.ok(detectTuiUpstreamError(a.full) !== null, "banner still detected at terminal");
});

test("stream: holdback releases once past the detector's reach, and only then", () => {
  const a = new TuiDeltaAssembler({ holdbackChars: 100 });
  assert.equal(a.push(mdFire(0, "x".repeat(80))), null, "80 chars: still held");
  const out = a.push(mdFire(1, "y".repeat(40)));
  assert.equal(out, "x".repeat(80) + "y".repeat(40), "released as one chunk once >100");
  assert.equal(a.push(mdFire(2, "tail")), "tail", "subsequent deltas stream straight through");
});

// ── resolveStreamHoldback: the FLOOR under OCP_TUI_STREAM_HOLDBACK (A1 fix) ────────────
// The C-1 auth-banner guarantee holds only while the holdback >= the default detector's
// 100-char reach. These tests pin that the resolver CLAMPS UP to the floor. They are
// mutation-proof: delete the `parsed < floor` branch and the sub-floor cases below fail
// (a 50 would pass straight through, reopening the leak). The clamped flag drives the boot
// warning in server.mjs, so its truthiness is asserted alongside every value.
test("holdback: a sub-floor value is clamped UP to the floor and flagged", () => {
  assert.deepEqual(resolveStreamHoldback("50"), { value: DEFAULT_HOLDBACK_CHARS, clamped: true });
  assert.deepEqual(resolveStreamHoldback("0"), { value: DEFAULT_HOLDBACK_CHARS, clamped: true });
  assert.deepEqual(resolveStreamHoldback("-5"), { value: DEFAULT_HOLDBACK_CHARS, clamped: true });
  assert.deepEqual(resolveStreamHoldback("99"), { value: DEFAULT_HOLDBACK_CHARS, clamped: true });
});

test("holdback: garbage / NaN falls back to the floor and is flagged (not silently 0)", () => {
  assert.deepEqual(resolveStreamHoldback("unlimited"), { value: DEFAULT_HOLDBACK_CHARS, clamped: true });
  assert.deepEqual(resolveStreamHoldback("5MB"), { value: DEFAULT_HOLDBACK_CHARS, clamped: true });
});

test("holdback: an above-floor value passes through unchanged and is NOT flagged", () => {
  assert.deepEqual(resolveStreamHoldback("200"), { value: 200, clamped: false });
  assert.deepEqual(resolveStreamHoldback("101"), { value: 101, clamped: false });
  assert.deepEqual(resolveStreamHoldback(String(DEFAULT_HOLDBACK_CHARS)), { value: DEFAULT_HOLDBACK_CHARS, clamped: false });
});

test("holdback: an unset env var takes the floor WITHOUT flagging (no spurious boot warning)", () => {
  assert.deepEqual(resolveStreamHoldback(undefined), { value: DEFAULT_HOLDBACK_CHARS, clamped: false });
  assert.deepEqual(resolveStreamHoldback(null), { value: DEFAULT_HOLDBACK_CHARS, clamped: false });
  assert.deepEqual(resolveStreamHoldback(""), { value: DEFAULT_HOLDBACK_CHARS, clamped: false });
  assert.deepEqual(resolveStreamHoldback("   "), { value: DEFAULT_HOLDBACK_CHARS, clamped: false });
});

test("holdback: the floor is a parameter, so a deployment can raise (never lower) it", () => {
  assert.deepEqual(resolveStreamHoldback("150", 200), { value: 200, clamped: true }, "custom floor still clamps up");
  assert.deepEqual(resolveStreamHoldback("300", 200), { value: 300, clamped: false });
});

test("stream: a short answer never passes the holdback and is delivered whole at terminal", () => {
  const T = "The capital of France is Paris.";
  const a = new TuiDeltaAssembler();
  assert.equal(a.push(mdFire(0, T, { final: true })), null);
  const rec = a.finalize(T);
  assert.equal(rec.ok, true);
  assert.equal(rec.exact, true);
  assert.equal(rec.tail, T, "the whole short answer is flushed at terminal (buffered semantics)");
});

test("stream: a DROPPED delta is a safe prefix → top-up from the transcript, exact=false", () => {
  const a = new TuiDeltaAssembler({ holdbackChars: 5 });
  a.push(mdFire(0, "Hello world, this is the first block. "));
  const T = "Hello world, this is the first block. And the tail the hook never delivered.";
  const rec = a.finalize(T);
  assert.equal(rec.ok, true, "prefix → recoverable");
  assert.equal(rec.exact, false, "flagged: concat(deltas) !== T");
  assert.equal(rec.tail, "And the tail the hook never delivered.");
  assert.equal(a.emitted + rec.tail, T, "client still receives exactly T");
});

test("stream: emitted bytes NOT a prefix of T → divergence, refuse the turn", () => {
  const a = new TuiDeltaAssembler({ holdbackChars: 5 });
  a.push(mdFire(0, "Let me go and read that file for you first."));
  const rec = a.finalize("A completely different final answer.");
  assert.equal(rec.ok, false, "must NOT serve text the transcript disagrees with");
  assert.equal(rec.tail, null);
});

// Message scoping: the transcript keeps only the LAST assistant message, so the assembler
// must too. Discarding is safe while nothing has been emitted; after that it is a divergence.
test("stream: new message_id BEFORE any emit → held text discarded, stays exact vs T", () => {
  const a = new TuiDeltaAssembler({ holdbackChars: 100 });
  a.push(mdFire(0, "I'll check the file.", { mid: "m1" })); // short pre-tool prose, held back
  assert.equal(a.emitted, "");
  const answer = "The file defines a Mutex class with acquire and release, and " + "z".repeat(90);
  const out = a.push(mdFire(0, answer, { mid: "m2", final: true }));
  assert.equal(out, answer, "only the FINAL message's text is emitted");
  const rec = a.finalize(answer); // T = extractLatestAssistantText = the last message only
  assert.equal(rec.ok, true);
  assert.equal(rec.exact, true, "scoping to the last message_id keeps concat === T true");
  assert.equal(a.messages, 2);
});

test("stream: new message_id AFTER an emit → unretractable, flagged and refused", () => {
  const a = new TuiDeltaAssembler({ holdbackChars: 10 });
  a.push(mdFire(0, "Long pre-tool prose that already went out to the client.", { mid: "m1" }));
  assert.notEqual(a.emitted, "");
  // Assert what push() RETURNS, not merely that finalize() refuses. This test used to check
  // only restartedAfterEmit + finalize().ok, which left it passing while F1 was live: the
  // second message's bytes were still being handed to the client. "The turn is refused" and
  // "the client got the bytes anyway" were both true at once.
  const out = a.push(mdFire(0, "The real answer.", { mid: "m2", final: true }));
  assert.equal(out, null, "after a message boundary follows an emit, NOTHING more may be emitted");
  assert.equal(a.restartedAfterEmit, true);
  assert.equal(a.finalize("The real answer.").ok, false, "must refuse: prose already emitted is not in T");
});

test("F1: an auth banner rendered as a LATER message is never forwarded to the client", () => {
  // The leak this class exists to prevent, in the shape production actually runs
  // (OCP_TUI_FULL_TOOLS=1 → multi-message tool-using turns are the norm):
  //   1. the model narrates past the holdback before a tool call  → released, emitted != ""
  //   2. credentials expire mid-turn → claude renders the 401 as ordinary assistant TEXT,
  //      as a NEW message
  //   3. pre-fix: push() took the `if (this.released)` branch — `released` was never reset at
  //      a message boundary — and returned the BANNER verbatim, straight to the client.
  // The holdback protected only the FIRST message of a turn. This asserts it protects the rest.
  const a = new TuiDeltaAssembler({ holdbackChars: 100 });
  const narration = "I'll check that file for you and then report back with what I find inside it.";
  a.push(mdFire(0, narration + narration, { mid: "m1" }));   // > holdback → released
  assert.notEqual(a.emitted, "", "precondition: the narration really did reach the client");

  const BANNER = "Please run /login · API Error: 401 Invalid authentication credentials";
  const out = a.push(mdFire(1, BANNER, { mid: "m2", final: true }));
  assert.equal(out, null, "the auth banner must NOT be forwarded once a later message begins");
  assert.ok(!a.emitted.includes("401"), "no byte of the banner may have reached the client");
  assert.equal(a.finalize(BANNER).ok, false, "and the turn is refused, not served");
});

test("F1: a first payload with message_id:null cannot disarm the guard", () => {
  // The residual bypass the reviewer found by probing. `this.messageId` used to be initialized
  // to null, so a first payload carrying message_id:null compared EQUAL to it → no boundary
  // registered → `messages` stayed 0 → when the REAL boundary arrived, `messages > 1` evaluated
  // 1 > 1 === false → restartedAfterEmit never armed → the released branch forwarded the banner.
  // The whole F1 guard was disarmed by a single null field. parseDeltaChunk does not validate
  // message_id, so such a payload does reach push().
  const a = new TuiDeltaAssembler({ holdbackChars: 100 });
  const narration = "I'll check that file for you and then report back with what I find inside it.";
  a.push({ hook_event_name: "MessageDisplay", message_id: null, delta: narration + narration });
  assert.notEqual(a.emitted, "", "precondition: the narration released to the client");
  assert.equal(a.messages, 1, "a null message_id is still a MESSAGE — it must register as one");

  const BANNER = "Please run /login · API Error: 401 Invalid authentication credentials";
  const out = a.push({ hook_event_name: "MessageDisplay", message_id: "m2", delta: BANNER });
  assert.equal(out, null, "the banner must not be forwarded — the guard must arm regardless");
  assert.equal(a.restartedAfterEmit, true);
  assert.ok(!a.emitted.includes("401"));
});

test("F1: whitespace cannot buy a release — the holdback screens TRIMMED length", () => {
  // detectTuiUpstreamError() TRIMS before applying its <=100-char rule, so gating release on
  // the UNTRIMMED pending.length let 101 spaces trim to "" → the detector has nothing to
  // classify → returns null → release fires having screened nothing, and every subsequent
  // delta of that message (a banner included) streams unfiltered.
  const a = new TuiDeltaAssembler({ holdbackChars: 100 });
  assert.equal(a.push(mdFire(0, " ".repeat(101), { mid: "m1" })), null,
    "101 chars of whitespace must not clear a 100-char holdback");
  assert.equal(a.released, false, "…and must not flip the assembler into released state");
  const BANNER = "Please run /login · API Error: 401 Invalid authentication credentials";
  assert.equal(a.push(mdFire(1, BANNER, { mid: "m1" })), null, "so the banner stays held back");
  assert.ok(!a.emitted.includes("401"));
});

test("F3: a STALE or truncated hook script is overwritten, not trusted because it exists", () => {
  // ~/.ocp-tui/stream/{md-hook.sh,settings.json} persist across OCP restarts. The old
  // write-if-missing guard meant a host that booted once under an older version was stuck on
  // that version's HOOK_SCRIPT forever — no upgrade could reach it. Worse, a non-atomic write
  // interrupted mid-flight leaves a TRUNCATED md-hook.sh that existsSync() calls fine, and
  // claude BLOCKS on that hook synchronously on every fire.
  const dir = mkdtemp2(`${tmpdir2()}/ocp-hook-`);
  mkdir2(dir, { recursive: true });
  writeFile2(`${dir}/md-hook.sh`, "#!/bin/sh\n# stale, truncated leftov", { mode: 0o700 });
  writeFile2(`${dir}/settings.json`, "{ TRUNCATED", { mode: 0o600 });

  const settings = prepareStreamHook(dir);

  assert.equal(readFile2(`${dir}/md-hook.sh`, "utf8"), HOOK_SCRIPT,
    "the stale script must be replaced with the current one, not left because it existed");
  assert.deepEqual(JSON.parse(readFile2(settings, "utf8")), buildStreamSettings(`${dir}/md-hook.sh`),
    "…and so must the stale settings file");
});

test("stream: hook script is a write-and-exit sh script and tolerates a missing sink var", () => {
  // forceSyncExecution: claude BLOCKS on this hook, so it must do no work inline.
  assert.ok(HOOK_SCRIPT.startsWith("#!/bin/sh"));
  assert.ok(HOOK_SCRIPT.includes('[ -n "$OCP_TUI_STREAM_FILE" ] || exec cat >/dev/null'),
    "no sink configured => swallow stdin and exit 0; never fail, never block claude");
  assert.ok(!/curl|node |python/.test(HOOK_SCRIPT), "no interpreter/network work in a blocking hook");
});

test("stream: settings registers exactly one MessageDisplay command hook (static, no per-request data)", () => {
  const s = buildStreamSettings("/x/md-hook.sh");
  assert.deepEqual(Object.keys(s.hooks), ["MessageDisplay"]);
  assert.equal(s.hooks.MessageDisplay[0].hooks[0].type, "command");
  assert.equal(s.hooks.MessageDisplay[0].hooks[0].command, "/x/md-hook.sh");
  // Warm-pool compatibility: the settings file must NOT carry a session/request-specific path.
  assert.ok(!JSON.stringify(s).includes(".jsonl"), "sink path comes from the pane env, not the settings file");
});

test("stream: sink path is keyed by session_id (concurrent panes cannot interleave)", () => {
  // OCP_TUI_MAX_CONCURRENT defaults to 2 — two claude panes DO run at once. A shared sink
  // would splice request A's deltas into request B's stream.
  const A = streamFilePath("/d", "aaaa-1111");
  const B = streamFilePath("/d", "bbbb-2222");
  assert.notEqual(A, B, "one sink per session-id");
  assert.ok(A.endsWith("/aaaa-1111.jsonl"));
});

test("stream: buildTuiCmd — streaming ON adds env + --settings and drops --safe-mode (hook survives)", () => {
  const off = buildTuiCmd("/bin/claude", "m", "SID", "/h", "cli");
  assert.ok(!off.includes("--settings"), "no --settings when streaming is off");
  assert.ok(!off.includes("OCP_TUI_STREAM_FILE"), "no sink env when streaming is off");
  assert.ok(off.includes("--safe-mode"), "the non-streaming pane carries --safe-mode");
  const on = buildTuiCmd("/bin/claude", "m", "SID", "/h", "cli", { file: "/d/SID.jsonl", settings: "/d/s.json" });
  assert.ok(on.includes("OCP_TUI_STREAM_FILE='/d/SID.jsonl'"), "sink delivered via the pane env");
  assert.ok(on.includes("--settings '/d/s.json'"));
  // --safe-mode would disable the MessageDisplay hook registered by --settings, so the
  // streaming pane must NOT carry it (it keeps the env-var suppression instead).
  assert.ok(!on.includes("--safe-mode"), "streaming pane omits --safe-mode so the hook fires");
  // must not regress the MCP wall or the pinned effort (#156)
  assert.ok(on.includes("--strict-mcp-config") && on.includes("--disallowedTools 'mcp__*'"), "MCP wall intact");
  assert.ok(on.includes("--effort low"), "OCP_TUI_EFFORT default intact");
  assert.ok(!on.includes(" -p ") && !on.includes("--bare"), "still a plain interactive TUI spawn");
});

test("stream: /health block is additive and exposes the divergence counter", () => {
  const stats = { lastEntrypoint: "cli", entrypointMismatches: 0, streamTurns: 3, streamDeltas: 21, streamTopUps: 1, streamDivergences: 0 };
  const sem = { inflight: 0, queued: 0 };
  const b = buildTuiHealthBlock({ enabled: true, entrypointMode: "cli", maxConcurrent: 2, streamEnabled: true }, stats, sem);
  assert.equal(b.streamEnabled, true);
  assert.equal(b.streamTurns, 3);
  assert.equal(b.streamDivergences, 0);
  // existing fields unchanged (grandfathered /health consumers)
  assert.equal(b.enabled, true);
  assert.equal(b.entrypointMode, "cli");
  assert.equal(b.maxConcurrent, 2);
  // a pre-streaming tuiStats (no stream* keys) must not produce undefined/NaN
  const legacy = buildTuiHealthBlock({ enabled: false, entrypointMode: "cli", maxConcurrent: 2 }, { lastEntrypoint: null, entrypointMismatches: 0 }, sem);
  assert.equal(legacy.streamEnabled, false);
  assert.equal(legacy.streamDivergences, 0);
});

// ── OpenAI Structured Outputs (response_format) — lib/structured-output.mjs ──
import { detectStructuredOutput, validateJsonSchema, validateJsonSchemaSafe, extractJsonPayload, structuredSystemInstruction, StructuredOutputError, resolveMaxAttempts } from "./lib/structured-output.mjs";

test("detectStructuredOutput: json_schema shape", () => {
  const d = detectStructuredOutput({ response_format: { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } } });
  assert.equal(d.mode, "schema"); assert.equal(d.strict, true); assert.deepEqual(d.schema, { type: "object" });
});
test("detectStructuredOutput: json_object shape", () => {
  assert.deepEqual(detectStructuredOutput({ response_format: { type: "json_object" } }), { mode: "json_object" });
});
test("detectStructuredOutput: json_mode:true alias → json_object", () => {
  assert.deepEqual(detectStructuredOutput({ json_mode: true }), { mode: "json_object" });
});
test("detectStructuredOutput: absent → null (non-structured untouched)", () => {
  assert.equal(detectStructuredOutput({ messages: [] }), null);
  assert.equal(detectStructuredOutput({ response_format: "nonsense" }), null);
  assert.equal(detectStructuredOutput({ json_mode: false }), null);
});
test("cacheHash: structured marker isolates JSON requests from the conversational slot", () => {
  const msgs = [{ role: "user", content: "list 3 fruits" }];
  const plain = cacheHash("m", msgs, { keyId: "k" });
  const asJson = cacheHash("m", msgs, { keyId: "k", structured: { mode: "json_object" } });
  const asSchema = cacheHash("m", msgs, { keyId: "k", structured: { mode: "schema", schema: { type: "array" } } });
  assert.notEqual(plain, asJson);      // JSON vs prose never collide
  assert.notEqual(asJson, asSchema);   // different schema → different slot
  assert.equal(plain, cacheHash("m", msgs, { keyId: "k" })); // unchanged for normal requests
});

// ── validateJsonSchemaSafe (#181): deep value must NOT crash the handler ─────
// A recursive schema + a model reply nested ~thousands deep overflows the value-
// depth recursion → RangeError → the handler used to surface a generic 500. The
// safe façade turns it into a validation miss (→ retry → refusal). Mutation-proof:
// replace the wrapper body with a bare `validateJsonSchema(...)` call and the deep
// test throws instead of returning errors.
test("validateJsonSchemaSafe: pathologically deep value → errors, never throws", () => {
  const schema = { $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } }, $ref: "#/$defs/node" };
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 6000; i++) { cur.child = {}; cur = cur.child; } // way past any stack limit
  let out;
  assert.doesNotThrow(() => { out = validateJsonSchemaSafe(deep, schema, "$", true); }, "must not throw a RangeError out to the handler");
  assert.ok(Array.isArray(out) && out.length > 0, "returns a non-empty validation error, so the retry loop yields a refusal not a 500");
});

test("validateJsonSchemaSafe: well-formed value passes through unchanged (byte-identical to the raw validator)", () => {
  const schema = { type: "object", required: ["name", "age"], properties: { name: { type: "string" }, age: { type: "integer" } } };
  assert.deepEqual(validateJsonSchemaSafe({ name: "a", age: 3 }, schema), validateJsonSchema({ name: "a", age: 3 }, schema));
  assert.deepEqual(validateJsonSchemaSafe({ name: "a" }, schema), validateJsonSchema({ name: "a" }, schema)); // error case matches too
});

test("validateJsonSchemaSafe: re-throws a non-RangeError so genuine bugs aren't masked as a validation miss", () => {
  // A schema whose `required` is a non-iterable makes the inner validator throw a TypeError — that's
  // a real bug, not a deep-value overflow, and must surface (not be swallowed as "did not validate").
  assert.throws(() => validateJsonSchemaSafe({ x: 1 }, { type: "object", required: 42 }), (e) => !(e instanceof RangeError));
});

test("validateJsonSchema: valid object passes", () => {
  assert.deepEqual(validateJsonSchema({ name: "a", age: 3 }, { type: "object", required: ["name", "age"], properties: { name: { type: "string" }, age: { type: "integer" } } }), []);
});
test("validateJsonSchema: missing required property flagged", () => {
  assert.ok(validateJsonSchema({ name: "a" }, { type: "object", required: ["name", "age"], properties: {} }).some(e => /age.*required/.test(e)));
});
test("validateJsonSchema: additionalProperties:false rejects extra keys", () => {
  assert.ok(validateJsonSchema({ a: 1, b: 2 }, { type: "object", additionalProperties: false, properties: { a: { type: "integer" } } }).some(e => /b.*additional/.test(e)));
});
test("validateJsonSchema: enum rejects non-null value not in list", () => {
  assert.ok(validateJsonSchema("maybe", { type: "string", enum: ["yes", "no"] }).length > 0);
});
test("validateJsonSchema: NULLABLE enum accepts null even when null not in enum (HA regression)", () => {
  // type:["string","null"] + enum:["Loxone"] — a null value must be accepted (nullability > enum).
  assert.deepEqual(validateJsonSchema(null, { type: ["string", "null"], enum: ["Loxone"] }), []);
});
test("validateJsonSchema: nullable enum still enforces non-null values against the enum", () => {
  assert.ok(validateJsonSchema("Other", { type: ["string", "null"], enum: ["Loxone"] }).length > 0);
});
test("validateJsonSchema: type mismatch flagged", () => {
  assert.ok(validateJsonSchema("str", { type: "integer" }).length > 0);
});
test("validateJsonSchema: array items + minItems", () => {
  assert.deepEqual(validateJsonSchema([1, 2, 3], { type: "array", items: { type: "integer" }, minItems: 3 }), []);
  assert.ok(validateJsonSchema([1], { type: "array", items: { type: "integer" }, minItems: 3 }).some(e => /minItems/.test(e)));
});

test("extractJsonPayload: clean JSON", () => {
  const r = extractJsonPayload('{"a":1}'); assert.ok(r.ok); assert.deepEqual(r.value, { a: 1 });
});
test("extractJsonPayload: fenced ```json block", () => {
  const r = extractJsonPayload('```json\n{"a":1}\n```'); assert.ok(r.ok); assert.deepEqual(r.value, { a: 1 });
});
test("extractJsonPayload: prose-wrapped, string-aware balanced slice", () => {
  const r = extractJsonPayload('Sure! Here you go: {"note":"has } and { inside"} — hope that helps.');
  assert.ok(r.ok); assert.deepEqual(r.value, { note: "has } and { inside" });
});
test("extractJsonPayload: array payload", () => {
  const r = extractJsonPayload('[1,2,3]'); assert.ok(r.ok); assert.deepEqual(r.value, [1, 2, 3]);
});
test("extractJsonPayload: no JSON → ok:false", () => {
  assert.equal(extractJsonPayload("I cannot help with that.").ok, false);
});

test("structuredSystemInstruction: embeds schema, forbids fences, escalates on retry", () => {
  const first = structuredSystemInstruction({ mode: "schema", schema: { type: "object" } }, 0, "");
  assert.ok(/code fences/.test(first) && /JSON Schema/.test(first));
  const retry = structuredSystemInstruction({ mode: "schema", schema: { type: "object" } }, 1, "bad enum");
  assert.ok(/REJECTED \(bad enum\)/.test(retry));
});
test("StructuredOutputError carries reason", () => {
  const e = new StructuredOutputError("schema validation failed", "raw");
  assert.equal(e.reason, "schema validation failed"); assert.ok(e instanceof Error);
});

// ── PR #153 review round 2, MUST-FIX: OCP_STRUCTURED_MAX_ATTEMPTS NaN guard must fail closed ──
// The old `Math.max(1, parseInt(env||"3",10))` returned NaN for a non-integer value → the retry loop
// `attempt < NaN` never ran → 0 spawns, every structured request refused. resolveMaxAttempts keeps
// the default instead of silently bricking the feature.
test("resolveMaxAttempts: valid integer honored", () => {
  assert.equal(resolveMaxAttempts("5"), 5);
  assert.equal(resolveMaxAttempts("1"), 1);
});
test("resolveMaxAttempts: unset/empty → default", () => {
  assert.equal(resolveMaxAttempts(undefined), 3);
  assert.equal(resolveMaxAttempts(""), 3);
  assert.equal(resolveMaxAttempts(null), 3);
});
test("resolveMaxAttempts: non-integer / non-finite / <1 fails CLOSED to the default (not NaN, not 0)", () => {
  let warned = 0; const warn = () => { warned++; };
  for (const bad of ["abc", "0", "-1", "NaN", "Infinity", "  "]) {
    const v = resolveMaxAttempts(bad, { fallback: 3, warn });
    assert.equal(v, 3, `bad input ${JSON.stringify(bad)} must fall back to 3, got ${v}`);
    assert.ok(Number.isFinite(v) && v >= 1, "result is always a usable positive integer");
  }
  assert.ok(warned > 0, "invalid values emit a startup warning");
});
test("resolveMaxAttempts: the retry loop is never bounded by NaN (regression: 0 spawns / silent refuse)", () => {
  const attempts = resolveMaxAttempts("abc");
  let ran = 0;
  for (let attempt = 0; attempt < attempts; attempt++) ran++;
  assert.ok(ran >= 1, "loop must execute at least once — pre-fix it ran 0 times");
});

// ── PR #153 review finding 1: $ref/$defs + strict:true must accept conforming objects ──
// The flagship shape the OpenAI SDK emits (zodResponseFormat / client.beta.chat.completions.parse)
// and OpenAI's own structured-outputs docs example: nested {$ref:"#/$defs/step"} + strict:true.
// Before the fix, strict inferred additionalProperties:false on the unresolved $ref (empty props) and
// rejected every real key. This is the exact regression the PR must not ship.
const OPENAI_DOC_SCHEMA = {
  type: "object",
  properties: {
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
    final_answer: { type: "string" },
  },
  $defs: {
    step: {
      type: "object",
      properties: { explanation: { type: "string" }, output: { type: "string" } },
      required: ["explanation", "output"],
      additionalProperties: false,
    },
  },
  required: ["steps", "final_answer"],
  additionalProperties: false,
};

test("validateJsonSchema: OpenAI doc schema ($ref/$defs) + strict:true accepts a conforming reply", () => {
  const conforming = { steps: [{ explanation: "add", output: "4" }, { explanation: "done", output: "4" }], final_answer: "4" };
  assert.deepEqual(validateJsonSchema(conforming, OPENAI_DOC_SCHEMA, "$", true), []);
});

test("validateJsonSchema: $ref + strict:true still REJECTS a genuinely-extra key (fix didn't disable validation)", () => {
  const extra = { steps: [{ explanation: "add", output: "4", bogus: 1 }], final_answer: "4" };
  const errs = validateJsonSchema(extra, OPENAI_DOC_SCHEMA, "$", true);
  assert.ok(errs.some(e => /bogus.*additional property not allowed/.test(e)), `expected the extra key rejected, got: ${JSON.stringify(errs)}`);
});

test("validateJsonSchema: $ref + strict:true still catches a missing required property", () => {
  const missing = { steps: [{ explanation: "add" }], final_answer: "4" };
  assert.ok(validateJsonSchema(missing, OPENAI_DOC_SCHEMA, "$", true).some(e => /output.*required/.test(e)));
});

test("validateJsonSchema: anyOf accepts a value matching one branch, rejects a value matching none", () => {
  const schema = { anyOf: [{ type: "string" }, { type: "integer" }] };
  assert.deepEqual(validateJsonSchema("hi", schema), []);
  assert.deepEqual(validateJsonSchema(3, schema), []);
  assert.ok(validateJsonSchema(true, schema).length > 0);
});

test("validateJsonSchema: allOf requires every branch to pass", () => {
  const schema = { allOf: [{ type: "object", properties: { a: { type: "integer" } }, required: ["a"] }, { type: "object", properties: { b: { type: "string" } }, required: ["b"] }] };
  assert.deepEqual(validateJsonSchema({ a: 1, b: "x" }, schema), []);
  assert.ok(validateJsonSchema({ a: 1 }, schema).some(e => /b.*required/.test(e)));
});

test("validateJsonSchema: unresolvable $ref is skipped, not failed", () => {
  assert.deepEqual(validateJsonSchema({ anything: 1 }, { $ref: "#/$defs/missing" }), []);
});

// ── PR #153 review round 2, BLOCKER: cyclic $ref must fail closed, not stack-overflow ──
// A pure ref→ref cycle recurses independent of the data — before the fix ANY reply value (even `5`)
// threw `RangeError: Maximum call stack size exceeded`, caught upstream as a 500 but only after
// 1–3 metered spawns → a request-controlled cost-amplification / grief vector on an authed path.
test("validateJsonSchema: a→b→a cyclic $ref fails closed (no stack overflow) for any value", () => {
  const schema = { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" };
  let errs;
  assert.doesNotThrow(() => { errs = validateJsonSchema(5, schema, "$", true); }, "cyclic $ref must not overflow the stack");
  assert.ok(errs.some(e => /cyclic \$ref/.test(e)), `expected a cyclic-$ref error, got: ${JSON.stringify(errs)}`);
});
test("validateJsonSchema: self-referential $ref (a→a) fails closed", () => {
  const schema = { $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" };
  let errs;
  assert.doesNotThrow(() => { errs = validateJsonSchema({ x: 1 }, schema, "$", true); });
  assert.ok(errs.some(e => /cyclic \$ref/.test(e)));
});
test("validateJsonSchema: cycle routed through anyOf fails closed", () => {
  const schema = { $defs: { a: { anyOf: [{ $ref: "#/$defs/a" }] } }, $ref: "#/$defs/a" };
  assert.doesNotThrow(() => validateJsonSchema({ x: 1 }, schema, "$", true));
});
test("validateJsonSchema: a LEGITIMATE recursive schema (Node→child:Node) is NOT flagged as a cycle", () => {
  // Data is a finite tree, so data-consuming recursion terminates — the cycle guard must not
  // false-positive here (refChain resets across properties/items).
  const schema = {
    $defs: { node: { type: "object", properties: { v: { type: "integer" }, child: { $ref: "#/$defs/node" } }, required: ["v"], additionalProperties: false } },
    $ref: "#/$defs/node",
  };
  const tree = { v: 1, child: { v: 2, child: { v: 3 } } };
  assert.deepEqual(validateJsonSchema(tree, schema, "$", true), []);
});

// ── PR #153 review finding 2: never serve an unvalidated / ambiguous extraction ──
test("extractJsonPayload: json_object mode rejects a refusal that merely CONTAINS json", () => {
  const reply = 'I can\'t do that. For reference the schema looks like {"type":"object"} — sorry.';
  const r = extractJsonPayload(reply, { whole: true });
  assert.equal(r.ok, false);
});

test("extractJsonPayload: json_object mode accepts a whole-reply JSON value", () => {
  const r = extractJsonPayload('  {"temp":21}  ', { whole: true });
  assert.ok(r.ok); assert.deepEqual(r.value, { temp: 21 });
});

test("extractJsonPayload: schema mode rejects >1 top-level JSON value (Schema:{} Answer:{})", () => {
  const reply = 'Schema: {"type":"object"}\n\nAnswer: {"temp":21}';
  const r = extractJsonPayload(reply);
  assert.equal(r.ok, false);
  assert.ok(/more than one/.test(r.reason || ""));
});

test("extractJsonPayload: schema mode rejects two competing options rather than silently picking one", () => {
  const r = extractJsonPayload('Option A:\n{"a":1}\nOption B:\n{"b":2}');
  assert.equal(r.ok, false);
});

test("extractJsonPayload: single prose-wrapped value still accepted in schema mode", () => {
  const r = extractJsonPayload('Sure, here you go: {"a":1} — done.');
  assert.ok(r.ok); assert.deepEqual(r.value, { a: 1 });
});

// ── Cleanup ──
// Settle the async-bodied tests registered through the sync `test()` helper BEFORE summarizing —
// otherwise their pass/fail is not reflected in the counts (see the `pendingAsync` comment above).
// ─── TUI streaming × warm pool: the INTEGRATION seam (backlog #2 rebased onto #158) ───
//
// The hook is installed by bootTuiPane at BOOT, and runTuiTurn reads the sink off the PANE
// (pane.streamFile). That indirection is the entire reason a POOLED pane streams: the pool
// pre-boots panes long before a request exists, so anything derived at turn time would leave
// every pool HIT silently buffered while every MISS streamed — a perf regression with no
// failing test and no error, visible only as "streaming mysteriously does nothing in prod".
// These three guard that seam.
console.log("\nTUI streaming × warm pane pool integration:");

import { bootTuiPane as bootPaneUnderTest, runTuiTurn as runTurnUnderTest } from "./lib/tui/session.mjs";
import { mkdtempSync as mkdtemp2, writeFileSync as writeFile2, mkdirSync as mkdir2, readFileSync as readFile2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";

// Fake tmux that records the spawned pane command and always looks ready + pasted.
function makeTmuxRecorder() {
  const cmds = [];
  const tmux = (args) => {
    cmds.push(args);
    if (args[0] === "capture-pane") {
      // input bar present AND the prompt visibly landed → both polls pass immediately
      return { status: 0, stdout: "[Pasted text #1 +2 lines]\n ? for shortcuts" };
    }
    return { status: 0, stdout: "" };
  };
  return { tmux, cmds, paneCmd: () => (cmds.find((a) => a[0] === "new-session") || []).slice(-1)[0] || "" };
}

// A HOME with one already-terminal transcript for `sid`, so readTuiTranscript returns at once.
function seedTranscript(home, sid, text) {
  const dir = `${home}/.claude/projects/x`;
  mkdir2(dir, { recursive: true });
  writeFile2(`${dir}/${sid}.jsonl`, JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
    turn_duration: 1234, cc_entrypoint: "cli",
  }) + "\n");
}

test("bootTuiPane with a streamDir installs the hook AT BOOT and hands the sink back on the pane", async () => {
  const home = mkdtemp2(`${tmpdir2()}/ocp-t-`);
  const streamDir = mkdtemp2(`${tmpdir2()}/ocp-s-`);
  const rec = makeTmuxRecorder();
  const pane = await bootPaneUnderTest({
    model: "sonnet", claudeBin: "claude", home, realHome: home,
    cwd: `${home}/wk`, port: 3456, tmux: rec.tmux, streamDir,
  });
  // The pane carries its OWN sink, named from its OWN session-id — which is what a pre-booted
  // pool pane needs, since it is minted with no knowledge of the request it will eventually serve.
  assert.ok(pane.streamFile, "a streamDir must yield a per-pane sink on the returned pane");
  assert.ok(pane.streamFile.includes(pane.sessionId), "the sink is keyed by the pane's own session-id");
  const cmd = rec.paneCmd();
  assert.ok(cmd.includes("OCP_TUI_STREAM_FILE="), "the pane's env must carry its sink path");
  assert.ok(cmd.includes(pane.streamFile), "…and it must be THIS pane's sink, not a shared one");
  assert.ok(cmd.includes("--settings"), "the MessageDisplay hook must be registered at spawn");
});

test("bootTuiPane WITHOUT a streamDir spawns exactly today's pane — no hook, no --settings", async () => {
  const home = mkdtemp2(`${tmpdir2()}/ocp-t-`);
  const rec = makeTmuxRecorder();
  const pane = await bootPaneUnderTest({
    model: "sonnet", claudeBin: "claude", home, realHome: home,
    cwd: `${home}/wk`, port: 3456, tmux: rec.tmux,
  });
  assert.equal(pane.streamFile, null, "no streamDir → no sink (streaming is opt-in, default OFF)");
  const cmd = rec.paneCmd();
  assert.ok(!cmd.includes("--settings"), "the default spawn must not gain --settings");
  assert.ok(!cmd.includes("OCP_TUI_STREAM_FILE"), "the default spawn must not gain the hook env");
});

test("REGRESSION: a WARM (pooled) pane streams — the sink comes off the pane, not the turn", async () => {
  const home = mkdtemp2(`${tmpdir2()}/ocp-t-`);
  const streamDir = mkdtemp2(`${tmpdir2()}/ocp-s-`);
  const rec = makeTmuxRecorder();

  // Pre-boot a pane the way the POOL does (its own session-id + sink, fixed at boot).
  const warm = await bootPaneUnderTest({
    model: "sonnet", claudeBin: "claude", home, realHome: home,
    cwd: `${home}/wk`, port: 3456, tmux: rec.tmux, streamDir,
  });
  // Its hook has already fired twice by the time the turn's transcript goes terminal.
  writeFile2(warm.streamFile,
    JSON.stringify({ hook_event_name: "MessageDisplay", delta: "Hello " }) + "\n" +
    JSON.stringify({ hook_event_name: "MessageDisplay", delta: "world" }) + "\n");
  seedTranscript(home, warm.sessionId, "Hello world");

  const seen = [];
  const pool = { acquire: () => warm, refill: () => {}, warm: 0 };
  const out = await runTurnUnderTest({
    prompt: "say hello", model: "sonnet", claudeBin: "claude", home, realHome: home,
    cwd: `${home}/wk`, port: 3456, tmux: rec.tmux, pool,
    onDelta: (d) => seen.push(d.delta),
    // streamDir is deliberately NOT passed: on a pool HIT runTuiTurn never cold-boots, so if it
    // recomputed the sink from a turn-time streamDir (the pre-rebase shape) this turn would emit
    // ZERO deltas and silently serve buffered. Reading pane.streamFile is what makes it stream.
    streamDir: null,
  });
  assert.deepEqual(seen, ["Hello ", "world"], "the pooled pane's deltas must reach the client");
  assert.equal(out.text, "Hello world", "and the transcript stays authoritative for the final text");
});

console.log("\nTest isolation (the suite must never touch the operator's live key store):");

test("the key store under test is a scratch db, NOT the operator's real ~/.ocp/ocp.db", () => {
  // The guard that was missing. `npm test` wrote live, UNREVOKED api_keys rows straight into the
  // operator's real ~/.ocp/ocp.db — the same database the running server reads — two per run,
  // unbounded (737 junk keys vs 12 real ones on the maintainer's host before this landed). It
  // went unnoticed for so long precisely because NOTHING asserted where the store actually was.
  const real = join(homedir(), ".ocp", "ocp.db");
  const used = getDbPath();
  assert.ok(used, "getDb() must have opened something by now");
  assert.notEqual(used, real, "the suite must NOT open the operator's live key database");
  assert.ok(used.startsWith(TEST_OCP_DIR), `expected a scratch db under ${TEST_OCP_DIR}, got ${used}`);
});

test("a PRODUCTION process (no NODE_ENV) must IGNORE OCP_DIR_OVERRIDE", () => {
  // Must run OUT OF PROCESS. The parent is irreversibly NODE_ENV=test by the time any test runs
  // (test-env.mjs set it before keys.mjs was imported), so the production path is unreachable
  // from in here — and an in-process test can only ever RE-IMPLEMENT the predicate, which is
  // worthless: the first cut of this test did exactly that, and deleting the whole NODE_ENV gate
  // from keys.mjs still left the suite at 320 passed / 0 failed. A copy of the predicate is not
  // the predicate. So: spawn a child with no NODE_ENV, the override set, and HOME redirected to
  // a temp dir (so the real key store is never opened), and assert what the REAL keys.mjs did.
  const home = mkdtempSync(join(tmpdir(), "ocp-prodsim-"));
  const evil = mkdtempSync(join(tmpdir(), "ocp-evil-"));
  try {
    const keysUrl = pathToFileURL(join(import.meta.dirname, "keys.mjs")).href;
    // The child prints the override it SAW, then the store it actually opened. Printing both is
    // the negative control: without it, a future refactor that renamed the env var and missed
    // this test's `env` object would leave the child with no override at all — and "prod opened
    // the right store" would pass for the wrong reason. Asserting the child saw it and ignored
    // it anyway is the claim we actually want to make.
    const probe = `import { getDb, getDbPath, closeDb } from ${JSON.stringify(keysUrl)};
getDb(); process.stdout.write(process.env.OCP_DIR_OVERRIDE + "\\n" + getDbPath()); closeDb();`;
    const env = { ...process.env, HOME: home, OCP_DIR_OVERRIDE: evil };
    delete env.NODE_ENV;                       // a production server has no NODE_ENV
    const [seen, opened] = execFileSync(process.execPath, ["--input-type=module", "-e", probe],
      { env, encoding: "utf8" }).trim().split("\n");
    assert.equal(seen, evil, "precondition: the child must actually SEE the override");
    assert.equal(opened, join(home, ".ocp", "ocp.db"), "a prod process must open HOME/.ocp/ocp.db");
    assert.ok(!opened.startsWith(evil), "…having seen the override, a prod process must IGNORE it");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(evil, { recursive: true, force: true });
  }
});

test("listKeys does not depend on rows left behind by an earlier or concurrent run", () => {
  // The ~1-in-6 flake: two runs sharing one db file. keys.find() returned undefined and the
  // caller's `in` check threw a TypeError instead of failing cleanly. With a per-run scratch db
  // the store starts empty, so the count is exactly what THIS run created.
  const mine = listKeys().filter((k) => k.name === "test-user-1");
  assert.equal(mine.length, 1, "exactly one test-user-1 — a shared store would accumulate duplicates");
});

runAsyncTests().then(() => Promise.all(pendingAsync)).then(() => {
  closeDb();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch((e) => {
  console.error("async test runner crashed:", e);
  closeDb();
  process.exit(1);
});
