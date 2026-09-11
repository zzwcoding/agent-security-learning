# 58-jiaotu-approval-relay: 狗粮票 B · 审批对接（申报→批准中继→对账，m9/m3/m10）

**What to build:** 审批回路外部化——soc-demo 永不自铸审批票，改为"申报→代理批准→拿票→执行→焚毁"五步，批准人身份由椒图口令（`X-Approver-Token`）证明，卡与铸票真相全在椒图 g4（批准中继形态，裁决 2026-09-11 Q5）。六件：①`approvals.ts` 加列 `external_approval_id TEXT`（幂等迁移，ALTER 兜底）+toWire 带出；②`graph.ts` 挂起分支新增申报：`approvalGateway` 存在且卡无 external_id 时 fire `declare()`（await，失败→审计 FAILURE+error 事件，卡留 pending 可重试；不碰 awaitApproval/interrupt 同步契约）；③`app.ts` approve/reject 外部分支：`JIAOTU_GATEWAY_URL` 设定时请求头 `x-approver-token` 透传给 `JiaoTuApprovalGateway.approve/reject`，200→本地卡镜像裁决（带 token/tokenJti，复用 `decideApproval`）+`enqueueRunJob(resume)`，椒图 409→409 `{error:"InvalidTransition"}`、401→401，响应 wire 形 `{approval_id, approval_token, run_id, run_status}` 不变；④`buildApp` opts 加可选 `approvalGateway?` seam（测试换假件）；⑤`run-dispatcher.ts` 保质期对账（G9）：挂起 run 的 pending 卡有 external_id 的 `fetchStatus` 对账，expired→`expireApprovalCard`（run failed approval_expired，既有函数复用）；⑥web 审批弹窗加"审批口令"输入（approve/reject 带 `x-approver-token` 头，内部模式可留空后端忽略，一处组件改动）。`JiaoTuApprovalGateway`（declare/fetchStatus/approve/reject+401/404/409 错误码透传）与契约测试同票交付。

**Touches modules:** `m9`（审批面外部化）、`m3`（挂起申报/对账/buildApp 装配接口）、`m10`（口令输入）

**Belongs to spec:** specs/modules.md（m9 审批卡 REST、m3 编排、m10 web）；设计源：椒图仓设计文档 §3-G5/G6/G9、§4.1、§二幕 4

**Blocked by:** 57（复用 jiaotu adapter 基建与 env 开关装配）

**Status:** done（2026-09-11 主窗口验收：五门禁 worktree 复跑全绿，agent 510→538+4s、web 110→111 只增不减，evals 33/33 triage_accuracy=1.000，approval-loop 五验收原样绿=内部模式零回归）

**验收（每条注源）：**
- [x] 外部模式批准全链：申报（request_approval PENDING 落椒图审计）→批准铸票（approve OK）→token 落本地卡→resume 验签→执行→burn_token OK；web 响应 wire 形不变（源 幕 4 判定点）
- [x] 并发后到批准：椒图 409→soc-demo 409 `{error:"InvalidTransition"}`（INV-10 仲裁权在椒图）（源 幕 4）
- [x] token 重放：闸查 `[J]` burned 得 true→403 token_used（INV-2 闭环跨两仓）；case 绑定靠票 14 透传的 case_id，闸 `scope_insufficient` 语义不变（源 幕 4/§3-G6）
- [x] G9：椒图卡先过期→dispatcher 对账→本地卡 expired+run failed approval_expired（源 §3-G9）
- [x] 内部模式（env 未设）：approve/reject 走原路径逐字节不变，web 口令留空被忽略；全量测试与 evals 零回归（源 §5-1）
- [x] 驳回半边：reject 代理→椒图 200→本地卡镜像 rejected→resume 后节点跳过执行，审计 create→reject（源 幕 4 驳回半边）
- [x] agent/web 全量测试绿只增不减

**实现记录：**（2026-09-11，worktree dogfood/57-58-59 施工完毕，未 commit 留主窗口验收）

