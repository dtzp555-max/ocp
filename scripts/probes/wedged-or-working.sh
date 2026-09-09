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
# MIN_RATE_PCT is 2, deliberately the same number the pre-rate versions of this
# script used as their %CPU threshold, so there is one constant rather than two
# that can disagree. It separates the measured cases by ~500x: a busy loop ran at
# 27 % of wall time, the wedged Node fixture at 0.05 %. EXPIRY: if a genuinely
# working turn is ever observed below 2 %, this number is wrong -- re-measure it,
# do not nudge it, and note that lowering it walks back toward the boolean.
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
# ACCUMULATED CPU TIME (`ps -o time=`) has neither problem: it is MONOTONIC, so
# growth across the window is positive evidence that the process ran, and no
# growth is positive evidence that it did not. That is the discriminator now.
# %CPU is still printed, as context for a human, and is no longer tested.
#
# WHAT THIS STILL CANNOT SEE: a process using less CPU than the `time` column's
# resolution over the whole window. Darwin reports hundredths (measured:
# `0:00.50` -> `0:02.50` across 2 s of busy-work); Linux reports whole seconds,
# so at the default 6x4 s window a process must accumulate >= 1 s of CPU to
# register. Below that it is reported inconclusive, never WORKING.

set -uo pipefail
N=${1:-6}; IV=${2:-4}
MIN_RATE_PCT=${MIN_RATE_PCT:-2}   # see header: one constant, measured separation ~500x
PAT='[c]laude --model'          # the bracket stops the GREP process matching itself in ps output (not this script's argv)

# Uninterruptible-sleep STAT character, chosen rather than assumed. Refuses on an
# unknown platform: a wrong letter here does not error, it silently makes the
# WEDGED verdict unreachable, which is the failure this replaces.
case "$(uname -s)" in
  Darwin|*BSD*) UNINT='U' ;;
  Linux)        UNINT='D' ;;
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
  #   grew   -> the process consumed CPU during the window. It ran. WORKING.
  #   !grew + uninterruptible seen -> blocked in the kernel and not computing. WEDGED.
  #   !grew + no uninterruptible   -> INCONCLUSIVE. This is the honest answer, not a
  #        weaker WORKING: a turn waiting on the upstream API and a turn blocked on a
  #        socket forever are the SAME observation here, and the header says so.
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
  # GC alone, which a boolean reads as work.
  grew=$(awk -v r="$rate" -v m="$MIN_RATE_PCT" 'BEGIN{ print (r >= m) ? 1 : 0 }')

  if [ "$samples" -lt 2 ]; then
    # One sample cannot show growth, so it cannot answer this question at all. Said
    # rather than defaulted: `samples` is the first positional argument, so
    # `./wedged-or-working.sh 1` is one keystroke away, and the previous version
    # answered it with a confident verdict derived from lo == hi.
    echo "    ⇒ inconclusive — only 1 sample; CPU-time growth needs at least 2."
    echo "      Re-run with N >= 2 (default 6)."
  elif [ "$grew" = "1" ]; then
    echo "    ⇒ WORKING — consumed ${delta}s of CPU over ${window}s = ${rate}% of wall time (>= ${MIN_RATE_PCT}%)."
    echo "      Sampled %CPU ${lo}–${hi} is printed as context and is NOT what this verdict rests on."
  elif printf '%s' "$stats" | grep -q "$UNINT"; then
    echo "    ⇒ WEDGED — uninterruptible wait (STAT contains '${UNINT}'), and CPU consumed at only"
    echo "      ${rate}% of wall time (${delta}s over ${window}s). Blocked in the kernel, not computing."
  else
    echo "    ⇒ inconclusive — no uninterruptible wait, and CPU consumed at only ${rate}% of wall"
    echo "      time (${delta}s over ${window}s, below the ${MIN_RATE_PCT}% floor; %CPU ${lo}–${hi})."
    echo "      A turn waiting on the upstream looks exactly like this. So does one blocked forever."
    echo "      Sample again over a longer window, or check whether the client ever received bytes."
  fi
done
