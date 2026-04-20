#!/usr/bin/env node
// scripts/patch-server-mjs.mjs
// Usage: node scripts/patch-server-mjs.mjs <diff-json-path> <server-mjs-path>
//
// Reads the {added, removed} diff produced by diff-models.mjs and inserts
// new canonical ids into MODEL_MAP and MODELS in server.mjs.
//
// Rules:
//  - Only `added` entries are applied. `removed` is surfaced in the PR body
//    as a human decision (deprecation is not auto-applied).
//  - Short aliases (opus / sonnet / haiku) are never touched here — bumping
//    them to a new version is a human decision.
//  - Zero dependencies. Regex-based string insertion.
//  - Existing 2-space indentation is preserved.

import { readFileSync, writeFileSync } from "node:fs";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/patch-server-mjs.mjs <diff-json-path> <server-mjs-path>");
  process.exit(2);
}

const [, , diffJsonPath, serverMjsPath] = process.argv;
if (!diffJsonPath || !serverMjsPath) usage();

const diff = JSON.parse(readFileSync(diffJsonPath, "utf8"));
const added = Array.isArray(diff?.added) ? diff.added : [];

if (added.length === 0) {
  console.error("patch-server-mjs: no additions — nothing to do");
  process.exit(0);
}

let src = readFileSync(serverMjsPath, "utf8");

// ── 1. Insert into MODEL_MAP ───────────────────────────────────────────
// Strategy: find the MODEL_MAP block, walk its lines, and insert new
// `"<id>": "<id>",` lines after the last canonical-id line (before the
// short aliases like "opus"/"sonnet"/"haiku").
const CANONICAL_LINE_RE = /^(\s*)"(claude-[a-z]+-\d[^"]*)"\s*:\s*"[^"]+"\s*,?\s*$/;

const mapOpen = src.indexOf("const MODEL_MAP = {");
if (mapOpen < 0) {
  console.error("patch-server-mjs: MODEL_MAP not found in server.mjs");
  process.exit(1);
}
const mapBraceStart = src.indexOf("{", mapOpen);
let depth = 0;
let mapBraceEnd = -1;
for (let i = mapBraceStart; i < src.length; i++) {
  if (src[i] === "{") depth++;
  else if (src[i] === "}") {
    depth--;
    if (depth === 0) { mapBraceEnd = i; break; }
  }
}
if (mapBraceEnd < 0) {
  console.error("patch-server-mjs: MODEL_MAP closing brace not found");
  process.exit(1);
}

const mapBody = src.slice(mapBraceStart + 1, mapBraceEnd);
const mapLines = mapBody.split("\n");

// Find the index of the last line that declares a canonical id.
let lastCanonicalIdx = -1;
let indent = "  ";
for (let i = 0; i < mapLines.length; i++) {
  const m = mapLines[i].match(CANONICAL_LINE_RE);
  if (m) {
    lastCanonicalIdx = i;
    indent = m[1] || "  ";
  }
}
if (lastCanonicalIdx < 0) {
  console.error("patch-server-mjs: no canonical-id line found in MODEL_MAP");
  process.exit(1);
}

const newMapLines = [];
for (const entry of added) {
  newMapLines.push(`${indent}"${entry.id}": "${entry.id}",`);
}
mapLines.splice(lastCanonicalIdx + 1, 0, ...newMapLines);

const patchedMapBody = mapLines.join("\n");
src = src.slice(0, mapBraceStart + 1) + patchedMapBody + src.slice(mapBraceEnd);

// ── 2. Insert into MODELS array ────────────────────────────────────────
const modelsOpen = src.indexOf("const MODELS = [");
if (modelsOpen < 0) {
  console.error("patch-server-mjs: MODELS not found in server.mjs");
  process.exit(1);
}
const arrStart = src.indexOf("[", modelsOpen);
depth = 0;
let arrEnd = -1;
for (let i = arrStart; i < src.length; i++) {
  if (src[i] === "[") depth++;
  else if (src[i] === "]") {
    depth--;
    if (depth === 0) { arrEnd = i; break; }
  }
}
if (arrEnd < 0) {
  console.error("patch-server-mjs: MODELS closing bracket not found");
  process.exit(1);
}

const arrBody = src.slice(arrStart + 1, arrEnd);
const arrLines = arrBody.split("\n");

// Find the last existing `{ id: "...", name: "..." }` line for indent reference
let lastModelIdx = -1;
let modelIndent = "  ";
for (let i = 0; i < arrLines.length; i++) {
  const m = arrLines[i].match(/^(\s*)\{\s*id\s*:\s*"[^"]+"/);
  if (m) {
    lastModelIdx = i;
    modelIndent = m[1] || "  ";
  }
}

const newModelLines = [];
for (const entry of added) {
  const name = (entry.display_name || entry.id).replace(/"/g, '\\"');
  newModelLines.push(`${modelIndent}{ id: "${entry.id}", name: "${name}" },`);
}

if (lastModelIdx >= 0) {
  arrLines.splice(lastModelIdx + 1, 0, ...newModelLines);
} else {
  // Empty MODELS — inject just before the closing bracket line.
  arrLines.splice(arrLines.length - 1, 0, ...newModelLines);
}

const patchedArrBody = arrLines.join("\n");
src = src.slice(0, arrStart + 1) + patchedArrBody + src.slice(arrEnd);

writeFileSync(serverMjsPath, src);
console.error(`patch-server-mjs: inserted ${added.length} model(s) into MODEL_MAP and MODELS`);
