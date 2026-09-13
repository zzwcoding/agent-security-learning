# 93-hunt-converge-orphan-case: 狩猎收敛两缺陷——取消竞态孤儿案 + fake 栈零证据 hit 建案（P3）

**What to build:** 票 84（S9 教学场景）捣乱实验实测发现的两个生产缺陷，转票不就地修（learn-by-rebuild 纪律）。① **converge 顺序缺陷（孤儿案）**：`services/agent/src/orchestration/judge.ts` `converge()` 的落账顺序是 建案（cases.create，:350）→ 写 note（:359）→ 假设迁移（port.transition，:371）——迁移遇 409（人取消在轮次在途时抢先落 cancelled，m2 状态机拒 cancelled→concluded）时，案已经建出：留下"挂在已取消假设上的孤儿案"，且 run 死在 outcome（node_error），`hunt_case_created` 审计永不落——案的存在无审计痕。② **fake 栈零证据 hit 建案**：生产装配 `index.ts:193` 的 `llm: makeLoopLlm(LLM_MODE)`（AGENT_LLM=fake → llm-stubs.ts 三件套）与狩猎内容不匹配：`FakeLoopPlanner`（llm-stubs.ts:27）给一切工具发 `{q: 假设句}` 参数，不合狩猎工具签名契约（playbook_lookup 需 tag/query、graph_query 需 entity，weknora.ts:82-93）→ **每个 hunt_task 子 run 都 failed(node_error:execute)**；而 `FakeLoopJudge`（llm-stubs.ts:59）的 allOk 判据只查 `result_summary !== ""`（failed 子报告折成 `failed:node_error` 恰好非空）→ 轮 2 照判 sufficient+hit → converge 建案——教学默认栈里"命中建案"建的是**零有效证据的案子**。内容层本有匹配的确定性三件套 `makeHuntFakeLoopLlm`（hunt-pack.ts:139：按模板 waves 渲染合法参数、按取证面 total>0 判 hit/miss），但只有测试消费，生产未接线。

**铁律:** 修复不改 m2 状态机与 REST 契约；①的修法方向（迁移先行 or 建案失败补偿）由实现票定，须保 INV-10（终态不可回退）与 INV-8（建案必留审计）同时成立；②的修法方向（index.ts 按 LLM_MODE=fake 接 makeHuntFakeLoopLlm，或 FakeLoopJudge allOk 排除 failed 子报告）由实现票定，修后 S9 文章 9-2/9-6 的实测预期输出要同步翻新（行号/输出样例实测核对）。

**Touches modules:** `m14`、`m5`、`m3`

**Belongs to spec:** specs/orchestration-loop.md（行为约定 9 收敛分岔 / fake 纪律）

**Blocked by:** 无

**Status:** done

**验收：**
- [x] ①取消竞态不再留孤儿案：轮次在途取消后，要么案未建、要么建案后迁移失败有补偿/审计痕（`hunt_case_created` 与案的存在性一致），带竞态复现测试
- [x] ②fake 栈收敛语义修复后：AGENT_LLM=fake 下子 run 不再全部 failed 于签名契约（或 judge 不再把 failed 子报告当有效证据），hit/miss 与取证面证据有因果；S9 文章实测样例同步翻新
- [x] 全量测试绿，零删除；INV-10/INV-8 断言不放松

**实现记录：**（2026-09-13 落，自主档 TDD；两缺陷复现测试先红后绿）

**① 孤儿案（选型：迁移先行）**
- `services/agent/src/orchestration/judge.ts`：`converge()` 落账顺序改为 **假设迁移（concluded/refuted，:355）→ 建 Case（:357-362）→ hunt_case_created 审计紧跟建案（:365-377）→ note（:378-396）→ miss 半边 register（:398-413）**。取消竞态下迁移 409 原样上抛时案还未建（零孤儿案、零审计痕，INV-10：假设留在其终态；INV-8：没建案就没有 hunt_case_created）；建案审计上移到建案成功之后立即落账——note/register 半路失败也不出「有案无账」窗口（案建了必有审计痕）。m2 状态机/REST 零改动（无 delete 案端点即不做补偿性删除；迁移成功后建案失败原样上抛交 runner 强杀口径，run failed 可回放）。
- 竞态复现测试 `judge.test.ts`「票 93① 取消竞态不建孤儿案」三例：CancelRacePort 模拟 m2 账面在 judge 已裁后被取消抢先落 cancelled（票 84 附录①同款窗口，注入点=脚本 judge）→ 断言 run failed(node_error:outcome)、案未建、零 hunt_case_created、假设终态不可回退；成功路径用 port/case 共享 trace 钉死「迁移→建案→note」顺序；第三例钉死 INV-8 防御半边（addNote 半路失败 → 案在、审计在、run 炸响、无回退）。rig() 加可选 port/cases 注入参（既有测试零改动）。

