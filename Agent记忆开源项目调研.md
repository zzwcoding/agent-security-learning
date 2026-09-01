# Agent 记忆(Memory)开源项目调研报告

> 调研日期:2026-09-01。所有 star 数、fork 数、最近推送时间(pushed_at)均通过 GitHub API(`https://api.github.com/repos/{owner}/{repo}`)于当日实时获取;架构描述来自各仓库 README、官方文档与 arXiv 论文原文。每条关键论断后附来源链接。
>
> **重要现状提示**(2026 年这一年的几个关键变化):
> - `letta-ai/letta` 已变为落地页,活跃源码迁至 `letta-ai/letta-code`(Letta Code),旧 V1 server 存档于 `archive` 分支([letta README](https://github.com/letta-ai/letta));
> - `GibsonAI/memori` 已迁移为 `MemoriLabs/Memori`,定位从"SQL 优先记忆引擎"升级为"企业级 agent 记忆基础设施"([GitHub API 重定向](https://api.github.com/repositories/1025381911));
> - `mem0ai/openmemory` 独立仓库已转型为"跨 Claude Code/Codex/OpenCode 移植编码会话"的 CLI/TUI 工具([repo](https://github.com/mem0ai/openmemory));
> - Zep 社区版(Community Edition)停止支持,代码移入 `getzep/zep` 的 `legacy/` 目录([zep README](https://github.com/getzep/zep))。

---

## 1. TL;DR:对比总表

| 项目 | Star(2026-09-01) | 记忆表示 | 写入机制 | 检索机制 | 部署形态 / License | 一句话差异化 |
|---|---|---|---|---|---|---|
| **mem0ai/mem0** | 64,461 | 向量记忆条目(事实句)+ 可选图记忆;User/Session/Agent 三级作用域 | 对话后 LLM 抽取;论文版为 extraction→update 双阶段(ADD/UPDATE/DELETE/NOOP),2026-04 新算法改单遍 ADD-only + 实体链接 | 语义 + BM25 + 实体多信号融合 + 时间推理 + 衰减排序 | 嵌入库 / Docker 自托管 / 云平台;Apache-2.0 | 事实条目型记忆层事实标准,集成面最广,营销与基准最激进 |
| **getzep/graphiti**(Zep 引擎) | 30,470(Graphiti)/ 4,883(zep 示例仓) | 双时序知识图谱:实体(节点,摘要随时间演化)+ 事实(边,带有效期窗口)+ episode(溯源) | 对话/业务数据增量抽取为三元组,旧事实失效不删除 | 语义 + BM25 + 图遍历混合,亚秒级 | 自托管框架(Apache-2.0)+ Zep 托管云(闭源引擎) | 唯一把"时间"做成一等公民的图谱记忆,冲突=事实失效而非覆盖 |
| **topoteretes/cognee** | 30,376 | 知识图谱 + 向量混合(文档→实体关系图+嵌入) | ECL(Extract-Cognify-Load)管线批/流式摄入;新 API 为 remember/recall/forget/improve | 语义/图/混合检索,auto-routing | 库 + Docker + MCP + 云;Apache-2.0 | 面向"公司大脑"的知识图谱记忆,重数据工程与本体 |
| **letta-ai/letta**(原 MemGPT) | 24,513(letta)/ 3,166(letta-code) | 分层上下文:core memory blocks(在上下文中,可自编辑)+ recall(对话历史)+ archival(向量库) | agent 用记忆工具自己编辑 core memory;sleep-time agent 后台整理("做梦") | 分层检索:blocks 常驻 + archival 语义搜索 + recall 历史搜索 | letta-code(npm,编码 agent 产品) + App Server 自托管 + 云;Apache-2.0 | "LLM 操作系统"思想发源地:记忆是被 agent 主动管理的可编辑对象 |
| **NevaMind-AI/memU** | 14,363 | Markdown 文件"Wiki" + 可复用技能(skills),嵌入索引 | agent 自身定时"自演化"任务把会话史蒸馏成技能/记忆 Markdown | 按任务检索相关 skill(嵌入匹配) | 云(memu.so)+ 自托管;Apache-2.0(LICENSE.txt) | 把记忆做成"人可读的文件 + 技能沉淀",为编码 agent 生态服务 |
| **MemoriLabs/Memori**(原 GibsonAI/memori) | 16,302 | SQL 结构化记录:`memori_conversation_message` / `entity_fact` / `process_attribute` / `knowledge_graph` 四类表 | 注册 LLM 客户端后同步捕获消息 + 后台异步抽取事实 | SQL 查询 + 召回注入 | SDK(Python/TS)+ Memori Cloud + BYODB 自托管;README 标 Apache-2.0(API 归为 NOASSERTION) | "记忆住进你自己的数据库",10+ 种 SQL/NoSQL 后端 |
| **MemTensor/MemOS** | 11,122 | MemCube(内容+元数据)统一封装:明文 / 激活(KV)/ 参数三类记忆 | MemScheduler 异步摄入;记忆反馈修正;技能结晶(L1 轨迹/L2 策略/L3 世界模型) | 混合检索(自托管 Neo4j+Qdrant;本地插件 SQLite FTS5+向量) | 云 API / Docker 自托管 / agent 本地插件;Apache-2.0 | 学术上最激进的"记忆操作系统",三类记忆统一调度 |
| **OSU-NLP-Group/HippoRAG** | 3,973 | OpenIE 三元组图 + 向量,Personalized PageRank | 离线索引(openIE + PPRL 去重) | 图检索 + PPR 扩散 + 向量 | 嵌入式库(pip);MIT | "海马体"启发的非参数持续学习,ICML'25,偏文档记忆而非对话 |
| **basicmachines-co/basic-memory** | 3,821 | 本地 Markdown 文件 + wikilink 构成的知识图谱 + observations | 人和 AI 经 MCP 读写同一批 Markdown,双向同步 | 语义搜索(可选 Milvus+Postgres)+ 关键词 | MCP 服务器(uv 安装)+ 云;AGPL-3.0 | 最彻底的"本地优先":知识就是磁盘上的人可读文本 |
| **memodb-io/memobase** | 2,872(2026-01 后基本停更) | 预定义槽位的用户画像(profile)+ 事件时间线 | 用户级 buffer 攒批对话后固定 3 次 LLM 调用写入 | 画像直读(<100ms)+ 时间线检索 | 自托管(FastAPI+Postgres+Redis)+ 云;Apache-2.0 | ChatGPT Memory 式画像记忆:可定义想记什么,读缓存极快 |
| **Mirix-AI/MIRIX** | 3,438 | 六类记忆库:Core/Episodic/Semantic/Procedural/Resource/Knowledge Vault | 元 agent 调度六个记忆 agent 分工写入;auto-dream 定期合并去重 | PostgreSQL 原生 BM25 + 向量相似度 | Docker 后端 + 桌面 app(截屏);Apache-2.0 | 多 agent 管多记忆库,面向"看屏幕的个人助理" |
| **langchain-ai/langmem** | 1,635 | LangGraph Store 中的语义记忆(集合/画像)、情景记忆、程序性记忆(提示词) | 热路径(工具即时存)与后台管理器(会话后反思)双模式 | 命名空间 + 语义搜索 + 元数据过滤,强度/新近度加权 | pip 库,依托 LangGraph 平台;MIT | LangChain 官方记忆 SDK:不造存储,给"记忆该怎么写"的方法论 |
| **agiresearch/A-mem** | 1,161(2025-12 后停更) | Zettelkasten 卡片笔记:结构化属性 + 笔记互联网络 | 新记忆生成笔记→找相似→建链→触发旧记忆演化 | ChromaDB 向量检索 | 研究原型;MIT | 学术界"记忆会生长"的代表:记忆之间自动链接与演化 |
| **supermemoryai/supermemory**(补充) | 29,170 | 记忆 + RAG 统一本体:事实、用户画像、连接器内容 | 对话自动抽取、矛盾处理、过期遗忘 | 混合搜索,宣称 ~50ms 画像 | API/云 + 自托管;MIT | 记忆与 RAG 合一"context 引擎",自称 LongMemEval/LoCoMo/ConvoMem 三榜第一 |

---

## 2. 按技术路线分组深讲

### 路线一:向量 + 画像档案 —— "记忆层即服务"

这是当前最主流、商业化最成熟的路线:把对话抽取成离散的事实条目(向量)或用户画像(结构化槽位),以"记忆层"SDK/API 的形式插进任意 agent。

#### 2.1.1 mem0ai/mem0

- **定位与架构**:自称"Universal memory layer for AI Agents",在应用与 LLM 之间加一层可持久化、可检索的记忆,支持 User/Session/Agent 三级记忆作用域([README](https://github.com/mem0ai/mem0))。
- **记忆模型**:记忆 = 一条条自然语言事实(如"用户喜欢草莓"),以向量条目存储,带 user_id/agent_id/run_id 元数据;另有可选的**图记忆**(Mem0ᵍ,论文中基于 Neo4j 实现)捕捉实体关系([论文 arXiv:2504.19413](https://arxiv.org/abs/2504.19413))。
- **写入管线**:经典描述是**两阶段管线**——extraction(从对话抽取候选事实)→ consolidation/update(与相似旧记忆比对后执行 ADD/UPDATE/DELETE/NOOP 四种操作),这是去重与冲突消解的核心([论文 arXiv:2504.19413](https://arxiv.org/abs/2504.19413))。**2026 年 4 月新算法**则反其道而行:**单遍 ADD-only 抽取**(一次 LLM 调用、不再 UPDATE/DELETE,记忆只增不改),配合实体链接、写时时间分类与"记忆衰减"排序;官方称该版本只服务于托管平台,开源 SDK 数字会有差距([README "New Memory Algorithm"](https://github.com/mem0ai/mem0)、[mem0.ai/research](https://mem0.ai/research))。
- **检索**:新算法为**多信号融合**——语义、BM25 关键词、实体匹配并行打分后融合,加时间感知重排(区分"现在/过去/将来"的问题),`pip install mem0ai[nlp]` 可启用混合检索([README](https://github.com/mem0ai/mem0)、[research 页](https://mem0.ai/research))。
- **存储后端**:支持 22 种向量库(Qdrant 默认,含 Chroma/PGVector/Milvus/Pinecone/Redis/OpenSearch/FAISS 等)([docs: vectordbs](https://docs.mem0.ai/components/vectordbs/overview));图记忆需图库(论文用 Neo4j)。
- **集成**:Python/TS SDK、CLI(`mem0 add/search`)、LangGraph/CrewAI 集成指南、agent skills 目录、自托管 server(docker compose,默认带鉴权)([README](https://github.com/mem0ai/mem0))。OpenMemory MCP 最初作为 mem0 的本地 MCP 记忆服务推出;目前主仓根目录已无 openmemory 子目录,独立仓库 `mem0ai/openmemory` 已于 2026-07 转型为编码会话移植工具(32 star)([repo](https://github.com/mem0ai/openmemory)、[mem0 主仓根目录](https://api.github.com/repos/mem0ai/mem0/contents/))。
- **部署/license/活跃度**:嵌入库 / 自托管 server / 云平台三档;Apache-2.0;64,461 star,最近推送 2026-08-31,极活跃([GitHub API](https://api.github.com/repos/mem0ai/mem0))。
- **官方 benchmark**:论文版 LoCoMo(LLM-as-a-Judge):Mem0 66.88%(1,764 tokens/题,p95 1.44s)、Mem0ᵍ 68.44%,对比 Zep 65.99%、LangMem 58.10%、OpenAI memory 52.90%、A-Mem 48.38%、全上下文 72.90%(26,031 tokens);宣称对 OpenAI 相对提升 26%、p95 延迟降 91%、token 省 90%+([论文 Table 2,arXiv:2504.19413](https://arxiv.org/html/2504.19413v1))。2026-04 新算法:LoCoMo 92.5、LongMemEval 94.4、BEAM(1M)64.1 / BEAM(10M)48.6,均注明是**托管平台数字**(含开源版没有的专有优化),评测框架在 [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) 开源([README](https://github.com/mem0ai/mem0))。与 Zep 的分数之争见 §3.5。

#### 2.1.2 memodb-io/memobase

- **定位与架构**:用户画像型记忆系统,"类似 ChatGPT 背后的记忆":每个用户常驻一份 profile + 事件时间线,读取只需几次 SQL,在线延迟 <100ms([README](https://github.com/memodb-io/memobase))。
- **记忆模型**:**预定义槽位画像**(basic_info/demographics/interest/psychological/work…,可由开发者自定义增删槽位)+ **事件时间线**(回答时间相关问题)([README](https://github.com/memodb-io/memobase)、[docs: profile](https://docs.memobase.io/features/profile/profile))。
- **写入管线**:每个用户有 buffer,**会话后攒批处理**,系统内刻意"没有 agent"以控制成本;v0.0.40 起单次写入固定 3 次 LLM 调用,较此前 3-10 次省 40-50% token;v0.0.37 加入细粒度 event gist 支持时间线检索([README News](https://github.com/memodb-io/memobase))。设计哲学是"记用户,不记 agent",记什么是开发者通过 schema 决定的。
- **检索**:画像直读(无预处理)+ 时间线/事件检索 + context API(把记忆直接打包成 prompt,500-1000ms)([README](https://github.com/memodb-io/memobase))。
- **存储后端**:FastAPI + Postgres + Redis,全 Docker 化([README](https://github.com/memodb-io/memobase))。
- **集成**:Python/Node/Go SDK、MCP、Playground([README](https://github.com/memodb-io/memobase))。
- **部署/license/活跃度**:自托管或云;Apache-2.0;2,872 star,**最后推送 2026-01-11,基本停更**——团队重心已转向新项目 Acontext(3,679 star,"Agent Skills as a Memory Layer")([GitHub API](https://api.github.com/repos/memodb-io/memobase)、[Acontext](https://github.com/memodb-io/Acontext))。
- **官方 benchmark**:自测 LoCoMo v0.0.37 总分 75.78(时间类 85.05 最强、多跳 46.88 偏弱),其他系统分数引自 mem0 论文,并应 Zep 要求加入 Zep* 75.14 一行([locomo-benchmark 文档](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md))。

#### 2.1.3 langchain-ai/langmem

- **定位与架构**:LangChain 官方记忆 SDK,不自带存储,而是提供"记忆原语 + LangGraph Store 原生集成"(核心 API 无状态,存储交给 LangGraph `BaseStore`,生产用 Postgres Store)([README](https://github.com/langchain-ai/langmem)、[概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/))。
- **记忆模型**:对照人类记忆分三类——**语义记忆**(事实,两种形态:无限增长的 collections、就地更新的 schema 化 profiles)、**情景记忆**(过往经历作为 few-shot 学习样例)、**程序性记忆**(系统提示词本身,经 `create_prompt_optimizer` 按反馈进化)([概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/))。
- **写入管线**:双模式——**热路径**(对话中 agent 调记忆工具即时写入,延迟可感)与**后台**(会话结束后 LLM 反思抽取,牺牲时效换深度);整合(consolidation)时显式处理"删除/失效 or 更新/合并"([README](https://github.com/langchain-ai/langmem)、[概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/))。
- **检索**:多级命名空间(如 `("acme", "{user_id}", "code_assistant")`)+ 语义搜索 + 元数据过滤;相关性不只看语义相似,还叠加记忆的**重要性与"强度"(最近/最常被用)**([概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/))。
- **部署/license/活跃度**:pip 库,MIT,1,635 star,2026-08-11 仍有推送([GitHub API](https://api.github.com/repos/langchain-ai/langmem))。注意:它是最轻的"方法论库",深度依赖 LangGraph 生态。

### 路线二:知识图谱 + 时序 —— "记忆是一张会过期的图"

#### 2.2.1 getzep/graphiti(Zep 的开源引擎)与 Zep 产品线

- **定位与架构**:Graphiti 是构建**时序知识图谱/上下文图(context graph)**的开源框架,是 Zep 的底层引擎;Zep 本身则是托管型企业平台,底层是专有"Context Graph Engine"图数据库,不再要求第三方图库([Graphiti README](https://github.com/getzep/graphiti))。
- **记忆模型**:节点 = 实体(人/产品/政策,摘要随时间演化);边 = 事实三元组,带**有效期窗口**(何时为真、何时被取代);episode = 原始摄入数据,所有派生事实可溯源;本体可用 Pydantic 预定义(prescribed)或从数据涌现(learned)([Graphiti README](https://github.com/getzep/graphiti))。论文架构为三层子图:episode 子图 → 语义实体子图 → 社区子图,并采用双时序数据模型(事件时间 vs 系统时间)([论文 arXiv:2501.13956](https://arxiv.org/abs/2501.13956))。
- **写入管线**:episode 增量摄入、实时成图,无需整图重算;**冲突消解 = 旧事实被"失效(invalidate)"而非删除**,时间历史完整保留;依赖 LLM 结构化输出做实体/边抽取与去重([Graphiti README](https://github.com/getzep/graphiti))。
- **检索**:语义嵌入 + BM25 关键词 + 图遍历三路混合,含图距离重排与搜索配方(search recipes);宣称生产环境 sub-200ms([Graphiti README](https://github.com/getzep/graphiti)、[Zep 对比表](https://github.com/getzep/graphiti))。
- **存储后端**:Neo4j 5.26、FalkorDB(含嵌入式 falkordblite)、Amazon Neptune + OpenSearch;Kuzu 已弃用(上游停止维护)([Graphiti README](https://github.com/getzep/graphiti))。
- **集成**:官方 MCP server(`mcp_server/`)、FastAPI REST 服务、LangGraph agent 教程;Zep 侧提供 Python/TS/Go SDK 与 CrewAI/LangGraph/AutoGen/AG2/Pydantic AI/Mastra/Vercel AI SDK/LiveKit 等集成包([Graphiti README](https://github.com/getzep/graphiti)、[zep README](https://github.com/getzep/zep))。
- **部署/license/活跃度**:Graphiti Apache-2.0 自托管,30,470 star,2026-09-01 仍在推送;`getzep/zep` 仓库现仅存示例与集成(4,883 star),社区版已废弃移入 `legacy/`([zep README](https://github.com/getzep/zep)、[开源战略公告](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/))。
- **官方 benchmark**:Zep 论文:DMR 上 94.8% vs MemGPT 93.4%;LongMemEval 准确率最高 +18.5%、延迟降 90%([arXiv:2501.13956](https://arxiv.org/abs/2501.13956));回应 mem0 论文的博文中给出修正后 LoCoMo J 分 75.14%±0.17,后续更新宣称"80%、<200ms"([Zep 博客](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/))。争议详见 §3.5。

#### 2.2.2 topoteretes/cognee

- **定位与架构**:开源"AI 记忆平台":任意格式数据摄入→自托管知识图谱→向量+图混合检索;核心是模块化 **ECL(Extract-Cognify-Load)管线**(官方 PyPI 描述与 [cognee 博客](https://www.cognee.ai/blog/deep-dives/grounding-ai-memory)、[PyPI](https://pypi.org/project/cognee/0.1.26/))。
- **记忆模型**:文档/对话/音频等被 Cognify 成"实体-关系图谱 + 向量嵌入"双表示,基于认知科学启发的本体生成;强调 tenant 隔离、溯源、审计([README](https://github.com/topoteretes/cognee))。
- **写入管线**:新四操作 API:`remember`(= add + cognify + improve)、会话级 `remember(session_id=...)`(快缓存、后台同步进图)、`forget`、`improve`;`AUTO_FEEDBACK=true` 时每次回答后多一次 LLM 调用来自我调优记忆([README](https://github.com/topoteretes/cognee))。
- **检索**:`recall` 自带 auto-routing 自动选检索策略;支持语义/图/混合([README](https://github.com/topoteretes/cognee))。
- **存储后端**:Docker profiles 提供 Postgres/PGVector、Neo4j 等;发布 `cognee/cognee` 与 `cognee/cognee-mcp` 镜像([README](https://github.com/topoteretes/cognee))。
- **集成**:MCP server、Claude Code 记忆插件(钩子捕获 prompt/工具轨迹、会话结束同步进图)、OpenClaw 插件、Rust/TS 客户端([README](https://github.com/topoteretes/cognee))。
- **部署/license/活跃度**:库 + Docker + 云;Apache-2.0;30,376 star,2026-08-31 推送,活跃([GitHub API](https://api.github.com/repos/topoteretes/cognee))。
- **研究**:论文《Optimizing the Interface Between Knowledge Graphs and LLMs for Complex Reasoning》(arXiv:2505.24478)([README](https://github.com/topoteretes/cognee))。

#### 2.2.3 agiresearch/A-mem(学术原型)

- **定位**:论文《A-MEM: Agentic Memory for LLM Agents》(arXiv:2502.12110)官方实现,受 **Zettelkasten 卡片笔记法**启发([README](https://github.com/agiresearch/A-mem))。
- **记忆模型与写入**:每条新记忆生成结构化笔记(context/tags/keywords/时间戳)→ 用 ChromaDB 找历史相似记忆 → 建立链接 → **触发被链接旧记忆的"演化"**(更新其 metadata/context),形成互联知识网络([README](https://github.com/agiresearch/A-mem))。
- **检索**:ChromaDB 向量检索(`search_agentic`)。
- **现状**:MIT,1,161 star,最后推送 2025-12-12,属研究代码;论文复现另在 [WujiangXu/AgenticMemory](https://github.com/WujiangXu/AgenticMemory)([GitHub API](https://api.github.com/repos/agiresearch/A-mem))。价值在思想(记忆互联+演化),被 mem0 论文作为对比基线(J 分 48.38)([arXiv:2504.19413](https://arxiv.org/html/2504.19413v1))。

#### 2.2.4 OSU-NLP-Group/HippoRAG(HippoRAG 2,补充)

- 从 RAG 侧逼近"长期记忆":OpenIE 抽取三元组建图 + Personalized PageRank 扩散检索;HippoRAG 2(ICML'25,arXiv:2502.14802)在事实记忆、sense-making、多跳关联三类任务上超过 RAG/GraphRAG/RAPTOR/LightRAG,且离线索引资源开销远低于图式方案([README](https://github.com/OSU-NLP-Group/HippoRAG))。MIT,3,973 star,活跃([GitHub API](https://api.github.com/repos/OSU-NLP-Group/HippoRAG))。更适合"文档型知识记忆"而非对话画像。

### 路线三:OS 式分层与多 agent 记忆 —— "记忆是被管理的系统资源"

#### 2.3.1 letta-ai/letta(原 MemGPT)

- **定位与架构**:MemGPT 论文(arXiv:2310.08560)提出把 LLM 当操作系统:上下文窗口=主存,外部存储=磁盘,agent 自己分页。Letta 是其产品化"stateful agents 平台"([letta README](https://github.com/letta-ai/letta)、[MemGPT 论文](https://arxiv.org/abs/2310.08560))。
- **记忆模型**:三层——**core memory blocks**(在上下文内、钉在系统提示上的带标签文本块,如 persona/human,多个 agent 可共享同一 block)、**recall memory**(对话历史持久化)、**archival memory**(上下文外的可语义检索向量库);agent 通过**记忆工具自编辑** core memory([Letta memory docs](https://docs.letta.com/guides/agents/memory)、[archival docs](https://docs.letta.com/v1-sdk/memory/archival-memory/))。
- **写入管线**:除 agent 热路径自编辑外,还有 **sleep-time agents / "dreaming"**:后台子 agent 在空闲时重读近期对话、沉淀教训、整理记忆结构,不占用前台交互(sleep-time compute 论文:arXiv:2504.13171)([Letta 博客](https://www.letta.com/blog/sleep-time-compute/)、[Memory & Dreaming docs](https://docs.letta.com/configuration/memory/))。
- **检索**:blocks 常驻上下文;archival 语义检索;recall 历史检索;上下文满后 compaction/eviction,旧消息仍可 API/工具取回([Letta memory docs](https://docs.letta.com/guides/agents/memory))。
- **重大转型(2026)**:`letta-ai/letta` 主仓已变为落地页,活跃源码在 **`letta-ai/letta-code`**(3,166 star,Apache-2.0,2026-09-01 活跃):npm 分发的编码 agent(TUI + App Server + 桌面/web/Slack/Telegram 渠道),旧 V1 server 存档于 `archive` 分支不再维护;另有实验性 [ai-memory-sdk](https://github.com/letta-ai/ai-memory-sdk)(45 star,2025-11 后停更)([letta README](https://github.com/letta-ai/letta)、[GitHub API letta-code](https://github.com/letta-ai/letta-code))。**结论:作为"记忆服务器"选 Letta 需谨慎评估其产品重心转移;其记忆思想(blocks+sleep-time)影响深远。**
- **benchmark**:Letta/MemGPT 是 Zep 论文与 mem0 论文的常被对比基线;官方未主打 LOCOMO 榜单。

#### 2.3.2 MemTensor/MemOS

- **定位与架构**:MemOS 论文(arXiv:2507.03724,2025-07 首发、v4 2025-12 修订)把记忆当作操作系统可管理的系统资源,统一表示、调度与演化;基本单元 **MemCube** 封装记忆内容+元数据(溯源/版本),可组合、迁移、融合([arXiv:2507.03724](https://arxiv.org/abs/2507.03724))。
- **记忆模型**:统一三类记忆——**明文记忆**(文本)、**激活记忆**(KV cache 级)、**参数记忆**(写入权重);另有"记忆生成(MemOp/MAG)"叙事的短版论文(arXiv:2505.22101)([论文摘要](https://arxiv.org/abs/2507.03724)、[README 引用块](https://github.com/MemTensor/MemOS))。工程侧现为 **MemOS 2.0"星尘"**:多 Cube 知识库管理(隔离/受控共享/动态组合)、MemScheduler 异步摄入(毫秒级)、自然语言记忆反馈修正、多模态(文本/图像/工具轨迹/persona)([README](https://github.com/MemTensor/MemOS))。
- **写入管线**:异步摄入 + 记忆结构化为可检查、可编辑的图(明确反对"黑盒向量库"叙事);agent 侧插件体系提出技能结晶分层:L1 轨迹 / L2 策略 / L3 世界模型 + 结晶化 Skills([README](https://github.com/MemTensor/MemOS))。
- **检索**:自托管版混合检索(Neo4j + Qdrant);本地插件为 SQLite FTS5 + 向量混合、智能去重,100% 本地([README](https://github.com/MemTensor/MemOS))。
- **集成**:面向 agent 生态的插件矩阵——OpenClaw、Hermes、DeepSeek Harness 的云/本地插件(npm 安装),Memory Viewer 面板([README](https://github.com/MemTensor/MemOS))。
- **部署/license/活跃度**:云 API / docker compose 自托管 / 本地插件;Apache-2.0;11,122 star,2026-09-01 推送,活跃([GitHub API](https://api.github.com/repos/MemTensor/MemOS))。注意主仓语言已标为 TypeScript(插件生态为主),Python 服务端仍在。
- **官方 benchmark**:论文(GPT-4o-mini 主干)LoCoMo 总分 **75.80**(MemOS-1031)对比 Memobase 72.01、Mem0 64.57、MIRIX 64.33、Zep 59.22、MemU 56.55、Supermemory 55.34(注:Memobase 在时间类 81.20 高于 MemOS 75.18);LongMemEval 77.8 vs 最佳基线 72.4([arXiv HTML v4 Table 3](https://arxiv.org/html/2507.03724v4))。README 新闻口径:LoCoMo 88.83、LongMemEval 89.20,并主导 OmniMemEval(14 个商业记忆产品 × 10 数据集的统一评测,含 OpenClaw 任务完成率 36.63%→50.87%)([README](https://github.com/MemTensor/MemOS)、[OmniMemEval](https://github.com/MemTensor/OmniMemEval))。**MemOS 论文复现并对比 Mem0 是其标志性动作之一**(论文 §对比实验)。

#### 2.3.3 Mirix-AI/MIRIX

- **定位与架构**:多 agent 个人助理:实时捕捉屏幕活动+对话,由**元 agent 调度六个记忆 agent** 写入六类记忆库:Core / Episodic / Semantic / Procedural / Resource / Knowledge Vault([README](https://github.com/Mirix-AI/MIRIX)、[论文 arXiv:2507.07957](https://arxiv.org/abs/2507.07957))。
- **写入与遗忘**:会话消息(含工具调用/报错/修复全程)按类型路由入库;提供 **auto-dream 端点**做显式清理合并——复审现有记忆、合并重复、解决过期/冲突条目(支持 dry_run)([README](https://github.com/Mirix-AI/MIRIX))。
- **检索**:PostgreSQL 原生 BM25 全文 + 向量相似度;`retrieve_with_conversation` 按会话语境取回([README](https://github.com/Mirix-AI/MIRIX))。
- **隐私与部署**:长期数据全部本地存储,隐私可控;docker compose 起 Dashboard+API,客户端 `mirix-client`(PyPI)([README](https://github.com/Mirix-AI/MIRIX))。
- **官方 benchmark**:论文宣称 ScreenshotVQA 上比 RAG 基线准确率高 35%、存储省 99.9%(自建 2 万张/序列的高分辨率截图基准);LoCoMo 85.4% "SOTA"([arXiv:2507.07957](https://arxiv.org/abs/2507.07957))。注意:MemOS 论文同一榜单复现 MIRIX 仅 64.33([arXiv:2507.03724v4](https://arxiv.org/html/2507.03724v4)),不同论文间复现差异极大,选型时应自行跑通评测。
- **活跃度**:Apache-2.0,3,438 star,2026-08-20 推送([GitHub API](https://api.github.com/repos/Mirix-AI/MIRIX))。

### 路线四:文件 / SQL 轻量派 —— "记忆就是你的磁盘和数据库"

#### 2.4.1 NevaMind-AI/memU

- **定位**:2025 下半年蹿升最快的新项目之一(2025-07 建仓,一年 14,363 star),理念从早期的"文件夹记忆"演进为"**个人记忆存成 Wiki**":跨会话、跨 agent、跨设备的共享记忆;核心记忆逻辑仅 500 行,刻意可审计([README](https://github.com/NevaMind-AI/memU)、[GitHub API](https://api.github.com/repos/NevaMind-AI/memU))。
- **记忆模型与写入**:记忆/技能都是 **Markdown 文件**;由宿主 agent 的定时桥接任务把新会话史切片成自演化 job,**由 agent 自己决定**不改/打补丁/新建技能,产物是带名称、描述、可复用工作流(含分支、边界情况、坑)的技能文件;`MemoryService` 本身不做 LLM 调用,只做存储/嵌入/检索——"判断与综合留在 agent 内"([README How it works](https://github.com/NevaMind-AI/memU))。
- **检索**:嵌入技能名+描述,同任务检索时返回相关 skill(渐进式 retrieve)([README](https://github.com/NevaMind-AI/memU))。
- **部署**:云版(memu.so,免费跨设备)+ 自托管(需自带 embedding);宿主适配器覆盖 Codex/Claude Code/Cursor/OpenClaw/Hermes 等编码 agent([README](https://github.com/NevaMind-AI/memU))。
- **License**:README 徽章与 LICENSE.txt 均为 Apache-2.0 文本(GitHub API 因文件格式归为 NOASSERTION)([LICENSE.txt](https://github.com/NevaMind-AI/memU))。
- **benchmark**:作为被测对象出现在 MemOS 论文 LoCoMo 表(56.55,时间类仅 27.10)([arXiv:2507.03724v4](https://arxiv.org/html/2507.03724v4))——与其"技能沉淀"而非"对话事实抽取"的定位相符,拿对话问答榜衡量它并不公平。

#### 2.4.2 basicmachines-co/basic-memory

- **定位**:MCP 原生的"本地优先"记忆:知识以**普通 Markdown** 存于磁盘,人和 AI 读写同一批文件并双向同步;observations + wikilinks 自然长成知识图谱;可选语义搜索(Milvus+Postgres 部署)与 cross-encoder 重排;云版 $15/月可同步/协作(Teams)([README](https://github.com/basicmachines-co/basic-memory))。
- **适用**:个人知识库、air-gapped 环境、希望"记忆文件我随时能打开看"的用户。AGPL-3.0(商用需注意传染性),3,821 star,2026-09-01 活跃([GitHub API](https://api.github.com/repos/basicmachines-co/basic-memory))。

#### 2.4.3 MemoriLabs/Memori(原 GibsonAI/memori)

- **定位变迁**:原 GibsonAI 版本以"SQL 优先记忆引擎"知名;现迁移为 **MemoriLabs/Memori**,口号"Memory from what agents do, not just what they say",定位 LLM 无关的 agent 原生记忆基础设施,面向企业,支持托管云/单租户/VPC/本地部署([GitHub API 重定向](https://api.github.com/repositories/1025381911)、[repo](https://github.com/MemoriLabs/Memori))。
- **记忆模型(仍是 SQL 优先)**:直接把结构化记录写进你自己的库——`memori_conversation_message`(原始消息,同步捕获)、`memori_entity_fact`(抽取事实,召回注入用)、`memori_process_attribute`(过程属性)、`memori_knowledge_graph`(图记录);BYODB 支持 CockroachDB/MariaDB/MongoDB/MySQL/OceanBase/Oracle/PostgreSQL/SQLite/TiDB 等,数据不出你的基础设施([BYODB docs](https://memorilabs.ai/docs/memori-byodb/))。
- **写入管线**:SDK 里一行 `Memori().llm.register(client)` 注册已有 LLM 客户端,对话持久化与召回自动后台完成;`attribution` 区分用户与进程;后台异步抽取"事实、偏好、规则、事件、关系"([repo README](https://github.com/MemoriLabs/Memori)、[BYODB docs](https://memorilabs.ai/docs/memori-byodb/))。另有 OpenClaw 插件捕获工具调用/决策/结果([README](https://github.com/MemoriLabs/Memori))。
- **官方 benchmark**:LoCoMo 总体 87%,平均每题 721 tokens(全上下文的 2.8%),自称胜过 Zep/LangMem/Mem0 且 prompt 比 Zep 小约 67%;论文 arXiv:2603.19935([README](https://github.com/MemoriLabs/Memori))。**该数字为官方自报,第三方未见复现。**
- **活跃度/license**:16,302 star(原仓迁移后增长快),2026-08-21 推送;README 徽章 Apache-2.0,GitHub API 识别为 NOASSERTION,商用前建议核对 LICENSE 文件([GitHub API](https://api.github.com/repositories/1025381911))。

#### 2.4.4 supermemoryai/supermemory(补充观察)

- 29,170 star,MIT,极活跃。"记忆 + RAG + 连接器"合一的 context 引擎:自动抽取事实、维护用户画像(~50ms)、处理矛盾与过期遗忘,宣称 LongMemEval/LoCoMo/ConvoMem 三榜第一、95% Recall@15、99.4% 上下文压缩([README](https://github.com/supermemoryai/supermemory))。可自托管,适合想"一个 API 拿到记忆+知识库"的团队;榜单数字同为官方自报。

---

## 3. 横向对比

### 3.1 写入时抽取策略:谁来决定"什么值得记"

| 策略 | 代表 | 说明 |
|---|---|---|
| **系统管线抽取**(对话后固定流程) | mem0、memobase、Memori、cognee | 对 LLM 调用次数/成本可控;memobase 把写入固定为 3 次调用([README](https://github.com/memodb-io/memobase));mem0 论文版为抽取+更新两阶段、新算法单遍 ADD-only([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)、[README](https://github.com/mem0ai/mem0)) |
| **agent 自主写入**(热路径工具) | letta(记忆工具)、langmem(热路径)、memU(agent 自演化) | agent 用工具即时记录/编辑记忆,延迟高但"记忆是 agent 的主动行为"([Letta docs](https://docs.letta.com/guides/agents/memory)、[langmem 概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) |
| **后台反思/整理** | langmem(background)、letta(sleep-time/dreaming)、MIRIX(auto-dream) | 会话后或空闲时批量抽取、合并、进化;langmem 文档明确权衡"更新速度 vs 深度模式分析"([概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)) |
| **增量图谱化** | graphiti/Zep、cognee | 每个 episode 实时抽取实体/关系入图,不整图重算([Graphiti README](https://github.com/getzep/graphiti)) |
| **双写(同步捕获+异步加工)** | Memori | 消息同步落库保真,事实异步抽取([BYODB docs](https://memorilabs.ai/docs/memori-byodb/)) |

### 3.2 冲突消解

- **失效而非删除(时序派)**:graphiti 给每条事实有效期窗口,新事实使旧事实失效但保留历史,可查询"任意时点为真的事实"([Graphiti README](https://github.com/getzep/graphiti))。
- **原地更新(抽取派经典)**:mem0 论文版 consolidation 步骤对相似旧记忆做 UPDATE/DELETE/NOOP 决策([arXiv:2504.19413](https://arxiv.org/html/2504.19413v1));langmem 整合语义记忆时"删除/失效 or 更新/合并"([概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/))。
- **只增不改(2026 新潮流)**:mem0 新算法单遍 ADD-only,"记忆累积、历史不被覆盖",靠检索端时间推理挑出"当前有效"的那条([README](https://github.com/mem0ai/mem0))——本质是把冲突消解从写入端挪到读取端。
- **定期整理(dream)**:MIRIX auto-dream 显式合并重复、解决过期冲突条目,支持 dry_run([README](https://github.com/Mirix-AI/MIRIX));langmem/sleep-time 也属此类"后台整理"。
- **槽位覆盖(画像派)**:memobase 的 profile 按槽位就地更新,天然无重复但会丢失演变史(事件时间线补充时序)。

### 3.3 遗忘 / 衰减

- **显式遗忘**:cognee 把 `forget` 做成一级 API([README](https://github.com/topoteretes/cognee));supermemory 宣称自动遗忘过期信息([README](https://github.com/supermemoryai/supermemory));langmem 检索权重含记忆"强度"(使用频率/新近度),弱记忆自然沉底([概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/))。
- **衰减排序**:mem0 新算法使用"fire-and-forget 记忆衰减排序 + 写时时间分类",宣称检索中位延迟仅 +1ms([research 页](https://mem0.ai/research))。
- **不遗忘、只失效**:graphiti 路线明确"old facts are invalidated — not deleted"([Graphiti README](https://github.com/getzep/graphiti)),适合合规审计场景。
- **人工/治理遗忘**:basic-memory 的记忆就是文件,人直接删;MemOS 支持自然语言反馈修正/替换记忆([README](https://github.com/MemTensor/MemOS))。

### 3.4 检索机制

| 项目 | 向量 | 关键词/BM25 | 图遍历 | 时序 | 其他 |
|---|---|---|---|---|---|
| mem0 | ✔(22 种库) | ✔(BM25) | 实体链接加分 | ✔ 时间推理重排 | 多信号融合 |
| graphiti/Zep | ✔ | ✔ | ✔(图距离重排、search recipes) | ✔ 双时序过滤(核心卖点) | 溯源到 episode |
| cognee | ✔ | ✔ | ✔ | 弱 | auto-routing |
| letta | ✔(archival) | recall 检索 | ✘ | 弱 | blocks 常驻上下文 |
| MemOS | ✔(Qdrant) | ✔(FTS5,本地插件) | ✔(Neo4j,自托管) | ✔(时间线) | KV/参数记忆直达 |
| MIRIX | ✔ | ✔(PG BM25) | ✘ | 时间限定查询 | 六库分流 |
| memobase | 事件检索 | ✘ | ✘ | ✔ 事件时间线 | 画像直读为主 |
| memU | ✔(技能嵌入) | 文件即检索 | wikilink | 弱 | 人可直接翻文件 |
| Memori | 召回注入 | SQL | ✔(knowledge_graph 表) | 弱 | SQL 优先 |
| HippoRAG 2 | ✔ | ✔ | ✔ + PPR 扩散 | ✘ | 多跳最强 |

### 3.5 Benchmark 全景与"LOCOMO 之争"

各家在 LoCoMo(LLM-as-a-Judge)上的**自报数字**(注意:主干模型、配置、时间点均不同,**不可直接横向比**):

| 来源 | 数字 | 出处 |
|---|---|---|
| mem0 论文(2025-04) | Mem0 66.88 / Mem0ᵍ 68.44 / Zep 65.99 / LangMem 58.10 / OpenAI 52.90 / A-Mem 48.38 / 全上下文 72.90 | [arXiv:2504.19413 Table 2](https://arxiv.org/html/2504.19413v1) |
| Zep 博客回应 | Zep 修正 75.14±0.17;后续更新称"80%、<200ms" | [Zep 博客](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) |
| memobase 自测 | Memobase v0.0.37 75.78(时间类 85.05) | [locomo-benchmark](https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md) |
| MemOS 论文 v4 | MemOS 75.80;同表 MIRIX 64.33 / MemU 56.55 / Supermemory 55.34 | [arXiv:2507.03724v4](https://arxiv.org/html/2507.03724v4) |
| MIRIX 论文 | 85.4% "SOTA" | [arXiv:2507.07957](https://arxiv.org/abs/2507.07957) |
| mem0 新算法(2026-04) | 92.5(平台版,含专有优化) | [README](https://github.com/mem0ai/mem0)、[research](https://mem0.ai/research) |
| Memori 自报 | 87% | [README](https://github.com/MemoriLabs/Memori) |
| supermemory 自报 | 三榜第一 | [README](https://github.com/supermemoryai/supermemory) |

**zep vs mem0 争议双方说法(如实记录)**:
- **Zep 方**([博客](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)):① mem0 论文错误配置了 Zep——把"为单一用户-助手对话设计的图"里两个说话者都标成 user;时间戳被拼进消息文本而没有用 Zep 的 `created_at` 字段;检索被串行执行导致 Zep 延迟被高估。② LoCoMo 本身太弱:对话仅 16k-26k tokens(现代窗口内),全上下文基线(72.90)高于 mem0 最好成绩(68.44),缺少知识更新类问题,Category 5 因缺 ground truth 不可用;倡议改用 LongMemEval(平均 115k tokens、含时序/状态变化题、人工校验)。
- **mem0 方**([getzep/zep-papers#5](https://github.com/getzep/zep-papers/issues/5),由 mem0 CTO Deshraj 发起):① Zep 的 84% 计算把 Category 5 计入分子却剔出分母,虚高约 25.56 分,按统一口径 10 次运行 Zep 实为 58.44%±0.20;② 指责 Zep 单方面修改共享 system prompt("Prompt Tampering")、偏离其早期 DMR 评测模板("Template Drift")、只公布单次运行;③ 对 Zep 的角色/时间戳/延迟质疑逐条反驳(角色映射遵循 Zep 自己的 DMR 基准与文档;`created_at` 在评测所用 zep-cloud==2.10.1 中尚不存在;串行检索更贴近真实且应对所有系统一致)。
- **第三方视角**:随后 MemOS 论文、memobase 仓库等在同一榜单上给出的 Zep 分数(59.22 / 75.14*)彼此相差 16 分,印证了"同榜不同命"。LoCoMo 上**全上下文基线长期高于多数记忆系统**这一事实,是各家(尤其 Zep)质疑该榜单代表性的共同出发点([Zep 博客](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)、[arXiv:2504.19413](https://arxiv.org/html/2504.19413v1))。**选型建议:把所有厂商榜单数字当广告,用对方开源的评测框架在自己数据上复现**(mem0 有 [memory-benchmarks](https://github.com/mem0ai/memory-benchmarks),MemOS 有 [OmniMemEval](https://github.com/MemTensor/OmniMemEval),zep 仓有 [benchmarks/](https://github.com/getzep/zep))。

---

## 4. 选型建议

| 场景 | 推荐 | 理由 |
|---|---|---|
| **个人助手 / C 端陪伴类对话产品** | **memobase**(接受停更风险)或 **mem0**;要极低读延迟、画像可控选 memobase;要生态与持续演进选 mem0 | 画像+事件时间线天然匹配"记住用户"类需求([memobase README](https://github.com/memodb-io/memobase));mem0 集成面最广、SDK 最成熟([mem0](https://github.com/mem0ai/mem0)) |
| **多 agent 编排 / 需要共享与分工记忆** | **letta 思想(共享 memory blocks)**、**MIRIX**(六类记忆+多 agent 管家)、**MemOS**(多 Cube 隔离/共享) | letta blocks 可跨 agent 共享([docs](https://docs.letta.com/guides/agents/memory));MIRIX 六类记忆由专门 agent 分管([论文](https://arxiv.org/abs/2507.07957));MemOS Cube 支持受控共享([README](https://github.com/MemTensor/MemOS)) |
| **企业知识库 / 强审计时序 / 客户关系演化** | **Graphiti(自托管)或 Zep(托管)**;重数据工程选 **cognee** | 双时序+溯源+失效机制是企业级记忆的最严谨答案([Graphiti README](https://github.com/getzep/graphiti));cognee 胜在 ECL 数据管线与多格式摄入([cognee](https://github.com/topoteretes/cognee)) |
| **本地隐私优先 / 记忆要透明可查** | **basic-memory**(人读 Markdown+MCP)、**memU 自托管**(技能化记忆)、**MemOS 本地插件**(SQLite 全本地)、**Memori BYODB**(记忆进你自己的库) | 全部支持数据不出本机/自有库;basic-memory AGPL 注意商用条款([repo](https://github.com/basicmachines-co/basic-memory)、[memU](https://github.com/NevaMind-AI/memU)、[MemOS](https://github.com/MemTensor/MemOS)、[Memori docs](https://memorilabs.ai/docs/memori-byodb/)) |
| **LangChain/LangGraph 技术栈** | **langmem** | 原生 BaseStore/命名空间集成,方法论清晰,但别指望它当独立记忆服务([langmem](https://github.com/langchain-ai/langmem)) |
| **文档型长期知识 / 多跳问答** | **HippoRAG 2**、**cognee** | 图+PPR 检索在多跳上占优,离线索引成本低于 GraphRAG 系([HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG)) |
| **编码 agent(Claude Code/Codex 等)跨会话记忆** | **memU**、**MemOS/Memori/cognee 的编码 agent 插件**、**letta-code 原生** | 2026 年的明显趋势:记忆项目纷纷为编码 agent 做插件/skill 入口(memu 适配矩阵、cognee Claude Code 插件、MemOS OpenClaw/DSH 插件、Memori OpenClaw 插件)(各 README) |

**避坑提示**:① `letta-ai/letta` 主仓已非可部署 server 源码;② `GibsonAI/memori` 链接会 301 到 MemoriLabs;③ memobase 与 A-mem 已明显放缓,生产采用需评估维护风险;④ 各项目 README 徽章 license 与 GitHub API 识别(Memori、memU)不一致时,以 LICENSE 文件原文为准。

---

## 5. 参考链接清单

**仓库**
- mem0 https://github.com/mem0ai/mem0 | 评测框架 https://github.com/mem0ai/memory-benchmarks | OpenMemory(转型) https://github.com/mem0ai/openmemory
- Graphiti https://github.com/getzep/graphiti | Zep 示例/集成 https://github.com/getzep/zep | 评测争议 issue https://github.com/getzep/zep-papers/issues/5
- cognee https://github.com/topoteretes/cognee
- Letta(落地页) https://github.com/letta-ai/letta | Letta Code https://github.com/letta-ai/letta-code | 实验 SDK https://github.com/letta-ai/ai-memory-sdk
- MemOS https://github.com/MemTensor/MemOS | OmniMemEval https://github.com/MemTensor/OmniMemEval
- memobase https://github.com/memodb-io/memobase | Acontext https://github.com/memodb-io/Acontext
- langmem https://github.com/langchain-ai/langmem
- A-mem https://github.com/agiresearch/A-mem | 论文复现 https://github.com/WujiangXu/AgenticMemory
- Memori https://github.com/MemoriLabs/Memori
- MIRIX https://github.com/Mirix-AI/MIRIX
- memU https://github.com/NevaMind-AI/memU
- basic-memory https://github.com/basicmachines-co/basic-memory
- HippoRAG https://github.com/OSU-NLP-Group/HippoRAG
- supermemory https://github.com/supermemoryai/supermemory

**文档**
- mem0 docs https://docs.mem0.ai(向量库清单:/components/vectordbs/overview)
- Letta memory https://docs.letta.com/guides/agents/memory | archival https://docs.letta.com/v1-sdk/memory/archival-memory/ | dreaming https://docs.letta.com/configuration/memory/
- Graphiti docs https://help.getzep.com/graphiti
- Memori BYODB https://memorilabs.ai/docs/memori-byodb/
- langmem 概念指南 https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- memobase LOCOMO 实验 https://github.com/memodb-io/memobase/blob/main/docs/experiments/locomo-benchmark/README.md
- mem0 research 页 https://mem0.ai/research

**论文**
- MemGPT: https://arxiv.org/abs/2310.08560
- Sleep-time Compute: https://arxiv.org/abs/2504.13171(博客 https://www.letta.com/blog/sleep-time-compute/)
- Zep(Graphiti 时序知识图谱): https://arxiv.org/abs/2501.13956
- Mem0: https://arxiv.org/abs/2504.19413(HTML 全文含 Table 1/2:https://arxiv.org/html/2504.19413v1)
- A-MEM: https://arxiv.org/abs/2502.12110
- MemOS(长版): https://arxiv.org/abs/2507.03724 | MemOS/MAG(短版): https://arxiv.org/abs/2505.22101
- MIRIX: https://arxiv.org/abs/2507.07957
- HippoRAG 2(From RAG to Memory, ICML'25): https://arxiv.org/abs/2502.14802 | HippoRAG 1(NeurIPS'24): https://arxiv.org/abs/2405.14831
- cognee 接口论文: https://arxiv.org/abs/2505.24478
- Memori LoCoMo 报告: https://arxiv.org/abs/2603.19935

**争议与生态**
- Zep 博客《Lies, Damn Lies, & Statistics》: https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/
- Zep 开源战略调整公告: https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/
- mem0 反驳 issue: https://github.com/getzep/zep-papers/issues/5
