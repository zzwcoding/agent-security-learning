# 23: m3 编排对齐 LangGraph.js——手写执行器迁移到 StateGraph（回补票）

**What to build:** services/agent 的手写图执行器（graph.ts）、run 状态机、信封 hash 链 checkpointer、ApprovalInterrupt 控制流异常，迁移到 @langchain/langgraph：StateGraph 声明编排、原生 interrupt()/Command 实现 L2 挂起/恢复、自定义 checkpointer（BaseCheckpointSaver）保留信封 hash 链防篡改语义。**行为语义全保**：triage/investigation/enrichment/sandbox/approvals/SSE 补发/budget 三闸的既有验收断言一条不删、一条不放松。

**Blocked by:** （回补票，直接动票 10/11/13/14/15/16 产物）

**Touches modules:** `m3`, `m4`, `m5`, `m6`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] package.json 真依赖 @langchain/langgraph（lockfile 在场），编排以 StateGraph 声明（节点/边/END 可读对应 m3 卡子图）（源：PRD §4.1 C3·ADR 0002）
  - `@langchain/langgraph@^1.4.14` 入 services/agent/package.json dependencies + pnpm-lock.yaml；graph.ts:295 `new StateGraph(RunFlowState).addSequence(entries)` + addEdge(START…)/addEdge(…, END)（graph.ts:296-300）
- [x] L2 interrupt/resume 走 LangGraph 原生 interrupt()/Command 机制，ApprovalInterrupt 控制流异常移除；票 11 五条验收（挂起→审批→resume→执行→焚毁、重启恢复、后到者 409、决定绑定 (run,tool_call)、驳回不执行）语义保持（源：PRD C3·票 11 验收回归）
  - ApprovalInterrupt 类已删除；挂起 = interrupt(卡id)（graph.ts:216），恢复 = graph.invoke(new Command({resume}))（graph.ts:349）。approval-loop.test.ts 五条验收原断言全绿；另补 langgraph-flow.test.ts 锁框架可观察面（__interrupt__/__resume__ 落盘）。生产入口冒烟：curl 全回路 + 杀进程重启后批准恢复均通过
- [x] 自定义 checkpointer 保留信封 hash 链：state 字节 sha256 + prev_hash 链，篡改任意字节 resume 必拒 + FAILURE 审计（源：票 10 验收保持·框架红线：不许为装进框架砍防篡改语义）
  - EnvelopeCheckpointSaver extends BaseCheckpointSaver（checkpointer.ts:140）：put 盖信封（sealEnvelope/putCheckpoint），getTuple 读前整链复核（verifyChain），putWrites 存框架任务账（checkpoint_writes 新表）。信封列结构与 envelope.ts 纯函数原样；真载体篡改断言在 langgraph-flow.test.ts（红线测试）
- [x] run 状态机（queued→running→awaiting_approval→running→completed/failed，非法 409）与 budget 三闸（60s/20 步/50k token）语义保持（源：CONTEXT.md 状态机·票 10）
  - statemachine.ts/budget.ts 零改动；迁移表全组合 + 三闸测试原断言全绿（graph.test.ts）
- [x] SSE 自增 id 落盘 + Last-Event-ID 补发不丢不重语义保持（源：INV-7·票 10）
  - events.ts/app.ts SSE 面零改动；app.test.ts 补发端到端原断言全绿
- [x] agent 全量测试改造后全绿，四 worker 子图验收断言不得删除或放松（源：票 13-16 回归·ADR 0002 决策 1）
  - agent 18 文件 216 测试全绿（基线 17 文件 211 + 本票新增 5 条新载体断言；既有断言除下方「出入 1」的信封环数外零改动）；全仓 lint/typecheck/test + python3 tools/check_specs.py 过
- [x] 架构投影文档（docs/arch-notes.json、architecture-m3-internal.*）同步为新载体（源：sdd-flow 阶段 5 收尾第⑤样）
  - arch-notes.json m3 卡与 architecture-m3-internal.{architecture.json,html} 标签同步为 StateGraph 声明编排 / 原生 interrupt()/Command / BaseCheckpointSaver·信封 hash 链

**Blocked by 补充说明:** 无前置票；本票是 ADR 0002 框架回补的第一张，完成后票 17/18 才开工（它们的 Blocked by 已加本票）。

## 出入记录（按「记票不猜」纪律，实施中发现）

1. **信封节奏随载体变化的可观察差异（既有断言 1 处调整）**：旧手写执行器「每节点跑完盖 1 环」；LangGraph 原生 checkpoint 节奏 = 输入簿记 2 环（step -1 原始输入、step 0 输入落通道，node 列 `__input__`）+ 每节点跑完 1 环（graph.test.ts 断言由 `toHaveLength(2)` 调整为 `THIN_ALERT_FLOW.length + 2`，注释留痕）。防篡改语义不变：每环都盖信封 hash、读前整链复核、篡改必拒（真载体断言 langgraph-flow.test.ts）。判断依据：环数是旧载体的实现节奏，不是 INV/PRD 语义；为凑旧环数去压制框架 checkpoint 才是真削足适履。
2. **票 13 期间 approval_demo 演示图接线掉线（本票回补）**：票 11 的 index.ts 原本 `AGENT_FLOW=approval_demo → APPROVAL_DEMO_FLOW`，票 13 换 makeNodes 时该接线被删（只剩注释，env 实际落到薄径）。本票迁移 graph.ts 时回补接线（index.ts），演示图重新可达。
3. **框架回吐语义（新知识，记票备考）**：同一节点 resume 后再次 interrupt() 时，框架会先把旧 resume 值返回给同位 interrupt() 调用；本票取「决定以审批卡 DB 为准、interrupt() 返回值只当唤醒信号」的循环式闸口（graph.ts:196-218），避免依赖框架 resume 值的匹配细节。
