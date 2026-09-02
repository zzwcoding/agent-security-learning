#!/usr/bin/env bash
# 启动薄 HTTP 层(阶段 47,红队攻击面):密钥纪律与 run-agent.sh 完全一致——
# LLM 三要素不进进程(config.py 默认指向凭证代理+PLACEHOLDER),只注入 Langfuse
# 观测键和现铸的网关短时通行证。
# 用法: scripts/run-chat-server.sh  (监听 127.0.0.1:8000)
set -euo pipefail
cd "$(dirname "$0")/.."

export LANGFUSE_PUBLIC_KEY="$(agent-key langfuse-public)"
export LANGFUSE_SECRET_KEY="$(agent-key langfuse-secret)"
export LANGFUSE_BASE_URL="http://localhost:3000"

# 网关通行证:启动时现铸、60 分钟短时、只进本进程环境不落盘(同 run-agent.sh)
export GATEWAY_TOKEN="$(scripts/mint-gateway-token.sh)"

exec .venv/bin/python -m uvicorn chat_server:app --host 127.0.0.1 --port 8000
