# 23-01 · 把手写执行器搬进 LangGraph.js：StateGraph、interrupt/Command、自定义 checkpointer

## 一、三问（这一阶段是干嘛的）

**位置感**：终极目标是「SOC 数字员工」——一套告警分诊/调查/富化的 agent 系统，其中 m3 是大脑（supervisor 编排）。路线图：

```
✅ 票 01-16  业务功能全跑通（但编排是手写的）
✅ ADR 0002  对账发现：PRD 承诺了 LangGraph.js，实际是手写执行循环——欠账
👉 票 23    把编排搬进 LangGraph.js（本票，框架回补第一票）★你在这里
⬜ 票 24-27 guards/MCP/ContextForge/真 LLM 回补
⬜ 票 17-18  知识沉淀、对话 Copilot（踩在本票地基上开工）
```

**这阶段是干嘛的？** 票 10/11 那会儿，图执行是自己写的：`graph.ts` 里一个 for 循环挨个跑节点、每跑完一个节点往 SQLite 盖一个「信封」（带 hash 的状态快照）、审批挂起靠一个自己抛自己接的 `ApprovalInterrupt` 异常。功能都对，但 PRD §4.1 承诺的技术栈是 LangGraph.js——2026-09-09 全局对账（ADR 0002）把这记成了欠账，本票清偿。

**什么需求逼我们这么设计？** 三条：① 承诺了框架就该真用框架，不然文档和代码两张皮；② 手写执行器只有线性循环，没有「从任意节点恢复」「子图嵌套」这些编排原语，票 18（对话 Copilot）马上要复用；③ 审批挂起靠自定义异常，异常一多就容易被人当错误吞掉——框架有专门的挂起机制，语义更清楚。

**解决了什么麻烦？** 换载体的同时**一行行为语义都不许丢**：审批五条验收、信封防篡改、预算三闸、SSE 补发……216 条断言一条不删不放松。麻烦在于框架的机制和我们的机制要对得上榫——下面跟着数据走就能看到榫头在哪。

## 二、全链路一览

```
POST /internal/runs {kind, alert_id}
        │
        ▼
┌─ createRun：runs 表插一行 queued ──────────────────────────┐
│                                                            │
│  graph.ts runFlow()：run 转 running（审计+SSE 镜像）        │
│        │                                                   │
│        ▼                                                   │
│  compileFlowGraph()：把 FlowNode[] 声明成 StateGraph        │
│    "intake" → "route" → END   （节点名就是卡上的子图名）     │
│    compile({ checkpointer: EnvelopeCheckpointSaver })       │
│        │                                                   │
│        ▼  graph.invoke(初始状态, {thread_id: runId})        │
│  ┌── LangGraph 执行循环（superstep 一步一停）──────────┐    │
│  │ 节点包装层：node_enter 事件 → budget.step()          │    │
│  │   → 把状态拷贝给 FlowNode.run(ctx)                   │    │
│  │   → node_exit 事件 → saveProgress 回写步数           │    │
│  │ 每步跑完：saver.put() 盖信封（hash 链 +1 环）         │    │
│  │ 节点里遇到 L2 动作 → interrupt(卡id) → 整图原地挂起   │    │
│  └──────────────────────────────────────────────────────┘    │
│        │                        │                            │
│   正常跑完                 挂起（awaiting_approval）         │
│        │                        │                            │
│        ▼                        ▼                            │
│  run 转 completed        值班长在审批卡 REST 上裁决           │
│                          → resumeRun() →                    │
│                          graph.invoke(Command{resume}, ...) │
│                          从盘上信封链末环接着跑              │
└────────────────────────────────────────────────────────────┘
        │
        ▼
GET /api/v1/events/stream?run_id= （SSE，自增 id 补发，没动）
```

改动就三块：**graph.ts**（执行循环 → StateGraph + interrupt/Command）、**checkpointer.ts**（信封链装进 BaseCheckpointSaver）、**db.ts**（加一张 checkpoint_writes 表存框架的挂起/恢复账）。runs/statemachine/events/audit/budget 的表和 REST 面一行没动。

## 三、跟着数据走 5 步（一次审批挂起-恢复的全旅程）

布景：值班系统建议隔离主机 centos7（L2 高危动作，得等人点头）。

**第 1 步：run 出生，图被声明出来。**
`POST /internal/runs` 落一行 `queued`，然后 `runFlow`（graph.ts:321）把 run 转 `running`，接着 `compileFlowGraph`（graph.ts:190）把 `APPROVAL_DEMO_FLOW` 的两个节点登记进 StateGraph：`response_advice` → `execute_action` → `END`（graph.ts:295-300）。此刻图还只是「图纸」，`compile` 时把我们的信封链 checkpointer 装进去（graph.ts:304-305）。

