# 参照分析：M507/AI-SOC-Agent（SamiGPT）

> 仓库：https://github.com/M507/ai-soc-agent （Blackhat 2025 发布，MIT，Python，活跃开发中）
> 分析日期：2026-09-04。已完成参照 Tracecat、FunnyWolf/agentic-soc-platform 不重复。

## 1. 解决什么需求

- 面向 SOC 团队/MSSP 的安全调查与事件响应自动化平台：告警分诊、SIEM 分析、CTI 富化、案件管理，通过 MCP 暴露给 AI 工具。([README](https://github.com/M507/ai-soc-agent))
- 价值主张锚点是**经济账**：README 首页即给出 "~$0.18 per alert、~50 秒/告警/标签页"，并附真实成本 CSV 与 Blackhat 演讲 PDF。([README](https://github.com/M507/ai-soc-agent)、[cost_all.csv](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/usage-events/cost_all.csv))
- 按 SOC 分层组织（SOC1 分诊 / SOC2 调查 / SOC3 响应），映射真实 SOC 的人力梯队，升级路径 Alert → SOC1 → SOC2 → SOC3。([run_books/README.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/README.md))

## 2. 功能清单

- 自动告警分诊（FP/BTP/TP/Uncertain 四分类，告警 verdict 生命周期）。([initial_alert_triage.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/soc1/triage/initial_alert_triage.md))
- 案件管理 CRUD：case、observable、comment、timeline、task、asset、evidence、case linking。([TOOLS.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/src/mcp/TOOLS.md))
- SIEM 调查：事件搜索、pivot、按实体/时间窗查关联告警、KQL。(同上)
- EDR 响应：端点隔离/解除隔离、杀进程、取证采集。(同上)
- CTI 富化：IOC 匹配、hash/IP 信誉（Local TIP + OpenCTI 可并发查询）。([config.json.example](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/config.json.example))
- 客户端知识库（KB）：内网网段/服务器命名/用户清单，用于 FP 判定的"内部实体核验"。([client_env/](https://github.com/M507/AI-SOC-Agent/tree/main/client_env)、[soc1/guidelines.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/soc1/guidelines.md))
- 检测工程闭环：FP 关闭时强制产出 fine-tuning 推荐、调查受阻时产出 visibility 推荐，写入 Trello/ClickUp/GitHub 工程看板。([initial_alert_triage.md Step 4.3/10](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/soc1/triage/initial_alert_triage.md))
- 双入口：AI Controller Web UI（底层调 Cursor IDE 的 `cursor-agent` CLI 执行）或直接当 MCP server 挂到 Cursor/Claude Desktop。([README](https://github.com/M507/ai-soc-agent))

## 3. 数据模型

- 核心实体：Alert（SIEM 侧，带 verdict 字段）与 Case（案件管理侧）双轨。告警 verdict 生命周期：无 verdict → `in-progress`（锁定防其他 agent 重复拾取）→ `false_positive` / `benign_true_positive` / `true_positive` / `uncertain`。([initial_alert_triage.md Step 1-3](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/soc1/triage/initial_alert_triage.md))
- Case 标准文档化且完整：metadata（标题强制 `[Alert Type] - [Primary Entity] - [Date/Time]`）、timeline、observables（7 类 IOC + 优先级 + first/last seen）、notes（按 tier 分类的固定 markdown 模板）、tasks、assets、evidence、case linking（duplicate/escalated-from 等 5 种关系）。([case_standard.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/standards/case_standard.md))
- Case 生命周期：open → in_progress → closed；FP/BTP 不建 case 直接关告警；只有 TP 才建/挂 case；同主机 24 小时内告警强制归并到同一 case（防案件碎片化是 runbook 里反复强调的第一优先级）。([initial_alert_triage.md Step 5/8.7/11.1](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/soc1/triage/initial_alert_triage.md))
- 代码侧是轻 DTO：Python dataclass + `to_dict/from_dict` mixin，同步风格，无 envelope 包装。([src/core/dto.py](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/src/core/dto.py))

## 4. agent 架构

- **不是 LLM agent 框架**。无 LangChain/LangGraph；"agent" 实体是外部通用编码 agent（Cursor `cursor-agent` 或 Claude Desktop），通过 MCP 调工具。SamiGPT 本体是工具层 + prompt 资产层。([README Quick Start](https://github.com/M507/ai-soc-agent))
- 多 agent 是**配置驱动的角色档案**：`config/agent_profiles.json` 定义 SOC1/2/3 三个 profile，各带 capabilities、runbooks、tools 白名单、decision_authority、max_concurrent_cases，外加 routing_rules（new_alert→SOC1 等）。([agent_profiles.json](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/config/agent_profiles.json))
- 推理链 = **结构化自然语言 runbook**：OBJECTIVE/SCOPE/INPUTS/TOOL CATEGORIES/GLOBAL OUTPUT VARIABLES/带 Decision Points 与 Outputs 的分步流程/COMPLETION CRITERIA。本质是极详细的 prompt 工程，含变量插值 `${ALERT_ID}` 和并行子步骤声明；另有 `flow_*.py` 伪代码流程图。([initial_alert_triage.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/soc1/triage/initial_alert_triage.md)、[run_books/](https://github.com/M507/AI-SOC-Agent/tree/main/run_books))
- 每个 tier 有 guidelines.md（角色人设 + 职责边界 + "不做清单"），首次 `execute_as_agent` 时自动注入工具结果。([AGENT_PROFILES_IMPLEMENTATION.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/AGENT_PROFILES_IMPLEMENTATION.md)、mcp_server.py L2181-2196)
- 工具层 vendor-neutral：`src/api/` 定义 CaseManagementClient/SIEMClient/EDRClient 通用接口，`src/integrations/<厂商>/` 各自实现 client/models/mapper 四件套。([README Architecture](https://github.com/M507/ai-soc-agent))
- 另有半成品确定性规则引擎 `rules_engine.py`（trigger 字符串 + action 链，输出 playbook 叙事文本）；注意 trigger 用 `eval` 求值（虽禁用了 builtins）。([rules_engine.py](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/src/mcp/rules_engine.py))

## 5. 安全与权限设计

**基本没做——这正是我们 demo 的差异化空间：**

- `decision_authority`（如 SOC1 禁止 containment）和 per-agent `tools` 白名单**只是声明式配置，不在工具调用层强制**：`_execute_tool` 是纯分发，无授权检查；`execute_as_agent` 只校验 runbook 名称是否属于该 tier（字符串包含匹配）。(mcp_server.py L2487、L2809 起；[agent_profiles.py](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/AGENT_PROFILES_IMPLEMENTATION.md))
- 无审批闸：`isolate_endpoint`、`kill_process_on_endpoint` 等破坏性 EDR 工具直接暴露给 LLM，无 human-in-the-loop。([TOOLS.md EDR 节](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/src/mcp/TOOLS.md))
- 无凭证代理：各平台 API key/密码明文写在 `config.json`；web UI 认证字段标注 "NOT IMPLEMENTED - TODO"。([config.json.example](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/config.json.example))
- 无注入防护/PII 脱敏（全文 grep 无相关实现，未证实有任何间接措施）。
- 有审计日志：MCP 请求/响应/错误分文件落盘（`logs/mcp/mcp_requests.log` 等），是唯一像样的安全相关能力。([README Logging](https://github.com/M507/ai-soc-agent))
- SOC3（响应）runbook 官方标注未完成，即最危险的层级最不成熟。([run_books/README.md](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/run_books/README.md))

## 6. 可观测与评测

- 日志：分层文件日志（debug/error/warning + MCP 请求/响应分离）。([README Logging](https://github.com/M507/ai-soc-agent))
- **成本核算是亮点**：`usage-events/` 下有真实 Cursor usage events CSV（每次调查一条：模型 composer-1、input/cache-read/output token、成本 $0.12–0.28），是"每条告警成本"口径的现成数据格式。([cost_all.csv](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/usage-events/cost_all.csv))
- 测试资产弱：`tests/` 多为打真实 API 的连通性脚本（找 list id、删数据等），无 eval 集、无标注语料、无 tracing 框架。([tests/](https://github.com/M507/AI-SOC-Agent/tree/main/tests))
- 交付物料：demo 视频、Blackhat 演讲 PDF、stats.png——面向"讲故事"的资产齐全。([demo/](https://github.com/M507/AI-SOC-Agent/tree/main/demo))

## 7. 我们可借什么

**直接可借（需求制造素材）：**

- **SOC tier 权限模型作为分级验票闸的需求来源**：它的 `decision_authority` 字段集（关 FP、关 BTP、升级 SOC2/3、containment、forensic）正是一份现成的"工具分级 × 角色权限"矩阵，它只声明不强制——我们做成强制闸即是明确的对比叙事。([agent_profiles.json](https://raw.githubusercontent.com/M507/AI-SOC-Agent/main/config/agent_profiles.json))
- **结构化 runbook 格式**：GLOBAL OUTPUT VARIABLES + 每步 Inputs/Actions/Decision Points/Outputs + COMPLETION CRITERIA，可直接改造成我们 LangGraph 节点的 prompt 契约和验收清单。
- **"显式自我审计 checkpoint"技巧**：runbook 强制 LLM 在建 case 前书面声明"已检查 X 个活跃 case、搜索了主机名 Y、确认无同主机 case"，把软约束变成可检验的输出 artifact——低成本提升可靠性的手法，可进我们的分诊 agent。
- **同主机 24h 归并策略 + verdict 锁定**：现成的告警去重/防并发业务规则。
- **KB 优先的 FP 激进攻略**（先验内部实体再谈 IOC），以及 **fine-tuning/visibility 推荐闭环**——正是我们"知识沉淀 agent"的需求蓝本。
- **case_standard.md 全文**：我们的案件数据模型基本可以这份标准为底本裁剪。
- **成本 CSV 口径**（每条告警 token/成本）：评测指标的现成模板。

**可用资产**：`run_books/` 全套 markdown、`standards/case_standard.md`、`config/agent_profiles.json`、`usage-events/*.csv`、`client_env/` 假数据（内网网段/用户清单样例）。

**不该照抄：**

- 安全模型（无强制授权、无审批、明文凭证、无注入/PII 防护）——我们反着做。
- `rules_engine.py` 的 `eval` trigger 和半成品状态。
- 把"agent"外包给 Cursor/Claude Desktop 的形态：能力上限受制于外部 IDE，无法展示我们自己的编排与安全控制面（与 FunnyWolf 外包 Harness 的教训同构）。
- 绑定具体厂商栈（TheHive/IRIS/Elastic）的 demo 路径；我们用 vendor-neutral 接口 + mock 即可。
- Python 栈——我们是 TS/LangGraph.js。
