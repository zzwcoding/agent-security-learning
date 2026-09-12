# 73-orchestration-loop-skeleton: m14 机制骨架——轮次链 + fanout/await + 接线（P1）

**What to build:** 编排循环的运行骨架。① `services/agent` 新增循环模块目录（m14 领地）：round 链六节点 intake→planner→dispatch→await_children→judge→outcome（FlowNode 形态，走 graph.ts 现有节点包装——**compileFlowGraph 串行链模型不动**，循环性靠 dispatcher 层"round k outcome 发事件拉起 round k+1"表达，父子 run 关联簿记入 run 行）；② `fanout_dispatch`：按 planner 组合拉起 N 个子 run（独立 run 行、记录 parent_run_id + round），子 run 复用 investigation worker 的 plan/decide 循环（hunt 版 prompt 模板为票 79 内容，本票用最小桩）；③ `await_children`：跨 run 等待——订阅事件总线（子 run 终态事件唤醒），**禁轮询**；④ 接线：`run-kinds.ts` 注册新 kind、`index.ts` makeNodes 分支、审计五要素（INV-8）与 SSE 事件（node_enter/exit 与现有口径一致）。验收条目逐条源自 specs/orchestration-loop.md 验收测试表（票 72 收口时回填行号）。

**铁律:** 框架红线——@langchain/langgraph 真用（节点包装/检查点走现有 compileFlowGraph 机制），禁手写替代；禁改 compileFlowGraph 拓扑模型（串行链 + dispatcher 循环是已定案形态，改动 = 回阶段 2）；边界红线——只许新建 m14 目录 + 改 run-kinds/index 接线，survey/直引他模块内部文件禁止（adapters 经公开接口注入）。

**Touches modules:** `m14`、`m3`

**Belongs to spec:** specs/orchestration-loop.md（验收条目行号票 72 收口时回填）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T01/T02/T19（spec 已定稿 2026-09-12）

**Blocked by:** 72

**Status:** blocked

**验收：**
- [ ] round 链六节点契约测试绿（fake LLM 下跑通两轮：C2≠C1 或收敛单轮）
- [ ] fanout 子 run 为独立 run 行，parent/round 簿记可查，SSE 全程可回放
- [ ] await_children 事件唤醒实现，全仓无轮询实现（review 可查）
- [ ] run-kinds 注册 + makeNodes 接线，旧 kind 行为零回归
- [ ] 审计五要素齐全（INV-8），失败强杀口径与现有 run 一致（INV-1）

**实现记录：**（待填）
