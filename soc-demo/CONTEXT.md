# CONTEXT.md · SOC 数字员工术语表

> 共享语言：代码命名、文档、对话都用这里的词。新术语先入表再使用。

## 角色

- **数字员工（digital employee）**：系统整体——supervisor + 4 worker agent 的人格化称呼
- **SOC1 分析师**：主用户，看分诊结果、确认/驳回关单建议；登录角色 `soc1`
- **值班长（duty_lead）**：L2 高危动作审批者
- **红队（red team）**：演示角色，操作攻击 fixture，无系统身份

## 领域

- **告警（Alert）**：Wazuh 格式流入的安全告警，TheHive 风格存储
- **案件（Case）**：TP 告警升级成的调查单元
- **分诊（triage）**：告警 → FP/BTP/TP/Uncertain 四分类的过程
- **verdict**：分诊/关案的判定结论（`false_positive / benign_true_positive / true_positive / uncertain`）
- **seam（接缝）**：模块间接口所在处，测试打在这里
- **任务票（Ticket）**：L1 写工具的授权票据，统一 TTL 900s
- **审批铸票（ApprovalToken）**：L2 高危工具经人工审批铸出的一次性票据
- **不可信字段（untrusted）**：告警中攻击者可控的字段（`full_log`/`data.*`），入库即标记
- **假设（hypothesis）**：分析师主动提出的待验证安全判断（如"内网有主机被植入 webshell"），编排循环的输入
- **轮次（round）**：编排循环的一次"选组合→扇出→收敛"迭代，轮间由证据与缺口驱动换组合
- **子 run（child run）**：一轮中被扇出拉起的独立取证 run，持本任务 narrow-scope 票，父 run 经事件唤醒回收
- **业务模板（playbook template）**：假设句式族 + 默认菜单子集 + 轮次上限的内容层数据，零机制代码
- **自主发现率**：紫队闭环指标——狩猎循环在预算内无人工干预发现攻击的比例（票 81）

## 工程

- **深模块（deep module）**：简单接口 + 大量隐藏实现；本仓库的组织原则
- **回放（replay）**：`scripts/replay.ts` 扮演外部 Wazuh，把 `fixtures/alerts/` 的告警按速率 POST 进 webhook；演示布景入口。推模式、不进 compose、绝不直接塞数据库
- **防线（D1–D8）**：八道安全防线，编号与对照见 PRD §7.1
- **狗粮接入（dogfood）**：soc-demo 作为椒图（agentjiaotu，独立安全网关，本仓安全思想的 TS 产品版）的第一个外部客户——workers 的 LLM 出站/票据申领/审批/焚毁全量改走椒图的接入形态。挂 `JIAOTU_GATEWAY_URL` env 开关，未设=默认形态逐字节不变。设计源：椒图仓 `docs/research/2026-09-10-狗粮全量接入设计.md`
- **防线换防**：狗粮形态的叙事口径——网关侧安全职能（LLM 凭证/铸票/审批/焚毁）交棒椒图，soc-demo 保留消费侧验票闸、KB 人审与业务审计；六幕剧本在此形态下重跑。定位是"原型向产品交棒"非"功能新增"：soc-demo 内部安全面=原型版教学资产，默认形态完整保留
- **jiaotu profile**：compose 第四个 profile——全外接形态：起椒图网关、**不启 soc-demo 内部 gateway**（四件安全职能运行面整体交棒）；默认形态=现九服务拓扑不动。两形态同仓共存靠配置表达，不开 git 分支
- **压力测试（压测）**：`scripts/bench/`（m13 工具面）用 autocannon 对公开 HTTP/SSE 面施压，实测四个理论天花板（分发循环 ~10 run/s / autorun 2s 消费 / SQLite 单写者水位线 / SSE 每订阅者 100ms 扇出预算）的本机真实值。设计源：`docs/research/2026-09-12-压力测试方案.md`。铁律：只走公开 HTTP/SSE 面、不 import services 内部（中立层边界规则既有口径）、fake LLM 零出网
- **压测拐点**：错误率起跳或延迟分布陡升的负载档位——压测要找的数字就是它；只同机比（每张结果表必须带机器规格），不当生产 SLO
- **过载卸载（shedding）**：`@fastify/under-pressure` 的过载保护——eventLoopDelay/heap/RSS 超阈值时自动 503，服务活着拒绝而不是压死；挂 `UNDER_PRESSURE=on` env 才装配，默认形态逐字节不变（jiaotu profile 同款开关纪律）
- **编排循环（orchestration loop）**：假设驱动的轮次机器——planner 选组合 → 扇出子 run → judge 裁决 → gap 缺口 → 再组合，直到证据收敛；循环拓扑落 dispatcher 层，LangGraph 串行链模型不动（m14 领地）
- **能力菜单（capability menu）**：planner 可选工具与剧本的登记面 = tools.manifest + 剧本库，未登记一律 fail-closed；planner 只许从菜单选组合，不许创造组合外动作
- **扇出/收敛（fan-out / converge）**：一轮内 N 个子 run 并行取证 / judge 汇总裁决；收敛判据是证据充分性，不是"该跑的跑完了"
- **hunt_flow / hunt_task**：编排循环的 run kind 名——hunt_flow=假设的循环 run（一轮一条串行链，轮间 outbox 接力）；hunt_task=扇出的子 run（标准 run 机器，narrow-scope 票）

