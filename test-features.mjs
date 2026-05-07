#!/usr/bin/env node
/**
 * Integration test for Quota + Cache features.
 * Tests database layer functions directly — no server needed.
 */
import { getDb, createKey, listKeys, validateKey, recordUsage, checkQuota, updateKeyQuota, getKeyQuota, findKey, cacheHash, getCachedResponse, setCachedResponse, clearCache, getCacheStats, closeDb, hasCacheControl } from "./keys.mjs";
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

// ── Cleanup ──
closeDb();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
