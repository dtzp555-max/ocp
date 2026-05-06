# Design: Response Cache Upgrade (Per-Key Isolation, cache_control Bypass, Chunked Stream Replay, Singleflight)

**Date:** 2026-05-07
**Status:** Draft (awaiting maintainer approval)
**Target version:** v3.13.0 (minor — internal correctness/concurrency improvements; no new public env vars or endpoints)
**Driving ADR:** [ADR 0005 — No Multi-Provider](../../adr/0005-no-multi-provider.md), decision §3 ("Cache improvements are in scope")

---

## Overview

OCP already has a response cache (`keys.mjs:296` `cacheHash` / `keys.mjs:311` `getCachedResponse` / `keys.mjs:324` `setCachedResponse`), wired into the proxy core at `server.mjs:1220` (non-streaming path read), `server.mjs:1227` (cache-hit-on-streaming-request replay), and `server.mjs:683` (streaming write-back). Today it has four functional gaps. This PR pair closes all four, in two minimum-reviewable units, **without changing the public API surface**.

| Gap | Impact today | Fix lands in |
|---|---|---|
| All keys share one cache pool | Key A's cache hit can leak Key B's prompt response | PR-A |
| Anthropic `cache_control` markers not detected | OCP cache may interfere with Anthropic prompt caching that the user explicitly requested | PR-A |
| Stream cache hit replays whole content in one SSE chunk | Downstream renders all-at-once; some SDKs misbehave on huge single deltas | PR-A |
| Concurrent identical cache misses all spawn `cli.js` independently | Cache stampede: N requests → N spawns → N billable calls | PR-B |

---

## Constitutional alignment (ALIGNMENT.md)

**`cli.js` does not perform response caching at the proxy layer.** The OCP response cache is a value-add operation that exists only inside OCP, between the wire (clients ↔ OCP) and the spawn (OCP ↔ `cli.js`). It does not introduce, rename, or alter any endpoint, header, request field, or response field that `cli.js` emits or expects. Cache hits return content byte-identical to what `cli.js` returned on the original miss, with the same `chat.completion` / `chat.completion.chunk` shape — **no client-observable wire shape change**.

This PR pair extends the existing cache (introduced in earlier commits) without expanding its surface. No new endpoints. No new headers. No new env vars exposed publicly (we add internal counters readable via the existing `/cache/stats` endpoint, but the response shape only gains numeric fields, not new structural fields).

Per Rule 1 / Rule 5: every commit body in this PR pair will state the absence of `cli.js` reference explicitly and justify scope under Rule 2's value-add carve-out for non-wire-affecting proxy operations.

---

## Key decisions (with rationale)

### D1. Per-key isolation via hash input, not schema column

`cacheHash` gains an optional `keyId` input. Distinct `keyId` values produce distinct hashes for the same prompt, so SQLite-level isolation falls out for free without a schema change.

**Rationale.** Adding a `key_id` column to `response_cache` requires either (a) dropping the existing `hash UNIQUE` index and replacing with a composite `(hash, key_id) UNIQUE`, which SQLite cannot do via plain `ALTER TABLE` and would require a table-rebuild migration, or (b) tolerating duplicate `hash` rows, which contradicts the existing schema comment and breaks `setCachedResponse`'s `ON CONFLICT(hash)` upsert clause.

The hash-input approach is reversible (we can switch to a schema column later if analytics across keys becomes a real need) and zero-risk on the SQL plane. The trade-off — losing the ability to query "which keys have cached this prompt?" — has no current consumer.

**Hash input format.** `cacheHash` prepends a version tag and key tag before the existing inputs:

```
v2|k:<keyId or "anon">|<model>|...rest as today
```

The `v2` prefix means existing v1-format rows in the cache table no longer hash-match any new request. They are abandoned, not deleted; the existing TTL-based `clearCache(CACHE_TTL)` cleanup interval at `server.mjs:185` reaps them within one TTL window. **No migration step is needed.** This is acceptable because the cache is by definition ephemeral and best-effort.

