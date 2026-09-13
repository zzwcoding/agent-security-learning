# 77-round-level-budget: 预算双闸——run 级 + 轮次级 + 轮次防转（P1）

**What to build:** 把现有 budget 三闸（60s/20 步/50k token，run 级）提升到双层级。① 轮次级闸：每轮独立计步/计时/token（防 planner 拆 1 条任务耗光父 run 预算的偏科场景）；② max_rounds 硬顶（默认值 spec 定，超顶强杀 failed，口径与现有 BudgetExceededError 一致——审计 + error 事件 + Web 可见）；③ 轮次级防转指纹：把 investigation worker 的"同参数重复调用报错"缰绳提升到轮次级——planner 在相邻两轮选出同一组合（同指纹）即判空转，max_repeat=1（允许证据变化后的重选由 gap 输入差异豁免，指纹含 gap 摘要 hash）；④ 计费连续性：resume/跨轮 token 累计口径与现有 run.steps/tokensUsed 一致（压测报告的四天花板数字不回退）。验收条目逐条源自 spec（票 72 回填行号）。

**铁律:** 预算闸是资源兜底不是业务逻辑——触发即强杀，不得"降级继续"；边界红线——只许扩展 budget.ts 计费口径与 m14 轮次簿记，既有 run 级闸语义不动（旧 kind 零回归）。

**Touches modules:** `m14`、`m3`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T06/T09/T10/T18（spec 已定稿 2026-09-12；T10 user_cancel_children 原 73-77 无票认领，L0 2026-09-13 补绑本票——人取消与预算触发共用「取消信号节点包装层检查 + 子 run failed(parent_cancelled)」同一套停止机制，loop.test.ts 归本票）

**Blocked by:** 73

**Status:** done

**验收：**
- [ ] 轮次级三闸各自触发测试绿（超步/超时/超 token 各一例）
- [ ] max_rounds 超顶强杀，审计 + error 事件 + SSE 可见
- [ ] 相邻轮同指纹组合被掐（防转断言），gap 差异化重选豁免成立
- [ ] 旧 kind（alert_flow 等）预算行为零回归（全量测试绿）
- [ ] token 累计跨轮/resume 连续，cost CSV 口径可续

**实现记录：**（2026-09-12 落，自主档 TDD）

