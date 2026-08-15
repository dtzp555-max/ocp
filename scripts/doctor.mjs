#!/usr/bin/env node
/**
 * scripts/doctor.mjs — OCP health & upgrade-readiness check.
 *
 * Usage:
 *   ocp doctor                  human-readable PASS/WARN/FAIL
 *   ocp doctor --json           machine-readable JSON for AI agents + ocp update
 *   ocp doctor --check oauth    fast path: only OAuth check
 *
 * Exit codes:
 *   0  all PASS or WARN-only
 *   1  any FAIL
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { DEFAULT_PORT, AUTH_STALE_AFTER_INCONCLUSIVE } from "../lib/constants.mjs";
import { resolveInstallDir, classifyInstallDir } from "./lib/install-dir.mjs";

const SCHEMA_VERSION = "1";

function semverParts(v) {
  const m = String(v).replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function semverCompare(a, b) {
  const A = semverParts(a), B = semverParts(b);
  if (!A || !B) return 0;
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  return A.patch - B.patch;
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-unit boot-race pre-flight check (issue #220, incident #215)
//
// On a real host, a system-scope systemd unit (/etc/systemd/system/ocp.service,
// bind 0.0.0.0) and a user-scope systemd unit (~/.config/systemd/user/
// ocp-proxy.service, bind 127.0.0.1) were BOTH enabled and BOTH pointed at the
// same server.mjs working tree and the same port, with drifted config. Whichever
// won the boot race silently decided the host's LAN reachability. Nothing in
// `ocp doctor` surfaced this; it was found by hand while diagnosing an unrelated
// update failure. See issue #215 for the live evidence table.
//
// Relationship to scripts/lib/restart-unit.mjs: introduced by PR #221 (merged)
// — issue #215's OTHER half — to resolve which unit CURRENTLY owns the port
// from LIVE process/cgroup state (ss/lsof + /proc/<pid>/cgroup) for the
// upgrade restart phase — a live-PID question. This check answers a
// different, STATIC question — which units WOULD start at boot, and are any
// two of them configured to collide on the same port — by reading unit-file
// config (`systemctl show` ExecStart/Environment, or plist content on macOS),
// never a live PID. No logic is shared or duplicated between the two; this
// module intentionally does not import restart-unit.mjs — the two checks are
// independent by design, not because one was waiting on the other to land.
//
// WARN, never FAIL: scripts/upgrade.mjs's runUpgrade() pre-flight guard only
// tolerates ready_to_upgrade=false for next_action.kind="fresh_install" — a
// FAIL here would block every future `ocp update` on an affected host,
// including the update that might fix the drift. The units' config could also
// legitimately differ for reasons this check cannot know (e.g. a deliberate
// blue/green setup) — WARN surfaces the hazard without itself becoming a new
// outage vector.
//
// Enumeration strategy: matching on unit NAME is fragile (a host may name a
// unit anything — the field incident's units were "ocp.service" and
// "ocp-proxy.service", nothing guarantees that pattern elsewhere), so instead
// every ENABLED unit's config is read and fingerprinted by whether its
// ExecStart (Linux) / ProgramArguments (macOS) actually invokes server.mjs, and
// from where.
//
// Grouping key: PORT ALONE (review finding MED-3.7 on #230 — see PR body for
// the full discussion). #220's own text is "detect when more than one enabled
// unit ... targets the OCP port" and #215's is "points at the same port"; an
// earlier revision of this check additionally required the working tree to
// match, reasoning from the single observed incident's shape rather than the
// stated requirement, and did so without flagging the narrowing as a
// narrowing. That was wrong on the merits too: two units on the same port from
// DIFFERENT trees still race for the port and would serve DIFFERENT code to
// whoever wins — arguably a worse outcome than the field incident, not a
// lesser one, and a host in that state has two entirely separate installs
// nobody may even realize both auto-start. Working tree is therefore reported
// in the WARN message (same tree vs different trees) to help diagnose the
// hazard, but no longer gates whether it fires.
//
// KNOWN LIMITATION (review round 3 on #230, discretionary): grouping by port
// alone means two units bound to distinct, SPECIFIC, non-wildcard addresses on
// the SAME port (e.g. one on loopback and another on a specific LAN address)
// will warn even though they don't actually contend — each can bind its own
// address without colliding. This is a deliberate false-positive-tolerant
// tradeoff, not an oversight: distinguishing "genuinely non-contending" from
// "contends because at least one side is a wildcard (0.0.0.0/::/unset)"
// reliably requires knowing this host's real default-bind semantics when
// CLAUDE_BIND is unset,
// which this check does not attempt to model. Accepted as a rare, WARN-only
// (never FAIL) false positive rather than adding that inference.
//
// Cost: Linux — up to 4 real subprocess spawns total regardless of host size
// (two `list-unit-files` calls to enumerate enabled *.service names, then at
// most one BATCHED `systemctl show` call per scope covering every candidate at
// once — never one spawn per unit; the extra `-p UnitFileState -p
// EnvironmentFiles` properties added by this revision ride the SAME batched
// call, zero extra spawns). macOS — 3 spawns (one enumerates every candidate
// plist in one shell command; two read `launchctl print-disabled` — gui/<uid>
// and system, both unprivileged, verified — to exclude units an operator has
// persistently disabled in either domain). A missing/erroring systemctl,
// or an unreadable listing, degrades the WHOLE check to "unknown" — which now
// pushes a low-severity INFO line (review finding MED-3.5) rather than nothing
// at all, so "verified clear" and "couldn't verify" are distinguishable from
// outside the process, not just internally. See classifyMultiUnitRisk's
// null-vs-"" discipline below, which mirrors restart-unit.mjs's own "ss
// returned nothing we could parse" vs "ss never ran" distinction.
//
// ─── Issue #327: telling a DECLARED second instance from a leftover duplicate ───
//
// The check above was written before OCP had any way for an instance to say who
// it is, so multiplicity and duplication were the same observation. `OCP_INSTANCE_NAME`
// (server.mjs's INSTANCE_NAME, surfaced on /health as `instanceName`, shipped v3.29.0) is the
// discriminator that was missing. This section reads it.
//
// WHERE THE DECLARATION IS READ FROM, and why the other source was rejected.
// Two sources exist and they answer different questions:
//
//   - `/health`.instanceName is the RUNTIME truth, and it is the wrong one here for
//     three independent reasons, any one of which is disqualifying. (a) This check's
//     stated question is STATIC — "which units WOULD start at boot" (see the module
//     comment above: "reading unit-file config ... never a live PID"). (b) doctor runs
//     before and around a restart, so an instance may legitimately not be answering;
//     an answer that changes depending on whether the host is mid-upgrade is not an
//     answer. (c) Decisively: a leftover duplicate unit is typically ENABLED BUT NOT
//     RUNNING — it lost the last boot race, or was superseded and never started. It
//     has no /health to read. So the one source that can see the defect this check
//     exists to find is the unit file, and the one that cannot is /health. Probing it
//     would also cost one extra subprocess per candidate port.
//   - The unit's own `Environment=` / the plist's `EnvironmentVariables` is the
//     operator's declared INTENT, is present whether the instance is up or down, and
//     — because `systemctl show -p Environment` is ALREADY in this check's single
//     batched call — costs zero additional spawns. It is also the same property the
//     port and bind address are already read from, so the declaration is established
//     at exactly the authority level of the thing it qualifies.
//
// So: unit config, exclusively. There is deliberately NO precedence rule and no
// /health fallback — a rule of the form "read the unit, else ask /health" would make
// the verdict depend on whether the host happened to be mid-restart, which is the
// static-vs-live confusion the module comment above already guards against.
//
// WHAT COUNTS AS "DECLARED". A set of enabled OCP units is RESOLVED when every unit
// is distinguishable from every other by BOTH the identity it claims AND the port it
// will bind. Anything else is undeclared multiplicity:
//
//   - two units on the SAME PORT are never resolved, whatever they declare — only one
//     process can hold a port, so this stays exactly the warning it was before #327.
//     A declaration must never be able to silence it, and by construction it cannot:
//     the port grouping below is computed before, and independently of, any name.
//   - two units claiming the SAME IDENTITY are not resolved either, even on different
//     ports. This is the case #327 reports and the case this check previously could
//     not see at all: a leftover duplicate sitting next to the intended instance, on
//     its own port, invisible because "different ports are never a boot race" was true
//     and complete only while there was nothing else to say about them.
//
// ABSENT vs EXPLICITLY EMPTY. `instanceName` is `string | null`: `null` means the unit
// declares no OCP_INSTANCE_NAME at all, `""` means it declares one and it is empty.
// The two are collapsed in some places and kept apart in others, and the asymmetry is
// the point. The places that collapse them are ENUMERATED below rather than bounded by
// a "nowhere else" — an earlier revision of this comment claimed the fold happened in
// exactly ONE place, independent review found the second, and no mutation can prove a
// universal negative anyway, which is what AGENTS.md's 4022be4 asks of a claim like it:
//
//   COLLAPSED (2 places, both deliberate):
//   1. claimedInstance(), the identity key for the DISTINCTNESS TEST — the only fold in
//      the conflict analysis, and the only one that can change a verdict. Pinned by M2.
//      Collapsed because README § "Running more than one instance on a host" defines an
//      empty value as the primary and requires only the SECOND instance to declare
//      itself. Absence and "" are therefore the same CLAIM — "I am the primary" — and
//      two units making it is unresolved regardless of which spelling each used. A
//      branch that treated absence as "nothing to compare" would be a predicate
//      satisfied by a missing operand, the defect shape this repo keeps shipping
//      (AGENTS.md, PR #371).
//   2. describeDeclaredInstances()'s `(primary)` rendering. Not a verdict and not an
//      exception to the rationale below: it renders the CLAIM, never an
//      `OCP_INSTANCE_NAME=""` directive nobody wrote, and it is reachable ONLY in the
//      `declared` state, where identityGroups is empty and therefore AT MOST ONE unit
//      can claim the primary — so there are never two `(primary)` entries to tell apart
//      and nothing is lost by not distinguishing them.
//
//   KEPT APART: the parsed model (`string | null`), describeDeclaration()'s three
//   renderings, and both WARN messages — because there the operator's next move differs
//   ("declare the one you meant to be extra" vs "you already edited this file — one of
//   these two edits is wrong"), and because rendering an absence as
//   `OCP_INSTANCE_NAME=""` would assert a directive nobody wrote.
//
// The value is `.trim()`ed to mirror server.mjs's INSTANCE_NAME exactly, so this check models what
// the server will actually do with the string rather than what the file literally says.
// That citation names the SYMBOL, not a line: it was written as `server.mjs:429`, which was
// right at v3.29.0 and wrong by two lines before this PR merged, because #395 removed the dead
// session surface above it. `grep -n INSTANCE_NAME server.mjs` survives the next shift; a
// corrected number only survives until the one after that. Same lesson as PR #391's, applied
// to a line number instead of a count.
// ═══════════════════════════════════════════════════════════════════════════

const UNIT_NAME_RE = /^[A-Za-z0-9:_.@-]+\.service$/;
// launchd labels are reverse-DNS-style identifiers (e.g. "dev.ocp.proxy",
// "homebrew.mxcl.postgresql@17" — "@" is a real, observed character in the
// wild). Same trust-boundary class as UNIT_NAME_RE above and PR #221's MED-5
// finding on restart-unit.mjs: a <Label> is attacker-creatable by anyone who
// can drop a plist, and review finding MED-3.3 on #230 found an earlier
// revision of this file interpolated an unvalidated Label straight into a
// copy-pasteable shell command in the WARN message — README.md's own guidance
// is to hand `ocp doctor` output to an AI agent, which can make a
// command-injection-shaped string in that output actionable, not just
// cosmetically broken.
// Leading "-" is rejected (first char excludes it; interior/trailing "-" is still allowed for
// labels like "...login-item-helper") even though review round 3 on #230 confirmed the CURRENT
// renderings are already safe against an option-injection-shaped label: `buildDisableHint`
// always emits the label as the TRAILING component of a `<domain>/<label>` token (never a
// standalone argv word), and this regex already excludes "/" and whitespace, so a label like
// "-Hattacker@example.com" can't break out of that token or split into extra shell words. That
// safety property lives in buildDisableHint's two format strings, not in this validator — a
// future rendering (e.g. `launchctl bootout <label>` with no `domain/` prefix) would reopen it.
// Rejecting a leading "-" here costs nothing (no real launchd label starts with one) and removes
// the dependency on that rendering detail entirely.
const LAUNCHD_LABEL_RE = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;
// Only these UnitFileState values mean "would actually start at boot" for the
// purposes of this check. Defense in depth (review finding HIGH-2 on #230): a
// mutation that deleted `--state=enabled` from the LISTING command survived
// the full suite untouched, because nothing re-derived "enabled" from each
// unit's OWN config — this allowlist is that second, independent gate. Stays
// PERMISSIVE when the property is absent (older systemd, or a caller that
// didn't request it) — this is a second check, not the only one, and must not
// newly reject unit shapes the primary --state=enabled filter already handled.
//
// NOTE on "enabled-runtime" (review round 3 on #230, discretionary observation):
// `--state=enabled` at the LISTING stage is an EXACT string match, so it can
// never itself surface an "enabled-runtime" unit (its enable-symlinks live
// under /run and are runtime-only) — this allowlist entry is unreachable via
// the normal gather path today, and "enabled-runtime" does NOT survive a
// reboot, so admitting it here is more permissive than the strict "would
// start at the NEXT boot" framing this check's name implies. Kept anyway,
// deliberately: a runtime-enabled unit CAN be racing another enabled unit for
// the port RIGHT NOW (a real, current hazard), just not a persistent one, and
// keeping the allowlist correct for a future caller that lists by a broader
// state filter costs nothing today.
const UNIT_FILE_STATE_ALLOWLIST = new Set(["enabled", "enabled-runtime"]);
// ARG_MAX / cost safety cap: past this many enabled *.service units in one scope,
// a single batched `systemctl show <all names> ...` command line risks becoming
// unwieldy for no real benefit (a host with 200+ enabled units enabling two OCP
// installs specifically is not a realistic shape this check needs to chase) —
// degrade to "unknown" for that scope rather than issuing an oversized command.
const MAX_UNIT_CANDIDATES = 200;

// Review round 4 on #230 (LOW-3): distinguishes "systemctl doesn't exist on this host at all"
// (a container, WSL without systemd, OpenRC, ...) from "systemctl exists but this particular
// probe failed" (permission, timeout, transient error). Verified directly: when execSync is
// given a full command STRING (this file's convention throughout), a missing binary is resolved
// by the shell it spawns through, which exits 127 and reports "command not found" on stderr —
// NOT a Node-level ENOENT on the execSync call itself (that only happens if the first execFile
// argument is itself a missing path, not applicable here). `err.status === 127` is therefore the
// portable, verified signal, independent of locale/shell.
function isCommandNotFound(err) {
  return !!err && err.status === 127;
}

function extractEnabledServiceNames(listUnitFilesOutput) {
  return String(listUnitFilesOutput)
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.split(/\s+/)[0])
    .filter(name => UNIT_NAME_RE.test(name)); // also excludes header/footer noise
}

function parseSystemctlShowBlocks(showOutput) {
  if (!showOutput) return [];
  return String(showOutput)
    .split(/\n\s*\n/)
    .map(block => {
      const props = {};
      for (const line of block.split("\n")) {
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        props[line.slice(0, idx)] = line.slice(idx + 1);
      }
      return props;
    })
    .filter(p => p.Id);
}

// Fingerprint one `systemctl show` property block as an OCP server.mjs unit, or
// null if it plainly isn't one (or isn't confidently determinable). ExecStart's
// structured form from `systemctl show` looks like
// "{ path=... ; argv[]=/usr/bin/node /home/opc/ocp/server.mjs ; ... }" — pull
// argv[] out of that if present, else fall back to treating the whole property
// as the argv string (tolerant of older systemd's plainer ExecStart rendering).
function fingerprintSystemdUnit(props, scope) {
  if (!UNIT_NAME_RE.test(props.Id || "")) return null; // never trust an unvalidated Id downstream

  // HIGH-2 defense in depth — see UNIT_FILE_STATE_ALLOWLIST above.
  const state = props.UnitFileState;
  if (state && !UNIT_FILE_STATE_ALLOWLIST.has(state)) return null;

  const execStart = props.ExecStart || "";
  const argvMatch = execStart.match(/argv\[\]=([^;]+)/);
  const argv = (argvMatch ? argvMatch[1] : execStart).trim().split(/\s+/).filter(Boolean);
  const serverArg = argv.find(a => a === "server.mjs" || a.endsWith("/server.mjs"));
  if (!serverArg) return null; // not an OCP unit — doesn't invoke server.mjs at all
  const workingTree = serverArg === "server.mjs" ? "" : serverArg.slice(0, -"/server.mjs".length);

  // MED-6 (review of #230): `systemctl show -p Environment` reflects only literal
  // `Environment=` directives — it does NOT expand `EnvironmentFile=`. setup.mjs itself only
  // ever writes literal Environment= lines, but a hand-edited unit could use either. If a
  // candidate's real port might be set via a file we cannot read here, assuming DEFAULT_PORT
  // would fabricate a port match (or a mismatch) with no real evidence behind it — drop the
  // candidate rather than guess (same "unknown must never be treated as safe-to-guess"
  // philosophy this file already applies elsewhere).
  if (props.EnvironmentFiles && props.EnvironmentFiles.trim()) return null;

  const env = props.Environment || "";
  const portMatch = env.match(/CLAUDE_PROXY_PORT=(\S+)/);
  const port = portMatch ? portMatch[1].replace(/^"|"$/g, "") : String(DEFAULT_PORT);
  const bindMatch = env.match(/CLAUDE_BIND=(\S+)/);
  const bind = bindMatch ? bindMatch[1].replace(/^"|"$/g, "") : "(default bind)";

  return { name: props.Id, scope, platform: "linux", port, workingTree, bind, instanceName: parseSystemdInstanceName(env) };
}

// #327. `null` when the unit declares no OCP_INSTANCE_NAME at all; a (trimmed) string
// when it declares one, INCLUDING the empty string. See the "ABSENT vs EXPLICITLY
// EMPTY" paragraph in the module comment for why the two must stay distinct here even
// though the distinctness test below folds them together.
//
// Two shapes, because `systemctl show -p Environment` quotes an assignment whose VALUE
// contains whitespace by wrapping the WHOLE `KEY=VALUE` pair: `Environment="A=b c" D=e`.
// The quoted form is tried first so a name with a space is read whole rather than
// truncated at the space by the bare form's `\S*`. `\S*` (not `\S+`) is what lets the
// explicitly-empty declaration match at all — `+` would read `OCP_INSTANCE_NAME=` as
// "absent", collapsing exactly the distinction this function exists to preserve.
// Anchored on start-of-string-or-whitespace so a longer key ending in the same letters
// (`MY_OCP_INSTANCE_NAME=x`) can never be mistaken for this one.
function parseSystemdInstanceName(env) {
  const m = env.match(/(?:^|\s)"OCP_INSTANCE_NAME=([^"]*)"/) || env.match(/(?:^|\s)OCP_INSTANCE_NAME=(\S*)/);
  return m ? m[1].trim() : null;
}

// macOS equivalent. setup.mjs only EVER writes one LaunchAgent
// (~/Library/LaunchAgents/dev.ocp.proxy.plist) and never a LaunchDaemon, so the
// structural precondition for this race (two independently-enabled auto-start
// definitions) is far less likely to arise from OCP's own tooling here than on
// Linux, where a hand-rolled system-scope unit is exactly what the field
// incident found. It is not impossible — an operator can hand-create a second
// LaunchAgent, or a package installer can drop one system-wide under
// /Library/LaunchAgents, or a LaunchDaemon under /Library/LaunchDaemons — so
// this still checks rather than silently skipping the platform, and scans all
// three locations (review finding MED-3.4 on #230: an earlier revision only
// scanned the two locations LEAST likely to be populated on an ordinary Mac —
// Apple's own daemons live under /System/Library, so /Library/LaunchDaemons is
// normally empty — and never scanned /Library/LaunchAgents at all, which is
// exactly where a system-wide installer drops one).
//
// plistBlob is a single pre-concatenated blob (one shell command, see
// gatherUnitCandidates) with each file's content prefixed by a
// "===OCP-DOCTOR-FILE:<path>===" delimiter line, so the whole scan costs one
// subprocess spawn regardless of how many plists exist.
function parsePlistCandidates(plistBlob) {
  if (!plistBlob) return [];
  const parts = String(plistBlob).split(/^===OCP-DOCTOR-FILE:(.*)===$/m);
  const units = [];
  for (let i = 1; i < parts.length; i += 2) {
    const path = (parts[i] || "").trim();
    const content = parts[i + 1] || "";
    if (!/<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(content)) continue; // wouldn't auto-start
    const argsBlock = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!argsBlock) continue;
    const args = [...argsBlock[1].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1]);
    const serverArg = args.find(a => a === "server.mjs" || a.endsWith("/server.mjs"));
    if (!serverArg) continue; // not an OCP unit
    const workingTree = serverArg === "server.mjs" ? "" : serverArg.slice(0, -"/server.mjs".length);
    const labelMatch = content.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/);
    const label = labelMatch ? labelMatch[1] : null;
    // Defense in depth (see LAUNCHD_LABEL_RE above): reject the whole candidate, exactly like
    // an unvalidated systemd Id is rejected on the Linux side, rather than trust an unvalidated
    // Label into any downstream message or command.
    if (!label || !LAUNCHD_LABEL_RE.test(label)) continue;
    const portMatch = content.match(/<key>CLAUDE_PROXY_PORT<\/key>\s*<string>([^<]*)<\/string>/);
    const bindMatch = content.match(/<key>CLAUDE_BIND<\/key>\s*<string>([^<]*)<\/string>/);
    const isDaemon = path.includes("/LaunchDaemons/");
    // scope: display grouping only ("is this personal-to-me or system-wide"). domain: the
    // launchctl disable-command TARGET, which is a different axis — review finding MED-3.3 on
    // #230 found the WARN message printed a `systemctl` command on macOS (a binary that does
    // not exist there) at all, so the fix must get the macOS command right, not just avoid
    // Linux syntax. A LaunchDaemon runs in launchd's `system` domain (`sudo launchctl disable
    // system/<label>`); a LaunchAgent — whether personal (~/Library) or installed system-wide
    // (/Library) — loads into the CURRENT USER's `gui/<uid>` domain, and launchctl's
    // disabled-overrides database (see parseDisabledLabels below) is tracked per that domain
    // regardless of which directory installed the plist.
    const scope = isDaemon || path.startsWith("/Library/LaunchAgents/") ? "system" : "user";
    const domain = isDaemon ? "system" : "gui";
    units.push({
      name: label,
      scope,
      domain,
      platform: "darwin",
      port: portMatch ? portMatch[1] : String(DEFAULT_PORT),
      workingTree,
      bind: bindMatch ? bindMatch[1] : "(default bind)",
      // #327, launchd side of parseSystemdInstanceName. `<string></string>` and a
      // self-closing `<string/>` are BOTH a declaration whose value is empty (plutil
      // writes the former, a hand-written plist may carry the latter) — matching only
      // the first would report a declared primary as undeclared. The alternation makes
      // capture group 1 `undefined` for the self-closing form, hence the `?? ""`.
      instanceName: (() => {
        const m = content.match(/<key>OCP_INSTANCE_NAME<\/key>\s*(?:<string>([^<]*)<\/string>|<string\s*\/>)/);
        return m ? (m[1] ?? "").trim() : null;
      })(),
    });
  }
  return units;
}

// Parses ONE `launchctl print-disabled <domain>` blob into the set of labels
// an operator has PERSISTENTLY disabled in that domain — real format
// (verified against a live host, both domains): a `disabled services = {
// "<label>" => enabled|disabled ... }` block. A RunAtLoad=true plist that's
// been `launchctl disable`d is inert (it will NOT actually start), so warning
// about it would be a false positive — and `launchctl disable` is the
// persistent, standard remediation a Mac operator would reach for (the exact
// analogue of `systemctl --user disable` on Linux). Best-effort: if a blob
// couldn't be gathered, this returns an empty set (nothing filtered from
// THAT domain) — permissive, not a reason to mark the whole check "unknown",
// since RunAtLoad=true is already a sufficient positive signal on its own and
// this is only a refinement that trims false positives further.
function parseDisabledLabels(disabledBlob) {
  const disabled = new Set();
  if (!disabledBlob) return disabled;
  const re = /"([^"]+)"\s*=>\s*(enabled|disabled)/g;
  let m;
  while ((m = re.exec(String(disabledBlob))) !== null) {
    if (m[2] === "disabled") disabled.add(m[1]);
  }
  return disabled;
}

// Union the gui/<uid> (LaunchAgents, personal or system-wide-installed) and
// system (LaunchDaemons) disabled-label sets. Review round 4 on #230, false
// claim correction: an earlier revision of this file claimed the system
// domain "requires root to query" and left it unprobed as a "documented
// limitation" — false (verified directly on a live host: uid 501, no sudo,
// `launchctl print-disabled system` exits 0). The consequence was
// self-inflicted: this file's OWN WARN recommends `sudo launchctl disable
// system/<label>` for a LaunchDaemon conflict, so an operator who followed
// that advice was warned about the same, now-disabled unit forever. Fixed by
// probing both domains and filtering on the union.
function unionDisabledLabels(...blobs) {
  const union = new Set();
  for (const blob of blobs) {
    for (const label of parseDisabledLabels(blob)) union.add(label);
  }
  return union;
}

function groupBy(units, keyFn) {
  const groups = new Map();
  for (const u of units) {
    const k = keyFn(u);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  return [...groups.values()];
}

// #327. The identity a unit CLAIMS, which is what the distinctness test compares.
// An absent declaration and an explicitly-empty one are the same claim — "I am the
// primary" — per README § "Running more than one instance on a host". See the module
// comment's "ABSENT vs EXPLICITLY EMPTY" paragraph, which ENUMERATES the two places that
// fold them: this one, and describeDeclaredInstances()'s `(primary)` rendering. This is the
// only fold in the CONFLICT ANALYSIS — the only one that can change a verdict — which is a
// narrower claim than the one that stood here through the first review round ("the ONLY
// place the two values are treated alike"). That was simply false, and the way it was false
// is the instructive part: it is a guaranteed-behaviour claim of the form 4022be4 says must
// name the mutation proving it, and a universal negative has no such mutation. An
// enumeration a reader can check beats a guarantee nobody can.
//
// The fold is pinned by M2, which is the mutation a careless implementation would actually
// ship: `units.filter(u => u.instanceName !== null)` — a predicate satisfied by a missing
// operand. Read it against M1 (identity analysis deleted outright): M2's red set is a strict
// SUBSET of M1's, and the tests M2 SPARES are exactly those whose two units BOTH carry a
// declaration, so M2's filter keeps them — "two units declaring the SAME name on different
// ports", the classifier and runDoctor trust-boundary tests (both units share one hostile
// name), and the runDoctor space-name test (both share "wifi bot"). That difference is the
// evidence; either red set alone would only say "identity analysis is broken".
//
// The membership is the claim; the SIZE of that set is not, and the difference between those
// two is why this sentence no longer says "the three". It said exactly that until review round
// 2 added one test, at which point the set became four while the PROPERTY it expresses did not
// move at all. A drifting count inside a claim that is otherwise stable is the same failure as
// the citation two paragraphs down. No absolute totals here on purpose: the suite grows every release, and a bare
// count with no base named cannot tell a later reader drift from a defect — the review finding
// on PR #391, which landed recording the IDENTITY of every test that reddens plus a delta
// against a named baseline, and recording the drift it measured rather than re-pinning past it.
// Identities and a subset relation survive a growing suite; totals do not. This branch's own
// base moved nine commits between the first measurement and the merge, which is the
// demonstration rather than the hypothesis. The totals live in the PR body, next to the SHA.
function claimedInstance(u) {
  return u.instanceName ?? "";
}

// #327. Names outside this set are never echoed into a message. Same trust boundary as
// UNIT_NAME_RE / LAUNCHD_LABEL_RE — an OCP_INSTANCE_NAME is writable by anyone who can
// write a unit file, and README's own guidance is to hand `ocp doctor` output to an AI
// agent. Note the difference from those two validators, and it is load-bearing: they
// REJECT the whole candidate, which is safe there because a malformed Id/Label cannot
// be used to address the unit anyway. Rejecting a candidate over its instance NAME
// would DROP a unit out of the conflict analysis — i.e. silence a hazard by writing a
// weird string into a file — so this sanitizes the RENDERING only. The raw value is
// still what claimedInstance() compares, so a hostile name cannot hide a duplicate.
// Both halves are pinned, by two different mutations: M10 (sanitizer removed) reddens the
// runDoctor trust-boundary test — the name reaches the terminal; M6 (quoted parse form
// dropped) reddens the classifier trust-boundary test through its premise assertion — the
// name stops reaching the grouping logic at all. Neither test can pass for the other's
// reason.
//
// THE SET EXCLUDES THE SPACE, and that is a deliberate consequence worth naming because it
// looks like an inconsistency: parseSystemdInstanceName goes out of its way to read a name
// containing a space WHOLE (systemd's quoted `Environment="K=v w"` form), and then this
// refuses to echo it. Both are right, and they are answering different questions. Parsing
// whole is a CORRECTNESS requirement — truncating "wifi bot" to "wifi" would invent a
// collision between two units that do not collide. Echoing is a TRUST question, and the set
// is an allowlist, so anything not positively known safe is withheld; a space is the cheapest
// separator to smuggle an extra argument past a reader skimming a shell-looking line. The
// operator still gets the finding, the unit name, the port and the length — everything except
// the untrusted bytes. The message says "safe label set" and not "printable" because a space
// IS printable; naming the set makes the message actionable rather than mysterious.
const SAFE_INSTANCE_NAME_RE = /^[A-Za-z0-9._@:+-]{1,64}$/;

function renderInstanceName(name) {
  return SAFE_INSTANCE_NAME_RE.test(name)
    ? `"${name}"`
    : `<not echoed: ${name.length} chars outside the safe label set [A-Za-z0-9._@:+-], max 64>`;
}

// How one unit's declaration reads in a message. Three renderings for three distinct
// observations — never two for three, because "no directive present" and "a directive
// whose value is empty" are different things an operator did.
function describeDeclaration(u) {
  if (u.instanceName === null) return "no OCP_INSTANCE_NAME declared";
  if (u.instanceName === "") return 'OCP_INSTANCE_NAME="" (the primary)';
  return `OCP_INSTANCE_NAME=${renderInstanceName(u.instanceName)}`;
}

// How a shared CLAIM reads — the thing two units are colliding over.
function describeClaim(identity) {
  return identity === "" ? "the PRIMARY instance" : `instance ${renderInstanceName(identity)}`;
}

// Two-or-more units sharing the same PORT are the original hazard (see the "Grouping
// key" discussion in the module comment above — port alone, not port+tree). Since #327
// two-or-more units sharing the same claimed IDENTITY are a second, distinct one.
//
// The port analysis is computed FIRST and is untouched by any declaration, so this
// function's warn set is a strict superset of its pre-#327 warn set: every input that
// warned before still warns. That is a claim about behaviour, so it cites the mutations
// that kill it (AGENTS.md): M3 lets a distinct declaration suppress a port collision, and
// reddens exactly the two NO-SILENCING tests and nothing else; M4 collapses the port grouping
// key to a constant so every unit lands in one group, and its whole red set is the pre-existing
// different-ports test — which has asserted since #230 that distinct ports never form a group —
// plus #327's own, with NO other pre-existing test reddening, which is what says that one test
// is the only guard for the port axis. Named tests rather than totals, for the reason given
// above claimedInstance.
//
// `groups` still means exactly "the port-collision groups" for scripts/upgrade.mjs's
// describeSecondUnit, which reads it. Established BEHAVIOURALLY, not by grepping for
// callers (ADR 0015 correction 3): test-features.mjs's #253 test drives the real gather
// layer through runUpgrade and asserts the rollback phase names the second enabled unit.
//
// NEW SHAPE SINCE #327, spelled out so the next reader does not have to re-derive it:
// `state: "warn"` can now carry an EMPTY `groups`, when the only finding is an identity
// collision. That combination was unreachable before — a warn implied at least one port
// group. describeSecondUnit is safe under it and is unchanged: `[].find(...)` is
// `undefined`, its `if (!group) return null` arm takes over, and `null` there already
// means "nothing more specific to say", never "confirmed no second unit". The behaviour
// is also identical to before #327 for that input, because the same input returned
// `"clear"` then, which describeSecondUnit's `state !== "warn"` guard also mapped to null.
//
// An identity group that is entirely CONTAINED in one port group is dropped rather
// than reported twice: the field-incident shape (two undeclared units on one port) is
// one hazard with two descriptions, and the port collision is the more urgent and more
// specific of them. A partial overlap is NOT dropped — three units where two collide on
// a port and all three claim the primary is genuinely two findings, and the operator
// who fixes only the port collision still has an ambiguous host.
function groupAndAssessConflicts(units) {
  // #327 part 5 (review F1): "clear" still ENUMERATED the unit — a single-install host is the
  // most common shape, and its inventory is exactly as useful to part 4 as a multi-instance one.
  if (units.length < 2) return { state: "clear", units };

  const portGroups = groupBy(units, u => u.port).filter(g => g.length >= 2);
  const identityGroups = groupBy(units, claimedInstance)
    .filter(g => g.length >= 2)
    .filter(g => !portGroups.some(p => g.every(u => p.includes(u))));

  if (portGroups.length === 0 && identityGroups.length === 0) {
    // #327: ≥2 enabled OCP units, every one distinguishable from every other by both
    // port and declared identity. Distinct from "clear" (which now means "fewer than
    // two units — the question never arose") so runDoctor can say so out loud: the
    // whole point of the declaration is that a correct multi-instance host stops being
    // indistinguishable from a broken one, and silence cannot carry that.
    return { state: "declared", units };
  }
  return { state: "warn", groups: portGroups, identityGroups, units };
}

// Pure classifier: parses already-gathered raw command/file output into a
// verdict. Never shells out itself — mirrors restart-unit.mjs's
// gather-vs-classify split so the decision logic is directly unit-testable
// without a live systemd/launchd instance.
//
// raw.userShowOut / raw.systemShowOut / raw.plistBlob follow a strict
// three-value discipline, same as restart-unit.mjs's ss/lsof/cgroup probes:
// `null` means "could not gather this" (tool missing, command failed, or too
// many candidates to probe cheaply — MAX_UNIT_CANDIDATES), `""` or a real
// listing means "gathered successfully, here's what's there" (including
// legitimately empty). `null` must never be read as "confirmed nothing found".
// raw.disabledBlob / raw.systemDisabledBlob (macOS only) are best-effort and
// do NOT participate in this discipline — see unionDisabledLabels above.
export function classifyMultiUnitRisk(raw = {}) {
  if (raw.platform === "darwin") {
    if (raw.plistBlob == null) {
      return { state: "unknown", reason: "could not enumerate LaunchAgents/LaunchDaemons" };
    }
    const disabledLabels = unionDisabledLabels(raw.disabledBlob, raw.systemDisabledBlob);
    const units = parsePlistCandidates(raw.plistBlob).filter(u => !disabledLabels.has(u.name));
    return groupAndAssessConflicts(units);
  }

  if (raw.userShowOut == null || raw.systemShowOut == null) {
    // LOW-3 (review round 4 on #230): a non-systemd Linux host (container, WSL without
    // systemd, OpenRC) previously got "unknown" — an INFO push on every single `ocp update`,
    // forever, about a check that can never apply there. "not-applicable" is silent (like
    // "clear") rather than a permanent, unactionable INFO line; "unknown" is reserved for a
    // host that DOES have systemctl but this specific probe still failed (permission, timeout,
    // a transient error) — that case is still genuinely worth surfacing.
    if (raw.systemctlNotFound) {
      return { state: "not-applicable", reason: "systemctl not found — this check only applies to systemd-managed Linux hosts" };
    }
    return {
      state: "unknown",
      reason: "systemctl unavailable, errored, or returned too many candidates for one or more scopes — cannot rule out a boot race",
    };
  }
  const units = [
    ...parseSystemctlShowBlocks(raw.userShowOut).map(p => fingerprintSystemdUnit(p, "user")),
    ...parseSystemctlShowBlocks(raw.systemShowOut).map(p => fingerprintSystemdUnit(p, "system")),
  ].filter(Boolean);
  return groupAndAssessConflicts(units);
}

// Impure gathering layer: decides which commands run and folds every failure
// mode (missing binary, non-zero exit, empty-but-valid output) into the
// null/""/text discipline classifyMultiUnitRisk expects. `run` defaults to
// real execSync in production; tests inject a fake runner that pattern-matches
// on the command string — the exact shape PR #221's resolveRestartPlan uses,
// adopted here specifically because that PR's review found the UNTESTED
// impure layer was where the real defects hid, not the pure classifier (this
// PR's own review — HIGH-1 on #230 — found the same thing had happened here:
// two tests asserted on the command string FROM INSIDE the injected fake,
// where the assertion's throw was swallowed by this function's own try/catch
// before it could reach the test framework. Fixed by having tests capture the
// command string and assert on it AFTER calling this function — see
// test-features.mjs).
//
// MED-4 (review of #230), verified on a real host: `for f in <dir>/*.plist; do
// [ -f "$f" ] && ...; done` exits non-zero when the LAST glob in the list
// expands to nothing (the shell leaves it as a literal, unmatched pattern, and
// `[ -f ]` on a literal glob string is false) — and on an ordinary Mac,
// /Library/LaunchDaemons is normally EMPTY (Apple's own daemons live under
// /System/Library), so this was the common case, not an edge case. execSync
// throws on that non-zero exit and DISCARDS the stdout already produced by
// earlier, successful iterations — silently turning a working scan into
// "unknown" on nearly every real Mac. Fixed with a trailing `; :` (`:` is the
// shell no-op builtin, always exit 0) so the loop's own exit status never
// determines the command's.
export function gatherUnitCandidates(run, platform) {
  if (platform === "darwin") {
    let plistBlob;
    try {
      plistBlob = run(
        `for f in "$HOME/Library/LaunchAgents"/*.plist /Library/LaunchAgents/*.plist /Library/LaunchDaemons/*.plist; do ` +
        `[ -f "$f" ] && { echo "===OCP-DOCTOR-FILE:$f==="; cat "$f"; }; done 2>/dev/null; :`
      );
    } catch { plistBlob = null; }

    let disabledBlob;
    try {
      disabledBlob = run(`launchctl print-disabled gui/$(id -u) 2>/dev/null`);
    } catch { disabledBlob = null; }

    // Review round 4 on #230: `launchctl print-disabled system` is ALSO an unprivileged,
    // read-only read (verified directly: uid 501, no sudo, exit 0, 19 entries) — the module
    // comment above parseDisabledLabels previously claimed this domain "requires root to
    // query", which was false and had a self-inflicted consequence: this file's OWN WARN
    // message recommends `sudo launchctl disable system/<label>` for a LaunchDaemon conflict,
    // so an operator who followed that advice got warned about the same (now-disabled) unit
    // forever, on every subsequent `ocp doctor`/`ocp update`. Second spawn, same best-effort/
    // permissive degradation as the gui-domain read above.
    let systemDisabledBlob;
    try {
      systemDisabledBlob = run(`launchctl print-disabled system 2>/dev/null`);
    } catch { systemDisabledBlob = null; }

    return { platform, plistBlob, disabledBlob, systemDisabledBlob };
  }

  let userListing, systemListing;
  let userNotFound = false, systemNotFound = false;
  try {
    userListing = run(`systemctl --user list-unit-files --type=service --state=enabled --no-legend --no-pager`);
  } catch (err) { userListing = null; userNotFound = isCommandNotFound(err); }
  try {
    systemListing = run(`systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager`);
  } catch (err) { systemListing = null; systemNotFound = isCommandNotFound(err); }
  // Only declare "systemctl isn't on this host at all" when BOTH scopes failed that specific
  // way — the same binary backs both calls, so a genuine absence fails both identically; a
  // single scope failing with exit 127 while the other succeeds would mean something odder is
  // going on and deserves the honest "unknown", not a confident "doesn't apply here".
  const systemctlNotFound = userNotFound && systemNotFound;

  const userNames = userListing != null ? extractEnabledServiceNames(userListing) : [];
  const systemNames = systemListing != null ? extractEnabledServiceNames(systemListing) : [];

  let userShowOut = userListing == null ? null : "";
  let systemShowOut = systemListing == null ? null : "";

  if (userListing != null && userNames.length > 0) {
    if (userNames.length > MAX_UNIT_CANDIDATES) {
      userShowOut = null;
    } else {
      try {
        userShowOut = run(`systemctl --user show ${userNames.join(" ")} -p Id -p ExecStart -p Environment -p UnitFileState -p EnvironmentFiles --no-pager`);
      } catch { userShowOut = null; }
    }
  }
  if (systemListing != null && systemNames.length > 0) {
    if (systemNames.length > MAX_UNIT_CANDIDATES) {
      systemShowOut = null;
    } else {
      try {
        systemShowOut = run(`systemctl show ${systemNames.join(" ")} -p Id -p ExecStart -p Environment -p UnitFileState -p EnvironmentFiles --no-pager`);
      } catch { systemShowOut = null; }
    }
  }

  return { platform, userListing, systemListing, userShowOut, systemShowOut, systemctlNotFound };
}

export function detectMultiUnitBootRace(opts = {}) {
  const platform = opts.mockPlatform || process.platform;
  const run = opts.run || ((cmd) => execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).toString());
  const raw = gatherUnitCandidates(run, platform);
  return classifyMultiUnitRisk(raw);
}

// Picks which unit in a conflicting group to suggest disabling: prefer a
// "user"-scope one (matches the actual remediation used on the field-incident
// host — the stray USER unit was disabled, the SYSTEM unit kept), else the
// first unit encountered (deterministic: gather always processes scopes/
// directories in the same fixed order). ONLY called for the same-working-tree
// case (see describeMultiUnitConflict below) — nominating a "stray" unit only
// makes sense when both units are drifted config on ONE install; see MED-7.
function pickDisableTarget(group) {
  return group.find(u => u.scope === "user") || group[0];
}

// Platform- and domain-aware remediation command for ONE unit (review finding
// MED-3.3 on #230: the previous revision always printed a `systemctl` command,
// including on macOS, where that binary does not exist). Factored out of the
// old buildDisableHint so both the same-tree (nominates one target) and
// different-tree (lists every unit's command, nominates none — see MED-7
// below) message shapes can share it.
function buildDisableCommand(unit) {
  if (unit.platform === "darwin") {
    return unit.domain === "system"
      ? `sudo launchctl disable system/${unit.name}`
      : `launchctl disable gui/$(id -u)/${unit.name}`;
  }
  return unit.scope === "user"
    ? `systemctl --user disable ${unit.name}`
    : `systemctl disable ${unit.name}`;
}

// Same-working-tree case: both units are drifted config on ONE install (the
// field incident's own shape), so nominating the likely-stray one (preferring
// user-scope, matching the real remediation used there) is reasonable.
function buildDisableHint(group) {
  const target = pickDisableTarget(group);
  const cmd = buildDisableCommand(target);
  const reversibleNote = target.platform === "darwin"
    ? `(reversible: the plist is preserved, only a persistent disable flag is set; undo with the same command substituting "enable" for "disable")`
    : `(reversible: the unit file is preserved${target.scope === "user" ? ", only the boot-enable link is removed" : ""})`;
  return `disable the stray one — e.g. "${cmd}" ${reversibleNote}`;
}

// Different-working-tree case (review finding MED-7 on #230): these are two
// SEPARATE installs, not one install's drifted config, so nominating either
// one as "the stray one" is a judgement this check has no basis for making —
// it directly contradicts the PR's own stated principle ("does not assert
// which of two conflicting units is correct"). Lists every unit's disable
// command instead of picking one.
function buildNeutralDisableHint(group) {
  const options = group.map(u => `"${buildDisableCommand(u)}"`).join(" or ");
  return `this check cannot tell which install you intend to keep — decide, then disable whichever you don't want: ${options} (reversible either way — the losing unit's file/plist is preserved)`;
}

// Actionable WARN text: names every conflicting unit, the difference that
// matters (bind address — the field incident's actual LAN-reachability
// hazard — plus whether the units share one working tree or point at
// different ones, see the "Grouping key" discussion above), and a
// platform-correct, reversible remediation command.
function describeMultiUnitConflict(groups, identityGroups = []) {
  const portMessages = groups.map(group => {
    const port = group[0].port;
    const trees = [...new Set(group.map(u => u.workingTree))];
    const names = group.map(u => `${u.scope}-scope "${u.name}" (bind ${u.bind}, ${describeDeclaration(u)})`).join(" and ");
    if (trees.length === 1) {
      const treeNote = ` (same working tree: ${trees[0] || "(unresolved)"})`;
      return `${group.length} enabled units target OCP port ${port}${treeNote}: ${names} — boot race: whichever starts first wins the port and the other silently orphans (issue #215). Pick one and ${buildDisableHint(group)}.`;
    }
    const treeNote = ` — DIFFERENT working trees (${trees.map(t => t || "(unresolved)").join(" vs ")}): these are two SEPARATE OCP installs racing for the same port, not just drifted config on one install`;
    return `${group.length} enabled units target OCP port ${port}${treeNote}: ${names} — boot race: whichever starts first wins the port and the other silently orphans (issue #215). ${buildNeutralDisableHint(group)}.`;
  });
  return [...portMessages, ...identityGroups.map(describeUndeclaredMultiplicity)].join(" | ");
}

// #327. The second hazard: units that do NOT contend for a port, but that nothing on
// this host distinguishes from one another. Deliberately worded so it cannot be
// mistaken for the boot-race message above — these units can all start and all bind,
// which is precisely why the failure is quiet: a leftover duplicate serving stale code
// on its own port looks exactly like a deliberate second instance, and the operator has
// no way to tell which they are looking at. That ambiguity is what buried a real
// duplicate on the host in issue #327.
//
// Nominates no unit to disable. Which one is intended is a judgement this check has no
// basis for making — the same principle MED-7 (#230) established for the
// different-working-trees case — so it offers the declaration as the first remedy
// (nothing is lost, the ambiguity goes away) and every unit's disable command second.
function describeUndeclaredMultiplicity(group) {
  const identity = claimedInstance(group[0]);
  const names = group
    .map(u => `${u.scope}-scope "${u.name}" (port ${u.port}, tree ${u.workingTree || "(unresolved)"}, ${describeDeclaration(u)})`)
    .join(" and ");
  const options = group.map(u => `"${buildDisableCommand(u)}"`).join(" or ");
  return `${group.length} enabled units all claim ${describeClaim(identity)} on different ports: ${names} — they do not race for a port, so both can start; nothing on this host says which is intended, which is exactly how a leftover duplicate hides next to a deliberate second instance (issue #327). Either declare the extra one (${group[0].platform === "darwin" ? "an OCP_INSTANCE_NAME entry in the plist's EnvironmentVariables dict" : "Environment=OCP_INSTANCE_NAME=<name> on its unit"}) or disable the one you do not want: ${options} (reversible either way — the losing unit's file/plist is preserved).`;
}

// #327. The positive report the issue asks for by name: "2 instances, both declared:
// primary :<DEFAULT_PORT>, `wifibot` :<DEFAULT_PORT+1>". The issue writes those as bare
// numbers; this comment does not, because `alignment.yml`'s port-literal SPOT job hard-fails
// any port literal in source and it does not read comments differently from code — and that
// gate exists for the 2026-05-08 incident this very file was half of. Pushed at INFO, and
// only ever on a host that has more than one enabled OCP unit, so it is not a line every
// host carries forever (the
// LOW-3 lesson on #230). It exists because "verified resolved" and "nothing looked" are
// otherwise the same silence from outside the process — the same argument MED-3.5 made
// for surfacing "unknown", applied to the state that replaced the false alarm.
function describeDeclaredInstances(units) {
  const list = units
    .map(u => `"${u.name}" :${u.port} (${u.instanceName === null || u.instanceName === "" ? "primary" : renderInstanceName(u.instanceName)})`)
    .join(", ");
  return `${units.length} enabled OCP units, all declared and distinct — no port collision and no repeated OCP_INSTANCE_NAME, so this is a deliberate multi-instance host rather than a leftover duplicate (issue #327): ${list}.`;
}

// Issue #289. ADR 0010 split the auth probe's outcomes into CONCLUSIVE (clean exit / non-zero
// exit) and INCONCLUSIVE (killed by a signal — including the probe's own timeout — or failed to
// spawn), and made `/health`'s `auth.ok` carry only the last CONCLUSIVE verdict: `true`, `false`,
// or `null` when no probe has ever concluded. That three-valued domain IS the content of ADR
// 0010; collapsing it back to two throws the decision away.
//
// Both doctor call sites used a falsy check (`if (!authOk)`), which maps `null` onto the same
// branch as `false` and then reported it with a hard-coded string — so doctor printed
// `auth.ok=false` for a value that was `null`, asserting a state that never occurred, and then
// selected next_action.kind = "fix_oauth" over credentials that had never been rejected. That
// routed the operator to debug working credentials AND made the next `ocp update` refuse to run
// ("Pre-upgrade check failed: fix_oauth"). This helper is the single place that split now lives,
// so the two sites cannot drift apart again — the same structural argument ADR 0010 made for
// `proxyHealthStatus`.
//
// Why `null`/absent is WARN rather than FAIL: a FAIL here is not a label, it is a decision with
// two consequences — `kind = "fix_oauth"`, whose remediation is "reinstall the claude native
// binary and restart the service", and `fail_count > 0`, which blocks the next `ocp update`.
// Neither is a correct response to "no probe has concluded yet". On a freshly restarted proxy
// that is the EXPECTED state for up to CLAUDE_AUTH_CHECK_INTERVAL_MS (ADR 0010 § "Costs
// accepted" — "A new boot state exists"). WARN keeps it visible in the check list and in
// warn_count without inverting a decision on evidence that does not exist.
//
// The rendered value is derived from what was actually observed (`auth.ok=null`,
// `auth.ok=false`, `auth.ok=missing`) rather than written as a literal, so no branch can assert
// a state the server did not report.
export function classifyAuthOk(body) {
  const auth = body?.auth;
  const ok = auth?.ok;
  const detail = auth?.message || "unknown";
  if (ok === true) return { level: "PASS", oauthOk: true, message: "OAuth token valid" };

  const seen = ok === null ? "null" : ok === undefined ? "missing" : String(ok);
  if (ok === false) {
    // #324. A latched `false` with nothing conclusive since is STALE EVIDENCE, not a fresh
    // rejection, and this function's verdict is a decision: FAIL sets next_action.kind =
    // "fix_oauth", which makes `ocp update` refuse outright (the `fix_oauth|fix_service)` arm in `ocp`, which prints "Pre-upgrade check failed" and returns 1 — cited by its text, not a line number, because this repo has a documented line-rot lesson).
    //
    // The wedge is real and was hit in production. An inconclusive probe deliberately preserves
    // the last conclusive `ok` — correct on its own, since a timeout measures host load and not
    // credential validity. But once `false` is latched, only a conclusive SUCCESS clears it, and a
    // probe that reliably times out never produces one. On that host the proxy served 51 requests
    // with zero errors and `/health` reported `ok`, while `ocp update` refused for hours; the only
    // symptom was the upgrade path being closed, with nothing anywhere saying "stuck".
    //
    // `auth.ok` itself is left alone deliberately: the last conclusive verdict really was `false`,
    // and rewriting the rule that determines a grandfathered B.2 field's value is a contract
    // change (the ADR 0010 test). The staleness lives in a separate additive counter and only
    // this decision reads it.
    const inconclusive = Number(auth?.consecutiveInconclusive) || 0;
    // The counter alone is not sufficient, and an independent review proved it by mutation: make
    // the server PRESERVE the counter on a conclusive rejection instead of resetting it, and the
    // state {ok:false, lastOutcome:"rejected", consecutiveInconclusive:3} reaches here — a
    // rejection that happened SECONDS ago, read as stale, unlocking the upgrade gate. Nothing in
    // the suite caught it.
    //
    // So require both: the count, AND that the most recent probe did not conclude. A correct
    // server can never emit lastOutcome="rejected" with a non-zero counter, because the rejection
    // branch resets it — this condition is therefore strictly tightening on correct servers and a
    // backstop against an incorrect one. Absent lastOutcome (an older server) is not inconclusive,
    // so it keeps FAILing, same direction as the absent-counter case.
    const lastInconclusive = auth?.lastOutcome === "timeout" || auth?.lastOutcome === "unavailable";
    if (inconclusive >= AUTH_STALE_AFTER_INCONCLUSIVE && lastInconclusive) {
      return {
        level: "WARN",
        oauthOk: true,
        message: `auth.ok=${seen} but the last ${inconclusive} probes were inconclusive ` +
          `(lastOutcome=${auth?.lastOutcome ?? "unknown"}) — the rejection is stale evidence, not a ` +
          `current one, so it does not block an upgrade (#324): ${detail}`,
      };
    }
    return { level: "FAIL", oauthOk: false, message: `auth.ok=${seen}: ${detail}` };
  }
  // `null` (ADR 0010's "no conclusive probe yet") and an absent field are both "not known",
  // which is not "rejected". lastOutcome, when present, is what tells an operator WHY.
  const because = auth?.lastOutcome ? `, lastOutcome=${auth.lastOutcome}` : "";
  return {
    level: "WARN",
    oauthOk: true,
    message: `auth.ok=${seen} — no conclusive auth probe yet${because}; not a credential rejection (ADR 0010): ${detail}`,
  };
}

export async function runDoctor(opts = {}) {
  const checks = [];
  const push = (id, level, message, extra = {}) =>
    checks.push({ id, level, message, ...extra });

  // --- fast path: --check oauth ---
  if (opts.checkOnly === "oauth") {
    return runOauthOnly(opts, checks, push);
  }

  // --- install directory (issue #348) ---
  // Resolved from THIS FILE's own location, not from $HOME — see scripts/lib/install-dir.mjs
  // for the full failure it fixes. Pushed as a visible check, first, because #348's real cost
  // was not that the answer was wrong: it was that a wrong answer was invisible, and surfaced
  // three checks downstream as "your version is too old".
  const { dir: ocpDir, source: ocpDirSource, ignored: ocpDirIgnored } = resolveInstallDir(opts);
  const install = classifyInstallDir(ocpDir);

  // Three levels, and the level is what decides whether an operator ever sees this line:
  //
  //   FAIL — the resolved directory exists and is NOT an OCP install (review HIGH-2). This is
  //     the state in which the fresh_install path would otherwise hand it to `rm -rf`, so the
  //     destructive step is withheld below and this says why. It cannot fire on the default
  //     path: the script-relative answer is the tree doctor.mjs is running from, which always
  //     has a package.json named "open-claude-proxy". Reaching it requires an explicitly-set
  //     $OCP_DIR (or an injected opts.ocpDir), and $OCP_DIR is new in this change — so no host
  //     that previously updated can be newly refused by it.
  //   WARN — an $OCP_DIR was supplied and could not be used (review MEDIUM-1). This was PASS
  //     in the first cut, and `ocp`'s cmd_update filter prints WARN and INFO only, so the
  //     refusal reached exactly nobody on the command it matters on. This module's own header
  //     states the opposite principle; WARN is what makes it true.
  //   PASS — otherwise.
  const installLevel = !install.safeToReplace ? "FAIL" : ocpDirIgnored ? "WARN" : "PASS";
  push("install_dir", installLevel,
       `${ocpDir} (resolved from ${ocpDirSource})` +
       (ocpDirIgnored ? ` — ${ocpDirIgnored}` : "") +
       (installLevel === "FAIL" ? ` — ${install.why}` : ""));

  // --- version detection ---
  const pkgPath = join(ocpDir, "package.json");
  let currentVersion = opts.mockVersion;
  let versionError = null;
  if (!currentVersion) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      currentVersion = `v${pkg.version}`;
    } catch (e) {
      currentVersion = "unknown";
      // Keep WHY, not just "unknown". ENOENT (the #348 shape — right code, wrong directory) is
      // a different operator action from a parse error or a permission denial on a file that
      // IS there, and "unknown" alone cannot tell them apart.
      versionError = e.code === "ENOENT"
        ? `no package.json at ${pkgPath}`
        : `could not read ${pkgPath}: ${e.message}`;
    }
  }
  // Resolve latest from origin/main (cheap: `git show origin/main:package.json`).
  // Falls back to current_version when network/git unavailable, so kind = noop instead
  // of recommending a downgrade against a stale hardcoded value.
  let latestVersion = opts.mockLatest;
  if (!latestVersion) {
    // Issue #173: `git show origin/main:...` reads the LOCALLY CACHED remote ref. Without a
    // fetch first, a machine that hasn't pulled since the last release sees latest == current
    // and reports noop — new releases were invisible everywhere except the machine that cut
    // the tag (live repro: Oracle VM, 2026-07-17). Fetch before comparing; on failure
    // (offline, auth, timeout) fall through to the cached ref — the pre-existing behavior.
    if (!opts.skipNetwork) {
      try {
        execSync(`git -C ${ocpDir} fetch --tags --quiet`, { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
      } catch { /* offline → compare against cached origin/main, as before */ }
    }
    try {
      const out = execSync(`git -C ${ocpDir} show origin/main:package.json 2>/dev/null`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
      const remotePkg = JSON.parse(out);
      latestVersion = `v${remotePkg.version}`;
    } catch {
      latestVersion = currentVersion;
    }
  }
  // Issue #348: this used to push PASS unconditionally — including when its own value was the
  // literal string "unknown". The check that HAD the information reported success, and the
  // failure surfaced one check later as `unknown < v3.4.0`, which reads as "your version is too
  // old" rather than "I could not find your install". FAIL here, and name the path that was
  // tried plus how it was chosen, so the message points at the actual remedy.
  //
  // Deliberately narrow, and deliberately NOT a new way for a working host to be blocked: the
  // FAIL condition (`!semverParts(currentVersion)`) is exactly the first conjunct of
  // `fromSupported` below, so it can only fire on a host where from_version_supported ALREADY
  // FAILs. fail_count goes 1 → 2 on those hosts; ready_to_upgrade (fail_count === 0) was
  // already false, next_action.kind is computed from `fromSupported` and is untouched, and
  // runUpgrade()'s pre-flight guard tolerates !ready_to_upgrade precisely for
  // kind="fresh_install", which is what this state produces. A host on a KNOWN-but-old version
  // (say v3.2.0) still gets current_version=PASS — it is only "I don't know" that FAILs.
  const versionKnown = !!semverParts(currentVersion);
  push("current_version", versionKnown ? "PASS" : "FAIL",
       versionKnown
         ? `current=${currentVersion}`
         : `could not determine the installed version — ${versionError || `unparseable version ${JSON.stringify(currentVersion)}`}` +
           `; install dir ${ocpDir} (resolved from ${ocpDirSource})` +
           `. If OCP is installed elsewhere, set OCP_DIR=<install path>.`);

  // --- from-version supported? ---
  const fromSupported = versionKnown && semverCompare(currentVersion, "v3.4.0") >= 0;
  push("from_version_supported", fromSupported ? "PASS" : "FAIL",
       fromSupported
         ? "≥ v3.4.0"
         : versionKnown
           // Issue #348: the "unknown < v3.4.0" wording this branch used to emit for BOTH cases
           // is an assertion about a version nobody established. Only claim "too old" when a
           // version was actually read.
           ? `${currentVersion} < v3.4.0; in-place upgrade not supported`
           : `cannot confirm the installed version is ≥ v3.4.0 because it could not be determined at all — see the current_version check above for the path that was tried. This is NOT "your version is too old".`);

  // --- service health check (mockable) ---
  let healthOk = true, oauthOk = true;
  // Issue #214: the RUNNING SERVICE's version, as reported by /health, kept distinct from
  // currentVersion (the tree's package.json, above). A partially-failed `ocp update` can
  // `git checkout` the new tag and then fail before the restart phase runs, leaving the tree
  // looking fully updated while the service still answers with the old code. null means
  // "unknown" (skipNetwork, /health unreachable, or a body with no usable version field) —
  // the decision below must degrade gracefully on unknown, same philosophy as upgrade.mjs's
  // postFlightOk ("an empty/unknown target degrades ... rather than blocking an otherwise-good
  // upgrade"). Stored as the bare string /health returns (no "v" prefix): semverParts()/
  // semverCompare() strip a leading "v" themselves, so prefixing here would be purely
  // cosmetic — an earlier version of this fix added one and it was dead weight (PR #217
  // review: survived mutation because nothing downstream reads the prefix).
  let serviceVersion = null;
  if (!opts.skipNetwork) {
    let health;
    if (opts.mockHealth !== undefined) {
      health = opts.mockHealth;
    } else {
      try {
        const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
        const out = execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/health`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
        health = { status: 200, body: JSON.parse(out) };
      } catch (e) {
        health = { error: String(e.message || e) };
      }
    }
    if (health.error || health.status !== 200) {
      healthOk = false;
      push("service_running", "FAIL", `service unreachable: ${health.error || `status ${health.status}`}`);
    } else if (!health.body || typeof health.body !== "object") {
      healthOk = false;
      push("service_running", "FAIL", "service /health returned 200 but empty/non-JSON body");
    } else {
      push("service_running", "PASS", "service responding on /health");
      const auth = classifyAuthOk(health.body);
      if (!auth.oauthOk) oauthOk = false;
      push("oauth_ok", auth.level, auth.message);
      // /health reports a bare semver (server.mjs `version: VERSION`, no leading "v"); only
      // trust it when it actually parses as a version, so a missing/garbled field degrades to
      // "unknown" (serviceVersion stays null) instead of being mistaken for a real mismatch.
      if (typeof health.body.version === "string" && semverParts(health.body.version)) {
        serviceVersion = health.body.version;
      }
    }
  }

  // --- multi-unit boot-race pre-flight (issue #220 / incident #215) ---
  // Gated by skipNetwork like the health/oauth block above — this reads the live
  // systemd/launchd environment (not "network" in the curl/git sense, but the same
  // "don't touch anything live" contract skipNetwork already exists to express in
  // tests). "clear" and "not-applicable" (LOW-3 on #230: systemctl genuinely doesn't
  // exist on this host — a container, WSL without systemd, OpenRC — so the check
  // can never apply here) both push nothing; the latter exists specifically so such
  // a host doesn't get an unactionable INFO line on every single `ocp update`,
  // forever. "unknown" DOES push a low-severity INFO line (review finding MED-3.5 on
  // #230) — reserved for a host that DOES have systemctl but this specific probe
  // still failed (permission, timeout, a transient error): before this distinction
  // existed, "verified clear" and "couldn't verify" were indistinguishable from
  // outside the process (both pushed nothing), which matters because
  // `systemctl --user ...` fails without XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS —
  // exactly what `sudo`'s env_reset strips — so `sudo ocp update` on a host whose
  // OCP is a SYSTEM unit (the #215 shape) silently degraded this whole check with no
  // visible trace. INFO does not affect fail_count/warn_count. See the module
  // comment above classifyMultiUnitRisk for the full design rationale (why WARN not
  // FAIL, why grouping is by port alone, why this doesn't depend on
  // scripts/lib/restart-unit.mjs).
  // #327 part 5: the per-host unit inventory is already derived by this check; expose it as
  // STRUCTURED JSON (not only the human message) so an agent or `ocp update --all-instances` can
  // enumerate declared instances without parsing prose. Non-null whenever the check ENUMERATED
  // (clear/warn/declared); null only when it could not (skipNetwork or the unknown state).
  let units = null;
  if (!opts.skipNetwork) {
    const multiUnit = detectMultiUnitBootRace(opts);
    if (multiUnit.state === "warn") {
      units = multiUnit.units;
      push("multi_unit_boot_race", "WARN", describeMultiUnitConflict(multiUnit.groups, multiUnit.identityGroups));
    } else if (multiUnit.state === "clear") {
      units = multiUnit.units; // single-install host: enumeration SUCCEEDED, so the inventory is real
    } else if (multiUnit.state === "declared") {
      units = multiUnit.units;
      // #327. Kept under the SAME check id deliberately: this is the same check reaching
      // a verdict, and the id is a stable machine-readable handle an operator or agent may
      // already key on. INFO does not touch warn_count/fail_count, so a correctly-declared
      // multi-instance host is no longer warned at — while every undeclared shape above
      // still is, which is the whole acceptance condition of #327.
      push("multi_unit_boot_race", "INFO", describeDeclaredInstances(multiUnit.units));
    } else if (multiUnit.state === "unknown") {
      push("multi_unit_boot_race", "INFO", `could not verify: ${multiUnit.reason}`);
    }
  }

  // --- determine next_action.kind (priority: fresh_install > fix_service > fix_oauth > noop/restart > update > upgrade) ---
  let kind;
  if (!fromSupported) {
    kind = "fresh_install";
  } else if (!opts.skipNetwork && !healthOk) {
    kind = "fix_service";
  } else if (!opts.skipNetwork && !oauthOk) {
    kind = "fix_oauth";
  } else {
    const cur = semverParts(currentVersion), lat = semverParts(latestVersion);
    if (!cur) {
      kind = "fresh_install";
    } else if (semverCompare(currentVersion, latestVersion) === 0) {
      // Issue #214: "tree == latest" alone is NOT "nothing to do" — the goal is the running
      // service serving the tree's version. When serviceVersion is known (see health-check
      // block above) and OLDER than the tree, a previous update half-completed (tree checked
      // out, restart phase never ran): the service needs a restart, with NO git operations
      // (the tree is already correct).
      //
      // kind="restart" is a DISTINCT value from "update" — PR #217's first draft reused
      // "update" and was rejected in review for two reasons, both load-bearing:
      //   1. "update"'s bash handler (_cmd_update_light) runs `git pull origin main --ff-only`.
      //      That is NOT a no-op in general: doctor's latestVersion comes from the VERSION
      //      NUMBER in origin/main's package.json, not from origin/main's commit. Between
      //      releases, main accumulates merged-but-unreleased commits while package.json stays
      //      put, so "tree == latest" (by version string) can hold while origin/main HEAD is
      //      genuinely ahead of the release tag. Routing that state through "update" would
      //      silently fast-forward a production host off its release tag onto unreleased main,
      //      then restart into it — worse than the bug this issue reports.
      //   2. _cmd_update_light drops every CLI flag ("$@" is never forwarded to it), so
      //      `ocp update --dry-run` on a stale host would have skipped straight to a real
      //      mutating restart despite the documented "preview the plan, don't mutate" contract.
      // "restart" has its own bash handler (_cmd_update_restart) that never touches git and
      // honors --dry-run.
      //
      // When serviceVersion is NEWER than the tree (e.g. the tree was rolled back, or someone
      // is running a newer/test build), do NOT restart: that would silently DOWNGRADE a
      // running service to match an older tree, which is exactly the class of surprise
      // auto-mutation this issue is about. Surface it (WARN) but leave kind="noop" — the same
      // "nothing forced" default as before this fix.
      //
      // Either way, push a WARN (not FAIL) so ready_to_upgrade stays true when kind="restart" —
      // runUpgrade()'s pre-flight guard only tolerates ready_to_upgrade=false for
      // kind="fresh_install".
      if (serviceVersion) {
        const serviceCmp = semverCompare(serviceVersion, currentVersion);
        if (serviceCmp < 0) {
          kind = "restart";
          push("service_version_matches_tree", "WARN",
            `tree at ${currentVersion.replace(/^v/, "")}, service serving ${serviceVersion.replace(/^v/, "")} — restarting`);
        } else if (serviceCmp > 0) {
          kind = "noop";
          push("service_version_matches_tree", "WARN",
            `tree at ${currentVersion.replace(/^v/, "")}, service serving ${serviceVersion.replace(/^v/, "")} (NEWER than tree) — not auto-restarting`);
        } else {
          kind = "noop";
        }
      } else {
        kind = "noop";
      }
    } else if (lat && cur.major === lat.major && cur.minor === lat.minor) {
      kind = "update";
    } else {
      kind = "upgrade";
    }
  }

  // --- next_action shape ---
  let next_action;
  if (kind === "fresh_install") {
    // Review HIGH-2: `rm -rf ${ocpDir}` is emitted ONLY when the target is absent, empty, or a
    // verifiable OCP install. Otherwise no automated steps are offered at all — an
    // ai_executable[] that silently dropped just the `rm` would leave a `git clone` that
    // cannot succeed into a non-empty directory, reporting a confusing clone failure instead
    // of the real problem. Saying "I will not generate steps for this target, here is why" is
    // the honest shape, and `human_required` is the field that already means exactly that.
    next_action = install.safeToReplace ? {
      kind,
      human_required: ["claude auth login (only if OAuth becomes invalid after reinstall)"],
      ai_executable: [
        `launchctl bootout gui/$(id -u)/ai.openclaw.proxy 2>/dev/null || true`,
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `mv ${join(homedir(), ".ocp")} ${join(homedir(), ".ocp.backup-")}$(date +%s) 2>/dev/null || true`,
        `rm -rf ${ocpDir}`,
        `git clone https://github.com/dtzp555-max/ocp ${ocpDir}`,
        `cd ${ocpDir} && npm install --no-audit --no-fund && node setup.mjs`,
        `${ocpDir}/ocp doctor`
      ],
      verify: "ocp doctor expects PASS on all checks"
    } : {
      kind,
      human_required: [
        `Refusing to generate a fresh-install plan: ${install.why}.`,
        `A fresh install would begin with \`rm -rf ${ocpDir}\`, and this tool only does that to a directory that is absent, empty, or verifiably an OCP install.`,
        // #366 review, finding B. This line used to be unconditional, so a directory we could not
        // INSPECT — a genuine install whose permissions block stat — was told to "remove it
        // yourself first". The `why` above had already been fixed to say "could not be inspected
        // ... do NOT delete it", which made the tool contradict itself in adjacent lines and left
        // the destructive instruction as the LAST thing the operator reads. Branch on the same
        // fact the classifier already reports rather than restating a guess.
        install.unreadableMarkers?.length
          ? `Do NOT delete this directory. It carries ${install.unreadableMarkers.length} of the marker file name(s) (${install.unreadableMarkers.join(", ")}) that could not be read, which is what an OCP install looks like from a process that lacks permission to inspect it. Fix the permissions (the directory needs SEARCH/execute, not just read) or re-run as its owner, then re-run \`ocp doctor\`.`
          : `If OCP is installed somewhere else, set OCP_DIR to that path (absolute). If you genuinely want this directory replaced, remove it yourself first, then re-run.`,
      ],
      ai_executable: [],
      verify: install.unreadableMarkers?.length
        ? "ocp doctor expects install_dir=PASS once this directory is readable (fix permissions; do not delete it)"
        : "ocp doctor expects install_dir=PASS once OCP_DIR points at an OCP install (or is unset)"
    };
  } else if (kind === "noop") {
    next_action = { kind, human_required: [], ai_executable: [], verify: "already at latest" };
  } else if (kind === "fix_oauth") {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `cd "$(npm root -g)/@anthropic-ai/claude-code" && node install.cjs`,
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor`
      ],
      // Independent review LOW-2 on #289: this remediation RESTARTS the service, and by ADR
      // 0010 a freshly restarted proxy reports auth.ok=null — oauth_ok WARN, not PASS — until
      // its first probe concludes. Demanding PASS immediately afterwards sets an expectation the
      // fix itself makes temporarily unreachable, and would read as "the fix did not work".
      verify: "ocp doctor expects oauth_ok=PASS (WARN immediately after the restart is expected — the first auth probe has not concluded yet; re-run once it has)",
      reference: "~/.cc-rules/memory/learnings/ocp_claude_native_binary_postinstall.md"
    };
  } else if (kind === "fix_service") {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor`
      ],
      verify: "ocp doctor expects service_running=PASS"
    };
  } else {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [`${ocpDir}/ocp update --yes`],
      verify: "ocp doctor expects PASS on all checks"
    };
  }

  const fail_count = checks.filter(c => c.level === "FAIL").length;
  const warn_count = checks.filter(c => c.level === "WARN").length;
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ready_to_upgrade: fail_count === 0,
    // Issue #348: additive, machine-readable siblings of the install_dir check, so an agent
    // reading --json can see WHICH tree every other field in this object describes.
    install_dir: ocpDir,
    install_dir_source: ocpDirSource,
    // #348 review HIGH-2: whether this directory may be handed to `rm -rf` by the
    // fresh_install path. False withholds every automated step; see the next_action shape.
    install_dir_safe_to_replace: install.safeToReplace,
    current_version: currentVersion,
    latest_version: latestVersion,
    from_version_supported: fromSupported,
    // #327 part 5: the structured per-host unit inventory (name/scope/port/instanceName per
    // enabled unit), null when the check could not enumerate (skipNetwork or unknown state).
    units,
    fail_count,
    warn_count,
    checks,
    next_action
  };
}

