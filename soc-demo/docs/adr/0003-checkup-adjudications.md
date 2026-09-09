# ADR 0003：收官体检裁决打包——LangChain 承诺口径、死信替代确认、evals 组装豁免

- 状态：已接受（2026-09-09，阶段 7 收官体检，用户拍板"所有的都全做"）
- 背景：checkup-2026-09-09.md 三类对账 + 结构扫描 + 遗留标记回收共产出 21 个决策项。本 ADR 收拢其中"不需要新代码、只需要正式决策"的裁决；需要代码的一律转票（28-44），不用 ADR 记。

## 裁决

1. **LangChain.js 承诺口径（对账一-5 / B3）**：PRD C3「TypeScript + LangChain.js / LangGraph.js」为斜杠可选项，承诺由 `@langchain/langgraph` 承载（票 23 已真落地：StateGraph / interrupt() / Command / BaseCheckpointSaver）。**LLM I/O 维持 `GatewayLlmClient` 经凭证代理直连，不引入 @langchain/core 模型适配层**——经代理出站是 INV-4（真凭证只存在于网关与出站瞬间）的架构保证，换 langchain 客户端直连上游会绕开票 08 的凭证代理与金丝雀闸。架构投影文档已同步（票 23/27）。
2. **pipeline_pending / 死信队列（遗留标记 [09-4]）**：正式确认票 09 的**覆盖性替代**——outbox 事件与业务写入同事务落库（票 03），"事件总线不可达"场景在架构上不存在，无死信可积压。不建死信队列；为对齐 PRD 措辞，PRD 异常与边界条目的"pipeline_pending"表述由实现记录口径覆盖（本 ADR 即裁决记录）。
3. **evals 进程内组装豁免（边界对账 E1，边界规则豁免清单第 1 条）**：决策 #10 拍板的快道形态是"单测级注入"（真 SQLite 内存库 + 生产 adapter 进程内组装），客观要求 evals 引用 services 内部。豁免如下，超出即越界：
   - 允许：`evals/src/{runner.ts,scenarios.ts,judge.ts,assertions.ts,suite.test.ts}` 及其直接 import 闭包中**组装入口性质的符号**（buildApp/executeRun/makeXxxFlow/FakeXxxLlm/MemoryXxx/GatewayLlmClient/事件读口）。
   - 禁止：直接调用 case-backend `src/db.ts`/`src/store.ts` 的**写路径函数**（evals 只经公开 REST 或组装入口间接触发写）。
   - 复核：每轮体检第四条对账复核本条；用途漂移（如 evals 开始改业务数据）即收回豁免。
4. **同批明确不豁免**：agent `workers/triage/testkit.ts` 直引 case-backend 内部（E2）→ 票 28 改造为夹具数据 + 真 REST；ingest 测试反引 `scripts/replay.ts`（E3）→ 票 28 改子进程执行。**"测试先绿了"不构成豁免理由。**

## 后果

- 好：三类对账的全部"承诺悬空"项有了正式去向（本 ADR 三条裁决 + 票 28-44 的补齐票），文档与实现不再有两头不一致的存活状态。
- 代价：边界规则节与闸（票 28）落地后，CI 将对现存越界真实报警——票 28 必须在同一提交内完成清偿，避免主干红灯窗口。
- 风险：豁免清单第 1 条若被 subsequent 票当作"evals 可以随便 import"的口子，边界将腐烂——靠每轮体检第四条回收复核兜底。

## 追认（2026-09-09，票 44 落地后 L0 追认，票 45 在案）

裁决 3 允许清单**延伸**：票 44 把 scenarios.ts（1334 行）按 facet 拆进 `evals/src/rigs/` 七文件（shared/approval/replay/chat/investigation/triage/attack.ts），属纯机械搬移——新文件继承组装入口豁免角色，语义不变：仍限组装入口性质符号、仍禁触 case-backend `db.ts`/`store.ts` 写路径、仍受每轮体检第四条复核。原五文件（runner/scenarios/judge/assertions/suite.test.ts）豁免不变。
