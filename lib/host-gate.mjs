// ── ADR 0020: which `Host` names may vouch for a same-origin request ─────────────────────
//
// ADR 0019 admits a request whose `Origin` host equals its `Host` header. That is strictly
// stronger than an allowlist for the CROSS-origin case — a browser sets both headers itself and
// `Host` is a forbidden header name, so an attacker page cannot make them match from a different
// origin. It does nothing against DNS REBINDING, where the request is GENUINELY same-origin: the
// attacker serves their page on this port, flips the A record to 127.0.0.1, and the browser sends
// their domain in both headers, equal by construction. No Origin check can close that (#446).
//
// THE DISCRIMINATOR IS NOT "is this local". It is: CAN AN ATTACKER WHO CONTROLS PUBLIC DNS POINT
// THIS NAME AT 127.0.0.1? That question has a mechanical answer for two families of name, and only
// those two are safe without the operator saying anything:
//
//   - An IP LITERAL. Reaching the server with `Host: 100.101.102.103` means the browser connected
//     to that address WITHOUT A DNS LOOKUP. There is no record to rebind. This is what keeps
//     `[::1]`, a Tailscale CGNAT address, a LAN address and a public IP working with no config.
//   - `localhost`, `*.localhost` (RFC 6761 §6.3) and `*.local` (RFC 6762 §3). Both are reserved
//     names that a resolver is required NOT to send to public DNS, so no public record exists to
//     flip. This is what keeps an mDNS dashboard (`ocp-host.local`) working with no config.
//     FAILURE CONDITION, stated because it is the one assumption here that a deployment can break:
//     a resolver configured to forward these to public DNS anyway (some corporate split-horizon
//     setups do) reopens rebinding for that name. An operator in that position pins the name with
//     an IP literal or removes the forwarding; OCP cannot detect it from inside a request.
//
// Every OTHER name — `ocp.example.com` and `r.attacker.example` alike — is a public DNS name, and
// FROM INSIDE A REQUEST THE TWO ARE INDISTINGUISHABLE. That is not a limitation of this code; it
// is the whole mechanism of the attack. So the operator declares theirs in `OCP_ALLOWED_HOSTS` and
// the attacker cannot. This is the same shape Vite (`server.allowedHosts`), webpack-dev-server
// (`allowedHosts`) and Jupyter (`allow_remote_access`) settled on, for the same reason.
//
// Everything here is pure so the decision can be tested without a socket; `server.mjs` supplies the
// three header values and the already-computed private-range verdict.

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_BRACKETED = /^\[[0-9a-f:.]+\]$/;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/;

/**
 * Split a `host[:port]` authority into its parts.
 *
 * Hand-rolled rather than `new URL("http://" + raw)` on purpose: the URL parser normalises a
 * default port away (`example.com:80` -> `example.com`), percent-escapes rather than rejecting
 * some invalid hostnames, and accepts a trailing path — three behaviours that would each turn a
 * malformed header into a plausible-looking parse instead of a refusal. Returns null on anything
 * it cannot account for, and every caller treats null as "refuse".
 */
export function parseAuthority(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s || s.length > 260) return null;
  let hostname = s, port = "";
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close === -1) return null;
    hostname = s.slice(0, close + 1);
    const rest = s.slice(close + 1);
    if (rest) {
      if (rest[0] !== ":") return null;
      port = rest.slice(1);
    }
  } else {
    const colon = s.indexOf(":");
    if (colon !== -1) {
      if (s.indexOf(":", colon + 1) !== -1) return null; // bare IPv6 without brackets, or junk
      hostname = s.slice(0, colon);
      port = s.slice(colon + 1);
      // A trailing colon carries no port, and the port checks below are all guarded on `port !==
      // ""` — so without this line `host:` would parse as the bare host `host`. Found by the unit
      // test's refusal list, not by reading this function.
      if (port === "") return null;
    }
  }
  if (port !== "" && !/^\d{1,5}$/.test(port)) return null;
  if (port !== "" && (Number(port) === 0 || Number(port) > 65535)) return null;
  if (!hostname) return null;
  // THE ROOT DOT IS NORMALISED HERE, not in each consumer. Node's `URL` PRESERVES it
  // (`new URL("http://ocp.example.com.").host` === "ocp.example.com."), so a browser at a
  // fully-qualified URL reaches this with a trailing dot — and `isRebindSafe` used to strip it
  // while `matchesDeclared` compared raw, ten lines apart. The visible consequence was a 403
  // telling the operator to declare a host they HAD declared. Found by independent review.
  // `ocp.example.com.` and `ocp.example.com` are the same name; making that true once, in the
  // parser, is what keeps the two consumers from disagreeing again.
  if (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname) return null;
  if (IPV6_BRACKETED.test(hostname)) return { hostname, port, literal: true };
  if (IPV4.test(hostname)) {
    if (hostname.split(".").some((o) => o.length > 1 && o[0] === "0")) return null;
    if (hostname.split(".").some((o) => Number(o) > 255)) return null;
    return { hostname, port, literal: true };
  }
  if (!DNS_NAME.test(hostname)) return null;
  return { hostname, port, literal: false };
}

