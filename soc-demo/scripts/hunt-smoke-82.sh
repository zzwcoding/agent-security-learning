#!/usr/bin/env bash
# 票 82 冒烟：狩猎页的 curl 等价脚本——零特权原则（决策 #6 渠道平权）的机器核对。
#
# 狩猎页（票 71 页面映射节六行）每屏调用的公开面，curl 一一可演：
#   假设列表（五态）      → GET  /api/v1/hypotheses[?status=]        （m2，票 73）
#   发起假设              → POST /api/v1/hypotheses                  （m2；outbox 拉起 hunt_flow）
#   轮次视图/judge/gap    → GET  /api/v1/hypotheses/:id（轮次归集段）+ GET /api/v1/audit?objectId=
#                          （run 行+审计重建：hunt_round_outcome 条目带 details.run_id 父 run 锚）
#   收敛结论 Case 链接    → GET  /api/v1/cases（cases.hypothesisId 反查，既有面）
#   实时推进              → GET  /api/v1/events/stream?run_id=（m3 SSE，流水线页同款补发语义）
#   取消假设              → POST /api/v1/hypotheses/:id/cancel       （仅发起人 + 仅 hunting）
# 全部走 Web 同源（vite :5173 代理）可达的公开面——页面能演的 curl 都能演，反之亦然。
# 无 Web 专属接口：本脚本即边界闸之外的走线证据（/api/v1/hypotheses 代理到 m2）。
#
# 用法：bash scripts/hunt-smoke-82.sh
# 前置布景（本机最小栈，AGENT_LLM=fake 保证确定性收敛）：
#   1. case-backend :3002（M2_URL）
#   2. agent :3003（AGENT_URL；EVENT_DRIVEN 默认 on 消费 hypothesis.created；AGENT_LLM=fake）
#   3. vite dev :5173（services/web，代理分叉见 vite.config.ts）
set -euo pipefail
cd "$(dirname "$0")/.."

WEB="${WEB:-http://127.0.0.1:5173}"
export LC_ALL=en_US.UTF-8 # 系统自带 bash 3.2 的多字节解析对 locale 敏感，显式声明
ACTOR="soc1@soc.local"

say()  { echo "== $*"; }
need() { printf '%s' "$1" | grep -q "$2" || { echo "FAIL: $3"; exit 1; }; }
json_field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

wait_up() {
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || true)
    [ "$code" = "200" ] && { echo "web up ($code)"; return 0; }
    sleep 1
  done
  echo "FAIL: web 60s 未就绪"; exit 1
}

# ── 1 · 发起假设（狩猎入口页表单的第一动作）──────────────────────────
say "1 发起假设：POST /api/v1/hypotheses（201 proposed + outbox hypothesis.created）"
wait_up
RESP=$(curl -s -X POST "$WEB/api/v1/hypotheses" -H 'content-type: application/json' \
  -H "x-actor-id: $ACTOR" \
  -d '{"text":"冒烟：dmz 主机存在 webshell 驻留","template_id":"hunt_webshell"}')
need "$RESP" '"hypothesis_id"' "1：POST /hypotheses 响应缺 hypothesis_id"
HYP=$(printf '%s' "$RESP" | json_field 'd["hypothesis_id"]')
STATUS=$(printf '%s' "$RESP" | json_field 'd["status"]')
[ "$STATUS" = "proposed" ] || { echo "FAIL: 1：新假设状态=$STATUS（应 proposed）"; exit 1; }
echo "hypothesis_id=$HYP"

# ── 2 · 假设列表（五态 Tag 的数据面）────────────────────────────────
say "2 假设列表：GET /api/v1/hypotheses 与 ?status= 过滤"
LIST=$(curl -s "$WEB/api/v1/hypotheses")
need "$LIST" '"hypotheses"' "2：列表响应缺 hypotheses 键"
printf '%s' "$LIST" | grep -q "$HYP" || { echo "FAIL: 2：列表缺刚发起的 $HYP"; exit 1; }
FILTERED=$(curl -s "$WEB/api/v1/hypotheses?status=proposed")
printf '%s' "$FILTERED" | grep -q "$HYP" || { echo "FAIL: 2：?status=proposed 过滤缺 $HYP"; exit 1; }
echo "列表与状态过滤均含 $HYP — PASS 2"

