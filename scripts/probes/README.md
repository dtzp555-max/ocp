# Probes from the #467 diagnosis

Three instruments for the failure in [#467](https://github.com/dtzp555-max/ocp/issues/467): an
OpenAI-protocol agent pointed at OCP does not fail — it **degrades into a chatbot**, with HTTP 200,
`finish_reason: "stop"`, `ocp health` ok, `recentErrors` empty and clean logs on both sides.

**Provenance.** Designed and verified in both directions by **Claude Opus 5 on 2026-09-09** against
**OCP 3.32.0**, on macOS (bash 3.2, BSD `ps`), while diagnosing a real agent deployment.
`tools-dropped.mjs` was originally Python and was ported to `.mjs` here because this repo is native
ESM throughout; its assertions and fixture design are unchanged.

---

## ⚠️ None of the three is sufficient alone

This is the single most important thing on this page, and it is why the failure survived days of
green checks.

| instrument | reads | blind to |
|---|---|---|
| `tools-dropped.mjs` | what the **client got** | whether OCP knows it dropped anything |
| `/health`'s `stats.toolRequestsDropped` (#468) | what the **server dropped** | whether the client had anything to branch on |
| the client's per-session **tool-call counter** | **which side ran the loop** | everything else |

The first two were run against the same request during #468's review and both reported `1` —
pointing at the same event from opposite ends. **Neither alone would have been enough**, and the
third is not a script at all. Use them together.

---

## `tools-dropped.mjs` — the wire-level criterion

Asks OCP for a tool call the model provably cannot answer from knowledge, with `tool_choice: "auto"`.

```
node scripts/probes/tools-dropped.mjs [--url http://127.0.0.1:3456] [--model claude-opus-5]

  exit 0  tool_calls came back        (the fixed state)
  exit 1  prose came back instead     (the state #467 reports)
  exit 2  the request itself failed   (NEITHER state established)
```

**Exit 2 is not a detail.** A request that never completed establishes neither state, and reporting
it as "tools were dropped" would be a negative predicate satisfied by an empty world. All three
exits were verified reachable: 0 against a stub returning `tool_calls`, 1 against a live OCP, 2
against a dead port.

Three deliberate choices, so a fixture built on it does not drift:

- **`tool_choice` is `"auto"`, not forced.** A forcing `tool_choice` already returns a loud 400
  (ADR 0013) and was never the silent case; asserting on it tests a path that is already correct.
- **Asserts on `message.tool_calls` and `finish_reason`, never on the prose.** The prose varies run
  to run — that variance *is* layer 2 of the bug — while the absence of `tool_calls` does not. A
  fixture asserting on prose would flake for the wrong reason and get "fixed" by loosening the
  wrong assertion.
- **The tool is unanswerable from knowledge** (an opaque build id behind a nonce), so "answered
  without calling it" cannot be a lucky guess.

## `wedged-or-working.sh` — the triage criterion

Classifies a long-running OCP-spawned `claude` child.

```
WEDGED  = STAT contains U (uninterruptible wait) AND %CPU stays near zero across samples
WORKING = STAT S/R AND %CPU fluctuates
```

Verified both ways: **WORKING** against a live 600-word generation (`STAT=S`, %CPU 0.1 → 8.7); the
**WEDGED** shape came from the incident itself — `STAT=U`, 0.2 % CPU, 9 minutes, killed before
OCP's 600 s timer would have fired.

Two things it is built to avoid, both of which produce a confident wrong answer:

- **One sample is not enough.** A working turn spends most of its wall clock waiting on the
  upstream, so a single reading of a healthy turn is indistinguishable from a wedged one. **The
  signal is the variance**, which is why it takes several samples and prints them all rather than a
  verdict from one.
- **Duration is not the criterion.** A legitimate tool-using turn measured **248 s**; the wedged one
  ran 9 min. Long is not wedged.

It also has a third verdict — `inconclusive`, when `U` is seen but CPU peaked — rather than forcing
every reading into one of two buckets.

Portability notes are in the script header: Linux `STAT` is `D` not `U`, and Linux `ps %CPU` is an
average since process start rather than an instantaneous sample — use `top -b -n1 -p <pid>` there.

## The third criterion, which is not a script

The one that actually separated cause from symptom: **the client's own per-session tool-call
counter** — because on the OCP side the work *appears* to happen, so **every capability test passes
either way**.

Same task, same prompt, two backends:

| backend | client `tool_call_count` | client `api_call_count` | who executed |
|---|---|---|---|
| OCP | **0** | 0 | OCP's inner `claude -p`, result returned as prose |
| native tool-calling API | **1** | 2 | the client |

Any agent framework recording per-session tool-call counts will show this. **It is not scriptable
against OCP alone**: the whole point is that it measures *which side ran the loop*, so a `curl`
cannot see it. As a fixture it needs a minimal OpenAI-wire client that declares one tool, executes
it, and counts.

## Already ruled out — do not re-measure

- **Not context length.** none / 20 KB / 100 KB / 300 KB → 4.1 / 2.8 / 4.9 / 4.5 s.
- **Not the network.**
