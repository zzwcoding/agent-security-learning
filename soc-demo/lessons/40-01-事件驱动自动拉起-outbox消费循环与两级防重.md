# 40-01 · 事件驱动自动拉起：outbox 消费循环（告警自己会跑流水线了）

> 票 40（G2-9 清偿）的教学文档。读前提问：跑通项目、看懂分诊与沉淀（见 run-01-分诊.md、36-01、17-01）。

## 一、三问（这一阶段是干嘛的）

**位置感先行**——终极目标是 PRD 的端到端消息旅程，一张图标出你在哪：

```
回放推告警 → 接入去重(09) → 写库+发事件(03) → 【supervisor 认领自动拉起(40)】 → 分诊(13) → TP建案 → 调查富化(36)
   ✅          ✅                ✅                    ⬜ 事件躺在 outbox 没人捡            ✅        ✅
案件关闭(39/17) → 发 case.closed → 【自动拉起提炼(40)】 → KB 草稿 → 人审 → 入库
                      ✅               ⬜ 同一条线头                        ✅
                                  ↑ 本票（40）就是修这两格 ↑
```

- **这一阶段是干嘛的？** 到上一票为止，流水线每一段都能跑，但每一段都要人推一把：想分诊，得有人对着告警 id 手敲 `POST /internal/runs {kind:"alert_flow"}`；想提炼，得再手敲一次 knowledge_flow。可 M2 的 outbox 表里其实早就躺着信号——告警入库那天起，`alert.created` 事件就在里面（票 09/03 写的），`case.closed` 也在（票 17 补的 emit）。**写了七年信，没装过邮差**。本票把邮差装上：agent 进程里挂一个后台循环，每两秒去 outbox 收一次信，见到 `alert.created` 就自动拉起分诊，见到 `case.closed` 就自动拉起提炼。回放一批 fixture，流水线从接入到富化全程自己跑完——PRD 消息旅程 step4 说的「supervisor 认领并拉起分诊子图」从这一票起是真的。
- **什么需求逼我们这么设计？** 两个：① 体检 G2-9 点名的悬空线头——事件进了 outbox 却零消费者；② 演示口径——PRD 的主打卖点就是"告警进来自动分诊"，链路上有一个人工环节，演示就要冷场。为什么用"轮询 outbox"而不是消息队列？specs/modules.md 一开始就砍了 Kafka（教学单机不上重型中间件），EventBus 的 seam 立在"SQLite outbox 表 + 游标轮询"上，将来换 Kafka 只换邮差不换信。
- **解决了什么麻烦？** 三个麻烦捆在一起：**不能漏**（事件得至少被处理一次——所以拉起失败时游标不动、下轮重试）；**不能重**（游标丢了、进程重启了、同一个事件来两遍，也不能分诊两次、提炼两份——INV-6 不变量）；**不能失控**（自动拉起是加进生产进程的常驻行为，得有一个开关一键关掉，手动模式和 evals 一点都不能被它影响）。

## 二、全链路一览

```
case-backend（M2）                          agent（M3）
┌──────────────────────┐                 ┌─────────────────────────────────────┐
│ outbox_events 表      │                 │ src/autorun.ts（新内部模块）          │
│  id=7 alert.created ←─┼─── 每2秒轮询 ───┤ ① HttpOutboxReader                  │
│  id=9 case.closed  ←─┼─── GET /api/v1/  │    GET /events?after=游标            │
└──────────────────────┘   events?after=N │ ② 逐条裁决：拉？跳？败？             │
                                          │    · alert.created → 有过 run 没有？ │
                                          │    · case.closed → 有过 run/提案没？ │
                                          │ ③ 推进游标 → event_cursors 表（自己库）│
                                          └──────────────┬──────────────────────┘
                                                         ▼ 拉起 = 打自家正门（app.inject）
                                              POST /internal/runs {kind, alert_id/case_id}
                                                         │  与手动触发同一扇门：
                                                         │  铸票 → 组图 → 执行 → 审计
                                                         ▼
                                              alert_flow（分诊，TP 后链调查富化）
                                              knowledge_flow（提炼 → kb 人审闸）
```

看这张图的三个关键：**信只有一种来源**（M2 的 outbox 表，业务和事件同事务落库，票在库在）；**邮差只有一只**（agent 进程内一个串行循环，上轮收完才收下轮，天然不会跟自己抢）；**拉起只有一扇门**（循环不直接碰 worker，它只是替你敲了那个你本来手敲的 `/internal/runs`）——所以手动模式有的铸票、验票、审计、SSE 时间线，自动拉起一样不少，一点旁路都没开。

