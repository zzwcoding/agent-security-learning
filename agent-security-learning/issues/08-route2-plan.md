# 路线 2 堡垒落地化方案

Type: grilling
Status: open
Blocked by: 07

## Question

图纸路线 2（microVM 隔离 → 凭证代理 → 数据脱敏管道 → 结构化审计）如何落在起步 Agent 上：

- microsandbox 的具体接入形态：哪些工具调用进 microVM（shell 工具首选？fetch 是否同进）、与现有容器化的关系
- 简易凭证代理设计（图纸建议 ~100 行自写）：替换当前 Keychain 注入的哪部分、假密钥改造成"占位符 + 出网注入"的最小流程
- Presidio 脱敏管道的数据流图：Analyzer → Anonymizer 接在 Agent 的哪个位置
- OTel GenAI 语义约定的审计字段设计（沿用 Langfuse）
- 核销路线 1 已知缺口清单中的网络 egress 项（microsandbox 白名单）

输入依赖：路线 1 的已知缺口清单、microsandbox 研究结论（issues/04）。
