#!/usr/bin/env bash
# 容器化启动起步 Agent:key 从 Keychain 注入,workspace 挂卷(容器里写的文件宿主可见)。
# 用法: scripts/docker-run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -t starter-agent .

# memory.json 单独挂卷:不挂的话它写在容器可写层,--rm 退出即焚毁,记忆跨重启失效。
# 文件必须先在宿主存在,否则 docker 会把挂载点建成同名目录
touch memory.json

exec docker run --rm -it \
  -e LLM_BASE_URL="https://api.minimaxi.com/v1" \
  -e LLM_MODEL="MiniMax-M2" \
  -e LLM_API_KEY="$(agent-key minimax)" \
  -v "$PWD/workspace:/app/workspace" \
  -v "$PWD/memory.json:/app/memory.json" \
  starter-agent
