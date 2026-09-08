# 12: gateway 三容器并排：contextforge + openfga

**What to build:** compose 接入 contextforge 与 openfga 官方镜像：setup-openfga.sh 按 A.2 幂等重建授权模型（4 角色 × 4 工具族），fga_check 插件挂载 contextforge。自写件不动镜像内部。

**Blocked by:** 08

**Touches modules:** `m8`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] compose 三容器并排 up：contextforge + openfga + 自写件（源：modules.md §2·2026-09-04 拍板）
- [ ] setup 脚本幂等重建授权模型（4 角色 × 4 工具族）（源：modules.md §2·ADR 0001）
- [ ] fga_check 插件挂载，改 user_map 对位 A.2 角色矩阵（源：ADR 0001 直接搬件）
- [ ] 升级官方镜像不碰自写代码（排障简单验证）（源：ADR 0001 决策）
