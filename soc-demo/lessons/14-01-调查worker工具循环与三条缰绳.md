# 14-01 · m5 调查 worker：工具循环与三条缰绳

> 票 14 教学文档。前情：票 13 分诊 agent 已经会给单条告警出"判决书"，TP 还能自动建案。但案子立了之后呢？真实 SOC 里还有一位 SOC2 调查师：围着案子做检索、把证据串成一份调查报告。本票让这位调查师上岗——他是全系统第一个要"多步循环干活"的 agent，也是第一个必须学会"适可而止"的 agent。

## 1. 三问（阶段动机）

**位置感**：终极目标是"告警进系统 → 分诊建案 → 调查取证 → 高危动作等人点头"的 SOC 数字员工。路线图：

```
✅ 票 01-03  地基：CI / 票面契约 / 案件后端（六实体库）
✅ 票 04-08  安全件：guards / 铸票 / 验票闸 / 凭证代理
✅ 票 09     告警接入
✅ 票 10-12  编排 + 审批回路 + gateway 容器
✅ 票 13     第一个工人：分诊 agent（单条告警 → 四分类 verdict → 建案）
✅ 票 14     ◀ 你在这里：第二个工人——调查 agent（案子 → 工具循环 → 调查报告）
⬜ 票 15+   富化 / 知识沉淀 / Web 演示窗 / eval 收口
```

**这一阶段是干嘛的？** 给 TP 案件出一份"调查报告"：调查 agent 拿着案子里的实体（IP 18.18.18.18、主机 centos7、用户 blimey）去查 SIEM、聚合历史告警、核对内部知识库，最后把发现写成一份固定格式的结构化报告，存进案件时间线。他只**提建议**（"建议隔离 centos7"），永远**不动手**。

**什么需求逼我们这么设计？** 分诊是一次性的（读告警 → 出判决，没有来回），调查不一样——查一轮没查够还得再查，查完才写结论。这个"查了再看、看了再查"的循环带来三个新麻烦，PRD 叫它们**三条缰绳**：
1. **循环会停不下来**——LLM 查上瘾怎么办？→ `max_steps=20`，用完强制收工（决策 #5）；
2. **循环会原地打转**——同一个查询翻来覆去发怎么办？→ 同参数重复调用直接返回错误（HolmesGPT 的 `prevent_overly_repeated_tool_call`）；
3. **循环会把上下文撑爆**——一次查询捞回 6 万字符怎么办？→ 超 1 万字符先摘要，超 5 万字符落盘只留引用。

**解决了什么麻烦？** 之前 TP 建案后案子是空的，只能等人来查；现在案子立起来就有调查师跟进，报告自动进 Timeline，SOC1 打开案件页就能看到"证据、影响资产、处置建议"。而且三条缰绳保证这位调查师干活有边界：不无限烧钱、不原地打转、不把 LLM 的"脑子"（上下文窗口）撑爆。

## 2. 全链路一览

```
TP 告警（票 13 分诊建案）→ case_000001 挂着 observables
   │
   ▼
┌───────────── agent 服务 · workers/investigation/flow.ts ─────────────┐
│ load_case   读案件详情（M2 adapter 直读）+ get_alert 取告警日期        │
│             → 折出实体清单 {ips, users, hosts, files} 作调查的出发点    │
│ plan        LLM 列任务清单（查什么、按什么顺序）                       │
│ tool_loop   ★工具循环：每步 = LLM 裁决「调什么工具」→ 三道检查 → 执行  │
│               ①防打转：同参数重复？直接回错误，不执行                   │
│               ②签名契约：siem_query 缺 time_window？拒绝，不执行        │
│               ③验票闸：verifyTicket 查票面 scope（无 L2，INV-3）       │
│               执行完 → 上下文治理：>1 万字摘要 / >5 万字落盘留引用      │
│ report_llm  LLM 写报告 → schema 逐字段把关 + findings 必须引用真工具   │
│               不过 → 重试 1 次 → 还不过 → 降级自由文本 + 标记          │
│ write_timeline  过闸 add_timeline_entry → 报告进 M2 案件时间线         │
│                 （body 人读 + structured 机读，FR-M5.4 双形态）        │
└──────────────┬───────────────────────────────────────────────────────┘
               ▼
   M2：timeline_entries 多一条 investigation_report；审计全程留痕
```

