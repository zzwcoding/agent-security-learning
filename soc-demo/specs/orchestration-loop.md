# 编排循环（orchestration-loop）

状态: 已定稿
来源: PRD §13（假设驱动编排循环，v1.2）；ADR 0005；modules.md m14 卡

## 目标

让分析师提出假设（hypothesis）后，系统以轮次机器自动验证或证伪：planner 从能力菜单选组合 → 扇出子 run 并行取证 → judge 裁决证据充分性 → gap 翻译缺口 → 换组合再一轮，直到收敛；收敛结论可查可溯（命中建案 / 未命中归档）。同一套机制经业务模板复用到多块业务（首发：狩猎；验收件：应急取证）。

## 不做什么

- 不改旧链（alert_flow 等既有 kind 保持静态查表，行为零变更）
- 循环不自动执行 L2 动作——遏制类只出文本建议，动作永远走人工审批回路（INV-3）
- 不支持并发多假设（一次一个，查完再提）
- planner 不许选能力菜单外工具、不许创造工具参数面外的动作
- weknora 未就绪不阻塞：playbook/graph 工具以 Memory stub 先行（票 79），对接归票 83
- 本 spec 不含 Web 页实现（归票 82）与教学场景（归票 84-89）

## 触及的模块

| 模块 | 改动类型 | 说明 |
|---|---|---|
| m14 | 新增 | 编排循环机制（planner/judge/gap 节点、轮次链、fanout/await、防转、预算簿记） |
| m3 | 改实现 | run-kinds 注册 hunt_flow/hunt_task；makeNodes 分支；子 run 取消信号的节点包装层检查 |
| m9 | 改实现 | 两票铸票：父票（planner 面）+ dispatch 逐任务 narrow-scope 子票（铸票唯一通道，R11） |
| m2 | 改接口 | hypothesis 第七实体（五态状态机、CRUD 读面、取消端点、轮次归集段）+ Case.hypothesis_id |
| m5 | 改实现 | 子 run 复用 plan/decide 循环；SIEM 四新维度工具（票 78）；hunt 版 prompt 为内容层 |

> 接口真源在 modules.md 各卡；本节只做本功能视角的引用与细化，两处不一致以卡为准。

## 接口定义

**m2 新增（假设实体）**：
- `POST /api/v1/hypotheses {template_id, text, actor}` → 201 {hypothesis_id}；置 proposed；outbox 拉起 hunt_flow
- `POST /api/v1/hypotheses/:id/cancel`（发起人，hunting 态）→ 200；hunting→cancelled（INV-10）
- `GET /api/v1/hypotheses?status=` / `GET /api/v1/hypotheses/:id`（详情含轮次归集：每轮 {round_no, tasks[], children[{run_id,status}], judge, gap}）
- Case 新增 `hypothesis_id` 可空字段（命中建案时回填）

**m14 内部契约（node 间，走 m3 信封状态）**：
- planner 输入 `{hypothesis_text, evidence_so_far[], gap|null, menu[], template{max_rounds, max_tasks}}`，输出 `{tasks:[{tool,params,rationale}]}`（1..max_tasks）
- judge 输入 `{hypothesis_text, round_reports[{task,result_summary,params_hash}]}`，输出 `{sufficient, verdict:hit|miss|null, confidence, gap_description|null}`
- gap 输入 `{judge_output, evidence_so_far}`，输出 `{gap_description}`（`{unknown, suggested_focus[]}`）
- 防转指纹 = hash(排序后任务集 + gap 摘要)；相邻轮指纹相同即拒

**票务（m9）**：
- 父票：hunt_flow 拉起时铸，allowed_tools = planner 只读面（playbook_lookup/graph_query/kb 类），TTL 900s
- 子票：dispatch 逐任务铸，allowed_tools = {该任务唯一工具}，TTL 900s；**铸票唯一通道**（INV-11 静态半边，R11）

