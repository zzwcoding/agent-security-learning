# 33-01 · 票 33：出站 wire 形锁 + fail-closed 降级分支

## 三问

**位置感**：阶段 7 收官体检 D 组「数据形状契约补机器锁」的收官一票：

```
票28 边界闸 ✅ → 票29 latest.json ✅ → 票30 alert wire ✅ → 票31 SSE+verdict ✅
→ 票32 guards 形状锁 + 注入语料锚 ✅ → 票33 测试补齐（D3）✅你在这里 → D 组清完
```

- **这一步是干嘛的？** 给两块「一直裸奔」的测试盲区补锁。第一块是 **agent 的出站
  票据通道**（`token-ports.ts`）：铸票（POST gateway `/internal/mint`）和焚毁登记
  （POST case-backend `/internal/used-tokens`）这两个 HTTP 请求体是**跨服务契约**——
  TS 这边发 `{case_id, run_id, allowed_tools}` 这些 snake_case 键，py 网关那边按
  `body["case_id"]`、`body["allowed_tools"]` 逐键取值，但此前**整个模块零测试**：
  哪天有人把 wire 键改成 `caseId`，网关当场回 400 `missing field`，而且是等到
  生产里审批/worker 拉起那一刻才炸。第二块是 **对话 Copilot 真 LLM adapter**
  （`RealChatLlm`）的两条降级分支：模型回包坏了、上游病了，都应该落「unknown
  低置信 → 澄清反问」而不是猜意图——也没人测过。
- **什么需求逼我们这么设计？** 体检结构-13/14 点名这两处；而边界规则（R1）禁止
  跨服务 import 源码，测试要锁「请求长什么样」只能**在 seam 处拦截出站请求**——
  票 27 的 `llm-client.test.ts` 已经示范过一次「注入 fetchImpl 捕获请求」的锁法。
  另外**测试不许为了好测去改生产代码**（本票边界：实现零改动），而这两个类
  恰恰没有注入点、直用全局 `fetch`——好在仓库里还有第二个先例：web 的
  `api.test.ts` 用 `vi.stubGlobal("fetch", 假件)` 给全局 fetch 换岗，一样能拦。
- **解决什么麻烦？** 把「字段名靠人肉记着两端同步」「降级行为靠 code review
  盯着」变成机器闸：谁改 wire 键、谁把「降级」改成「猜」，CI 当场红，还精确
  到哪一条样本、哪一个分支。

## 全链路一览

本票新增两个测试文件、16 条测试，锁两类行为：

```
【锁一：出站 wire 形】src/token-ports.test.ts
  vi.stubGlobal 换掉全局 fetch ──► HttpMintClient.mintTaskTicket / mintApprovalToken
        │                                POST {GATEWAY_URL}/internal/mint
        │                                体 = {type, jti, sub, case_id, run_id, scope, allowed_tools}
        │                                （camelCase 接口字段在 adapter 里映射成 snake_case）
        ├──► HttpTokenBurner.burn        POST {CASE_BACKEND_URL}/internal/used-tokens
        │                                体 = {jti, source}，失败只打日志不抛（fire-and-forget）
        ▼
   断言：方法/URL/头/体逐字 toEqual —— 键名漂移必红

【锁二：降级分支】workers/chat/llm-real.test.ts
  adapter 级：假 seam（triage/llm-real.test.ts 先例）
        回包坏形（7 种样本）──► {tool:"unknown", confidence:0, tokens:照记}
        上游病（5 种错误码）──► {tool:"unknown", confidence:0, tokens:0}，不抛
  全链路级：真 RealChatLlm 接真 chat_flow 子图（knowledge/flow.test.ts:336 先例）
        seam 必抛/坏形 ──► flow 拿 unknown/0 ──► 走「澄清反问」分支 ──► run completed
```

两层锁的分工：adapter 级锁「**降级产物长什么样**」（枚举各种坏输入逐个喂），
全链路级锁「**降级产物被谁消费、产生什么用户可见行为**」（澄清反问、零工具
调用、审计留痕）。只有前者，改坏了 flow 消费端照样绿；只有后者，坏输入的
枚举覆盖会稀稀拉拉。

## 跟着数据走：一条「模型说了人话」的坏回包

拿降级分支①最生活化的样本走一遍——用户问「把主机隔离掉算了」，模型却没守
JSON 契约，回了一句人话：

1. **seam 层**：假 seam 返回 `{ text: "这个嘛……我也说不清楚，你要干嘛来着？", tokens: 33 }`。
   这是 mock 上游——真网上这可能是 MiniMax 没输出 JSON 的一次自由发挥。
2. **adapter 层**（`llm-real.ts`）：先 `unwrapJsonText` 剥围栏/think 段（这句没有
   围栏，原样回来），再 `JSON.parse` → 抛异常 → `parsed = null` → 形状判定不过 →
   返回 `{ tool: "unknown", confidence: 0, tokens: 33 }`。注意 **tokens 照记**：
   钱已经花了，账不能吞（计费口不撒谎）。
