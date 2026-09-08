# 23: m3 编排对齐 LangGraph.js——手写执行器迁移到 StateGraph（回补票）

**What to build:** services/agent 的手写图执行器（graph.ts）、run 状态机、信封 hash 链 checkpointer、ApprovalInterrupt 控制流异常，迁移到 @langchain/langgraph：StateGraph 声明编排、原生 interrupt()/Command 实现 L2 挂起/恢复、自定义 checkpointer（BaseCheckpointSaver）保留信封 hash 链防篡改语义。**行为语义全保**：triage/investigation/enrichment/sandbox/approvals/SSE 补发/budget 三闸的既有验收断言一条不删、一条不放松。

**Blocked by:** （回补票，直接动票 10/11/13/14/15/16 产物）

**Touches modules:** `m3`, `m4`, `m5`, `m6`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] package.json 真依赖 @langchain/langgraph（lockfile 在场），编排以 StateGraph 声明（节点/边/END 可读对应 m3 卡子图）（源：PRD §4.1 C3·ADR 0002）
- [ ] L2 interrupt/resume 走 LangGraph 原生 interrupt()/Command 机制，ApprovalInterrupt 控制流异常移除；票 11 五条验收（挂起→审批→resume→执行→焚毁、重启恢复、后到者 409、决定绑定 (run,tool_call)、驳回不执行）语义保持（源：PRD C3·票 11 验收回归）
- [ ] 自定义 checkpointer 保留信封 hash 链：state 字节 sha256 + prev_hash 链，篡改任意字节 resume 必拒 + FAILURE 审计（源：票 10 验收保持·框架红线：不许为装进框架砍防篡改语义）
- [ ] run 状态机（queued→running→awaiting_approval→running→completed/failed，非法 409）与 budget 三闸（60s/20 步/50k token）语义保持（源：CONTEXT.md 状态机·票 10）
- [ ] SSE 自增 id 落盘 + Last-Event-ID 补发不丢不重语义保持（源：INV-7·票 10）
- [ ] agent 全量测试改造后全绿，四 worker 子图验收断言不得删除或放松（源：票 13-16 回归·ADR 0002 决策 1）
- [ ] 架构投影文档（docs/arch-notes.json、architecture-m3-internal.*）同步为新载体（源：sdd-flow 阶段 5 收尾第⑤样）

**Blocked by 补充说明:** 无前置票；本票是 ADR 0002 框架回补的第一张，完成后票 17/18 才开工（它们的 Blocked by 已加本票）。
