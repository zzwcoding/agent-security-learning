#!/usr/bin/env bash
# 票 12：OpenFGA 授权模型幂等重建（PRD 附录 A.2：4 角色 × 4 工具族）。
# 用法：bash scripts/setup-openfga.sh [OPENFGA_URL]（默认宿主映射口 http://127.0.0.1:18080）
# 幂等 = store 按名复用 / 模型比对复用 / 元组差量同步——重复跑结果一致；
# 引擎在 services/gateway/fga/setup_openfga.py，本壳只管路径与默认值。
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 services/gateway/fga/setup_openfga.py \
  --api "${1:-http://127.0.0.1:18080}"
