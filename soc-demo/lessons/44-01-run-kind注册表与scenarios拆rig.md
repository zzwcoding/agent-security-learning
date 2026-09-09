# 44-01 · run kind 注册表：一处注册处处消费 + evals scenarios 拆 rig

> 票 44（重构票：F2+F6）的教学文档。读前需要知道：agent 里加一种 run kind（比如 alert_flow），
> 以前要在 9+ 个地方各写一笔；evals 的 scenarios.ts 已经长到 1334 行。

## 一、三问（这一阶段是干嘛的）

**位置感先行**——功能票全部收官（票 04~42），票 43 把安全代码收了敛，这一票收拾「配置散落」和「巨石文件」：

```
票 43：安全代码归库（gated 闸一处定义、出站共享件）
   ✅
票 44：① run kind 注册表（一处注册处处消费）② evals scenarios 拆 rig
   ↑ 你在这里（行为零变化：测试当合同，数字只增不减）
```

- **这一阶段是干嘛的？** 两件事：① **一张 kind 的全部知识，收进一张注册表**——以前「系统认哪几种 run」在 app.ts 的 `RUN_KINDS`，「哪种吃 case_id」在 `CASE_KINDS`，「每种铸什么票」在 `TICKET_SPECS`，「每种组什么图」在 index.ts 的 if 分支，「流水线页画几个节点」在 web 的 `FLOW_NODES`——五个地方各存一份，加一种 kind 要全仓摸一遍，漏一处就静默漂移。② **把 1334 行的 scenarios.ts 按 facet 拆开**——审批的布景、replay 的布景、对话的布景……各回各家。
- **什么需求逼我们这么设计？** 体检报告（结构-1/2）数出来的账：新增一个 run kind 要碰 **9+ 个文件**。散装配置的坏处和复印件一样：三张平行表之间没有任何机制保证它们说的是同一件事——`RUN_KINDS` 里有 `close_flow` 但 `TICKET_SPECS` 里忘了写？拉起时 `spec.sub` 直接炸 500。
- **解决了什么麻烦？** 现在「新 kind 触点 9+ 文件 → 注册表加一个 entry」。注册表自己长了一张完整性测试网：票面/拉起实体/图工厂/预置骨架要么都在一格里齐全，要么测试红。

## 二、全链路一览

```
services/agent/src/run-kinds.ts  ◀── 唯一事实来源（一张表，每行一个 kind）
   │   alert_flow    { intake:"alert", ticket:三族并集, pipelineNodes:分诊六节点, makeGraph }
   │   knowledge_flow{ intake:"case",  ticket:提炼面,                        makeGraph }
   │   chat_flow     { intake:"case",  requiresMessage:true, ticket:只读四件, makeGraph }
   │   case_flow     { intake:"case",  ticket:两族并集, pipelineNodes:链两节点, makeGraph }
   │   close_flow    { intake:"alert", ticket:最小票,                        makeGraph }
   │        ▲ 谁来读哪一格：
   ├──────── app.ts   拉起校验（不在册→400 unknown_kind；intake→该带 alert_id 还是 case_id；
   │                  requiresMessage→chat 没消息 400）+ 铸票读 ticket
   ├──────── index.ts 只管「真件从哪来」（Http adapter/LLM 双 adapter/FGA/语料表），
   │                  打包成 RunKindGraphDeps 注入；makeNodes = 查表取图工厂
   ├──────── index.ts autorun 拉起 payload 读 intake（原 kind==="alert_flow" 特判消失）
   └──────── run-kinds.test.ts 完整性闸：三件套齐全 / INV-3 无 L2 / 票面逐字保持 /
                   pipelineNodes ≡ fixtures/sse-events.json / 图工厂产出 ≡ 骨架
fixtures/sse-events.json flow_nodes  ◀── 契约样品（票 31 先例）
   ├──── agent 侧闸：run-kinds.test.ts（注册表骨架 ≡ 样品）
   └──── web 侧闸：pipeline.test.ts（手抄 FLOW_NODES ≡ 样品）——web 禁 import agent 源码
                      （边界规则 R6），所以靠同一份样品锁两端，不靠派生

evals/src/scenarios.ts（52 行门面：runScenario 分发表）
   └── rigs/  shared（骨架/检查构造器/假铸票——断言分层）
              approval（票 11 五景）  replay（票 09 两景）
              chat（票 18 三景）      investigation（票 14/42）
              triage（票 35 金丝雀）  attack（票 17 RAG + 票 16 沙箱）
```

## 三、跟着数据走（注册一个 kind 的请求的一生）

拿「值班长一键确认关单 close_flow」走一遍（票 39 上线的 kind，今天它的知识第一次住在同一行里）：

