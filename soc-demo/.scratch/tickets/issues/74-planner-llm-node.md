# 74-planner-llm-node: planner LLM 节点——拆假设选组合（P1）

**What to build:** m14 的 planner 节点定稿。① prompt 契约落地：输入=假设 + 已有证据 + 缺口描述 + 能力菜单（**只许选 tools.manifest 登记工具，未登记即非法输出**）；输出 schema=任务组合 C_k（任务清单：工具+参数+依据），schema 校验失败走降级（重试一次→仍败置本轮为空组合并落审计，fail-closed 不编造）；② fake adapter（确定性拆条，测试用）+ real adapter（走 llm-client 现有 seam + 凭证代理，真出网开关同现有口径）；③ 防注入：planner 输入里的调查报告（上游 LLM 产物）进 prompt 前过 guards /scan/injection（沿用 investigation 的 scanField 先例）；④ "路由建议 vs 路由决定"分痕：planner 输出落审计（INV-8），但拉子 run 的铸票以决定为准。验收条目逐条源自 spec（票 72 回填行号）。

**铁律:** 框架红线——禁手写 JSON 解析替代 schema 校验（用现有 schema.ts 范式）；边界红线——planner 不持 L2 通道（INV-3），它只输出组合，执行永远是 dispatch 的事。

**Touches modules:** `m14`、`m5`（复用 scan/seam）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T03/T04/T05/T16（spec 已定稿 2026-09-12）

**Blocked by:** 73

**Status:** done（2026-09-12 L2 自主档施工完成：T03/T04/T05/T16 全绿 + 双闸 PASS + 全量 pnpm test 绿（agent 585+3skip、case-backend 74、evals 99、web 111、mcp-audit 14、ingest 44+1skip——只增不减）；L0 验收通过 2026-09-13）

**验收：**
- [x] 输出 schema 校验 + 降级路径测试绿（坏输出不炸 run，落审计）——planner.test::schema_degrade（恰重试 1 次/同一消毒输入重放/DENIED 审计/空轮归集/run completed）+ schema_retry_recovers（重试救回照常出子 run）
- [x] 菜单外工具选择 100% 被拒（断言非法输出不产出子 run）——planner.test::offmenu_rejected（不 retry 恰 1 次调用、childrenOf=0、hunt_plan_denied DENIED reason=offmenu_tool、无 hunt_dispatch_decide）
- [x] 注入变体报告进 prompt 前被 guards 拦截（攻击 fixture 复用）——prompt-guard.test::poisoned_report_scanned（fixtures/attack/injection/previous_output.json 毒负载；block/flag 双路占位符、原文与特征片段零进 prompt、消毒事件/审计只记字段不记原文）
- [x] fake/real 双 adapter 测试绿；real 出网开关语义与现有 LLM 件一致——RealLoopPlanner 走 ChatSeam（GatewayLlmClient 结构适配）；prompt-guard「makeLoopLlm 出网开关」describe：fake 档确定性拆条零出网 / real 档经 llm-client 出站且不可达时 LlmUpstreamError(unreachable) 与四 worker 同款 fail-closed
- [x] planner 建议/决定审计分痕可查（审计条目两个 action 区分）——hunt_plan_suggest（A，planner.ts）与 hunt_dispatch_decide（B，flow.ts dispatch）两条五要素 SUCCESS 可查（T03 断言同帧双条 + children 一致）；拒绝落 hunt_plan_denied（DENIED）