## 三、跟着数据走（ssh-5712 那条爆破告警，从事件到 run）

1. **信诞生**：回放把 ssh-5712 推进 ingest webhook → 去重（第一次见，不是重复）→ 映射落库。M2 的 `ingestAlert` 在**同一个事务**里干两件事：INSERT alerts 一行 + `emitEvent("alert.created", {alertId, source, sourceRef})` 往 outbox_events 插一行。事务没提交，事件不存在；提交了，事件必在——这就是 outbox 模式的全部秘密：**业务和事件要么都在，要么都不在，没有中间态**。
2. **邮差来收**：agent 进程里的循环每 2 秒问一次 `GET /api/v1/events?after=6&limit=100`（6 是上次的游标水位，存在 agent 自己 sqlite 的 event_cursors 表里）。M2 把 `id > 6` 的行给它：id=7 那条 alert.created。
3. **裁决：拉不拉？** 循环先看 payload 里的 alertId，去 agent 自己的 runs 表查一眼："这个告警已经有 alert_flow 的 run 了？"（查法：`WHERE kind='alert_flow' AND alert_id=? AND status != 'failed'`——**failed 的不算数**，上次失败这次允许再试）。没有 → 拉。
4. **拉起 = 敲正门**：`app.inject` 打自家 `POST /internal/runs {kind:"alert_flow", alert_id:"<uuid>"}`。接下来发生的一切你都在票 13/36 见过：gateway 铸任务票 → makeNodes 组分诊图+调查富化链 → 图跑完 → 审计落 M2。循环没有为自动拉起写一行业务逻辑，它只是个自动按键的手。
5. **记账**：游标推到 7，写回 event_cursors。就算这时进程被杀，重启后从 7 继续收——id=7 那封不会再拆一遍。
6. **捣乱实验（游标丢了）**：假设 agent 的库被删了，游标归零，循环重读 id=7——**同样的告警会分诊两次吗？** 不会。第 3 步的 runs 表查到"这条告警已有 run"→ 跳过（skip 理由 `run_exists`），游标照样推到 7，不卡壳。再退一步：就算防重查询失效、真拉起了两个并发 run，还有票 13 的 **verdict 锁**兜底——两条 run 同时去 PATCH `verdict='in-progress'`（条件更新 `WHERE verdict IS NULL`），只有先到者拿到，后到者 409。三层防线：**查账 → 跳过；查漏 → 锁兜；锁外 → 不存在**。
7. **case.closed 同一条路**：SOC1 关案（或测试里 POST /close 带 verdict）→ outbox 多一条 id=9。循环裁决时多查一处：M2 的 kb 账面里这个 case 是不是已经提炼过（有 proposed/approved 的提案就是提炼过）→ 没有 → 拉起 knowledge_flow → 提炼 → kb_propose 建草稿 → 审批卡挂起等人审。**人审这一步永远不自动**（INV-5）——自动的是跑腿，拍板永远归人。

## 四、新技术点：outbox 消费游标（transactional outbox + cursor）

- **名字**：事务性发件箱（transactional outbox）+ 消费游标（consumer offset）。不是某个包的 API，是消息系统最底层的一对模式——Kafka 的 offset、MQ 的 ack，本质都是它。
- **作用**：解决"业务写了、事件丢了"和"事件读了、处理挂了"两头怕。写侧把事件当业务数据在同一事务落库（不怕丢）；读侧拿一个**水位线**（处理到哪个 id 了）慢慢往前挪（不怕重——最多从水位线重读，配防重就安全）。和项目里你已见过的 SSE `Last-Event-ID` 补发（INV-7）、M2 `/events?after=` 是同一个思想第三次出现：**自增 id 落盘 = 免费的进度条**。
- **参数**：三个决定撑起一个最简实现——① 水位线存哪：消费方自己的库里（`event_cursors(name, cursor)` 表），存事件生产方那边反而丢；② 水位线何时推：**逐条推**（处理完一条推一条），不是批完再推——崩在批中间最多重读尾部，配合防重无损；③ 失败推不推：**拉起失败不推**（下轮重试，at-least-once），**坏事件/防重命中推**（它们是"想清楚了不动作"，重试一万次也不会成功，卡住整条队伍不值）。
- **用法**：本项目落在 `services/agent/src/autorun.ts`，核心就三个函数的形状：

