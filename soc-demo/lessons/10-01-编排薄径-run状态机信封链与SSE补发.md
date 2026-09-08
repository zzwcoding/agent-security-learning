# 10-01 · 票 10：m3 编排薄径——run 状态机、信封 hash 链与 SSE 补发

## 三问

**位置感**：数据地基（m2）和安全基座（m9 五件套）、正门（m1）都齐了，现在轮到
「指挥官」——supervisor 编排：

```
票03 m2案件后端 ✅ → 票04-08 m9安全基座 ✅ → 票09 m1告警接入 ✅
→ 票10 m3编排薄径 ✅你在这里 → 票11 审批回路 → 票13+ 各 worker 子图 → 前端/评测
```

- **这一步是干嘛的？** 给 agent 服务（:3003）装上编排骨架：`POST /internal/runs`
  开一张「工单」（run），run 自己走完状态机（queued→running→completed）；干活过程
  一边干一边发「带编号的广播」（SSE 事件，编号落盘）；每个节点干完盖一个「防篡改
  火漆信封」（checkpointer hash 链）；还配了三个「断电闸」（LLM 60s / 20 步 / 5 万
  token，超了强杀）。本票没有任何真 worker——run 进图转一圈直接终点，先让骨架转起来。
- **什么需求逼我们这么设计？** 三个现实麻烦：① 演示现场网会断，Web 页面断线重连后
  「错过的进度」必须一条不少地补上（决策 #9）；② 落盘的图状态是 LLM 干活的依据，
  谁要是改了盘上的字节，恢复出来的就是被投毒的状态——恢复前必须验货（v3 决策 ⑦）；
  ③ LLM 会陷入死循环，限调用次数挡不住「每次都换个说法」的推理空转，必须按 token
  和墙钟兜底（Tracecat 口径）。
- **解决什么麻烦？** 事件「自增 id 落 SQLite」让断线补发和实时推送是同一段代码；
  信封 hash 链让「改一环、断全链」，篡改任何字节 resume 必拒；三个闸共用一条
  「超限→强杀→审计→error 广播」通路，任一触发处理方式完全一致。

## 全链路一览

```
POST /internal/runs {kind:"alert_flow", alert_id}        app.ts（薄壳：校验+开工）
   │ 建工单：runs 表插一行，status=queued，审计 create
   ▼
executeRun（graph.ts，编排执行器）
   ① queued→running（过状态机断言，审计 + 广播 audit 事件）
   ② 逐节点执行（薄径只有两个确定性节点）：
        intake  —— 确认交接上下文（alert_id 在状态里；真分诊是票 13）
        route   —— supervisor 路由点：无 worker 注册，直 END
      每个节点三连：
        广播 node_enter → budget.step() 计一步 → 节点干活
        → 广播 node_exit → 盖信封落 checkpoints 表（hash 链）
   ③ running→completed（审计 + 广播 audit 事件）
   │ 任何节点抛错 / 三闸超限 → running→failed + FAILURE 审计 + error 广播
   ▼
run_events 表（自增 id 落盘）──► GET /api/v1/events/stream?run_id=
   EventSource 断线重连带 Last-Event-ID: n → 服务端补发 id>n 的事件（INV-7 不丢不重）
```

## 跟着数据走：run_9937329b 的一生（真跑出来的）

1. **开工**：`POST /internal/runs {"kind":"alert_flow","alert_id":"al-smoke-5712"}`
   → 202 `{"run_id":"run_9937329b-…"}`。此刻 runs 表多了一行
   `status='queued'`，审计表里有一条 create。
2. **进场**：执行器把状态推到 running（CONTEXT.md 状态机表放行这条边，其他边一律
   409），同时 run_events 表落下 **1 号事件**：`audit`，内容是状态 diff
   `{from:"queued",to:"running"}`——审计是真相源，广播是它的回声。
