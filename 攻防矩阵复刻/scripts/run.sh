#!/usr/bin/env bash
# 从 macOS Keychain 取 API key 注入环境变量,磁盘不落明文。
# 用法: scripts/run.sh [传给 demo.py 的参数...]
set -euo pipefail
cd "$(dirname "$0")/.."

export LLM_BASE_URL="https://api.minimaxi.com/v1"
export LLM_MODEL="MiniMax-M2"
export LLM_API_KEY="$(agent-key minimax)"

exec .venv/bin/python demo.py "$@"