```ts
// 读口 seam：生产打 M2 REST，测试换内存数组
interface OutboxReader { eventsAfter(after: number, limit?: number): Promise<OutboxEvent[]> }
// 水位线 seam：生产存 agent 自己的 sqlite（dbCursorStore），测试存内存
interface CursorStore { get(name: string): number; set(name: string, cursor: number): void }
// 一轮消费：读一批 → 逐条裁决 → 逐条推水位
const res = await pollAutorunOnce(deps);   // {scanned, launched, skipped, failed?, cursor}
```

生产装配在 `src/index.ts`（ listen 之后 `startAutorun(...)`），`launch` 用 fastify 的 `app.inject` 打自家 `/internal/runs`——不出网络就能走完整条 HTTP 语义，这是 fastify 官方支持的进程内请求，不是测试专用品。

## 五、关键顿悟

- **"自动"的最小实现是"替人按键"，不是"另起炉灶"**。循环没有自己的业务逻辑，它只是把"人手敲 POST /internal/runs"自动化了——于是铸票、验票闸、审计、预算兜底、SSE 时间线全部白拿，一行不用重写。反过来，如果让循环直接去调 worker，等于在正门旁边开了个狗洞，安全语义全得重做一遍。**复用正门，是这类"自动化票"最重要的一条工程直觉**。
- **at-least-once + 防重 = 恰好一次的实用等价**。分布式消息里"恰好一次送达"是圣杯，工程上永远做不出；能做出来的是"至少一次 + 重复了也不出事"：游标失败不推保证不丢，runs 表查 + verdict 锁保证重了白重。**判断哪里该推游标哪里不该推，就看重复执行的代价**——重拉一个 run 代价可控（有锁），所以失败不推；跳过一个坏事件零代价，所以立刻推。这不是偷懒，是把"哪些操作天然幂等"想清楚后的精确分配。
- **开关是给"默认行为"配的刹车，测试不受影响要靠结构而不靠自觉**。EVENT_DRIVEN 缺省 on，evals 凭什么不怕它？因为 evals 根本不 import 生产装配 index.ts——它们直接组装 buildApp 注入假件。循环想影响 evals 都找不到门。**好的开关关得住行为，更好的结构让开关没有需要关的对象**。
- **write-side 与 read-side 常隔好几张票**。alert.created 写于票 09，case.closed 写于票 17，消费者今天才来——这不是欠账，是 seam 先行的正常节奏：先把"信"的格式和落点钉死（同事务 outbox），谁来读、什么时候读都可以等。体检 G2-9 把"没邮差"记成线头，本票收口——**线头清单就是跨票工程的项目管理**。

## 六、亲手验证

前置：compose 起来（`docker compose up -d`，agent 默认 `EVENT_DRIVEN=on`）。

1. **看邮差上岗**：`docker compose logs agent | grep autorun` → 应见 `event-driven autorun: on (M2 outbox → alert_flow/knowledge_flow)`；M2 没就绪时会先刷几条 `autorun_poll_failed`（正常，病了重试不崩）。
2. **推一条告警，全程不碰 /internal/runs**：`pnpm replay`（或 web 回放按钮）推 fixtures → 等 2~3 秒 → `curl -s "http://127.0.0.1:3002/api/v1/alerts" | grep -o '"verdict_ai":[^,]*'` → 告警有了 AI 判断；web 流水线视图能看到 alert_flow 的 run 自己出现了。
3. **关案看提炼自动接**：web 上把某个 TP 案件走完关单 → 案件时间线出现提炼 run 的痕迹，审批页多了一张 kb_write 审批卡（**这一步停住等人**——自动的到卡为止）。
4. **捣乱实验（开关）**：`EVENT_DRIVEN=off docker compose up -d agent` 再回放一条 → 告警躺在列表里永远 New，没人自动分诊；此时手敲 `curl -X POST http://127.0.0.1:3003/internal/runs -H 'content-type: application/json' -d '{"kind":"alert_flow","alert_id":"<id>"}'` 手动拉起照常好使——开关只卸自动挡，手动挡永远在。
5. **捣乱实验（防重）**：`docker exec -it $(docker ps -qf name=agent) sh` 进容器，`rm /data/agent.sqlite*` 删掉 agent 的库重启（游标丢了，M2 的事件还在）→ 重启后循环从零重扫 → 流水线里**不会**冒出重复 run：`curl -s "http://127.0.0.1:3002/api/v1/audit?objectId=<告警id>" | grep -c '"create".*"run"'` 只有一条。
