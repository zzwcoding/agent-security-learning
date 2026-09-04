# SOC 数字员工（soc-demo）

为被告警淹没的 SOC 提供一名"数字员工"：自动分诊告警、调查取证、沉淀知识，危险动作永远等人点头。

- 需求与验收口径：`specs/` 与 PRD（见下方文档地图）
- 一键启动：`docker compose up`（阶段 0.2 起可用）

## 文档地图

- PRD v1.1（冻结+变更记录）：`../deliverables/route5/product-handbook.md`
- 模块划分：`specs/modules.md`
- 术语表：`CONTEXT.md`
- 架构决策：`docs/adr/`
- 架构图：`docs/architecture-v4.html`（点节点跳详情页 `docs/nodes/`）；M1 内部结构图 `docs/architecture-m1-internal.html`
- 节点注解源文件：`docs/arch-notes.json`（改注解改它，改完跑 `node scripts/inject-arch-notes.mjs`；archify 重出主图后也要重跑一次）
