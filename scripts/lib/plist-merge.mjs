// scripts/lib/plist-merge.mjs
//
// Preserves user-customised env vars when setup.mjs rewrites the unit file.
//
// Rule:
//   - keys present in NEW template → template value wins (template is source of truth)
//   - keys ONLY in EXISTING (not in template) → preserved verbatim
//
// No new dependencies — regex-based, plist <key>X</key><string>Y</string> shape
// is stable enough for our hand-written templates in setup.mjs.
//
// SECURITY DENYLIST (A4): keys that must NEVER be carried into a service unit, even when a
// prior unit already contained them. OCP's key store honors OCP_DIR_OVERRIDE only when
// NODE_ENV === "test" (keys.mjs). If BOTH somehow reached a daemon's environment, the server
// would open a scratch/empty key store instead of ~/.ocp/ocp.db — in AUTH_MODE=multi a silent
// total auth outage. The preservation rule below ("keys only in EXISTING are kept verbatim")
// is exactly a vector for that: a unit that once carried these test-only vars would otherwise
// survive every setup re-run. So we strip them from the preserved set unconditionally. This is
// defense-in-depth: setup.mjs's own template never injects them, so the only way they enter is
// preservation, and this closes it. (The residual path — a hand-rolled `node server.mjs` with
// both vars exported — is out of any launcher's reach; keys.mjs's loud "NOT the default" log is
// the backstop there.)
export const NEVER_PRESERVE = new Set(["NODE_ENV", "OCP_DIR_OVERRIDE"]);

// Note: setup.mjs XML-escapes all injected values before writing (via xmlEscape()),
// so raw `<` / `>` / `&` never appear in plist <string> bodies — the [^<]* regex below is safe.
const PLIST_KV_RE = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;

export function parsePlistEnv(plistContent) {
  if (!plistContent) return {};
  if (Buffer.isBuffer(plistContent)) plistContent = plistContent.toString("utf8");
  // Restrict to the EnvironmentVariables dict to avoid catching Label, etc.
  const envBlock = plistContent.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!envBlock) return {};
  const out = {};
  let m;
  PLIST_KV_RE.lastIndex = 0;
  while ((m = PLIST_KV_RE.exec(envBlock[1])) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

export function mergePlistEnv(existing, template) {
  if (!existing) return template;
  const existingEnv = parsePlistEnv(existing);
  const templateEnv = parsePlistEnv(template);
  const KNOWN = new Set(Object.keys(templateEnv));

  const preserved = {};
  for (const [k, v] of Object.entries(existingEnv)) {
    if (!KNOWN.has(k) && !NEVER_PRESERVE.has(k)) preserved[k] = v;
  }
  if (Object.keys(preserved).length === 0) return template;

  const lines = Object.entries(preserved)
    .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
    .join("\n");

  // Inject before the closing </dict> of EnvironmentVariables
  return template.replace(
    /(<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?)(\n\s*<\/dict>)/,
    `$1\n${lines}$2`
  );
}

const SYSTEMD_KV_RE = /^Environment=([^=]+)=(.*)$/gm;

export function parseSystemdEnv(serviceContent) {
  if (!serviceContent) return {};
  if (Buffer.isBuffer(serviceContent)) serviceContent = serviceContent.toString("utf8");
  const out = {};
  let m;
  SYSTEMD_KV_RE.lastIndex = 0;
  while ((m = SYSTEMD_KV_RE.exec(serviceContent)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

export function mergeSystemdEnv(existing, template) {
  if (!existing) return template;
  const existingEnv = parseSystemdEnv(existing);
  const templateEnv = parseSystemdEnv(template);
  const KNOWN = new Set(Object.keys(templateEnv));

  const preservedLines = Object.entries(existingEnv)
    .filter(([k]) => !KNOWN.has(k) && !NEVER_PRESERVE.has(k))
    .map(([k, v]) => `Environment=${k}=${v}`);
  if (preservedLines.length === 0) return template;

  // Guard: if template has no Environment= anchor, cannot inject — return template as-is.
  // (In practice the OCP systemd template always has Environment= lines.)
  if (!/^Environment=/m.test(template)) return template;

  // Inject after the last existing Environment= line in the template
  return template.replace(
    /(^Environment=[^\n]+\n)((?!Environment=).*$)/ms,
    `$1${preservedLines.join("\n")}\n$2`
  );
}
