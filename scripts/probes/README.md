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
WORKING      = accumulated CPU time GREW across the sampling window
WEDGED       = it did not grow, AND the process was in uninterruptible sleep
inconclusive = it did not grow, and there was no uninterruptible sleep
               (a turn waiting on the upstream and one blocked forever are
                the same observation here — that is why this is a verdict)
```

**Why not `%CPU`.** It was the criterion until an independent review measured it wrong on both
platforms. On macOS `%CPU` is a **decaying average** — measured `2.1 → 0.0` with zero CPU consumed
in between — so a process that wedged two seconds ago shows a *falling* number, and "it varied" read
that decay as work. Measured directly against this script: a process that burned CPU and then
blocked forever on a fifo gave `%CPU 61.1 → 1.3 → 0.0` while its CPU time stayed flat at `7.51s`;
the old predicate answers **WORKING**, the current one answers **inconclusive**. On Linux the same
column is an average *since process start*, so a child that burned CPU at startup and then wedged
shows a **constant non-zero** value indefinitely. Accumulated CPU time is monotonic and has neither
failure.

**Platform.** Uninterruptible sleep is `STAT=U` on macOS/BSD and `D` on Linux. An earlier version
hardcoded `U` and told the reader to hand-edit for Linux, which made the `WEDGED` verdict **dead
code on Linux** — the platform OCP is normally deployed on — while `docs/troubleshooting.md` printed
the command with no platform note at all. The character now comes from `uname`, and an unrecognised
platform **exits 3** rather than probing with a letter that can never match.

**Why it is a rate.** `WORKING` requires CPU consumed at a minimum **rate**, not merely a counter
that moved. An earlier version asked only whether the counter moved, and an independent review
measured it answering `WORKING` for a permanently wedged process in **7 of 14** default runs: a Node
process blocked mid-`fetch` on a server that never replies still runs undici's timers and GC,
accumulating ~0.01 s per ~30 s, and Darwin's hundredths resolution records it. That is the *target*
class — an OCP-spawned `claude` wedged on the Anthropic API. The refuting evidence was already on the
verdict line, which printed `%CPU 0.0–0.0` next to the word `WORKING`.

**The threshold is 0.3 %, and the first number here was 2, which was wrong.** 2 was chosen to match
the `%CPU` threshold the pre-rate versions used. The same review then measured what a genuinely
*working* streaming turn costs, and it sits **below 2** — the floor had been placed above the signal
it exists to detect. Re-measured, one run, a Node SSE client parsing tokens off a real socket over a
20 s window:

| fixture | CPU as % of wall time |
|---|---|
| wedged — in-flight `fetch` to a black hole | **0.00 – 0.10 %** |
| working — streaming at 20 tok/s | **0.50 %** |
| working — streaming at 40 tok/s | 0.65 % |
| working — streaming at 100 tok/s | 1.30 % |
| busy loop | 99.80 % |

0.3 was chosen as ~3x above the highest wedged rate observed **at that time** and ~1.7x below the
slowest observed working one. **Both halves of that justification have since been falsified** — see
the section below: further sweeping found wedged fixtures at 0.90 %, 2.00 % and 5.00 %, all above
0.3, and the working population reaches down to 0.45 %. What 0.3 does today is a smaller and
defensible job: it separates *consuming CPU* from *not consuming CPU at this instrument's
resolution*, and makes no claim about which population a consuming process belongs to.

**There is no rate at which this instrument can say `WORKING`.** Above the floor the verdict is
always `CONSUMING CPU, WORKING-OR-WEDGED UNRESOLVED`, and the thing to decide on is whether the
client has actually **received bytes**.

That is not caution, it is the measurement. A wedged client — permanently blocked on a
never-answering socket — reaches whatever rate its timers happen to cost: **0.05 %** with no
heartbeat, **1.00 %** at 10 ms/s, **2.00 %** at 20 ms/s, **5.00 %** at 50 ms/s. Genuinely working
streams measured **0.55 %** (20 and 40 tok/s), 1.20 % (100), **1.85 %** (200), 2.25 % (400). The two
overlap, and **the wedged side has no ceiling** — a process spinning in a retry loop makes no
progress at 99 %.

**Two successive versions of this file put a boundary in the wrong place for the same reason**, and
the second is worth recording because it looked like the fix for the first. A `⚠ THIN MARGIN`
warning below 3x the floor cut *through* the overlap: a wedged process at 0.90 % got an unwarned
`WORKING` while working turns at 0.45 % and 0.75 % were warned. Replacing it with a confident band
at 2 % — calibrated against the measured *top of the working population* — moved the same inversion
up: a wedged fixture at 20 ms/s reaches exactly **2.00 %** and got confident `WORKING`, while a
working 200 tok/s stream at **1.85 %** got the caveat.

**The error both times was calibrating against the population that was measured rather than the one
the boundary must guard against.** The "highest wedged rate" each band rested on was an artifact of
where the sweep stopped, not a property of the population — and one more step of the sweep broke
each band in turn. This file already stated the principle for the *lower* boundary ("nothing bounds
the wedged side below the working side … this instrument cannot order them, at any threshold"); the
confident band was the one place it stopped applying its own sentence.

**What `MIN_RATE_PCT` (0.3 %) is now for**, and it is a smaller job than either band tried to do: it
separates *consuming CPU* from *not consuming CPU at this instrument's resolution*. It makes no claim
about which population a consuming process belongs to. Override with `MIN_RATE_PCT`.

**A retracted claim, recorded rather than quietly replaced.** An earlier version said a process below
the `time` column's resolution lands in *inconclusive*, "never `WORKING`". That followed only from the
Linux half of its own sentence, and it is false: fed 0.40 s of CPU across a 20 s window this script
answers `WORKING`, because 0.40/20 clears the rate floor. What resolution costs is precision in the
rate near the floor, not a guarantee about the verdict.


Verified in both directions against constructed processes, not read:

| process | observed | verdict |
|---|---|---|
| busy loop | `cpu_time 0.73 → 4.73s`, `%CPU 91.9–100.0` | **WORKING** |
| blocked forever on a fifo, settled | `cpu_time 0.00s` flat, `%CPU 0.0` | inconclusive |
| burned CPU, then blocked forever, probed inside the decay window | `cpu_time 7.51s` flat, `%CPU 61.1 → 1.3 → 0.0` | inconclusive — the old predicate answered **WORKING** here |
| `N=1` | one sample | inconclusive, and says why: growth needs two |
| unrecognised `uname` | — | refuses, exit 3 |

The **WEDGED** shape itself came from the incident rather than from a fixture — `STAT=U`, 0.2 % CPU,
9 minutes, killed before OCP's 600 s timer would have fired. A real uninterruptible-sleep process
cannot be constructed on demand, so that branch's *reachability* now rests on the `STAT` character
being right for the platform, which **is** tested, rather than on the branch having been exercised.
Said plainly rather than left for a reader to assume the table covers all four.

Three things it is built to avoid, all of which produce a confident wrong answer:

- **One sample cannot show growth at all**, so `N=1` is refused rather than answered. `samples` is
  this script's first positional argument, so `./wedged-or-working.sh 1` is one keystroke away — and
  an earlier version answered it with a verdict derived from `lo == hi`, which reported a process
  pegged at **83.2 %** as `inconclusive — %CPU never moved`.
- **`%CPU` moving is not evidence of work**, and `%CPU` standing still is not evidence of its
  absence. See "Why not `%CPU`" above; both directions are measured.
- **Duration is not the criterion.** A legitimate tool-using turn measured **248 s**; the wedged one
  ran 9 min. Long is not wedged.

The third verdict, `inconclusive`, is a real answer rather than a failure to reach one: a turn
waiting on the upstream API and a turn blocked forever produce the *same* observation, and forcing
that into one of two buckets is how the earlier version got it wrong.

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
