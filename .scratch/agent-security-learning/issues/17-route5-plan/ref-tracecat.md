# Tracecat 参照分析（路线 5 · 票 17 阶段 A）

> 研究日期：2026-09-04。对象：https://github.com/TracecatHQ/tracecat （约 3.8k star，AGPL-3.0，EE 目录单独商业许可）。
> 信息主要来自官方 README 与 docs.tracecat.com 文档站，个别二手来源已标注。

## 1. 解决什么需求

- **定位**：开源的 Tines / Splunk SOAR 替代品，自称"agentic security automation platform"，面向安全团队和 AI agent。来源：[GitHub README](https://github.com/TracecatHQ/tracecat)
- **目标用户**：安全工程师 / SOC 分析师（官方口径是 "security engineers"、"AI-native security teams"）。早期博客口径强调"人手不足的中小安全团队也用得起"。来源：[Beta launch 博客](https://tracecat.com/blog/launch-beta)、[DISC InfoSec 介绍](https://blog.deurainfosec.com/tracecat-open-source-soar/)
- **替代的工作流**：商业 SOAR 的人工编排 + 告警分诊流程。痛点叙事是商业 SOAR 贵（号称最高 5x 成本节省）、按 workflow 计费导致用户被迫把逻辑塞进少数 workflow，以及传统 SOAR 是"AI 之前"时代为确定性流程设计、AI 是后加的。来源：[Beta launch 博客](https://tracecat.com/blog/launch-beta)、[Tracecat vs Tines](https://www.tracecat.com/tracecat-vs-tines)
- **核心价值主张**：
  - Prompt-to-automation：从 Claude Code / Codex 等 coding agent 通过 Tracecat MCP 直接建 automation（agents、workflows、cases、tables）。
  - All-in-one：agents + workflows + lookup tables + case management 一体。
  - Sandboxed-by-default（nsjail）+ Temporal 持久执行，主打安全、可靠、可扩展。
  - 自托管 / 云双部署，无 "SSO 税"（SAML/OIDC 开源内置）。来源：[GitHub README](https://github.com/TracecatHQ/tracecat)

## 2. 功能清单

来源：[GitHub README](https://github.com/TracecatHQ/tracecat)、[docs 首页](https://docs.tracecat.com/)、[llms.txt 文档索引](https://docs.tracecat.com/llms.txt)

**核心能力（开源）**
- Agents：自定义 agent（prompt + 工具 + chat），支持 preset agent（EE）。
- Workflows：低代码 builder，复杂控制流（if、loop、scatter-gather、while、subflow），Temporal durable execution；workflow 以 YAML definition 定义、有 draft/publish 版本模型。来源：[workflows 文档](https://docs.tracecat.com/automations/workflows.md)
- Actions：核心 action 分 Request（HTTP/SQL/SSH/gRPC/Email）、Transform（reshape、python script、data transforms、require）、Workflow（subflow、循环）几类。来源：[llms.txt](https://docs.tracecat.com/llms.txt)
- Triggers：webhook、schedule（cron/interval）、workflow-as-API（同步 /wait 端点）、error workflow（别的 workflow 失败时触发）、case/task/comment 触发器。来源：[llms.txt](https://docs.tracecat.com/llms.txt)
- Case management：case + 评论/回复 + 附件 + tasks + linked rows + tags + 自定义字段 + dropdown（EE）+ durations（EE）；case 内 copilot 可总结时间线并起草下一步。来源：[case management 文档](https://docs.tracecat.com/automations/cases.md)
- Tables：结构化 lookup 数据存储，可被 workflow / agent 查询，行可关联到 case。
- Tracecat MCP：把 Tracecat 自身暴露为 MCP server，让外部 coding agent 驱动整个平台。
- MCP client：agent 可接远程 HTTP/OAuth MCP server 或本地 npx/uvx stdio MCP server。
- Custom registry：把自己的 Python UDF / YAML template action 从 Git 仓库同步进 Tracecat，版本化、可回滚。
- Audit logs：可导出到 SIEM。
- SAML / OIDC 开源内置。

**EE 特有**（面试叙事要注意这条"护城河划线"）
- 100+ 托管 MCP server 目录（Splunk、CrowdStrike、SentinelOne、Sentinel、Elastic、Wiz、GreyNoise、PagerDuty 等 50+ 预配置）。
- 细粒度 RBAC/ABAC、自定义角色/组/scope、OAuth2.0 scope。
- Human-in-the-loop 审批（unified inbox / Slack / email 审批敏感工具调用）。
- Workspace GitOps 版本控制（workflow/agent/table schema 同步到 GitHub/GitLab）。
- Case tasks、linked rows、metrics、durations、dropdowns、跨 case 关联 copilot、preset agent、tool_approvals。

## 3. 数据模型

来源：[case actions 参考](https://docs.tracecat.com/automations/core-actions/case-actions/cases.md)、[case triggers](https://docs.tracecat.com/automations/triggers/case-triggers.md)、[workflow definition](https://docs.tracecat.com/automations/core-concepts/workflow-definition.md)、[RBAC 文档](https://docs.tracecat.com/manage-platform/rbac.md)

**核心实体**
- Organization → Workspace（多租户两层，workspace 是资源和 RBAC 边界）→ 用户/组/服务账号。
- Workflow（draft/published definition，YAML，含 triggers + actions + inputs/outputs + control flow）。
- Action（命名空间化，如 `core.cases.create_case`、`tools.slack.post_message`、`ai.agent`）。
- Case：summary、description（Markdown/Mermaid）、status、severity、priority、payload、自定义 fields、tags、assignee、comments、attachments、tasks、linked rows。
- Table / Row：lookup 结构化数据，行可 link 到 case（每 case 每表最多 250 行、最多 10 张表）。
- Secret（workspace/org 级，custom/ssh_key/mtls/ca_cert 类型）、Variable（非敏感配置）、Secret environment（按客户/应用身份/部署阶段分桶凭证）。
- Agent preset（EE）：保存的 instructions + tools + MCP integrations + 版本号。

**Case 状态机**（枚举值，官方 action 参考给出完整集合）
- status：`unknown / new / in_progress / on_hold / resolved / closed / other`
- severity：`unknown / informational / low / medium / high / critical / fatal / other`
- priority：`unknown / low / medium / high / critical / other`
- 生命周期事件族：create / update / close / reopen / view，加 comment、field change（status/priority/severity/assignee/payload）、tag、task、attachment、dropdown 事件——每个事件都可触发 workflow。来源：[case triggers](https://docs.tracecat.com/automations/triggers/case-triggers.md)
- 注意：Tracecat 没有独立的 "alert" 一等实体；告警通过 webhook trigger 进入 workflow，workflow 再 create_case。Case 是聚合后的工作项。这是与我们的 demo（alert → case 两级）明显不同的设计选择。
- 防环路细节：workflow 产生的 case 事件不会再触发 case trigger。来源：[case triggers](https://docs.tracecat.com/automations/triggers/case-triggers.md)

## 4. AI agent 设计

来源：[ai-agent 文档](https://docs.tracecat.com/agents/ai-agent.md)、[agents/secrets-variables](https://docs.tracecat.com/agents/secrets-variables.md)、[security/architecture](https://docs.tracecat.com/security/architecture.md)

- **嵌入方式**：AI 是 workflow 里的 action，不是独立运行时——`ai.action`（单次 LLM 调用，无工具）、`ai.agent`（带工具调用的 agent 节点）、`ai.preset_agent`（EE，引用保存的 preset）。选型口诀官方写死：无工具用 ai.action，要工具用 ai.agent，要复用配置用 preset。
- **模型**：多 provider（OpenAI gpt-4.1、Anthropic claude-3-5-sonnet 等），workspace 级启用模型目录；支持自定义 OpenAI-compatible provider / 自托管推理（气隙部署文档提到 self-hosted LLM inference）。
- **工具供给**：`actions` 白名单（Tracecat action 名）+ `mcp_integrations`（保存的 MCP server）。**default-deny**：agent 只能看到身份和 workspace scope 允许的工具，配置再收窄；显式 deny 覆盖 allow。策略裁决三态：Allow / Deny / Require approval。来源：[security/architecture](https://docs.tracecat.com/security/architecture.md)
- **Human-in-the-loop**：`tool_approvals` 按工具名逐个要求审批（EE）。审批是 Temporal durable 的：worker 重启、retry 后决定仍绑定到 run + tool call；每次批准/拒绝产生一条审计事件（不含工具参数和输出）。审批暂停不计入 agent 超时。来源：[ai-agent 文档](https://docs.tracecat.com/agents/ai-agent.md)
- **资源兜底**：`max_tool_calls`（默认 15）、`max_requests`（默认 45）、timeout（默认 1800s）；EE 级还有总 token 预算 + token 燃烧速率限制（"固定调用次数限制挡不住推理死循环，所以按 token 限"——这个论证可直接引用）。来源：[security/architecture](https://docs.tracecat.com/security/architecture.md)
- **多 agent 分工**：没有完整多 agent 编排；有 preset（可复用的角色化配置，示例就是 `security-analyst`、`security-triage`）、subagent preset 的网络权限受 root preset 约束、case 评论里 @提及 agent、workspace chat 里选 preset agent。是"单 agent + 角色 preset"模式而非多 agent 协作。
- **凭证代理（对我们最关键）**：preset agent 的指令里写 `${{ SECRETS.x.KEY }}` 占位符，LLM 只看到占位符原文；真实值在 tool 执行层服务端注入。沙箱只拿短寿命、scope 到 run/workspace/model/允许工具集的 JWT，trusted proxy 在沙箱外把凭证附到 API/LLM/MCP 调用上。官方明确警告：不要把 SECRETS 表达式放进 `ai.action`/`ai.agent` 的普通输入里。来源：[agents/secrets-variables](https://docs.tracecat.com/agents/secrets-variables.md)
- **官方威胁模型立场（金句）**："把 LLM 当作不可信的决策者——它可以提议工具调用、生成代码，但不能给自己授角色、不能批准自己的调用、不能解析 broker 凭证、不能改沙箱策略。"注入威胁被明确建模：告警、邮件、case、工具结果都可能藏恶意指令。来源：[security/architecture](https://docs.tracecat.com/security/architecture.md)

## 5. 安全与权限设计

来源：[security/architecture](https://docs.tracecat.com/security/architecture.md)、[rbac 文档](https://docs.tracecat.com/manage-platform/rbac.md)、[org audit logs](https://docs.tracecat.com/audit-logs/organization.md)

- **RBAC**：scope 形如 `resource:action`（workspace 级）/ `org:resource:action`（org 级），角色是 scope 包。内置 6 角色：workspace-viewer(12 scopes)/editor(36)/admin(56)、organization-member(6)/admin(84)/owner(87)。assignment 绑定 user/group × org-wide/单 workspace，有效权限取并集。关键规则：**你只能授出自己持有的 scope**（"Cannot grant scopes not held by the caller"）；服务账号不走角色，直接持 scope 且受 allowlist 限制。细粒度自定义角色/组是 EE。
- **凭证存储**：Fernet（AES-128-CBC + HMAC-SHA256）加密静态存储，密钥 `TRACECAT__DB_ENCRYPTION_KEY`（不可轮换，丢钥即全部凭证不可恢复——官方自己标注的限制）；API token 类（服务账号 key、MCP PAT、webhook key）用加盐 BLAKE2b 单向哈希、恒定时间比较、只在创建时返回一次。执行时解析：只有 executor / agent tool runner / trusted MCP server / LLM gateway / preset service 这些沙箱外可信服务能解析凭证；可外接 AWS Secrets Manager。
- **运行时**：nsjail 沙箱默认开启（网络默认隔离、只读运行时、cgroup 资源限制、syscall 过滤）；agent 生成的代码、自定义 Python、本地 stdio MCP 全在同一个边界里。Temporal 持久 payload 用 AES-256-GCM 加密（HKDF 按 workspace 派生 key，默认关闭需手动开启）；结果中的 secret 值在持久化前 mask 成 `***`（字面替换，官方承认会漏编码变形后的拷贝）。
- **审计**：四路分离——platform audit（平台管理员）、organization audit（用户/服务账号，HTTPS webhook 推送到 SIEM）、agent OTel 遥测（LLM 可观测）、MCP access logs。事件模型固定：actor_type(USER/SERVICE_ACCOUNT)、actor_id、ip、resource_type/id、action、status(ATTEMPT/SUCCESS/FAILURE)。**审计只记操作不记内容**：prompt、工具参数、凭证永不进审计事件。投递是 best-effort（10s 超时、3 次重试、背压下丢事件）。
- **多租户**：org + workspace 两层；应用层租户 scope + PostgreSQL 行级安全双层（RLS 是应用检查失效时的兜底）；外部 MCP 连接继承用户权限、PAT 保持 workspace scope。
- **变更管理**：custom registry 按 commit 版本化可回滚；发布 workflow 时记录 registry lock（pin 住 action 版本）；EE workspace GitOps（secret 只同步 key 名不同步值）。

## 6. 集成生态

来源：[integrations 索引（109 页）](https://docs.tracecat.com/_llms/integrations.md)、[README](https://github.com/TracecatHQ/tracecat)

- **规模**：100+ 预建 connector（文档列了 109 个集成页），机制是自带 action registry（命名空间 `tools.*`），认证协议覆盖 HTTP、SMTP、gRPC、OAuth。
- **安全向集成代表**：CrowdStrike、SentinelOne、Microsoft Defender for Endpoint、Microsoft Sentinel、Splunk、Elastic Security、Wazuh、Panther、MISP、VirusTotal、GreyNoise、AbuseIPDB、Shodan、URLScan、ThreatFox、CISA KEV、FIRST EPSS、Okta、PagerDuty、ServiceNow、Jira、Slack、Teams、Google SecOps。
- **MCP 双向**：对外 Tracecat 自己是 MCP server（让 Claude Code 等驱动平台）；对内 agent 可挂远程 HTTP/OAuth 或本地 stdio MCP server；EE 提供 50+ 预配置托管 MCP server 目录。
- **自定义扩展**：custom registry 从 Git 同步 Python UDF / YAML template action，版本化、发布锁、可回滚。
- **本地 vs 远程 MCP 的安全差**（官方自己点明）：远程 MCP 走 trusted proxy 每次调用都复检、支持审批闸；stdio MCP 跑在 agent 沙箱内、不支持审批闸、凭证进沙箱、启用它要给整个沙箱开网。来源：[security/architecture](https://docs.tracecat.com/security/architecture.md)

## 7. 我们可借什么

结合我们的 demo（告警分诊+响应助手，TS/LangGraph.js，演示注入防护/权限收窄/审计）：

**直接可借的设计点**
- **Case 数据模型**：status/severity/priority 三枚举（new→in_progress→on_hold→resolved→closed；unknown/other 兜底值设计很实用），case 事件驱动触发器，评论即时间线、@提及 agent、防环路规则（自动化产生的事件不再触发自动化）。我们的 case schema 可以直接对齐这套枚举，面试时"与 Tracecat 对齐"本身就是说服力。
- **凭证代理模式**：LLM 只见 `${{ SECRETS.x.KEY }}` 占位符，服务端在工具执行层注入真值；沙箱/agent 持短寿命 scoped JWT 而非真凭证。这正是我们要演示的"凭证代理"防线，Tracecat 给出了工业级参照（含"不要把占位符放进普通 prompt 输入"的反面警告）。
- **工具策略三态裁决**：Allow / Deny / Require approval，default-deny + 显式 deny 覆盖 allow，按工具名配 `tool_approvals`——我们"工具分级验票闸"的直接蓝本。
- **审批的持久性语义**：审批决定必须绑定 (run, tool call) 并在重启/重试后依然有效，批准/拒绝各产生一条审计事件。我们 demo 里审批闸可以用内存态模拟，但叙事上要对齐这条语义。
- **token 预算 > 调用次数上限**：限调用次数挡不住推理循环，按 token 总量+燃烧速率限——这是我们防线设计里一条现成的、有出处的论证。
- **审计事件模型**：固定字段 actor/action/resource/status(ATTEMPT→SUCCESS/FAILURE)，"审计记操作不记内容"，PII/凭证永不进审计。我们的审计防线可直接抄这个事件 schema。
- **"LLM 是不可信决策者"的威胁模型表述**：四不——不能授权、不能自批、不能取凭证、不能改策略。这是面试讲设计哲学时最值钱的一句话。

**可直接用的资产**
- Case 枚举值和 case trigger 事件 payload JSON（见第 3 节，有完整示例）可作我们 mock 数据格式。
- 官方 ai.agent 的 YAML 示例（investigate_alert / draft_case_update）是现成的"告警分诊 agent"配置样例，可改写成我们 LangGraph.js 的图定义。
- AGPL-3.0 意味着可研读源码但**不能直接抄代码进商业/闭源 demo**（我们的 demo 是内部面试项目，读代码学设计没问题，复制代码需谨慎）。

**明确不该照抄的**
- **技术栈**：Python/FastAPI/Temporal/nsjail/Postgres——我们是 TS/LangGraph.js，Temporal 的 durable execution 和 nsjail 沙箱都抄不动，叙事上改为"LangGraph checkpointer 提供轻量持久性"即可，不要硬对标。
- **Workflow-as-code 平台本身**：Tracecat 的本质是 SOAR 平台（通用编排引擎），我们只是分诊+响应助手。不要引入 YAML workflow DSL、custom registry、GitOps 这些平台级复杂度。
- **无独立 alert 实体**：Tracecat 把告警当 webhook payload、case 是唯一工作项；我们的 demo 演示分诊价值，alert→case 的两级模型（去重/聚合/升级）反而更贴合叙事，这是我们可以"比 Tracecat 更聚焦"的点。
- **EE 划线**：细粒度 RBAC、审批、跨 case 关联、托管 MCP 目录都是付费墙后功能——说明这些是业界公认的硬需求，正好证明我们 demo 里自研简化版这些能力的价值。
- **PII 脱敏在 Tracecat 是空白**：架构文档把 prompt 注入过滤、PII 过滤都划到"客户自建 LLM proxy 负责"的边界外。我们的 PII 脱敏防线是 Tracecat 没做的差异化点，值得在叙事中强调。

**未证实项**
- 多 agent 分工的更多细节（subagent preset 仅一句提及，未见完整文档）——未证实。
- README 宣称 "100+ connectors" 与文档 109 个集成页基本吻合，但每个集成的成熟度未逐一验证——未证实。
- Enterprise 的 human-in-the-loop inbox 具体 UX 未见公开文档细节——未证实。
