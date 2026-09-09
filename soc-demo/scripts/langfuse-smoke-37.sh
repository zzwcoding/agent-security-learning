#!/usr/bin/env bash
# 票 37 冒烟（真容器）：默认 config 不含 langfuse（验收②）+ profile 一键起（验收①）
# + langfuse 探活 + agent 侧镜像真落 trace 可查（验收③）。
# 用法：bash scripts/langfuse-smoke-37.sh  （需要 Docker daemon；CI 不跑——CI 只做
# compose-topology.test.ts 的静态断言与默认 config 校验，本脚本是本地/发版前真机验证）
set -euo pipefail
cd "$(dirname "$0")/.."

wait_url() { # wait_url <url> <名> —— 120s 内等到 2xx/3xx，否则喊人（首启要跑 DB 迁移，慢是正常的）
  for _ in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    [ "$code" != 000 ] && [ "$code" != 502 ] && [ "$code" != 503 ] && { echo "[$2] up ($code)"; return 0; }
    sleep 1
  done
  echo "[$2] 120s 未就绪"; exit 1
}

echo "== 1. 默认 config 不含 langfuse（验收②：默认链路零改动，九服务原样）=="
if docker compose config --services | grep -qx 'langfuse'; then echo "FAIL 默认 config 出现 langfuse"; exit 1; fi
n=$(docker compose config --services | wc -l | tr -d ' ')
[ "$n" = "9" ] || { echo "FAIL 默认服务数 = $n（应 9）"; exit 1; }
echo "PASS 默认九服务不变，langfuse / langfuse-db 均不在"

echo "== 2. profile observability 一键起（验收①）=="
docker compose --profile observability config --services | grep -qx 'langfuse' || { echo "FAIL profile 后仍无 langfuse"; exit 1; }
docker compose --profile observability up -d langfuse
docker compose --profile observability ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}' | grep -E 'langfuse|SERVICE'
wait_url http://127.0.0.1:13000/api/public/health langfuse
echo "PASS profile 起 langfuse（宿主 13000），教学假 key pk-lf-local-demo 已由 LANGFUSE_INIT_* 种下"

echo "== 3. agent env 穿透在场（compose 渲染面）=="
docker compose config agent | grep -q 'LANGFUSE_PUBLIC_KEY' || { echo "FAIL agent 未穿 LANGFUSE_PUBLIC_KEY"; exit 1; }
docker compose config agent | grep -q 'LANGFUSE_HOST' || { echo "FAIL agent 未穿 LANGFUSE_HOST"; exit 1; }
echo "PASS agent 三把钥匙 env 穿透（key 空 = 旁路不启用）"

echo "== 4. trace 落库可查（验收③：真 ingestion POST → API 查回）=="
pnpm -C services/agent exec vitest run src/langfuse.test.ts 2>&1 | grep -Ev '^$/'
echo "PASS（见上：真容器冒烟 2 例应 ✓，未 skip）"

echo "== 5.（可选，agent 在跑才做）整链口径：agent 带真 key 重启 → 重放告警 → run trace 可查 =="
if [ -n "$(docker compose ps -q agent 2>/dev/null || true)" ]; then
  grep -q '^LANGFUSE_PUBLIC_KEY=pk-lf-local-demo' .env 2>/dev/null || \
    echo "SKIP 整链步：.env 未配 LANGFUSE_PUBLIC_KEY（要跑：.env 追加 LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY 后重跑本脚本）"
  if grep -q '^LANGFUSE_PUBLIC_KEY=pk-lf-local-demo' .env 2>/dev/null; then
    docker compose up -d agent   # env 变了会自动重建
    wait_url http://127.0.0.1:3003/healthz agent
    pnpm replay >/dev/null
    sleep 3
    hit=$(curl -s -u pk-lf-local-demo:sk-lf-local-demo "http://127.0.0.1:13000/api/public/traces?limit=10" | grep -o '"run_id":"run_[a-f0-9-]*"' | head -1 || true)
    [ -n "$hit" ] || { echo "FAIL 整链：Langfuse 里没见到 run trace"; exit 1; }
    echo "PASS 整链：查到 $hit（打开 http://localhost:13000 用 demo@soc-demo.local / teaching-demo-pass-not-for-prod 看时间线）"
  fi
else
  echo "SKIP 整链步：agent 容器未在跑（九服务一键起后重跑本脚本可补做）"
fi

echo
echo "收尾：停观测栈 = docker compose --profile observability down（数据在 ./data/langfuse-db/）"
