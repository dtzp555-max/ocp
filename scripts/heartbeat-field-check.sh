#!/bin/bash
# One-shot field-evidence gatherer for OCP v3.12.0 SSE heartbeat.
# Scheduled by ~/Library/LaunchAgents/dev.ocp.heartbeat-check.plist to fire
# once at 2026-05-02 09:00 Australia/Brisbane. Gathers evidence from local
# OCP logs + GitHub issue #47 + repo issue search, posts a summary comment
# on #47, and exits. Does NOT open PRs or change code — the maintainer
# decides after reading the summary.
#
# Dry-run: ./heartbeat-field-check.sh --dry-run   (prints summary, skips post)

set -euo pipefail

REPO="dtzp555-max/ocp"
SHIP_DATE="2026-04-25"
# Baseline captured at script-install time so internal testing entries from
# Phase 3 verification (~5 entries from 2026-04-25T00:00–00:48Z) don't get
# counted as field evidence. Any heartbeat_active log entry with ts >= this
# timestamp is treated as a real opt-in.
BASELINE_TS="2026-04-25T01:00:00Z"
PROXY_LOG="$HOME/ocp/logs/proxy.log"
OUT_DIR="$HOME/ocp/logs"
SELF_LOG="$OUT_DIR/heartbeat-field-check-$(date +%Y-%m-%d).log"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

mkdir -p "$OUT_DIR"

exec > >(tee -a "$SELF_LOG") 2>&1

echo "=== heartbeat field-evidence check: $(date -u +%Y-%m-%dT%H:%M:%SZ) (dry_run=$DRY_RUN) ==="

# ── signal 1: local proxy log ─────────────────────────────────────────────
if [ -r "$PROXY_LOG" ]; then
  # Only count entries with ts >= BASELINE_TS (string sort works on RFC3339)
  HEARTBEAT_COUNT=$(grep '"event":"heartbeat_active"' "$PROXY_LOG" 2>/dev/null \
    | awk -v base="$BASELINE_TS" '
        match($0, /"ts":"[^"]+"/) {
          ts = substr($0, RSTART+6, RLENGTH-7);
          if (ts >= base) c++
        }
        END { print c+0 }')
else
  HEARTBEAT_COUNT=0
fi
echo "signal 1 — heartbeat_active log entries since $BASELINE_TS: $HEARTBEAT_COUNT"

# ── signal 2: comments on #47 since ship ──────────────────────────────────
NEW_47_JSON="/tmp/ocp-47-new-comments-$$.json"
gh issue view 47 --repo "$REPO" --json comments \
  --jq '[.comments[] | select(.createdAt >= "'"$SHIP_DATE"'T00:00:00Z")]' \
  > "$NEW_47_JSON" 2>/dev/null || echo "[]" > "$NEW_47_JSON"
NEW_COMMENTS=$(jq 'length' "$NEW_47_JSON")
echo "signal 2 — new comments on #47 since $SHIP_DATE: $NEW_COMMENTS"

# Build a compact, human-readable excerpt for the summary body
NEW_47_EXCERPT=""
if [ "$NEW_COMMENTS" -gt 0 ]; then
  NEW_47_EXCERPT=$(jq -r '.[] | "- **@\(.author.login)** (\(.createdAt)): " + (.body | gsub("\r"; "") | split("\n")[0])[:180]' "$NEW_47_JSON")
fi

# ── signal 3: other heartbeat-related issues since ship ──────────────────
OTHER_ISSUES_JSON="/tmp/ocp-heartbeat-issues-$$.json"
gh search issues "repo:$REPO heartbeat" --json number,title,state,createdAt --limit 30 \
  --jq '[.[] | select(.createdAt >= "'"$SHIP_DATE"'T00:00:00Z" and .number != 47 and .number != 48)]' \
  > "$OTHER_ISSUES_JSON" 2>/dev/null || echo "[]" > "$OTHER_ISSUES_JSON"
OTHER_ISSUES=$(jq 'length' "$OTHER_ISSUES_JSON")
echo "signal 3 — other heartbeat-related issues since ship: $OTHER_ISSUES"

OTHER_ISSUES_EXCERPT=""
if [ "$OTHER_ISSUES" -gt 0 ]; then
  OTHER_ISSUES_EXCERPT=$(jq -r '.[] | "- #\(.number) [\(.state)] \(.title)"' "$OTHER_ISSUES_JSON")
fi

# ── compose summary ──────────────────────────────────────────────────────
BODY_FILE="/tmp/ocp-47-summary-$$.md"
{
  echo "### Automated 7-day field-evidence check (v3.12.0)"
  echo
  echo "_Triggered by a local launchd scheduled task on the maintainer's rig at $(date -u +%Y-%m-%dT%H:%M:%SZ)._"
  echo
  echo "| Signal | Count |"
  echo "|---|---|"
  echo "| \`heartbeat_active\` log entries on prod rig (since baseline $BASELINE_TS) | $HEARTBEAT_COUNT |"
  echo "| New comments on #47 since $SHIP_DATE | $NEW_COMMENTS |"
  echo "| Other heartbeat-related issues filed since $SHIP_DATE | $OTHER_ISSUES |"
  echo
  if [ -n "$NEW_47_EXCERPT" ]; then
    echo "**New #47 comments (first line each):**"
    echo
    echo "$NEW_47_EXCERPT"
    echo
  fi
  if [ -n "$OTHER_ISSUES_EXCERPT" ]; then
    echo "**Other heartbeat-related issues:**"
    echo
    echo "$OTHER_ISSUES_EXCERPT"
    echo
  fi
  echo "**Decision guidance for maintainer (manual):**"
  echo
  echo "- If any of the above indicate a **crash report** on \`: keepalive\` comment frames → leave default at \`0\` and file a \`CLAUDE_HEARTBEAT_FORMAT=empty-delta\` follow-up issue (spec \`§D2\` fallback plan)."
  echo "- If there is at least one **opt-in confirmation** (a user reports \`CLAUDE_HEARTBEAT_INTERVAL\` fixed their timeout issue) and no crash reports → consider opening a PR for v3.13.0 flipping the default to \`30000\`, following the same ALIGNMENT + independent-reviewer + release-kit discipline as PR #49."
  echo "- If all three signals are zero → extend the soak window or close this follow-up as \"no field evidence.\""
  echo
  echo "This bot does not open PRs or change code. The maintainer reviews and acts."
} > "$BODY_FILE"

echo "--- summary preview ---"
cat "$BODY_FILE"
echo "--- end preview ---"

# ── post (unless dry-run) ────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN — skipping gh issue comment"
else
  gh issue comment 47 --repo "$REPO" --body-file "$BODY_FILE" && echo "comment posted on #47"
fi

# ── cleanup + self-disable so the plist doesn't linger loaded forever ────
rm -f "$NEW_47_JSON" "$OTHER_ISSUES_JSON" "$BODY_FILE"

if [ "$DRY_RUN" -eq 0 ]; then
  # Unload + remove the plist so this never fires again
  PLIST="$HOME/Library/LaunchAgents/dev.ocp.heartbeat-check.plist"
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "self-disabled: removed $PLIST"
  fi
fi

echo "=== done ==="
