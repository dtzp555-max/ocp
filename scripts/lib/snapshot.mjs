import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

export function writeSnapshot({ homeDir, fromCommit, fromVersion, toVersion, extraFiles = [] }) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const root = join(homeDir, ".ocp", `upgrade-snapshot-${ts}`);
  mkdirSync(root, { recursive: true });

  // Standard manifest files
  writeFileSync(join(root, "from-commit.txt"), fromCommit + "\n");
  writeFileSync(join(root, "from-version.txt"), fromVersion + "\n");
  writeFileSync(join(root, "to-version.txt"), toVersion + "\n");

  // Optional captures (best-effort, never fatal)
  const tryCopy = (src, dst) => {
    try {
      if (existsSync(src)) copyFileSync(src, dst);
    } catch (err) {
      console.error(`[snapshot] warn: could not copy ${src} (${err.code || err.message})`);
    }
  };
  tryCopy(join(homeDir, "Library", "LaunchAgents", "dev.ocp.proxy.plist"), join(root, "plist"));
  tryCopy(join(homeDir, ".config", "systemd", "user", "ocp-proxy.service"), join(root, "service"));
  tryCopy(join(homeDir, ".ocp", "ocp.db"), join(root, "db.bak"));
  tryCopy(join(homeDir, ".ocp", "admin-key"), join(root, "admin-key"));
  tryCopy(join(homeDir, ".openclaw", "openclaw.json"), join(root, "openclaw.json"));

  for (const { src, name } of extraFiles) tryCopy(src, join(root, name));

  return root;
}

export function readSnapshot(snapshotPath) {
  const read = (n) => {
    try { return readFileSync(join(snapshotPath, n), "utf8").trim(); } catch { return null; }
  };
  return {
    path: snapshotPath,
    fromCommit: read("from-commit.txt"),
    fromVersion: read("from-version.txt"),
    toVersion: read("to-version.txt")
  };
}

export function listSnapshots(homeDir) {
  const root = join(homeDir, ".ocp");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(name => name.startsWith("upgrade-snapshot-"))
    .map(name => ({ name, path: join(root, name), mtime: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Garbage-collect old upgrade snapshots.
 *
 * Retention rule (a snapshot is KEPT if any of these is true):
 *   - It is among the last `keepCount` snapshots (sorted oldest→newest)
 *   - Its timestamp is within `keepDays` of `now`
 *   - It is the single most-recent snapshot (always-keep safety net)
 *
 * @param {string} homeDir - Root containing ~/.ocp/
 * @param {object} opts
 * @param {number} [opts.keepCount=5] - Minimum count to keep
 * @param {number} [opts.keepDays=30] - Keep snapshots newer than N days
 * @param {boolean} [opts.dryRun=false] - If true, report plan but don't delete
 * @param {Date} [opts.now=new Date()] - Override clock for testing
 * @returns {{kept: Array, removed: Array, dryRun: boolean}}
 */
export function gcSnapshots(homeDir, opts = {}) {
  const keepCount = opts.keepCount ?? 5;
  const keepDays = opts.keepDays ?? 30;
  const dryRun = !!opts.dryRun;
  const now = opts.now || new Date();

  const all = listSnapshots(homeDir);  // sorted oldest→newest
  if (all.length === 0) return { kept: [], removed: [], dryRun };
  if (all.length === 1) return { kept: all, removed: [], dryRun };  // always keep most recent

  const cutoffMs = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const lastN = new Set(all.slice(-keepCount).map(s => s.path));

  const kept = [], removed = [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    const isMostRecent = i === all.length - 1;
    const isInLastN = lastN.has(s.path);
    const isWithinDays = parseSnapshotTimestamp(s.name) >= cutoffMs;
    if (isMostRecent || isInLastN || isWithinDays) {
      kept.push(s);
    } else {
      removed.push(s);
    }
  }

  if (!dryRun) {
    for (const s of removed) {
      try {
        rmSync(s.path, { recursive: true, force: true });
      } catch (err) {
        console.error(`[snapshot] warn: could not remove ${s.path} (${err.code || err.message})`);
      }
    }
  }

  return { kept, removed, dryRun };
}

function parseSnapshotTimestamp(name) {
  // upgrade-snapshot-2026-05-11T08:30:00Z → epoch ms
  const m = name.match(/upgrade-snapshot-(.+)$/);
  if (!m) return 0;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : 0;
}