**② fake 栈零证据 hit（两处都修，票面倾向采纳）**
- 主修（接线）：`services/agent/workers/investigation/hunt-pack.ts` 新增 **`makeHuntLoopLlm(mode)`**（内容层生产选择面，:243——fake → `makeHuntFakeLoopLlm`，其余 → 机制 `makeLoopLlm` 真件；机制目录不能反向 import 内容层，故选择缝落内容层）；`services/agent/src/index.ts:196` 装配换 `llm: makeHuntLoopLlm(LLM_MODE)`。AGENT_LLM=fake 下 hunt_flow 用模板 waves 合法参数（playbook_lookup {tag}、graph_query {entity}、取证四维带 time_window），子 run 不再全部 failed(node_error:execute)；hit/miss 判据 = 取证面 total>0（hunt-pack FORENSIC_TOOLS）。
- 防御纵深（判据）：`src/orchestration/llm-stubs.ts` 新增 **`isFailedReport()`**（failed:* 摘要 / params_hash 空 / result_summary 空——await-children error 终局折账口径）并接入 `FakeLoopJudge.allOk`（failed 子报告不再因「恰好非空」被当证据）；`hunt-pack.ts` 的 hunt judge 同判据（`allExecuted`）——failed 报告既不折成 hit 也不折成 miss，按不充分进 gap 接力。
- 新测试：`src/orchestration/llm-stubs.test.ts`（新件 4+1 例：isFailedReport 形判别、FakeLoopJudge 既有行为不放松 + failed 缺陷形拒绝 + 混排/空摘要拒绝 + 首轮语义零变化、makeLoopLlm 机制缺省口径）；`hunt-pack.test.ts` 增「生产装配口 makeHuntLoopLlm」4 例（fake 接内容层三件套出合法 waves 参数、对照面机制桩盲发 {q}、fake judge 拒 failed 报告、real 档分流不出发网副作用）。既有测试桩消费面全绿（loop/flow/judge/hunt-pack/evals 只增不减）。

**S9 文章翻新**（本票授权的唯一文档改动，行号/样例全部修复后真栈 docker 实测复核）
- `lessons/scenario/9-2.md`：轮 1 hunt_plan 实测样例换成新拆条（playbook_lookup {tag:"webshell"} + web_access_query {url_pattern,time_window}）；fake 选择规则段改写为「生产 fake 档经 makeHuntLoopLlm 接内容层 makeHuntFakeLoopLlm（hunt-pack.ts:140/243），机制桩退为机制缺省件（llm-stubs.ts:39-48）」；§五①预期 C₁ = playbook_lookup + web_access_query；§五②捣乱 C 预期改退化单任务 kb_lookup（非族分支 hunt-pack.ts:149）；§五③审计分痕序列按实测修正（run 名下四条，hunt_round_outcome 挂假设实体名下）。
- `lessons/scenario/9-6.md`：调用链图与站 1 全文按迁移先行重写（judge.ts 新锚点 :342-417/:355/:357-362/:365-377/:378-396/:398-413）；实测 note 样例换真栈输出（confidence=0.8、params_hash 引用痕真起——case_000014）；cases 查询命令修投影字段名 hypothesisId；捣乱①步骤 2 家族表换新形状（子 run completed/4 步）；捣乱①结论 4 竞态变体改写为「缺陷已转票 93 修复 + 修后真栈复测」（轮 2 409 → run failed(node_error:outcome)、零案、零 hunt_case_created、审计链 create/transition/hunt_round_outcome/cancel/hunt_cancel）；防线对号「收敛 fail-closed」行与场景题 1 答案行号同步。捣乱②（预算）机制链与 token 数学（24×3）未受两修影响，实测样例保持有效。

**双闸与测试**：`pnpm test` 全绿（evals 112 / mcp-audit 14 / agent 717+3 skip / case-backend 76 / ingest 44+1 skip / web 143，零失败）；`check_specs.py` PASS、`check_boundary.py` PASS（12/12）；`check_zero_increment.py` 红（4 个机制层文件：judge.ts/judge.test.ts/llm-stubs.ts/llm-stubs.test.ts——**票面预批授权面**，机制层修复本票）。零删除：diff 只增不减（judge.test.ts 的 3 行"删除"是 rig() 签名行重排，零测试用例删除）。

---

**附：票 84 实测证据（2026-09-13，本机栈 AGENT_LLM=fake）**

① 孤儿案复现：`hyp_9fba78fd-6dee-4d0f-a9a7-5fc94647e09c`（hunt_webshell）轮 2 中途取消（轮 2 run_3daeaac5 已过 intake steps=3 时 POST cancel 200）→ 轮 2 继续跑到 outcome：converge 建出 **case_000011**（title `[hypothesis:hit] hyp_9fba78fd…`，cases.hypothesis_id 已挂）→ `port.transition(hyp,"concluded")` 409（m2 账面已 cancelled）→ run failed `node_error:outcome`（error 事件 message `…/hypotheses/hyp_9fba78fd… failed: HTTP 409`）。终态对账：假设 status=cancelled/cancel_reason=user_cancelled，**case_000011 存在且挂其上**；父 run 审计无 hunt_case_created（kill 在 converge 中途）。

② 零证据 hit 复现：冒烟主角 `hyp_0b1dccef-100b-48ba-a60c-0505a9289a9a`（hunt_webshell）两轮共 3 个 hunt_task 子 run **全部 failed(node_error:execute)**（子 run 事件流：`tool_call playbook_lookup` → `error hunt_tool_signature:lookup_requires_filter`；graph_query 同理 `entity_required`），FakeLoopJudge 轮 2 照判 `sufficient:true, verdict:"hit", confidence:0.7` → 建案 case_000010 → concluded。轮次归集（GET /api/v1/hypotheses/:id）里 rounds[0].children 两行 status 全 "failed"，judge.verdict="hit" 同屏并存。

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS + lint 复绿（子 agent 留一处 unused 形参 `input`，L0 清偿——与体检红 lint 同款教训：触碰文件 lint 必须自证）+ agent 717|3skip + evals 112 全绿零删除。零增量闸红=票面预批授权面（机制层修复），声明在案。①修法「迁移先行」认可（CasePort 无 delete，加端点=踩 REST 契约铁律；concluded 无案的残留态由 kill 审计回放交人，hunt_case_created 上移消除「有案无账」窗口）；②双层守卫（机制桩+内容层同判据）认可。收尾五样齐。