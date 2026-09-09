#!/usr/bin/env bash
# Is a long-running OCP turn wedged, or is it genuinely working?
#
#   ./wedged-or-working.sh [samples] [interval_seconds]
#
# Criterion. The discriminator is the RATE at which the process consumes CPU,
# measured across this script's own sampling window from the MONOTONIC
# `ps -o time=` column -- never from the `%CPU` column, which lies differently
# on each platform (see PLATFORM below).
#
#   WORKING      = CPU consumed at >= MIN_RATE_PCT of wall time across the window.
#                  Positive evidence that the process is computing.
#   WEDGED       = below that rate, AND seen in uninterruptible sleep.
#                  Positive evidence that it is blocked in the kernel.
#   inconclusive = below that rate, and no uninterruptible sleep. This is BOTH
#                  what a turn waiting on the upstream looks like AND what one
#                  blocked forever looks like. "I don't know" is the honest
#                  answer there, not WORKING.
#
# WHY A RATE AND NOT "DID IT GROW AT ALL". A first version of this asked only
# whether the counter moved, and an independent review measured it reporting
# WORKING for a permanently wedged process in 7 of 14 default runs. A Node
# process blocked mid-`fetch` on a server that never answers still runs undici's
# timers and GC, accumulating ~0.01 s per ~30 s; Darwin's hundredths resolution
# records that, and a boolean "grew" cannot tell 0.05 % from 90 %. That is the
# exact target class -- an OCP-spawned `claude` wedged on the Anthropic API -- so
# it was the expensive error, not an edge case. The refuting evidence was already
# on the verdict line, which printed `%CPU 0.0-0.0` beside the word WORKING.
#
# MIN_RATE_PCT IS 0.3, AND THE FIRST NUMBER HERE WAS 2, WHICH WAS WRONG.
# 2 was chosen to match the %CPU threshold the pre-rate versions used. An
# independent review then measured what a genuinely WORKING streaming turn costs
# and it sits BELOW 2 -- i.e. the floor had been placed above the signal it exists
# to detect. Re-measured here, one run, a Node SSE client parsing tokens off a real
# socket over a 20 s window:
#
#     20 tok/s  -> 0.50 %      wedged (in-flight fetch to a black hole) -> 0.00-0.10 %
#     40 tok/s  -> 0.65 %      busy loop                                -> 99.80 %
#    100 tok/s  -> 1.30 %
#
# 0.3 was chosen as ~3x above the highest wedged rate observed AT THAT TIME and ~1.7x
# below the slowest observed working one. BOTH HALVES OF THAT HAVE SINCE BEEN
# FALSIFIED: further sweeping found wedged fixtures at 0.90%, 2.00% and 5.00%, all
# above 0.3, and the working population reaches down to 0.45%. Two successive bands
# built on "above every wedged rate measured" -- a 3x THIN MARGIN warning, then a
# confident band at 2% -- were each broken by one more step of the sweep, because the
# ceiling they rested on was where someone stopped measuring, not a property of the
# population.
#
# WHAT 0.3 DOES TODAY is a smaller and defensible job: it separates CONSUMING CPU from
# NOT CONSUMING CPU at this instrument's resolution. It makes no claim about which
# population a consuming process belongs to, and there is no upper band at all.
#
# EXPIRY -- keyed on the SEPARATION, not on any single observation. An earlier
# revision said "if a genuinely working turn is ever observed below 2 %, this
# number is wrong", and four lines later called exactly that outcome intended.
# Both cannot hold, and the review made the observation. So: if a WEDGED process is
# ever measured at or above this rate, or a WORKING one below it, the separation
# this constant rests on has collapsed -- re-measure BOTH fixtures and record the
# pair, rather than nudging the number toward whichever case you just saw.
#
# Why a single sample is not enough: a working turn spends most of its wall clock
# waiting on the upstream API, so ONE sample of a healthy turn looks identical to
# a wedged one. A rate needs two readings in any case, so N=1 is refused rather
# than answered.
#
# Why not "it has been running a long time": long is not wedged. A legitimate
# tool-using turn measured here ran 248 s; a wedged one ran 9 min at 0.2% CPU
# before being killed. Duration alone does not separate them.
#
# PLATFORM, and WHY THE DISCRIMINATOR IS NOT %CPU.
#
# Uninterruptible sleep is STAT 'U' on Darwin/BSD and 'D' on Linux. An earlier
# version hardcoded 'U' and told the reader in a comment to "swap the pattern
# below" for Linux — so on Linux, which is how OCP is normally deployed, the
# WEDGED branch was DEAD CODE and could never fire, while docs/troubleshooting.md
# printed the command with no platform note at all. Found by independent review.
# The character is now selected from `uname`, and an unrecognised platform
# REFUSES rather than silently probing with the wrong letter.
#
# %CPU is no longer the discriminator, in either branch. It is a DECAYING AVERAGE
# on Darwin — measured: 2.1 -> 0.0 with zero CPU consumed in between — so a
# process that wedged two seconds ago shows falling %CPU, and "the number moved"
# read that decay as work. On Linux the same column is an average since process
# start, so a child that burned CPU at startup and then wedged shows a CONSTANT
# non-zero value forever. Two platforms, two different ways for the same test to
# answer WORKING about a wedged process.
#
# ACCUMULATED CPU TIME (`ps -o time=`) has neither problem: it is MONOTONIC. The
# discriminator is the RATE at which it grows across this script's own window --
# NOT whether it grew, which was a separate defect with its own history below.
# %CPU is still printed, as context for a human, and is no longer tested.
#
# THE RESOLUTION FLOOR, and the claim about it that was RETRACTED. Darwin reports
# hundredths (measured `0:00.50` -> `0:02.50` across 2 s of busy-work); Linux
# reports whole seconds. An earlier revision concluded from the Linux half that a
# process below that resolution "is reported inconclusive, never WORKING" -- FALSE,
# and falsified in one run: fed 0.40 s of CPU across a 20 s window THE REVISION BEING
# DESCRIBED answered WORKING, because 0.40/20 cleared its rate floor. (This script no
# longer has a WORKING verdict at all -- the same input now answers UNRESOLVED at 2.00%.) What resolution actually
# costs is precision in the rate near the floor, not a guarantee about the verdict.

