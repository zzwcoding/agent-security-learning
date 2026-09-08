# 22: m11 eval 全维 + CI 快慢两道

**What to build:** 补齐攻击/审批/replay/对话维，用例 ≥30；三维报告（分诊准确率/四攻击面拦截率分面计数/成本口径 cost_all.csv）；CI 每日 + 手动全栈 compose 慢道。

**Blocked by:** 14, 15, 16, 17, 18, 19

**Touches modules:** `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 用例 ≥30：分诊 ≥10 / 攻击 ≥10（四面）/ 审批 ≥3 / replay ≥2 / 对话 ≥3（源：m11 卡测试计划）
- [ ] 防线拦截率：攻击 fixture 分面计数，拦截=扫描拦或行为兜底 403 分别计（源：PRD FR-M11.4）
- [ ] 成本口径：每条告警 token/耗时/估算成本，CSV 照 M507 cost_all.csv 列结构（源：PRD FR-M11.4）
- [ ] CI 快慢两道：PR 快道单测级 <5min；每日 + 手动全栈 compose 慢道（源：决策记录 #10）
- [ ] judge 分数进报告不进门禁（复核）（源：PRD FR-M11.2）
