# 39-m4-soc1-close-entry: SOC1 一键确认关单入口（G2-7）

**What to build:** FR-M4.5 演示口径补全：FP/BTP 关单建议 → web 告警/案件页 SOC1 一键确认 → L1 任务票执行 close_alert（New→InProgress→Closed 状态机合法驱动，票 13 偏差②的先置 InProgress 补上）→ 审计/时间线留痕。

**Blocked by:** 28

**Touches modules:** `m2`, `m4`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] SOC1 确认后关单建议真实执行（状态机合法路径）（源：FR-M4.5·遗留标记 13-2）
- [x] 审批式留痕：确认动作进审计与时间线（源：INV-8）
- [x] web 入口可达且 409/失败路径有人话提示（源：FR-M10.3 同款交互）

## 实现记录（2026-09-09）

**落地形态（记票）**：执行放 agent 侧（票面"以 L1 任务票执行"字面要求，m9 闸"每工具调用过 verifyTicket"语义不可丢，故不取 web 直调 case-backend 的形态），落成**新 run kind `close_flow`**，走 m3 卡既有拉起面 `POST /internal/runs`（m4 卡"无独立 HTTP 面"不破，web 发起分诊同款先例）。run 形态同时白拿 SSE 时间线/审计镜像/预算兜底，不比直调重多少。

落点：
- `services/agent/workers/triage/close.ts`（新）：close_flow 两节点子图。`load_close_target`＝gated get_alert + 预检三连（verdict 未定→`close_verdict_missing`；建议非 close→`close_advice_missing`；已 Closed→`close_already_closed`，具名错误供 web 映射人话）；`execute_close`＝gated close_alert，**先置 InProgress 放在闸内动作里**（票 13 偏差②：New→Closed 非法；票面缺 close_alert 时告警一个字节不动，fail-closed 到底），再 POST /close 带 verdict。确认人（deps.actor）进 `close_confirm` 审计五要素（INV-8）。
- `services/agent/workers/triage/m2.ts`：TriageM2 契约 + HttpTriageM2 增 `closeAlert(alertId, verdict)`（POST /api/v1/alerts/:id/close，409 折成 `{ok:false, reason}`）。
- `services/agent/src/app.ts`：`RUN_KINDS` 放行 `close_flow`（吃 alert_id）；`TICKET_SPECS.close_flow`＝最小票 `{sub:"agent:triage", scope:["alert:update"], allowedTools:["get_alert","close_alert"]}`（INV-3 无 L2）；makeNodes 第三参带 actor；`/internal/runs` 的 actor 类型诚实派生（x-actor-type 头 → 缺省 actorId 以 `agent:` 开头记 agent、其余记 user、无头维持 system/internal，对齐 M2 ctxOf 内网信任口径）。
- `services/agent/src/index.ts`：makeNodes 接线 close_flow → makeCloseFlow（HttpTriageM2 + 生产 audit + 确认人透传）。
- `services/web/src/close.ts`（新）+ `pages/AlertsPage.tsx`：告警行"确认关单"按钮（`closeAdvised`=fp/btp 且 recommended_action=close 且未 Closed；角色矩阵 soc1/duty_lead/admin 可见、redteam 不可见——A.2 案件写入族口径）；Popconfirm 确认 → startRun 带 `x-actor-id` → 订阅该 run 的 SSE（ReconnectingSse）等终态 → 成功/失败人话 + 刷新列表。`closeRunFailText` 逐条映射后端具名错误（含 M2 409 InvalidTransition → "关单被状态机拒绝（409）"），票 21 decideErrorText 同款套路。
- `services/web/src/api.ts`：startRun 增可选 `{actorId}`（x-actor-id 头随行）。

测试（TDD 先红后绿）：agent `workers/triage/close.test.ts` 7 个（状态机合法驱动/审计时间线双留痕/未分诊拒绝/重复确认拒绝/闸 fail-closed 告警零写/failReason 可定位/铸最小票+确认人进审计），web `close.test.ts` 13 个 + api 1 + pages 4。全量：agent 391+4sk、case-backend 60、ingest 41+1sk、web 100、mcp-audit 14、evals 97 + eval runner 33 case 全过；`check_specs.py` PASS（0 警告）、`check:boundary` PASS（0 越界）、lint/typecheck 全绿，零删除。

### 出入与偏差记录（不改 spec 本体）

1. **入口只在告警页，未做案件页按钮**：票面"web 告警/案件页"按验收最小口径落告警列表页——FP/BTP 关单建议挂在告警上，而案件页展示的是 Case（FP/BTP 关单路径不建案，案件页无此行可挂）。后续若做"值班长自由关单"再议入口。
2. **"时间线留痕"＝run 事件时间线**：alert 实体无 timeline（M2 Timeline 挂 case）；FP/BTP 关单不涉及案件。留痕落在：run 事件流（tool_call/tool_result/audit 镜像，流水线视图可见）+ agent 审计（HttpAuditSink 汇入 M2 audit_entries）+ M2 自身两条状态 diff 审计。
3. **close_flow 不经 /internal/runs 的 409 直返**：拉起面契约保持 202 {run_id}（同步执行到终态）；409 语义经 run 失败的具名错误 + SSE error 事件带到 web 人话提示，未改 m3 卡公开接口响应形状。
4. **角色矩阵第二来源**：web 侧 `CONFIRM_CLOSE_ROLES` 手抄 A.2（soc1/duty_lead/admin ✓）——与 services/gateway/fga/matrix.json 的 case_write roles 一致；web 不 import 他包源码（边界规则），一致性靠本记录与测试锚定。
