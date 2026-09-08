# 01: CI 守门：spec gate + lint/typecheck/test 进 Actions

**What to build:** 任何推送/PR 出红绿信号：Actions 跑 tools/check_specs.py 与 pnpm lint/typecheck/test。仓库级基建，不触及模块卡。补阶段 0 欠账——CI 要在第一行业务代码之前存在。

**Blocked by:** None (can start immediately)

**Touches modules:** 无（仓库级基建）

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 推送/PR 自动跑 python3 tools/check_specs.py，非零退出即红（源：sdd-flow 阶段 0 纪律）
- [ ] 人为把 specs/modules.md 依赖改出环，CI 变红（证明闸门活着）（源：spec gate 无环校验）
- [ ] pnpm lint / typecheck / test 三连进 CI（源：仓库 package.json scripts）
