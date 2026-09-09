# 43-01 · 安全件收敛：闸拒一处定义与出站共享件

> 票 43（重构票：F1+F3+F5+F4+F7）的教学文档。读前需要知道：agent 里六处 worker 有个叫 `gated()` 的验票包装（票 13 起的「工具调用先过闸」），guards/llm/fga 是三个出站客户端。

## 一、三问（这一阶段是干嘛的）

**位置感先行**——全部功能票已上线，这一票不添任何新功能，是给「安全代码」做一次归库整理：

```
票 04~42：功能全上线（分诊/调查/富化/对话/审批/evals/compose）
   ✅
票 43：重构——把复印了六遍的安全代码收回一份
   ↑ 你在这里（行为零变化：一行功能都不改，测试当合同）
```

- **这一阶段是干嘛的？** 一句话：**把「同一件事的六份手抄」收成一份**。体检报告（2026-09-09）F 组点名的账：`gated()` 验票闸在五个 worker flow + close.ts + 审批变体里各有一份复印件；guards/llm/fga 三个客户端各自手抄了「超时+判超时+探针」三件套。
- **什么需求逼我们这么设计？** 复印件已经**真漂移过**：guards 判超时只认 `TimeoutError`，llm/fga 认 `TimeoutError||AbortError`——同一个「对方没回话」，三家的 reason 标签口径不一样。安全代码漂移比功能代码漂移危险：今天漂的是标签，明天漂的就可能是「拒还是放」。
- **解决了什么麻烦？** 收敛之后，「**闸拒审计长什么样**」全仓只有一处定义（`src/gated-call.ts`），「**什么叫出站超时**」也只有一处定义（`src/outbound.ts`）。以后改安全口径=改一个文件；审计员问「DENIED 长什么样」，答案是唯一的一个文件:行号。

## 二、全链路一览

```
worker 六份手抄（triage / investigation / knowledge / chat / enrichment / triage-close.ts）
   │  以前：各自 30 行 gated 闭包（微差三处）
   │  现在：各留一份「差异点声明」（前缀/凭据/审计落点，≈12 行）
   ▼
src/gated-call.ts  makeGatedCall  ◀── 闸拒审计条目 + `${prefix}_gate_denied` 错误拼法，唯一定义
   │        ├─ 差异① 前缀：triage_/chat_/approval_…（参数 prefix）
   │        ├─ 差异③ 凭据：任务票带不带 caseId / 审批票带 used（参数 creds 回调）
   │        └─ 差异② 放行广播：chat 的 tool_call 多 tier 字段（参数 emitToolCall）
   ▼
src/graph.ts executeApproved（审批变体）：验票+闸拒段也走 makeGatedCall，
   凭据换 ApprovalToken+焚毁读口；放行后的焚毁/执行标记/带 result 事件
   顺序是票 11 契约，留在原处（事件顺序一动就是行为变化，不并）
   ▼
src/verify-ticket.ts verifyTicket（闸本体，票 07 就有的，一行没动）

guards-client / llm-client / fga-client / vector-store（四个出站客户端）
   ▼
src/outbound.ts  ◀── timeoutSignal / isOutboundTimeout / ProbeResult / smokeHttpProbe，唯一定义
```

## 三、跟着数据走（一条闸拒的生命之旅）

拿一条真闸拒走一遍——分诊 worker 想调 `close_alert`，但票面没这件工具：

1. **入口**：`workers/triage/flow.ts` 的 `gated(ctx, "close_alert", {...}, action)`。它已经是共享件造出来的函数（`makeGatedCall` 的返回值），worker 自己只声明过三件事：前缀叫 `triage`、凭据是 `{ticket, runId}`、闸拒审计记到 `tool_call/runId` 头上。
2. **进闸**：共享件算参数指纹 `paramsHash`（票 07 的跨语言锚），调 `verifyTicket`。票面 `allowed_tools` 里没有 `close_alert` → 回 `{allow:false, reason:"scope_insufficient"}`。
3. **闸拒（本票的意义所在）**：这一段现在只写在 `src/gated-call.ts` 一处——审计条目 `action:"deny" / result:"DENIED" / details{tool, reason, params_hash, node}`，然后抛 `triage_gate_denied:scope_insufficient`。runner 捕到这错误把 run 强杀成 failed（INV-1 不吞错）。**重构前后逐字节一样**——这是重构票的铁律：`app.test.ts` 里票 13 就锁死的「闸拒强杀 + DENIED 审计」用例，今天一个字没改、照样全绿，这就是「行为零变化」的证据。
4. **捣乱输入对照**：同样的调用换成 chat worker，唯一差别是它声明的放行广播多拼一个 `tier` 字段、凭据可能多带 `caseId`——差异全在**声明**里，闸体本体是同一个函数。以前你要读六遍代码才敢说「六处闸拒行为一致」，现在读一遍 `makeGatedCall` 就够了。

