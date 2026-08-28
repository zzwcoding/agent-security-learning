#!/usr/bin/env bash
# 启动起步 Agent:从 macOS Keychain 取 API key 注入环境变量,磁盘不落明文。
# 用法: scripts/run-with-keychain.sh [供应商]   (默认 minimax)
set -euo pipefail
cd "$(dirname "$0")/.."

PROVIDER="${1:-minimax}"
case "$PROVIDER" in
  minimax)
    export LLM_BASE_URL="https://api.minimaxi.com/v1"
    export LLM_MODEL="MiniMax-M2"
    ;;
  # 备选供应商加在这里;kimi 的 Keychain 条目是 OAuth token,不能当 API key 用
  *)
    echo "未知供应商: $PROVIDER" >&2
    exit 1
    ;;
esac
export LLM_API_KEY="$(agent-key "$PROVIDER")"

exec .venv/bin/python agent.py
