# 58-jiaotu-approval-relay: 狗粮票 B · 审批对接（申报→批准中继→对账，m9/m3/m10）

**What to build:** 审批回路外部化——soc-demo 永不自铸审批票，改为"申报→代理批准→拿票→执行→焚毁"五步，批准人身份由椒图口令（`X-Approver-Token`）证明，卡与铸票真相全在椒图 g4（批准中继形态，裁决 2026-09-11 Q5）。六件：①`approvals.ts` 加列 `external_approval_id TEXT`（幂等迁移，ALTER 兜底）+toWire 带出；②`graph.ts` 挂起分支新增申报：`approvalGateway` 存在且卡无 external_id 时 fire `declare()`（await，失败→审计 FAILURE+error 事件，卡留 pending 可重试；不碰 awaitApproval/interrupt 同步契约）；③`app.ts` approve/reject 外部分支：`JIAOTU_GATEWAY_URL` 设定时请求头 `x-approver-token` 透传给 `JiaoTuApprovalGateway.approve/reject`，200→本地卡镜像裁决（带 token/tokenJti，复用 `decideApproval`）+`enqueueRunJob(resume)`，椒图 409→409 `{error:"InvalidTransition"}`、401→401，响应 wire 形 `{approval_id, approval_token, run_id, run_status}` 不变；④`buildApp` opts 加可选 `approvalGateway?` seam（测试换假件）；⑤`run-dispatcher.ts` 保质期对账（G9）：挂起 run 的 pending 卡有 external_id 的 `fetchStatus` 对账，expired→`expireApprovalCard`（run failed approval_expired，既有函数复用）；⑥web 审批弹窗加"审批口令"输入（approve/reject 带 `x-approver-token` 头，内部模式可留空后端忽略，一处组件改动）。`JiaoTuApprovalGateway`（declare/fetchStatus/approve/reject+401/404/409 错误码透传）与契约测试同票交付。

**Touches modules:** `m9`（审批面外部化）、`m3`（挂起申报/对账/buildApp 装配接口）、`m10`（口令输入）

**Belongs to spec:** specs/modules.md（m9 审批卡 REST、m3 编排、m10 web）；设计源：椒图仓设计文档 §3-G5/G6/G9、§4.1、§二幕 4

**Blocked by:** 57（复用 jiaotu adapter 基建与 env 开关装配）

**Status:** blocked（等 57）

**验收（每条注源）：**
- [ ] 外部模式批准全链：申报（request_approval PENDING 落椒图审计）→批准铸票（approve OK）→token 落本地卡→resume 验签→执行→burn_token OK；web 响应 wire 形不变（源 幕 4 判定点）
- [ ] 并发后到批准：椒图 409→soc-demo 409 `{error:"InvalidTransition"}`（INV-10 仲裁权在椒图）（源 幕 4）
- [ ] token 重放：闸查 `[J]` burned 得 true→403 token_used（INV-2 闭环跨两仓）；case 绑定靠票 14 透传的 case_id，闸 `scope_insufficient` 语义不变（源 幕 4/§3-G6）
- [ ] G9：椒图卡先过期→dispatcher 对账→本地卡 expired+run failed approval_expired（源 §3-G9）
- [ ] 内部模式（env 未设）：approve/reject 走原路径逐字节不变，web 口令留空被忽略；全量测试与 evals 零回归（源 §5-1）
- [ ] 驳回半边：reject 代理→椒图 200→本地卡镜像 rejected→resume 后节点跳过执行，审计 create→reject（源 幕 4 驳回半边）
- [ ] agent/web 全量测试绿只增不减

**实现记录：**（待填）