set -uo pipefail
N=${1:-6}; IV=${2:-4}
# A zero interval makes the window zero, and a rate over a zero window is not a
# small number -- it is not a number. The guard below would substitute 0.00% and
# print it as though it had been measured, which is the exact shape this script
# keeps removing. Refuse, the way N=1 is refused, and say why.
if [ "$IV" -le 0 ] 2>/dev/null || ! [ "$IV" -ge 1 ] 2>/dev/null; then
  echo "interval_seconds must be a WHOLE NUMBER >= 1 (got '${IV}')." >&2
  echo "  0 or non-numeric: there is no window to divide by, and the guard below would" >&2
  echo "  substitute 0.00% and print it as though it had been measured." >&2
  echo "  Fractional (0.5, 2.5): sleep accepts these and the window is real, but Linux's" >&2
  echo "  ps 'time' column has WHOLE-SECOND resolution, so a sub-second window quantises" >&2
  echo "  the rate to 0% or 200%. Refused for a different reason than 0 is -- an earlier" >&2
  echo "  version of this message gave only the first reason and refused both." >&2
  exit 3
fi
MIN_RATE_PCT=${MIN_RATE_PCT:-0.3}   # requested floor. The EFFECTIVE floor is the larger of this
                                    # and one TIME_QUANTUM over the window -- see below, because on
                                    # Linux this constant cannot be the thing that decides.
PAT='[c]laude --model'          # the bracket stops the GREP process matching itself in ps output (not this script's argv)

# Uninterruptible-sleep STAT character, chosen rather than assumed. Refuses on an
# unknown platform: a wrong letter here does not error, it silently makes the
# WEDGED verdict unreachable, which is the failure this replaces.
# TIME_QUANTUM is the smallest non-zero value this platform's `ps -o time=` can report,
# and it is picked here for the same reason UNINT is: guessing makes a check silently
# inoperative rather than loudly wrong. Darwin reports hundredths, Linux whole seconds.
case "$(uname -s)" in
  Darwin|*BSD*) UNINT='U'; TIME_QUANTUM=0.01 ;;
  Linux)        UNINT='D'; TIME_QUANTUM=1 ;;
  *) echo "unsupported platform $(uname -s): I do not know which ps STAT character means" >&2
     echo "uninterruptible sleep here, and guessing would make the WEDGED verdict silently" >&2
     echo "unreachable rather than wrong. Add the platform above and re-run." >&2
     exit 3 ;;
esac

# `ps -o time=` -> seconds. Handles [[DD-]HH:]MM:SS[.CC] so one parser covers
# Darwin's hundredths and Linux's whole seconds.
cputime_s() {
  ps -p "$1" -o time= 2>/dev/null | tr -d ' ' | awk -F: '
    { d=0; if ($1 ~ /-/) { split($1, a, "-"); d=a[1]; $1=a[2] }
      n=NF; s=$n; m=(n>=2)?$(n-1):0; h=(n>=3)?$(n-2):0
      printf "%.2f", d*86400 + h*3600 + m*60 + s }'
}

# bash 3.2 (macOS default) has no mapfile — keep this portable.
PIDS=$(ps -Ao pid,command | grep "$PAT" | awk '{print $1}')
if [ -z "$PIDS" ]; then
  echo "no OCP-spawned claude process running — nothing to classify"; exit 0
