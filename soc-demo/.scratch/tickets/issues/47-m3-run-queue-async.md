# 47-m3-run-queue-async: run 异步化：queued 队列 + 消费循环 + 审批卡保质期（ADR 0004-1）

**What to build:** POST /internal/runs 落 queued 即 202 返回（不再同步跑完才返回）；agent 后台消费循环（autorun 同款）捡 queued→running→执行；approve 后 resume 同队列；APPROVAL_TTL_SECONDS 到期的 pending 审批卡自动作废（审批状态机加 pending→expired）→ run 落 failed（reason=approval_expired）+ 审计；并发上限 env 可配（默认 1）。队列 = runs 表 queued 状态 + 消费循环，不引入新消息中间件产品（ADR 0004-1）。

**Blocked by:** （ADR 0004 已落）

**Touches modules:** `m3`, `m4`, `m8`, `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] POST /internal/runs 秒回 202 {run_id, status:queued}；SSE 订阅同一 run 能看到 queued→running→completed 真流（源：CONTEXT.md run 状态机 queued 态·ADR 0004-1）
- [x] 消费循环捡起/并发上限/进程重启后续跑（queued 不丢）（源：m3 卡 checkpointer 语义）
- [x] 审批卡保质期：过期自动作废→run failed+审计；过期卡上批准 409；未过期链路行为不变（源：遗留标记 11-2·ADR 0004-1）
- [x] approve→resume 走队列（批准秒回，执行异步），既有审批五验收语义保持（源：票 11 回归）
- [x] evals 33 用例与 web 页面在异步形态下全绿（等待终态 helper/页面复核；web SSE 已按补发形态设计改动应很小）（源：票 18 出入①翻转）
- [x] 异步化后 INV-1/2/3/8 全部回归绿（源：CONTEXT.md）

## 实现落点（票内记档）

- 新模块 `services/agent/src/run-dispatcher.ts`：run_jobs 队列原语（入队/FIFO 领取/完结、resume 去重）、dispatchOnce（先扫审批保质期再领任务）、startRunDispatcher（常驻循环 + 开工前重启恢复 + stop 优雅停机）、recoverDispatcherState、RUN_DISPATCH/APPROVAL_TTL_SECONDS env 解析。autorun（票 40）原样独立，两个循环互不掺和。
- 队列 = agent 自持 SQLite 的 `run_jobs` 表（db.ts 新 DDL），不是 runs.status 单打：resume 诉求没法用 run 状态表达（awaiting_approval→queued 不是合法迁移，CONTEXT.md 状态机一字未动），start/resume 统一落表；runs.status='queued' 仍是 run 自己的生命周期态、响应体里的 status 即它。
- app.ts：POST /internal/runs（非 chat）落 queued 即 202 {run_id, status}；铸任务票+组图+executeRun 整体挪进分发循环执行件（executeStartJob）；approve/reject 落决定即入 resume 队列秒回（executeResumeJob 执行时按票 17 重组图）；/events/stream 补发后进入实时推送（轮询同一张落盘总线），run 终态才收流；buildApp 内建 dispatcher 生命周期（onClose 优雅停机），`dispatcher:false` 可关（测试的确定性时刻）。
- 审批卡保质期：statemachine.ts 审批状态机加 pending→expired（expired 吸收态）；approvals.ts 增 expireApprovalCard（一个事务：卡 expired + 审计 expire + approval_decided 广播 + run 先转 running 再 failed(approval_expired)——awaiting_approval→failed 不是合法迁移，两步都是）+ listExpiredPendingApprovals。
- 测试工具：`services/agent/src/testkit.ts` 新增 waitForRunStatus / waitForRunTerminal（轮询 runs 表），m3 侧测试与 evals rig 共用。
- web：ApprovalStatusWire 加 "expired"、statusTag 加「已过期」文案（api.ts/approvals.ts/approvals.test.ts 三处小改）。页面其余零改动——SSE 补发+实时推送后，PipelinePage/AlertsPage 的"订阅等终态"形态自动成立。

## 记票定夺（票面留白处）

1. **孤儿 running 的重启口径**：recoverDispatcherState 把「进程被杀时正在跑」的 run 判 failed(reason=orphaned_by_restart) + 强杀审计 + error 事件，**不**重置 queued 重跑——重跑会让图从头重放节点，M2 时间线/审计重复留痕；failed 在 autorun 防重口径里本就允许事件重拉（自动补跑），人工场景也能从 Web 直接看到失败原因。
2. **chat 保持同步**（票面点名的待决项）：POST /api/v1/chat 与 /internal/runs 的 chat_flow 支线都不走队列——chat 的 SSE 应答流本身就是产品（m8 卡「流式回答」），改成"先 202 再另开流听"会毁对话体验；且 message/role 交接态不在 run 行里，入队要扩 schema。m8 全部测试零改动通过。
3. **resume 去重**：同一 run 已有未完结的 resume 任务时复用不重发——陈旧双批决定不叠加执行。
4. **毒丸不重试**：任务执行抛错按完结处理（记 failed 日志），循环不崩也不无限重试；重试语义归 autorun 的事件防重口径管。
5. **并发上限/保质期 env**：RUN_DISPATCH 缺省 1、非正整数回 1；APPROVAL_TTL_SECONDS 缺省 86400、非有限正数回缺省（fail-closed 不猜）。

## 时序契约变更清单（本票有意翻转「POST 返回时已终态」，逐条列出）

既有断言零删除零放松；以下只把「返回时刻即终态」改成「返回 queued + 等终态后断言」，断言本体不变：

1. app.test.ts「POST /internal/runs {kind, alert_id} → 202」：`已跑完` → 响应体断言 status:queued + 落库 queued，waitForRunTerminal 后仍断言 completed（行内容不变）。
2. app.test.ts 票 34 四用例：approve 响应的 run_status 断言 completed/failed → 改断言 awaiting_approval（秒回时刻的真值）+ waitForRunTerminal 后用库面 status 断言 completed/failed；executions/DENIED 审计断言全部后移到等完之后，逐字保留。
3. approval-loop.test.ts（票 11 审批五验收）：startRun 助手加「等 awaiting_approval」（挂起态不再在 POST 返回时成立）；验收1 run_status completed → 等终态后断言；换参数用例 run_status awaiting_approval → 等新卡开出后断言（断言更准了： resume 真跑过）；驳回/重启/409/铸票失败/token_expired 各用例同理——五验收语义条条保持。
4. case-flow.test.ts 三用例：POST 后立即断言 runRow/timeline → waitForRunTerminal 后断言（断言本体不变）。
5. autorun.test.ts 票 40 集成两用例：launch 后立即断言 completed → waitForRunTerminal 后断言；补 app.close()（buildApp 现在带循环，测试要收干净）。
6. workers/triage/flow.test.ts：makeNodes 路径等终态后断言铸票与写回；「铸票失败 502」是**同步铸票行为的伴生断言**，随铸票挪进循环一并改写——202 秒回 + 等 failed(fail_reason=mint_failed)（fail-closed 口径不变：无票绝不执行），502 wire 面不再存在。
7. workers/triage/close.test.ts、workers/chat/flow.test.ts（approve/reject 两用例）、workers/knowledge/flow.test.ts：approve/reject/POST 后取证前加等终态；run_status 断言换成等完后的库面断言。
8. approvals.test.ts 状态机全组合矩阵：APPROVAL_STATES 加 expired 后矩阵自动扩到 4×4，LEGAL 集合加 pending>expired（本票新增的合法迁移，不是放松）。
9. evals rigs：approval×5 + investigation——startApprovalRun 等挂起、决定后等终态/等新卡再取证；断言语义逐条保持。

## 门禁

- `python3 tools/check_specs.py` → PASS（0 警告）
- `pnpm check:boundary` → self-test 18/18 + PASS（0 越界，9/9 条禁令全有人查）
- `pnpm lint` / `pnpm typecheck` → 过
- 测试：agent 461+4sk / case-backend 60 / evals 99 / ingest 42+1sk / web 100 / mcp-audit 14 / `pnpm test:eval` 33 用例全过（详见 commit 时点的运行输出）