**改动文件**（agent 六件 + web 两件 + 新增 adapter 与两份测试）：
- `services/agent/src/db.ts`：DDL approvals 加列 `external_approval_id TEXT` + `migrate()` 查缺补列（ALTER 兜底，学 runs.case_id 既有迁移写法）
- `services/agent/src/approvals.ts`：ApprovalRow.externalId/mapApproval/toWire 带出 `external_id`；新增端口 `ApprovalGateway`（declare/fetchStatus/approve/reject）+ `ApprovalGatewayError`（原码透传）+ `setApprovalExternalId`（落卡+declare SUCCESS 审计）/`listPendingApprovalsByRun`（申报候选集）/`listDeclaredPendingApprovals`（G9 候选集）——端口接口立在领域文件、adapter 在 jiaotu/（57 的 token-ports idiom）
- `services/agent/src/jiaotu/approval-gateway.ts`（新增）：`JiaoTuApprovalGateway` 四方法，wire 对齐椒图 g4 approval/index.ts（申报 POST /internal/approvals Bearer+{tool,params,params_hash,risk←reason,case_id}；对账 GET /api/v1/approvals/:id 公开面取 approval.status；批准 POST …/approve 口令走 x-approver-token 头、票从响应 {approval_token:{token,jti,exp}} 拆出；驳回 …/reject body {reason}）；非 2xx 一律 ApprovalGatewayError(原 status)，正文不进 message；2s 超时 + fetchImpl 注入（57 idiom）
- `services/agent/src/graph.ts`：ExecuteOpts/DriveDeps 加 `approvalGateway?`；runFlow 挂起分支（isSuspended、awaiting_approval 落定后）对本 run 无 external_id 的 pending 卡 await `declare()`——成功 external_id 落卡+审计，失败审计 FAILURE+error 事件(`approval_declare_failed`)卡留 pending 可重试；幂等（已有 external_id 跳过，resume 重入不重复申报）；awaitApproval/interrupt 同步契约未碰
- `services/agent/src/app.ts`：buildApp opts 加 `approvalGateway?` seam（runOpts/dispatcherRunOpts/dispatcher deps 三处透传）；approve/reject 外部分支——无 external_id→502 `declare_pending`；口令头透传 gateway.approve/reject，200→`decideApproval` 镜像裁决（token/tokenJti 落卡）+`decideAndResume`（既有路径原样复用）；椒图 409→409 `{error:"InvalidTransition"}`、401→401 `{error:"unauthorized"}`、400（驳回缺原因）→400 `reason_required`、其余→502 `gateway_failed`（卡留 pending 可重试）；响应 wire 形 `{approval_id, approval_token, run_id, run_status}` 逐字段不变
- `services/agent/src/run-dispatcher.ts`：deps 加 `approvalGateway?`；dispatchOnce 保质期扫描后加 G9 对账——已申报 pending 卡 `fetchStatus`，expired→`expireApprovalCard`（run failed approval_expired 既有函数复用）；pending 不动（决定不对账代写）；对账口病了只记日志本轮跳过
- `services/agent/src/index.ts`：JIAOTU_GATEWAY_URL 设定时 buildApp 加传 `approvalGateway: new JiaoTuApprovalGateway({baseUrl})`（57 三件之外补第四件）；未设逐字节不变
- `services/web/src/api.ts`：decideApproval 加选填 approverToken→`x-approver-token` 头（留空头不发）；`services/web/src/pages/ApprovalsPage.tsx`：工具栏加"审批口令"Input.Password（页面级 state，一处组件改动不引状态库），approve/reject 共用，留空 trim 后不发头
- 测试：`src/jiaotu/approval-gateway.test.ts`（新增 17 例：四方法 wire 逐字段+401/404/409/400 透传+正文不外泄+不可达+env 兜底+响应缺票炸响）；`src/approval-relay.test.ts`（新增 13 例，见下）；`services/web/src/api.test.ts` 补 1 例（口令头随行/留空不发）