3. **flow 消费层**（`flow.ts:281`）：`if (c.tool === "unknown" || c.confidence < 0.5)`
   命中 → 给用户发「想确认一下您的意图：……能再具体说说吗？」→ `chat.clarify`
   置位 → 后面 intent_gate/execute/answer_llm 全部让路。**绝不猜意图**：
   用户说「隔离掉」，系统明明听见了「隔离」，但置信度不够就不执行 L2 动作——
   这条安全语义是 PRD M8 异常与边界白纸黑字要的。
4. **测试断什么**（全链路测试）：run `completed`（降级路径接管，没裸抛）；
   token 流里有「想确认」；全程零 `tool_call`；审计 `llm_call` 细节里
   `tool: "unknown", confidence: 0`（adapter 的降级产物真流进了审计）；`chat.clarify`
   置位。五个断言把整条链从生产者钉到消费者。
5. **捣乱输入会怎样？** 假如有人觉得「unknown 太保守」，把降级改成
   `siem_query/0.9`（猜一个）：七样本坏形测试当场红 + 全链路测试当场红
   （变异 M2 实测）。假如有人把「上游病 → unknown」改成「上游病 → 抛出去」：
   五码测试 + 全链路测试红（变异 M3 实测）。

## 新技术点四要素：`vi.stubGlobal` 给全局 fetch 换岗

- **名字**：Vitest 的 `vi.stubGlobal(name, value)`（vitest 包，测试全局打桩 API）。
- **作用**：临时替换全局对象上的属性（如 `fetch`、`window`），配 `vi.unstubAllGlobals()`
  还原。和**构造注入**（`new Client({fetchImpl})`）比：注入要求生产代码留了口子，
  stubGlobal 不要求——**测试边界纪律「实现零改动」时的正门**。代价是影响面是
  整个进程（测试文件内），所以用完必须还原，且测试里不能有别的代码依赖真 fetch。
- **参数**：`vi.stubGlobal("fetch", vi.fn())`——第二参就是新值；本票传的是会
  记录 `(url, init)` 的假 `fetch`，还能回 `Promise.reject` 模拟断网。
- **用法**（本项目用在哪：`src/token-ports.test.ts`，先例 `web/src/api.test.ts:13`）：

  ```ts
  vi.stubGlobal("fetch", impl);        // beforeEach/测试体里换岗
  await new HttpMintClient(base).mintTaskTicket(req);  // 出站被 impl 拦截记录
  vi.unstubAllGlobals();               // afterEach 还原，绝不漏出测试进程
  ```

  注意分工：`GatewayLlmClient` 有 `fetchImpl` 注入点，走注入（llm-client.test.ts）；
  `HttpMintClient`/`HttpTokenBurner` 没有注入点，走 stubGlobal——**有门走门，
  没门也不为测试砸墙**。

## 关键顿悟

- **wire 键名是最容易漂、也最该锁的契约**。TS 接口 `caseId` 和 wire 键 `case_id`
  只差一个下划线，类型系统管不到「序列化之后的键名」（`JSON.stringify` 直接吃
  对象字面量的键），编译全绿、运行 400。锁法就是「逐字 `toEqual` 整个请求体」——
  不用 `toMatchObject`（宽松匹配会让多出来的键溜过去）。
- **降级测试要分两层锁**：adapter 孤岛测试锁「返回什么」，全链路测试锁「消费端
  拿它做了什么」。只测前者，flow 的消费条件（`confidence < 0.5`）改坏了没人红；
  只测后者，坏输入枚举不全、改个解析分支可能漏网。票 32 的教训在这里同样适用：
  每条样本只证明一件事，多分支样本拆开喂。
- **fire-and-forget 也有契约**：`void fetch(...).catch(log)` 的语义是「失败只打
  结构化日志、绝不阻塞执行器」。测试用 `vi.spyOn(console, "error")` 把日志接住，
  断言 `warn: "used_tokens_register_failed"` + jti——日志也是行为，也值得锁。
- **测试布景里「会叫的替身」好过「沉默的替身」**：全链路布景的 M2 依赖指向
  discard 端口（`http://127.0.0.1:9`）而不是空对象 cast——万一降级路径误触了
  M2，连接拒绝当场红；沉默替身则会把「不该发生的触达」悄悄吞掉。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo/services/agent
pnpm vitest run src/token-ports.test.ts          # 应 7 passed
pnpm vitest run workers/chat/llm-real.test.ts    # 应 9 passed
pnpm vitest run                                  # 应 34 files, 328 passed | 2 skipped
```

捣乱实验（做完 `git checkout -- <文件>` 还原）：把
`services/agent/src/token-ports.ts` 里 `mintTaskTicket` 请求体的 `case_id:` 改成
`caseId:`，重跑第一条命令——应看到 2 failed（逐字 toEqual 咬住键名漂移）。
还原后再想想：为什么 `burn` 那条测试不用 `await`？（答：burn 是 fire-and-forget，
fetch 换岗后的假件是同步记账、立即返回；只有断言「失败日志」那条需要
`setTimeout(0)` 等被吞掉的 rejection 走完 `.catch`。）
