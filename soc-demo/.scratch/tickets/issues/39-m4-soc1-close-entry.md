# 39-m4-soc1-close-entry: SOC1 一键确认关单入口（G2-7）

**What to build:** FR-M4.5 演示口径补全：FP/BTP 关单建议 → web 告警/案件页 SOC1 一键确认 → L1 任务票执行 close_alert（New→InProgress→Closed 状态机合法驱动，票 13 偏差②的先置 InProgress 补上）→ 审计/时间线留痕。

**Blocked by:** 28

**Touches modules:** `m2`, `m4`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] SOC1 确认后关单建议真实执行（状态机合法路径）（源：FR-M4.5·遗留标记 13-2）
- [ ] 审批式留痕：确认动作进审计与时间线（源：INV-8）
- [ ] web 入口可达且 409/失败路径有人话提示（源：FR-M10.3 同款交互）
