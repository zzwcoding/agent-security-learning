#!/usr/bin/env bash
# 启动凭证代理(阶段 26):真 key 从 Keychain 取出,且只进入代理进程。
# Agent 用 scripts/run-agent.sh 另行启动——它的环境里只有 PLACEHOLDER 占位符。
# 用法: scripts/run-proxy.sh   (默认 minimax)
set -euo pipefail
cd "$(dirname "$0")/.."

PROVIDER="${1:-minimax}"
if [ "$PROVIDER" != "minimax" ]; then
  # 备选供应商加在这里;kimi 的 Keychain 条目是 OAuth token,不能当 API key 用
  echo "未知供应商: $PROVIDER" >&2
  exit 1
fi

export MINIMAX_API_KEY="$(agent-key "$PROVIDER")"

echo "凭证代理就绪:http://127.0.0.1:5055 → https://api.minimaxi.com(真 key 只在本进程)"
exec .venv/bin/python -m uvicorn proxy:app --host 127.0.0.1 --port 5055
