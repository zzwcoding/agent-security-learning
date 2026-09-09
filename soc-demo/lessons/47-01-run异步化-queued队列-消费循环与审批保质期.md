# 47-01 · run 异步化：queued 队列 + 消费循环 + 审批卡保质期

> 票 47（ADR 0004 裁决 1，本波 M 级）的教学文档。读前需要知道：run 有五个状态
> `queued→running→awaiting_approval→running→completed/failed`（CONTEXT.md 语义核心），
> 其中 queued 从票 10 建表那天起就一直是个"挂牌空位"——直到本票才真的有人用。

## 一、三问（这一票是干嘛的）

**位置感先行**——这是阶段 7 收官残留三项裁决的第一项（ADR 0004 拆成票 47/48/49）：

```
票 40：事件驱动拉起（outbox 消费循环，后台轮询的先例）
   ✅
票 47：run 异步化（POST 秒回 + 分发循环 + 审批卡保质期）
   ↑ 你在这里
票 48：ToolManifest 登记（S）；票 49：PII mapstore + 反查（S）
   ⬜
```

- **这一票是干嘛的？** 从前 `POST /internal/runs` 是"当面把活干完才给你回执"——HTTP
  请求挂在那里，直到 run 跑到终态才返回 202。本票把它改成"收单开票，回执上写着
  **排队中**"，真正干活的是 agent 进程里一个后台循环。
- **什么需求逼我们这么设计？** LLM 跑分诊要几十秒，跑整链更久；HTTP 客户端（Web
  页面、autorun、未来的任何调用方）替 supervisor 背整个执行期，超时、断连、重试全都
  没法谈。排队是所有"慢活"的标准解法：交接瞬间只有一个动作——**落库**。
- **解决了什么麻烦？** 三个：①调用方不再被执行期绑死；②run 有了真实的排队语义
  （PRD 里写了 queued，账面终于和现实一致）；③审批卡有了**保质期**——以前一张
  pending 卡可以挂一万年，值班长忘了批，run 就永远吊在 awaiting_approval。

## 二、全链路一览

一次"秒回"背后的完整旅程（以 `POST /internal/runs {kind:"case_flow"}` 为例）：

```
POST /internal/runs
   │ ① 校验 kind/alert_id/case_id（400 面原样）
   │ ② createRun：runs 表插一行 status='queued'
   │ ③ run_jobs 表插一条 start 任务（actor 一起落盘！）
   ▼
202 {run_id, status:"queued"}   ◀── 到这里请求就结束了，毫秒级
   │
   │        （后台）run-dispatcher 消费循环，每 100ms 一轮
   │  ④ 先扫审批卡保质期：超时 pending 卡 → expired + run failed
   │  ⑤ 领任务（事务内 pending→claimed，一次最多 RUN_DISPATCH 条）
   ▼
executeStartJob
   │ ⑥ 铸任务票（gateway /internal/mint）→ 组图（run-kinds 注册表）
   │ ⑦ executeRun：queued→running→逐节点→completed（跟同步时代同一套代码）
   ▼
事件一条条落 run_events 表
   │
   ▼
GET /events/stream（SSE）
      ⑧ 先按游标补发历史事件，然后实时推送增量，run 到终态才收流
      —— Web 流水线页从"事后看录像"升级成"看直播"，页面代码零改动
```

审批的续跑（resume）走同一条队列：值班长批准 → 决定落卡 + **resume 任务入队** →
接口秒回 → 循环领了任务再从信封链末态续跑。批准的人从此"按了按钮就走"。

## 三、跟着数据走 5 步（一张卡从排队到过期作废）

1. **落单**：`POST /internal/runs {kind:"case_flow", case_id:"case_1"}`。runs 表多一行
   `status='queued'`，run_jobs 表多一行 `action='start'`。注意 run_jobs 里还塞了
   `payload={actor:...}`——异步以后，发请求时的 `x-actor-id` 请求头早就没了，谁发起的
   这件事必须随任务落盘（票 39 的 close_flow 确认审计要记到人头上，不能因为异步丢了）。
2. **领活**：循环醒来（dispatchOnce），先干私活——扫一遍有没有该过期的审批卡；然后
   领任务：`SELECT ... WHERE state='pending' ORDER BY id LIMIT 1`，领到就改成
   `claimed`。这个 UPDATE 在事务里，同一个任务绝不会被领两次。
3. **干活**：executeStartJob 铸票、组图、executeRun。**这里一行执行逻辑都没重写**——
   铸票/组图/续跑的代码跟同步时代一模一样，只是调用时机从"HTTP 请求里"挪到了
   "循环里"。审计的 requestId 换成 `dispatch_` 前缀自造（没有请求头可借了）。
