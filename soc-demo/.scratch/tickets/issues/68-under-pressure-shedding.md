# 68-under-pressure-shedding: @fastify/under-pressure 过载卸载装配（框架红线票）（P2）

**What to build:** **框架红线（sdd-flow 原则 6：点名即上）**——`@fastify/under-pressure` 真引入三个 Fastify 服务（services/{agent,ingest,case-backend} 的 package.json 依赖 + 代码真 register）。装配纪律：**仅当 `UNDER_PRESSURE=on` 才注册**（env 缺省=零注册=默认形态逐字节不变，jiaotu profile 同款开关纪律）；on 时阈值显式配置（maxEventLoopDelay/maxHeapUsedBytes/maxRssBytes，env 可覆盖，默认给教学演示量级的保守值）。验证两腿：①默认形态回归——UNDER_PRESSURE 未设时全量测试绿且只增不减，新增 2-3 用例（off=无 shedding 行为；on=超阈 503，unit 级用极小假阈值触发）；②压测对照——on 状态复跑票 67 SSE 场景与票 66 持续流，记录 shedding 503 计数/服务存活/eventLoopDelay 对照表进报告（B4/B2 节补列）。

**Touches modules:** `m1`、`m2`、`m3`、`m13`

**Belongs to spec:** specs/modules.md（m13 卡 + m1/m2/m3 卡备注面）；设计源 docs/research/2026-09-12-压力测试方案.md §一/§三 B5

**Blocked by:** 67

**Status:** done（2026-09-12 子 agent 施工：三服务装配 + 9 用例 + 三腿压测对照入报告；默认阈值未触发=健康，机制演示档 503 出现/存活/恢复）

**验收：**
- [x] 三服务 package.json 出现 @fastify/under-pressure 且 app 代码真调用 register（框架红线对账项）——三包 dependencies + `src/under-pressure.ts` registerUnderPressure(app)，unit 测 `hasPlugin("@fastify/under-pressure")` on=true/off=false 双态锁死
- [x] UNDER_PRESSURE 未设=默认行为逐字节不变（全量测试只增不减）——全量 pnpm test 绿零失败，三服务各 +3 用例（9 新增 0 修改 0 删除）；容器级实证：默认栈三口 `/healthz`=200、`/status`=404（零注册）
- [x] on 时 503 shedding 实测表进报告；off/on 对照结论写清——报告 B2/B4 各补「under-pressure on/off 对照」小节：默认阈值未触发=服务健康（agent 峰值 heap 57MB/eLD 3.1ms，离 1GiB/1000ms 一个量级）；机制演示档（48MB）503 真出现且服务存活、压后恢复
- [x] compose 三服务 env 透传（.env.example 注释补 UNDER_PRESSURE）——`docker compose config` 空缺省/on 双态插值核实；容器内 `/status` 指标口为透传生效的直接证据