function runOauthOnly(opts, checks, push) {
  let healthOk = true, oauthOk = true, oauthLevel = null;
  let health;
  if (opts.mockHealth !== undefined) {
    health = opts.mockHealth;
  } else {
    try {
      const port = process.env.CLAUDE_PROXY_PORT || String(DEFAULT_PORT);
      const out = execSync(`curl -sf --max-time 3 http://127.0.0.1:${port}/health`, { stdio: ["pipe", "pipe", "pipe"] }).toString();
      health = { status: 200, body: JSON.parse(out) };
    } catch (e) {
      health = { error: String(e.message || e) };
    }
  }

  if (health.error || health.status !== 200) {
    healthOk = false;
    push("oauth_ok", "FAIL", `service unreachable: ${health.error || `status ${health.status}`}`);
  } else if (!health.body || typeof health.body !== "object") {
    healthOk = false;
    push("oauth_ok", "FAIL", "service /health returned 200 but empty/non-JSON body");
  } else {
    const auth = classifyAuthOk(health.body);
    if (!auth.oauthOk) oauthOk = false;
    oauthLevel = auth.level;
    push("oauth_ok", auth.level, auth.message);
  }

  const kind = !healthOk ? "fix_service" : !oauthOk ? "fix_oauth" : "noop";

  let next_action;
  // Issue #348: same resolution as the full path (see scripts/lib/install-dir.mjs). This one only builds the ai_executable
  // strings, but printing `~/ocp/ocp doctor --check oauth` to an operator whose install is at
  // /opt/ocp is a remediation step that cannot work when pasted.
  const { dir: ocpDir } = resolveInstallDir(opts);
  if (kind === "noop") {
    // `ocp doctor --check oauth` exists to answer "is OAuth OK?", so reporting "OAuth healthy"
    // when the honest answer is "no probe has concluded yet" is the same overclaim #289 is about,
    // on the very path doctor's own fix_oauth remediation tells the operator to re-run. `kind`
    // deliberately stays "noop" — a WARN must not gate anything (see classifyAuthOk) — only the
    // verify string stops asserting a state that was never established.
    next_action = { kind, human_required: [], ai_executable: [],
      verify: oauthLevel === "WARN"
        ? "auth state not yet established — re-run `ocp doctor --check oauth` after the next probe"
        : "OAuth healthy" };
  } else if (kind === "fix_oauth") {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `cd "$(npm root -g)/@anthropic-ai/claude-code" && node install.cjs`,
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor --check oauth`
      ],
      // Same as the full path's fix_oauth verify above (independent review LOW-2 on #289).
      verify: "ocp doctor --check oauth expects PASS (WARN immediately after the restart is expected — the first auth probe has not concluded yet; re-run once it has)",
      reference: "~/.cc-rules/memory/learnings/ocp_claude_native_binary_postinstall.md"
    };
  } else {
    next_action = {
      kind,
      human_required: [],
      ai_executable: [
        `launchctl bootout gui/$(id -u)/dev.ocp.proxy 2>/dev/null || true`,
        `launchctl bootstrap gui/$(id -u) ${join(homedir(), "Library", "LaunchAgents", "dev.ocp.proxy.plist")}`,
        `${ocpDir}/ocp doctor --check oauth`
      ],
      verify: "ocp doctor --check oauth expects service_running=PASS"
    };
  }

  const fail_count = checks.filter(c => c.level === "FAIL").length;
  // "skipped" = --check oauth fast path intentionally omits version detection.
  // AI agents should NOT semver-compare against current_version/latest_version when
  // either equals "skipped"; the full path provides those fields when needed.
  return {
    schema_version: SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    ready_to_upgrade: fail_count === 0,
    current_version: opts.mockVersion || "skipped",
    latest_version: opts.mockLatest || "skipped",
    from_version_supported: true,
    fail_count,
    // Computed, not the literal 0 it used to be (independent review MEDIUM-1 on #289). The
    // literal was correct while this path could only ever push PASS or FAIL; #289 made WARN
    // reachable here, and a hard-coded 0 then printed "Summary: 0 FAIL, 0 WARN" directly under
    // a [WARN] oauth_ok line and under-reported to any agent reading --json. That is the same
    // hard-coded-literal-asserting-an-unobserved-state defect this issue exists to remove, so
    // it is derived from `checks` exactly as the full run does it.
    warn_count: checks.filter(c => c.level === "WARN").length,
    checks,
    next_action
  };
}

// CLI entrypoint — use fileURLToPath + realpath to handle symlinked install paths
// (e.g. /tmp/ → /private/tmp/ on macOS would otherwise miss the guard).
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
function _isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch { return false; }
}
if (_isMain()) {
  const wantJson = process.argv.includes("--json");
  const checkIdx = process.argv.indexOf("--check");
  const checkOnly = checkIdx !== -1 ? process.argv[checkIdx + 1] : undefined;
  const result = await runDoctor({ checkOnly });
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`OCP doctor — ${result.current_version} → ${result.latest_version}`);
    for (const c of result.checks) console.log(`  [${c.level}] ${c.id}: ${c.message}`);
    console.log(`\nSummary: ${result.fail_count} FAIL, ${result.warn_count} WARN`);
    console.log(`Next action: ${result.next_action.kind}`);
  }
  process.exit(result.fail_count === 0 ? 0 : 1);
}
