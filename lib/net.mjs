// OCP network helpers — shared so server.mjs and tests use one definition. (issue #125)

// A bind address is "loopback" only if it cannot be reached from another host.
// Any other address (0.0.0.0, ::, a concrete LAN/Tailscale IP, etc.) is
// network-exposed and must trigger the TUI LAN gate.
export function isLoopbackBind(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "localhost" ||
         addr === "::ffff:127.0.0.1" || /^127\./.test(addr);
}