3. **过节点**：2 号 `node_enter(intake)` → 3 号 `node_exit(intake)`，随后 checkpoints
   表落第一个信封：`seq=1, prev_hash=''（创世）, hash=sha256:0de7f2fc…`；
   接着 route 节点同款三连，第二个信封 `seq=2, prev_hash=sha256:0de7f2fc…`——
   **正好是第一个信封的 hash**。链就这么一环扣一环。
4. **收工**：6 号事件 `audit {from:"running",to:"completed"}`。六个事件全程
   编号 1-6，一个不缺。
5. **捣乱者断网重连**：假设浏览器收到 2 号就断网了。重连时 EventSource 自动带上
   `Last-Event-ID: 2`，服务端查 `run_events WHERE id>2`，把 3、4、5、6 原样补发——
   不丢（全集=已收∪补发）、不重（补发里没有 ≤2 的）、顺序不变。
6. **更狠的捣乱者改数据库**：他 `UPDATE checkpoints SET state='{}' WHERE seq=2`。
   下次 resume：状态字节和 state_ref（状态的 sha256 指纹）对不上，当场抛
   `checkpoint_tampered`，恢复被拒 + 审计 FAILURE。改 hash 列、改 prev_hash、
   抽掉一环，同样死——链上任何一环被动，从那环起全部对不上。

## 新技术点四要素：SSE（Server-Sent Events）与 Last-Event-ID

- **名字**：SSE（server-sent events），WHATWG HTML 标准的 `text/event-stream` 协议；
  浏览器侧配套 API 是 `EventSource`。属于 Web 平台层，后端只是按格式吐文本。
- **作用**：服务器→浏览器的**单向**推送管道。和你已会的轮询（M2 的
  `GET /api/v1/events?after=`）比：轮询是客户端反复来问「有新的吗」，SSE 是服务器
  有货就推，省掉空轮询；和 WebSocket 比：WebSocket 双向但要升级协议，SSE 就是普通
  HTTP 响应，教学版够用（Web 页面只需要「收」进度）。断线自动重连是 EventSource
  白送的——这正是 INV-7 要的服务端配合点。
- **参数（wire 格式）**：一事件三行 + 一个空行结束：
  `id:` 给事件编号（EventSource 记住它，重连时自动放进 `Last-Event-ID` 请求头）；
  `event:` 事件类型（前端 `addEventListener("node_enter",…)` 按型订阅）；
  `data:` 载荷（本项目是 JSON，冗余带 type/run_id/ts，照 PRD §6-M3 的事件示例）。
- **用法**（本项目 services/agent/src/events.ts + app.ts）：
  ```ts
  // 发事件 = 插一行拿全局自增 id（落盘才有「补发」可言）
  const res = db.prepare("INSERT INTO run_events …").run(runId, type, payload, now);
  const id = Number(res.lastInsertRowid);
  // 补发 = 按游标查表（和实时推送同一段代码）
  eventsAfter(db, runId, Number(req.headers["last-event-id"] ?? 0));
  // wire 格式
  `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`
  ```
  HTTP 侧用 `reply.hijack()` 接管原始响应写这三行；测试打不到流式响应，所以
  补发选择和格式化都抽成纯函数单测，HTTP 只做壳。

（第二个新技术点：hash 链。原理一句话——每个信封的 hash 用 sha256 盖住「自己全部
字段 + 上一个信封的 hash」，和区块链记账同构，参数复用票 07 验票闸的 `paramsHash`
规范化序列化，细看 `envelope.ts` 注释，这里不重复展开。）

## 关键顿悟

- **「自增 id 落盘」四个字是补发语义的全部根基**。id 持久且单调，断线补发就退化成
  一句 `WHERE run_id=? AND id>游标 ORDER BY id`——不丢（id 连续可查）、不重（>
  游标保证不回头）。不需要消息队列、不需要确认协议，一张 SQLite 表就是事件总线
  （决策 #9「与审计留痕共用持久化」的深意）。
