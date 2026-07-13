#!/usr/bin/env bash
# OCP TUI-mode latency floor harness — see README.md in this directory.
# Measures TRUE first-token time of the subscription path by polling tmux capture-pane,
# bypassing OCP entirely (no :3456, no ocp-tui-* sessions).
#
# 目的：回答一个问题——如果把 OCP 现有的两个已知开销砍掉
#   (a) 每请求 spawn + boot（可用预热进程池消除）
#   (b) 假流式（等 turn_duration 才返回，可用增量读 pane 消除）
# 之后，订阅池路径的**真实 TTFT 地板**是多少？
#
# 判据：地板 ≤ 4s → OCP 作为"省钱选项"可行；> 8s → 死透，不再讨论。
#
# 红线：
# - 不经过生产 OCP 服务（:3456）—— 直接起 tmux+claude，OCP 进程零干扰
# - tmux session 前缀用 zhiyin-floor-（**不是** ocp-tui-），避免被 OCP 的
#   reaper 当成自己的会话杀掉，也避免我们杀到它的
# - 用 real HOME（凭据）—— scratch HOME + symlink 凭据会 fork OAuth 导致 401
#   （见跨机记忆 tui_scratch_home_credential_fork）
set -uo pipefail

N=${1:-5}
MODEL=${MODEL:-claude-sonnet-5}
EXTRA_ARGS=${EXTRA_ARGS:-}          # 额外 CLI 参数（如 --effort low --bare）
TAG=${TAG:-baseline}
OUT=${OUT:-$(dirname "$0")/measurements.jsonl}
PROMPT_FILE=$(mktemp)
PREFIX="zhiyin-floor"

mkdir -p "$(dirname "$OUT")"

# ── 构造提示：~2000 token 的假会议转写 + 明确的起始标记 ────────────────
# 单行（多行会在 tmux send-keys 时提前触发 Enter）
build_prompt() {
  local seg="Speaker A said the quarterly pipeline is tracking behind plan and the enterprise segment needs a different motion. Speaker B replied that the current onboarding flow loses roughly a third of trial accounts before the first integration is complete. They debated whether the fix belongs in product or in customer success. "
  local body=""
  for _ in $(seq 1 22); do body+="$seg"; done
  printf '%s' "You are a real-time meeting copilot. Meeting transcript so far: $body --- Task: produce ONE prompt card as compact JSON with keys: points (array of 3 short Chinese bullet points), keyline (one English sentence the user can read aloud). IMPORTANT: your reply MUST begin with three hash characters immediately followed by the uppercase word CARD (no space between them), then the JSON. No preamble, no markdown fences." > "$PROMPT_FILE"
}
build_prompt
PROMPT_CHARS=$(wc -c < "$PROMPT_FILE" | tr -d ' ')

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

echo "配置: $TAG   参数: [$EXTRA_ARGS]"
echo "模型: $MODEL   样本: $N   提示长度: ${PROMPT_CHARS} chars (≈$((PROMPT_CHARS/4)) token)"
echo "输出: $OUT"
echo

for i in $(seq 1 "$N"); do
  SESS="${PREFIX}-$$-$i"
  SID=$(uuidgen)

  # ── 冷启动：spawn + 等输入框就绪 ─────────────────────────────────
  T_SPAWN=$(now_ms)
  tmux new-session -d -s "$SESS" -x 200 -y 50 \
    -e CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 \
    -e CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
    -c "$HOME" \
    "claude --model $MODEL --session-id $SID --strict-mcp-config --disallowedTools 'mcp__*' $EXTRA_ARGS" 2>/dev/null
  if [ $? -ne 0 ]; then echo "[$i] tmux spawn 失败，跳过"; continue; fi

  # 轮询输入框就绪（claude TUI 的输入提示符）
  READY=0
  for _ in $(seq 1 150); do   # 上限 15s
    PANE=$(tmux capture-pane -p -t "$SESS" 2>/dev/null || true)
    if grep -qE '│ >|❯|Try "' <<<"$PANE"; then READY=1; break; fi
    sleep 0.1
  done
  T_READY=$(now_ms)
  BOOT_MS=$((T_READY - T_SPAWN))
  if [ "$READY" -ne 1 ]; then
    echo "[$i] 启动超时（${BOOT_MS}ms），pane 末 3 行:"
    tmux capture-pane -p -t "$SESS" 2>/dev/null | tail -3 | sed 's/^/      /'
    tmux kill-session -t "$SESS" 2>/dev/null
    continue
  fi

  # ── 热态：粘提示 → 回车 → 量首 token ─────────────────────────────
  tmux send-keys -t "$SESS" -l "$(cat "$PROMPT_FILE")" 2>/dev/null
  sleep 0.4                       # 让粘贴落地（OCP 用 400ms 轮询粒度）
  T0=$(now_ms)
  tmux send-keys -t "$SESS" Enter 2>/dev/null

  TTFT_MS=-1
  for _ in $(seq 1 600); do       # 上限 60s
    if tmux capture-pane -p -t "$SESS" 2>/dev/null | grep -q '###CARD'; then
      TTFT_MS=$(( $(now_ms) - T0 )); break
    fi
    sleep 0.1
  done

  # ── 完整回答：pane 连续 2s 不再变化 ──────────────────────────────
  COMPLETE_MS=-1
  if [ "$TTFT_MS" -ge 0 ]; then
    LAST=""; STABLE=0
    for _ in $(seq 1 900); do     # 上限 90s
      CUR=$(tmux capture-pane -p -t "$SESS" 2>/dev/null | cksum)
      if [ "$CUR" = "$LAST" ]; then
        STABLE=$((STABLE+1))
        [ "$STABLE" -ge 20 ] && { COMPLETE_MS=$(( $(now_ms) - T0 - 2000 )); break; }
      else
        STABLE=0; LAST="$CUR"
      fi
      sleep 0.1
    done
  fi

  printf '{"i":%d,"tag":"%s","model":"%s","extra_args":"%s","prompt_chars":%s,"boot_ms":%d,"ttft_ms":%d,"complete_ms":%d}\n' \
    "$i" "$TAG" "$MODEL" "$EXTRA_ARGS" "$PROMPT_CHARS" "$BOOT_MS" "$TTFT_MS" "$COMPLETE_MS" | tee -a "$OUT"

  tmux kill-session -t "$SESS" 2>/dev/null
  sleep 1
done

rm -f "$PROMPT_FILE"
echo
echo "=== 汇总 ==="
python3 - "$OUT" <<'EOF'
import json,sys,statistics
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok=[r for r in rows if r['ttft_ms']>=0]
if not ok: print("无有效样本"); sys.exit()
def s(k):
    v=[r[k] for r in ok if r[k]>=0]
    return f"n={len(v)} 中位={statistics.median(v)/1000:.2f}s 最小={min(v)/1000:.2f}s 最大={max(v)/1000:.2f}s" if v else "无"
print(f"  冷启动 boot      : {s('boot_ms')}   ← 预热进程池可完全消除")
print(f"  TTFT（首 token） : {s('ttft_ms')}   ★ 这就是地板")
print(f"  完整回答         : {s('complete_ms')}")
print(f"\n  失败样本: {len(rows)-len(ok)}/{len(rows)}")
EOF
