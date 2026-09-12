# 73-orchestration-loop-skeleton: m14 机制骨架——轮次链 + fanout/await + 接线（P1）

**What to build:** 编排循环的运行骨架。⓪ **m2 假设实体（L0 补记 2026-09-13：spec 触及模块表"m2 改接口"与 ADR 0005 页面映射均把两条新查询面标给本票，原文漏写——按既定指派并入，非范围扩张）**：case-backend 新增 hypothesis 第七实体（五态状态机 proposed→hunting→concluded/refuted/cancelled，INV-10 全守住）+ 三端点（POST /api/v1/hypotheses 置 proposed 且 outbox 拉起 hunt_flow / POST :id/cancel（发起人+hunting 态）/ GET 列表?status= 与详情含轮次归集段）+ Case.hypothesis_id 可空列；① `services/agent` 新增循环模块目录（m14 领地）：round 链六节点 intake→planner→dispatch→await_children→judge→outcome（FlowNode 形态，走 graph.ts 现有节点包装——**compileFlowGraph 串行链模型不动**，循环性靠 dispatcher 层"round k outcome 发事件拉起 round k+1"表达，父子 run 关联簿记入 run 行）；② `fanout_dispatch`：按 planner 组合拉起 N 个子 run（独立 run 行、记录 parent_run_id + round），子 run 复用 investigation worker 的 plan/decide 循环（hunt 版 prompt 模板为票 79 内容，本票用最小桩；planner/judge/gap 本票用确定性最小桩，74/75 换真）；③ `await_children`：跨 run 等待——订阅事件总线（子 run 终态事件唤醒），**禁轮询**；④ 接线：`run-kinds.ts` 注册 hunt_flow/hunt_task 新 kind、`index.ts` makeNodes 分支、审计五要素（INV-8）与 SSE 事件（node_enter/exit 与现有口径一致）。两票票务归 76（本票 dispatch 用现有铸票口径拉起子 run）、预算分档归 77（本票跑默认档）——不欠不越。

**铁律:** 框架红线——@langchain/langgraph 真用（节点包装/检查点走现有 compileFlowGraph 机制），禁手写替代；禁改 compileFlowGraph 拓扑模型（串行链 + dispatcher 循环是已定案形态，改动 = 回阶段 2）；边界红线——只许新建 m14 目录 + 改 run-kinds/index 接线，survey/直引他模块内部文件禁止（adapters 经公开接口注入）。

**Touches modules:** `m14`、`m3`、`m2`

**Belongs to spec:** specs/orchestration-loop.md（验收条目行号票 72 收口时回填）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T01/T02/T19/T21（spec 已定稿 2026-09-12）

**Blocked by:** 72

**Status:** done（2026-09-13 子 agent 施工+主窗口验收：m14 骨架+m2 假设实体落地，T01/T02/T19/T21 全绿；L0 三裁决落实——autorun 分支补线/parksOnEvents 分发放行追认/link 表与 case_id 承载备案）

**验收：**
- [x] round 链六节点契约测试绿——flow.test 两轮轨迹绿（C2≠C1→concluded）（fake LLM 下跑通两轮：C2≠C1 或收敛单轮）
- [x] fanout 子 run 为独立 run 行——hunt_run_links+runs 双面可查，SSE 自增 id 回放，parent/round 簿记可查，SSE 全程可回放
- [x] await_children 事件唤醒实现——LoopEventBus 唤醒，目录无定时器，T19 静态+动态断言，全仓无轮询实现（review 可查）
- [x] run-kinds 注册 + makeNodes 接线——七 kind 快照口径更新，旧 kind 零回归（全量绿），旧 kind 行为零回归
- [x] 审计五要素齐全——五要素+失败强杀同既有口径（INV-1）（INV-8），失败强杀口径与现有 run 一致（INV-1）

