# TERMS · 场景导览术语表（业务比喻 ↔ 代码落点 ↔ 为什么）

> 学卡词翻这张表，不用反复问。比喻体系以已发布 31 篇场景文章为准（数字员工/保安处/手令/叫号屏/档案室/派活的/看板的）；
> 学习中若发明了新叫法，对表收编成"又称"，**不要另起一套**——两套比喻并存是理解灾难。
> 三栏：业务比喻（又称）| 代码真实落点 | 为什么这样设计。文章开头应链接本表。

## 人与窗口

| 比喻（又称） | 代码落点 | 为什么 |
|---|---|---|
| 演示员（替探头跑腿的人） | `scripts/replay.ts` | 告警该由 Wazuh 探头推来；教学里用脚本扮演它，推模式、绝不直塞数据库——入口真实才能教入口 |
| 报案单 | `fixtures/alerts/*.json` | 一份 Wazuh 格式告警 JSON；fixture 进 git=每次演示同一批真实素材 |
| 前台/收案窗口 | `services/ingest`（:3001） | 能不能收案的第一道门：验型 422、severity 映射都在门口做，脏数据不进屋 |
| 档案室 | `services/case-backend`（:3002，SQLite） | 档案（告警/案件/审计/KB 账面）归它管；跨服务只走 REST，谁也不能翻墙开柜 |
| 数字员工 | `services/agent`（:3003） | 自动干活的进程；"员工"因为它是被治理对象——自己一滴权限都没有 |
| 保安处 | `services/gateway`（:8002，Python） | 唯一签票/凭证托管方；员工的一切出站授权都从这里领 |
| 值班长 | 审批人（web 页点批准的人） | 手里有钥匙的人；L2 高危动作等他点头 |
| SOC1（一线值班员） | 角色 `soc1` | 权限最小角色：能查能录，不能批、不能反查 PII——职责口径的对照组 |

## 排队与拉起

| 比喻（又称） | 代码落点 | 为什么 |
|---|---|---|
| 叫号屏 | `outbox_events` 表（M2 库） | 事务型 outbox：档案室办完业务同事务写屏，档案和叫号永远对得上（INV-6 家族）。**常见误读**：以为可以用 Kafka 替代——能但杀鸡用牛刀，单机 SQLite + 轮询就是这个量级的最简解 |
| 看板的 | `autorun` 循环（agent 进程，2s tick） | 每天瞄一眼叫号屏，看到新号自动拉活；事件驱动的"不睡觉的人" |
| 派活的（派活清单） | `run-dispatcher` 循环 + `run_jobs` 表（100ms tick） | 任务先落表、循环再领。**四层看**：①表=待办清单（HTTP 秒回后活躺在表里）②循环=唯一领单人（全系统就 1 个，不存在等谁抢）③翻状态防双吃（`pending→claimed` 在事务内翻，数据库原子性=防重副本/重启窗口/并发测试）④领了不等于立刻做完（还要铸票/组图才开跑）。**常见误读**：以为 202 和派活循环有触发关系——没有，202 是给调用方的回执，循环只认表 |
| 拉起正门 | `POST /internal/runs`（agent） | 工种拉起唯一入口；只做校验/立案/入队+202 秒回，**不跑流水线** |
| 工种/注册表 | `run-kinds.ts` 的 `REGISTRY`（5 种 flow） | **身份是门卫不是档案柜**：拉起前先查（时序在立案的合法性判定里），查完才知道铸什么票、组什么图。**常见误读**：①"立案了才去查"——反了，查注册表是立案合法性的一部分；②"查一次就完了"——执行器组图时还会查同一个（票面真相源在注册表，两处读的是同一份）；③"注册表和告警能有什么关系"——告警决定走哪个工种，工种决定这张票允许动什么工具（AI 不能碰 L2，防误杀）。**分层**：工种=身份（这张 run 是谁）｜票面=权限（能动哪些工具）｜组图=流水线（干活的工序） |
| 游标/水位线 | `event_cursors` 表 | 看板的看到第几号了；失败不动游标=下轮重看，跳过才推=至多一次 |

