# Agent 安全评估项目调研总结

> **调研时间**：2026-08-27
> **面向对象**：Agent 开发者（正在学习 agent 安全相关知识）
> **工作目录**：`/Users/divh/Downloads/安全评估agent/`

---

## 一、调研背景

本文档梳理了 GitHub 上 agent 安全评估/红队相关的开源项目，回答三个核心问题：

1. 为什么会有这么多看似重叠的项目？
2. 引入安全框架、加安全代码、还是用开源项目评估——这三种思路哪个对？
3. 作为 agent 开发者，应该按什么顺序学什么？

---

## 二、项目全景（按用途分类）

### 2.1 学术 Benchmark（顶级会议/论文）

| 项目 | 维护方 | 核心特点 | 链接 |
|------|--------|---------|------|
| **AgentDojo** | ETH Zurich SPY Lab | 评估工具调用 agent 在**间接 prompt injection** 下的行为，覆盖用户任务、工具调用、数据外泄、防御策略 | https://github.com/ethz-spylab/agentdojo |
| **Agent Security Bench (ASB)** | Rutgers 等 | **ICLR 2025 论文**；覆盖 10 个真实场景（学术咨询、理财、法律等）；含 DPI/OPI/Plan-of-Thought 后门/记忆投毒等多种攻击 | https://github.com/agiresearch/ASB |
| **OpenAgentSafety (OA-Safety)** | CMU | **ICLR 2026 论文**；350+ 多轮多用户任务；覆盖 8 大类真实风险；支持真实工具（浏览器/终端/文件系统/消息平台） | https://github.com/Open-Agent-Safety/OpenAgentSafety |
| **ASTRA** | Intuit AI Security Research | 10 真实场景 + 30+ 工具 + 140 对抗攻击；聚焦 5 类违规（guardrail bypass / 参数滥用 / 系统 prompt 泄漏 / 提权 / 死循环） | https://github.com/jie311/ASTRA |
| **Safety Adherence Benchmark** | rapturt9 | Grid-world 环境；测试 agent 在冲突指令下对安全原则的遵循能力 | https://github.com/rapturt9/SafetyAdherenceBenchmark |

### 2.2 推理端 / 模型层评估（直接测 LLM 本体）

| 项目 | 维护方 | 核心特点 | 链接 |
|------|--------|---------|------|
| **Backbone Breaker Benchmark** | Lakera + UK AI Security Institute | 测量 backbone LLM 在 agent 执行脆弱时刻的行为；用人类红队威胁快照 | https://www.lakera.ai/blog/the-backbone-breaker-benchmark |
| **Gandalf Agent Breaker** | Lakera | 公开红队挑战测试床；含 RAG、browsing、tools、memory、prompt 提取、工具投毒 | https://gandalf.lakera.ai/agent-breaker |
| **CyberSecEval** | Meta Purple Llama | LLM 网络安全基准套件 | https://github.com/facebookresearch/PurpleLlama |

### 2.3 企业自检 / 红队平台

| 项目 | 维护方 | 核心特点 | 链接 |
|------|--------|---------|------|
| **Tencent/AI-Infra-Guard (A.I.G)** ⭐ | 腾讯朱雀实验室 | **全栈 AI 红队平台**；含 SkillTrustBench（T01-T09 九大类风险，F1 最高 0.9848）；含 Agent Scan / MCP Scan / Skill Scan / AI Infra Scan / Jailbreak Eval；上 Black Hat EU Arsenal | https://github.com/Tencent/AI-Infra-Guard |
| **SafeAgents (SafeAgentEval)** | 微软 | 统一框架：Autogen/LangGraph/OpenAI Agents 多框架支持；ARIA + DHARMA 评分 | https://github.com/microsoft/SafeAgents |
| **NVIDIA NeMo Agent Toolkit Red Teaming** | NVIDIA + Lakera | 端到端 red team 评估工作流（含零售 agent 示例） | https://github.com/NVIDIA/NeMo-Agent-Toolkit |

### 2.4 政府背书 / 专项评估

| 项目 | 维护方 | 核心特点 | 链接 |
|------|--------|---------|------|
| **AgentThreatBench** | 已并入 UK AISI `inspect_evals` | 200+ 攻击载荷；专攻 **ASI06 Agent Memory Poisoning** 五大类 | https://pypi.org/project/agentthreatbench/ |
| **UK AISI inspect_evals** | UK Government BEIS | AISI 官方模型评估框架 | https://github.com/UKGovernmentBEIS/inspect_evals |

