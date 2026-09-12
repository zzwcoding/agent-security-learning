# 75-judge-gap-llm-nodes: judge + gap_analyzer LLM 节点——裁决与缺口（P1）

**What to build:** m14 的收敛判据两件。① judge 节点：读本轮 N 份子报告 → 输出 {结论, 置信度, 证据充分性}；判据schema 化（不许自由文本裁决），置信度低/证据冲突时宁可继续轮次不可提前收敛（fail-closed 口径）；② gap_analyzer 节点：judge 判"不充分"时激活，把缺口翻译成下一轮 planner 输入（"A 主机可疑进程的外联未知"式结构化缺口描述）；③ 两节点的输入（子报告=上游 LLM 产物）同样过注入扫描；④ 防合谋点：judge 不得改写子报告内容，只许引用+裁决（审计留 params_hash 引用痕）。fake/real 双 adapter 同票 74 口径。验收条目逐条源自 spec（票 72 回填行号）。

**铁律:** 框架红线与边界红线同票 74；judge/gap 也不持 L2——收敛结论里若含遏制建议，只是文本建议进 timeline（沿用调查报告 recommended_actions 先例），动作永远走人工审批回路。

**Touches modules:** `m14`、`m5`

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T07/T08/T16/T17（spec 已定稿 2026-09-12）

**Blocked by:** 73

**Status:** done（2026-09-13 子 agent 施工 + L0 验收通过（2026-09-12 L2 自主档施工完成：T07/T08/T16/T17 全绿 + 双闸 PASS + 全量 pnpm test 绿（agent 599+3skip、case-backend 75、evals 99、web 111、mcp-audit 14、ingest 44+1skip——只增不减）；待 L0 验收）

**验收：**
- [x] 证据充分时单轮收敛、不充分时激活 gap→planner 再组合（轮次转换测试绿）——judge.test::T07（scripted judge 单轮 sufficient+hit → concluded + 建案，无 round_relay）+ 轮次转换组（轮 1 不充分 → gap 恰激活 1 次 → round_relay 事件 → 轮 2 planner 输入带结构化缺口 suggested_focus，轮 2 收敛）；73 的 flow.test T02 两轮轨迹（fake 档）保持绿
- [x] 子报告被注入污染时 judge 不采信被污染段（攻击 fixture 断言）——prompt-guard.test T16 judge 半边（fixtures/attack/injection/previous_output.json 毒子报告：tool_output 通道 flag → `[blocked:round_reports:0.result_summary]` 占位、原文与特征片段零进 prompt、消毒事件/审计三面零原文零金丝雀、裁决照常产出）+ gap 半边（毒缺口描述/毒证据同款占位、结构化缺口照常产出）+ guards 不可达 fail_closed 全占位（INV-1）
- [x] judge 只引用不改写（子报告 hash 前后一致断言）——judge.test::T17 两例：①正常路径 judge 输入=原件的消毒副本（result_summary 原样、params_hash=paramsHash(task.params) 可复算）、hunt_judge_verdict 审计带 evidence_hashes 引用痕；②恶意 adapter 原地改写/伪造报告 → 节点对「LLM 可触达副本」调用前后指纹比对+hash 逐一核对逮住 → hunt_judge_denied DENIED reason=report_mutated + 裁决降级不充分（不收敛、无建案），改写文本/伪造 hash 全账面零残留
- [x] fake/real 双 adapter 测试绿——FakeLoopJudge/FakeLoopGap 确定性（prompt-guard fake 档断言 sufficient+hit 可复算）；RealLoopJudge/RealLoopGap 走 ChatSeam（回包坏形 → LlmUpstreamError(bad_shape) 交节点重试半边；AGENT_LLM=real 时 makeLoopLlm().judge 不可达 → LlmUpstreamError(unreachable) 与四 worker 同款 fail-closed）
- [x] 收敛结论落 timeline 为 note 型条目（kind 枚举消费一个空位，INV-8 审计齐）——T07/T08 断言 note 条目（HttpCasePort 固定 CONCLUSION_NOTE_KIND="note"、author=agent:hunt_flow）+ structured {hypothesis_id, round_no, verdict, confidence, evidence_hashes, recommended_actions[]} 机读五痕 + m2 侧 addTimelineEntry 同事务审计 + hunt_case_created/hunt_register 五要素条目可查

