#!/usr/bin/env bash
# 票 41 冒烟（真容器）：agent 数据卷（B5·对账一-4 清偿）——审批 interrupt 挂起 →
# docker restart agent（进程死、容器层换掉）→ 同一张 pending 卡还在，批准后 resume 到
# completed，SSE 断点前的事件照常补发（m3 卡测试计划的 compose 层证据）。
# 最小栈 = agent + gateway + case-backend（approve 要向 gateway 铸 ApprovalToken、
# 执行要查 M2 焚毁表/汇审计）；guards/chroma/openfga 由 depends_on 自动带起。
# 用法：bash scripts/agent-smoke-41.sh
#  （需要 Docker daemon——daemon 不可用显式 SKIP 不装绿，先例同票 37 的能力探测；
#   CI 只跑 compose-topology.test.ts 的静态/config 断言，本脚本是本地真机验证）
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker info --format ok >/dev/null 2>&1; then
  echo "SKIP 票 41 冒烟：docker daemon 不可用（拓扑断言已在 vitest 里跑过，本脚本归真机）"
  exit 0
fi

# HMAC 钥兜底：compose 穿透给 gateway+agent，两枚必须同串（用户 .env 设了就用用户的）
export SOC_HMAC_KEY="${SOC_HMAC_KEY:-local-demo-hmac-key-not-for-prod}"

# 演示图进容器：AGENT_FLOW=approval_demo（index.ts 教学开关）经 /tmp override 注入，
# docker-compose.yml 一字不动——本票主角（数据卷）必须从真 compose 文件来
OVERRIDE="$(mktemp /tmp/agent-smoke-41.XXXX.yml)"
trap 'rm -f "$OVERRIDE"' EXIT
cat > "$OVERRIDE" <<'YAML'
services:
  agent:
    environment:
      AGENT_FLOW: approval_demo
YAML
COMPOSE=(docker compose -f docker-compose.yml -f "$OVERRIDE")

wait_url() { # wait_url <url> <名> —— 90s 内等到非 000/5xx，否则喊人
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    [ "$code" != 000 ] && [ "$code" != 502 ] && [ "$code" != 503 ] && { echo "[$2] up ($code)"; return 0; }
    sleep 1
  done
  echo "[$2] 90s 未就绪"; exit 1
}

echo "== 1. 最小栈 up（agent+gateway+case-backend；guards/chroma/openfga 由 depends_on 带起）=="
"${COMPOSE[@]}" up -d agent gateway case-backend
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
wait_url http://127.0.0.1:3003/healthz agent
wait_url http://127.0.0.1:8002/healthz gateway
wait_url http://127.0.0.1:3002/healthz case-backend

echo "== 2. 拉起审批 run 挂起（alert_flow × AGENT_FLOW=approval_demo → 卡在 L2 闸口）=="
RUN_ID=$(curl -s -X POST http://127.0.0.1:3003/internal/runs -H 'content-type: application/json' \
  -d '{"kind":"alert_flow","alert_id":"smoke-41-restart"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["run_id"])')
echo "run_id = $RUN_ID"
CARD_ID=$(curl -s "http://127.0.0.1:3003/api/v1/approvals?status=pending" | python3 -c "
import sys, json
mine = [c for c in json.load(sys.stdin)['approvals'] if c['run_id'] == '$RUN_ID']
assert len(mine) == 1, f'应恰好一张 pending 卡，得到 {len(mine)}'
print(mine[0]['id'])")
echo "pending 卡 = ${CARD_ID}（tool=isolate_host，挂在 execute_action 的 interrupt 上）"

echo "== 3. 杀进程：docker restart agent（容器层整个换掉，只有挂载卷还在）=="
"${COMPOSE[@]}" restart agent
wait_url http://127.0.0.1:3003/healthz agent

echo "== 4. 同一张卡还在（验收①核心：卡从挂载盘回来，不是新库的空世界）=="
"${COMPOSE[@]}" exec -T agent ls /app/data | grep -q agent.sqlite \
  && echo "卷内证据：容器里 /app/data/agent.sqlite 在场"
python3 - "$RUN_ID" "$CARD_ID" <<'EOF'
import sys, json, urllib.request
run_id, card_id = sys.argv[1], sys.argv[2]
cards = json.load(urllib.request.urlopen("http://127.0.0.1:3003/api/v1/approvals?status=pending"))["approvals"]
mine = [c for c in cards if c["run_id"] == run_id]
assert len(mine) == 1 and mine[0]["id"] == card_id, f"重启后卡变了：{mine}"
assert mine[0]["tool"] == "isolate_host" and not mine[0]["executed"], f"卡形状不对：{mine[0]}"
print(f"PASS 同一张卡还在：{card_id}（run 绑定原样，未执行未裁决）")
EOF

echo "== 5. SSE 活着且断点前的事件可补发（INV-7：事件从盘上来，不丢不重）=="
SSE=$(curl -s -N --max-time 5 "http://127.0.0.1:3003/api/v1/events/stream?run_id=$RUN_ID" || true)
echo "$SSE" | grep -q "approval_required" || { echo "FAIL SSE 没回放 approval_required"; exit 1; }
echo "PASS SSE 补发含 approval_required（重启前落盘的事件照常回放）"

echo "== 6. 批准 → resume → completed（决定绑定原 (run, tool_call)）=="
RESP=$(curl -s -X POST "http://127.0.0.1:3003/api/v1/approvals/$CARD_ID/approve" \
  -H 'content-type: application/json' -d '{"approver":"smoke@soc.local"}')
echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('run_status') == 'completed', f'run 没 resume 到 completed：{d}'
print(f\"PASS approve → run_status={d['run_status']}（approval_token 已铸、闸放行、动作已执行）\")"
curl -s "http://127.0.0.1:3003/api/v1/approvals/$CARD_ID" >/dev/null 2>&1 || true
python3 - "$CARD_ID" <<'EOF'
import sys, json, urllib.request
card = json.load(urllib.request.urlopen(f"http://127.0.0.1:3003/api/v1/approvals"))["approvals"]
mine = [c for c in card if c["id"] == sys.argv[1]]
assert mine and mine[0]["executed"], f"卡没打 executed 标记：{mine}"
print(f"PASS 卡 executed=true（一次性执行标记落卷，重启也丢不掉）")
EOF

echo
echo "SMOKE PASS（票 41 验收①真容器证据：挂起 → 杀进程重启 → 同卡批准 → resume completed）"
echo "收尾：本脚本起的最小栈还在跑，要停 → docker compose stop agent gateway case-backend guards chroma openfga"
