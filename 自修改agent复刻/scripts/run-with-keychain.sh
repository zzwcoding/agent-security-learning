#!/usr/bin/env bash
# 真 key 只从 Keychain 取出、只进本进程环境;.env 永远假密钥,真 key 不进 git。
# 用法: scripts/run-with-keychain.sh demo.py --generator llm
set -euo pipefail
cd "$(dirname "$0")/.."

export MINIMAX_API_KEY="$(agent-key minimax)"

exec .venv/bin/python "$@"
