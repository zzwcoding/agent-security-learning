# 27-01 · 票 27：真 LLM adapter 接线——出站走凭证代理，fake↔real 一个 env 切换

## 三问

**位置感**：阶段 5 框架回补五连票的最后一票（23 LangGraph → 24 llm-guard → 25 MCP SDK →
26 官方镜像 → **27 真 LLM，你在这里**）。ADR 0002 对账时点名过第四处偏移："真 LLM 全程缺席
（四 worker 全 Fake）"。前四票把地基修好，这一票把大脑接上电：

```
票13-16 落了 Fake 旁挂 → ADR 0002 拍板回补 → 票27 接真件（经 gateway 代理）✅你在这里 → 17/18 踩着它继续
```

- **这一步是干嘛的？** 给分诊（m4）和调查（m5）各造一个真 LLM adapter（RealTriageLlm /
  RealInvestigationLlm），出站统一走 gateway 的 `/proxy/llm/*` 凭证代理；生产装配默认 real，
  测试继续用 fake。子图、闸、prompt 契约一行没动。
- **什么需求逼我们这么设计？** 框架红线（L0 明令）：真 LLM 调用必须经 gateway 代理出站——
  占位符换真凭证、金丝雀断言，这是票 08 立的契约；PRD §4.1 C3 点名的 LLM 也必须"真上"，
  功能等价的 Fake 撑生产不算数。
- **解决什么麻烦？** 三个：① agent 进程从此**根本没有 key 可泄**（真凭证只活在网关进程，
  INV-4 从"纪律"变成"物理事实"）；② 真模型不可靠（限流/超时/输出不合 schema）——
  全部接进票 13/14 已有的 fail-closed 降级路径，不裸抛、不编造；③ fake ↔ real 切换
  只动注入物——票 13 当年打桩时说的"LLM 换真件时只换 adapter，图与闸一行不动"，今天兑现。

## 全链路一览

一次分诊 verdict 的真 LLM 之旅（每个环节只干一件事）：

```
告警 5712（case-backend）
   │  worker 子图照旧跑：load_alert → kb_check → merge_check → self_audit
   ▼
verdict_llm 节点：buildTriagePrompt(input)          ← prompt 契约文本（事实接口，没动）
   │  不可信段已过 guards 扫描 + wrapUntrusted 包装
   ▼
RealTriageLlm（workers/triage/llm-real.ts）          ← 只搬运：prompt 逐字交 client，回包交 parseVerdict
   ▼
GatewayLlmClient（src/llm-client.ts）                ← POST {代理}/v1/chat/completions
   │     body: { model:"minimax-m2", temperature:0, messages:[{role:"user",content:prompt}] }
   │     头: x-actor-id / x-request-id（代理审计跟 run 关联）
   ▼
gateway /proxy/llm/*（票 08 的 proxy.py）            ← ★全系统唯一摸到真 key 的地方
   │     白名单字段注入占位符真值；金丝雀扫描；Authorization: Bearer <真key>
   ▼
minimax 上游（OpenAI 兼容 chat/completions）
   ▼
回包 choices[0].message.content                     ← 自由文本（可能套 markdown 围栏）
   ▼
adapter 剥围栏 → worker 的 parseVerdict 把关        ← schema 把关还在 worker，位置没挪
   ▼
verdict 写回 M2（verdict_ai + 三结局动词）
```

调查 worker 同构：plan / decide / summarize / report 四方法共用同一个 client。

## 跟着数据走：上游病了的那一刻（fail-closed 的两条路）

真模型比伪 LLM 脆弱得多——限流 429、网关没配 key 503、网络超时、输出带围栏、
干脆回一段散文。票 27 的规矩：**有降级路径的走降级，没降级路径的强杀，绝不编造**。

以"gateway 代理 503"为例（triage/llm-real.test.ts 里真链路断言的布景）：

1. `GatewayLlmClient.chat` 收到 503 → 映射成 `LlmUpstreamError(code="http_503")`。
   注意错误消息**只带代号不带上游正文**——provider 的错误文本是外部可控内容，
   不许流进我们的审计和 SSE 事件面。
2. `RealTriageLlm.verdict` 接住这个错，**不抛**，回一个必然不合 schema 的标记回包：
   `{"verdict":"llm_upstream_http_503"}`。
3. worker 的 verdict_llm 节点照票 13 的老规矩办：parseVerdict 报
   `bad_verdict:llm_upstream_http_503` → 审计记一条 `llm_retry` → 重试 1 次 → 还是病 →
   `uncertainFallback` → **verdict=uncertain + recommended_action=human**，run 照常 completed。
   告警挂人工待办——"宁可升级人工不可猜"，跟 LLM 回垃圾话时一模一样。
4. 对照组（调查 worker）：`plan` 阶段上游病了怎么办？plan 没有"编个任务清单出来"的降级路径
   ——adapter 直接抛 `LlmUpstreamError`，m3 runner 强杀 run（failed + 审计 + error 事件）。
   硬编一份任务清单继续跑才是真事故。report 不一样：它有"降级自由文本 + 标记"的老路，
   所以 report 阶段病了 → 标记回包 → 降级报告进 Timeline，body 里带着
   `llm_upstream:rate_limited` 供人排查。

