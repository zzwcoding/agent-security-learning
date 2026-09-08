# 10: m3 supervisor 编排薄径：runs + checkpointer + SSE + budget

**What to build:** POST /internal/runs→202、checkpointer SQLite 信封 hash 链、SSE 事件总线（自增 id 落盘 + Last-Event-ID 补发）、资源兜底计数。本票 run 无 worker 直 END——先把编排骨架跑通。

**Blocked by:** 03

**Touches modules:** `m3`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] POST /internal/runs {kind, alert_id} → 202 {run_id}（源：m3 卡公开接口）
- [x] SSE 自增 id 落盘；断线按 Last-Event-ID 补发不丢不重（源：m3 卡公开接口·INV-7）
- [x] checkpointer 信封 hash 链，篡改落盘状态任意字节 resume 必拒（源：m3 卡测试计划）
- [x] 资源兜底：LLM 超时 60s / max_steps 20 / token 50k/run 任一超限强杀 + 审计（源：m3 卡资源兜底口径·决策 #4/#5/#12）
- [x] 无 worker 的 run 无人干预跑完（薄径交付，eval fixture 伪 LLM）（源：m3 卡 Seam·adapter）

## 实现记录（2026-09-08，编码窗口）

- **落点**：services/agent（:3003）自持 SQLite 三表（`db.ts`）：`runs`（run 实体，状态机
  `statemachine.ts` 照 CONTEXT.md run 行）、`run_events`（SSE 总线，全局自增 id）、
  `checkpoints`（信封 hash 链）。run 不进 M2 六实体库——m3 卡把 checkpointer/事件总线/
  worker 生命周期划给 agent，compose 卷 ./data/agent:/data。
- **内部模块对齐 m3 卡**：`graph.ts`（图执行器，薄径节点 intake→route 直 END）、
  `events.ts`（总线 + `eventsAfter` 补发 + `formatSse` wire 格式）、`envelope.ts`
  （`{run_id, seq, node, state_ref, prev_hash, hash}`，state_ref=状态字节 sha256，
  信封 hash 复用 verify-ticket 的 paramsHash）、`budget.ts`（60s/20 步/50k，env 口子
  `LLM_TIMEOUT_MS[_<NODE>]/MAX_STEPS/MAX_TOKENS_PER_RUN`）。`resumeRun` 本票是深函数
  （篡改→拒+审计 FAILURE），HTTP resume 面随票 11。
- **范围取舍（记票不改 spec）**：① agent 侧审计走 `AuditSink` seam
  （测试 Memory / 生产 Console 进日志；SSE 里有 audit 镜像事件落 run_events）——
  PRD FR-S5「两路汇入 M2 audit_entries 同一表」需要 M2 开审计写入口，M2 现只有查询面，
  HttpAuditSink 等 M2 开口后换 adapter（照 m1 的 M2Client 先例）；② 薄径为同步直跑
  （better-sqlite3 全同步、无真 LLM，POST 返回时 run 已终态），worker/LLM 异步化后
  executeRun 签名与兜底语义不变；③ POST /internal/runs 校验 kind（本票只放行
  alert_flow，fail-closed）与 alert_id 非空，不查 M2 告警存在性——M2Client 接线随票 13；
  ④ SSE 另收 `?after=` 作为 Last-Event-ID 的显式等价写法（与 M2 outbox 游标同名）。
- **测试**：agent 87 绿（本票新增 61：状态机全组合 / 信封篡改五处+抽环 / 补发不丢不重 /
  budget 口径 / runner 兜底强杀三路 / HTTP 202·400·404 / 真 socket SSE Last-Event-ID）。
  spec gate PASS（5 规划警告合法），lint / typecheck 全仓过。
