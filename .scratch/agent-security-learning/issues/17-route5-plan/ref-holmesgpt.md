# HolmesGPT（robusta-dev/holmesgpt，现 HolmesGPT/holmesgpt）参照分析

> 注：项目 2025 年 10 月进入 CNCF Sandbox，仓库已迁至 `HolmesGPT/holmesgpt`，Microsoft 是主要贡献方之一。

## 1. 解决什么需求

- **面向人群**：on-call / SRE / 平台工程师。痛点定义得很清楚：事故发生时最难的不是修，而是"从哪开始查"——未文档化的隐性知识、工具切换过载（Grafana/日志/trace 来回翻）、k8s 复杂度超出个人知识面。（[CNCF blog](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)）
- **核心价值主张**：AI 故障排查 agent——主动决定查什么数据、跑什么查询、迭代收敛假设，最终给出自然语言根因 + 修复建议。场景偏**可用性事故**而非安全告警。（[GitHub README](https://github.com/HolmesGPT/holmesgpt)）
- **端到端闭环**：从 AlertManager / PagerDuty / OpsGenie / Jira / GitHub 拉告警，调查后把结论写回源系统或 Slack/Teams（`--update` 开关）；Operator 模式用 CRD（`HealthCheck`/`ScheduledHealthCheck`）做 7×24 后台主动巡检。（[Why HolmesGPT](https://holmesgpt.dev/dev/why-holmesgpt/)、README）
- 对我们 demo 的映射：他们=可用性告警分诊+根因；我们=安全告警分诊+响应，需求结构同构（告警源接入→调查→结论回写→知识沉淀）。

## 2. Agent 架构

- **单 agent 工具调用循环**，不是多 agent supervisor。核心类 `ToolCallingLLM.call()`：`while i < max_steps` 循环，每轮 LLM 产出 tool calls → 并行执行 → 结果回灌消息历史。eval 中 `max_steps=100`；最后一轮不给工具，强制产出最终答案；超限抛 `Too many LLM calls`。（[tool_calling_llm.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/holmes/core/tool_calling_llm.py)）
- **任务分解在 prompt 层**："agentic task list approach"——agent 先建任务清单再逐条执行；另有可选的 `TodoWrite` 工具（eval 默认关闭）。（[CNCF blog](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)、[test_ask_holmes.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/tests/llm/test_ask_holmes.py)）
- **上下文管理**（对我们最有参考价值的一块）：
  - 每轮 LLM 调用前跑 `compact_if_necessary()`，超窗则压缩历史；
  - 超大工具结果 `spill_oversized_tool_result()` 落盘、只给 LLM 摘要/引用（"streaming large results to disk, output budgeting"）；
  - 工具级 transformer：`llm_summarize` 用小模型先摘要大输出（阈值如 10000 字符）再进上下文；
  - 服务端过滤/分页：jq 查询、表格列裁剪、`max_depth` JSON 树遍历，把"少拉数据进上下文"做到工具设计里。（[why-holmesgpt](https://holmesgpt.dev/dev/why-holmesgpt/)、[kubernetes.yaml](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/holmes/plugins/toolsets/kubernetes.yaml)）
- **防打转守卫**：`prevent_overly_repeated_tool_call` 拒绝同参数重复工具调用，直接返回错误让 agent 换方向。（[safeguards.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/holmes/core/safeguards.py)）

## 3. Toolset 模型

- **YAML 声明式 toolset**：`holmes/plugins/toolsets/*.yaml` 一个文件一个域（kubernetes.yaml、helm.yaml…）。字段：`description`、`docs_url`、`tags`（`core`/`cli`/`cluster`）、`prerequisites`（探测命令，不满足则自动禁用）、`llm_instructions`（给 LLM 的域级用法提示）、`tools[]`。工具定义支持三种形态：固定 `command` 模板、Jinja 参数化的 `script`、纯 Python 工具；外加 MCP server 和 HTTP connector（YAML 声明 host/path/method 白名单 + auth，自动包装成 LLM 工具）。（[kubernetes.yaml](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/holmes/plugins/toolsets/kubernetes.yaml)、[why-holmesgpt](https://holmesgpt.dev/dev/why-holmesgpt/)）
- **启用机制**：配置里 `toolsets.<name>.enabled` + `config` 注入凭证；prerequisites 运行时探测决定可用性；tags 控制场景（如 CLI 不加载 `cluster` tag）。（[adding-evals](https://holmesgpt.dev/dev/development/evaluations/adding-evals/)）
- **内置 40+ toolset**：K8s（core/logs/live-metrics/lineage）、Prometheus/Loki/Datadog/Grafana/Tempo/ES/Splunk、SQL 全家桶、Kafka/RabbitMQ、ArgoCD/Helm/Docker、Confluence/Notion/Slab（知识库）、Jira/ServiceNow（ITSM）、GitHub/GitLab/Jenkins、AWS/Azure/GCP、Internet。完整清单见 README 和 [built-in toolsets](https://holmesgpt.dev/data-sources/builtin-toolsets/)。
- **读写分级是 toolset 级的**：默认全部只读；写能力集中在独立 toolset `Kubernetes Remediation (MCP)`（scale/rollback/patch/drain），opt-in 单独启用。这个"读工具集默认全开、写工具集单独闸"的分层正是我们"工具分级表"可以直接借鉴的结构。（[k8s toolset 文档](https://holmesgpt.dev/dev/data-sources/builtin-toolsets/kubernetes/)、README）
- **工具描述工程**值得细看：每个工具的 `description` 写了何时用、何时不要用（"Prefer over bash for large queries"）、限制和替代方案，实质上把路由知识编码在 description 里而非 router 代码里。

## 4. Runbook / 知识机制

- **Runbook 目录制**：内置目录 `holmes/plugins/runbooks/` + 自定义 catalog（`catalog.json` 索引 id/description/link + markdown 正文）。流程：收到问题→按 description 匹配→`fetch_runbook` 工具拉取全文→逐步执行并输出 checklist。多个 catalog 合并。description 质量直接决定匹配率——这是"用元数据做检索"而非向量 RAG。（[runbooks 文档](https://holmesgpt.dev/latest/reference/runbooks/)）
- **Skills/记忆（自沉淀，较新）**：从 eval 代码可见 `SkillCatalog`/`fetch_skill`/前端注入的 `SuggestSkills` 工具——调查结束时 agent 可建议把本次学到的环境特异性知识写成 SKILL.md，下次调查自动加载。eval 里有完整的"首次调查→产出 skill→replay 同题验证 skill 被 fetch 且答案仍正确且探索性调用减少"闭环（`memories_generated`、`rerun_with_memory`、`replay_forbidden_tools` 断言）。这与我们 supervisor 的"知识沉淀 agent"几乎一一对应。（[test_ask_holmes.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/tests/llm/test_ask_holmes.py)）官方文档对此机制公开描述较少，细节标注**未证实（从测试代码推断）**。
- 外部知识库（Confluence/Notion/Slab/Internet）作为 toolset 接入，不是独立 RAG 管道。

## 5. Eval / 评测体系（重点）

- **规模与定位**：150+ evals，官方明确说"we use the evals as regression tests on every commit"，并用于跨模型对比。（[evaluations 文档](https://holmesgpt.dev/development/evaluations/)、[PyPI](https://pypi.org/project/holmesgpt/0.19.0/)）
- **数据组织**：pytest fixture 目录制——`tests/llm/fixtures/test_ask_holmes/<编号_场景名>/`，每个目录一个 `test_case.yaml` + 配套资源（`manifest.yaml` 造故障、自定义 runbook、`toolsets.yaml`、预置 skills）。`test_case.yaml` 字段：`user_prompt`、`expected_output`（要点列表）、`before_test`/`after_test`（kubectl 真实布景/拆景）、`tags`（easy/medium/hard/regression/benchmark + 能力维度如 logs/context_window/datetime）、`mocked_date`、`conversation_history`、`include_files`、`runbooks`、`toolsets`、`port_forwards`、以及 skill 相关断言字段。（[adding-evals](https://holmesgpt.dev/dev/development/evaluations/adding-evals/)、[01_how_many_pods fixture](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/tests/llm/fixtures/test_ask_holmes/01_how_many_pods/test_case.yaml)）
- **打分 = LLM-as-judge + 确定性断言混合**：
  - judge 用 Braintrust `autoevals` 的 `LLMClassifier`，strict 模式检查"所有 expected 要点是否都出现"、loose 模式宽松匹配，二值 0/1、带 CoT rationale；judge 模型与被测模型分离（`CLASSIFIER_MODEL`，且只支持 OpenAI 系做 judge）。（[classifiers.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/tests/llm/utils/classifiers.py)）
  - 确定性断言补充 LLM judge 够不着的点：`forbidden_tools`（不该调的工具没调）、`max_tokens` 上限、skill 数量/更新引用的硬检查。（[test_ask_holmes.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/tests/llm/test_ask_holmes.py)）
- **两种数据模式**：`RUN_LIVE=true` 真打集群（kind 集群 + manifest 布景）；mock 模式回放工具输出，`mock_policy: inherit/never_mock/always_mock` 三档。新集成优先用 live。（[adding-evals](https://holmesgpt.dev/dev/development/evaluations/adding-evals/)）
- **CI 回归**：GitHub Actions——每次 commit 跑回归子集；Fast benchmark（`regression or benchmark`）每周日定时；Full benchmark（全部难度）手动触发；PR 改了 eval 相关文件则触发快速校验；`ITERATIONS=10` 多次跑取稳定通过率抗抖动。工作流 `.github/workflows/eval-regression.yaml`。（[evaluations](https://holmesgpt.dev/development/evaluations/)、[CLAUDE.md](https://github.com/HolmesGPT/holmesgpt/blob/master/CLAUDE.md)）
- **结果分析**：Braintrust 做实验追踪（`EXPERIMENT_ID` 命名实验、`MODEL=a,b,c` 一次跑多模型对比），按分数升序找最差 case、看工具调用 trace（input/tool calls/tool results/output/expected）；也生成 GitHub markdown 报告（耗时/轮数/工具数/cost 列）。历史结果归档在文档站。（[reporting 文档](https://holmesgpt.dev/development/evaluations/reporting/)）
- **可迁移的 meta 经验**：eval 不只是质量门槛，也是**需求制造机**——文档说 eval 用于 "map out areas for improvement"；skill 机制的每个能力（建议、加载、纠错、去重、replay）都配了专门 eval。

## 6. 安全设计

- **只读为默认、写为 opt-in**："By design, HolmesGPT has read-only access and respects RBAC"；内置 toolset 全是只读，写能力（remediation、ticket 回写）单独 toolset、单独凭证、显式启用。（README、[k8s permissions](https://holmesgpt.dev/dev/data-sources/builtin-toolsets/kubernetes/)）
- **权限继承而非自管**：本地用 kubeconfig、集群内用 ServiceAccount/ClusterRole；RBAC 收紧后 agent 自适应降级并把限制告知用户；有专门的 namespace 级 RBAC 文档（还提醒要告诉 agent 自己的权限边界，否则会把 Forbidden 误判为集群故障）。（[k8s toolset 文档](https://holmesgpt.dev/dev/data-sources/builtin-toolsets/kubernetes/)、[robusta RBAC 文档](https://docs.robusta.dev/master/setup-robusta/rbac-namespace-scoping.html)）
- **参数注入防护**：模板参数经 `sanitize()`（shlex.quote）后只允许在非引号赋值槽位引用 `"$VAR"`，脚本注释里明确禁止在引号上下文中插值 `{{ param }}`；jq 参数用 `--arg` 传入不进程序文本。（[kubernetes.yaml](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/holmes/plugins/toolsets/kubernetes.yaml) 每个 script 头部 SECURITY 注释）
- **审批闸 + 防伪造**：`requires_approval` 按工具+参数判定；审批通过签发**签名 approval token**（`mint_token`/`verify_token`/`mint_prefix_token`），消息历史里校验签名防"伪造对话历史"；前缀 token 支持"此类命令本次会话都批准"；bash toolset 有 allow/deny 列表（eval 代码注释提及）。（[tool_calling_llm.py](https://raw.githubusercontent.com/HolmesGPT/holmesgpt/master/holmes/core/tool_calling_llm.py)）
- **凭证代理形态**：HTTP connector 把 token 写在 YAML 的 `{{ env.X }}` 里、LLM 只见端点不见凭证；OAuth/OIDC 走专用 MCP k8s toolset，授权码流程弹给前端用户。（[why-holmesgpt](https://holmesgpt.dev/dev/why-holmesgpt/)、[k8s toolset 文档](https://holmesgpt.dev/dev/data-sources/builtin-toolsets/kubernetes/)）
- **审计**：OTel trace 导出每次工具调用/prompt/回答（"full audit trail"）。（[why-holmesgpt](https://holmesgpt.dev/dev/why-holmesgpt/)）
- **Prompt injection 专项讨论**：公开文档/博客未见系统性注入防护设计（如不受信内容隔离、canary token），主要靠"只读 + 审批闸 + 参数 sanitize"收敛爆炸半径。标注：**未证实有专门机制**。这恰是我们 demo 可以做出差异化的地方。

## 7. 我们可借什么 / 不该照抄什么

**可借（按优先级）**：
1. **Eval 体系骨架直接复刻**：fixture 目录制（`test_case.yaml` + 布景脚本）+ LLM judge（strict 要点覆盖式、judge 与被测模型分离）+ 确定性断言（forbidden_tools、token 上限、审批行为硬检查）+ 难度/能力双维 tags + CI 分层（每 commit 回归子集、周期全量、ITERATIONS 多次取稳定）。我们用 vitest 而非 pytest，但结构和断言类型可一一映射。
2. **工具分级 = 读 toolset 默认开 / 写 toolset 单独闸 + 审批 token 签名**：我们的"工具分级验票闸"可借鉴 `requires_approval(tool, params)` 参数级判定 + 签名 token 防伪造对话历史，这在面试里是很硬的叙事点。
3. **上下文工程三件套**：工具输出 transformer（llm_summarize）、超大结果落盘、服务端过滤（jq/列裁剪）——SOC 场景日志/告警量大，这条直接变成需求。
4. **知识沉淀闭环 + 对应 eval**：SuggestSkills→SKILL.md→replay 验证（技能被加载、答案仍对、探索调用减少）是我们"知识沉淀 agent"的现成评测模板。
5. **Runbook 用 description 匹配而非向量库**：demo 阶段更轻、更可解释。
6. **工具 description 写作范式**：每个工具写清"何时用/何时别用/替代方案"。
7. **RBAC 降级自适应**：把权限边界写进 prompt，Forbidden 当信息不当故障。

**不该照抄**：
- **单 agent 循环**：我们 demo 的卖点就是 supervisor 多 agent 分工；HolmesGPT 的单环 + TodoWrite 更简，但我们场景（分诊/调查/富化/沉淀并行）有真实分工动机，不必退化成单 agent。
- **bash 脚本型工具 + sanitize**：demo 用 TS，用结构化 API 调用即可，不引入 shell 模板注入面（但要把它当"为什么不给 agent 裸 shell"的论据讲）。
- **k8s/kubectl 域**：换告警源（SIEM 式 fixture），架构迁移而非域迁移。
- **读优先、写靠 remediation toolset 的顺序**要反过来说：SOC 场景写操作（封禁、隔离、关单）是核心价值也是核心风险，审批闸要放一等公民位置；且 HolmesGPT 缺 prompt injection 专项防线（**未证实有**），我们的注入防护 + PII 脱敏 + 凭证代理正是相对它的差异化叙事。
