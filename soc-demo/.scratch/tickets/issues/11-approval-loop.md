# 11: 审批回路：interrupt + 审批卡 REST + ApprovalToken

**What to build:** L2 动作 interrupt() 挂起 run → 审批卡 REST（挂 agent）→ 值班长批准铸 ApprovalToken / 驳回不执行 → resume，审批决定绑定 (run, tool_call)。含中断-恢复测试。

**Blocked by:** 06, 07, 10

**Touches modules:** `m3`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] L2 动作处 interrupt() 挂起，Web 审批后 resume，决定绑定 (run, tool_call)（源：PRD FR-M3.5·Tracecat 持久性语义）
- [ ] 审批卡 REST：GET /api/v1/approvals?status=pending、POST .../approve|reject（源：m9 卡公开接口·FR-S2.4）
- [ ] 批准 → mint ApprovalToken（一次性）；驳回 → 不执行 + 审计（源：PRD FR-S2.4）
- [ ] 审批 interrupt 处杀 agent 进程重启，恢复后决定仍绑定原 (run, tool_call)（源：m3 卡测试计划）
- [ ] 并发审批后到者 409（源：PRD M10 异常与边界·INV-10 同源仲裁）
