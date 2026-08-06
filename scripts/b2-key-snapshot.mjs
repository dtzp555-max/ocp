#!/usr/bin/env node
/**
 * B.2 response key-set snapshot — the wire-side replacement for the ADR 0012 prose grep (#346).
 *
 * WHY THIS EXISTS
 * ---------------
 * ADR 0012 grants a standing authorization for additive read-only fields on grandfathered
 * Class B.2 endpoints, and its condition 5 requires the author to write "additive under ADR 0012"
 * plus the field names into the PR body and the CHANGELOG. `CLAUDE.md`'s release_kit sweep used to
 * READ that prose with a grep. That grep missed a condition-5-compliant spelling three times
 * running (#338, then twice inside #344's review), each time caught by a human and never by the
 * mechanism, and #346 recorded the verdict: prose reference formatting is not a closed symbol set,
 * so no regex is complete over it.
 *
 * The spelling problem was only the symptom. Every version of that grep — including a perfect one —
 * can see only additions whose author WROTE the marker. A field added with no marker yields
 * "none this cycle": a green result for the exact case the audit is least able to see, and the
 * exact shape of the four pre-#288 additions that motivated ADR 0012 in the first place.
 *
 * This module reads the WIRE instead. It boots a real `server.mjs`, probes every Class B.2
 * endpoint+method pair in `ALIGNMENT.md` § "Current Class B inventory", and records each
 * response's recursive KEY SET (never its values). The record is checked in at
 * `docs/governance/b2-response-keys.json`; the test suite fails on any difference. An author who
 * adds a field must update the snapshot, and the snapshot's git history is the per-release record
 * of how B.2 surface actually grew — independent of whether anyone wrote a marker.
 *
 * WHAT IT DOES NOT SEE is enumerated in TWO places, and deliberately not here: the snapshot
 * file's own `notCovered` block (13 entries, each tagged [measured] or [reasoned]) and
 * `CLAUDE.md`'s `governance_audits.blind_spots` (7 headline items). This header keeps no third
 * copy — a third would be the one that goes stale. Read one of those two before treating a green
 * run as coverage.
 *
 * USAGE
 *   node scripts/b2-key-snapshot.mjs            # probe a fresh server, print the diff, exit 1 on drift
 *   node scripts/b2-key-snapshot.mjs --write    # probe a fresh server and rewrite the snapshot
 *   node scripts/b2-key-snapshot.mjs --print    # probe and dump the records as JSON
 *
 * The test suite imports `makeB2Fixture` / `probeB2KeySets` / `diffB2KeySets` and drives them
 * through its own live-server harness, so the FIXTURE (which is what determines the key sets)
 * is single-sourced here and cannot drift between the CLI and the test.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

export const SNAPSHOT_PATH = join(REPO_ROOT, "docs", "governance", "b2-response-keys.json");
export const ALIGNMENT_PATH = join(REPO_ROOT, "ALIGNMENT.md");
export const SERVER_PATH = join(REPO_ROOT, "server.mjs");

// ── Key-set extraction ──────────────────────────────────────────────────────
/**
 * Recursive key paths of a decoded JSON response. VALUES ARE NEVER RECORDED — that is the whole
 * point: uptime, timestamps and counters must not make the snapshot flap.
 *
 *   { a: 1 }                 -> ["a"]
 *   { a: null }              -> ["a"]           present-but-null IS in the key set …
 *   { }                      -> []              … and absent is not. /health's `instanceName`
 *                                               deliberately ships as "" rather than being
 *                                               omitted (#327) precisely so consumers can tell
 *                                               those apart; this preserves that distinction.
 *   { a: { b: 1 } }          -> ["a", "a.b"]
 *   { a: [] }                -> ["a", "a[]"]    the "[]" marker records that the value is an
 *                                               ARRAY, so array->object is a visible change even
 *                                               when the array is empty.
 *   { a: [{b:1},{c:2}] }     -> ["a","a[]","a[].b","a[].c"]   union over elements
 */
