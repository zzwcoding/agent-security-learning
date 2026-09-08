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

## 工程

- **深模块（deep module）**：简单接口 + 大量隐藏实现；本仓库的组织原则
- **回放（replay）**：`scripts/replay.ts` 扮演外部 Wazuh，把 `fixtures/alerts/` 的告警按速率 POST 进 webhook；演示布景入口。推模式、不进 compose、绝不直接塞数据库
- **防线（D1–D8）**：八道安全防线，编号与对照见 PRD §7.1

## 语义核心

> 2026-09-08 票 18 收口沉淀：过图导览确认的领域规则，机器可校验（tools/check_specs.py）。spec 验收标准引用 `INV-x`，引用不复述。

### 状态机
| 实体 | 状态集合 | 合法流转 |
|---|---|---|
| alert | New, InProgress, Imported, Closed | New→InProgress, InProgress→Imported, InProgress→Closed, Closed→InProgress |
| case | New, InProgress, Closed | New→InProgress, InProgress→Closed |
| run | queued, running, awaiting_approval, completed, failed | queued→running, running→awaiting_approval, awaiting_approval→running, running→completed, running→failed |
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