**Anonymous fallback.** When the request has no authenticated key (`req._authKeyId === undefined`), `keyId` is `"anon"`. Anonymous-mode users (PROXY_ANONYMOUS_KEY or no auth) share one anonymous pool, which preserves the only legitimate today-multi-user use case (a household running OCP without per-user keys). If this becomes a problem we can add per-IP scoping later, but anonymous-pool sharing is acceptable for v1 because anonymous mode is fundamentally a trust-everyone-on-LAN posture.

### D2. `cache_control` bypass: detect anywhere, skip OCP cache entirely

If any element in `messages` (top-level or nested in `content` arrays) carries a `cache_control` field, OCP sets `req._cacheHash = null` and skips both lookup and write-back.

**Rationale.** Anthropic's [prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) is opt-in by client-side annotation. A user who annotates `cache_control: { type: "ephemeral" }` is explicitly requesting that *Anthropic's* cache serve the call (and is paying the reduced cache-read pricing). Layering OCP's response cache on top in this case is wrong on two counts:

1. The user's intent is "cache at provider, not at proxy." OCP overruling that intent silently is the same drift family as the 2026-04-11 incident — proxy invents behavior the upstream surface doesn't request.
2. OCP cache hits would make `usage.cache_read_input_tokens` (the client-observable signal that prompt caching worked) appear inconsistent — sometimes present, sometimes absent — depending on whether OCP cached.

Detection is purely structural: walk `messages`, for each `m` check `m.cache_control` (rare top-level form) and if `m.content` is an array, check each part. No semantic interpretation; if the field is present, we bypass.

**Implementation site.** A small helper `hasCacheControl(messages)` exported from `keys.mjs`, called in `handleChatCompletions` immediately before the existing `cacheHash` call. If it returns true, we skip the cache-lookup branch entirely.

### D3. Chunked stream replay (80 chars/chunk, no artificial delay)

Today's cache-hit-on-streaming-request branch (`server.mjs:1227–1237`) sends the entire cached content in a single `delta.content` chunk. This works for spec-compliant SSE clients but visibly degrades the UX (no incremental render) and has tripped at least one buggy SDK in the wild that assumes deltas are small.

The fix splits cached content into ~80-character substrings, each sent as a separate `chat.completion.chunk` SSE event. **No artificial delay between chunks** — they ship as fast as `res.write` accepts. This preserves OCP's "ship as fast as possible" disposition; we are simulating *the chunk shape* of streaming, not the *latency*.

**Why 80 chars?** Compromise: small enough that even a multi-paragraph cached response yields >5 chunks (visible incremental render), large enough that even a 4 KB response only produces 50 chunks (not 4000 single-char events). Tunable later via internal constant; not exposed as env var per scope-creep avoidance.

**Boundary safety.** UTF-8 multibyte characters: we slice by `Array.from(content)` (so each iteration step is a full code point) and group every 80 code points. This avoids producing invalid UTF-8 mid-character.

### D4. Singleflight stampede protection: in-process Map, all-or-nothing failure

`keys.mjs` exports `singleflight(hash, fn)`. An in-memory `Map<hash, Promise>` deduplicates concurrent identical cache-miss flows. The first request executes `fn()`; concurrent requests with the same hash receive the same promise. When the promise settles (resolve or reject), the map entry is deleted.

**Rationale (single-process scope).** OCP runs as a single Node.js process per host. A `Map` is sufficient. Adding Redis or another shared store would be the start of a multi-instance evolution, which is out of scope per ADR 0005 (OCP is a personal power tool, not a horizontally-scaled SaaS).

**All-or-nothing failure semantics.** When the leader's `fn()` rejects, all followers receive the same rejection. The alternative — letting followers retry independently after a leader failure — risks N retries of an already-broken upstream, which is exactly what stampede protection was meant to prevent. Followers can retry at the *next* request, with idle backoff handled by the client. This matches Go's `golang.org/x/sync/singleflight` reference behavior.

