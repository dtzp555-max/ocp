// OCP network helpers — shared so server.mjs, setup.mjs and tests use one definition. (issue #125)

// A bind address is "loopback" only if it cannot be reached from another host.
// Any other address (0.0.0.0, ::, a concrete LAN/Tailscale IP, etc.) is
// network-exposed and must trigger the LAN boot gates.
export function isLoopbackBind(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost" ||
         addr === "::ffff:127.0.0.1" || /^127\./.test(addr);
}

// Boot-time safety gate for non-loopback open-auth deployments with host-side tools granted
// (ADR 0026, #544). Mirrors the TUI LAN gate (ADR 0007) and OCP_LOCAL_TOOLS gate (lib/prompt.mjs):
// the default `-p` path grants host-side tools whenever AUTH_MODE !== "multi", so binding to a
// non-loopback address with open auth (`none`, `shared` without `PROXY_API_KEY`, or any
// unrecognised mode) lets any reachable peer execute host tools and reach admin endpoints without
// a token.
//
// Returns a fatal message string when the configuration must refuse to boot, or null when allowed.
// Pure — server.mjs supplies the resolved config and performs process.exit(1), so the predicate is
// unit-testable and its wiring is pinned by live-server integration tests (#343).
export function openLanSafetyError({
  bindAddress,
  loopbackBind,
  authMode,
  hasSharedKey,
  toolsGranted,
  tuiMode,
  allowOpenLan,
}) {
  if (tuiMode) return null; // TUI has its own stricter LAN gate (OCP_TUI_ALLOW_LAN=1, ADR 0007)
  if (loopbackBind) return null; // loopback-only bind: not network-exposed
  if (!toolsGranted) return null; // e.g. AUTH_MODE=multi empties built-in tools (--tools "")
  if (authMode === "shared" && hasSharedKey) return null; // non-loopback callers must present PROXY_API_KEY
  if (allowOpenLan) return null; // explicit operator opt-in (OCP_ALLOW_OPEN_LAN=1)
  const authDesc = authMode === "shared"
    ? "CLAUDE_AUTH_MODE=shared with no PROXY_API_KEY"
    : `CLAUDE_AUTH_MODE=${authMode}`;
  return (
    `non-loopback CLAUDE_BIND (${bindAddress}) with open auth (${authDesc}) and host-side tools granted is unsafe.\n` +
    `  Any reachable peer on the network could invoke pre-approved local tools (--allowedTools / --dangerously-skip-permissions) and access admin endpoints without a token.\n` +
    `  Fix by doing one of:\n` +
    `    1. Bind to loopback: CLAUDE_BIND=127.0.0.1 (default)\n` +
    `    2. Enable authentication: CLAUDE_AUTH_MODE=multi (recommended — per-user keys, empties built-in tools) or CLAUDE_AUTH_MODE=shared with PROXY_API_KEY\n` +
    `    3. Explicitly opt in: OCP_ALLOW_OPEN_LAN=1 (only behind a separate network boundary such as a firewall or VPN)`
  );
}

// Resolve setup.mjs's `--auth-mode` option given the chosen `--bind` address (ADR 0026, #544).
// Loopback installs keep defaulting to `none`; non-loopback installs without an explicit
// `--auth-mode` default to `multi` so `node setup.mjs --bind 0.0.0.0` produces a safe, bootable
// LAN config instead of one refused by openLanSafetyError.
// Any explicit non-`multi` auth mode on a non-loopback bind returns a `lanWarning` because
// install-autostart.mjs does not inject `PROXY_API_KEY` (so `shared` boots with no key and fails
// the gate) and `none` / unrecognised modes fail the gate unless `OCP_ALLOW_OPEN_LAN=1` is added.
export function resolveSetupAuthMode(args, bindAddress) {
  const list = Array.isArray(args) ? args : [];
  const idx = list.indexOf("--auth-mode");
  const explicit = idx >= 0 && list[idx + 1] && !String(list[idx + 1]).startsWith("--")
    ? String(list[idx + 1])
    : null;
  const loopback = isLoopbackBind(bindAddress);
  if (!explicit) {
    if (!loopback) return { authMode: "multi", defaultedForLan: true, lanWarning: null };
    return { authMode: "none", defaultedForLan: false, lanWarning: null };
  }
  if (loopback || explicit === "multi") {
    return { authMode: explicit, defaultedForLan: false, lanWarning: null };
  }
  const lanWarning = explicit === "shared"
    ? `Non-loopback --bind ${bindAddress} with --auth-mode shared: setup.mjs does not write PROXY_API_KEY into the service unit, so server.mjs will refuse to boot (ADR 0026) until you add PROXY_API_KEY to the launchd plist / systemd unit by hand — or re-run with --auth-mode multi.`
    : `Non-loopback --bind ${bindAddress} with explicit --auth-mode ${explicit}: server.mjs refuses open or unrecognised-auth LAN boots by default (ADR 0026) — set OCP_ALLOW_OPEN_LAN=1 in the service unit only behind a firewall/VPN, or re-run with --auth-mode multi.`;
  return { authMode: explicit, defaultedForLan: false, lanWarning };
}