墙钟兜底没换人：adapter 的 HTTP 超时读的跟 budget 三闸同一条 env 链
（`LLM_TIMEOUT_MS_<NODE>` > `LLM_TIMEOUT_MS` > 60s，决策 #4）。adapter 先掐，
`ctx.checkLlm` 的 60s 墙钟仍是最终闸——对齐，不抢闸。

## 新技术点四要素：OpenAI 兼容 chat/completions

- **名字**：Chat Completions API（OpenAI 事实标准，业界兼容形态；minimax 同款兼容）。
- **作用**：把"一次 LLM 调用"规范化成"一袋消息进、一段文本出"。之前 Fake 直接收结构化
  input 返回判定，真模型只会读文本——adapter 就是这两者之间的翻译。
- **参数**：`model`（模型名，env `LLM_MODEL` 可换）、`messages`（`[{role, content}]` 数组，
  本项目把整份 prompt 契约文本作为唯一一条 user 消息——不拆不改）、`temperature: 0`
  （SOC 判定要稳定不要创造性）、`usage.total_tokens`（回包里的计费口，喂 `ctx.charge`）。
- **用法**（本项目落点，src/llm-client.ts:81 附近）：

```ts
const res = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-actor-id": actor, "x-request-id": requestId },
  body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  signal: AbortSignal.timeout(this.timeoutMs(node)),  // 与 budget 三闸同 env 链
});
// 200 → choices[0].message.content + usage.total_tokens；429/5xx/超时 → LlmUpstreamError
```

测试里**不真出网**：`GatewayLlmClient` 构造时注入 `fetchImpl`（假 fetch，捕获请求形态、
回固定响应）——这是票 08 test_proxy.py `httpx.MockTransport` 先例在 TS 侧的等价物。

## 关键顿悟

- **seam 当年打对了，今天只换注入物**。票 13 把 `TriageLlm` 接口和 prompt 契约定为
  "事实接口"，把 Fake 挂在 `deps.llm` 上——票 27 全程没碰 flow.ts/schema.ts/prompt.ts，
  index.ts 里 `FakeTriageLlm` 换成 `RealTriageLlm(new GatewayLlmClient(...))` 就完成了生产切换。
  当日多写一层接口，日后少改十处代码。
- **fail-closed 不等于一律炸掉**。有降级路径（triage verdict → uncertain+人工；
  investigation report → 降级自由文本）就走降级——流水线不死，事情交给人；没有降级路径
  （plan/decide/summarize）就强杀——**编造才是唯一不可接受的失败**。判据是"下游有没有
  接得住这个失败的人"，不是"失败严不严重"。
- **凭证安全的最高境界是让泄露无处发生**。agent 进程 env 里根本没有 SECRETS_*，
  测试里金丝雀断言"出站体不含 SECRETS_ 值"是零成本成立——因为钥匙从头到尾只在网关
  进程，agent 拿着占位符都换不出真值。INV-4 靠架构保证，不靠自觉。
- **真模型的输出是"脏"的：`<think>` 推理段是实测出来的，不是猜的**。MiniMax-M2 的 content
  自带 `<think>…</think>` 思考前缀（真网第一次冒烟就撞上），markdown 围栏也常见。adapter
  只做无损清理（剥 think 段、剥围栏，未闭合不误吞），**schema 把关永远留在 worker**
  （parseVerdict/parseReport）——剥完还不合法就进降级路径，绝不"修"到合法为止，那是自欺。
  另一处实测：上游对模型 id 大小写不敏感，`minimax-m2` 直接可用（PRD 决策 #7 的写法原样成立）。

## 亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 0) 全部单测（真网冒烟自动能力探测：无 key 显式 skip 并打印原因——这是合法结局）
cd services/agent && pnpm vitest run 2>&1 | tail -4
# 应看到 21 files / 239 passed | 1 skipped，skip 原因含 SECRETS_LLM_API_KEY

# 1) 亲手看 mock 上游锁住的出站形态
pnpm vitest run src/llm-client.test.ts
# 应看到"出站请求形态""INV-4（agent 侧金丝雀）"等 11 条全绿

# 2) 真网冒烟（本票已真跑全通，你可以复现）：compose 起 gateway + Keychain 取 key 重跑
agent-key minimax                    # 学习项目密钥约定：供应商 key 统一在 macOS Keychain，不落盘
SECRETS_LLM_API_KEY="$(agent-key minimax)" docker compose up -d gateway
cd services/agent
SECRETS_LLM_API_KEY="$(agent-key minimax)" LLM_TIMEOUT_MS=120000 pnpm vitest run src/llm-client.test.ts
# 应看到 12 条全过（skip 消失），打印：
#   [票 27 真网冒烟证据] model=minimax-m2 tokens=913 verdict=tp confidence=0.85 action=create_case
# 网关侧同步留痕（docker compose logs gateway | grep proxy.forward）：
#   actor=agent:triage request_id=smoke-ticket-27 POST /v1/chat/completions upstream=200
# 玩完收摊：docker compose stop gateway（真 key 不留运行态）

# 3) 捣乱实验：把 compose 里 agent 的 AGENT_LLM 改成 fake 再 up，
#    跑一条告警——verdict 秒出（伪 LLM 规则判定）；改回 real（无 key）再跑，
#    观察 verdict_ai.rationale 带 llm_upstream_http_503、告警 InProgress 挂人工。
#    这就是 fail-closed 降级路径的可观察形态。
```
