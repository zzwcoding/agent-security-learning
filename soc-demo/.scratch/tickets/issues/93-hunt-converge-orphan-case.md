# 93-hunt-converge-orphan-case: 狩猎收敛两缺陷——取消竞态孤儿案 + fake 栈零证据 hit 建案（P3）

**What to build:** 票 84（S9 教学场景）捣乱实验实测发现的两个生产缺陷，转票不就地修（learn-by-rebuild 纪律）。① **converge 顺序缺陷（孤儿案）**：`services/agent/src/orchestration/judge.ts` `converge()` 的落账顺序是 建案（cases.create，:350）→ 写 note（:359）→ 假设迁移（port.transition，:371）——迁移遇 409（人取消在轮次在途时抢先落 cancelled，m2 状态机拒 cancelled→concluded）时，案已经建出：留下"挂在已取消假设上的孤儿案"，且 run 死在 outcome（node_error），`hunt_case_created` 审计永不落——案的存在无审计痕。② **fake 栈零证据 hit 建案**：生产装配 `index.ts:193` 的 `llm: makeLoopLlm(LLM_MODE)`（AGENT_LLM=fake → llm-stubs.ts 三件套）与狩猎内容不匹配：`FakeLoopPlanner`（llm-stubs.ts:27）给一切工具发 `{q: 假设句}` 参数，不合狩猎工具签名契约（playbook_lookup 需 tag/query、graph_query 需 entity，weknora.ts:82-93）→ **每个 hunt_task 子 run 都 failed(node_error:execute)**；而 `FakeLoopJudge`（llm-stubs.ts:59）的 allOk 判据只查 `result_summary !== ""`（failed 子报告折成 `failed:node_error` 恰好非空）→ 轮 2 照判 sufficient+hit → converge 建案——教学默认栈里"命中建案"建的是**零有效证据的案子**。内容层本有匹配的确定性三件套 `makeHuntFakeLoopLlm`（hunt-pack.ts:139：按模板 waves 渲染合法参数、按取证面 total>0 判 hit/miss），但只有测试消费，生产未接线。

**铁律:** 修复不改 m2 状态机与 REST 契约；①的修法方向（迁移先行 or 建案失败补偿）由实现票定，须保 INV-10（终态不可回退）与 INV-8（建案必留审计）同时成立；②的修法方向（index.ts 按 LLM_MODE=fake 接 makeHuntFakeLoopLlm，或 FakeLoopJudge allOk 排除 failed 子报告）由实现票定，修后 S9 文章 9-2/9-6 的实测预期输出要同步翻新（行号/输出样例实测核对）。

**Touches modules:** `m14`、`m5`、`m3`

**Belongs to spec:** specs/orchestration-loop.md（行为约定 9 收敛分岔 / fake 纪律）

**Blocked by:** 无

**Status:** open

**验收：**
- [ ] ①取消竞态不再留孤儿案：轮次在途取消后，要么案未建、要么建案后迁移失败有补偿/审计痕（`hunt_case_created` 与案的存在性一致），带竞态复现测试
- [ ] ②fake 栈收敛语义修复后：AGENT_LLM=fake 下子 run 不再全部 failed 于签名契约（或 judge 不再把 failed 子报告当有效证据），hit/miss 与取证面证据有因果；S9 文章实测样例同步翻新
- [ ] 全量测试绿，零删除；INV-10/INV-8 断言不放松

**实现记录：**（待填）

---

**附：票 84 实测证据（2026-09-13，本机栈 AGENT_LLM=fake）**

① 孤儿案复现：`hyp_9fba78fd-6dee-4d0f-a9a7-5fc94647e09c`（hunt_webshell）轮 2 中途取消（轮 2 run_3daeaac5 已过 intake steps=3 时 POST cancel 200）→ 轮 2 继续跑到 outcome：converge 建出 **case_000011**（title `[hypothesis:hit] hyp_9fba78fd…`，cases.hypothesis_id 已挂）→ `port.transition(hyp,"concluded")` 409（m2 账面已 cancelled）→ run failed `node_error:outcome`（error 事件 message `…/hypotheses/hyp_9fba78fd… failed: HTTP 409`）。终态对账：假设 status=cancelled/cancel_reason=user_cancelled，**case_000011 存在且挂其上**；父 run 审计无 hunt_case_created（kill 在 converge 中途）。

② 零证据 hit 复现：冒烟主角 `hyp_0b1dccef-100b-48ba-a60c-0505a9289a9a`（hunt_webshell）两轮共 3 个 hunt_task 子 run **全部 failed(node_error:execute)**（子 run 事件流：`tool_call playbook_lookup` → `error hunt_tool_signature:lookup_requires_filter`；graph_query 同理 `entity_required`），FakeLoopJudge 轮 2 照判 `sufficient:true, verdict:"hit", confidence:0.7` → 建案 case_000010 → concluded。轮次归集（GET /api/v1/hypotheses/:id）里 rounds[0].children 两行 status 全 "failed"，judge.verdict="hit" 同屏并存。