export function responseKeyPaths(value) {
  const out = new Set();
  walk(value, "", out);
  return [...out].sort();
}

function walk(value, prefix, out) {
  if (Array.isArray(value)) {
    out.add(`${prefix}[]`);
    for (const el of value) walk(el, `${prefix}[]`, out);
    return;
  }
  // `typeof null === "object"`, so the null guard has to come first or a null value would be
  // treated as an empty object — which is the same OUTPUT here but for the wrong reason, and
  // would break the moment someone reads this as "objects recurse".
  if (value === null || typeof value !== "object") return;
  for (const k of Object.keys(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p);
    walk(value[k], p, out);
  }
}

// ── ALIGNMENT.md inventory parsing ──────────────────────────────────────────
/**
 * Parse the Class B.2 rows out of `ALIGNMENT.md` § "Current Class B inventory" and expand them
 * into `METHOD /path` pairs. The constitution is the authority on what the inventory IS, so the
 * probe plan is checked against it rather than against a hand-kept list that can silently fall
 * behind — a new B.2 endpoint added to the inventory with no probe added here fails the suite.
 *
 * Returns [] on a table the parser does not recognise; callers MUST assert the result is
 * non-empty (anchor-drift guard — an unrecognised table would otherwise "cover" everything
 * vacuously).
 */
