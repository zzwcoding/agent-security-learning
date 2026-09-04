# 参照分析：FunnyWolf/agentic-soc-platform（ASP）

- 仓库：https://github.com/FunnyWolf/agentic-soc-platform （约 1.17k star，2025-09 创建，2026-08 仍活跃，Python/Django 后端 + Vite/AntD 前端，MIT）
- 文档站：https://asp.viperrtp.com/zh/asp/overview/
- 作者：FunnyWolf（Viper/星链计划生态，Knownsec 404 StarLink 收录）
- 分析日期：2026-09-04；代码基线：master 分支（server version 0.5.x，v0.6.0 spec 在设计中）

---

## 1. 解决什么需求

**目标用户**：告警量超过人工处理能力的 SOC 团队——希望在调查中用 LLM 但又要求审计、留痕、人工最终决策的团队；希望私有化部署（安全数据不出内网）的团队。
（[overview](https://asp.viperrtp.com/zh/asp/overview/)）

**替代的工作流**：分析师「逐条处理 SIEM 告警、在多个工具间切换」→ 改为「围绕 Case 审查 AI 分析结果并做最终判断」。平台负责聚合、补全上下文、推进重复流程，人负责风险判断和处置决定。

**核心价值主张**：
- 告警洪水收敛：SIEM/Webhook 告警 → Module 提取 IOC、关联聚合 → 少量可处置 Case（README 称"千万级日志收敛到少量案件"）。
- AI 秒级调查报告：严重性/置信度/影响/优先级/判定 + 结构化报告。
- 代码优先（Python Module/Playbook）而非拖拽编排，且让外部 Harness Agent（Claude Code/Codex 等）通过 CLI/Skills 进入 SOC 流程，而非自建孤立 Agent 系统。
- 定位 explicitly「不是另一个 SIEM/SOAR」：保留成熟 SOAR 的工作台和数据模型，定制逻辑交给 Python。

## 2. 功能清单

- 告警接入：Splunk/ELK Webhook、Kibana/ELK Index Action，统一写 Redis Stream（[architecture](https://asp.viperrtp.com/zh/asp/overview/architecture/)）
- Module：Python 流式处理告警，IOC 提取、字段映射、按 correlation_uid 关联聚合生成 Case/Alert/Artifact
- Case 作战室：证据审查、指派、状态流转、Comments 讨论（评论会作为 LLM 分析上下文）、Timeline/Case Log
- AI 调查：Case 创建/更新后调度 LLM 生成结构化调查报告（InvestigationReport schema）
- 富化：威胁情报（OTX/OpenCTI 等 Provider 抽象）、CMDB、内部知识检索
- Playbook：Python `run()` 单入口的自动化剧本（内置 Investigation / Knowledge Extraction / TI Enrichment / CMDB Enrichment / Case Summary）
- 知识沉淀：从已判定 Case 提取组织级 Knowledge，后续分析时检索注入
- 治理：本地/LDAP 登录、三角色（admin/user/viewer）、用户级 API Key、Inbox 通知、全局 Audit Log
- 多 LLM Provider 配置（OpenAI 兼容 base_url，按 tag 路由）
- Dashboard、批量分诊（bulk triage，v0.6.0）、SLA 管理（v0.6.0 spec）
- Agent 集成：asp-cli + Skills 市场（FunnyWolf/asp-marketplace，约 20 个 skill，含调查工作流、Module/Playbook 编写辅助）

## 3. 数据模型

核心实体（Django ORM，`backend/apps/*/models.py`）：

- **Case**：可读 ID（case_000001）、title、双轨评估字段——人工 severity/impact/priority/confidence/verdict 与 AI 对应的 `*_ai` 字段**分开存储**；status 状态机 `New → In Progress → On Hold/Resolved → Closed`（Closed→In Progress 即 Reopen，清空 verdict/closed_time，保留 acknowledged_time）；进入 Closed 强制要求 verdict + disposition note；另有 category（DLP/EDR/IAM/Cloud 等）、tags、assignee、correlation_uid、`investigation_report_ai_json`。
  来源：[cases/models.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/cases/models.py)、[01-bulk-case-triage.md](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/docs/specs/v0.6.0/01-bulk-case-triage.md)
- **Alert**：必须挂在 Case 下（FK 级联）；字段对齐 OCSF 风格——severity/confidence/impact/disposition/action、MITRE tactic/technique/sub_technique、product vendor/category、rule 信息、first/last_seen、`raw_data` + `unmapped` 保留原始字段；AlertStatus: New/In Progress/Suppressed/Resolved/Archived/Deleted。
  来源：[alerts/models.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/alerts/models.py)
- **Artifact**：IOC 实体，type/name/role 三套大枚举（type≈40 值、name≈250 值覆盖 host/process/file/email/cloud/k8s，role=Target/Actor/Affected/Related），与 Alert M2M。
  来源：[artifacts/models.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/artifacts/models.py)
- **Enrichment**：可挂 Case/Alert/Artifact 任一；type（TI/CMDB/Identity/History…）+ provider（超大枚举含主流 TI/EDR/云厂商）+ uid 去重 + data JSON。
- **Knowledge**：title/body/tags/expires_at，source=Manual|Case，Case 来源与 Case 一对一；约束校验（Case 来源必须挂 case）。
  来源：[knowledge/models.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/knowledge/models.py)
- **CaseRelationship**：Related/Duplicate of/Parent of，DB 约束防自环、单父、单 duplicate 目标。
- **CaseAnalysisJob**：AI 分析任务（Pending/Running/Success/Failed + result_json），复用为质量评测的 prediction 来源。
- **AuditLog**：GenericForeignKey 指向任意对象，action + actor + changes diff + metadata。

## 4. 多 agent 分工设计（重点）

**结论先行：ASP 不是 LangGraph/CrewAI 式内部多 agent 系统，没有 supervisor/handoff 图。** 「分诊/调查/富化/知识沉淀」四种分工由四种**不同机制**承担：

| 分工 | 实现机制 | 位置 |
| --- | --- | --- |
| 分诊/聚合 | **确定性 Python Module**（Redis Stream 消费组，非 LLM） | `backend/custom/modules/*.py`，`agentic/runtime/module.py` |
| 调查 | **单次结构化 LLM 调用**（LangChain `ChatOpenAI.with_structured_output`，输出 Pydantic InvestigationReport） | `apps/agentic/analysis/analysis.py` |
| 富化 | **Playbook**（Python run() 循环调 TI/CMDB 集成，非 LLM） | `backend/playbooks/threat_intelligence_enrichment.py` |
| 知识沉淀 | **Playbook 触发 LLM 抽取**（KnowledgeExtractionLLMResult schema） | `apps/agentic/analysis/knowledge.py` |
| 开放式调查/狩猎 | **外部 Harness Agent**（Claude Code/Codex/Gemini CLI 等经 asp-cli + Skills） | [skills 目录](https://asp.viperrtp.com/zh/asp/integrations/skills/) |

关键设计细节：

- **LLM 框架是 LangChain（langchain_openai），不是 LangGraph**。所有 LLM 调用走 `invoke_structured_llm(prompt_id, payload, output_schema)`：SystemMessage=文件化提示词（`data/playbooks/<name>/System_{zh,en}.md`），HumanMessage=紧凑 JSON payload，temperature=0。
  来源：[prompts.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/agentic/analysis/prompts.py)、[llmapi.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/integrations/llm/llmapi.py)
- **上下文装配用「field profile」白名单**：`profiles.py` 按模型×profile（investigation/agent）声明哪些字段喂给 LLM，含关联序列化器（alerts→artifacts→enrichments→comments→audit_logs），并**显式剔除 AI 自写字段避免自引用循环**；profile 带版本号（AI_PROFILE_VERSION）。
- **知识检索是两段式**：LLM 先产出检索关键词（失败时 fallback 到 title/tags/rule_name），再对 Knowledge 做 icontains 检索（上限 8 关键词/10 条），注入调查 prompt——不是向量 RAG。
- **知识提取有人工门**：Case 无 analyst verdict 时跳过抽取。
- **工具隔离方式**：内部 LLM 调用根本不挂工具（纯文本→结构化输出，无 tool calling）；需要行动力的部分全部外包给 Harness Agent，其能力边界=asp-cli 的 API 面（`FOUNDATION_CAPABILITIES` 约 35 个 operation，含 case.update_ai、siem.query.spl/esql、ti.query、playbook.run 等），文档明确「写操作需用户明确授权」。
  来源：[agent_api/views.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/agent_api/views.py)、[skills 使用原则](https://asp.viperrtp.com/zh/asp/integrations/skills/)
- **协作机制**：不是 agent 间消息传递，而是「共享资源层」——所有角色（人/Module/LLM/Harness Agent）读写同一套 Case/Alert/Artifact/Knowledge 记录，靠 Audit Log + Timeline 留痕（文档称「协作主线」）。

## 5. 安全与权限设计

做到的程度：

- **认证/授权**：本地 + LDAP；三角色 admin/user/viewer（viewer 只读，服务端校验，见 `accounts/permissions.py`）；Agent API 用用户级 **UserApiKey**（有过期时间、last_used_at、可轮换），Agent 操作权限=持有用户的角色（IsBusinessWriterOrReadOnly）。
- **审计**：全局 AuditLog（signal 驱动自动记录所有 BaseModel 的 create/update/delete，含 changes diff 和 actor；relation 事件单独记录）；AI 分析上下文里会带上截断到 100 条的 Case 审计历史。
  来源：[audit/models.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/audit/models.py)、[signals.py](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/backend/apps/audit/signals.py)
- **凭证管理**：LLM/TI 的 API key 存服务端 settings，设置页做连通性测试时对响应预览中的 key 做 `***` 脱敏（`settings/services.py::_redact`）；skill 文档要求「不要把 API Key 写进 skill/仓库/提示词」。**没有凭证代理/按需下发机制**——Agent 拿到的 UserApiKey 就是长期 bearer token。
- **提示词注入防护**：基本**没有**。仅在 investigation 提示词里有一句数据边界提示（"knowledge body 的 Markdown 只属于该条知识记录本身"），无输入消毒、无 guardrail、无输出校验之外的防护。全仓 grep 无 injection/guardrail/jailbreak 相关实现。
- **审批闸**：**没有**。Playbook 执行模型明确排除中途人工审批——「点击 Run 即授权整个 Playbook」（[03-playbook-execution.md](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/docs/specs/v0.6.0/03-playbook-execution.md)）；Playbook 有 RISK_LEVEL 元数据字段但未见强制门控逻辑（未证实在 v0.6.0 是否落地）。护栏是「Playbook 默认只做调查/富化/知识类动作，处置类动作由用户自己写的代码承担」。
- **PII 脱敏**：无（仅 secret 脱敏）。

## 6. 可观测与评测

- **评测**：v0.6.0 spec 设计了 AI Quality Evaluation——Case 关闭时把「关闭前最后一次成功 CaseAnalysisJob 的 AI 五字段」与「人工五字段」逐项比较，产出 AI–Human Agreement（刻意不用 Accuracy 措辞，不合成总分，不按 model/prompt 版本切片）；Reopen 即删除 Evaluation。这是少见且务实的 agent 评测范式。
  来源：[08-ai-quality-evaluation.md](https://github.com/FunnyWolf/agentic-soc-platform/blob/master/docs/specs/v0.6.0/08-ai-quality-evaluation.md)
- **Tracing**：无 LangSmith/OTel/Sentry 集成。可观测性靠：CaseAnalysisJob 状态机 + result_json 留档、Playbook run 的 `add_run_message` UI 可见消息、Audit Log、AnalysisRecord（含 profile_version、用到的 knowledge keywords/records）。
- **测试**：Django 单测覆盖 audit/agent_api/siem/threat_intel/settings 等约 9 个 apps/integrations；**无 LLM 输出的回归测试**（提示词迭代靠 profile_version 标记，未见 eval 数据集，未证实）。
- **Mock/演示资产**：`backend/custom/data/modules/` 有 3 个场景的原始告警 fixture（AWS IAM 提权、EDR 删卷影、用户上报钓鱼邮件，各 2 条 raw_alert JSON）+ 3 个 SIEM 索引 YAML；`backend/mock/` 有 mock SIEM 与数据导入脚本。

## 7. 我们可借什么

**直接可借鉴的设计**：

1. **双轨评估字段（`severity` vs `severity_ai`）**：AI 判断与人工判断分列存储，天然支撑「AI-Human Agreement」评测和「人做最终决策」叙事——我们 demo 的告警分诊可以直接抄这个字段设计，面试时可讲评测闭环。
2. **Field-profile 白名单装配 LLM 上下文**：显式声明每个 agent 能看到哪些字段（investigation profile vs agent profile），比「把整个对象 dump 给 LLM」更工程化，也顺便实现了数据最小化——可与我们的 PII 脱敏防线合并讲。
3. **Case 状态机 + 进入 Closed 强制 verdict**：一条可讲的「水位线」规则（无判定不许关案），且 Reopen 语义清晰。
4. **OCSF 风格的 Alert/Artifact 枚举**：Artifact type/name/role 三枚举覆盖面极大，是我们造告警数据模型和测试数据的现成参照。
5. **评测范式**：不评文字质量、不合成总分、逐字段 agreement、明确 Not evaluable/Coverage 口径——我们 demo 的 eval 页可以照此设计，避免「准确率」话术陷阱。
6. **测试资产**：3 个场景的 raw_alert JSON fixture + SIEM YAML（[custom/data](https://github.com/FunnyWolf/agentic-soc-platform/tree/master/backend/custom/data)）格式可参考来自造我们的模拟告警。
7. **知识两段式检索（LLM 产关键词→关键词检索→注入）+ 无人工判定不抽取**：低成本知识闭环，我们的「知识沉淀 agent」可以复刻这个门控。
8. **Skills 使用原则里「写操作需用户明确授权」**：与我们的审批闸防线呼应，可作为行业惯例佐证。

**不该照抄的部分**：

- **架构路线**：ASP 把开放式 agent 能力外包给外部 Harness Agent（Claude Code 等），内部 LLM 只做无工具的结构化抽取。我们 demo 的核心卖点恰恰是 LangGraph supervisor 多 agent 分工，照抄 ASP 就没有多 agent 可讲。ASP 证明了「分诊用确定性代码、LLM 只做判断」是生产实践——我们可以吸收为**分诊前置规则层**，但 supervisor 图仍是我们的主线。
- **安全防线薄弱**：无注入防护、无审批闸、无凭证代理、无 PII 脱敏——这正是我们 demo 的差异化空间，每条都可以作为「ASP 没做、我们做了」的需求制造依据。
- **无 tool calling 的保守设计**：适合生产稳妥，但 demo 需要展示 agent 自主工具调用 + 验票闸，应走我们既定路线。
- 巨型 provider 枚举（EnrichmentProvider 上百个值）属于堆砌，demo 不需要。

**与 Tracecat 的对照定位**（一句话）：Tracecat 是「工作流引擎+AI」，ASP 是「SOAR 工作台+AI 判断+外部 agent」，我们 demo 是「LangGraph 内部多 agent+安全防线」——三者各居一格，互不冲突。
