#!/usr/bin/env bash
# UserPromptSubmit hook: inject result.json output contract for all OCP TUI requests.
# OCP_JSON_MODE=1: write structured JSON (schema from schema.json if present)
# OCP_JSON_MODE=0: write plain text wrapped as {"content":"..."}
set -euo pipefail

# Only inject for OCP TUI sessions (OCP_RESULT_DIR must be set)
[ -n "${OCP_RESULT_DIR:-}" ] || exit 0

INPUT=$(cat)
RESULT_FILE="${OCP_RESULT_DIR}/result.json"
SCHEMA_FILE="${OCP_RESULT_DIR}/schema.json"

if [ "${OCP_JSON_MODE:-0}" = "1" ]; then
  SCHEMA_CLAUSE=""
  if [ -f "$SCHEMA_FILE" ]; then
    SCHEMA_CLAUSE="\nThe JSON MUST conform to this JSON Schema: $(cat $SCHEMA_FILE)"
  fi

  printf '\n---\n[JSON OUTPUT CONTRACT - enforced by Stop Hook]\nWrite the structured JSON value to: %s%b\nDo NOT print the JSON payload in chat.\nAfter writing validate with: jq -e . %s\nYour ONLY chat response must be exactly:\n{"status":"success","result_file":"%s"}\n[END CONTRACT]\n---\n'     "$RESULT_FILE" "$SCHEMA_CLAUSE" "$RESULT_FILE" "$RESULT_FILE"
else
  printf '\n---\n[RESPONSE CAPTURE CONTRACT - enforced by Stop Hook]\nWrite your complete response as JSON to: %s\nFormat: {"content": "your full response here"}\nEscape special characters properly so the file is valid JSON.\nDo NOT print the response in chat.\nYour ONLY chat response must be exactly:\n{"status":"success","result_file":"%s"}\n[END CONTRACT]\n---\n'     "$RESULT_FILE" "$RESULT_FILE"
fi