**Streaming caveat.** Singleflight wraps the *non-streaming* code path only in PR-B. For streaming, deduplicating concurrent identical streaming requests is materially harder (we'd need to fan out one upstream stream to N downstream connections in real time, with backpressure). It's also a less common case (cache stampedes typically come from non-streaming batch jobs hitting the proxy in parallel). Streaming dedup is **explicitly out of scope** for this PR pair; leave a TODO comment in `callClaudeStreaming` for a future ticket.

**Map size unboundedness.** In normal operation the map is empty most of the time (entries delete on Promise settlement). Pathological case: an upstream call that hangs forever leaks one Map entry per stuck request. The existing `TIMEOUT` guard on `callClaude` (server.mjs spawn timeout) bounds this — the Promise will reject (timeout) within `TIMEOUT` ms, and the entry clears. No additional sweep needed.

---

## PR boundaries

### PR-A — Foundation (D1 + D2 + D3)

**Files touched:**
- `keys.mjs`: extend `cacheHash` with optional `keyId`/version prefix; add `hasCacheControl(messages)` helper
- `server.mjs`: pass `req._authKeyId` to `cacheHash`; check `hasCacheControl` and bypass; chunk cache-hit replay at line 1227–1237
- `test-features.mjs`: add cases for keyId isolation, cache_control bypass, chunked replay shape

**LOC budget:** ~80 production + ~50 test
**Risk:** Low — all changes are additive or guard-clause; existing cache behavior preserved when `keyId` defaults to "anon" and no `cache_control` present.
**Backward compat:** v1-format hashes naturally orphan; TTL cleanup reaps within one window; no migration script.

### PR-B — Concurrency (D4)

**Files touched:**
- `keys.mjs`: add `singleflight(hash, fn)` and `getInflightStats()` exports
- `server.mjs`: wrap non-streaming cache-miss path through `singleflight`; add inflight count to `/cache/stats` response
- `test-features.mjs`: add concurrent-request test that asserts only 1 spawn occurs for N=10 simultaneous identical requests

**LOC budget:** ~70 production + ~40 test
**Risk:** Medium — concurrency code is harder to reason about; mitigation is an explicit test case for the dedup behavior.
**Streaming explicitly out of scope:** TODO comment placed in `callClaudeStreaming` for follow-up ticket.

---

## Testing strategy

**Unit-ish (in `test-features.mjs`):**
1. `cacheHash` with two different `keyId` values → different hashes
2. `cacheHash` v2 prefix present in output (sanity check)
3. `hasCacheControl` returns true for top-level `cache_control` and for nested in `content[]`
4. `hasCacheControl` returns false for benign messages
5. Chunked replay: cached "abcdefgh..." (160 chars) produces 2 deltas

**Integration (manual smoke before merge):**
1. Set `CLAUDE_CACHE_TTL=60000`; create key A and key B; identical prompt from each → both spawn fresh; second-call from same key → cache hit
2. Send a message with `cache_control` annotation → OCP logs `cache_skipped: cache_control_present`; no cache write
3. Streaming cache hit visibly produces multiple SSE deltas (`curl -N | grep "data: "` shows >1 lines)

**Concurrent (PR-B only):**
1. Spawn 10 simultaneous identical non-streaming requests; assert (via `/cache/stats` inflight peak or via a process spawn counter) only 1 `cli.js` spawn occurred

---

## Out of scope (deliberately deferred)

- **Streaming singleflight** — see D4 streaming caveat. TODO in code.
- **Semantic cache** (embedding-based near-match) — needs an embedding provider + vector index. Punt to v3.14+ if there's user demand.
- **Cross-process cache** (Redis backend) — violates ADR 0005's "personal power tool" posture.
- **Cache versioning by model ID hash** — model upgrades currently invalidate cache organically because model is in the hash; if Anthropic ever silently changes a model's behavior without a model ID bump, that's a separate alignment problem.
- **Per-key cache TTL override** — single global TTL (existing `CLAUDE_CACHE_TTL`) is fine; per-key TTL is a knob no one has asked for.

---

## Rollback plan

If either PR introduces a regression, the rollback is a clean git revert. The cache layer is opt-in (default `CLAUDE_CACHE_TTL=0` = disabled), so users who never enabled the cache are unaffected by any cache-layer regression. Users who *had* enabled the cache lose only ephemeral state on revert. No persistent on-disk state is reshaped by this PR pair (we explicitly avoid schema migrations per D1 rationale).
