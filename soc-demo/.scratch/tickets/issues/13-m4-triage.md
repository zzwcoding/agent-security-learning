# 13: m4 分诊 worker：四分类子图

**What to build:** 单条告警 → 四分类 verdict + 处置建议的结构化子图：wrapUntrusted 不可信包装、guards 扫描调用、KB 检索注入（内存 stub）、L1 任务票过验票闸。物理无 L2 票。

**Blocked by:** 04, 07, 10

**Touches modules:** `m2`, `m4`, `m7`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 四分类 verdict 结构化输出 schema（prompt 契约=事实接口）（源：m4 卡职责·注意）
- [ ] 标注集宏准确率 ≥80%（源：m4 卡测试计划）
- [ ] 同主机 24h 两条 TP 只建 1 案；并发同告警只分诊 1 次（源：m4 卡测试计划）
- [ ] 自我审计 checkpoint 100% 出现（源：m4 卡测试计划）
- [ ] 全部工具调用过 verifyTicket（L1 任务票）；物理无 L2 票（源：INV-3·m9-S2）
- [ ] 不可信段 wrapUntrusted 包装 + guards /scan/injection 调用（源：m4 卡 Seam·PRD FR-S3.1/S3.2）
- [ ] KB 检索注入走内存 stub adapter（源：m4 卡依赖·m7 检索面 stub）