## 票与闸

| 比喻（又称） | 代码落点 | 为什么 |
|---|---|---|
| 手令/任务票（Ticket） | HMAC 三段 token，900s | L1 写工具的授权票：写清能动哪个工具、几点失效；员工开工前必须领。**四层拆解**（学习者实测拆 7 问才讲透，故预分层）：①凭证层=手令本身（为什么要有：员工零权限，出站授权全靠它）②签名层=HMAC（密钥给内容算指纹，没密钥造不出假票；密钥 .env 定义、gateway 持有、agent 只验不签）③时效层=900s TTL（过期闸拒）④权限层=票面（见下行）。比喻"手令"只覆盖①④，②③在文章里首次出现要打"这是第几层"招呼 |
| 票面 | 票 payload 的 sub/scope/allowedTools | 印在票上的字；闸只认票面不认人嘴——员工自作主张在物理上不可能（INV-3）。票面的**内容来源**是注册表（铸造前按工种查出 sub/scope/allowedTools 印上去），所以"执行器组图时又查注册表"和"铸票前查注册表"读的是同一份真相 |
| 闸体/闸 | `gated-call.ts` 的 `gated()` | 每次工具调用的唯一动作入口：亮票→验票→执行→记账四步舞；安全语义只许一份拷贝（票 43 教训） |
| 审批卡 | agent `approvals` 表的卡 | L2 高危动作的"待批条"：run 挂在 awaiting_approval，卡是唯一真相 |
| 一次性密令（ApprovalToken） | HMAC 票，300s，批准时才铸 | L2 专用：一动作一铸、用后即焚；批准≠执行（批完先秒回，执行在 resume 之后） |
| 焚毁/坟场 | `used_tokens` 表（M2 库） | 用过的票落账；重放票在闸前先查坟场——查无此人也是账，读口病了 fail-closed（INV-1/2） |
| 意图闸 | chat worker 的 intent_gate（FGA） | 对话里冒出的高危动作先过权限三态（allow/require_approval/deny）；可见≠可直查 |

## 知识与防线

| 比喻（又称） | 代码落点 | 为什么 |
|---|---|---|
| KB 账面 vs 检索面 | M2 `kb_entries` 表 vs agent 侧 chroma | 两扇窗：账面走人审状态机，检索面只有"正门批准"才写入（INV-5）——绕过账面翻账查无 |
| KB 人审闸 | case-backend kb proposals + web 审批 | 提案必须人点头才进检索面——"会搭更会防"的根（INV-5/9） |
| 安检员 | `services/guards`（:8001，llm-guard+Presidio） | 出站扫描：注入话术打标/拦截、PII 脱敏；拦下也要记账（DENIED 审计） |
| 取餐铃（SSE） | `/api/v1/events` SSE 流（100ms 推送） | 异步任务的进度直播；站柜台等 vs 铃响取餐 |
| 留痕 | M2 `audit_entries` 表 | INV-8：写操作必留台账；"执行没发生"的证明=事件流里少一对工具帧 |
| 防线换防 / 狗粮接入 | 椒图 agentjiaotu 集成形态（`JIAOTU_GATEWAY_URL` 开关） | 本仓安全思想的 TS 产品版（椒图）来接管网关侧安全；默认形态逐字节不变——见 CONTEXT.md |
| 防重三闸 | `dup_batch`/`run_exists`/`kb_exists` | 同一事件重放不会重起流水线/重复提案——事件桥的至多一次口径 |

## 编排循环

> 票 89 新增节。一句话定位：报案电话（S1 告警链）之外，数字员工的**主动狩猎环**——
> 拿一份侦查怀疑书，一轮一轮"选组合→扇出→收敛"，直到证据够定性。机制代码全在
> `services/agent/src/orchestration/`（m14 领地），业务内容全在 fixtures/（内容层数据）。

