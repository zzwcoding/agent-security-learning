# 10: m3 supervisor 编排薄径：runs + checkpointer + SSE + budget

**What to build:** POST /internal/runs→202、checkpointer SQLite 信封 hash 链、SSE 事件总线（自增 id 落盘 + Last-Event-ID 补发）、资源兜底计数。本票 run 无 worker 直 END——先把编排骨架跑通。

**Blocked by:** 03

**Touches modules:** `m3`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] POST /internal/runs {kind, alert_id} → 202 {run_id}（源：m3 卡公开接口）
- [ ] SSE 自增 id 落盘；断线按 Last-Event-ID 补发不丢不重（源：m3 卡公开接口·INV-7）
- [ ] checkpointer 信封 hash 链，篡改落盘状态任意字节 resume 必拒（源：m3 卡测试计划）
- [ ] 资源兜底：LLM 超时 60s / max_steps 20 / token 50k/run 任一超限强杀 + 审计（源：m3 卡资源兜底口径·决策 #4/#5/#12）
- [ ] 无 worker 的 run 无人干预跑完（薄径交付，eval fixture 伪 LLM）（源：m3 卡 Seam·adapter）