每个环节一句话：**load_case 是接案**（把案子里的线索抄给调查师）；**plan 是列提纲**；**tool_loop 是查资料的手**（三条缰绳全拴在这只手上）；**report_llm 是写报告**（写完还有编缉审稿）；**write_timeline 是归档**。工具三件套：**siem_query 查外部语料**（fixtures/alerts 当 mock SIEM）、**related_alerts 查库内历史告警**（M2）、**kb_verify 查内部知识**（票 13 的 KB stub）。

## 3. 跟着数据走：5712 暴力破解案（invest/01_ssh_tp_full 布景）

布景：票 13 的 5712 真实告警（"sshd: brute force"）被分诊为 TP 后自动建案，案件 observable 里有 `hostname=centos7`、`ip=18.18.18.18`、`user=blimey`。

1. **load_case**：从 M2 读案件详情，抄下三条线索；再调 `get_alert` 拿告警日期（2023-04-25T13:51）——后面所有查询的时间窗都从它出发。
2. **plan**：伪 LLM 列出三步任务：`siem_query 查 18.18.18.18` → `related_alerts 聚合 centos7` → `kb_verify 核验内部事实`。
3. **第 1 步 siem_query**：LLM 裁决发起查询，参数带 `time_window: {from: 告警日期-24h, to: +24h}`。三道检查全过：参数没重复、签名合法（time_window 在！）、票面有 siem_query。执行后命中 1 条——`full_log: "Invalid user blimey from 18.18.18.18 port 48928"`，进入观察记录。
4. **第 2/3 步**：related_alerts 从 M2 捞到同主机告警，kb_verify 从 KB stub 查到"centos7 是在册内网资产"。三步查完，LLM 裁决 `finish`。
5. **report_llm**：LLM 写出报告 JSON——findings 里的证据**逐字**来自第 3 步的工具输出（"Invalid user blimey…"），`recommended_actions` 建议 `isolate_host`。编缉审稿两道：schema 逐字段验型 ✓；findings 引用的 `source_tool` 确实调用过 ✓。
6. **write_timeline**：过闸调 `add_timeline_entry`，报告进时间线——`body` 是人读的 markdown，`structured` 是机读 JSON（eval 和检索吃这个）。
7. **捣乱实验一（查上瘾）**：换个每次都换参数硬查的 LLM——它会一直查到第 20 步被 `max_steps` 掐断，然后**照常**写出报告，只是 `incomplete: true`、结论标注"调查不完整"。run 状态是 completed，不是 failed——截断是"收工"，不是"处决"。
8. **捣乱实验二（原地打转）**：换一个把同一参数连发两次的 LLM——第二次调用被指纹识别（`工具名 + 参数 hash` 和上次一样），直接返回 `repeated_tool_call` 错误，SIEM 一个字节都没收到。LLM 拿到错误观察后换路收工，报告照出。

## 4. 新技术点四要素：工具调用循环（tool-calling loop）

- **名字**：工具调用循环 / ReAct 式 agent loop；HolmesGPT 里叫 `ToolCallingLLM.call()` 范式。这是 agent 工程的标准骨架，本票落在 `flow.ts` 的 `tool_loop` 节点。
- **作用**：分诊是"一问一答"（一次 LLM 调用出判决），调查是"多问多答"（LLM 自己决定调什么工具、看结果、再决定下一步）。循环把 LLM 从"答题者"变成"干事者"。和票 13 的关系：分诊子图是固定流程的六节点，调查子图的核心节点自己是个内循环——**图套环**。
- **参数**（本项目的关键决策）：
  - 每步 = 一次 LLM 裁决 + 最多一次工具执行；裁决返回 `{kind:"tool", tool, params}` 或 `{kind:"finish"}`；
  - 步数上限 20（决策 #5），环境变量 `MAX_STEPS` 同口径可调；
  - **注意它管的是循环步数，不是图节点数**——m3 runner 的 `budget.step()` 管节点，`ctx.charge` 管 token，各管各的，双保险不重叠。
