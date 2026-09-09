# 36-m5m6-case-flow-live: case_flow 生产接线：调查+富化上线（B4+G2-5+G2-6）

**What to build:** ① RUN_KINDS 放行 case_flow：alert_flow TP 分支建案后链上 enrich→investigate（子图已有，票 15/14），web 流水线视图节点适配；② add_task_log 收口：M2 补 tasks 写口（m2 卡本有 tasks 实体）并接通调查工具面，或从工具面移除声明（二选一按 m5 卡定）；③ 调查循环 observe 接 guards tool_output 通道扫描（flag 打标）。

**Blocked by:** 28

**Touches modules:** `m2`, `m3`, `m5`, `m6`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] TP 告警 → 建案 → 富化 → 调查报告全链在生产 RUN_KINDS 可达（源：遗留标记 15-4/27-2·B4·PRD §4.2 步骤 7-8）
- [ ] add_task_log 两头一致（可用或移除）（源：遗留标记 14-2）
- [ ] 调查 tool_output 过 guards（源：遗留标记 14-3·D1 防线）
- [ ] web 流水线视图覆盖 case_flow 节点（源：FR-M10.2）