**第 2 步：节点开跑，每步落一个信封。**
`graph.invoke({run: {kind, alert_id}}, {configurable: {thread_id: runId}})` 启动。LangGraph 把每个节点包成一个 superstep：我们的包装层先发 `node_enter` 事件、`budget.step()` 过秤，再把状态浅拷贝一份塞给 `ctx.state` 让 worker 随便改（graph.ts:281-293）。节点跑完，框架调 `EnvelopeCheckpointSaver.put()`——盖一个信封：状态字节算 sha256 当 `state_ref`，再连上上一环的 `prev_hash`（checkpointer.ts:177）。**这条 hash 链就是票 10 的防篡改底座，一环扣一环，改任何一环后面全对不上。**

**第 3 步：撞上 L2 动作，整图原地挂起。**
`execute_action` 节点里调 `ctx.awaitApproval("isolate_host", …)`：先查审批卡表，没有能生效的卡 → 开一张 pending 卡（卡上记着 run_id + tool + params_hash，这就是「决定绑定 (run, tool_call)」的锚），然后调 **`interrupt(卡id)`**（graph.ts:216）。这个函数会抛出框架专用的 `GraphInterrupt`——不是错误，是挂起信号：整个 invoke 正常返回，返回值里带 `__interrupt__` 标记（graph.ts:310），run 已经被开卡事务原子地转成 `awaiting_approval`。挂起的那一步**不会**留信封（节点没跑完），盘上最后一环就是前一个节点的末态。

**第 4 步：值班长批准，Command 唤醒。**
`POST /api/v1/approvals/:id/approve`：先找 gateway 铸一枚一次性 ApprovalToken，裁决落卡（pending→approved），然后 `resumeRun`（graph.ts:417）——**先把信封链整链复核一遍**（checkpointer.ts:87 的 `verifyChain`，链对不上直接 409 + FAILURE 审计），再把 **`new Command({resume: true})`** 递给 invoke（graph.ts:349）。框架从盘上读出「停在哪个节点」，把节点**从头重跑**一遍；重跑时 `awaitApproval` 又查一次卡——这次卡已 approved 带 token → 验票闸验签 → 执行隔离 → 焚毁登记 jti。注意：**决定永远以数据库里的卡为准**，`interrupt()` 的返回值我们看都不看。

**第 5 步：捣乱输入——换参数的 tool_call 吃不到原决定。**
假设有人中途把参数从 `{host:"centos7"}` 换成 `{host:"web-99"}`：resume 重跑节点时，`awaitApproval` 按 `paramsHash({host:"web-99"})` 查卡——查不到（卡绑的是旧参数的 hash）→ 给新调用**再开一张新卡** → 再次 `interrupt` 挂起。旧决定套不上去，这就是「决定绑定 (run, tool_call)」落在代码结构上。这里有个框架细节：同一个节点第二次调 `interrupt()` 时，框架会把上一次的旧 resume 值先「回吐」给它——所以我们用了一个循环：`interrupt()` 返回了就回到循环顶重查卡，卡还没决就再中断（graph.ts:196-218），直到真正挂起。谁对谁错全看卡，框架的唤醒信号只是「该再查一次了」。

## 四、新技术点四要素

### 1. `StateGraph`（@langchain/langgraph 主类）

- **名字**：StateGraph，LangGraph.js 的图构建器，主包 `@langchain/langgraph`。
- **作用**：把「先跑谁后跑谁」从代码循环变成**声明**——加节点、连边、指到 END，像画流程图。和手写 for 循环的区别：图是数据，框架能检查它（有没有到不了的节点）、能在任意节点前停下再从那儿继续。
- **参数**：构造时给状态定义（本项目用 `Annotation.Root` 声明单通道 `run`，reducer 是「后写覆盖」graph.ts:170-175）；`addNode(名字, 函数)`、`addEdge(START/名字, 名字/END)`；`compile({checkpointer})` 装上存档引擎。
- **用法**：graph.ts:295-305。本项目把 FlowNode[] 顺序连成链，`compile` 后 `graph.invoke(输入, config)` 开跑。

### 2. `interrupt()` + `Command`（human-in-the-loop 二件套）

- **名字**：`interrupt(value)`（挂起）与 `new Command({resume: 值})`（唤醒），主包导出。
- **作用**：挂起 = 「图停在这儿，等人给个说法」；唤醒 = 「说法来了，接着跑」。比喻：interrupt 是图自己按下的**暂停键 + 便利贴**（便利贴上写着卡 id），Command 是把批复送回来的信封。和我们旧的 `ApprovalInterrupt` 异常的本质区别：框架认识这个异常，会**保存现场**（检查点+挂起记录落盘），换进程都能续；自己抛的异常一死就忘。
- **参数**：`interrupt(value)` 的 value 随便放什么（我们放审批卡 id，SSE 和调试时能看见）；`Command({resume})` 的 resume 是唤醒时它返回给你的值。**坑**：同一节点第二次 `interrupt()` 时框架会先回吐旧 resume 值——要么用它做决定，要么像我们一样无视它、以数据库为准再查一轮。
- **用法**：graph.ts:216（挂起）、graph.ts:349（唤醒）。挂起后 invoke 正常返回，返回对象里带 `__interrupt__` 键（graph.ts:310 用它判断「挂起还是跑完」）。