### 2.5 红队攻击框架

| 项目 | 核心特点 | 链接 |
|------|---------|------|
| **wb-red-team** | Whitebox + Blackbox 红队；分析源码自动生成多轮攻击链 | https://github.com/sundi133/wb-red-team |
| **agent-adversarial-tester** | 安全编排引擎；AI 驱动的攻击演化；高保真判定 | https://github.com/Ismail-2001/agent-adversarial-tester |
| **RedTeam-MCP** | 用 AI 规划攻击、横向移动、特权升级 | https://github.com/RELIAX1212221/RedTeam-MCP |
| **pentest-ai-agent** | AI 渗透测试 lab（Kali Linux + Metasploit + LangChain + Ollama） | https://github.com/NoamAmar07/pentest-ai-agent |
| **llm-redteam-lab** | 4 个 AI agent 的自动化红队系统；对比有无 guardrail | https://github.com/sabrinahaniff/llm-redteam-lab |
| **contemporary-agent-attacks** | 公开的 agent-security benchmark；1,669 样本（497 攻击 + 1,172 良性）；CC BY 4.0 | https://github.com/AndrewSispoidis/contemporary-agent-attacks |

### 2.6 资源索引

| 资源 | 说明 | 链接 |
|------|------|------|
| **Awesome Agentic AI Security** | benchmark 目录；含元数据（producer/coverage/maturity/limits） | https://natnew.github.io/Awesome-Agentic-AI-Security/resources/benchmarks |
| **OWASP Agentic Security Initiative** | **ASI01–ASI10 事实标准分类**（必读） | https://genai.owasp.org/resource/agentic-security-initiative |

---

## 三、为什么会有这么多项目？

两个根本原因：

**A. 攻击面太多**
一个 Agent = LLM（提示词输入） + 工具（工具调用） + 记忆（持久存储） + MCP/Plugin（外部资源） + 多 Agent 协作。每个面都有独立的研究社区，自然产生独立项目。

**B. 项目目的不同**
- 学术界做**攻防 benchmark**（论文驱动）
- 安全公司做**红队平台**（产品驱动）
- 框架作者做**开发时 SDK**（生态驱动）

三类人分别写代码，自然成倍。

---

## 四、核心澄清：三个"选项"不是选择题

下表的三种思路在 agent 安全生命周期里其实是**不同阶段**：

| 选项 | 对应阶段 | 关注点 |
|------|---------|--------|
| **① 引入安全框架** | 开发前（选型与设计） | 框架是否自带安全能力 |
| **② 加入安全代码** | 开发中（编码） | 攻防模式参考 + 复用检测逻辑 |
| **③ 开源项目评估** | 上线前后（验证） | 跑已有 benchmark |

**结论**：三个要同时用，不是三选一。
```
   开发前           开发中           上线前           上线后
   ┌─────┐         ┌─────┐         ┌─────┐         ┌─────┐
   │选型与│──①──▶  │防御性│──②──▶  │上线前│──③──▶  │持续 │
   │设计  │         │编码  │         │评估  │         │观测 │
   └─────┘         └─────┘         └─────┘         └─────┘
   威胁建模         安全模式         静态+动态测试     运行时监控
   框架选型         Guardrail        红队演练         应急响应
```

---

## 五、多维度分类

### 5.1 按开发生命周期

| 阶段 | 项目 |
|------|------|
| **开发前（选型）** | SafeAgents、Llama Guard、NeMo Guardrails |
| **开发中（编码）** | AgentDojo、ASB、wb-red-team、SkillTrustBench |
| **上线前（评估）** | **A.I.G**（最全）、ASB、OA-Safety、ASTRA、AgentThreatBench |
| **运行时（持续）** | SafeAgents（内置检测）、A.I.G Skill runtime scan |

### 5.2 按测试对象层（**回答"是否都是推理端"**）

