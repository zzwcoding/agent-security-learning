# 11: 审批回路：interrupt + 审批卡 REST + ApprovalToken

**What to build:** L2 动作 interrupt() 挂起 run → 审批卡 REST（挂 agent）→ 值班长批准铸 ApprovalToken / 驳回不执行 → resume，审批决定绑定 (run, tool_call)。含中断-恢复测试。

**Blocked by:** 06, 07, 10

**Touches modules:** `m3`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] L2 动作处 interrupt() 挂起，Web 审批后 resume，决定绑定 (run, tool_call)（源：PRD FR-M3.5·Tracecat 持久性语义）
- [x] 审批卡 REST：GET /api/v1/approvals?status=pending、POST .../approve|reject（源：m9 卡公开接口·FR-S2.4）
- [x] 批准 → mint ApprovalToken（一次性）；驳回 → 不执行 + 审计（源：PRD FR-S2.4）
- [x] 审批 interrupt 处杀 agent 进程重启，恢复后决定仍绑定原 (run, tool_call)（源：m3 卡测试计划）
- [x] 并发审批后到者 409（源：PRD M10 异常与边界·INV-10 同源仲裁）

## 实现记录（2026-09-08，编码窗口）

- **落点**：services/agent（:3003）。`approvals` 表进 agent 自持 SQLite（`db.ts` 第四张表，
  卡字段 `(run_id, tool, params_hash)` 即「决定绑定 (run, tool_call)」的落点）；审批状态机
  （pending→approved/rejected，表外一律 409）进 `statemachine.ts`，与 run 状态机同源仲裁。
- **interrupt/resume**：`graph.ts` 节点上下文新增 `executeApproved(tool, params, opts, action)`
  正门——首次调用开卡（事务内：插卡 + 广播 `approval_required` + run 转 awaiting_approval）
  后抛 `ApprovalInterrupt` 收手（挂起≠失败）；`resumeRun` 先验信封链再续跑，从链末态
  **重跑中断节点**（Tracecat 语义），budget 的 steps/tokens 从 run 行接续（兜底口径跨重启
  连续）。执行一律过票 07 的 `verifyTicket` 闸，allow 才执行 mock 动作 → 焚毁登记 +
  卡打 executed 标记；deny（票过期/参数被换/重放）→ DENIED 审计 + run 强杀（INV-1）。
- **审批卡 REST**（`app.ts`）：GET `/api/v1/approvals?status=`、POST `.../approve|reject`。
  approve 顺序 = 先铸票（gateway `POST /internal/mint`，票 06 产物，`HttpMintClient`）后
  （事务内）裁决——铸票失败 502、卡仍 pending 可重试，不留「已批准无票」悬置态；并发后到者
  在裁决事务 409（approve 端点另有 pending 预检，省掉后到者白铸的票）。reject 不铸票不执行。
- **seam**：`token-ports.ts` 出站两件——`MintClient`（测试假件按 fixtures/tickets wire 契约
  在 TS 侧铸票；生产 `HttpMintClient` → gateway）与 `TokenBurner`（生产 `HttpTokenBurner`
  fire-and-forget POST M2 `/internal/used-tokens`，票 03 产物）。测试里闸的重放读口
  （`used`）注入 `MemoryBurnRegistry`。
- **范围取舍（记票不改 spec）**：① 焚毁登记的**跨进程读口**本票未接 M2（BurnRegistry
  seam 是同步读，M2 是 HTTP）——生产先 `used` 不传（闸不查焚毁表），一次性由卡
  executed_at 单次执行 + 执行后即焚写 + 300s TTL 三层兜底；M2 焚毁表读要等异步化闸或
  本地镜像 adapter，接容器时（票 12）对齐。② 审批超时失效（APPROVAL_TIMEOUT_SECONDS）
  与「票过期须重新审批」（PRD 异常与边界）未实现：同步直跑下批准与执行同请求完成，
  过期到不了；票过期时闸拒 + run failed（fail-closed），重新审批留异步化后的票。③
  `AGENT_FLOW=approval_demo` 挂 `APPROVAL_DEMO_FLOW`（response_advice → execute_action，
  mock EDR 隔离 centos7）作 curl 演示布景；默认仍薄径直 END。④ `checkpointer.loadRunState`
  空链语义从「抛 Tampered」改为「交空态从头起」（中断在首个节点前的合法形态；篡改仍拒）。
- **测试**：agent 113 绿（本票新增 26：审批状态机全组合 / 开卡挂起与回滚 / 裁决仲裁四向
  409 / 一次性执行标记 / REST 202·400·404·409·502 / 批准全回路含真验签与重放 403 /
  换参数不吃旧决定 / 文件库双 app 模拟杀进程重启 / 过期票 DENIED 强杀 / resume 状态门）。
  真机冒烟：gateway(py) + agent(ts) 双进程跑通挂起→杀进程→重启→批准→resume→completed，
  事件流 12 条编号连续（approval_required→decided→tool_call→tool_result）。
  spec gate PASS（5 规划警告合法），lint / typecheck / py pytest 全过。