export function parseB2Inventory(alignmentText) {
  const pairs = [];
  for (const line of alignmentText.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map(c => c.trim());
    // cells[0] is the empty string before the leading pipe.
    const [, endpointCell, methodCell, bucketCell] = cells;
    if (!endpointCell || !bucketCell || !bucketCell.includes("B.2")) continue;
    const m = endpointCell.match(/^`([^`]+)`$/);
    if (!m) continue;
    for (const method of methodCell.split(",").map(s => s.trim()).filter(Boolean)) {
      if (!/^[A-Z]+$/.test(method)) continue;
      pairs.push(`${method} ${m[1]}`);
    }
  }
  return pairs;
}

// ── Fixture ─────────────────────────────────────────────────────────────────
// A `claude` that never touches the network. The stdin branch exists so ONE request can be made
// to fail on demand: `/health` and `/status` both expose `recentErrors[]`, and without a real
// error that array is empty and its ELEMENT shape goes unrecorded — a silent hole of exactly the
// kind this mechanism exists to close.
const FIXTURE_CLAUDE = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
stdin_payload=$(cat)
case "$stdin_payload" in
  *OCP_B2_FORCE_ERROR*) echo "forced upstream failure (b2 key-set fixture)" >&2; exit 3 ;;
esac
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}'
printf '%s\\n' '{"type":"result"}'
exit 0
`;

// `/status` calls fetchUsageFromApi(), which reads OAuth credentials from (1) the environment,
// (2) $HOME/.claude/.credentials.json, (3) the macOS keychain via `security find-generic-password`.
// On a developer's Mac step (3) SUCCEEDS, and /status would then make a REAL billed request to
// api.anthropic.com — non-deterministic, network-dependent, and quota-spending inside `npm test`.
// A `security` that exits non-zero, first on PATH, closes the last of the three. With all three
// closed, fetchUsageFromApi() returns its no-token error WITHOUT any network call, and /status's
// shape is identical on a dev Mac and on a bare CI runner.
const FIXTURE_SECURITY = "#!/bin/sh\nexit 1\n";

// handleLogs reads $HOME/.openclaw/logs/proxy.log — a file server.mjs never writes (logEvent goes
// to stdout/stderr; the file is the service manager's redirect). Left to the ambient HOME it is
// the developer's own production log on one machine and absent on CI, so /logs would record a
// different key set (or a 500) depending on where the suite ran. Seeded here with a single
// NON-JSON line: that is the one part of an entry server.mjs actually constructs — the
// `{ raw: line }` fallback — so `entries[].raw` is genuine response surface. JSON-parseable lines
// pass through verbatim, so THEIR keys belong to whatever wrote the log, not to the endpoint, and
// seeding one would record non-surface as surface.
const FIXTURE_LOG_LINE = "ocp b2 key-set fixture line (deliberately not JSON)\n";

/**
 * Create the scratch dirs, fake binaries and environment that pin every response's SHAPE.
 * Returns { env, dir, home, cleanup }. `env` is merged over the caller's own base environment.
 */
export function makeB2Fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocp-b2-"));
  const home = mkdtempSync(join(tmpdir(), "ocp-b2-home-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);

  const claude = join(dir, "claude");
  writeFileSync(claude, FIXTURE_CLAUDE);
  chmodSync(claude, 0o755);

  const security = join(bin, "security");
  writeFileSync(security, FIXTURE_SECURITY);
  chmodSync(security, 0o755);

  mkdirSync(join(home, ".openclaw", "logs"), { recursive: true });
  writeFileSync(join(home, ".openclaw", "logs", "proxy.log"), FIXTURE_LOG_LINE);

  return {
    dir,
    home,
    claude,
    env: {
      // Store isolation. keys.mjs honours OCP_DIR_OVERRIDE only when NODE_ENV=test, so both are
      // load-bearing: without the pair, POST /api/keys writes to the operator's real key store.
      NODE_ENV: "test",
      OCP_DIR_OVERRIDE: dir,
      OCP_SKIP_AUTH_TEST: "1",
      CLAUDE_BIN: claude,
      CLAUDE_BIND: "127.0.0.1",
      CLAUDE_AUTH_MODE: "none",
      CLAUDE_CACHE_TTL: "0",
      CLAUDE_TIMEOUT: "4000",
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      // Empty, not deleted: getOAuthCredentials() tests truthiness, so "" takes the same branch as
      // absent while still overriding an inherited real token.
      CLAUDE_CODE_OAUTH_TOKEN: "",
      // ── Everything below pins a response SHAPE, not just a value. Each one has been checked
      //    against server.mjs; changing any of them changes what the snapshot records.
      // CLAUDE_SKIP_PERMISSIONS=true makes /health's config.allowedTools a STRING instead of an
      // array, i.e. `config.allowedTools[]` disappears from the key set.
      CLAUDE_SKIP_PERMISSIONS: "false",
      // TUI mode replaces /health's `spawn` block with a 3-key variant that has no `reason`.
      CLAUDE_TUI_MODE: "false",
      // Value-only, but pinned so an ambient export cannot make one machine's run differ.
      OCP_INSTANCE_NAME: "",
      PROXY_ADVERTISE_ANON_KEY: "0",
    },
    cleanup() {
      // Never throw from cleanup: in a test this runs in a `finally`, where a throw would REPLACE
      // the real assertion error and make a stray temp file look like a regression.
      for (const p of [dir, home]) {
        try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
      }
    },
  };
}

// ── Probe plan ──────────────────────────────────────────────────────────────
// Ordered. Read-only probes run before the mutating ones that would invalidate them: GET /sessions
// before DELETE /sessions, GET /cache/stats before DELETE /cache, the key probes before the key is
// revoked. `:id` is substituted with the id of the key created by the POST /api/keys probe, and
// each record is filed under the INVENTORY's spelling of the path so the coverage check can match
// it against ALIGNMENT.md directly.
//
// REQUEST-SHAPED RESPONSES ARE A CATEGORY, not a one-off — ask about every probe you add.
// Some handlers echo the request, so the recorded key set is decided by the BODY BELOW rather
// than by the server, and this snapshot can never detect an addition inside such a sub-object.
// Two of the probes here are in that category and are handled differently on purpose:
//   PATCH /api/keys/:id/quota  sends all three dimensions, so the echo is complete.
//   PATCH /settings            echoes one results.<key> per setting in the body; measured,
//                              {timeout} gives results.timeout{,.ok,.value} and {cacheTTL} gives
//                              results.cacheTTL{,.ok,.value}. The body is pinned to {timeout};
//                              changing it shows up as drift with no server change behind it.
// The quota probe got this right and the settings probe did not, for three lines, until #354's
// review noticed. Writing the rule down once is why this comment exists.
export const B2_PROBE_PLAN = [
  { name: "POST /api/keys", method: "POST", path: "/api/keys", body: { name: "b2-key-snapshot" } },
  { name: "GET /health", method: "GET", path: "/health" },
  { name: "GET /status", method: "GET", path: "/status" },
  { name: "GET /sessions", method: "GET", path: "/sessions" },
  { name: "GET /settings", method: "GET", path: "/settings" },
  { name: "GET /logs", method: "GET", path: "/logs" },
  { name: "GET /dashboard", method: "GET", path: "/dashboard" },
  { name: "GET /api/keys", method: "GET", path: "/api/keys" },
  { name: "GET /api/keys/:id/quota", method: "GET", path: "/api/keys/:id/quota" },
  { name: "GET /api/usage", method: "GET", path: "/api/usage" },
  { name: "GET /cache/stats", method: "GET", path: "/cache/stats" },
  // All three quota dimensions, because this response ECHOES the request: sending only `daily`
  // would record a key set determined by the fixture rather than by the server.
  { name: "PATCH /api/keys/:id/quota", method: "PATCH", path: "/api/keys/:id/quota", body: { daily: 10, weekly: 20, monthly: 30 } },
  { name: "PATCH /settings", method: "PATCH", path: "/settings", body: { timeout: 600000 } },
  { name: "DELETE /api/keys/:id", method: "DELETE", path: "/api/keys/:id" },
  { name: "DELETE /sessions", method: "DELETE", path: "/sessions" },
  { name: "DELETE /cache", method: "DELETE", path: "/cache" },
];

async function request(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
  const text = await res.text();
  let json = null;
  let parsed = false;
  try { json = JSON.parse(text); parsed = true; } catch { /* non-JSON body */ }
  return { status: res.status, contentType, json, parsed, text };
}

/**
 * Drive the whole sequence against an ALREADY-RUNNING server on `port` and return the records,
 * keyed by probe name. Deterministic by construction: two runs against two fresh boots must
 * produce identical output, and the suite asserts exactly that.
 */
export async function probeB2KeySets(port) {
  // Warm-up. Not decoration: without traffic, /api/usage's byKey/recent/timeline are empty arrays
  // and their element shapes go unrecorded, and without a FAILED request recentErrors[] does too.
  await request(port, "POST", "/v1/chat/completions", {
    model: "sonnet", messages: [{ role: "user", content: "b2 key-set warm-up" }],
  });
  await request(port, "POST", "/v1/chat/completions", {
    model: "sonnet", messages: [{ role: "user", content: "OCP_B2_FORCE_ERROR" }],
  });

  const records = {};
  let keyId = null;
  for (const probe of B2_PROBE_PLAN) {
    const path = probe.path.replace(":id", keyId === null ? "missing-key" : String(keyId));
    const r = await request(port, probe.method, path, probe.body);
    if (probe.name === "POST /api/keys") keyId = r.json?.id ?? null;
    records[probe.name] = {
      status: r.status,
      contentType: r.contentType,
      keys: r.parsed ? responseKeyPaths(r.json) : null,
    };
  }
  return records;
}

// ── Diffing ─────────────────────────────────────────────────────────────────
/**
 * Compare a recorded snapshot against a fresh probe. Returns null when they agree, otherwise a
 * multi-line, actionable message. Deliberately reports ADDITIONS and REMOVALS separately: only
 * additions can be covered by ADR 0012, and a removal is a contract change that needs its own ADR.
 */
export function diffB2KeySets(expected, actual) {
  const lines = [];
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const name of names) {
    const e = expected[name];
    const a = actual[name];
    if (!e) { lines.push(`  ${name}`, `      ! probed but ABSENT from the snapshot`); continue; }
    if (!a) { lines.push(`  ${name}`, `      ! in the snapshot but NOT PROBED`); continue; }
    const detail = [];
    if (e.status !== a.status) detail.push(`      ! status ${e.status} -> ${a.status}`);
    if (e.contentType !== a.contentType) detail.push(`      ! content-type ${e.contentType} -> ${a.contentType}`);
    const eKeys = e.keys, aKeys = a.keys;
    if (eKeys === null && aKeys !== null) {
      detail.push(`      ! recorded as a non-JSON body, now returns JSON with ${aKeys.length} key paths`);
    } else if (eKeys !== null && aKeys === null) {
      detail.push(`      ! recorded as JSON, now returns a non-JSON body`);
    } else if (eKeys && aKeys) {
      for (const k of aKeys) if (!eKeys.includes(k)) detail.push(`      + ${k}`);
      for (const k of eKeys) if (!aKeys.includes(k)) detail.push(`      - ${k}`);
    }
    if (detail.length) lines.push(`  ${name}`, ...detail);
  }
  if (!lines.length) return null;
  return [
    "Class B.2 response surface differs from the checked-in key-set snapshot.",
    `Snapshot: docs/governance/b2-response-keys.json`,
    "",
    ...lines,
    "",
    "  +  a key the server now returns and the snapshot does not have",
    "  -  a key the snapshot has and the server no longer returns",
    "",
    "WHAT TO DO",
    "  + ADDED key — this is a response-shape change on a grandfathered Class B.2 endpoint.",
    "    Either revert the addition, or: check ADR 0012's six conditions, state",
    "    'additive under ADR 0012' with the exact field names in BOTH the PR body and the",
    "    CHANGELOG entry (condition 5), and update the snapshot with",
    "      node scripts/b2-key-snapshot.mjs --write",
    "  - REMOVED / renamed / retyped key, changed status, changed content-type — NOT covered by",
    "    ADR 0012. Condition 1 is 'additive only'; ADR 0006's grandfather clause makes this a new",
    "    authorization request. It needs its OWN ADR, merged with or before this PR.",
    "  If neither describes your change, the probe plan or the fixture drifted — read",
    "  scripts/b2-key-snapshot.mjs before touching the snapshot.",
  ].join("\n");
}

export function readB2Snapshot() {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function freePort() {
  const srv = createServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r));
  return port;
}

async function cliBootAndProbe() {
  const fixture = makeB2Fixture();
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...fixture.env, CLAUDE_PROXY_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { err += d; });
  try {
    const t0 = Date.now();
    while (!out.includes("listening on") && child.exitCode === null && Date.now() - t0 < 60000) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (!out.includes("listening on")) {
      throw new Error(`server.mjs did not start\nstdout: ${out.slice(0, 800)}\nstderr: ${err.slice(0, 800)}`);
    }
    return await probeB2KeySets(port);
  } finally {
    child.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 250));
    fixture.cleanup();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = process.argv.includes("--write");
  const print = process.argv.includes("--print");
  const records = await cliBootAndProbe();
  if (print) {
    console.log(JSON.stringify(records, null, 2));
    process.exit(0);
  }
  const snapshot = readB2Snapshot();
  if (write) {
    snapshot.probes = records;
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`wrote ${SNAPSHOT_PATH}`);
    console.log("Now state the added field names in the PR body AND the CHANGELOG (ADR 0012 condition 5).");
    process.exit(0);
  }
  const drift = diffB2KeySets(snapshot.probes, records);
  if (drift) { console.error(drift); process.exit(1); }
  console.log("B.2 response key sets match the snapshot.");
}
