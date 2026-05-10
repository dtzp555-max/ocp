import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
    } catch { /* swallow */ }
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
