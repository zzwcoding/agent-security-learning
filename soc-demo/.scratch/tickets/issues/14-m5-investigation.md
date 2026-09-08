# 14: m5 调查 worker：工具循环 + 三条缰绳

**What to build:** TP 案件关联调查：多步工具循环产出结构化调查报告进 Timeline。三条缰绳（max_steps/防打转/上下文治理）+ siem_query fixture adapter。只提建议不动手。

**Blocked by:** 13

**Touches modules:** `m2`, `m5`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] siem_query 强制 time_window 等工具签名契约（源：m5 卡公开接口·PRD §6-M5）
- [ ] invest/01_ssh_tp_full：报告 schema 过 + findings 引用真实工具输出（源：m5 卡测试计划）
- [ ] max_steps=20 超限截断（源：m3 资源兜底·决策 #5）
- [ ] 防打转：同参数重复调用直接返回错误（源：m5 卡测试计划）
- [ ] 超大结果 spill 落盘且上下文未超窗（源：m5 卡测试计划）