- **用法**（`services/agent/workers/investigation/flow.ts` 的循环骨架，简化）：

```ts
while (stepsUsed < maxSteps) {
  stepsUsed += 1;
  const d = await llm.decide({ case, tasks, observations });  // LLM 看着观察记录裁决
  ctx.charge(d.tokens);                                       // token 缰绳（m3 计费口）
  if (d.kind === "finish") { finished = true; break; }
  if (seen.has(fp(d)))   { /* 缰绳二：同参数指纹 → 错误观察 */ continue; }
  if (!validateToolCall(d.tool, d.params).ok) { /* 契约 → 错误观察 */ continue; }
  const payload = await gated(ctx, d.tool, d.params, () => execTool(d.tool, d.params)); // 验票闸
  observations.push({ step, tool: d.tool, ok: true, payload: await observe(payload) }); // 缰绳三
}
// 循环正常退出（没 finish）= incomplete，照常走 report_llm / write_timeline
```

  生活比喻：调查师是按小时计费的顾问——`max_steps` 是工时上限，防打转是"这问题你不是刚问过吗"，上下文治理是他随身背包的容量（装不下的大部头寄存到仓库，包里只放取件条）。三条缰绳拴的是**预算、行为、背包**。

## 5. 关键顿悟

- **"只提建议不动手"是结构，不是态度**：报告里可以白纸黑字写"建议 isolate_host"，但调查票的 allowed_tools 里没有它、worker 里也没有审批执行通道——建议到了执行层就是死路。prompt 里写"请不要执行"没用，票面里没有才是真没有（票 13"物理无 L2 票"的续集）。
- **findings 引用真实工具输出 = 给 LLM 装反抄袭系统**：LLM 最擅长一本正经地编造"查到的证据"。两道防线：flow 里查 `source_tool` 是否真调用过（编造来源 → 重试 → 降级），测试里逐字比对 evidence 是否在工具输出的观察记录里（编造内容 → 测试红）。**能溯源的证据才配进报告**。
- **三条缰绳的共同哲学：先截断，再收尾**：max_steps 用尽不是把 run 杀成 failed，而是逼出一份标注"调查不完整"的部分报告——降级路径的终点仍是**可用的产物** + 诚实的标记，而不是一个空案子。查到多少写多少，写不了就明说，比装懂强。

## 6. 亲手验证

调查链路的单测已全绿，你可以亲手跑一遍（不必起 Docker，全部内存件 + 真实 fixture 语料）：

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo/services/agent
npx vitest run workers/investigation
```

应看到：2 个文件 21 个测试全绿（contract 10 + flow 11）。contract 里有"PRD 示例 JSON 原样通过"——PRD §6-M5 那段报告 schema 抄进测试原封不动能过闸；flow 里第一行就是"报告 schema 过 + findings 引用真实工具输出"的全链路。

再看全仓不回归 + spec 门禁：

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo
pnpm test && pnpm typecheck && pnpm lint && python3 tools/check_specs.py
```

应看到：agent 173 / case-backend 43 / ingest 21 / mcp-audit 10 全绿；spec gate PASS（3 条"规划中模块目录尚不存在"的合法警告）。

**捣乱实验**（验证你真理解了时间窗这条缰绳）：打开 `workers/investigation/contract.test.ts`，找到 "siem_query 合法调用放行" 那个测试，把 `time_window` 的 `from` 改成 `from` 晚于 `to`（比如 `from: "2023-04-26T00:00:00Z", to: "2023-04-25T00:00:00Z"`），再给 validateToolCall 补一行断言跑一遍——应看到 `bad_time_window.order`。反过来把 `time_window` 整个删掉再查 FixtureSiem 会怎样？什么都查不到——这就是"强制 time_window、无默认值"的意义：**不给 LLM"查全库"的选项，是从源头控上下文的闸门**。