### 3. `BaseCheckpointSaver`（自定义 checkpointer 的基类）

- **名字**：BaseCheckpointSaver，来自 @langchain/langgraph（底层包 langgraph-checkpoint）。
- **作用**：LangGraph 每跑完一个 superstep 就调 `saver.put()` 存档，每次启动/恢复调 `saver.getTuple()` 读档。官方给的是内存版和 Postgres 版；我们要的是「SQLite + 信封 hash 链」——继承基类把这几个接缝自己实现，**框架的存档节奏 + 我们的防篡改链**就焊在一起了。
- **参数（要实现的钩子）**：`put(config, checkpoint, metadata)`（存一档）、`getTuple(config)`（读一档，读前整链复核）、`putWrites(config, writes, taskId)`（存挂起/恢复的任务账，重启用）、`deleteThread`（删线程）。序列化用自带的 `this.serde`（JSON 足够）。
- **用法**：checkpointer.ts:140 起。`put` 里盖信封（sealEnvelope → state_ref 锁字节、prev_hash 链环），`getTuple` 里 `verifyChain` 先炸篡改再交货。信封落盘还是原来那张 `checkpoints` 表，`run_id` 就是 `thread_id`。

## 五、关键顿悟

- **换载体 ≠ 换语义，榫头在接缝上。** 手写循环有四个动作（事件、预算、盖章、挂起），迁移后各有去处：事件和预算留在我们自己的节点包装层，盖章进了 saver.put，挂起换了 interrupt()。判断「真迁移还是假迁移」就看这些语义是不是还各归其位。
- **决定以数据库为准，框架信号只是闹钟。** interrupt() 的返回值可能被框架回吐旧值，所以审批决定永远重查审批卡表——把权威放在一个地方（DB），框架机制只管「停/走」，两条线就永远不会打架。
- **框架的节奏就是新的验收基线。** 检查点从「每节点一环」变成「框架说了算」（输入簿记 2 环 + 每节点 1 环）——carrier 决定 cadence，人不能也不该替框架数环。防篡改语义（每环都盖 hash、读前整链复核）才是不能让的那条线。

## 六、亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
# 0) 全量测试（agent 18 文件 216 条，含 5 条新载体断言）
cd services/agent && pnpm vitest run && cd ../..

# 1) 起一套最小布景：gateway（要带签名密钥）+ agent（审批演示图）
KEY=$(python3 -c "import json;print(json.load(open('fixtures/tickets/contract.json'))['hmac_key']['value'])")
docker run -d --name gw-smoke -p 18002:8002 -e SOC_HMAC_KEY="$KEY" soc-demo-gateway:latest
cd services/agent
AGENT_FLOW=approval_demo AGENT_DB_PATH=/tmp/agent-smoke.sqlite \
GATEWAY_URL=http://127.0.0.1:18002 SOC_HMAC_KEY="$KEY" PORT=3013 pnpm dev

# 2) 发一个 run：应看到 202 + run_id，此刻已挂在 L2 闸口
curl -s -X POST localhost:3013/internal/runs -H 'content-type: application/json' \
  -d '{"kind":"alert_flow","alert_id":"al-5712"}'

# 3) 审批卡应在架：run_id/tool=isolate_host/params/params_hash 都绑在这张卡上
curl -s "localhost:3013/api/v1/approvals?status=pending" | python3 -m json.tool

# 4) 盘上看框架的挂起账（__interrupt__ 就在 checkpoint_writes 表里）
sqlite3 /tmp/agent-smoke.sqlite "SELECT channel, count(*) FROM checkpoint_writes GROUP BY channel;"
sqlite3 /tmp/agent-smoke.sqlite "SELECT seq, node FROM checkpoints ORDER BY seq;"
#   应看到：信封链有 __input__ 两环 + 已跑完的节点环；没有 execute_action（它没跑完）

# 5) 批准 → 应看到 approval_token 铸出 + run_status: completed
CARD=$(curl -s "localhost:3013/api/v1/approvals?status=pending" | python3 -c "import json,sys;print(json.load(sys.stdin)['approvals'][0]['id'])")
curl -s -X POST "localhost:3013/api/v1/approvals/$CARD/approve" \
  -H 'content-type: application/json' -d '{"approver":"duty_lead"}' | python3 -m json.tool

# 捣乱实验：趁卡还 pending，重新发一个 run 再批准时改 params_hash 对应的参数是改不动的——
# 参数在卡开出来时就用 hash 锁死了；真想捣乱就直接 UPDATE checkpoints 里某一环的 state
# 字节，再批准同一个卡：resume 应被拒（TamperedCheckpointError→409）+ 审计 FAILURE。
```
