// keys.mjs — API key management and usage tracking for OCP LAN mode
// Uses Node.js built-in SQLite (node:sqlite) — zero external dependencies.
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const OCP_DIR = join(homedir(), ".ocp");
mkdirSync(OCP_DIR, { recursive: true });
const DB_PATH = join(OCP_DIR, "ocp.db");

let db;

export function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id INTEGER,
      key_name TEXT NOT NULL DEFAULT 'anonymous',
      model TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL DEFAULT 0,
      response_chars INTEGER NOT NULL DEFAULT 0,
      elapsed_ms INTEGER NOT NULL DEFAULT 0,
      success INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (key_id) REFERENCES api_keys(id)
    );

    CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_log(key_id);

    CREATE TABLE IF NOT EXISTS response_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT UNIQUE NOT NULL,
      model TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_hit_at TEXT,
      hits INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cache_hash ON response_cache(hash);
    CREATE INDEX IF NOT EXISTS idx_cache_created ON response_cache(created_at);
  `);

  // Idempotent migrations: add quota columns if they don't exist yet.
  for (const col of [
    "ALTER TABLE api_keys ADD COLUMN quota_daily INTEGER DEFAULT NULL",
    "ALTER TABLE api_keys ADD COLUMN quota_weekly INTEGER DEFAULT NULL",
    "ALTER TABLE api_keys ADD COLUMN quota_monthly INTEGER DEFAULT NULL",
  ]) {
    try { db.exec(col); } catch (e) {
      // SQLite throws "duplicate column name" if already present — safe to ignore.
      if (!e.message?.includes("duplicate column")) throw e;
    }
  }
}

// ── Key CRUD ──

export function createKey(name) {
  const key = "ocp_" + randomBytes(24).toString("base64url");
  const d = getDb();
  const stmt = d.prepare("INSERT INTO api_keys (key, name) VALUES (?, ?)");
  const result = stmt.run(key, name);
  return { id: result.lastInsertRowid, key, name };
}

export function listKeys() {
  const d = getDb();
  return d.prepare(
    "SELECT id, key, name, created_at, revoked, quota_daily, quota_weekly, quota_monthly FROM api_keys ORDER BY created_at DESC"
  ).all().map(({ key, ...rest }) => ({
    ...rest,
    keyPreview: key.slice(0, 8) + "..." + key.slice(-4),
  }));
}

export function revokeKey(idOrName) {
  const d = getDb();
  const stmt = d.prepare(
    "UPDATE api_keys SET revoked = 1 WHERE (id = ? OR name = ?) AND revoked = 0"
  );
  return stmt.run(idOrName, idOrName).changes > 0;
}

export function validateKey(key) {
  const d = getDb();
  const row = d.prepare(
    "SELECT id, name FROM api_keys WHERE key = ? AND revoked = 0"
  ).get(key);
  return row || null;
}

// ── Usage recording ──

export function recordUsage({ keyId, keyName, model, promptChars, responseChars, elapsedMs, success }) {
  const d = getDb();
  d.prepare(`
    INSERT INTO usage_log (key_id, key_name, model, prompt_chars, response_chars, elapsed_ms, success)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(keyId ?? null, keyName || "anonymous", model, promptChars, responseChars, elapsedMs, success ? 1 : 0);
}

// ── Usage queries ──

export function getUsageByKey({ since, until } = {}) {
  const d = getDb();
  let where = "WHERE 1=1";
  const params = [];
  if (since) { where += " AND created_at >= ?"; params.push(since); }
  if (until) { where += " AND created_at <= ?"; params.push(until); }

  return d.prepare(`
    SELECT
      key_name,
      COUNT(*) as requests,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as errors,
      SUM(prompt_chars) as total_prompt_chars,
      SUM(response_chars) as total_response_chars,
      SUM(elapsed_ms) as total_elapsed_ms,
      AVG(elapsed_ms) as avg_elapsed_ms,
      MIN(created_at) as first_request,
      MAX(created_at) as last_request
    FROM usage_log
    ${where}
    GROUP BY key_name
    ORDER BY requests DESC
  `).all(...params);
}

