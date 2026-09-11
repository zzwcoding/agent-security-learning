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
| 叫号屏 | `outbox_events` 表（M2 库） | 事务型 outbox：档案室办完业务同事务写屏，档案和叫号永远对得上（INV-6 家族） |
| 看板的 | `autorun` 循环（agent 进程，2s tick） | 每天瞄一眼叫号屏，看到新号自动拉活；事件驱动的"不睡觉的人" |
| 派活的（派活清单） | `run-dispatcher` 循环 + `run_jobs` 表（100ms tick） | 任务先落表、循环再领——HTTP 秒回和真干活解耦（异步化）：崩了能续跑、前端有 SSE 可看 |
| 拉起正门 | `POST /internal/runs`（agent） | 工种拉起唯一入口；只做校验/立案/入队+202 秒回，**不跑流水线** |
| 工种/注册表 | `run-kinds.ts` 的 `REGISTRY`（5 种 flow） | "系统能干什么活"的清单：吃什么事件、铸什么票、组什么图，一张表管全仓 |
| 游标/水位线 | `event_cursors` 表 | 看板的看到第几号了；失败不动游标=下轮重看，跳过才推=至多一次 |

## 票与闸

| 比喻（又称） | 代码落点 | 为什么 |
|---|---|---|
| 手令/任务票（Ticket） | HMAC 三段 token，900s | L1 写工具的授权票：写清能动哪个工具、几点失效；员工开工前必须领 |
| 票面 | 票 payload 的 sub/scope/allowedTools | 印在票上的字；闸只认票面不认人嘴——员工自作主张在物理上不可能（INV-3） |
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

## 状态机速记

| 词 | 合法流转 | 卡点 |
|---|---|---|
| run | `queued→running→awaiting_approval?→completed/failed` | awaiting_approval 只在等审批；failed 必带 failReason |
| alert | `New→InProgress→Closed`；Closed 不可重开 | verdict 定了才能关；`M2_FINAL_VERDICTS` 门口再验 |
| 审批卡 | `pending→approved/rejected/expired`，终态再裁 409 | 先到者赢；过期也是裁决（actor=system:approval_ttl） |
| KB 提案 | `proposed→approved/rejected`，终态再裁 409 | approved 只是账面，进检索面必须走正门执行体 |
