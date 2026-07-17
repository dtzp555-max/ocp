# 2026-06-15 Canary Runbook

**Purpose:** Confirm that a TUI-mode turn is billed to the **Pro/Max subscription pool** (not the Agent SDK credit pool) after Anthropic's 2026-06-15 billing split activates.

The billing classifier reading `cli` is **necessary but NOT sufficient** proof. (Note the naming: the value is stored in the JSONL transcript under the field name `entrypoint`, and sent to Anthropic on the wire as the `cc_entrypoint` header — they carry the same value after claude's startup classification. The commands below grep the transcript, so they match `entrypoint`.) A `cli` label tells you OCP sent the right classification; it does not tell you Anthropic billed the right pool. The only authoritative test is to observe whether the **Agent SDK credit balance** moves or not before and after the canary turn.

---

## Prerequisites

- `CLAUDE_TUI_MODE=true` already set and OCP restarted (see [TUI-mode setup](../tui-mode.md#enabling-tui-mode-opt-in))
- `tmux` installed on the host
- No other OCP traffic during the canary (quiesce — see below)
- Access to your Anthropic account billing page (manual step — see below)

---

## Step 1 — Quiesce the host

Stop any IDE or client that is actively sending requests through this OCP instance.

Confirm the proxy is idle:

```bash
curl -s http://127.0.0.1:3456/health | python3 -m json.tool | grep activeRequests
# Expected: "activeRequests": 0
```

Wait until `activeRequests` is `0` before proceeding. If you cannot quiesce (e.g. family members are actively using it), run the canary on a separate OCP instance or during a quiet window.

---

## Step 2 — Read the Agent SDK credit balance BEFORE the canary

> **Manual step — no programmatic API available.**
>
> OCP's `/usage` endpoint reads `anthropic-ratelimit-unified-*` response headers from the Pro/Max plan quota (5-hour and 7-day subscription windows). These headers report **subscription usage**, not the Agent SDK credit pool balance. There is no known programmatic API to query the Agent SDK credit pool balance from outside the Anthropic web app.

To read the balance:

1. Open [https://claude.ai/settings/billing](https://claude.ai/settings/billing) (or your Anthropic Console billing page) in a browser.
2. Find the **Agent SDK Credits** section (sometimes labeled "API Credits" or "Agent SDK usage").
3. Note the current balance (e.g. `$18.43 remaining of $20.00`).

Write the value down — you will compare it after the canary turn.

---

## Step 3 — Send the canary turn

With TUI-mode on and the host quiesced, send exactly one small request:

```bash
curl -s -X POST http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "messages": [{"role": "user", "content": "Reply with the single word: pong"}],
    "max_tokens": 10
  }' | python3 -m json.tool
```

Use Haiku (the cheapest model) to minimize any hypothetical impact if the canary turns red.

Wait for the response to arrive completely (TUI-mode buffers the full response before returning — you will see a delay of several seconds, then the full reply).

---

## Step 4 — Confirm the transcript shows `entrypoint:"cli"`

After the canary turn completes, inspect the most recent JSONL transcript for the billing-classifier label:

```bash
# The canary was run quiesced (Step 1), so the most recent JSONL across ALL project
# dirs IS the canary turn. We glob every projects subdir instead of recomputing
# claude's cwd-encoding rule (it maps every "/" AND "." to "-", e.g. ~/.ocp-tui/work
# => projects/-home-<user>--ocp-tui-work/; see lib/tui/transcript.mjs encodeCwd) —
# a glob is robust even if that encoding changes in a future claude build.
LATEST=$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
echo "Transcript: $LATEST"
grep -o '"entrypoint":"[^"]*"' "$LATEST" | tail -1
# Expected: "entrypoint":"cli"
```

If the output shows `"entrypoint":"cli"`, the billing-classifier label is correct. If it shows `"entrypoint":"sdk-cli"`, the spawn did not get a real PTY — stop immediately and do not re-enable TUI-mode without investigation. Check `tmux new-session` manually and review ADR 0007 § spawn/PTY gate. (If the grep returns nothing, the transcript may not yet be flushed — re-run after a second, or confirm the turn completed.)

**Reminder: an `entrypoint:cli` label (the `cc_entrypoint=cli` wire header) is necessary but not sufficient.** It tells you OCP sent the right label to Anthropic. You must still check the credit balance in Step 5.

---

## Step 5 — Re-read the Agent SDK credit balance AFTER the canary

Return to [https://claude.ai/settings/billing](https://claude.ai/settings/billing) and reload the page. Note the current balance again.

---

## Step 6 — Green/Red decision

### Green (balance unchanged)

The Agent SDK credit balance did not decrease. The turn billed against the Pro/Max subscription pool as expected. TUI-mode is working correctly.

**Actions:**
- Keep `CLAUDE_TUI_MODE=true` on this host.
- Monitor the balance periodically for the first week to catch any delayed attribution.
- Resume normal traffic.

### Red (Agent SDK credit balance decreased)

The Agent SDK credit balance decreased. The subscription pool is not being used for TUI-mode turns on this host, despite `cc_entrypoint=cli` being set. This may indicate a backend routing change on Anthropic's side, a TTY detection failure, or a policy change.

**Actions — immediate:**
1. Unset `CLAUDE_TUI_MODE` (or set to any value other than `"true"`) in the service unit:
   - systemd: edit `/etc/ocp/ocp.env` (or the unit's `Environment=` line), then `sudo systemctl daemon-reload && sudo systemctl restart ocp.service`
   - launchd: edit the plist `EnvironmentVariables` section, then `launchctl bootout gui/$(id -u)/dev.ocp.proxy && launchctl bootstrap gui/$(id -u) <plist-path>`
2. Restart OCP and confirm the `/health` response no longer shows TUI-mode active.
3. If you share this OCP with family or other Max users: freeze their access temporarily until you understand the billing impact.
4. Consider pivoting to OLP multi-provider (see [OLP](https://github.com/dtzp555-max/olp)) which can spread load across other providers to avoid the Agent SDK credit drain.

Per ALIGNMENT.md Rule 2 / ADR 0007 § Kill-switch: "Per the constitution, the response is to drop the Anthropic provider rather than escalate spoofing."

---

## Ongoing monitoring — self-classification mini-canary

To detect future drift (e.g. a claude CLI upgrade that changes TTY-detection behavior), you can run a periodic one-liner that sends a tiny TUI turn with `OCP_TUI_ENTRYPOINT=auto` (so claude self-classifies rather than having OCP pin the value) and alerts if the transcript self-classification is not `cli`:

```bash
# Run with OCP temporarily configured OCP_TUI_ENTRYPOINT=auto
# Then check the most recent transcript:
# Glob the most recent transcript across all project dirs (robust to claude's
# cwd-encoding rule; run this right after the auto-mode mini-canary turn).
LATEST=$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)
RESULT=$(grep -o '"entrypoint":"[^"]*"' "$LATEST" | tail -1)
echo "Self-classified entrypoint: $RESULT"
if echo "$RESULT" | grep -q '"entrypoint":"cli"'; then
  echo "OK — subscription pool"
else
  echo "ALERT — not cli; check TTY and billing"
fi
```

Run this after any major `claude` CLI upgrade. The `auto` mode lets the CLI's own `t$A` startup function determine the value from the actual TTY state (see ADR 0007 § Billing-classifier labeling).

---

## Related

- [Flip/rollback runbook](./tui-flip-rollback.md) — how to set and unset `CLAUDE_TUI_MODE` on systemd and launchd hosts
- [ADR 0007](../adr/0007-tui-interactive-mode.md) — TUI-mode architecture and governing rules
- [Subscription-pool (TUI) mode](../tui-mode.md#subscription-pool-tui-mode)
