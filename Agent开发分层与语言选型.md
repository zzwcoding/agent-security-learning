# Agent 开发分层地图与语言选型（路线 3/4 参考）

> 生成：2026-08-31；数据来源：GitHub API 实时查询（star 为当日量级，仅供比较量级，不是质量）。
> 用途：路线 3（城堡）开工时的语言选型依据。**数据有时效，路线 3 开工前应重新拉一遍校验。**
> 结论由主线窗口研究产出，开工时需再详细讨论。

## 0. 判定（TL;DR）

- **"从路线 3 开始全线转 JS"不合适；"从路线 3 引入 TS 作为 MCP 客户端/产品交付层的语言"非常合适**——这正是业界产品层的事实标准位。
- 路线 3 的核心重资产（授权引擎、MCP 网关）是**部署 + 精读对象，不是你写的代码**，它们的语言不约束你。
- 三语策略：**Python = 安全工程主力；TypeScript = 产品/MCP 客户端交付层（自路线 3 引入）；Go/Rust = 只部署只精读不写**。
- 路线 4 保持 Python：红队武器（garak/PyRIT）与端云生态（Presidio/RouteLLM/llama_index）是 Py 垄断区，JS 无对应物。

## 1. 分层地图（GitHub API 2026-08-31 实测）

| 层 | 代表项目（语言 / ★） | 该层的"你做什么" |
|---|---|---|
| 产品/交互层 | vercel/ai **TS** 26.5k；mastra **TS** 27.6k；claude-agent-sdk **TS** 1.7k | **写**：agent 产品交付 |
| 智能编排层 | langchain **Py** 145k vs langchainjs **TS** 18k；langgraph **Py** 40.8k vs langgraphjs **TS** 3.2k | **写**：ReAct/工具/记忆/护栏（差 8-12 倍，Py 是参考实现） |
| MCP/协议层 | typescript-sdk **TS** 13.3k（**官方参考实现**）、python-sdk **Py** 24.2k、ContextForge **Py** 4.4k | **写**（client 侧）+ **精读**（网关源码是 Python） |
| 授权层 | openfga **Go** 5.7k、spicedb **Go** 7k、agentic-authz **TS** 65★（小 demo） | **部署 + DSL 建模**（语言无关）+ 客户端集成 |
| 沙箱/基础设施层 | microsandbox **Rust** 8k、firecracker **Rust** 36.4k、gvisor **Go** 19.2k | **部署 + 精读 + 调 SDK**，不是写 |
| 安全工具层 | llm-guard **Py** 3.2k、NeMo **Py** 7k、garak **Py** 9.1k、PyRIT **Py** | **写/用**——Python 垄断，JS 无对应物 |
| 观测/密钥层 | langfuse **TS** 34k、openlit **TS** 2.7k、Infisical **TS** 29k、vault **Go** 36.2k | 部署 + SDK 调用（TS 意外地强） |
| 模型/端云层 | llama.cpp **C++** 126k、ollama **Go** 179.8k、presidio **Py** 10.7k、RouteLLM **Py** 5.4k、llama_index **Py** 51.9k | 部署 + 精读 + **Py 生态封装**（路线 4 主场） |

读数注意：GitHub 的 language 字段是"字节数最多的语言"——E2B 主仓标 Python（实为 TS SDK + 多语言仓）、claude-agent-sdk 标 Shell（CLI 薄封装），要结合仓库内容解读。

## 2. 逐路线语言现实

### 路线 3（城堡）——混合最自然的一条

| 路线 3 的活 | 语言 | 理由 |
|---|---|---|
| 被治理的 agent（消费端）+ MCP client | **TS** | typescript-sdk 是官方参考实现（协议母语）；业界产品层 agent 本来就长在 TS |
| ContextForge 网关：部署、源码精读、（若做）插件 | **Py** | 网关本体是 Python/FastAPI；精读+扩展点跟宿主语言顺手 |
| OpenFGA：部署 + ReBAC 授权矩阵建模 | **语言无关** | 它的 DSL/JSON 是自有语法；产出物是模型思想（Zanzibar），不是代码 |
| 哈希链日志（几十行锚点件） | 跟宿主 | 嵌进网关就 Py；独立服务则自由，建议跟 TS 消费端同语言 |

### 路线 4（攻防者）——留 Python

红队武器（garak/PyRIT）、端云生态（Presidio encrypt、RouteLLM、llama.cpp/ollama 的封装生态）全是 Py/C++/Go 垄断。硬转 JS = 安全工具链全部重购，零收益。唯一合理的 TS 触点：把红队攻击回归集跑在被治理的 TS agent 上（攻你的产品才是真攻防）。

## 3. 两个关键认知（选型讨论的前提）

1. **"语言学路线"是伪问题，"每层你写什么代码"才是真问题**。路线 3/4 的大多数重资产（OpenFGA/网关/沙箱/向量库）是部署+调 API 的对象；语言选择只作用于"你亲手写的锚点件"（凭证代理、哈希链、授权矩阵、攻击回归集+路由器）。
2. **分层靠协议解耦，不靠语言换位**。MCP（client↔server）、OTel（观测）、HTTP（服务间）是层间的粘合剂——语言选型因此可以按层独立做决定，这正是微服务拼法。用户提的"agent=TS、沙箱=Go/Rust、RAG=Py 服务"就是标准形态；补充完整版还要加：授权=Go 服务（OpenFGA）、观测=TS 服务（Langfuse 本体就是 TS 写的）。

## 4. 路线 3 开工时的检查清单

- [ ] 重新拉一遍上表数据校验时效（GitHub API，同口径）
- [ ] 确认 TS 侧 MCP client 技术位：@modelcontextprotocol/sdk + 产品层框架（Vercel AI SDK / Mastra 择一）
- [ ] ContextForge 版本与插件扩展点语言（Py）是否仍如本表
- [ ] OpenFGA 建模语言无关确认（DSL/JSON），决定授权矩阵文档形式
- [ ] 与主线窗口讨论：路线 3 的 agent（TS）是否复用 starter-agent 的安全形态（护栏/凭证/审计的 TS 等价物清单见 lesson 0025 与 langchainjs middleware 目录）
