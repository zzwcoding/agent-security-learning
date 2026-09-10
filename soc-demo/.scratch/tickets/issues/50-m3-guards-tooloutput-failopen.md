# 50-m3-guards-tooloutput-failopen: guards 不可达时 tool_output 通道静默 fail-open（P2）

**What to build:** 修复防线缺口：guards 服务停机时，分诊/调查/富化的 `tool_output` 扫描通道**静默放行**——不打标、不审计、无任何降级痕迹，run 照常 completed。现状：`guards-client.ts` 不可达时按 failMode 缺省 block 返回 `fail_closed` 裁决，但 tool_output 的两个消费点只认 `flag` 分支，`fail_closed`（以及 `block`）落空即放行。本票让"降级"变成**看得见的事件**：无论选哪种修法，guards 不可达时必须有可 grep 的审计/事件痕迹。

**缺口解剖（2026-09-10 场景教学 2.2 捣乱实测发现）：**
- 位置①（裁决生产侧）：`services/agent/src/guards-client.ts:47-49` —— failMode 缺省 `block`；`unreachable()` 把不可达折成 `fail_closed`（guards-client.ts:74-82）。
- 位置②（裁决消费侧，只认 flag）：`services/agent/workers/investigation/flow.ts:229-240`（observe 的扫描消费）、`services/agent/workers/enrichment/flow.ts:175-185`（analyzer 输出扫描消费，同款）。
- 对照组（合规样板）：triage（workers/triage/flow.ts:99 一带）与 chat（workers/chat/flow.ts:10 一带）的 prompt 侧通道**显式处理 block/fail_closed**——仅工具输出通道漏。
- 实证：同一案件直拉 case_flow，guards 在线 → 工具输出含真注入样本、flag 1 次打标+审计；guards 停机 → 0 flag、0 审计、0 事件、run completed（教具 run：在线 run_572f5bec vs 停机 run_ce0559ef）。

**修法二选一（记票交 L0 裁决，实现前定案）：**
- **方案 a（推荐）**：tool_output 扫描的调用点显式传 `failMode:"flag"`——不可达时 guards-client 返回 `{action:"flag", reason:"guards_unreachable"}`，沿用既有 flag 打标语义（原文保留待人工复核），消费点把 reason 写进审计 details。最小改动、语义自洽（工具输出通道本来就是 flag 策略，票 04）。
- **方案 b**：消费点显式处理 `fail_closed`——记 `guards_unreachable` 降级审计（FAILURE）+ run 事件 warning，行为与现状一致（不打标放行）但留痕。改动集中在两个 worker。

**边角（随本票一并处理）**：flag 打标路径取 `decision.score`；方案 a 下不可达 flag 的 `score` 为 undefined——details 需缺省化（如 `score: decision.score ?? null`）或以 reason 替代。

**Blocked by:** （无——票 04 guards 通道、票 43 共享出站骨架均已落）

**Touches modules:** `m3`, `m5`, `m6`

**Belongs to spec:** specs/modules.md

**Status:** todo

- [ ] guards 停机 + 直拉 case_flow：审计或 run 事件里出现具名降级痕迹（`guards_unreachable`），不再静默 completed（源：lessons/scenario/2-2.md 捣乱 A/B 对照；总纲「发现的问题」P2）
- [ ] guards 在线行为回归：tool_output 注入样本照旧 flag 打标 + `tool_output_flagged` 审计（对照 run_572f5bec 形态），triage/chat prompt 通道行为零变化（源：票 04 策略表；对照组合规）
- [ ] 不可达路径 `score` 边角处理：details 无 undefined 字段（缺省 null 或以 reason 替代）（源：本票边角）
- [ ] 单测补不可达注入用例（guards-client 假件停机 → 断言降级痕迹 + 不强杀 run），既有测试零删除（源：阶段纪律「测试零删除」）
- [ ] 复跑教学对照（docker compose stop guards → 直拉 case_flow → 对比 A/B）作为验收冒烟，结果回写 lessons/scenario/2-2.md 备注行（源：教学布景可复现性）

## 备注

- 优先级 P2 依据：这是**安全相关通道的可观测性静默缺失**（防线在但降级无痕），不是数据损坏/越权——故不阻塞教学，转票排期。
- 修复后 2-2.md 的 A/B 教具对比会变成"A flag / B 降级留痕"，教学叙事更完整。