## 四、新技术点四要素：重构的安全姿势（基线先行）

- **名字**：无官方 API，方法论叫**特征化测试保护下的重构**（refactor under characterization tests）——本仓叫法：重构票的铁律「既有测试就是行为契约」。
- **作用**：重构最怕「顺手改了行为自己不知道」。解法是把测试当合同：动手前先全量跑一遍绿、记下数字（agent 417+4sk、case-backend 60、evals 99、ingest 42+1sk、web 100、mcp-audit 14）；改完再跑，**数字只能因新增测试变多，不能变少**。比喻：搬家具前先把每件家具拍照，搬完对照片——少一张都不行。
- **参数**：三条纪律。① 基线先行（先跑绿再动手）；② 测试零删除零放松（发现某测试锁的是实现细节而非行为？记票交 L0，不许自己动手改测试）；③ 新共享件自己补单测（本票新增 `gated-call.test.ts` 6 条 + `outbound.test.ts` 8 条，正是 431 = 417+14 的来路）。
- **用法**：本票实操顺序——`pnpm test` 记基线 → 收敛 F1/F3/F5/F4/F7 → `pnpm -r run test` 对数字 → `python3 tools/check_specs.py` + `pnpm check:boundary` 双闸 → 验收框逐条勾。任何一步红了，回滚自己的改动，绝不修测试凑绿。

## 五、关键顿悟

- **「复印件漂移」是重复代码最贵的代价**。六份 gated 里那句 `throw new Error(\`${prefix}_gate_denied:${reason}\`)` 看着无害，可 guards 的超时判定漂掉了 `AbortError` 就是真事故前兆——不是「有人会改错」，是「已经漂了」。收敛的成本一次性，漂移的风险是复利的。
- **收敛 ≠ 大一统：差异要参数化，不要抹掉**。chat 的 `tier` 字段、审批变体「tool_call 在验票前发出」的事件顺序，都是**各自调用方有理由的差异**。共享件把它们做成参数（`emitToolCall` 钩子），而不是逼六处统一成一个样子——那才是真行为变化。
- **版本钉死是给「时间」上的锁**。compose 里 chroma/contextforge/langfuse 早就按 digest 钉了（票 26/37），这次 openfga 补上（`@sha256:78d1fa60…`，registry 实查+本机 pull 验证与 `v1.19.0` 同一镜像）；msb CLI 没有 registry 可钉，就退一步把实测版本 `0.6.16` 写在探针旁（`sandbox.ts` msbProbe 注释）。钉不住版本，至少记录版本。

## 六、亲手验证

```bash
cd /Users/divh/Downloads/安全评估agent/soc-demo

# 1. 共享件自己的单测（闸拒长什么样，锁在这里）
pnpm -C services/agent vitest run src/gated-call.test.ts src/outbound.test.ts
#    应看到：2 个文件 14 条全绿（闸拒审计逐字段断言 + AbortError 也算超时）

# 2. agent 全量：431 passed | 4 skipped（基线 417+4sk，零删除零放松）
pnpm -C services/agent test 2>&1 | tail -3

# 3. 验证「单处定义」：闸拒错误的全仓唯一 throw 应只在共享件里
grep -rn "_gate_denied" services/agent --include="*.ts" | grep -v "\.test\.ts"
#    应看到：throw 只在 src/gated-call.ts 一行；investigation/flow.ts 那条命中是
#    消费方（按消息串识别「闸拒不吞」，INV-1），不是第二处定义

# 4. 双闸
python3 tools/check_specs.py && pnpm check:boundary
#    应看到：spec gate: PASS / boundary gate: PASS（0 越界）

# 捣乱实验：把 src/gated-call.ts 里的 result:"DENIED" 临时改成 "FAILURE"，跑票 13 的
# 闸拒用例（pnpm -C services/agent vitest run workers/triage）——应当场红一片。
# 六处调用点一行没改，红灯却全亮：这就是「安全语义集中一处」的守门效果。改回即复原。
```