**验收行逐条落地**：
1. 外部批准全链：relay 测试「批准全链」——申报（fake g4 收到领域卡逐字段投影）→批准中继（口令原样透传）→椒图铸票随响应中继→token/tokenJti 落本地卡→resume 闸验签执行原 tool_call→焚毁登记→审计 create→declare→approve→execute；响应 wire 形断言与内部模式逐字段相同
2. 并发后到 409：fake g4 回 409→soc 409 `{error:"InvalidTransition"}`，卡留 pending、run 留 awaiting_approval（INV-10 仲裁权在椒图）
3. token 重放+case 绑定：全链测试断言焚毁账登记后 `verifyTicket` 403 `token_used`；case 绑定链路=worker caseId→卡 caseId→declare case_id→椒图票 14 透传铸票→闸 `scope_insufficient` 语义不变（verify-ticket.ts 一字未动）
4. G9：dispatcher 三例——fetchStatus=expired→镜像结算 expired+run failed(approval_expired)；pending 不动；对账口 404/网络病只记日志不动卡
5. 内部模式零回归：无 seam 时挂起不申报（卡无 external_id）、approve 走 mint 本地铸票原路径（relay 测试专锁）+ approval-loop.test.ts 五验收原样全绿 + evals rigs 不设 env 全绿
6. 驳回半边：中继→椒图 200→镜像 rejected→resume 后节点 `{executed:false,outcome:"rejected"}` 跳过执行，审计 create→declare→reject、无 tool_call 事件
7. 全量只增不减：见下

**测试/门禁**：agent 49→51 文件、510→538 passed（+2 文件 +28 例，4 skipped 不变）；web 15 文件 110→111 passed（+1）；evals 33 场景不变全绿（`test:eval` vitest 34 passed，triage_accuracy=1.000）；`pnpm lint`/`pnpm typecheck`（6 项目）/`pnpm test`（全仓）/`pnpm test:eval` 全绿。施工前实测基线：agent 49/510+4s、web 15/110（票面所记"web 7 文件/60"为过期数字，实测按 15/110 起算只增不减）

**偏离票面的决定及理由**：
1. 加列迁移落点在 `db.ts`（DDL+migrate）而非 approvals.ts——票面写"approvals.ts 加列"，但本仓迁移 idiom（CREATE IF NOT EXISTS + PRAGMA 查缺补列）在 db.ts，遵从现状；approvals.ts 只承载领域字段与辅助函数
2. ApprovalGateway 端口接口立在领域文件 approvals.ts（非 jiaotu/ 自含）——57 idiom（接口在 token-ports.ts、adapter 在 jiaotu/），graph/app/dispatcher 只 import 领域类型不依赖 adapter
3. 无 external_id 的卡 approve/reject 定为 502 `{error:"declare_pending"}`——票面给"409/502"两可，取 502 与内部模式 mint_failed 同哲学（卡留 pending 可重试，绝不本地补铸，INV-2 单口不破）
4. 错误映射补足票面未细写的分支：401→401 unauthorized、reject 缺原因（椒图 400）→400 reason_required、其余（404/5xx/网络）→502 gateway_failed；均不自吞不自造（adapter 原码透传，映射只在 app 层）
5. 申报成功也落 declare SUCCESS 审计（票面只要求失败 FAILURE）——INV-8：卡上外部锚是状态变更，须可回放；外部模式审计链成为 create→declare→approve/reject→execute
6. G9 对账只镜像 expired——椒图侧 approved/rejected 不对账代写（决定唯一入口是批准/驳回中继响应，防双写竞态）；对账口病了本轮跳过（查不到真相≠真相是过期，INV-1 邻域口径）
7. web 口令输入放审批页工具栏（批准 Popconfirm 与驳回 Modal 共用同一 state）——票面"一处组件改动"的最小落法，留空不发头内部模式零变化
