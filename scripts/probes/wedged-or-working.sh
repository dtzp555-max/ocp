#!/usr/bin/env bash
# Is a long-running OCP turn wedged, or is it genuinely working?
#
#   ./wedged_or_working.sh [samples] [interval_seconds]
#
# Criterion (macOS/BSD ps; Linux notes below):
#   WEDGED  = STAT contains U (uninterruptible wait) AND %CPU stays near zero
#   WORKING = STAT is S/R AND %CPU fluctuates across samples
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
PAT='[c]laude --model'          # bracket avoids matching this script's own argv

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
    echo "    ⇒ WORKING — no uninterruptible wait; %CPU ranged ${lo}–${hi}"
  fi
done
