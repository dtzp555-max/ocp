/**
 * OCP shared constants — single source of truth.
 *
 * Any literal that appears in more than one place across server.mjs, setup.mjs,
 * scripts/* belongs here so port-drift / URL-drift cascades cannot recur.
 *
 * Background: from 2026-05-08 (PR #71 dogfood accident) through 2026-05-13
 * (v3.16.3) a single hardcoded "3478" in scripts/upgrade.mjs + scripts/doctor.mjs
 * cascaded into every downstream config write, ultimately taking out the
 * OpenClaw "大内总管" Telegram agent. See CHANGELOG v3.16.2 and v3.16.3.
 *
 * Adding a new constant: prefer ALL_CAPS_SNAKE_CASE. Document the consumers.
 * If a literal is referenced from a shell script (ocp, ocp-connect, setup.sh)
 * that can't import .mjs, add a `// keep in sync with lib/constants.mjs` note
 * at the shell-script reference; CI grep prevents drift.
 */

// Default TCP port the OCP HTTP proxy listens on. Set by env CLAUDE_PROXY_PORT
// at runtime; this is the fallback when env is unset.
// Consumers: server.mjs, setup.mjs, scripts/upgrade.mjs, scripts/doctor.mjs,
// scripts/sync-openclaw.mjs. Shell scripts ocp / ocp-connect keep the literal
// "3456" in sync with this value (see CI gate in .github/workflows/alignment.yml).
export const DEFAULT_PORT = 3456;

// Localhost bind for client-side fetches (curl, health checks).
export const LOCAL_HOST = "127.0.0.1";

// OpenAI-compatible API base path appended to the proxy URL.
export const OPENAI_API_BASE = "/v1";

// Convenience: full local URL the OCP proxy listens on by default.
// scripts that want to probe locally can use this directly.
export const LOCAL_PROXY_URL = `http://${LOCAL_HOST}:${DEFAULT_PORT}`;

// #324. How many CONSECUTIVE inconclusive auth probes make the last conclusive verdict stale.
//
// Consumers: server.mjs (produces `auth.consecutiveInconclusive` on /health) and
// scripts/doctor.mjs (decides FAIL vs WARN from it, which decides whether `ocp update` runs).
// It lives here rather than in either one because a threshold the producer and the decider
// disagree about is the drift this file exists to prevent — doctor would either refuse upgrades
// the server considers stale, or accept ones it does not.
//
// Denominated in PROBES, not time — deliberately, but worth knowing: at the default 10-minute
// interval 3 means roughly half an hour with nothing concluding, while a short
// CLAUDE_AUTH_CHECK_INTERVAL_MS shortens the wall-clock window to 3x that interval. Timeout-type
// inconclusives have a floor (the in-flight guard means they cannot arrive faster than about
// 3x CLAUDE_AUTH_CHECK_TIMEOUT_MS); spawn-failure-type ones do not. Kept a non-tunable constant
// for the same reason AUTH_DEGRADE_AFTER is one (ADR 0010): an operator-tunable threshold on a
// safety decision is a knob for turning the safety off.
export const AUTH_STALE_AFTER_INCONCLUSIVE = 3;
