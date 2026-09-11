# 68-under-pressure-shedding: @fastify/under-pressure 过载卸载装配（框架红线票）（P2）

**What to build:** **框架红线（sdd-flow 原则 6：点名即上）**——`@fastify/under-pressure` 真引入三个 Fastify 服务（services/{agent,ingest,case-backend} 的 package.json 依赖 + 代码真 register）。装配纪律：**仅当 `UNDER_PRESSURE=on` 才注册**（env 缺省=零注册=默认形态逐字节不变，jiaotu profile 同款开关纪律）；on 时阈值显式配置（maxEventLoopDelay/maxHeapUsedBytes/maxRssBytes，env 可覆盖，默认给教学演示量级的保守值）。验证两腿：①默认形态回归——UNDER_PRESSURE 未设时全量测试绿且只增不减，新增 2-3 用例（off=无 shedding 行为；on=超阈 503，unit 级用极小假阈值触发）；②压测对照——on 状态复跑票 67 SSE 场景与票 66 持续流，记录 shedding 503 计数/服务存活/eventLoopDelay 对照表进报告（B4/B2 节补列）。

**Touches modules:** `m1`、`m2`、`m3`、`m13`

**Belongs to spec:** specs/modules.md（m13 卡 + m1/m2/m3 卡备注面）；设计源 docs/research/2026-09-12-压力测试方案.md §一/§三 B5

**Blocked by:** 67

**Status:** ready

**验收：**
- [ ] 三服务 package.json 出现 @fastify/under-pressure 且 app 代码真调用 register（框架红线对账项）
- [ ] UNDER_PRESSURE 未设=默认行为逐字节不变（全量测试只增不减）
- [ ] on 时 503 shedding 实测表进报告；off/on 对照结论写清
- [ ] compose 三服务 env 透传（.env.example 注释补 UNDER_PRESSURE）

**实现记录：**（待填）