| 层 | 含义 | 项目 |
|---|------|------|
| **模型层**（推理端 LLM） | 只测 LLM 本体的拒绝能力 | Backbone Breaker、Gandalf、CyberSecEval |
| **Agent 系统层** | 测 LLM + 工具调用 + 规划 | ASTRA、ASB、OA-Safety、AgentDojo、SafeAgents |
| **记忆层** | 测长期记忆被投毒 | AgentThreatBench |
| **MCP/Skill 供应链** | 测第三方组件 | A.I.G SkillScan / MCPScan |
| **基础设施层** | 测 AI 组件 CVE | A.I.G AI Infra Scan |
| **源码层** | 静态扫你自己的代码 | wb-red-team、A.I.G SkillScan 静态模式 |

> **关键结论：不是所有项目都是推理端。** Backbone Breaker / Gandalf / CyberSecEval 才是偏推理端的；其余绝大多数测的是 **agent 系统作为整体**。

### 5.3 按用途

| 用途 | 项目 |
|------|------|
| **学术 benchmark** | AgentDojo、ASB、OA-Safety、ASTRA、SafetyAdherenceBenchmark |
| **红队工具链** | wb-red-team、agent-adversarial-tester、RedTeam-MCP、pentest-ai-agent、llm-redteam-lab |
| **企业自检平台** | **A.I.G**（最像产品）、SafeAgents |
| **挑战/CTF** | Gandalf、contemporary-agent-attacks |
| **政府背书** | AgentThreatBench、inspect_evals |

---

## 六、按学习目标分类（学 / 了解 / 用）

### 6.1 ✅ 深入学（必须掌握）

| 资源 | 为什么必须学 |
|------|------------|
| **OWASP Agentic Security Initiative**（ASI01–ASI10） | 它是 agent 安全的事实标准分类，比任何单一项目都更"全"。**比项目更值得学** |
| **威胁建模基础**（STRIDE / LINDDUN / MAESTRO） | 你做开发，必须能自己想清楚"哪些输入会被攻击" |
| **Tencent/AI-Infra-Guard (A.I.G)** | 当你产品化的对标参考，它的 SkillTrustBench（T01–T09）几乎可以直接拿来做自检标准 |

### 6.2 👀 了解（知道存在和适用场景）

| 资源 | 知道它能干嘛就行 |
|------|-----------------|
| **ASB** (ICLR 2025) | 知道 attack 形式化分类（DPI/OPI/PoT 后门/MP） |
| **OA-Safety** (ICLR 2026) | 知道 8 类风险和真实工具的评估方法 |
| **ASTRA** | 知道 5 类违规分类 |
| **AgentDojo** | 知道间接 prompt injection 的"教科书" |
| **SafeAgents** | 知道多框架下用 ARIA/DHARMA 评分 |
| **AgentThreatBench** | 知道 memory poisoning 五类攻击 |
| **Backbone Breaker** | 知道还有人在测 LLM 本身 |

### 6.3 🛠️ 用（直接在你的工作流里跑起来）

| 资源 | 何时用 |
|------|--------|
| **A.I.G** | 每当你做完一个新功能，跑一遍 AI Infra Scan + Agent Scan |
| **SkillTrustBench** (A.I.G 的一部分) | 每次引入一个第三方 Skill/MCP 之前扫一下 |
| **wb-red-team** | 你的 agent 涉及复杂工具编排时，用它做白盒分析 |
| **AgentDojo** | 想快速验证你的 system prompt 是否抗注入时 |
| **AgentThreatBench** | 你的 agent 用了持久记忆时 |

---

## 七、容易忽略但更重要的维度

这几个**比项目本身更重要**，容易漏：

1. **OWASP Agentic Security Initiative（ASI01–ASI10）**——它是**目录和术语表**，所有项目都基于它分类。学它一个胜过学十个项目。
2. **威胁建模**——在写第一行代码前就要做的"假设攻击"。**STRIDE**（通用）或 **MAESTRO**（专为 LLM agent 设计）任选。
3. **运行时守卫（runtime guardrails）**——评估只能告诉你"哪里有洞"，守卫能"挡住"洞。开源的有 **Llama Guard**、**NeMo Guardrails**；商业的有 **Lakera Guard**、**Prompt Armor**。
4. **可观测性（observability）**——一旦出问题你要能"复盘"。**LangSmith / Langfuse / Phoenix (Arize)** 是 agent 领域的主流。比"事后修复"更重要的"事后溯源"。
5. **合规与标准**——**NIST AI RMF**、**EU AI Act**、**ISO/IEC 42001**。学不学看你的目标客户，但不学的话企业客户很难接受你。
6. **测试驱动安全（security-as-test）**——把"安全断言"当作 unit test 一样写进 CI，而不是最后才评估。`pytest` + 上面任何一个 benchmark 就能起步。