4. **看直播**：Web 订阅 `/events/stream?run_id=...`。服务端先把库里已有的事件按游标
   补发（INV-7 老规矩），然后每 100ms 查一次同一张表，有新事件就推。run 一到终态，
   写完最后一批就收流。补发和实时推送是**同一段代码、同一张表**——这就是当初"总线
   只有一张落盘的表"设计的红利。
5. **捣乱实验——晾着它**：一张 pending 审批卡，没人批。APPROVAL_TTL_SECONDS（默认
   86400 秒）一到，下一轮循环把它扫出来：卡 `pending→expired`（审批状态机新迁移）、
   审计记 `expire`、SSE 广播 approval_decided(decision=expired)、对应的 run 先转
   running 再转 `failed(reason=approval_expired)`。为什么要两步？因为状态机里
   `awaiting_approval→failed` 不是合法迁移——挂起的 run 得先"被认领"（running）才能
   "被强杀"（failed）。规则面前不抄近道，审计里两条留痕都真实。

## 四、新技术点：为什么队列表里有两个状态字段？（容易被问倒的设计点）

- **名字**：本票没有引入任何新库/新产品（ADR 0004 明令"不上 Kafka/Redis"）。
  队列 = agent 自持 SQLite 里的 `run_jobs` 表 + 一个 while 循环。这个模式业内叫
  **DB-as-queue / outbox 消费**，跟票 40 的 autorun 是同一个物种。
- **作用**：你可能会问——runs 表不是已经有 `status='queued'` 了吗，为什么还要一张
  run_jobs 表？因为 **run 的状态是"它自己几岁了"，任务是"还有谁欠它一次执行"**，
  是两本账：
  - resume 诉求没法用 run 状态表达：run 挂起在 `awaiting_approval`，续跑的"待办"
    如果也用 queued 表达，就得加 `awaiting_approval→queued` 迁移——CONTEXT.md 状态机
    一字不能动（INV-10 的表是语义核心），所以待办必须有自己的落点。
  - 任务还要驮 payload（actor）和领用状态（pending/claimed/done），这些塞进 runs 表
    全是污染。
- **参数**：`RUN_DISPATCH` 并发上限（默认 1，非正整数一律回 1——不猜）；
  `APPROVAL_TTL_SECONDS` 审批保质期（默认 86400）。
- **用法**：本项目里 `startRunDispatcher(deps, {intervalMs})` 在 buildApp 里装配，
  进程退出走 fastify onClose 钩子——stop() 不领新任务，等在跑的任务落定才放进程走
  （优雅停机）。测试里传 `{intervalMs: 5}` 快节拍，或者 `dispatcher: false` 把循环
  关掉，专门看"任务在队列里排队"的确定性瞬间。

## 五、关键顿悟 3 条

- **"秒回"的本质是把交接变成一次落库**。同步时代 HTTP 请求 = 执行期，异步时代
  HTTP 请求 = 写两行 SQLite。凡是"慢活"，接口只该做"登记"，不该做"等候"。
- **重启恢复选 failed 而不是重跑**：进程被杀时正在跑的 run，恢复成
  failed(orphaned_by_restart) 而不是重置 queued 重来——因为图会从头重放节点，M2
  时间线/审计会重复留痕。**宁可诚实地失败，不要不忠实地成功**。而 queued 的任务
  天然在盘上，重启后循环接着领——"queued 不丢"是表结构保证的，不是谁努力的结果。
- **时序契约是契约的一部分**：本票改了十来处测试，但一条断言都没删没放松——改的
  全是"什么时候断言"（POST 返回时刻 → 等终态之后），断言的本体逐字保留。学会区分
  **行为契约**（run 必须跑到 completed）和**时序契约**（POST 返回时已经 completed），
  重构时才知道哪部分能动、哪部分必须等价。

## 六、亲手验证（建议在 compose 起全栈后玩）

```bash
cd soc-demo && docker compose up -d case-backend agent gateway openfga chroma
# ① 秒回观察：POST 立刻返回，status 是 queued
curl -s -X POST localhost:3003/internal/runs \
  -H 'content-type: application/json' -d '{"kind":"alert_flow","alert_id":"<告警id>"}'
#    应看到：{"run_id":"run_...","status":"queued"}——毫秒级返回

# ② 看直播：SSE 挂上，另开一个终端发上面的 POST
curl -N "localhost:3003/api/v1/events/stream?run_id=<run_id>"
#    应看到：audit 帧（status from:queued to:running）→ node_enter/exit 帧 →
#    audit 帧（from:running to:completed）→ 连接自动关闭

# ③ 保质期：把 agent 的 APPROVAL_TTL_SECONDS 调小（compose 里加 env，如 "5"），
#    发一个带 L2 动作的 run（AGENT_FLOW=approval_demo），挂起后不批卡
#    应看到：约 5 秒后 SSE 出现 approval_decided(decision:"expired") 帧，
#    GET /api/v1/approvals?status=expired 里躺着这张卡，run 终态 failed
```