## 语义核心

> 2026-09-08 票 18 收口沉淀：过图导览确认的领域规则，机器可校验（tools/check_specs.py）。spec 验收标准引用 `INV-x`，引用不复述。

### 状态机
| 实体 | 状态集合 | 合法流转 |
|---|---|---|
| alert | New, InProgress, Imported, Closed | New→InProgress, InProgress→Imported, InProgress→Closed, Closed→InProgress |
| case | New, InProgress, Closed | New→InProgress, InProgress→Closed |
| run | queued, running, awaiting_approval, completed, failed | queued→running, running→awaiting_approval, awaiting_approval→running, running→completed, running→failed |
| hypothesis | proposed, hunting, concluded, refuted, cancelled | proposed→hunting, hunting→concluded, hunting→refuted, hunting→cancelled |
| kbentry | proposed, approved, rejected | proposed→approved, proposed→rejected |

### 不变量
| ID | 陈述 |
|---|---|
| `INV-1` | 全链路 fail-closed：验票闸/FGA/凭证代理/注入扫描任何异常一律拒绝执行；deny 覆盖 allow |
| `INV-2` | ApprovalToken 一次性：用后焚毁登记（jti 入 used_tokens），重放必 403；改参数即失效（参数 hash 绑定） |
| `INV-3` | 任何 worker 的票据 scope 不含 L2 工具；L2 动作必须经人审批铸一次性 ApprovalToken 才可执行 |
| `INV-4` | 真凭证只存在于网关 env 与出站注入瞬间；prompt/工具调用/审计/时间线全链路 grep 不到 SECRETS_ 值（金丝雀断言） |
| `INV-5` | 只有 approved 状态的 KBEntry 进检索面；人审是知识入库唯一通道 |
| `INV-6` | 重复推送同 (source, sourceRef) 告警只 occurrences+1 并刷新 lastSeen，不新建、不重复触发流水线 |
| `INV-7` | SSE 事件自增 id 落盘；断线重连按 Last-Event-ID 补发，每个事件恰好到达一次，不丢不重 |
| `INV-8` | 任意写操作/LLM 调用/工具调用/审批/状态变更都有五要素 AuditEntry（含 diff 快照） |
| `INV-9` | 对话历史中的审批表述无签名即无效；审批唯一依据是签名 ApprovalToken（验签不信文本） |
| `INV-10` | 状态机之外的实体状态变更一律 409 InvalidTransition，不静默改写 |
| `INV-11` | 子 run 任务票 scope 严格 ⊆ 父 run 能力菜单；菜单外工具调用一律 403（遍历断言进 eval，票 76） |
