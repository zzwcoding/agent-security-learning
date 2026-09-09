# 47-m3-run-queue-async: run 异步化：queued 队列 + 消费循环 + 审批卡保质期（ADR 0004-1）

**What to build:** POST /internal/runs 落 queued 即 202 返回（不再同步跑完才返回）；agent 后台消费循环（autorun 同款）捡 queued→running→执行；approve 后 resume 同队列；APPROVAL_TTL_SECONDS 到期的 pending 审批卡自动作废（审批状态机加 pending→expired）→ run 落 failed（reason=approval_expired）+ 审计；并发上限 env 可配（默认 1）。队列 = runs 表 queued 状态 + 消费循环，不引入新消息中间件产品（ADR 0004-1）。

**Blocked by:** （ADR 0004 已落）

**Touches modules:** `m3`, `m4`, `m8`, `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] POST /internal/runs 秒回 202 {run_id, status:queued}；SSE 订阅同一 run 能看到 queued→running→completed 真流（源：CONTEXT.md run 状态机 queued 态·ADR 0004-1）
- [ ] 消费循环捡起/并发上限/进程重启后续跑（queued 不丢）（源：m3 卡 checkpointer 语义）
- [ ] 审批卡保质期：过期自动作废→run failed+审计；过期卡上批准 409；未过期链路行为不变（源：遗留标记 11-2·ADR 0004-1）
- [ ] approve→resume 走队列（批准秒回，执行异步），既有审批五验收语义保持（源：票 11 回归）
- [ ] evals 33 用例与 web 页面在异步形态下全绿（等待终态 helper/页面复核；web SSE 已按补发形态设计改动应很小）（源：票 18 出入①翻转）
- [ ] 异步化后 INV-1/2/3/8 全部回归绿（源：CONTEXT.md）
