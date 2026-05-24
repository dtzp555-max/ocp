#!/usr/bin/env bash
# Stop hook: block until result.json is valid JSON — for all OCP TUI sessions.
set -euo pipefail

# Only enforce for OCP TUI sessions (OCP_RESULT_DIR must be set)
[ -n "${OCP_RESULT_DIR:-}" ] || exit 0

RESULT="${OCP_RESULT_DIR}/result.json"

if [ ! -f "$RESULT" ]; then
  printf '{"decision":"block","reason":"Write response to %s first."}' "$RESULT"
  exit 0
fi

if ! jq -e . "$RESULT" >/dev/null 2>&1; then
  printf '{"decision":"block","reason":"%s is not valid JSON. Fix it."}' "$RESULT"
  exit 0
fi

exit 0
