#!/usr/bin/env node
/**
 * Integration test for Quota + Cache features.
 * Tests database layer functions directly — no server needed.
 */
import { getDb, createKey, listKeys, validateKey, recordUsage, checkQuota, updateKeyQuota, getKeyQuota, findKey, cacheHash, getCachedResponse, setCachedResponse, clearCache, getCacheStats, closeDb, hasCacheControl, singleflight, getInflightStats } from "./keys.mjs";
import { isLoopbackBind } from "./lib/net.mjs";
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Use a test database to avoid corrupting real data
const TEST_DB = join(homedir(), ".ocp", "ocp-test.db");
try { unlinkSync(TEST_DB); } catch {}

// Monkey-patch DB_PATH for testing (override the module-level variable)
// Since keys.mjs uses lazy init, we can set env before first getDb() call
process.env.HOME = homedir(); // ensure consistent

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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
}

await runSingleflightTests();

// ── Plist Env Merge Tests ──
import { mergePlistEnv, mergeSystemdEnv } from "./scripts/lib/plist-merge.mjs";

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

// ── Upgrade Tests ──
import { runUpgrade } from "./scripts/upgrade.mjs";

console.log("\nUpgrade:");

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
    tMkdirSync(testJoin(dotOcp, `upgrade-snapshot-${ts}`));
  }
  const list = listSnapshots(root);
  assert.equal(list.length, 3);
  assert.ok(list[0].path.includes("2026-05-01"));
  assert.ok(list[2].path.includes("2026-05-03"));
  rmSync(root, { recursive: true, force: true });
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
    tMkdirSync(testJoin(dotOcp, `upgrade-snapshot-${ts}`));
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
    tMkdirSync(testJoin(dotOcp, `upgrade-snapshot-${ts}`));
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
  tMkdirSync(testJoin(dotOcp, "upgrade-snapshot-2026-01-01T10:00:00Z"));
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
    tMkdirSync(testJoin(dotOcp, `upgrade-snapshot-${ts}`));
  }
  const result = gcSnapshots(root, { keepCount: 1, keepDays: 0, dryRun: true, now: new Date("2026-05-11T00:00:00Z") });
  assert.equal(result.dryRun, true);
  assert.equal(result.removed.length, 2);
  // Files still exist
  assert.ok(testExistsSync(testJoin(dotOcp, "upgrade-snapshot-2026-04-01T10:00:00Z")));
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

function parseStreamJsonEvent(event, isFirstDelta) {
  const t = event?.type;

  // system/* — first-event init + other system meta (api_retry etc.)
  if (t === "system") return null;
  // user — echo of user message; consumed
  if (t === "user") return null;

  // stream_event — contains nested content_block_delta
  if (t === "stream_event") {
    const inner = event.event ?? event;
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { text: inner.delta.text ?? "" };
    }
    // Other stream_event sub-types (content_block_start, message_delta, etc.) — consumed
    return null;
  }

  // assistant — aggregate message (fallback when no prior content_block_delta seen)
  // Empirically (claude CLI without --include-partial-messages, verified v2.1.104 through v2.1.158): fast/short
  // responses may emit ONLY the aggregate assistant event, no content_block_delta events.
  // If isFirstDelta is true, extract text here; otherwise it's a duplicate, ignore.
  // Reference: OLP commit 65f945c (assistant-aggregate fallback, fold-in).
  if (t === "assistant") {
    if (isFirstDelta) {
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
  const result = parseStreamJsonEvent(event, true);
  assert.deepEqual(result, { text: "Hello" });
});

test("parseStreamJsonEvent: assistant-aggregate used when isFirstDelta=true (no prior delta)", () => {
  const event = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Short answer." }] }
  };
  const result = parseStreamJsonEvent(event, true);
  assert.deepEqual(result, { text: "Short answer." });
});

