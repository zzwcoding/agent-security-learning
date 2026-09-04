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
