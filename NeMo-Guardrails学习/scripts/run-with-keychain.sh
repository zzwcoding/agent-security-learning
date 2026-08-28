#!/bin/bash
# 启动聊天壳:key 从 Keychain 取,只注入环境变量,不落盘、不硬编码
set -euo pipefail
cd "$(dirname "$0")/.."

export OPENAI_API_KEY="$(agent-key minimax)"
# 关掉 NeMo 的匿名使用统计(它会往 NVIDIA 发心跳 ping)
export NEMO_GUARDRAILS_NO_USAGE_STATS=1

exec .venv/bin/python chat.py
