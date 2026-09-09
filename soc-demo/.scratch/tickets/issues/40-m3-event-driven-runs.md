# 40-m3-event-driven-runs: 事件驱动自动拉起（G2-9）

**What to build:** 消费 outbox 事件自动编排：alert.created → 自动拉起 alert_flow（回放演示口径，防重：verdict 锁已有）；case.closed → 自动拉起 knowledge_flow 提炼（票 17 线头）；开关 env 可关（evals/手动模式不受影响）。

**Blocked by:** 28

**Touches modules:** `m3`, `m7`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] alert.created 自动分诊可开关（源：遗留标记 17-6·PRD 消息旅程）
- [x] case.closed 自动提炼可开关（源：遗留标记 17-6·FR-M7.1）
- [x] 重复事件不重复拉起（INV-6/verdict 锁复用）（源：INV-6）

## 实现记录（2026-09-09）

**落地形态（记票）**：消费循环放 **agent 进程内后台轮询**（生产进程已常驻，不新增部署单元；compose 服务图不动），落成 m3 新内部模块 `src/autorun.ts`（m3 卡内部模块清单已补一行）。轮询 M2 既有事件游标 `GET /api/v1/events?after`（票 03 产物，此前零消费者），把事件折成对自家正门 `POST /internal/runs` 的拉起（生产经 fastify `app.inject`，与手动触发同一条轨道：铸票→组图→执行→审计，不开旁路）——`alert.created → alert_flow`（PRD 消息旅程 step4）、`case.closed → knowledge_flow`（step11，票 17 emit 的消费者到位）。`close_flow` 不挂自动：SOC1 手动确认是票 39 的语义。

**三个口径（记票）**：
1. **开关**：`EVENT_DRIVEN`，**缺省 on**（PRD 消息旅程主链路：ingest→分诊的自动化是演示正主）；`EVENT_DRIVEN=off` 关。evals 不受影响是结构保证（evals 组装 buildApp，从不 import 生产装配 index.ts）；手动 POST /internal/runs 照旧。compose agent 服务注入 `EVENT_DRIVEN: ${EVENT_DRIVEN:-on}`。
2. **游标**：消费水位持久化在 agent 自己的 sqlite 新表 `event_cursors(name, cursor)`（db.ts DDL），重启不重放。游标丢失（库被删）重放也安全，见防重。
3. **防重（INV-6，两层 + 一兜底）**：① agent runs 表查——同对象已有**非 failed** 的同类 run → 跳过（failed 允许重拉 = 重试语义）；② knowledge_flow 加查 M2 kb 账面——该 case 已有 proposed/approved 提案 → 跳过（rejected 不挡，按票面字面口径）；③ 并发兜底 = 票 13 verdict 锁（PATCH 条件更新，同一告警并发双拉只有先到者分诊成功），零新代码复用。批内重复事件同批去重。

**失败语义**：拉起失败（/internal/runs 非 2xx，典型 = 铸票 502）或防重查询病了 → **at-least-once**：本批中止、游标停在失败事件前、下轮重试（「不丢」优先，重试安全由防重兜底）；坏事件（payload 缺 id）与防重命中则跳过并推进游标（poison 不挡道）。M2 不可达 → 轮询只记 `autorun_poll_failed` 日志不中断（启动冒烟实测）。

落点：
- `services/agent/src/autorun.ts`（新）：`OutboxReader`/`HttpOutboxReader`（GET /api/v1/events?after&limit=100）、`CursorStore`/`dbCursorStore`、`runsLookup`（runs 表防重查）、`makeHttpKbEntryCheck`（GET /api/v1/kb/proposals 过滤 source_case_id×proposed/approved）、`pollAutorunOnce`（读一批→逐事件裁决→逐事件推游标）、`startAutorun`（串行不重叠的常驻循环，stop 可重入）、`eventDrivenEnabled`（EVENT_DRIVEN 解析，缺省 on）。
- `services/agent/src/db.ts`：`event_cursors` 表 DDL（游标水位）。
- `services/agent/src/index.ts`：生产装配——db 提前实例化（游标/防重与 buildApp 同一份库）；listen 后按 `eventDrivenEnabled()` 挂 `startAutorun`，launch 用 `app.inject` 打 `/internal/runs`（alert_id/case_id 折 snake wire）。
- `docker-compose.yml`：agent env 增 `EVENT_DRIVEN: ${EVENT_DRIVEN:-on}`。
- `specs/modules.md`：m3 卡内部模块清单补 `autorun` 一行（公开接口零变更）。

测试（TDD 先红后绿）：`src/autorun.test.ts` 22 个——主链路（alert.created/case.closed → 拉起 + 游标推进、无关 topic 忽略、水位后不重放）、防重（重放 run_exists / 同批 dup_batch / kb_exists / failed 可重拉 / 坏事件跳过）、at-least-once（launch 失败游标不动、恢复重试、kb 查询病了同口径）、生产件（dbCursorStore 落库重开可读、runsLookup failed 不挡对象不串）、出站 wire 形（HttpOutboxReader URL 与取值、makeHttpKbEntryCheck 命中表）、开关与循环（缺省 on/off 可关、fake timers 验证周期轮询与 stop）、**全链路集成 2 个**（真 case-backend 子进程：种告警→真 outbox→app.inject 正门→薄径 run completed→游标丢失重放不重复拉起；建案→关案→knowledge_flow 拉起）。启动冒烟：缺省 on 打出 `event-driven autorun: on` 且 M2 缺席只记 warn；`EVENT_DRIVEN=off` 打出 off 不挂循环。

全量门禁：lint 干净、typecheck 6 包 Done、`check_specs.py` PASS（0 警告）、`check:boundary` PASS（0 越界，self-test 17/17）、agent 413+4sk（基线 391+4sk，+22 零删除）、case-backend 60、ingest 41+1sk、web 100、mcp-audit 14、evals 97（eval runner 32 case 全过）。

### 出入与偏差记录（不改 spec 本体）

1. **开关缺省 on**：票面只说「开关 env 可关」，默认值取 PRD 消息旅程 step4 主链路口径（M2 发 alert.created，supervisor 认领并拉起分诊）——自动拉起就是这条消息旅程的收口，缺省 off 会让演示主链路断在半截。关 = `EVENT_DRIVEN=off`，一行 env。
2. **单开关管两类事件**：alert.created 与 case.closed 共用一个 `EVENT_DRIVEN`（票面单数「开关 env」）；要分开关是加法，按需再拆。
3. **消费循环单实例假设**：游标是一条水位线（`m2_outbox`），多 agent 实例同库会互抢游标——演示口径单实例；真要横向扩再上「游标分片/租约」，记此处不做。
4. **knowledge 防重的 kb 账面查走全量列表**：M2 端点无按 source_case_id 过滤参数，演示规模一次 `GET /api/v1/kb/proposals` 全量拉回客户端过滤；规模大了再加端点参数（m2 卡公开面对账时补）。
