// OCP env-var parsing helpers.
//
// Fail-closed positive-integer parsing for numeric caps (body size, image
// byte/count limits). A misconfigured cap must NEVER silently disable a guard:
// `parseInt("unlimited", 10)` is NaN and `x > NaN` is always false, so a naive
// parse of CLAUDE_MAX_BODY_SIZE=unlimited would remove the body-size limit
// entirely (unbounded body → OOM). Likewise CLAUDE_MAX_BODY_SIZE=5MB naively
// parses to 5 (bytes) and bricks the proxy. So a present-but-invalid value is
// REJECTED (default kept, caller warns), not accepted. (PR #154 review F3.)
//
// Pure (no env access, no IO) so it is unit-testable without a live server.

// Parse `raw` as a strictly-positive base-10 integer of bytes/count (no unit
// suffix). Returns { value, ok, reason }:
//   - missing/empty        → { value: def, ok: true }               (use default)
//   - valid positive int   → { value: n,  ok: true }
//   - anything else        → { value: def, ok: false, reason }      (fail closed)
// Rejects: NaN ("unlimited"), non-positive ("0", "-1"), unit-suffixed ("5MB"),
// and fractional/ambiguous ("20.5", "0x10") values — String(n) !== trimmed catches
// any input parseInt only partially consumed.
export function parsePositiveInt(raw, def) {
  if (raw === undefined || raw === null || raw === "") return { value: def, ok: true };
  const trimmed = String(raw).trim();
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== trimmed) {
    return { value: def, ok: false, reason: "not a strictly-positive integer (bytes/count, no unit suffix)" };
  }
  return { value: n, ok: true };
}