/**
 * Can this name be pointed at 127.0.0.1 by someone who controls public DNS? See the header comment
 * — an IP literal cannot (no lookup happened), and RFC 6761 / RFC 6762 reserved names cannot
 * (no public record exists). Everything else can, and must be declared.
 */
export function isRebindSafe(authority) {
  if (!authority) return false;
  if (authority.literal) return true;
  // No trailing-dot strip here: `parseAuthority` already did it, for EVERY consumer. Doing it
  // twice is how the two functions drifted apart in the first place.
  const h = authority.hostname;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  return false;
}

/** An entry with no port matches any port; an entry WITH one matches only that port. */
export function matchesDeclared(authority, declared) {
  if (!authority || !declared || declared.length === 0) return false;
  for (const d of declared) {
    if (d.hostname !== authority.hostname) continue;
    if (d.port === "" || d.port === authority.port) return true;
  }
  return false;
}

/**
 * Parse `OCP_ALLOWED_HOSTS`. Unparseable tokens are returned separately rather than dropped in
 * silence: a typo'd entry is a name the operator BELIEVES they declared, and a silently shorter
 * list would present as "the gate is broken" at the worst moment. `server.mjs` logs them at boot.
 * Not fatal — refusing to boot on a typo takes the proxy down to fix a misspelling.
 */
export function parseAllowedHosts(raw) {
  const hosts = [], invalid = [], defaultPort = [];
  // COMMA ONLY, never whitespace. Splitting on whitespace too would turn the typo `my host.tld`
  // into two entries and SILENTLY DECLARE `my` — an operator's slip widening the allowlist is the
  // opposite of what this setting is for. One comma-separated field is one declaration, or it is
  // reported as invalid.
  for (const raw_tok of String(raw == null ? "" : raw).split(",")) {
    const tok = raw_tok.trim();
    if (!tok) continue;
    const a = parseAuthority(tok);
    if (!a) { invalid.push(tok); continue; }
    // `Origin` never carries a default port — `new URL("https://h.example:443").host` yields the
    // bare host — so a declaration that names one usually cannot match, and the operator gets a
    // 403 saying "declare this host" for a host they DID declare. Flagged so the fix is a sentence
    // rather than a debugging session.
    //
    // FAILURE CONDITION, and it is why this can only ever WARN (规则 5). The default port is PER
    // SCHEME, and a declaration carries no scheme, so this is a heuristic and it has a measured
    // false positive:
    //
    //     new URL("https://h.example:443").host -> "h.example"       port dropped
    //     new URL("http://h.example:443").host  -> "h.example:443"   port KEPT
    //     new URL("https://h.example:80").host  -> "h.example:80"    port KEPT
    //
    // So an operator serving PLAIN HTTP on 443 (TLS terminated upstream) has a WORKING declaration
    // that this flags. The literals will not rot — 443/80 are fixed by WHATWG's special-scheme
    // table and OCP only ever sees http/https — what rots is the APPLICABILITY. That is the
    // difference between "the number is wrong" and "the rule the number implements is narrower
    // than the sentence beside it", and an earlier version of this comment asserted the sentence.
    // Found by independent review, measured not argued. Because the flag can be wrong, the entry
    // is KEPT and the boot line says "usually", never "never" — and it must never become a
    // rejection: that would break a working deployment on a heuristic.
    if (a.port === "443" || a.port === "80") defaultPort.push(tok);
    hosts.push(a);
  }
  return { hosts, invalid, defaultPort };
}

/**
 * The whole inbound-Origin decision, as data. `reason` is what gets logged and is how a test tells
 * "admitted because same-origin" apart from "admitted because the operator declared it" — two
 * outcomes that are identical on the wire and must not be identical in evidence.
 */
export function evaluateOriginGate({ origin, hostHeader, method, declaredHosts = [], isPrivateOrigin = false }) {
  if (!origin) return { allow: true, reason: "no-origin" };
  if (method === "GET" || method === "HEAD") return { allow: true, reason: "method-exempt" };

  let originHost = null;
  try { originHost = new URL(origin).host; } catch { /* `null`, opaque, or malformed */ }
  const originAuthority = originHost ? parseAuthority(originHost) : null;

  // The operator declared this origin. Checked BEFORE same-origin because it is the arm that
  // rescues a Host-REWRITING reverse proxy, where `Host` is the upstream's own address and can
  // never equal the public Origin the browser sends.
  if (matchesDeclared(originAuthority, declaredHosts)) return { allow: true, reason: "declared-origin" };
  if (isPrivateOrigin) return { allow: true, reason: "private-origin" };

  if (originHost !== null && originHost === String(hostHeader || "")) {
    const hostAuthority = parseAuthority(hostHeader);
    if (isRebindSafe(hostAuthority) || matchesDeclared(hostAuthority, declaredHosts)) {
      return { allow: true, reason: "same-origin" };
    }
    // Genuinely same-origin, and that is exactly why it is refused: a public DNS name vouching for
    // itself is the rebinding shape. Distinct reason because the operator's fix is different.
    return { allow: false, reason: "undeclared-host" };
  }
  return { allow: false, reason: "foreign-origin" };
}