export function getUsageTimeline({ keyName, hours = 24 } = {}) {
  const d = getDb();
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  let where = "WHERE created_at >= ?";
  const params = [since];
  if (keyName) { where += " AND key_name = ?"; params.push(keyName); }

  return d.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00', created_at) as hour,
      COUNT(*) as requests,
      SUM(prompt_chars) as prompt_chars,
      SUM(response_chars) as response_chars,
      AVG(elapsed_ms) as avg_elapsed_ms
    FROM usage_log
    ${where}
    GROUP BY hour
    ORDER BY hour
  `).all(...params);
}

export function getRecentUsage(limit = 50) {
  const d = getDb();
  return d.prepare(`
    SELECT key_name, model, prompt_chars, response_chars, elapsed_ms, success, created_at
    FROM usage_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

// ── SQLite datetime helper ──
// SQLite datetime('now') stores as 'YYYY-MM-DD HH:MM:SS' (no T, no Z).
// JavaScript .toISOString() produces 'YYYY-MM-DDTHH:MM:SS.sssZ'.
// String comparison between the two breaks for same-day ranges (T > space).
// This helper formats Date to match SQLite's format for correct comparisons.
function sqliteDatetime(date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

// ── Quota management ──

// Returns { period, limit, used, resetsIn } if a quota is exceeded, null otherwise.
// Anonymous/admin callers (keyId === null) are never subject to quotas.
export function checkQuota(keyId, _keyName) {
  if (keyId === null || keyId === undefined) return null;

  const d = getDb();
  const keyRow = d.prepare(
    "SELECT quota_daily, quota_weekly, quota_monthly FROM api_keys WHERE id = ? AND revoked = 0"
  ).get(keyId);
  if (!keyRow) return null;

  const now = new Date();

  // UTC period boundaries (SQLite-compatible format)
  const startOfToday = sqliteDatetime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const sevenDaysAgo = sqliteDatetime(new Date(Date.now() - 7 * 86400000));
  const thirtyDaysAgo = sqliteDatetime(new Date(Date.now() - 30 * 86400000));

  // Next reset times for human display
  const tomorrowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  function msToHuman(ms) {
    if (ms <= 0) return "now";
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // Single query for all periods (widest window = monthly)
  const row = d.prepare(`
    SELECT
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as daily_cnt,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as weekly_cnt,
      COUNT(*) as monthly_cnt
    FROM usage_log
    WHERE key_id = ? AND success = 1 AND created_at >= ?
  `).get(startOfToday, sevenDaysAgo, keyId, thirtyDaysAgo);

  const checks = [
    { period: "daily",   limit: keyRow.quota_daily,   used: row?.daily_cnt ?? 0,   resetsIn: msToHuman(tomorrowUTC - now) },
    { period: "weekly",  limit: keyRow.quota_weekly,  used: row?.weekly_cnt ?? 0,  resetsIn: "rolling 7-day window" },
    { period: "monthly", limit: keyRow.quota_monthly, used: row?.monthly_cnt ?? 0, resetsIn: "rolling 30-day window" },
  ];

  for (const { period, limit, used, resetsIn } of checks) {
    if (limit === null || limit === undefined) continue;
    if (used >= limit) {
      return { period, limit, used, resetsIn };
    }
  }

  return null;
}

// Set quota for a key. Only updates fields explicitly present in the input object.
// Pass null to clear a specific limit. Omit a field to leave it unchanged.
export function updateKeyQuota(idOrName, updates = {}) {
  const d = getDb();
  const setClauses = [];
  const params = [];
  if ("daily" in updates)  { setClauses.push("quota_daily = ?");  params.push(updates.daily ?? null); }
  if ("weekly" in updates) { setClauses.push("quota_weekly = ?"); params.push(updates.weekly ?? null); }
  if ("monthly" in updates){ setClauses.push("quota_monthly = ?");params.push(updates.monthly ?? null); }
  if (setClauses.length === 0) return false;
  params.push(idOrName, idOrName);
  const result = d.prepare(
    `UPDATE api_keys SET ${setClauses.join(", ")} WHERE id = ? OR name = ?`
  ).run(...params);
  return result.changes > 0;
}

// Returns { daily: { limit, used }, weekly: { limit, used }, monthly: { limit, used } }
export function getKeyQuota(keyId) {
  const d = getDb();
  const keyRow = d.prepare(
    "SELECT quota_daily, quota_weekly, quota_monthly FROM api_keys WHERE id = ?"
  ).get(keyId);
  if (!keyRow) return null;

  const now = new Date();
  const startOfToday  = sqliteDatetime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const sevenDaysAgo  = sqliteDatetime(new Date(Date.now() - 7 * 86400000));
  const thirtyDaysAgo = sqliteDatetime(new Date(Date.now() - 30 * 86400000));

  const row = d.prepare(`
    SELECT
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as daily_cnt,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) as weekly_cnt,
      COUNT(*) as monthly_cnt
    FROM usage_log
    WHERE key_id = ? AND success = 1 AND created_at >= ?
  `).get(startOfToday, sevenDaysAgo, keyId, thirtyDaysAgo);

  return {
    daily:   { limit: keyRow.quota_daily   ?? null, used: row?.daily_cnt ?? 0 },
    weekly:  { limit: keyRow.quota_weekly  ?? null, used: row?.weekly_cnt ?? 0 },
    monthly: { limit: keyRow.quota_monthly ?? null, used: row?.monthly_cnt ?? 0 },
  };
}

// ── Response cache ──

// Generate a cache key from model + messages + request params that affect output.
// opts.keyId isolates per-API-key cache pools (v2 hash format).
// When keyId is absent/null/empty, falls back to "anon" (shared anonymous pool).
export function cacheHash(model, messages, opts = {}) {
  const keyId = opts.keyId || "anon";
  const h = createHash("sha256");
  h.update(`v2|k:${keyId}|`);
  h.update(model);
  if (opts.temperature != null) h.update(`t:${opts.temperature}`);
  if (opts.max_tokens != null) h.update(`mt:${opts.max_tokens}`);
  if (opts.top_p != null) h.update(`tp:${opts.top_p}`);
  for (const m of messages) {
    h.update(m.role || "");
    h.update(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  }
  return h.digest("hex");
}

// Check whether any message (or content part) carries an Anthropic cache_control field.
// If true, OCP should skip its own cache to avoid interfering with prompt-caching intent.
export function hasCacheControl(messages) {
  for (const m of messages || []) {
    if (m && typeof m === "object") {
      if (m.cache_control) return true;
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === "object" && part.cache_control) return true;
        }
      }
    }
  }
  return false;
}

// Look up a cached response. Returns { response, hits } or null.
// Also updates last_hit_at and increments hits counter on hit.
export function getCachedResponse(hash, ttlMs) {
  const d = getDb();
  const cutoff = sqliteDatetime(new Date(Date.now() - ttlMs));
  const row = d.prepare(
    "SELECT id, response, hits FROM response_cache WHERE hash = ? AND created_at >= ?"
  ).get(hash, cutoff);
  if (!row) return null;
  // Update hit stats
  d.prepare("UPDATE response_cache SET hits = hits + 1, last_hit_at = datetime('now') WHERE id = ?").run(row.id);
  return { response: row.response, hits: row.hits + 1 };
}

// Store a response in the cache
export function setCachedResponse(hash, model, response) {
  const d = getDb();
  // Upsert: if hash already exists (race condition), just update
  d.prepare(`
    INSERT INTO response_cache (hash, model, response) VALUES (?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET response = excluded.response, created_at = datetime('now'), hits = 0
  `).run(hash, model, response);
}

// Clear all cached responses, or expired ones only
export function clearCache(ttlMs = null) {
  const d = getDb();
  if (ttlMs === null) {
    const result = d.prepare("DELETE FROM response_cache").run();
    return result.changes;
  }
  const cutoff = sqliteDatetime(new Date(Date.now() - ttlMs));
  const result = d.prepare("DELETE FROM response_cache WHERE created_at < ?").run(cutoff);
  return result.changes;
}

// Get cache statistics
export function getCacheStats() {
  const d = getDb();
  const total = d.prepare("SELECT COUNT(*) as cnt FROM response_cache").get()?.cnt ?? 0;
  const totalHits = d.prepare("SELECT SUM(hits) as total FROM response_cache").get()?.total ?? 0;
  const sizeBytes = d.prepare("SELECT SUM(LENGTH(response)) as size FROM response_cache").get()?.size ?? 0;
  return { entries: total, totalHits, sizeBytes };
}

// ── Singleflight stampede protection ──

// In-memory singleflight Map: hash → { promise, requesters }
// Deduplicates concurrent identical cache-miss flows so only one upstream call runs.
// Per ADR 0005 / spec D4: in-process scope only (single Node process per host).
const inflightMap = new Map();

export function singleflight(hash, fn) {
  const existing = inflightMap.get(hash);
  if (existing) {
    existing.requesters++;
    return existing.promise;
  }
  // Wrap fn() in Promise.resolve().then() so synchronous throws don't escape.
  const promise = Promise.resolve().then(fn).finally(() => {
    inflightMap.delete(hash);
  });
  inflightMap.set(hash, { promise, requesters: 1 });
  return promise;
}

export function getInflightStats() {
  let totalRequesters = 0;
  for (const entry of inflightMap.values()) totalRequesters += entry.requesters;
  return {
    inflight: inflightMap.size,
    requesters: totalRequesters,
  };
}

// Find a key by id or name (returns { id, name } or null)
export function findKey(idOrName) {
  const d = getDb();
  return d.prepare("SELECT id, name FROM api_keys WHERE id = ? OR name = ?").get(idOrName, idOrName) || null;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}