**实现记录：**（2026-09-12，票 68 收口）
- **装配（框架红线兑现）**：`@fastify/under-pressure@^9.1.0`（官方 9.x 配 Fastify 5）进三包 dependencies；各服务新增 `src/under-pressure.ts`（开关+选项推导+register 一处装）：`UNDER_PRESSURE=on` 才 register（env 缺省/其他值=零注册，jiaotu 同款开关纪律）；on 时阈值显式给教学保守值 **maxEventLoopDelay=1000ms（插件 README 示例同量级）/maxHeapUsedBytes=1GiB/maxRssBytes=1.5GiB**——官方缺省全 0=不检查（README 原话核对），零检查等于白装故必须给值；三阈值 `UNDER_PRESSURE_MAX_*` env 可覆盖。**票面 `exposureInterval` 官方 9.x 不存在**，现版为 `sampleInterval`（缺省 1000ms，保持官方缺省）；503 语义全插件自带（FST_UNDER_PRESSURE + Retry-After 缺省 10s），零自造响应；`/status`（exposeStatusRoute）+ healthCheck 并入 memoryUsage 四指标=压测的 eventLoopDelay 公开观察口。
- **装配层接线（报备）**：三服务 app.ts 的 setErrorHandler 顶部加一条 `FST_UNDER_PRESSURE` 放行分支（`reply.send(err)` 原样交还插件自带 503+Retry-After）——不加会被通用 500 兜底吞掉（卸载面必须诚实）；off 时该 code 不存在、分支零触发，既有错误行为逐字节不变。除此之外零路由/零业务逻辑/零中间件改动。
- **透传**：docker-compose.yml 三服务 environment 补 `UNDER_PRESSURE`+三阈值 env（空缺省=off）；.env.example 注释块补齐（缺省不设=逐字节不变）。`docker compose config` 双态插值核实；容器级实证：on 栈三口 `/status`=200 带指标、默认栈三口 `/status`=404。
- **验证腿①（默认形态回归）**：三服务各 `src/under-pressure.test.ts` 3 用例（off=零注册零 shedding（未设/off/OFF/"on " 四态 × 极小假阈值也不 shed）；on=极小假阈值 503+Retry-After 头；on=阈值 env 可覆盖+/status 指标）——TDD red→green（red 首跑 2 失败/3，实现后 9/9）。全量 pnpm test 绿零失败只增不减；bench `npm test` 54/54；双闸 PASS（spec 0 警告 / boundary 0 越界 12/12）。
- **验证腿②（三腿对照，真栈真跑）**：默认九服务+fake LLM+jiaotu 清空，每腿 down→清 data→up。**off 基线**=票 66/67 既有数字（未重跑，票面授权）。**on 默认阈值**：b2 sustained 8 → 960/960×201 零 5xx、积压峰 409 收敛、ingest P99 29ms；b4 200 → e2e P50 50/P99 101ms、补发对账差 0、hold CPU 25.3%；`/status` 首次给出 eventLoopDelay 实测（hold 相位 1.5-2.2ms 均值）——补上票 67「无现成指标」的缺口。**机制演示档**（`UNDER_PRESSURE_MAX_HEAP_USED_BYTES=48000000`，压在 agent load 峰 57MB/rest 33MB 之间）：503 真出现（`/healthz`+`/status` 同 503，应答体即插件 FST_UNDER_PRESSURE）、服务存活（ingest 960 发全应答、agent event loop 毫秒级响应）、压后恢复（颤振止于 +225s，此后 ~8 分钟三口全 200）；跨容器互证：agent 日志 39 次 autorun 拉起 503（游标不动 at-least-once 重试）+ `audit_ingest_failed HTTP 503`（case-backend 擦阈 shed，8 个 ingest 500 的归因）。**全部进报告** B2/B4 对照小节。
- **偏差/留观**：①机制演示档尾部 16 run 未到终态（15 告警停 New），重启 agent（m3 孤儿恢复）无进度、零审批卡零 FAILURE 审计，公开观察面不可归因且插件无因果链（只 shed 入站）；off/on-default 两腿同场景干净，未复现，留观（报告已知边界注记）。②pnpm-lock.yaml 随依赖更新（①的机械后果）。③报告对照小节落在 B2 持续流节内/B4 节尾（票面「各补小表或小节」授权）。services/** 改动面：三 package.json + 三 app.ts 装配两行级 + 三新文件×2，均在票面①②⑤内。
- L0 验收（主窗口，2026-09-13）：亲跑全量 pnpm test EXIT=0 且只增不减（agent 562+3skip、case-backend 44+1skip、ingest 63——三服务恰各 +3；web 111、evals 33/33 不动）+ bench 54/54 + 双闸 PASS；装配 diff 逐行审（app.ts 各 +12 行：放行分支理由成立且 off 态零触发、compose 空缺省透传、.env.example 注释块）——setErrorHandler 接线报备**接受**。收尾五样：spec 无出入（exposureInterval→官方现版无此选项已澄清）/ modules.md 已同步（m13 Adapter 行改口径 + m1/m2/m3 卡备注各一条，L0 亲改）/ CONTEXT 无新术语（「过载卸载 shedding」已存）/ 施工日志=报告对照小节+已知边界注记+本记录 / 架构投影无变更（装配层无新运行时件）。**遗留挂账（阶段 E 体检回收）**：机制演示档尾部 16 run 未终态留观一条。
