# ADR 0004：三项终态裁决落地——run 异步化（outbox 队列）、ToolManifest 登记、PII mapstore

- 状态：已接受（2026-09-10，阶段 7 收官残留裁决，用户拍板"全做"并给方向）
- 背景：收尾体检残留三项（G2-3 异步化 / G2-4 ToolManifest / [24-1] mapstore），L0 建议全部从砍，用户否决并给设计方向：①异步化上中间件模式；②设计了的功能配齐上游——新增工具→工具登记，外围用空壳生成器演示；③没人反查就做一个反查入口。

## 裁决

1. **run 异步化**：POST /internal/runs 落 queued 即返回，消费循环（autorun 同款后台轮询）捡起执行；审批（resume）同队列；**审批卡保质期** APPROVAL_TTL_SECONDS 到期自动作废（审批状态机加 pending→expired）+ run 落 failed + 审计。**队列用 agent 自持 SQLite 的 runs 表（queued 状态）+ 消费循环，不引入新消息中间件产品**——outbox/autorum/SSE 落盘补发/checkpointer 全是该模式的既有件，缺的只是分发循环；并发上限 env 可配（默认 1）。
2. **ToolManifest 登记机制**：工具清单落 `tools.manifest.json` 单一来源（name/tier/family/owner_card/description），验票闸分级改读 manifest；**未登记一律 L1 fail-closed 口径保持**；配 **工具脚手架生成器**（生成"输出一句话"的空壳工具 + manifest 行 + 测试骨架），演示"新增工具→登记→闸生效/未登记被拒"全流程。三张卡 + A.1 清单与 manifest 的一致性由契约测试锁。
3. **PII mapstore + 反查口**：guards 脱敏时记录 占位符→原文 映射（自持 sqlite 落盘）；新增受控反查端点（duty_lead/admin 角色，agent 侧过闸转发，审计 INV-8）；映射表属敏感面，不进任何可观测面（金丝雀口径不冲突——INV-4 管凭证不管 PII）。

## 后果

- 好：PRD 三处"设计了没做"（queued 状态、FR-S2.1 ToolManifest、FR-S4.2 mapstore）全部兑现；演示动线升级（审批有真实截止、新增工具有脚手架、反查有入口）。
- 代价：票 47 是 M 级（波及 evals 33 用例的同步假设与 web 等待形态——SSE 补发使 web 改动很小）；48/49 为 S/M。
- 拆票：47 异步化+审批保质期（M）、48 ToolManifest+脚手架（M）、49 mapstore+反查（M），依赖无环，串行派发。

## 追认（2026-09-09，票 49 落地后 L0 追认）

裁决 3 的反查归属按方案 a 落地并追认：`POST /api/v1/pii/reveal` 走 agent 端点级角色白名单（duty_lead/admin，soc1/redteam 403），**不进 FGA 工具矩阵**——反查是人的平台动作而非 worker 工具调用，A.2 矩阵的粒度是工具授权；端点白名单有正反测试锚。映射表属敏感面的金丝雀口径（原文不进日志/SSE/审计 details）随票 49 落地。
