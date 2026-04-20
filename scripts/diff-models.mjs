#!/usr/bin/env node
// scripts/diff-models.mjs
// Usage: node scripts/diff-models.mjs <models-json-path> <server-mjs-path>
//
// Reads Anthropic /v1/models response JSON and the server.mjs source,
// then prints {added, removed} JSON to stdout.
//
// added   = canonical ids present in API but missing from MODEL_MAP
// removed = canonical ids present in MODEL_MAP but missing from API
//
// Only canonical ids (matching /^claude-[a-z]+-\d/) are considered.
// Short aliases like "opus", "sonnet", "haiku" are intentionally ignored —
// bumping those is a human decision (surfaced in the PR body).

import { readFileSync } from "node:fs";

const CANONICAL_RE = /^claude-[a-z]+-\d/;

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/diff-models.mjs <models-json-path> <server-mjs-path>");
  process.exit(2);
}

const [, , modelsJsonPath, serverMjsPath] = process.argv;
if (!modelsJsonPath || !serverMjsPath) usage();

// ── 1. Parse Anthropic /v1/models payload ──────────────────────────────
const apiPayload = JSON.parse(readFileSync(modelsJsonPath, "utf8"));
const apiData = Array.isArray(apiPayload?.data) ? apiPayload.data : [];

const apiModels = new Map(); // id → display_name
for (const m of apiData) {
  if (!m || typeof m.id !== "string") continue;
  if (!CANONICAL_RE.test(m.id)) continue;
  apiModels.set(m.id, m.display_name || m.id);
}

// ── 2. Extract MODEL_MAP keys and MODELS[].id from server.mjs ──────────
const src = readFileSync(serverMjsPath, "utf8");

function extractBlock(source, openMarker, openChar, closeChar) {
  const startIdx = source.indexOf(openMarker);
  if (startIdx < 0) return "";
  const braceStart = source.indexOf(openChar, startIdx);
  if (braceStart < 0) return "";
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return "";
}

const mapBlock = extractBlock(src, "const MODEL_MAP = {", "{", "}");
const modelsBlock = extractBlock(src, "const MODELS = [", "[", "]");

const mapKeys = new Set();
for (const m of mapBlock.matchAll(/"([^"]+)"\s*:/g)) {
  const k = m[1];
  if (CANONICAL_RE.test(k)) mapKeys.add(k);
}

const modelsIds = new Set();
for (const m of modelsBlock.matchAll(/id\s*:\s*"([^"]+)"/g)) {
  const k = m[1];
  if (CANONICAL_RE.test(k)) modelsIds.add(k);
}

// Union of canonical ids already declared in server.mjs. A model is considered
// "missing" only if neither structure knows it.
const knownIds = new Set([...mapKeys, ...modelsIds]);

// ── 3. Compute diff ────────────────────────────────────────────────────
const added = [];
for (const [id, display_name] of apiModels) {
  if (!knownIds.has(id)) added.push({ id, display_name });
}

const removed = [];
for (const id of knownIds) {
  if (!apiModels.has(id)) removed.push(id);
}

process.stdout.write(JSON.stringify({ added, removed }, null, 2) + "\n");
process.exit(0);
