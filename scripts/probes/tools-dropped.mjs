#!/usr/bin/env node
// Does OCP return `tool_calls` for a client that asks for one? (#467)
//
// The wire-level half of the #467 diagnosis: it talks to OCP directly and asserts on the response,
// so it needs no agent framework.
//
//   node scripts/probes/tools-dropped.mjs [--url <base>] [--model claude-opus-5]
//
//   --url defaults to LOCAL_PROXY_URL from lib/constants.mjs. It is imported rather than
//   spelled here: `.github/workflows/alignment.yml`'s port-literal SPOT check scans every
//   .mjs outside its exempt list, and scripts/ is not exempt.
//
//   exit 0 — tool_calls returned (the fixed state)
//   exit 1 — prose returned instead (the state #467 reports)
//   exit 2 — the request itself failed; neither state was established
//
// PROVENANCE. Designed, written and verified in BOTH directions by Claude Opus 5 on 2026-09-09
// against OCP 3.32.0, while diagnosing a real agent deployment. Originally Python; ported to .mjs
// here because the repo is native ESM throughout and this would otherwise have been its first .py
// file. The assertions and the fixture design below are unchanged from that original.
//
// THREE DESIGN CHOICES, each of which a naive rewrite would get wrong:
//
//   * `tool_choice` is "auto", NOT a forced call. A forcing tool_choice already returns a loud 400
//     (ADR 0013) and was never the silent case, so asserting on it would test a path that is
//     already correct and prove nothing about the reported one.
//   * The assertion is on `message.tool_calls` and `finish_reason` — NEVER on the prose. The prose
//     varies run to run, and that variance is itself layer 2 of the bug (the system-prompt wrapper
//     contradicting the granted tool surface), so a fixture asserting on it would flake for the
//     wrong reason and get "fixed" by loosening the wrong assertion.
//   * The tool is one the model provably CANNOT satisfy from its own knowledge — an opaque build id
//     behind a nonce — so "answered without calling it" cannot be a lucky guess.
//
// WHAT THIS PROBE CANNOT SEE, stated because a green run here is not a working agent. It reads what
// the client GOT. It cannot see whether OCP knows it dropped anything — that is `/health`'s
// `stats.toolRequestsDropped`, added in #468 — and neither can see the criterion that actually
// separates "the client's agent loop ran" from "OCP's inner CLI did the work and narrated it",
// which is the CLIENT's own per-session tool-call counter and needs a real OpenAI-wire client.
// Same task, same prompt: OCP `tool_call_count=0`/`api_call_count=0`; a native tool-calling API
// `1`/`2`. Capability tests pass on both sides, which is why the agent was dead for days and every
// check was green. USE THE THREE TOGETHER; none of them is sufficient alone.

import { LOCAL_PROXY_URL } from "../../lib/constants.mjs";

const args = process.argv.slice(2);
// A flag given with NO value used to fall back to the default silently. The default `--url` is a
// live OCP on this host, so a typo'd or truncated flag probed PRODUCTION and printed a verdict
// indistinguishable from one about the intended target. Refuse instead.
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`--${name} was given with no value. Refusing rather than silently using the ` +
      `default (${dflt}) — the default target is a real proxy, and a verdict about the wrong one ` +
      `looks exactly like a verdict about the right one.`);
    process.exit(2);
  }
  return v;
};
const url = opt("url", LOCAL_PROXY_URL);
const model = opt("model", "claude-opus-5");
const key = opt("key", "probe");
const timeoutMs = Number(opt("timeout", "180")) * 1000;

// Echo what was actually resolved. Every verdict below is ABOUT this target, and until an
// independent review pointed it out the output named neither the URL nor the model.
console.log(`probing ${url}  model=${model}  timeout=${timeoutMs / 1000}s`);

const TOOL = {
  type: "function",
  function: {
    name: "lookup_build_id",
    description: "Return the opaque build id for this deployment.",
    parameters: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] },
  },
};

const body = JSON.stringify({
  model, max_tokens: 200,
  tools: [TOOL], tool_choice: "auto",
  messages: [{
    role: "user",
    content: 'Call lookup_build_id with nonce="probe-1". You cannot know the build id without calling it.',
  }],
});

let data;
try {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    process.exit(2);
  }
  data = JSON.parse(text);
} catch (e) {
  // exit 2, not 1: a request that never completed establishes NEITHER state, and reporting it as
  // "tools were dropped" would be a negative predicate satisfied by an empty world.
  console.log(`request failed: ${e.message}`);
  process.exit(2);
}

const choice = data.choices?.[0] ?? {};
const msg = choice.message ?? {};
const calls = msg.tool_calls;
const fin = choice.finish_reason;

console.log(`  finish_reason : ${fin}`);
console.log(`  tool_calls    : ${calls ? "yes" : "NO"}`);
if (!calls) console.log(`  content       : ${JSON.stringify((msg.content || "").slice(0, 120))}`);

if (calls) {
  console.log("\nPASS — client-declared tool was called back.");
  process.exit(0);
}

// A 200 carrying NEITHER tool_calls NOR prose establishes neither state, so it is exit 2 like any
// other unusable answer — not exit 1, which asserts "prose came back instead". Measured: a stub
// returning `{}` with HTTP 200 used to exit 1 while printing `finish_reason : undefined` and an
// empty content, i.e. it reported the state #467 describes on evidence that showed nothing at all.
// This is the same rule the README already makes a principle of, applied one case further in.
if (!fin && !(msg.content || "").length) {
  console.log(`\nINCONCLUSIVE — HTTP 200 with no tool_calls, no finish_reason and no content. ` +
    `Neither state is established; this is not evidence that tools were dropped.`);
  process.exit(2);
}

console.log(`\nFAIL — tools accepted, no tool_calls emitted, finish_reason ${JSON.stringify(fin)} ` +
  `(reads as "finished normally"). A client has nothing to branch on.`);
process.exit(1);