fi

for pid in $PIDS; do
  echo "── pid $pid  ($(ps -p "$pid" -o etime= | tr -d ' ') elapsed)"
  stats=""; cpus=""; t_first=""; t_last=""; samples=0
  for _ in $(seq 1 "$N"); do
    read -r st cpu <<<"$(ps -p "$pid" -o stat=,%cpu= 2>/dev/null)"
    [ -z "${st:-}" ] && { echo "    exited mid-sample"; break; }
    ct=$(cputime_s "$pid")
    printf '    STAT=%-5s %%CPU=%-6s cpu_time=%ss\n' "$st" "$cpu" "${ct:-?}"
    stats="$stats$st "; cpus="$cpus$cpu
"
    [ -z "$t_first" ] && t_first="$ct"
    t_last="$ct"; samples=$((samples + 1))
    sleep "$IV"
  done
  # ── verdict ────────────────────────────────────────────────────────────────────
  # Ordered so every verdict rests on POSITIVE evidence rather than on the absence
  # of something. That ordering is the whole correction: the previous version's
  # WORKING branch fired on "%CPU varied", and a decaying average varies while the
  # process does nothing at all.
  #
  #   rate >= MIN_RATE_PCT -> the process is consuming CPU. That is ALL it establishes:
  #        WORKING-OR-WEDGED UNRESOLVED. There is deliberately NO 'confident WORKING' band --
  #        see the branch below for the measurement that removed it.
  #   below the floor + uninterruptible seen -> blocked in the kernel, not computing. WEDGED.
  #        The one verdict here that rests on POSITIVE evidence of the failure.
  #   below the floor, no uninterruptible    -> INCONCLUSIVE. A turn waiting on the upstream
  #        and one blocked on a socket forever are the SAME observation here.
  if [ "$samples" -eq 0 ]; then
    echo "    ⇒ inconclusive — no sample was taken"
    continue
  fi
  lo=$(printf '%s' "$cpus" | grep -v '^$' | sort -n  | head -1)
  hi=$(printf '%s' "$cpus" | grep -v '^$' | sort -rn | head -1)
  delta=$(awk -v a="${t_first:-0}" -v b="${t_last:-0}" 'BEGIN{ printf "%.2f", b - a }')
  # Wall seconds actually spanned: one interval fewer than the sample count, because
  # the sleep follows each sample. Guard the zero case so the division cannot blow up
  # on a run that broke out early.
  window=$(awk -v n="$samples" -v iv="$IV" 'BEGIN{ w=(n-1)*iv; print (w > 0) ? w : 0 }')
  rate=$(awk -v d="$delta" -v w="$window" 'BEGIN{ printf "%.2f", (w > 0) ? (d / w) * 100 : 0 }')
  # THE RATE, not "did it move". See the header for the 7-of-14 measurement that
  # forced this: a wedged Node process accumulates ~0.01 s per ~30 s from timers and
  # GC alone, which a boolean reads as work. Named for what it holds -- it was called
  # `grew` through two revisions after it stopped meaning "grew", which is this repo's
  # own "a name is a claim" rule catching the one identifier whose meaning changed.
  # THE EFFECTIVE FLOOR, not the requested one. `ps -o time=` is QUANTISED, so the
  # smallest non-zero rate this platform can even represent over this window is
  # one quantum / window. On Linux that is 1s/20s = 5% at the default settings --
  # FIFTEEN TIMES the requested 0.3, so no value between 0 and 5 exists and the
  # constant can never be what decides. The predicate would silently degenerate to
  # "did the counter move", which is the boolean an earlier round removed, on the
  # platform this file itself calls the one OCP is normally deployed on.
  #
  # [measured] fed Linux-shaped HH:MM:SS values, delta 0s -> 0.00% -> inconclusive and
  # delta 1s -> 5.00% -> unresolved, with nothing representable in between. On Darwin
  # the quantum is 0.05% of the window, so 0.3 sits six quanta above resolution and is
  # a real floor there: 0.05s -> inconclusive, 0.06s -> unresolved, both measured.
  #
  # So the floor is DERIVED and reported, rather than asserted as a constant. An earlier
  # comment called 0.3 "the instrument's resolution floor" -- a Darwin property written
  # as an instrument property.
  quantum_pct=$(awk -v q="$TIME_QUANTUM" -v w="$window" 'BEGIN{ printf "%.2f", (w > 0) ? (q / w) * 100 : 0 }')
  floor=$(awk -v m="$MIN_RATE_PCT" -v q="$quantum_pct" 'BEGIN{ print (q > m) ? q : m }')
  above_floor=$(awk -v r="$rate" -v f="$floor" 'BEGIN{ print (r >= f) ? 1 : 0 }')

  if [ "$samples" -lt 2 ]; then
    # One sample cannot show growth, so it cannot answer this question at all. Said
    # rather than defaulted: `samples` is the first positional argument, so
    # `./wedged-or-working.sh 1` is one keystroke away, and the previous version
    # answered it with a confident verdict derived from lo == hi.
    echo "    ⇒ inconclusive — only 1 sample; CPU-time growth needs at least 2."
    echo "      Re-run with N >= 2 (default 6)."
  elif [ "$above_floor" = "1" ]; then
    # NO CONFIDENT BAND, DELIBERATELY. There is no rate above which this instrument can say
    # WORKING, because the WEDGED population has no ceiling: its rate is whatever timers that
    # process happens to run, and a process spinning in a retry loop makes no progress at 99%.
    #
    # An earlier revision had a confident band at 2%, calibrated against the measured top of the
    # WORKING population -- the wrong population, since the error it must prevent is a WEDGED
    # process EXCEEDING it. [measured] a wedged fixture at a 20 ms/s duty cycle reaches 2.00% and
    # got a confident WORKING, while a genuinely working 200 tok/s stream at 1.85% got the caveat:
    # the wedged side outranked the working side. Same inversion the earlier 3x band had at 0.9%,
    # moved up. And the 0.90% "highest wedged rate" it was justified against was an artifact of
    # where the sweep STOPPED, not a property of the population.
    #
    # The README already said this for the LOWER boundary -- "nothing bounds the wedged side below
    # the working side ... this instrument cannot order them, at any threshold". It is equally true
    # at the top, and the confident band was the one place these files stopped applying their own
    # sentence.
    echo "    ⇒ CONSUMING CPU, WORKING-OR-WEDGED UNRESOLVED — ${delta}s over ${window}s = ${rate}%"
    echo "      of wall time (effective floor ${floor}%, = max of MIN_RATE_PCT and one ${TIME_QUANTUM}s"
    echo "      quantum over the window). DECIDE ON WHETHER THE CLIENT HAS RECEIVED BYTES, not on this."
    # A rate of exactly one quantum is the COARSEST reading this instrument can produce -- on Linux
    # at the default window that is 5.00%, and nothing else on the line distinguishes it from a
    # precise 5%. Said here rather than left for the operator to infer from the quantum.
    if awk -v d="$delta" -v q="$TIME_QUANTUM" 'BEGIN{exit !(d <= q * 1.0001)}'; then
      # THE INTERVAL IS (0, 2*rate), NOT (0, rate]. `ps` TRUNCATES, so a reported one-quantum
      # increment means the true readings were t0 in [C0, C0+q) and t1 in [C0+q, C0+2q) -- the true
      # delta is therefore in (0, 2q), open at both ends. An earlier version of this line wrote
      # (0, rate], which is the intuitive thing to write and understates the ceiling by 2x, IN THE
      # UNSAFE DIRECTION: it tells the operator the process may be using at most `rate` when it may
      # be using nearly twice that. The conclusion holds whether ps truncates or rounds.
      hi_rate=$(awk -v r="$rate" 'BEGIN{ printf "%.2f", r * 2 }')
      echo "      ⚠ AT THE RESOLUTION LIMIT: ${delta}s is one quantum, the smallest increment this"
      echo "        platform can report. The true rate is somewhere in (0, ${hi_rate}%) -- up to TWICE"
      echo "        the figure above, because ps truncates at both ends of the window. This"
      echo "        instrument cannot narrow it; lengthen the window to refine."
    fi
    echo "      Consuming CPU is not progress. Measured: wedged clients running ordinary timers span"
    echo "      0.05-5.00%, genuinely working streams 0.55-2.25% -- overlapping, and the wedged side"
    echo "      is unbounded above. There is no rate at which this instrument can say WORKING."
    echo "      Sampled %CPU ${lo}–${hi} is context and is NOT what any of this rests on."
  elif printf '%s' "$stats" | grep -q "$UNINT"; then
    echo "    ⇒ WEDGED — uninterruptible wait (STAT contains '${UNINT}'), and CPU consumed at only"
    echo "      ${rate}% of wall time (${delta}s over ${window}s, below the ${floor}% effective floor)."
    echo "      Blocked in the kernel, not computing."
  else
    echo "    ⇒ inconclusive — no uninterruptible wait, and CPU consumed at only ${rate}% of wall"
    echo "      time (${delta}s over ${window}s, below the ${floor}% effective floor; %CPU ${lo}–${hi})."
    echo "      A turn waiting on the upstream looks exactly like this. So does one blocked forever."
    echo "      Sample again over a longer window, or check whether the client ever received bytes."
  fi
done
