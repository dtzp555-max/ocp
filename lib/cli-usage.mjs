// #512 PR-1: what a spawn cost, read from the CLI's own stream-json events, reduced to fields
// that are safe to log (numbers and short enums, never content).
//
// Source: `claude -p --output-format stream-json --verbose`. Shapes measured on CLI 2.1.280
// (2026-09-25); they are not a documented contract, so every field is optional and a shape this
// module does not recognise yields null rather than a guess. Re-measure if a CLI upgrade makes
// these fields disappear from `claude_ok` / `claude_stream_event`.

const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? out : null;
}

// `result.usage` -> the four counts that decide what a request cost against the prompt cache.
// `input_tokens` is the UNCACHED remainder only; what the whole prompt cost is the sum of the
// three input fields. A request whose conversation is re-written into the cache every call shows
// up here as a large cacheWriteTokens and a cacheReadTokens that never grows (#512).
export function summarizeResultUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return compact({
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
  });
}

const SHORT = (v) => (typeof v === "string" && v.length <= 64 ? v : undefined);
const MAX_WINDOWS = 4;

// `rate_limit_event.rate_limit_info` -> status, which limit, when it resets, and the utilization
// of each window the CLI reports (`unifiedWindows`: five_hour and seven_day on 2.1.280).
// Bounded: at most MAX_WINDOWS windows, short string keys, numbers only inside each.
export function summarizeRateLimitEvent(event) {
  const info = event && typeof event === "object" ? event.rate_limit_info : undefined;
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  let windows;
  const uw = info.unifiedWindows;
  if (uw && typeof uw === "object" && !Array.isArray(uw)) {
    for (const [name, w] of Object.entries(uw).slice(0, MAX_WINDOWS)) {
      if (name.length > 32 || !w || typeof w !== "object") continue;
      const util = typeof w.utilization === "number" && Number.isFinite(w.utilization) ? w.utilization : undefined;
      const one = compact({ utilization: util, resetsAt: count(w.resetsAt) });
      if (one) (windows ??= {})[name] = one;
    }
  }
  return compact({
    status: SHORT(info.status),
    rateLimitType: SHORT(info.rateLimitType),
    resetsAt: count(info.resetsAt),
    overageStatus: SHORT(info.overageStatus),
    overageDisabledReason: SHORT(info.overageDisabledReason),
    isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
    windows,
  });
}
