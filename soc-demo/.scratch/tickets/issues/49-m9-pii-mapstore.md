# 49-m9-pii-mapstore: PII mapstore 落地 + 受控反查口（ADR 0004-3）

**What to build:** guards /pii/anonymize 脱敏时记录 占位符→原文 映射（guards 自持 sqlite 落盘，.gitignore 覆盖数据目录）；新增受控反查链路：web（duty_lead/admin）→ agent 过闸端点 → guards /pii/reveal（占位符→原文），全链 INV-8 审计；映射表属敏感面不进任何日志/事件可观测面。

**Blocked by:** （ADR 0004 已落）

**Touches modules:** `m2`, `m9`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 脱敏产出映射落盘，重启不丢（源：FR-S4.2·遗留 [24-1]·ADR 0004-3）
- [ ] 反查链路角色受控：soc1/redteam 不可用，duty_lead/admin 可用；每查必审计（源：A.2 矩阵·INV-8）
- [ ] 映射表内容不出现在日志/SSE/审计 details（金丝雀式断言）（源：敏感面口径·INV-4 类推）
- [ ] 投影图 guards-internal 的「脱敏映射表」幽灵节点变事实（源：收尾体检 [四-5]）
