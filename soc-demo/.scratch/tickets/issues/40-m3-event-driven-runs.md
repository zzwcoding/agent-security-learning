# 40-m3-event-driven-runs: 事件驱动自动拉起（G2-9）

**What to build:** 消费 outbox 事件自动编排：alert.created → 自动拉起 alert_flow（回放演示口径，防重：verdict 锁已有）；case.closed → 自动拉起 knowledge_flow 提炼（票 17 线头）；开关 env 可关（evals/手动模式不受影响）。

**Blocked by:** 28

**Touches modules:** `m3`, `m7`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] alert.created 自动分诊可开关（源：遗留标记 17-6·PRD 消息旅程）
- [ ] case.closed 自动提炼可开关（源：遗留标记 17-6·FR-M7.1）
- [ ] 重复事件不重复拉起（INV-6/verdict 锁复用）（源：INV-6）
