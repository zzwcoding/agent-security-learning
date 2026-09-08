# 21: m10 Web 下：审批卡 + 时间线 + 对话入口 + Eval 页 + 范围锁死

**What to build:** 收齐六页面：审批卡页（批准/驳回/409 并发）、案件时间线页（含 M8 对话追问入口）、Eval 结果页。路由快照锁死六页面之外无路由；六幕 curl 等价脚本核对。

**Blocked by:** 11, 18, 19, 20

**Touches modules:** `m8`, `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 审批卡页：pending 列表/批准/驳回 + 实时反馈；并发后到者 409（源：PRD FR-M10.3·异常与边界）
- [ ] 案件时间线页：详情 + timeline + 对话追问入口（源：PRD FR-M10.4）
- [ ] Eval 结果页：最近一次跑分三维展示（源：PRD FR-M10.6）
- [ ] 路由快照：六页面之外无任何路由（源：m10 卡测试计划·决策 #6）
- [ ] 六幕剧本每幕同步 curl 等价脚本核对通过（源：m10 卡测试计划·零特权原则）