**实现记录：**（2026-09-12，L2 自主档）
- m2（⓪）：`services/case-backend` 新增 `hypotheses.ts`（第七实体：五态状态机接 statemachine、取消四因枚举 user_cancelled/planner_broken/spin/budget、发起人）+ `hypotheses.test.ts`（T21 `illegal_transition_409` 等 11 例）；db.ts 增 hypotheses / hypothesis_rounds 表 + cases.hypothesis_id 可空列（migrate 补列）；app.ts 增 POST /api/v1/hypotheses（proposed + outbox hypothesis.created 同事务）、POST :id/cancel（发起人 403 / 状态机 409）、GET 列表?status= 与详情含轮次归集段、PATCH :id（循环驱动迁移的写半边，表外 409）、POST :id/rounds（(hyp,round_no) 幂等）。
- m14（①②③）：`services/agent/src/orchestration/`（ports/template/bus/ledger/await-children/launcher/relay/llm-stubs/hypothesis-port/flow/task-flow）——轮次链六节点 FlowNode 走 graph.ts 既有节点包装（compileFlowGraph 未动）；await_children 只经 LoopEventBus（events.ts eventTap 扇出喂入）事件唤醒，全目录无定时器（T19 静态+动态断言）；轮次接力 startRoundRelay（ledger.findByRound 幂等锚，重放不起重复轮，T02）；planner/judge/gap 确定性桩（两轮 C2≠C1，T01/T02 全绿）。
- m3（④）：run-kinds.ts 注册 hunt_flow/hunt_task（intake=case，hypothesis_id 走 case_id 位承载——不扩 runs schema；pipelineNodes 缺省=动态发现，不动 fixtures 契约锁；票面=既有 L0 只读件，无 L2）+ RunKindGraphDeps.orchestration 注入缝；index.ts 装配 tap 扇出/SqliteHuntLedger/HttpHypothesisPort/door(app.inject 正门)/relay。run-kinds.test 快照按其自带口径更新为七 kind；全量 574 例绿（旧 kind 零回归）。
- 偏差记票（L0 备案）：① m2 outbox hypothesis.created → hunt_flow 的 autorun 消费支线未接（autorun.ts 在本票禁改清单）——round 1 经 m3 标准入口拉起，支线归 74/75 接线；② 父子簿记未入 runs 行（同①禁改清单），落 agent 侧 hunt_run_links 表 + m2 轮次归集 children[{run_id,status}] 双面可查；③ POST /internal/runs {kind:hunt_flow, hypothesis_id} 以 case_id 位承载（①的同源最小落法）。
- L0 派发中裁决落实（2026-09-13）：① **autorun.ts 增 hypothesis.created 唯一解禁分支**（该文件除此外一字不动）——防重两道闸缺一不可（闸① runs 表 hunt kind 查重 runsLookup 口径 / 闸② hunt_run_links.findByRound 轮锚），launch 经 HuntLauncher.launchRound（RunDoor 正门 + 簿记锚落账），失败不动游标 at-least-once；契约测试 `src/autorun-hunt.test.ts`（真 case-backend 子进程全环路：POST /api/v1/hypotheses → 真 HttpOutboxReader 消费 → hunt_flow queued→running → **真 m2 REST proposed→hunting 迁移** → outcome 真落轮次归集；游标丢失重放=run_exists、failed 放行后=round_exists，两闸分咬即「缺一不可」）。随附**受控补丁待 L0 追认**：run-dispatcher.ts 的 startRunDispatcher 对注册表 `parksOnEvents` 标记的 run「领了就放」——await_children 挂起的父 run 不放行会顶死串行分发循环、扇出子 run 永远领不到任务（生产死锁，probe 实证）；dispatchOnce 契约与既有分发测试零改动，非状态机/非 m3 公开接口；run-kinds.ts 的 RunKindDescriptor 增 parksOnEvents 格（仅 hunt_flow=true，注册表单点声明）。② hunt_run_links 簿记口径与 ③ case_id 位承载（阶段 E 体检候选）已同步进 specs/modules.md m14 卡「备注」节。

**L0 派发中裁决（2026-09-13，对上列三偏差）：**
- ① **不采纳"归 74/75"，授权本票补线**：spec 行为约定 1 与 T01 的生产路径 = POST /hypotheses → autorun 消费 hypothesis.created → hunt_flow 拉起——这是骨架接线不是 LLM 节点事。autorun.ts 解禁一个 topic 分支（照 alert.created 先例：防重两道闸、经 RunDoor 拉起、失败不动游标 at-least-once），并补"POST /hypotheses → autorun tick → hunt_flow queued→running → proposed→hunting"契约测试。autorun.ts 改动面仅此一个分支。
- ② **接受**：hunt_run_links 簿记（不扩共享 runs schema）成立；modules.md m14 卡备注须同步此簿记口径（与 m2 hypothesis_rounds 双面同源）。
- ③ **受控接受+挂账**：hypothesis_id 经 runs.case_id 位承载记入 m14 卡备注；**列阶段 E 体检候选**（专用列/语义正名将由体检裁决）。
- **L0 验收（主窗口，2026-09-13 补线后）**：追认 parksOnEvents 受控补丁（串行分发被挂起 execute 顶死的生产死锁，probe 实证；diff 逐行审——仅 hunt_flow 标记、dispatchOnce 契约不动、失败/孤儿走既有件）；亲跑双闸 PASS + 全量 pnpm test 两遍：首跑 evals 1 例 flake（负载下时序敏感，单跑与全量复跑均绿，**flake 观察挂账阶段 E**）、复跑 EXIT=0 全绿（agent 573+3skip、case-backend 74、evals 99、web 111、mcp-audit 14、ingest 44+1skip——只增不减）。收尾五样：spec 无出入（orchestration-loop.md 行为约定 1/2/6/7 全兑现）/ modules.md 已同步（m14 卡两行 L0 核过 + m3 卡分发放行行 L0 补）/ CONTEXT 无新术语（编排循环族已存）/ 施工日志=本记录+裁决节 / 架构投影=m14 无 HTML 投影（ADR 0005 冻结源 JSON 口径，源 JSON 本就含 m14 组件，无出入）。