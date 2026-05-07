#!/usr/bin/env node
// Idempotently sync OCP's claude-local provider models into OpenClaw's registry.
// Only touches:
//   - config.models.providers["claude-local"].models
//   - config.agents.defaults.models["claude-local/*"] keys
// All other fields and providers are preserved.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const OPENCLAW_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const PROVIDER_NAME = "claude-local";
const QUIET = process.argv.includes("--quiet");

function log(msg) { if (!QUIET) console.log(`  ✓ ${msg}`); }
function warn(msg) { console.warn(`  ⚠ ${msg}`); }

if (!existsSync(OPENCLAW_CONFIG)) {
  log(`OpenClaw not installed at ${OPENCLAW_CONFIG} — skipping (this is fine for non-OpenClaw users)`);
  process.exit(0);
}

const modelsConfig = JSON.parse(readFileSync(join(REPO_ROOT, "models.json"), "utf-8"));
const desiredModels = modelsConfig.models.map(m => ({
  id: m.id,
  name: m.openclawName,
  reasoning: m.reasoning,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
}));
const desiredAliases = Object.fromEntries(
  modelsConfig.models.map(m => [`${PROVIDER_NAME}/${m.id}`, { alias: m.displayName }])
);

const config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf-8"));

// Compute diff before writing
const existingModels = config?.models?.providers?.[PROVIDER_NAME]?.models ?? [];
const existingIds = new Set(existingModels.map(m => m.id));
const desiredIds = new Set(desiredModels.map(m => m.id));
const added = [...desiredIds].filter(id => !existingIds.has(id));
const removed = [...existingIds].filter(id => !desiredIds.has(id));

if (added.length === 0 && removed.length === 0 && existingModels.length === desiredModels.length) {
  // Check deep equality too in case names/maxTokens changed
  const changed = desiredModels.some((d) => {
    const e = existingModels.find(x => x.id === d.id);
    return !e || e.name !== d.name || e.maxTokens !== d.maxTokens;
  });
  if (!changed) {
    log("OpenClaw registry already in sync");
    process.exit(0);
  }
}

// Backup
const backupPath = `${OPENCLAW_CONFIG}.bak.${Date.now()}`;
copyFileSync(OPENCLAW_CONFIG, backupPath);
log(`Backed up to ${backupPath}`);

// Surgical patch: only touch claude-local provider and claude-local/* aliases
if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};
if (!config.models.providers[PROVIDER_NAME]) {
  // First-time registration
  config.models.providers[PROVIDER_NAME] = {
    baseUrl: "http://127.0.0.1:3456/v1",
    api: "openai-completions",
    authHeader: false,
    models: desiredModels,
  };
} else {
  // Update only the models array; leave baseUrl/api/authHeader untouched (user may have customized port)
  config.models.providers[PROVIDER_NAME].models = desiredModels;
}

if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.models) config.agents.defaults.models = {};

// Remove stale claude-local/* aliases, then add desired ones
for (const key of Object.keys(config.agents.defaults.models)) {
  if (key.startsWith(`${PROVIDER_NAME}/`)) delete config.agents.defaults.models[key];
}
Object.assign(config.agents.defaults.models, desiredAliases);

writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n");

if (added.length > 0) log(`Added: ${added.join(", ")}`);
if (removed.length > 0) log(`Removed (no longer in models.json): ${removed.join(", ")}`);
log(`OpenClaw registry synced: ${desiredModels.length} models registered`);
