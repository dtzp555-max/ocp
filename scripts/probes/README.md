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
| `tools-dropped.mjs` | what the **client got** | whether OCP knows it dropped anything — it never reads `/health` |
| `/health`'s `stats.toolRequestsDropped` (#468) | what the **server dropped** | anything the client experienced that OCP did not cause |
| the client's per-session **tool-call counter** | **which side ran the loop** | everything else |

**The asymmetry is real but it does not run both ways, and an earlier version of this table claimed
it did.** On this codebase `server.mjs` emits no `tool_calls` anywhere, so `toolRequestsDropped > 0`
**entails** the client got none — that direction is an entailment, not a second independent
instrument.

The genuine one-way gap is the other direction, and it is the reason the probe alone is not enough:
**probe exit 1 does NOT entail OCP dropped anything.** Under `tool_choice: "auto"` a prose answer is
spec-legal (`lib/tool-support.mjs` says so in as many words), so exit 1 is also what a *correct*
backend returns when the model simply declines to call. The unanswerable-nonce design narrows that
window; it does not close it. Only `stats.toolRequestsDropped` distinguishes "OCP dropped the tools"
from "the model chose not to use them".

So: **use them together**, and note that an exit code and a count are different quantities — their
both being `1` in #468's cross-check is a coincidence of value, not evidence of agreement.

---

## `tools-dropped.mjs` — the wire-level criterion

Asks OCP for a tool call the model provably cannot answer from knowledge, with `tool_choice: "auto"`.

```
node scripts/probes/tools-dropped.mjs [--url <base>] [--model claude-opus-5]

  exit 0  tool_calls came back        (the fixed state)
  exit 1  prose came back instead     (the state #467 reports)
  exit 2  the request itself failed   (NEITHER state established)
```

`--url` defaults to `LOCAL_PROXY_URL` from `lib/constants.mjs`. The port is deliberately not
spelled here or in the probe: `alignment.yml`'s port-literal SPOT check scans every `.mjs`
outside its exempt list, and `scripts/` is not exempt.

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
WEDGED       = uninterruptible wait (U), AND peak %CPU < 2
WORKING      = no uninterruptible wait, AND (%CPU varied OR peak %CPU >= 2)
inconclusive = anything else — including a FLAT NEAR-ZERO %CPU with no U
```

Verified both ways: **WORKING** against a live 600-word generation (`STAT=S`, %CPU 0.1 → 8.7); the
**WEDGED** shape came from the incident itself — `STAT=U`, 0.2 % CPU, 9 minutes, killed before
OCP's 600 s timer would have fired.

Two things it is built to avoid, both of which produce a confident wrong answer:

- **One sample is not enough — for a turn that is WAITING.** A working turn spends most of its wall
  clock waiting on the upstream, and a single reading of *that* is indistinguishable from a wedged
  one. Variance across samples is what separates them, which is why the script takes several and
  prints them all rather than a verdict from one.

  It is **not** the only signal, and an earlier version of this page said it was: a turn actually
  *computing* is distinguishable from **one** sample, because its `%CPU` is simply high. The
  predicate is therefore `varied OR peak >= 2`, not `varied` alone — measured, a strict
  variance-only rule reported a process pegged at **83.2 %** as `inconclusive — %CPU never moved`,
  because at `N=1` the low and the high are the same number and `samples` is this script's first
  positional argument.
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
