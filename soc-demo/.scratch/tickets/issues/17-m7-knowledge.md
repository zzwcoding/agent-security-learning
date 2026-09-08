# 17: m7 知识沉淀 + chroma 检索面

**What to build:** 案件关闭 → 提炼 KBEntry 草稿（proposed）→ kb_write L2 人审闸 → approved 进 chroma 检索面。kb/proposals REST 挂 m2。驳回后检索面确定性查不到。

**Blocked by:** 03, 11, 13, 23

**Touches modules:** `m2`, `m7`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 提炼子图产出 KBEntry 草稿 proposed（kind/title/body/tags）（源：m7 卡职责·PRD §5.10）
- [ ] kb_write 为 L2 工具：人审 approve → approved 进检索面；驳回 → rejected 永不检索（源：PRD FR-M7.2·INV-5）
- [ ] knowledge/02_poison_rejected：驳回后检索面确定性查不到（源：m7 卡测试计划）
- [ ] kb/proposals REST 挂 M2 侧（源：m7 卡公开接口决策）
- [ ] 检索 top-k=5；replay 对结论一致且工具调用数下降（源：决策记录 #6·m7 卡测试计划）
