# 77-round-level-budget: 预算双闸——run 级 + 轮次级 + 轮次防转（P1）

**What to build:** 把现有 budget 三闸（60s/20 步/50k token，run 级）提升到双层级。① 轮次级闸：每轮独立计步/计时/token（防 planner 拆 1 条任务耗光父 run 预算的偏科场景）；② max_rounds 硬顶（默认值 spec 定，超顶强杀 failed，口径与现有 BudgetExceededError 一致——审计 + error 事件 + Web 可见）；③ 轮次级防转指纹：把 investigation worker 的"同参数重复调用报错"缰绳提升到轮次级——planner 在相邻两轮选出同一组合（同指纹）即判空转，max_repeat=1（允许证据变化后的重选由 gap 输入差异豁免，指纹含 gap 摘要 hash）；④ 计费连续性：resume/跨轮 token 累计口径与现有 run.steps/tokensUsed 一致（压测报告的四天花板数字不回退）。验收条目逐条源自 spec（票 72 回填行号）。

**铁律:** 预算闸是资源兜底不是业务逻辑——触发即强杀，不得"降级继续"；边界红线——只许扩展 budget.ts 计费口径与 m14 轮次簿记，既有 run 级闸语义不动（旧 kind 零回归）。

**Touches modules:** `m14`、`m3`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T06/T09/T18（spec 已定稿 2026-09-12）

**Blocked by:** 73

**Status:** blocked

**验收：**
- [ ] 轮次级三闸各自触发测试绿（超步/超时/超 token 各一例）
- [ ] max_rounds 超顶强杀，审计 + error 事件 + SSE 可见
- [ ] 相邻轮同指纹组合被掐（防转断言），gap 差异化重选豁免成立
- [ ] 旧 kind（alert_flow 等）预算行为零回归（全量测试绿）
- [ ] token 累计跨轮/resume 连续，cost CSV 口径可续

**实现记录：**（待填）