- **hash 链防篡改靠的是「链」不是「锁」**。单个 hash 只能验「这份和当初那份一样吗」，
  前提是你手里有原件；链式 hash 让每个信封顺便担保上一个信封，验末环等于验全链——
  落盘状态自己给自己作证，不需要可信第三方。
- **资源兜底三闸共用一条强杀通路**。LLM 超时、max_steps、token 超限都只是
  `BudgetExceededError` 的三种 kind，runner 只认这个异常：置 failed + FAILURE 审计 +
  error 广播。口径（60s/20/50k）全在 budget.ts 一处，env 留调参口子——将来调口径
  不碰编排代码。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 1. 单测全绿（agent 87 = 本票新增 61 + 既有 26）
(cd services/agent && npx vitest run)          # 应看到 Tests  87 passed

# 2. 起服务（自己的终端跑，库里会多出 data/agent.sqlite）
cd services/agent && npx tsx src/index.ts      # :3003
```
```bash
# 3. 开一张工单 → 202 + run_id
curl -s -w '\n[%{http_code}]\n' -X POST http://127.0.0.1:3003/internal/runs \
  -H 'content-type: application/json' \
  -d '{"kind":"alert_flow","alert_id":"al-5712"}'
# 应看到：{"run_id":"run_…"} [202]

# 4. 看全程广播：6 条事件（audit/node_enter/node_exit ×2 节点/audit），id 1-6 连续
curl -s "http://127.0.0.1:3003/api/v1/events/stream?run_id=<上一步的run_id>"

# 5. 假装断线重连：带 Last-Event-ID: 2 → 恰好补 3-6，一条不多一条不少
curl -s -H 'Last-Event-ID: 2' \
  "http://127.0.0.1:3003/api/v1/events/stream?run_id=<同上>"

# 6. 信封链：seq=2 的 prev_hash 应等于 seq=1 的 hash（ Genesis 的 prev_hash 是空串）
python3 -c "
import sqlite3; db = sqlite3.connect('data/agent.sqlite')
for r in db.execute('SELECT seq,node,prev_hash,hash FROM checkpoints'): print(r)"

# 7. 捣乱实验①：缺字段 → 400；不认识的 kind → 400 unknown_kind（fail-closed）
curl -s -w ' [%{http_code}]' -X POST http://127.0.0.1:3003/internal/runs \
  -H 'content-type: application/json' -d '{"kind":"alert_flow"}'
curl -s -w ' [%{http_code}]' -X POST http://127.0.0.1:3003/internal/runs \
  -H 'content-type: application/json' -d '{"kind":"chat_flow","alert_id":"x"}'

# 8. 捣乱实验②（篡改落盘状态 → resume 必拒）：直接改库里的检查点字节，
#    再让 resumeRun 来恢复——先空跑一次应 resume OK，改完再跑应 REJECTED
python3 -c "
import sqlite3; db = sqlite3.connect('data/agent.sqlite')
db.execute(\"UPDATE checkpoints SET state='{}' WHERE seq=1\"); db.commit()"

cd services/agent && npx tsx -e "
Promise.all([import('./src/db.js'), import('./src/checkpointer.js')]).then(([{ openDb }, { resumeRun }]) => {
  const db = openDb('../../data/agent.sqlite');
  const runId = db.prepare('SELECT id FROM runs LIMIT 1').get().id;
  try { resumeRun(db, runId, { audit: { record: () => {} }, requestId: 'hand' }); console.log('resume OK'); }
  catch (e) { console.log('REJECTED:', e.name, '-', e.message); }
});"
# 应看到：REJECTED: checkpoint_tampered - checkpoint_tampered: state bytes tampered at seq 1
# （把 UPDATE 那行删掉重来一次，应看到 resume OK——先验货再放行）
```
玩完 `lsof -ti:3003 | xargs kill -9` 关服务；`rm -f data/agent.sqlite*` 重置布景。
（票 11 会给 resume 开 HTTP 面，届时第 8 步可以纯 curl 复现「改库→恢复被拒」。）
```