test("parseStreamJsonEvent: assistant-aggregate skipped when isFirstDelta=false (no double-count)", () => {
  const event = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Short answer." }] }
  };
  const result = parseStreamJsonEvent(event, false);
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
  // First event: isFirstDelta=true → yields text
  const r1 = parseStreamJsonEvent(delta, true);
  assert.deepEqual(r1, { text: "Streaming text." });
  // Second event (aggregate): isFirstDelta is now false (content already emitted) → null
  const r2 = parseStreamJsonEvent(agg, false);
  assert.equal(r2, null);
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
  const result = parseStreamJsonEvent(event, true);
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
  const parsed = parseStreamJsonEvent(ev2[0], true);
  assert.deepEqual(parsed, { text: "Hi" });
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
import { encodeCwd, transcriptPath, findTranscriptPath, parseTranscriptLines, isTerminalLine, extractLatestAssistantText, verifyEntrypoint } from "./lib/tui/transcript.mjs";
import { readFileSync as tuiReadFileSync, mkdtempSync as tuiMkdtemp0, mkdirSync as tuiMkdir0, writeFileSync as tuiWrite0 } from "node:fs";
import { tmpdir as tuiTmp0 } from "node:os";

console.log("\nTUI transcript — path formula:");

test("encodeCwd replaces every slash AND every dot with dash", () => {
  // Verified live (claude v2.1.158): /home/u/.ocp-tui/work -> -home-u--ocp-tui-work
  assert.equal(encodeCwd("/home/u/.ocp-tui/work"), "-home-u--ocp-tui-work");
  assert.equal(encodeCwd("/tmp/tui-test"), "-tmp-tui-test"); // dot-free path still correct
});
test("transcriptPath composes HOME/.claude/projects/<enc>/<sid>.jsonl", () => {
  assert.equal(
    transcriptPath("/home/u", "/home/u/.ocp-tui/work", "abc-123"),
    "/home/u/.claude/projects/-home-u--ocp-tui-work/abc-123.jsonl"
  );
});
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

await asyncTest("readTuiTranscript honours wall-clock cap and returns partial text", async () => {
  const dir = tuiMkdtemp(`${tuiTmpdir()}/tui-`);
  const p = `${dir}/s.jsonl`;
  tuiWriteFile(p, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }) + "\n");
  const out = await readTuiTranscript({ transcriptPath: p, wallclockMs: 300, pollMs: 50 });
  assert.equal(out.text, "partial");
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
import { reapStaleTuiSessions, SESSION_PREFIX, buildTuiCmd } from "./lib/tui/session.mjs";

console.log("\nTUI session reaper:");

test("SESSION_PREFIX is ocp-tui-", () => {
  assert.equal(SESSION_PREFIX, "ocp-tui-");
});

console.log("\nTUI command construction (proxy-purity / #4):");

test("buildTuiCmd suppresses host CLAUDE.md + auto-memory (proxy purity, #4)", () => {
  const cmd = buildTuiCmd("/usr/bin/claude", "claude-haiku", "sid-1", "/home/u", "cli");
  // OCP is a proxy: the host's CLAUDE.md / auto-memory must never leak into the proxied turn.
  assert.ok(/(^| )CLAUDE_CODE_DISABLE_CLAUDE_MDS=1( |$)/.test(cmd), "must disable CLAUDE.md injection");
  assert.ok(/(^| )CLAUDE_CODE_DISABLE_AUTO_MEMORY=1( |$)/.test(cmd), "must disable auto-memory injection");
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

test("reaper kills ONLY ocp-tui- sessions, never olp-tui-", () => {
  const killed = [];
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "ocp-tui-aaaa\nolp-tui-bbbb\nmisc\nocp-tui-cccc\n" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux });
  assert.equal(n, 2);
  assert.equal(killed.join(","), "ocp-tui-aaaa,ocp-tui-cccc");
  assert.ok(!killed.includes("olp-tui-bbbb"), "olp-tui-bbbb must never be killed");
});

test("reaper returns 0 when tmux status !== 0 (no server)", () => {
  const fakeTmux = (_args) => ({ status: 1, stdout: "" });
  const n = reapStaleTuiSessions({ tmux: fakeTmux });
  assert.equal(n, 0);
});

test("reaper returns 0 for empty session list", () => {
  const killed = [];
  const fakeTmux = (args) => {
    if (args[0] === "list-sessions") return { status: 0, stdout: "" };
    if (args[0] === "kill-session") { killed.push(args[args.indexOf("-t") + 1]); return { status: 0 }; }
    return { status: 0, stdout: "" };
  };
  const n = reapStaleTuiSessions({ tmux: fakeTmux });
  assert.equal(n, 0);
  assert.equal(killed.length, 0);
});

// ── TUI home preparation (scratch vs real) ───────────────────────────────
import { prepareTuiHome, ensureTuiCwdTrusted } from "./lib/tui/session.mjs";
import { mkdtempSync as hMkdtemp, mkdirSync as hMkdir, writeFileSync as hWrite, readFileSync as hRead, existsSync as hExists, readlinkSync as hReadlink } from "node:fs";
import { tmpdir as hTmp } from "node:os";

console.log("\nTUI home preparation:");

test("prepareTuiHome scratch mode: symlinks creds, seeds onboarded config, trusts cwd, strips history", () => {
  const realHome = hMkdtemp(`${hTmp()}/real-`);
  hMkdir(`${realHome}/.claude`, { recursive: true });
  hWrite(`${realHome}/.claude/.credentials.json`, '{"token":"x"}');
  hWrite(`${realHome}/.claude.json`, JSON.stringify({ theme: "dark", projects: { "/old/secret/project": { hasTrustDialogAccepted: true } } }));
  const tuiHome = hMkdtemp(`${hTmp()}/tui-`);
  const cwd = `${tuiHome}/work`;
  prepareTuiHome(realHome, tuiHome, cwd);
  // credentials symlinked (token never copied)
  assert.equal(hReadlink(`${tuiHome}/.claude/.credentials.json`), `${realHome}/.claude/.credentials.json`);
  const seed = JSON.parse(hRead(`${tuiHome}/.claude.json`, "utf8"));
  assert.equal(seed.hasCompletedOnboarding, true);
  assert.equal(seed.theme, "dark");                                   // onboarded config carried over
  assert.equal(seed.projects[cwd].hasTrustDialogAccepted, true);      // scratch cwd trusted
  assert.equal(seed.projects["/old/secret/project"], undefined);      // user project history stripped
  assert.ok(hExists(`${tuiHome}/.claude/projects`));                  // own projects dir
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

// ── resolveTuiEntrypointEnv ───────────────────────────────────────────────
import { resolveTuiEntrypointEnv } from "./lib/tui/session.mjs";

console.log("\nresolveTuiEntrypointEnv:");

test("mode 'cli' sets CLAUDE_CODE_ENTRYPOINT=cli", () => {
  const env = {};
  resolveTuiEntrypointEnv(env, "cli");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "cli");
});

test("mode 'cli' overwrites an inherited CLAUDE_CODE_ENTRYPOINT value", () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  resolveTuiEntrypointEnv(env, "cli");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "cli");
});