---

## 八、学习路线（4 阶段推进）

| 阶段 | 时间投入 | 重点 | 产出 |
|------|---------|------|------|
| **P1 基础概念** | 1-2 周 | OWASP ASI01-10、AgentDojo 论文、威胁建模 STRIDE/MAESTRO | 能看懂其他 benchmark 在测什么 |
| **P2 参考架构** | 2-3 周 | ASB + OA-Safety + ASTRA 论文；把 AgentDojo 跑起来 | 能设计一个 threat model |
| **P3 防御性开发** | 并行 | SkillTrustBench T01-T09；ASTRA 攻击分类；写 `guardrail.py` 模块 | 自带安全的代码习惯 |
| **P4 评估与红队** | 持续 | 部署 A.I.G；wb-red-team 接入 CI | CI 里有 `security-scan` 步骤 |

**P1+P2 是基础**，**P3 是你的代码能力**，**P4 是工程化保障**。前两步"学"，后两步"用"。

### 推荐优先级（按个人身份）

| 你是 | 第一步学 | 主要用 |
|------|---------|--------|
| **agent 开发者** | ASI01-10 + AgentDojo | A.I.G SkillTrustBench、A.I.G Agent Scan |
| **产品 / 平台** | A.I.G 全栈架构 + ASB | A.I.G、SafeAgents |
| **学术研究** | ASB / OA-Safety 论文 | 各 benchmark 复用 |

---

## 九、下一步具体动作

**就今天能做的事**：打开 https://genai.owasp.org/resource/agentic-security-initiative 通读 ASI01–ASI10。读完后回看 ASB 会发现它就是把这 10 条**具体化成了评估场景**。

可选的下一步方向（任选其一）：

1. 把 OWASP ASI01-10 的中文对照表 + 每个对应的项目映射整理成 markdown
2. 把 A.I.G clone 下来做个本地试跑 demo
3. 针对现在做的 agent 类型给出更具体的 guardrail 代码模板
4. 把 AgentDojo 论文的核心章节整理成精读笔记

---

## 十、调研来源与可信度

- **搜索范围**：GitHub 公开仓库 + 官方论文 + 安全厂商博客
- **重点核实**：A.I.G 在 Black Hat EU Arsenal 的官方记录、AgentThreatBench 被 UK AISI 合并的事实、ASB/OA-Safety 在 ICLR 的接收情况
- **未核验项**：部分小型项目（llm-redteam-lab、pentest-ai-agent 等）的活跃度，需自行访问仓库看 commit history
- **最后更新**：2026-08-27

---

**附录：所有项目 URL 速查表（去重）**

```
https://github.com/ethz-spylab/agentdojo
https://github.com/agiresearch/ASB
https://github.com/Open-Agent-Safety/OpenAgentSafety
https://github.com/jie311/ASTRA
https://github.com/microsoft/SafeAgents
https://github.com/microsoft/SafeAgentEval
https://pypi.org/project/agentthreatbench/
https://github.com/UKGovernmentBEIS/inspect_evals
https://github.com/rapturt9/SafetyAdherenceBenchmark
https://www.lakera.ai/blog/the-backbone-breaker-benchmark
https://gandalf.lakera.ai/agent-breaker
https://github.com/facebookresearch/PurpleLlama
https://github.com/NVIDIA/NeMo-Agent-Toolkit
https://github.com/Tencent/AI-Infra-Guard
https://github.com/sundi133/wb-red-team
https://github.com/Ismail-2001/agent-adversarial-tester
https://github.com/RELIAX1212221/RedTeam-MCP
https://github.com/NoamAmar07/pentest-ai-agent
https://github.com/sabrinahaniff/llm-redteam-lab
https://github.com/AndrewSispoidis/contemporary-agent-attacks
https://natnew.github.io/Awesome-Agentic-AI-Security/resources/benchmarks
https://genai.owasp.org/resource/agentic-security-initiative
```