**产物**
- `services/agent/src/budget.ts`（唯一 m3 计费口径扩展）：BudgetKind 增量扩 `round_max_steps/round_token_budget/round_timeout/rounds/parent_cancelled`（既有三闸语义逐字节不动）；`RoundBudget`（轮级三闸，触发 kind 带 round_ 前缀，强杀同走 BudgetExceededError 一条路）；`BUDGET_TIERS` + `budgetForKind(kind)`（hunt_flow run 档 900s/200 步/500k、轮档 120s/10 步/30k，env `<KIND>_MAX_STEPS/_MAX_TOKENS_PER_RUN/_LLM_TIMEOUT_MS` 可覆写、轮级加 `_ROUND` 段；不在表内的 kind——alert_flow 等旧 kind 与 hunt_task——恒默认档 60s/20 步/50k，零回归）；`assertRoundsBudget`（max_rounds 硬顶，kind=rounds）。
- `services/agent/src/orchestration/cancel.ts`（新增，m14 取消信号机制）：CancelBoard（首写 wins，INV-10 进程内半边）+ makeLoopCancel（订阅轮次 run 的预算强杀 error 事件 → requestCancel：m2 PATCH 写半边落 cancelled（原因 budget/time/budget_rounds 映射）+ hunt_cancel 五要素审计）+ throwIfCancelled（节点包装层逐节点前检查的唯一实现，抛 BudgetExceededError(parent_cancelled) 借 runner 既有强杀路径——禁第二套强杀）。无定时器无轮询（T19 同纪律）。
- `services/agent/src/orchestration/flow.ts`：六节点统一节点包装层（取消检查 → 轮步 → 轮时墙钟（注入钟）→ charge 转记轮 token，run 级闸先抛/轮级后抛可区分）；intake 落 max_rounds 硬顶（超顶轮在 hunting 前置前即拒）+ prev_fingerprint 重算（m2 轮次归集为真相源）；dispatch 落防转拒组合（hunt_round_spin_denied DENIED + cancelled(spin)）；outcome 落防转空轮归集；outcome 侧 max_rounds 卡撤除（硬顶统一由 intake 的 rounds 预算闸拒，强杀/取消/审计同一套口径）。
- `services/agent/src/orchestration/task-flow.ts`：子 run 四节点过取消检查包装层。
- `services/agent/src/orchestration/llm-stubs.ts`/`planner.ts`：tasks_fingerprint 升格为防转指纹 spinFingerprint = hash(排序后任务集 + gap 摘要)——gap hash 在指纹内即表达差异化豁免。
- `services/agent/src/orchestration/ports.ts`：OrchestrationDeps 增量可选缝 cancel/roundBudget/now（缺省 = 机制默认档，73 既有装配零改动）。
- `services/agent/src/autorun.ts`（L0 裁决②）：第三分支 hypothesis.cancelled → cancelHypothesis 缝（AutorunDeps 可选成员，index.ts 生产装配）→ res.cancelled/cancel_dup 新增。
- `services/case-backend/src/hypotheses.ts`（L0 裁决②）：cancelHypothesis 同事务 emit `hypothesis.cancelled`（73 created 先例镜像；emitEvent 为 store 既有内部件，公开面零变更）。
- `services/agent/src/app.ts`（m3 接线一处）：dispatcher 的 start/resume 执行参数加 `budget: budgetForKind(run.kind).run`（旧 kind 返回与 budgetFromEnv 等价实例，语义零变化）。
- `services/agent/src/index.ts`（装配）：makeLoopCancel 挂 loopBus，onClose 随手撤。
- 测试：`orchestration/budget.test.ts`（档位/零回归单测 + T18 dual_gate_triggers 五例）、`orchestration/loop.test.ts`（新增：T06 spin_guard 两例 / T09 rounds_exhausted / T10 user_cancel_children 两例）。

**验收证据（票面五条）**
- 轮次级三闸各自触发：budget.test.ts::dual_gate_triggers ①轮步（round_max_steps，3 步小档）②轮 token（round_token_budget）③轮时（round_timeout，注入钟）④run 总 token（既有 token_budget，run 级闸语义不动）全绿；+ cancelled(budget) + kill FAILURE 审计 + SSE error 事件逐例断言。
- max_rounds 超顶：loop.test.ts::rounds_exhausted——20 轮跑满后第 21 轮 intake 被 rounds 闸拒，run failed(budget_exceeded:rounds) + kill FAILURE 审计 + error 事件（SSE 可见），假设 cancelled(budget_rounds)，不冒充 refuted。
- 防转：loop.test.ts::spin_guard——固定组合 + 恒定 gap → 第 3 轮 dispatch 拒组合（无子 run 无接力）+ cancelled(spin) + DENIED 审计（max_repeat=1）；豁免例：gap 随证据演化 → 指纹不同 → 正常收敛 concluded。
- 旧 kind 零回归：全量 `pnpm test` 绿（agent 62 文件 620 通过 + 3 skip 不变；evals/case-backend/ingest/web/mcp-audit/gateway 全绿）；budget.test 保留原六例逐字节未动。
- 计费连续性：T09 断言每轮 run.steps=6/tokensUsed=72（planner24+judge24+gap24）、子 run 8 tok/4 步——跨轮独立记账、run 行口径与既有 saveProgress/resumeRun 接续一致，cost CSV（每假设一行、轮次明细内嵌）数字可续。

**档位首跑回测（fake LLM，spec 风险②对账）**：never-converge 20 轮最坏形态：run 级父链累计 120 步/1440 tok/153ms（占顶 60.0%/0.288%/0.017%）；轮级均值 5.7 步/69 tok/7.3ms（占顶 57.1%/0.229%/0.006%）；两轮收敛场景 run 级 12 步/120 tok（占 6%）。结论：**步数维度最坏用量占顶 ~60%（200 步档 = 20 轮 × 6 节点 + 40% 余量，档位与结构消耗匹配，不调档）；token/耗时两维在 fake 桩下不可代表真 LLM（桩 24 tok/次、零延迟），无超顶无 >20% 偏差信号，待票 78/79 真执行体落地后需真 LLM 复测一轮再定**。