1. **拉起**：web 告警页点确认 → `POST /internal/runs {kind:"close_flow", alert_id}`。app.ts 第一件事查表：`runKindOf("close_flow")`——在册，`intake:"alert"` → 校验 alert_id 在场（带 case_id 来？不关我事，表里说它吃 alert）。
2. **铸票**：读同一格的 `ticket`：`{sub:"agent:triage", scope:["alert:update"], allowedTools:["get_alert","close_alert"]}`——最小票（INV-3：无任何 L2）。这段票面字段与拆表前**逐字相同**，run-kinds.test.ts 的「票面字段逐字保持」用例咬着它。
3. **组图**：app.ts 把票交给 makeNodes；index.ts 查表取 `close_flow` 的 makeGraph，把生产装配件（HttpTriageM2、审计 sink）注进去，拿回两节点子图；确认人 `ctx.actor` 照票 39 透传进审计（INV-8）。
4. **对照捣乱输入**：把 kind 换成 `nope_flow`——`runKindOf` 查无此人 → 400 `unknown_kind`，fail-closed 口径跟拆表前一字不差。要是有人在注册表加了个新 kind 但忘了写 makeGraph？完整性测试「三件套齐全」当场红——**一致性不再靠人肉记性，靠测试网**。

## 四、新技术点四要素：注册表模式（descriptor registry）

- **名字**：描述符注册表（descriptor registry）。本仓无框架，就是 `Record<string, Descriptor>` + 两个访问函数。
- **作用**：把「同一样东西的 N 份平行记录」换成「一份结构化记录 + 多个只读消费者」。和票 43 的 `makeGatedCall` 是一个思路的两种形态：43 收敛的是**行为**（闸拒怎么写审计），44 收敛的是**声明**（一个 kind 是什么）。比喻：以前加个新员工要跑五个办公室各填一张表；现在一张入职表，工资/门禁/工位都从它派生。
- **参数**：本仓注册表 entry 的五个格子——`intake`（吃 alert_id 还是 case_id）、`requiresMessage`（chat 特有）、`ticket`（铸票三件套）、`pipelineNodes`（web 流水线预置骨架，可选）、`makeGraph`（吃装配件还图工厂的 maker）。**组合根纪律**：注册表自己不碰 env、不碰网络——所有 env 决定的单例（KB 真容器还是内存、LLM fake 还是 real）由 index.ts 打包成 `RunKindGraphDeps` 注入，注册表仍然可以被测试裸构造。
- **用法**：`services/agent/src/run-kinds.ts:REGISTRY`；访问走 `runKindOf`（查无此人返回 undefined，给拉起口做 400）或 `requireRunKind`（查无此人直接抛，给已过闸的内部路径——resume 重组图等——炸响不猜）。

## 五、关键顿悟

- **「一处注册」的度量不是文件数，是「新知识的落点数」**。close_flow 的 makeGraph 代码物理上还是要写在某处（注册表里），index.ts 仍要装配真件——但**关于这个 kind 的每一个决定**（吃什么 id、铸什么票、组什么图、画几个节点）只在一处。剩下两处触点无法消除：图工厂的宿主（注册表 entry 本身）和它的测试。
- **派生不行就契约锁，锁不住两端就锁样品**。理想方案是 web「由注册表派生」节点清单，但边界规则 R6 禁止 web import agent 源码（web 是纯展示壳）——于是退一步：注册表和 web 各自拿 fixtures/sse-events.json 的 flow_nodes 当镜子照（两端测试各读同一样品）。谁单方面改名单，自己那端红。这是票 31「共享样品契约锁」的第二次落地。
- **拆巨石文件，先拆「对外 API 不变」的门面**。scenarios.ts 从 1334 行变 52 行，而 runner.ts / scenarios.test.ts 的 import 一行没动——门面把七份 rig 再出口，公共面（`runChatPrompt`/`ScenarioSkip`/`sandboxBackendFromFixture`）原样。搬代码不改行为的诀窍：**逐字搬，签名不改，让 import 图而不是函数体发生变化**。
- **改不了 ADR 就记票，但闸不能红**。rigs 文件 import services 内部，落在 ADR 0003 允许清单之外——ADR 是 L0 产物不能自己改，记票 45 请追认；但边界闸当晚就得绿，于是按票面授权改边界规则表的例外列（表内显著标注「待 L0 追认」）。有趣的发现：check_boundary.py 的花括号展开**本来就支持目录前缀**（`evals/src/rigs/{a,b}.ts` 直接命中），闸代码一行没改。

## 六、亲手验证（可选）

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
# ① 注册表长什么样——五个 kind 一张表，每行五格
sed -n '/const REGISTRY/,/^};/p' services/agent/src/run-kinds.ts | head -30
# 应看到：alert_flow/knowledge_flow/chat_flow/case_flow/close_flow 各一个 entry

# ② 完整性闸：故意把某个 kind 的 makeGraph 删掉再跑测试，应当红
pnpm -C services/agent test -- src/run-kinds.test.ts
# 应看到：7 个测试全绿；恢复后「图工厂产出与骨架自洽」一条应在列

# ③ 拆分前后门面对照：scenarios.ts 只剩分发表
cat evals/src/scenarios.ts
# 应看到：14 个 case 的 switch，再无任何布景装配代码；rigs/ 七文件各管一维

# 捣乱实验：往 REGISTRY 里临时加一个 "ghost_flow" entry（不进完整性测试的名单快照）
# → run-kinds.test.ts 的「kind 全集」用例应当红——这就是「加 kind 必须过测试网」的体感
```