**预算档位（按 kind 分档，ADR 0005 遗留收口）**：
- hunt_task（子 run）：60s / 20 步 / 50k token（沿用默认档）
- hunt_flow run 级：900s / 200 步 / 500k token
- hunt_flow 轮级：120s / 10 步 / 30k token；max_rounds=20；单轮 ≤2 子任务；防转 max_repeat=1
- 档位实现走 budgetFromEnv 分档（env 可覆写）；定稿数字随票 77 首跑回测压测四天花板，偏差>20% 记票调档

## 行为约定

1. 假设提交即置 proposed 并拉起 hunt_flow；hunt_flow 首轮开始前置 hunting（同一事务口径，INV-10）。
2. 轮次链节点序固定：intake→planner→dispatch→await_children→judge→outcome；每节点 node_enter/exit 事件与既有 run 同口径（INV-7/8）。
3. planner 输出 schema 校验失败 → 重试 1 次（同一输入重放不算步数额外计？算，计入口径）→ 仍败则本轮终止（fail-closed），落审计 DENIED，run 不杀；连续两轮 planner 失败 → 假设 cancelled（原因 planner_broken）。
4. planner 选到菜单外工具 → 不 retry，直接本轮终止 + DENIED 审计（菜单外无重试价值）。
5. planner/judge/gap 的全部输入（假设文本=用户输入、子报告=上游 LLM 产物、gap=LLM 产物）进 prompt 前过 guards 注入扫描；block 一律占位符，原文不进 prompt。
6. dispatch 按 planner 组合逐任务铸子票并拉起 hunt_task 子 run（独立 run 行，parent_run_id+round 簿记）；铸票失败 → 该任务不执行、无悬置、落审计（fail-closed）。
7. await_children 只经事件唤醒（子 run 终态事件），全仓禁轮询。
8. judge 只引用子报告（params_hash 引用痕），不改写子报告内容；结论落假设详情轮次归集。
9. 收敛分岔：judge sufficient+hit → hypothesis concluded + 建 Case（挂 hypothesis_id，复用建案路径）；sufficient+miss → refuted + note 型 TimelineEntry + hypothesis_register（入图一律 proposed 态）；不充分且轮次未达上限 → gap → 下一轮。
10. 防转：相邻两轮指纹相同（含 gap 摘要）→ 拒组合、假设 cancelled（原因 spin）。gap 摘要实质变化（新证据改写缺口）豁免——指纹含 gap hash 即表达。
11. 预算/超时触发（轮级或 run 级）→ 进行中的子 run 收到取消信号（节点包装层逐节点前检查），未起的不再起；假设 cancelled（原因 budget/time）；子 run 自身状态落 failed + reason=parent_cancelled。**cancelled 不冒充 refuted**。
12. 人取消（hunting 态发起人或 duty_lead）→ 同 11 的停止语义，原因 user_cancelled；终态不可回退（INV-10），可重新发起新假设。
13. hypothesis_register 为 L1 写工具：走验票闸、五要素审计（INV-8）；stub 期写本地图 store 标 proposed；graph_query 只回 approved 态关系（INV-5 口径，人审通道票 83 对接期定端点）。
14. 全链路 token/步数/耗时落成本 CSV 同口径（每假设一行，轮次明细内嵌）。
15. hunt_flow 全链路 grep 不到 SECRETS_ 值（INV-4 金丝雀断言延伸到 planner/judge prompt 与审计 details）。

## 验收测试