| 比喻（又称） | 代码落点 | 为什么 |
|---|---|---|
| 侦查怀疑书（又称：狩猎立项，hypothesis） | `case-backend/src/hypotheses.ts:107`（建档+`hypothesis.created` 同事务 ：122）；状态机 `case-backend/src/statemachine.ts:27`；拉起轮 1：`src/autorun.ts:218` | 被动等报案单之外数字员工主动写下的"待验证怀疑"（如"web01 被植了 webshell"）——主动环的入口。提出即落档案室账面、同事务发事件（INV-6 家族）；五态走 m2 状态机，终态不可回退、表外迁移 409（INV-10）。提出者不止人：紫队 eval（S12）里攻击 fixture 自动转怀疑书（actor=system）。**常见误读**：把怀疑书当案件——案件（case）是查实后的案卷，怀疑书是查证前的立项，hit 收敛才建案挂钩 |
| 查证轮（又称：一轮，round） | 六节点轮次链 `src/orchestration/flow.ts:41`（intake→planner→dispatch→await_children→judge→outcome）；轮号簿记 `hunt_run_links` 表 `src/orchestration/ledger.ts:41`；轮次归集回假设账面 `case-backend/src/hypotheses.ts:204`（(hypothesis_id, round_no) 唯一） | 一次"选组合→扇出→收敛"的完整来回，轮间由证据缺口驱动换组合。**循环性不在图里**：图内永远一轮一条串行链（ADR 0005），下一轮由接力件订阅 round_relay 事件拉起（`src/orchestration/relay.ts:26`，幂等锚 ledger.findByRound）。**预算双闸**：run 级闸先抛、轮级闸后抛（flow.ts:52-69 节点包装层 + budget.ts:127 轮档），max_rounds 硬顶开跑前即拒（flow.ts:94）——防一个怀疑烧穿全仓预算。**防转指纹**：任务集+gap 摘要双双原地踏步=拒组合、转 cancelled(spin)，不冒充 refuted（planner.ts:250 产指纹、flow.ts:152-170 查）——"换轮必须换组合"是闸不是建议 |
| 单趟差（又称：取证子 run，child run / hunt_task） | 图 `src/orchestration/task-flow.ts:18`（intake→plan→execute→report）；拉起+簿记 `src/orchestration/launcher.ts:35`；真执行体装配注入 `workers/investigation/hunt-executor.ts:108`（不注入=机制桩原样） | 一轮里派出去的一趟差事：独立 run 行，只带一张"只许干这一件事"的窄手令。**权限按任务收窄**：子票面=该任务唯一工具（run-kinds.ts:351），任务工具不在父菜单内直接拒铸（run-kinds.ts:347-349，INV-11 铸票缝）——扇出 N 路 ≠ 发一张大票跑全程。父**不盯表不轮询**：子 run 终态发 `hunt_task_finished` 事件（task-flow.ts:76），父经事件唤醒回收（`src/orchestration/await-children.ts:38`，订阅先于派工=事件不丢）；父链取消后子 run 在下一个节点边界安全停（`src/orchestration/cancel.ts:78`） |
| 派工菜单（又称：菜单围栏，capability menu） | 每轮可见菜单=模板圈定的子集（机制默认档 `src/orchestration/template.ts:9`；父票面单一来源 `workers/investigation/hunt-pack.ts:88`）；越界两道闸：planner 契约拒（`src/orchestration/planner.ts:235-238`）+ 铸票缝拒（run-kinds.ts:347） | 拟单只能照菜单点，菜单外后厨不做——planner 自己也是 LLM、不可信，**越动态，闸越不能松**。菜单真源是模板注入的子集，机制不持第二份工具清单（分层铁律）；"票面 ⊆ manifest" 由 tools-manifest 对账测试咬死。INV-11 的第一道闸在 planner（选不得），第二道在铸票缝（签不出越界票）——两道独立成立，绕过一道还有一道 |
| 撒出去·收回来（又称：扇出/收敛，fan-out/converge） | 扇出：`src/orchestration/flow.ts:136-207`（dispatch 逐任务拉起）；收敛分岔：`src/orchestration/judge.ts:335`（converge：hit 建案挂 hypothesis_id / miss 归档+register） | 一次派几路单趟差并行取证，回来对齐口供定"证据够不够"。并行**不并权**（每路自己的窄票）；收敛判据是**证据充分性**，不是"该跑的跑完了"——judge 输出 schema 化判据（judge.ts:91），sufficient 但置信度低于地板（缺省 0.7，judge.ts:53）一律降级不收敛、进 gap 再来一轮：宁可多轮补查，绝不带病定案 |
| 循环三件套（又称：拟单的/拍板的/找缺口的——planner·judge·gap 三个 LLM 决策面） | `src/orchestration/planner.ts:162`（planRound：消毒→schema→菜单闸→截断）；`src/orchestration/judge.ts:174`（judgeRound；防改写留底比对 :196）；`src/orchestration/gap.ts:121`（analyzeGap：结构化缺口） | 三个决策面同一纪律：**prompt 是决策面不是证据面**——假设文本与上游 LLM 产物进 prompt 前逐一过安检员消毒，非 allow 一律占位符、原文零进 prompt（INV-4 邻域卫生）；输出一律 schema 显式验型，不许自由文本裁决/缺口，坏形重试一次再败 fail-closed（不编造）。拍板的防合谋：只许按 params_hash 引用子报告、只引用不改写（改写即裁决无效）。**审计分痕**：拟单的建议（hunt_plan_suggest，planner.ts:254）与实际决定（hunt_dispatch_decide，flow.ts:194）两个 action 分开可查——"路由建议"与"路由决定"是两笔账 |
| 无人值守破案率（又称：自主发现率） | `evals/src/rigs/purple.ts:298`（discovery_rate_ground_truth，spec T23）；产物 `eval-results/purple-team.json`（逐例发现率表+盲区聚类） | 紫队闭环的成绩单：不给值班长递条子、预算内自己抓到攻击的比例。发现判定走 ground truth 断言+签名机器复核，**不靠 LLM 自评**（judge 评分零进门禁）；预算口径写死（轮数≤机制硬顶且≤模板档、token≤run 档；cancelled 不冒充发现）——防"无限烧 token 必发现"的注水质疑。没抓到的也不白跑：gap 产物聚成盲区报告（哪条证据链缺失、该补哪个工具维度）——诚实的阴性资产 |
| 预案卡（又称：业务模板，playbook template） | 数据 `fixtures/hunt-templates/*.json`（4 张卡：webshell/C2 外联/凭据外泄/IR 主机失陷）；装载登记 `workers/investigation/hunt-pack.ts:51`、:64（未登记 id 落机制默认档）；机制侧只有格式契约 `src/orchestration/template.ts:9-21` | 一族怀疑一张卡：假设句式族、菜单子集、轮次/任务上限、既定查询计划全写在卡上。**分层铁律的活教材**：机制层写一次（循环只认格式契约+上限四字段），业务内容全是数据——加第二个业务零机制增量，diff 与 m14 交集为空（票 80 断言，S11 主角）。菜单收窄即选路空间收窄：应急卡里 planner 看不见 web 工具——**动态性是有边界配置的**。别与 weknora「剧本库」（playbook_lookup 查的查询参考册）混一张卡：预案卡管循环怎么排，剧本库管查询怎么抄 |

## 状态机速记

| 词 | 合法流转 | 卡点 |
|---|---|---|
| run | `queued→running→awaiting_approval?→completed/failed` | awaiting_approval 只在等审批；failed 必带 failReason |
| alert | `New→InProgress→Closed`；Closed 不可重开 | verdict 定了才能关；`M2_FINAL_VERDICTS` 门口再验 |
| 审批卡 | `pending→approved/rejected/expired`，终态再裁 409 | 先到者赢；过期也是裁决（actor=system:approval_ttl） |
| KB 提案 | `proposed→approved/rejected`，终态再裁 409 | approved 只是账面，进检索面必须走正门执行体 |
| 假设 | `proposed→hunting→concluded/refuted/cancelled`，终态不可回退 | 首轮开跑前置 hunting（远端 409 原样上抛=不带病开跑）；取消六因（user_cancelled/planner_broken/spin/budget/time/budget_rounds）只是 cancelled 的原因标注，不是独立状态（INV-10） |
