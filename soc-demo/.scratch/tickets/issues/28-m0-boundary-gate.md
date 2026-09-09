# 28-m0-boundary-gate: 边界闸补建 + 越界清偿（A2+E2+E3）

**What to build:** specs/modules.md「边界规则」节机器化：自写零依赖边界闸脚本（消费边界规则表与豁免清单，格式照 tools/check_specs.py 先例）进父仓库 CI ts job；同提交内清偿现存越界：① workers/triage/testkit.ts 直引 case-backend 内部 → 改夹具数据+真 REST（E2，ADR 0003 裁决 4 明确不豁免）；② ingest replay.test.ts 反引 scripts/replay.ts → 改子进程执行（E3）。

**Blocked by:** （ADR 0003 裁决 3/4 已落）

**Touches modules:** `m2`, `m4`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 边界闸脚本进 CI 且真消费「边界规则」表：豁免有理由、越界必红（源：skill 阶段 6·核心原则 7）
- [ ] testkit 不再 import case-backend 内部，triage 全部既有测试语义保持（源：对账二-5·ADR 0003 裁决 4）
- [ ] ingest 测试不反引 scripts/，replay 行为断言保持（源：对账二-6）
- [ ] CI 全绿含新闸；「边界规则」表每条禁令都有人查（源：sdd-flow 阶段 6 验收对象）
