#!/usr/bin/env bash
# 启动起步 Agent(阶段 26 起):LLM 三要素不再注入任何进程环境——config.py 的默认值
# 已指向本地凭证代理,key 是 PLACEHOLDER 占位符。本脚本只注入 Langfuse 观测键
# (它们不在对话攻击面上,归观测系统管)。
# 用法: scripts/run-agent.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 阶段 19:Langfuse 观测。SDK 自动读这三个环境变量;base url 是本地自托管实例
export LANGFUSE_PUBLIC_KEY="$(agent-key langfuse-public)"
export LANGFUSE_SECRET_KEY="$(agent-key langfuse-secret)"
export LANGFUSE_BASE_URL="http://localhost:3000"

exec .venv/bin/python agent.py
