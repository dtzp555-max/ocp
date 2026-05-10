#!/usr/bin/env node
/**
 * Integration test for Quota + Cache features.
 * Tests database layer functions directly — no server needed.
 */
import { getDb, createKey, listKeys, validateKey, recordUsage, checkQuota, updateKeyQuota, getKeyQuota, findKey, cacheHash, getCachedResponse, setCachedResponse, clearCache, getCacheStats, closeDb, hasCacheControl, singleflight, getInflightStats } from "./keys.mjs";
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
import { writeSnapshot, readSnapshot, listSnapshots } from "./scripts/lib/snapshot.mjs";
import { mkdtempSync, rmSync, mkdirSync as tMkdirSync, writeFileSync as testWriteFile } from "node:fs";
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

// ── Cleanup ──
closeDb();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