test("mode 'auto' deletes CLAUDE_CODE_ENTRYPOINT (leaves unset)", () => {
  const env = {};
  resolveTuiEntrypointEnv(env, "auto");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_ENTRYPOINT"));
});

test("mode 'auto' deletes an inherited CLAUDE_CODE_ENTRYPOINT value", () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  resolveTuiEntrypointEnv(env, "auto");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_ENTRYPOINT"));
});

test("mode 'off' leaves an inherited CLAUDE_CODE_ENTRYPOINT value untouched", () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  resolveTuiEntrypointEnv(env, "off");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "sdk-cli");
});

test("mode 'off' with no inherited value leaves env unchanged", () => {
  const env = { OTHER: "x" };
  resolveTuiEntrypointEnv(env, "off");
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.OTHER, "x");
});

test("default mode (no second arg) behaves like 'cli'", () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" };
  resolveTuiEntrypointEnv(env);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "cli");
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
  return needle.length >= 3 && flatPane.includes(needle);
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
test("tuiPromptLanded(READY_PANE, 'ping') === false  (needle <3 chars, placeholder present)", () => {
  assert.equal(_tuiPromptLanded(TUI_READY_PANE, "ping"), false);
});
test("tuiPromptLanded('❯ ping\\n  ? for shortcuts', 'ping') === true  (needle present, no placeholder)", () => {
  assert.equal(_tuiPromptLanded("❯ ping\n  ? for shortcuts", "ping"), true);
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

test("models.json aliases.sonnet === 'claude-sonnet-4-6' (default-request-model SPOT)", () => {
  assert.equal(_spotModels.aliases.sonnet, "claude-sonnet-4-6");
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

// ── Cleanup ──
closeDb();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
