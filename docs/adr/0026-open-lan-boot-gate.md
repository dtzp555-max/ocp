# ADR 0026 — Open-LAN Boot Gate (`OCP_ALLOW_OPEN_LAN`)

- **Status**: Accepted (maintainer sign-off 2026-11-26)
- **Date**: 2026-11-26
- **Issue**: #544
- **Class**: Not endpoint-touching — boot-time safety gate evaluated before `server.listen()`, mirroring ADR 0007's TUI LAN gate and `localToolsSafetyError` (`lib/prompt.mjs`). No request handler, endpoint contract, or B.2 response key set is changed.

## Context

The boot gates for TUI mode (ADR 0007, `OCP_TUI_ALLOW_LAN=1`) and `OCP_LOCAL_TOOLS` (`localToolsSafetyError`) both refuse to start on a non-loopback bind, because any reachable peer on the network could drive host-side tools.

The default `-p` spawn path grants the same class of host-side tools (`--allowedTools Bash Read Write Edit Glob Grep WebSearch WebFetch Agent`, or `--dangerously-skip-permissions`) whenever `AUTH_MODE !== "multi"` (`TOOLS_GRANTED`), and sets `isAdmin = true` for every caller outside `multi` mode. Yet binding to a non-loopback address (`CLAUDE_BIND=0.0.0.0`, `::`, or a LAN/Tailscale IP) with open authentication (`CLAUDE_AUTH_MODE=none`, `CLAUDE_AUTH_MODE=shared` with `PROXY_API_KEY` unset, or an unrecognised mode) previously booted without refusing, printing only a banner line.

Three user-facing paths steered operators straight into that state without mentioning pre-approved host tools:
1. `ocp lan` printed `CLAUDE_BIND=0.0.0.0` + `ocp restart` with no auth mode.
2. `setup.mjs --bind 0.0.0.0` defaulted `--auth-mode` to `none`.
3. `README.md` listed `0.0.0.0` as "for LAN access" without noting the open-auth + host-tools exposure.

## Decision

1. **Fail-closed boot gate on open non-loopback `-p` deployments (`openLanSafetyError` in `lib/net.mjs`).**
   Before `server.listen()`, `server.mjs` refuses to start (`FATAL:` + `process.exit(1)`) when **all** of the following hold:
   - `TUI_MODE` is `false` (TUI mode already enforces its own stricter `OCP_TUI_ALLOW_LAN=1` gate on every non-loopback bind regardless of auth mode, ADR 0007);
   - `!isLoopbackBind(BIND_ADDRESS)` (network-exposed bind);
   - `TOOLS_GRANTED` is `true` (i.e. `AUTH_MODE !== "multi"`, so the `-p` spawn does not empty built-in tools);
   - effective auth is open: NOT (`AUTH_MODE === "shared"` with a non-empty `PROXY_API_KEY`) — fail-closed so `none`, `shared` without a key, and any unrecognised `CLAUDE_AUTH_MODE` value are all refused;
   - `OCP_ALLOW_OPEN_LAN !== "1"`.

2. **Explicit opt-in escape hatch (`OCP_ALLOW_OPEN_LAN=1`).**
   Symmetric with `OCP_TUI_ALLOW_LAN=1`, operators running behind an independent network-layer trust boundary (firewall, VPN, isolated VLAN) may explicitly opt in with `OCP_ALLOW_OPEN_LAN=1`. When this override actively bypasses the gate, `server.mjs` logs a boot warning and prints an `Open LAN override:` line in the startup banner.

3. **Steer user-facing LAN paths to safe defaults.**
   - `setup.mjs` (via pure helper `resolveSetupAuthMode` in `lib/net.mjs`): when `--bind` is non-loopback and `--auth-mode` is omitted, default to `multi` (per-user keys, `--tools ""`) instead of `none`, and log why. Explicit `--auth-mode` flags are respected; any explicit non-`multi` `--auth-mode` on a non-loopback bind emits a warning (for `shared`, noting that `setup.mjs` does not write `PROXY_API_KEY` into the service unit so it must be added by hand; for `none` or unrecognised modes, noting `OCP_ALLOW_OPEN_LAN=1`).
   - `ocp lan`: steer operators to `node setup.mjs --bind 0.0.0.0 --auth-mode multi` (or setting `CLAUDE_AUTH_MODE=multi` / `shared` + `PROXY_API_KEY`) and mention `OCP_ALLOW_OPEN_LAN=1`.
   - `README.md`, `docs/lan-mode.md`, and `CHANGELOG.md`: document the gate, the opt-in, and the safe LAN modes.

## Consequences

- **Breaking for one specific unauthenticated LAN configuration:** an existing deployment running `CLAUDE_BIND=0.0.0.0` (or another non-loopback address) with `CLAUDE_AUTH_MODE=none` or `CLAUDE_AUTH_MODE=shared` (without `PROXY_API_KEY`) will now refuse to boot until the operator switches to `multi`, sets `PROXY_API_KEY` under `shared`, binds to loopback, or explicitly sets `OCP_ALLOW_OPEN_LAN=1`.
- **Authenticated and loopback deployments unchanged:** default `127.0.0.1` installs, `AUTH_MODE=multi` LAN servers, `AUTH_MODE=shared` + `PROXY_API_KEY` LAN servers, and `CLAUDE_TUI_MODE=true` + `OCP_TUI_ALLOW_LAN=1` deployments all continue to boot without change.
- **No request-handler impact:** the gate runs before `server.listen()`; Class A, Class B.1, and Class B.2 endpoint wire contracts and the B.2 response key-set snapshot are unchanged.
