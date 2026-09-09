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
# Linux: STAT 'D' is the equivalent of BSD 'U'. Swap the pattern below.
# The %CPU column on Linux ps is an average since process start, not an
# instantaneous sample — use `top -b -n1 -p <pid>` there instead.

set -uo pipefail
N=${1:-6}; IV=${2:-4}
PAT='[c]laude --model'          # the bracket stops the GREP process matching itself in ps output (not this script's argv)

# bash 3.2 (macOS default) has no mapfile — keep this portable.
PIDS=$(ps -Ao pid,command | grep "$PAT" | awk '{print $1}')
if [ -z "$PIDS" ]; then
  echo "no OCP-spawned claude process running — nothing to classify"; exit 0
fi

for pid in $PIDS; do
  echo "── pid $pid  ($(ps -p "$pid" -o etime= | tr -d ' ') elapsed)"
  stats=""; cpus=""
  for _ in $(seq 1 "$N"); do
    read -r st cpu <<<"$(ps -p "$pid" -o stat=,%cpu= 2>/dev/null)"
    [ -z "${st:-}" ] && { echo "    exited mid-sample"; break; }
    printf '    STAT=%-5s %%CPU=%s\n' "$st" "$cpu"
    stats="$stats$st "; cpus="$cpus$cpu
"
    sleep "$IV"
  done
  # verdict
  if printf '%s' "$stats" | grep -q 'U'; then
    hi=$(printf '%s' "$cpus" | grep -v '^$' | sort -rn | head -1)
    if awk -v h="${hi:-0}" 'BEGIN{exit !(h < 2.0)}'; then
      echo "    ⇒ WEDGED — uninterruptible wait, peak %CPU ${hi} over ${N} samples"
    else
      echo "    ⇒ inconclusive — U seen but CPU peaked at ${hi}; sample again"
    fi
  else
    lo=$(printf '%s' "$cpus" | grep -v '^$' | sort -n  | head -1)
    hi=$(printf '%s' "$cpus" | grep -v '^$' | sort -rn | head -1)
    # The %CPU conjunct is TESTED here, not merely printed. An earlier version computed lo/hi and
    # interpolated them into a WORKING message without ever comparing them, so the only
    # discriminator was whether the letter U appeared -- while this file's own header, the README
    # and docs/troubleshooting.md all stated the rule as "STAT S/R AND %CPU fluctuates".
    #
    # The gap pointed the WRONG WAY: a process blocked forever on a socket or a pipe sits in an
    # INTERRUPTIBLE wait at ~0% CPU -- the shape this header itself calls normal ("a working turn
    # spends most of its wall clock waiting on the upstream API"). So the most common way a
    # network client wedges was reported WORKING. [measured] a process blocked on a fifo read that
    # nothing will ever write: STAT=SN, %CPU 0.0-0.2, verdict "WORKING".
    # WORKING needs EITHER variance OR meaningful CPU, not variance alone. A strict `hi > lo`
    # alone has a false downgrade in the other direction, and `samples` is this script's first
    # positional argument so it is one keystroke away: [measured] `./wedged-or-working.sh 1`
    # against a process pegged at 83.2% reported "inconclusive — %CPU never moved", because with
    # one sample lo == hi. A process steady at high CPU has the same problem at any N.
    #
    # The 2.0 threshold is deliberately the SAME ONE the WEDGED branch uses above, so the two
    # verdicts are symmetric about one number rather than disagreeing via two unrelated ones.
    if awk -v l="${lo:-0}" -v h="${hi:-0}" 'BEGIN{exit !(h > l || h >= 2.0)}'; then
      echo "    ⇒ WORKING — no uninterruptible wait; %CPU ${lo}–${hi}"
    else
      echo "    ⇒ inconclusive — no uninterruptible wait, but %CPU never moved (${hi} across ${N} samples)."
      echo "      A turn waiting on the upstream looks like this. So does one blocked forever."
      echo "      Sample again over a longer window, or check whether the client ever received bytes."
    fi
  fi
done
