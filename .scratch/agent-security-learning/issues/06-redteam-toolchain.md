# 红队工具链选型

Type: research
Status: resolved
Blocked by:

## Question

路线 4 红队部分在 Mac 上的工具组合怎么选？候选：garak、PyRIT、Tencent A.I.G（AI-Infra-Guard）、AgentDojo。对比维度：Mac 可运行性（Python 版本 / 模型依赖 / GPU 需求）、对"攻击本地 LangGraph + MCP Agent"的适配度、攻击 payload 回归集进 CI 的载体选择。给出组合推荐（哪几个全量用、哪几个了解即可）。

## Answer

**组合推荐：garak 全量用（广撒网扫描 + payload 库），PyRIT 全量用（自定义攻击编排 + CI 回归载体），A.I.G 只取 MCP-Scan 单组件（扫 MCP server 源码），AgentDojo 了解即可（固定环境的学术基准，非打自己 agent 的工具）。**

### 逐项对比

**1. NVIDIA garak —— 全量用**

- Mac 可运行性：官方明确"developed in Linux and OSX"，Apple Silicon 无障碍；纯 pip 安装（`pip install -U garak`），Python 要求 3.11–3.13（源码安装路径注明 `python>=3.11,<=3.13`）；打 API 型目标不需要 GPU；模型依赖灵活——支持 OpenAI 兼容 API、Ollama（经 litellm/REST）、以及"pretty much anything accessible via REST"。
- 适配度：关键在 `rest.RestGenerator`——用一小段 YAML 描述任意 HTTP 端点即可把本地 Agent 包装成 garak 的 target（把 LangGraph Agent 用 FastAPI 暴露一个 chat 端点即可）。自带 20+ probe 家族：promptinject（间接注入）、dan、encoding（编码注入）、xss、leakreplay、packagehallucination 等，覆盖提示注入主战场。局限：它把 target 当单轮/对话黑盒，不感知工具调用轨迹——"注入是否诱发了恶意 tool call"要靠自定义 detector 或交给 PyRIT。
- CI：CLI 工具，每次跑生成 JSONL report + hit log；回归门槛可用脚本解析 hitlog/失败率实现，payload 集可经 `--probes` 白名单收敛。学习价值：快速建立"漏洞类别 → probe → detector"的心智模型。

来源：[NVIDIA/garak README](https://github.com/NVIDIA/garak)

**2. Azure PyRIT —— 全量用**

- Mac 可运行性：纯 Python 库，`pip install pyrit`，支持 Python 3.10–3.13（官方文档推荐 3.13）；无 GPU 需求；scorer/converter 需要的 judge 模型可用任意 OpenAI 兼容端点或本地 Ollama（通过自定义 target 接），不绑定 Azure。
- 适配度：这是四者中对"攻击自己写的 Agent"最贴合的。核心是 `PromptTarget` 抽象——继承并实现 `send_prompt_async(message)` 即可把本地 LangGraph + MCP Agent 变成一等公民 target（进程内直接调 graph，比 HTTP 更利于断言内部状态）；`PromptChatTarget` 支持改对话历史，支撑 PAIR/TAP/Crescendo 等多轮攻击。Converters 可叠加做 payload 变换（base64、ROT13、Unicode 等），Scorers 支持 true/false、分类、自定义逻辑——正好用来写"注入后不得调用 send_email 工具"这类确定性断言。内置 memory（SQLite）记录全部攻击会话。
- CI：它就是 Python 库而非平台，attack + scorer 天然写成 pytest 用例；payload 回归集以 YAML/JSON 存仓库，CI 里跑确定性子集（固定 judge 模型 + 断言型 scorer），这是四者中进 CI 最顺的载体。

来源：[PyRIT 安装文档](https://github.com/Azure/PyRIT/blob/main/doc/setup/install_pyrit.md)、[PyRIT Prompt Targets 文档](https://azure.github.io/PyRIT/code/targets/0_prompt_targets.html)、[PyRIT 官方文档站](https://azure.github.io/PyRIT/)

**3. Tencent A.I.G（AI-Infra-Guard）—— 只取 MCP-Scan 单组件，平台整体了解即可**

- Mac 可运行性：Docker 部署（Docker 20.10+，4GB RAM / 10GB 磁盘），官方明确跨平台含 macOS，Apple Silicon Docker 可跑；MCP/Skill/Agent scan 也有独立 CLI（如 `pip install aig-skill-scan`）。扫描/越狱评估需要配置一个 LLM API key（模型驱动的扫描器）。注意：项目自声明"无认证机制，不得部署到公网"，仅本地用。
- 适配度：五个模块里与本关直接相关的是 **MCP Server scan**——支持扫源码或远程 URL，检测 14 大类风险（tool poisoning、credential exfiltration、command injection 等），正好覆盖自己写的 MCP 工具层。**Agent Scan 主要适配 Dify/Coze 等平台化 agent**，对接任意本地 LangGraph 编排不是它的目标场景；Jailbreak Evaluation 与 garak/PyRIT 功能重叠。
- CI：平台走 Web UI + API（localhost:8088），CI 友好度一般；但独立 CLI（`aig-skill-scan` / mcp-scan CLI，`-o result.json`）可以直接进流水线。结论：在"工具层安全"小节用 mcp-scan CLI 扫一遍自己的 MCP server 源码即可，不必全量引入平台。

来源：[Tencent/AI-Infra-Guard README](https://github.com/Tencent/AI-Infra-Guard)

**4. ethz-spylab AgentDojo —— 了解即可（作为攻击语料与评估方法论参考）**

- Mac 可运行性：`pip install agentdojo` 纯 Python，跑基准用 API 模型无需 GPU（仅内置 PI detector 需 `transformers` extra，可选）；无 Mac 障碍。
- 适配度：它是**基准环境**而非通用红队工具——97 个 user task + 629 个 injection task 跑在它自带的 workspace/travel/banking/slack 四个固定套件里，评估的是"模型 + 防御管线"在这些环境里的 utility/security。虽然提供自定义 pipeline/attack/task-suite 的扩展点，但要把自己的 LangGraph + MCP Agent 塞进它的形式化 utility-check 框架，改造成本远高于直接用 PyRIT。官方也提示 API 仍在变动。
- 价值：① 629 条 injection payload 是现成的回归集语料，可挑与"工具滥用/数据外泄"相关的条目移植进 PyRIT 回归集；② 它的三指标（benign utility / utility under attack / security）是面试可讲的评估方法论；③ 想了解防御侧（tool_filter 等）实现时可读源码。

来源：[AgentDojo 文档站](https://ethz-spylab.github.io/agentdojo/)、[ethz-spylab/agentdojo](https://github.com/ethz-spylab/agentdojo)、[AgentDojo 论文 (NeurIPS 2024 D&B)](https://arxiv.org/abs/2406.13352)

### 落地形态（一句话）

起步 Agent 暴露一个薄 HTTP 层：garak 走 REST generator 做宽谱扫描发现面，PyRIT 进程内自定义 `PromptTarget` 做深度攻击编排 + 确定性 scorer，payload 回归集 = PyRIT pytest 用例 + 从 AgentDojo 移植的注入语料，A.I.G 的 mcp-scan CLI 作为工具层源码扫描的独立 CI 步骤。
