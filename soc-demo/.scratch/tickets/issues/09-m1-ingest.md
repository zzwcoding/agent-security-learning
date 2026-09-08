# 09: m1 告警接入 + 回放载体

**What to build:** webhook 接收 → 去重（occurrences+1）→ 映射 → 不可信标记 → 写 m2 → 发事件。scripts/replay.ts 扮演外部 Wazuh 按速率回放 fixture。

**Blocked by:** 03

**Touches modules:** `m1`, `m2`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] POST /api/v1/webhooks/alerts 全链路：接收校验→去重→映射→不可信标记→写 m2→发事件（源：m1 卡职责·内部结构）
- [ ] 同一 fixture 连推 3 次只建 1 条，occurrences+1 刷新 lastSeen（源：m1 卡测试计划·INV-6）
- [ ] 7 类具名 fixture 映射全过（源：m1 卡测试计划）
- [ ] 注入变体字段带 untrusted 标记（源：m1 卡测试计划）
- [ ] scripts/replay.ts：推模式、不进 compose、绝不直塞数据库（走 webhook 正门）（源：m1 卡回放载体三条铁律）