| 验收标准 | 对应测试 |
|---|---|
| 发起假设 → hypothesis proposed → hunt_flow queued→running → hunting（T01，`INV-10`） | `services/agent/src/orchestration/flow.test.ts::hunt_flow_start_transitions` |
| 轮次链六节点事件序列与既有 run 口径一致；outbox 轮次接力幂等（重放不重复起 round，`INV-6` 同族）；SSE 事件自增 id 可补发（T02，`INV-7`） | `services/agent/src/orchestration/flow.test.ts::round_chain_event_order` |
| planner 输出超 2 任务 → 截断 + 审计，不拒整轮（T03） | `services/agent/src/orchestration/planner.test.ts::task_cap_truncates` |
| 菜单外工具选择 → 本轮终止 + DENIED 审计（T04，`INV-11`、`INV-3`） | `services/agent/src/orchestration/planner.test.ts::offmenu_rejected` |
| schema 坏输出 → 重试一次 → 再败本轮终止 run 不死（T05） | `services/agent/src/orchestration/planner.test.ts::schema_degrade` |
| 相邻轮同指纹组合被拒，假设 cancelled(spin)（T06） | `services/agent/src/orchestration/loop.test.ts::spin_guard` |
| sufficient+hit → 建 Case 挂 hypothesis_id，假设 concluded；遏制建议文本无签名 ApprovalToken 即无效（T07，`INV-9`） | `services/agent/src/orchestration/judge.test.ts::hit_creates_case` |
| sufficient+miss → refuted + note TimelineEntry + register(proposed)（T08） | `services/agent/src/orchestration/judge.test.ts::miss_archives` |
| 20 轮未收敛 → cancelled(budget_rounds)（T09） | `services/agent/src/orchestration/loop.test.ts::rounds_exhausted` |
| hunting 取消 → 子任务停/不起，子 run failed(parent_cancelled)（T10） | `services/agent/src/orchestration/loop.test.ts::user_cancel_children` |
| 父票铸于 run 起（planner 只读面），子票铸于 dispatch（每任务单工具）（T11/T12） | `services/agent/src/orchestration/ticketing.test.ts::two_tier_mint_timing` |
| 子票 scope ⊆ 父菜单 + 票面外工具 100% 403 遍历矩阵；TTL 过期票重放必拒（T13/T14，`INV-11`、`INV-2`、`INV-3`） | `evals/src/rigs/hunting.ts::inv11_matrix` |
| 铸票失败 → 任务不执行无悬置 + DENIED 审计（T15，`INV-1`、`INV-8`） | `services/agent/src/orchestration/ticketing.test.ts::mint_failure_fail_closed` |
| 毒报告进 planner/judge/gap prompt 前被 guards 拦截/清洗；全链路金丝雀 grep 不到凭证（T16，`INV-4`） | `services/agent/src/orchestration/prompt-guard.test.ts::poisoned_report_scanned` |
| judge 不改写子报告（hash 前后一致）（T17） | `services/agent/src/orchestration/judge.test.ts::no_rewrite` |
| 预算双闸四触发（轮步/轮 token/轮时/run 总 token）→ cancelled + 审计 + SSE（T18） | `services/agent/src/orchestration/budget.test.ts::dual_gate_triggers` |
| await_children 事件唤醒、全仓无轮询实现（T19） | `services/agent/src/orchestration/await.test.ts::event_wakeup_no_polling` |
| 应急取证模板落地 diff 不触 m14 目录（零增量验收）（T20） | `tools/check_zero_increment.py` |
| hypothesis 状态机外变更 409（INV-10）（T21） | `services/case-backend/src/hypotheses.test.ts::illegal_transition_409` |
| register 只写 proposed / graph_query 只回 approved（T22，`INV-5`） | `services/agent/src/orchestration/graph-stub.test.ts::proposed_only_unlisted` |
| 紫队：attack fixture→假设→发现判定走 ground truth 断言（不靠 LLM 自评）（T23） | `evals/src/rigs/purple.ts::discovery_rate_ground_truth` |

## 依赖与风险

- 依赖：m3 run 机器/outbox/事件总线（既有件）；m9 mint 面（既有）；guards 扫描面（既有）；票 78 四 SIEM 维度工具；票 79 模板与 stub；m2 hypothesis 实体（票 73 同期）。
- 风险：① await_children 事件唤醒若误用轮询会拖 SSE 实时性——T19 静态断言防；② 20 轮 × 2 任务最坏 40 子 run，hunt_flow run 级 500k token 是估算档——票 77 首跑对账压测四天花板；③ judge 证据充分性判据是 LLM 判断——T23 用 ground truth 兜底演示口径，judge 不进门槛（决策 #10 沿用）。