**实现记录：**（2026-09-12，L2 自主档）
- ① judge 节点定稿 `orchestration/judge.ts`（flow.ts judge 节点唯一委托）：judgeRound = 消毒 → LLM 裁决（schema 校验重试 1 次）→ hash 留底比对 → 低置信降级 → 交接态 + 审计。判据 schema 化：parseJudgeVerdict（parsePlan/parseReport 同款显式验型范式，非手写解析替代）逐字段把关 {sufficient, verdict:hit|miss|null, confidence∈[0,1], gap_description|null} + 一致性（sufficient ⟺ verdict 非 null）；坏形两路同态（real adapter 抛 LlmUpstreamError(bad_shape) ≡ 假件回坏形）收进重试半边 → 再败按不充分降级 + hunt_judge_denied DENIED（fail-closed：宁可继续轮次绝不带病收敛，run 不死）；低置信地板 JUDGE_CONFIDENCE_FLOOR env（缺省 0.7，FakeLoopJudge 恰在地板上——73 测试零扰动）：sufficient 但低于地板 → 降级不充分进 gap 再来一轮（hunt_judge_verdict details.low_confidence_downgrade 可查）。
- ①' 防注入（行为 5/T16 judge 半边）：sanitizeJudgeInput——假设文本 user_input 通道、子报告 result_summary tool_output 通道（上游 LLM 产物）；非 allow 一律 `[blocked:<field>]` 占位（flag 也占位：judge prompt 是裁决面）；消毒只产出 prompt 副本，状态/轮次归集永持原件；task 对象深拷贝零共享引用。
- ①'' 防合谋（行为 8/T17）：prompt 引用凭据=tool+params_hash+消毒摘要（不含 params 原文）；节点对 LLM 可触达副本调用前快照、调用后指纹比对+params_hash 与原件逐一核对——改写即裁决无效（report_mutated DENIED + 降级不充分）；evidence_hashes 进 hunt_judge_verdict 审计与 note structured（params_hash 引用痕）。
- ② gap_analyzer 节点定稿 `orchestration/gap.ts`：analyzeGap（judge 判不充分时由 outcome 激活）= 消毒（judge 裁决+既有证据全走 tool_output 通道）→ LLM 翻译 → parseGap 显式验型 {gap_description, unknown, suggested_focus[]}（重试 1 次）→ 再败按机制档缺口降级 + hunt_gap_denied（翻译失败≠停摆，防转指纹闸归票 76/77 兜底）；产物随 recordRound 落 m2 gap 段 = 下一轮 planner 输入 + 相邻轮指纹含 gap hash 的素材；审计 hunt_gap_suggest（INV-8）。
- ③ 收敛分岔（行为 9）`judge.ts converge`：hit → 建 Case 挂 hypothesis_id（复用 m2 建案公开路径 POST /api/v1/cases）+ transition(concluded)；miss → transition(refuted) + hypothesis_register（ports.ts 新缝 HypothesisRegisterSeam，`orchestration/register.ts` 缺省内存桩记 proposed——工具本体/验票闸/真 Memory stub 归票 79，T08 断言调用发生且 status=proposed + hunt_register 审计）；两分支都落 note 型 TimelineEntry（收敛结论 + evidence_hashes + 遏制建议文本）。
- ③' m2 建案端点接口细化（spec 授权，最小增量）：`services/case-backend` POST /api/v1/cases 接受可空 `hypothesis_id` 入参（app.ts 入参 + store.ts createCaseManual 透传 + insertCase 落 hypothesis_id 列——列票 73 已建）+ hypotheses.test 补 1 例（落列/读面同源/缺省 null 既有行为零扰动）；建案审计 details 带 hypothesisId。
- ③'' CasePort/register 生产装配零格补：OrchestrationDeps 增可选 cases?/register?——cases 缺省 `orchestration/case-port.ts` HttpCasePort（m2 公开 REST，hypothesis-port.ts 同款 adapter 纪律，R1）；register 缺省内存桩（scan 缝同款缺省法），index.ts 除 LLM 切换行外零改动。
- ④ fake/real 双 adapter：fake=票 73 桩原样；real=`llm-real.ts` 增 RealLoopJudge/RealLoopGap（与 RealLoopPlanner 共用 ChatSeam，坏形抛 LlmUpstreamError(bad_shape)、timeout/unreachable 原样上抛强杀 INV-1）；`makeLoopLlm` real 分支三件齐（同一 GatewayLlmClient seam，actor=agent:hunt_flow）。**index.ts 生产装配切换（74 移交）落地**：`llm: makeFakeLoopLlm()` → `llm: makeLoopLlm(LLM_MODE)`（LLM_MODE=AGENT_LLM env 链，与四 worker 同一总口；切换同一行的 import 与紧邻失实注释一并更正，无其他改动）。
- 偏差声明（L0 备案，三项均为票内解读非越界）：① miss 半边 note TimelineEntry 的承载面——TimelineEntry 在 m2 是 case 作用域（无假设时间线端点），PRD §13.5②「未命中落 note 型 TimelineEntry」实现为归档案：复用建案公开路径建归档案挂 hypothesis_id，note 条目承载证伪摘要（hit=命中建案、miss=归档案，同一 CasePort 缝）；② 遏制建议文本通道——spec judge 输出契约四字段一字未动，adapter 可在 seam 层附带可选 containment_suggestions（string[]），形把关+tool_output 通道消毒后只进 note 的 recommended_actions 文本（investigation recommended_actions 先例），永不进 m2 judge 轮次账面（恰四字段，T07 断言）与任何动作/审批通道（INV-3/9）；③ 低置信地板数字 0.7 为机制档（env 可调，spec 未定数，票 77 回测可调档）。
- 测试（TDD，测试先于实现、写在 seam 处）：新增 `orchestration/judge.test.ts` 8 例（T07 两例含 INV-9 断言：遏制建议只是文本进 note、全审计流无 approval/execute 动作、register 未被调、m2 judge 记录恰四字段；T08 miss_archives；T17 两例；轮次转换三例：gap→planner 再组合/schema 降级 fail-closed 接力/低置信降级）+ `orchestration/prompt-guard.test.ts` 增 6 例至 12（T16 judge 半边 2 + gap 半边 1 + makeLoopLlm real 档 judge/gap 3）；`flow.test.ts`/`planner.test.ts` rig 各注入 cases/register 假件（74 给 rig 加 scan 假件同款缝处改动，断言零变）。全量 `pnpm test`：agent 599 passed|3 skipped（585→599 只增）、case-backend 75（74→75 只增）、evals 99+eval 33/33、web 111、mcp-audit 14、ingest 44+1skip；双闸 `python3 tools/check_specs.py` PASS（0 警告）、`python3 tools/check_boundary.py` PASS（0 越界，12/12）。
- **L0 验收（主窗口，2026-09-13）**：亲跑双闸 PASS + agent 599 passed|3 skip + case-backend 75 passed 均绿只增；index.ts 生产切换 diff 核实（makeLoopLlm 装配 + 缺省缝件注释，确为一行级）；case-backend 接口细化为 spec 授权最小增量（POST /cases 可空 hypothesis_id）。三项票内解读**均接受**：①miss 归档案语义（TimelineEntry case 作用域的结构性要求，hit/miss 同一 CasePort 缝；记入 modules.md 无需——m2 卡公开接口未变，语义在票记录与 spec 行为 9 注释）；②containment_suggestions 为 adapter 层可选扩展（m14 契约四字段一字未动）；③JUDGE_CONFIDENCE_FLOOR=0.7 env 可调（**档位复核归 77**，77 简报已带此句）。收尾五样齐；register 真工具归 79（T22 由 79 兑现）。