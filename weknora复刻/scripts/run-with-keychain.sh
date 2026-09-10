#!/usr/bin/env bash
# 用 Keychain 里的 GLM key 启动控制台（key 不落盘不进命令行历史，agent-key 只在启动时注入）
# 用法：bash scripts/run-with-keychain.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export WEKNORA_LLM_API_KEY="$(agent-key glm)"        # chat 走 GLM（glm-4-flash 免费档）
export WEKNORA_EMBED_API_KEY="$(agent-key minimax)"  # embedding 走 MiniMax（embo-01；智谱 embedding 未充值）
exec .venv/bin/streamlit run main.py
