# 37-m3-langfuse-profile: Langfuse observability profile 落地（B1）

**What to build:** docker-compose 增 langfuse 服务与 `profiles: [observability]`（ADR 0001 承诺兑现）；agent 审计/事件按可选 env 开关镜像到 Langfuse（不进默认链路）；文档口径对齐（ADR 0001/PRD v1.1 变更 1 引用本票）。

**Blocked by:** 28

**Touches modules:** `m3`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] compose profile observability 一键起 Langfuse（源：遗留 ADR 0001·对账一-1）
- [ ] 默认链路零改动（不开 profile 行为不变）（源：ADR 0001 拍板）
- [ ] 可选接通时 trace 可查（源：PRD C5 trace 收集）