**实现记录：**（2026-09-12，L2 自主档）
- ① planner 节点定稿 `orchestration/planner.ts`：prompt 契约 buildPlannerPrompt（输入 {hypothesis_text,evidence_so_far[],gap|null,menu[],template{max_rounds,max_tasks}} 的确定性渲染，机制层无业务话术，R10）；输出 schema parsePlan（{tasks:[{tool,params,rationale}]}，tasks≥1，investigation parseReport 同款显式验型范式，非手写解析替代）；降级行为 3——schema 失败同一消毒输入重试 1 次（tokens 逐次 charge 计入口径）→ 再败本轮终止（fail-closed 不编造）+ hunt_plan_denied DENIED，run 不死；菜单 fail-closed 行为 4——菜单外工具不 retry 直接终止（对全量输出把关，含将被截断的任务；工具名截 64 字符入库防 provider 可控长文本进审计）；T03 超 max_tasks 截断+建议审计 truncated=true 不拒整轮。
- ①' 防注入（行为 5/T16）：sanitizePlannerInput 逐不可信段过 ScanSeam（ports.ts 新缝；生产缺省=guards-client scanInjection 公开缝，m5 investigation 先例，禁触 guards 服务内部）——假设文本走 user_input 通道、证据/缺口（上游 LLM 产物）走 tool_output 通道；allow 留原文/strip 用清洗文本/block·flag·fail_closed 一律 `[blocked:<field>]` 占位（flag 也占位：planner prompt 是决策面非证据面，与 investigation observe() 证据保全语义刻意不同）；原文零进 prompt、消毒事件/审计只记字段+判定+score。
- ①'' 连续两轮失败→cancelled(planner_broken)：失败轮归集形=空组合且 judge=null（intake 读上轮归集判 prev_planner_failed，不扩 m2 RoundRecord schema）；outcome 空轮归集→prev 失败则 PATCH cancelled{reason:planner_broken}，否则接力下一轮（relay 既有件），max_rounds 兜底 cancelled(budget)。
- ② fake/real 双 adapter：fake=票 73 FakeLoopPlanner 原样（确定性拆条）；real=`orchestration/llm-real.ts` RealLoopPlanner——走 src/llm-client.ts 既有 ChatSeam（GatewayLlmClient→gateway /proxy/llm/* 凭证代理），坏形抛 LlmUpstreamError(bad_shape) 交节点重试半边，timeout/unreachable 原样上抛强杀（与 investigation plan/decide 同款 INV-1）；装配总口 `llm-stubs.ts makeLoopLlm(mode=AGENT_LLM env)`（fake→桩，其余→real），judge/gap 真件归票 75。
- ④ 审计分痕：hunt_plan_suggest（建议 A，planner.ts）/ hunt_dispatch_decide（决定 B，flow.ts dispatch，原 hunt_dispatch 更名——全仓 grep 零外部引用）；recordAudit+HUNT_ACTOR 上提 `orchestration/audit-log.ts`（免机制目录内循环 import）。
- 接线：flow.ts planner 节点换 planRound 真节点；dispatch/judge/outcome 加 planner_failed 本轮终止分支（无决定即无 B 半边、无子 run）；ports.ts 新增 ScanSeam+OrchestrationDeps 本体上移（flow.ts 保留 re-export，既有 import 路径零改动）+ OrchestrationDeps.scan 可选缝（缺省 scanInjection，index.ts 装配零改动即向后兼容）。
- 测试（TDD，写在 seam 处）：`orchestration/planner.test.ts` 6 例（T03/T04/T05/schema_retry_recovers/planner_broken 两轮取消/单轮失败不误伤）+ `orchestration/prompt-guard.test.ts` 6 例（消毒映射单元/T16 poisoned_report_scanned/guards 不可达 fail-closed/INV-4 金丝雀出站体/makeLoopLlm 开关两档）；既有 flow.test（73 两轮轨迹）/autorun-hunt.test 补一行 allow-all scan 假件注入（缝处最小改动，语义零变）。
- 偏差记票（L0 备案）：① index.ts 生产装配仍 makeFakeLoopLlm()（该文件在本票禁改清单外）——makeLoopLlm 开关已就绪+测试锁口径，AGENT_LLM=real 的生产切换是一行装配改动，归票 75（judge/gap 真件同期）或装配票；② hunt_dispatch→hunt_dispatch_decide 更名（分痕可读性，零回归）；③ 连续失败判定不扩 m2 schema（轮次归集空轮+无 judge 即失败轮标记）。
- **L0 验收（主窗口，2026-09-13）**：亲跑双闸 PASS + agent 包 585 passed|3 skipped EXIT=0（T03/T04/T05/T16 断言形态核对过：截断不拒轮/菜单外零 retry 子 run 恒 0/重试计步/毒报告三面零泄漏）；变更清单 11 文件全在 orchestration/ + 一个测试缝行。偏差处置：**①接受**——index.ts 生产切换一行归票 75（L0 已在 75 派发简报钉死该项，防两票都不接）；**②③接受**（分痕可读性/不扩 schema 均为合法实现取舍）。收尾五样：spec 无出入 / modules.md 无需同步（无公开接口变更，审计 action 名为实现事实）/ CONTEXT 无新术语 / 施工日志=本记录 / 架构投影无出入（冻结源 JSON planner 组件语义未变）。