**JUDGE_CONFIDENCE_FLOOR 复核**：judge.ts 地板 0.7（env 可调）与本票档位并读——低置信降级会多耗轮次，消耗由轮级闸 + max_rounds 硬顶 + 防转三道兜底封顶（最坏 20 轮 × 72 tok 桩形/轮），无互相打架；缺省 0.7 不改。

**记入偏差（如实）**
1. fail_reason 形态：parent_cancelled 借 BudgetExceededError 既有口径，落 `budget_exceeded:parent_cancelled`（审计/事件 details.kind=parent_cancelled 可查）——不是裸字符串，为守住「禁第二套强杀实现」。
2. 人取消的生产接续（L0 裁决② 2026-09-13 补全，改动面两处照授权执行）：① case-backend `hypotheses.ts` cancelHypothesis 在取消落账同一事务 emit `hypothesis.cancelled` {hypothesisId, reason}（照 73 hypothesis.created 同事务先例；状态机/端点签名零变更，409 终态语义不变）；② `autorun.ts` 解禁第三分支——防重（同批去重 dup_batch + 信号板首写 wins 重放 cancel_dup 幂等跳过）→ m14 requestCancel 唯一入口（requestCancel 对上游已 cancelled 账面免重 PATCH，409 原样上抛契约不动；reason 并集扩 m2 四因，源头已闸）→ 失败不动游标 at-least-once。生产接线 index.ts cancelHypothesis = loopCancel.requestCancel。
3. 预先存在（非本票引入）4 处 lint unused 报错在 autorun-hunt.test.ts（本票顺手清偿）/judge.test.ts/prompt-guard.test.ts/case-backend app.ts，其余未越界代清。

**L0 裁决②补全的契约测试**
- m2 侧（case-backend hypotheses.test.ts）：取消 200 与 outbox `hypothesis.cancelled` {hypothesisId, reason:user_cancelled} 恰一行同事务；终态重取消 409 不发第二事件。
- agent 侧（autorun-hunt.test.ts，全真件：真 m2 子进程 + 真 HttpOutboxReader + 真 m2 REST 假设面）：POST /hypotheses → autorun 拉起轮 1（intake 真迁移 hunting）→ 父 run 挂 await_children、子 run 停测试栅栏 → POST :id/cancel（真端点 200）→ pollAutorunOnce 消费 hypothesis.cancelled（res.cancelled=[hyp]）→ 放行栅栏 → 父/子 run 全链 failed(parent_cancelled)、子 run 零 tool_call（未干的活不干）、hunt_cancel + kill FAILURE 审计齐（INV-8）、m2 账面仍 cancelled(user_cancelled) 不被停止链二次扰动（INV-10）；重放幂等：created 分支 round_exists 挡（闸② 簿记锚，run 已 failed 故闸① 放行——73 两道闸语义）+ cancelled 分支 cancel_dup 挡，无新 run。
- **L0 验收（主窗口，2026-09-13 补线后）**：亲跑双闸 PASS + agent 621 passed|3 skip + case-backend 76 passed 只增；cancel 生产链闭合核实（同事务 hypothesis.cancelled 事件 + autorun 第三分支 + 全真件 T10 生产路径契约测试 + created/cancelled 双重放幂等）；偏差①（fail_reason=budget_exceeded:parent_cancelled 借既有强杀口径）**接受**——正合"禁第二套强杀"铁律。收尾五样齐（预算分档事实已在 m14 卡预算约束备注，无新增同步）。**挂账（阶段 E 收口核对）**：预算档位 token/耗时两维系 fake 桩读数不可代表真 LLM，78/79 真执行体落地后复测回测偏差>20% 记票调档。