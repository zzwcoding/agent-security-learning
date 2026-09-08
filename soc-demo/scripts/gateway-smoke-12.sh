#!/usr/bin/env bash
# 票 12 冒烟（真容器）：三容器并排 up + setup 幂等两连跑 + A.2 矩阵裁决 + 插件容器内真跑 + 换镜像不碰自写件。
# 用法：bash scripts/gateway-smoke-12.sh   （需要 Docker daemon；CI 的 compose job 只做 config 校验，本脚本是本地/发版前的真机验证）
set -euo pipefail
cd "$(dirname "$0")/.."

wait_url() { # wait_url <url> <名> —— 90s 内等到非 000/5xx，否则喊人
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    [ "$code" != 000 ] && [ "$code" != 502 ] && [ "$code" != 503 ] && { echo "[$2] up ($code)"; return 0; }
    sleep 1
  done
  echo "[$2] 90s 未就绪"; exit 1
}

echo "== 1. 三容器并排 up（contextforge + openfga + gateway 自写件，验收①）=="
docker compose up -d --build openfga contextforge gateway
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
wait_url http://127.0.0.1:18080/healthz openfga
wait_url http://127.0.0.1:4444/health contextforge
wait_url http://127.0.0.1:8002/healthz gateway

echo "== 2. setup-openfga.sh 幂等两连跑（验收②）=="
bash scripts/setup-openfga.sh | tee /tmp/setup-run1.txt
echo "--- 第二遍（应 store/model 复用、元组零写入）---"
bash scripts/setup-openfga.sh | tee /tmp/setup-run2.txt
grep -q "store .* (reused" /tmp/setup-run2.txt || { echo "FAIL store 未复用"; exit 1; }
grep -q "model .* (reused)" /tmp/setup-run2.txt || { echo "FAIL model 未复用"; exit 1; }
grep -q "tuples    = written=0 deleted=0" /tmp/setup-run2.txt || { echo "FAIL 元组未收敛"; exit 1; }
echo "PASS 幂等：store/model 复用，元组零写入零删除"

echo "== 3. A.2 矩阵裁决（第一遍 run 的 13 条全 ✓）=="
n=$(grep -c '✓' /tmp/setup-run1.txt); echo "✓ 条数 = $n"
[ "$n" = 13 ] || { echo "FAIL 裁决条数不符（应 13）"; exit 1; }

echo "== 4. fga_check 插件在 contextforge 容器内真跑（挂载 + 容器网络直达 openfga，验收③）=="
docker compose exec -T contextforge python - <<'EOF'
import asyncio, sys
sys.path.insert(0, "plugins")  # 复刻 plugin_dirs 的加载方式
import yaml, fga_check
from cpex.framework import PluginConfig, PluginContext, ToolPreInvokePayload
from cpex.framework.models import GlobalContext

entry = yaml.safe_load(open("plugins/config.yaml"))["plugins"][0]
keys = ("name", "kind", "version", "author", "hooks", "tags", "mode", "priority", "config")
plugin = fga_check.FGACheckPlugin(PluginConfig(**{k: entry[k] for k in keys if k in entry}))
print("plugin:", plugin.name, plugin.mode, "priority", plugin.priority)

def call(email, tool):
    def go():
        ctx = PluginContext(global_context=GlobalContext(request_id="smoke", user=email))
        return plugin.tool_pre_invoke(ToolPreInvokePayload(name=tool, args={}), ctx)
    return asyncio.run(go())

expect = [("soc1@soc.local", "kb_lookup", True),
          ("soc1@soc.local", "isolate_host", False),     # m8 eval：soc1 发起 L2 意图 100% deny
          ("stranger@evil.example", "kb_lookup", False)]  # 认不出的脸=匿名位，全 deny
for email, tool, want in expect:
    r = call(email, tool)
    assert r.continue_processing is want, f"{email}->{tool}: 预期 {want}"
    print(f"  {'ALLOW' if want else 'DENY(403)'}  {email} -> {tool}")
EOF
echo "PASS 插件裁决：allow/deny/匿名 三路全对（真容器 → 真容器）"

echo "== 5. 换镜像不碰自写件（验收④：官方镜像按 digest 强制重建容器 → 自写件仍从挂载来）=="
docker compose up -d --force-recreate contextforge
wait_url http://127.0.0.1:4444/health contextforge
docker compose exec -T contextforge grep -q "fga_check" /app/plugins/config.yaml \
  && echo "PASS 官方镜像重建容器后插件配置原样（挂载件不随镜像升级漂移）"

echo
echo "SMOKE PASS（票 12：四条验收的真容器证据齐了）"
