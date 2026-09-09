#!/usr/bin/env bash
# Is a long-running OCP turn wedged, or is it genuinely working?
#
#   ./wedged-or-working.sh [samples] [interval_seconds]
#
# Criterion (macOS/BSD ps; Linux notes below):
#   WEDGED  = STAT contains U (uninterruptible wait) AND %CPU stays near zero
#   WORKING      = no uninterruptible wait, AND (%CPU varied across samples OR peak %CPU >= 2)
#   inconclusive = anything else -- notably a flat near-zero %CPU with no U, which is BOTH what
#                  a turn waiting on the upstream looks like AND what one blocked forever looks
#                  like. Saying "I don't know" is the honest answer there, not WORKING.
#
# Why a single sample is not enough: a working turn spends most of its wall
# clock waiting on the upstream API, so ONE sample of a healthy turn looks
# identical to a wedged one. The signal is in the variance across samples,
# which is why this takes several and prints them all rather than a verdict
# from one reading.
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
  grew=$(awk -v d="$delta" 'BEGIN{ print (d > 0) ? 1 : 0 }')

  if [ "$samples" -lt 2 ]; then
    # One sample cannot show growth, so it cannot answer this question at all. Said
    # rather than defaulted: `samples` is the first positional argument, so
    # `./wedged-or-working.sh 1` is one keystroke away, and the previous version
    # answered it with a confident verdict derived from lo == hi.
    echo "    ⇒ inconclusive — only 1 sample; CPU-time growth needs at least 2."
    echo "      Re-run with N >= 2 (default 6)."
  elif [ "$grew" = "1" ]; then
    echo "    ⇒ WORKING — consumed ${delta}s of CPU across ${samples} samples (%CPU ${lo}–${hi}, context only)"
  elif printf '%s' "$stats" | grep -q "$UNINT"; then
    echo "    ⇒ WEDGED — uninterruptible wait (STAT contains '${UNINT}') and 0s of CPU consumed"
    echo "      across ${samples} samples. Blocked in the kernel, not computing."
  else
    echo "    ⇒ inconclusive — no uninterruptible wait, and no measurable CPU consumed"
    echo "      (${delta}s across ${samples} samples; %CPU ${lo}–${hi})."
    echo "      A turn waiting on the upstream looks exactly like this. So does one blocked forever."
    echo "      Sample again over a longer window, or check whether the client ever received bytes."
    echo "      Note the floor: Linux 'ps -o time=' has 1-second resolution, so a process using less"
    echo "      than ~1s of CPU over the whole window lands here rather than in WORKING."
  fi
done