# ── 3 · 轮次视图：编排循环拉起 run → 轮次归集段出现 ──────────────────
say "3 轮次视图：autorun 拉起 hunt_flow，详情内嵌轮次归集段（组合/子 run/judge/gap）"
FOUND=""
for _ in $(seq 1 60); do
  DETAIL=$(curl -s "$WEB/api/v1/hypotheses/$HYP")
  ST=$(printf '%s' "$DETAIL" | json_field 'd["status"]')
  NR=$(printf '%s' "$DETAIL" | json_field 'len(d.get("rounds") or [])')
  if [ "$NR" != "0" ] || [ "$ST" != "proposed" ]; then FOUND=1; break; fi
  sleep 2
done
[ -n "$FOUND" ] || { echo "FAIL: 3：120s 内轮次归集段未出现（hunt_flow 未拉起？检查 agent EVENT_DRIVEN）"; exit 1; }
need "$DETAIL" '"tasks"' "3：轮次归集段缺组合 tasks"
need "$DETAIL" '"children"' "3：轮次归集段缺子 run 簿记 children"
echo "rounds=$NR status=$ST — PASS 3"

# ── 4 · 断线刷新重建：审计按对象反查父 run 锚 + SSE 补发 ─────────────
say "4 run 行+审计重建：GET /api/v1/audit?objectId=<hyp> → 父 run 锚 → SSE 可回放"
AUDIT=$(curl -s "$WEB/api/v1/audit?objectId=$HYP")
need "$AUDIT" '"hunt_round_outcome"' "4：审计缺 hunt_round_outcome 条目（objectType=hypothesis）"
RUN=$(printf '%s' "$AUDIT" | python3 -c '
import json,sys
try:
    for a in json.load(sys.stdin):
        if a.get("objectType") == "hypothesis" and isinstance(a.get("details"), dict) and a["details"].get("run_id"):
            print(a["details"]["run_id"]); break
except Exception:
    pass
' || true)
[ -n "$RUN" ] || { echo "FAIL: 4：审计条目缺父 run 锚（details.run_id）"; exit 1; }
SSE=$(curl -s --max-time 15 "$WEB/api/v1/events/stream?run_id=$RUN")
need "$SSE" '"audit"' "4：父 run SSE 流缺 audit 帧（事件总线未落盘/未补发）"
echo "父 run=${RUN}，SSE 流回放正常 — PASS 4"

# ── 5 · 收敛结论 / 取消假设（状态机终态对账）─────────────────────────
say "5 终态对账：concluded（Case 挂 hypothesis_id）或 refuted/cancelled；hunting 窗口抢取消"
FIN=""
for _ in $(seq 1 90); do
  DETAIL=$(curl -s "$WEB/api/v1/hypotheses/$HYP")
  ST=$(printf '%s' "$DETAIL" | json_field 'd["status"]')
  case "$ST" in
    hunting)
      # 取消端点同权对账：409=状态机拒绝（非 hunting/非发起人），200=人取消成立
      CODE=$(curl -s -o /tmp/h82cancel.json -w '%{http_code}' -X POST "$WEB/api/v1/hypotheses/$HYP/cancel" \
        -H 'content-type: application/json' -H "x-actor-id: $ACTOR" \
        -d '{"by":"'"$ACTOR"'","reason":"user_cancelled"}')
      if [ "$CODE" = "200" ]; then
        echo "hunting 窗口内取消成立（$(cat /tmp/h82cancel.json | json_field 'd["status"]')）"
        FIN=cancelled; break
      fi
      ;;
    concluded|refuted|cancelled) FIN="$ST"; break ;;
  esac
  sleep 2
done
[ -n "$FIN" ] || { echo "FAIL: 5：180s 内假设未到终态（fake LLM 循环应秒级收敛）"; exit 1; }
if [ "$FIN" = "concluded" ]; then
  CASES=$(curl -s "$WEB/api/v1/cases")
  printf '%s' "$CASES" | grep -q "$HYP" || { echo "FAIL: 5：concluded 但案件面无挂 hypothesis_id 的 Case"; exit 1; }
  echo "命中建案已挂 hypothesis_id=$HYP — PASS 5（concluded）"
else
  echo "终态=${FIN}（状态机五态如实落账）— PASS 5"
fi

echo
echo "SMOKE PASS（票 82：狩猎页六行数据需求 curl 等价核对全通——零 Web 专属接口，渠道平权）"
