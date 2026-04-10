// keys.mjs — API key management and usage tracking for OCP LAN mode
// Uses Node.js built-in SQLite (node:sqlite) — zero external dependencies.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
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
  `);
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
    "SELECT id, key, name, created_at, revoked FROM api_keys ORDER BY created_at DESC"
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

export function closeDb() {
  if (db) { db.close(); db = null; }
}
