# WeKnora 复刻 · 产品需求文档（PRD）

状态: 已定稿

> 版本：v0.1（2026-09-10，L1 设计窗口起草；11 维逼问 + Web/Agent 加问全维标注完毕）→ v1.0（2026-09-10，主窗口收口：范围含/不含逐条确认 + B 类问题 1 拍板（智谱 GLM：embedding-3 + glm-4-flash），全文待确认项清零，翻「已定稿」）→ v1.1（2026-09-10，变更触发：架构图 v1 过审落锤（ADR 0001）后用户拍板"安全防线接入椒图 M3"——按变更路由只重开 ⑥/⑧ 与 §6 威胁模型，落 §6.3 防御分工 + §8.1-6 决策，ADR 0002；重开后即定稿）→ v1.2（2026-09-10，ADR 0003：embedding 供应商智谱→MiniMax，embedding-3 余额不足实测触发；chat 仍 GLM 免费档）。
> 项目性质：**学习项目**——目的是吃透 WeKnora 的 RAG + 知识图谱 + Wiki 三条核心管线，不是造产品。逼问从简，但范围"含/不含"逐条显式列出。
> 事实底座：`HANDOFF.md`（调研窗口交接：§2 范围界定 / §3 已拍板决策 / §4 十四阶段路线 / §5 信源地图），本文引用标注〔HANDOFF §n〕。方法约定见 `MISSION.md` + `PLAN.md`（sdd-flow 出骨架 × learn-by-rebuild 出执行纪律）。
> 语义底座：`CONTEXT.md`（术语表 + 语义核心不变量），本文引用不复述；机器门禁 `tools/check_specs.py`。
> 体例参照：`agentjiaotu/docs/prd.md`（同仓库安全网关全尺寸 PRD），按其 1/3~1/2 规模裁剪。

---

## 0. 文档定位与水位线

### 0.1 文档分工（本文 vs 其他骨架产物）

| 产物 | 管什么 | 不管什么 |
|---|---|---|
| **本文（PRD）** | 为什么做、做什么/不做什么、业务对象语义、威胁模型视角、量级口径、决策记录——**为什么与边界** | 接口字段级真源、逐条验收测试绑定 |
| `CONTEXT.md` | 术语表（大白话+英文原词+比喻）+ 语义核心不变量 | 产品叙事 |
| `specs/modules.md`（阶段 2） | 模块卡真源：公开接口、依赖边、`## 边界规则`、`## 页面映射`；改接口卡回 L0 评审 | 叙事与理由 |
| `specs/<幕>.md`（阶段 3，按幕分批） | 每幕行为约定与**验收测试逐条绑定**，spec gate 机检 | 产品叙事 |
| `lessons/NNNN-阶段名.md`（阶段 5） | 每学习阶段的教学讲解落盘（五节结构，learn-by-rebuild） | 规格约定 |

施工纪律（learn-by-rebuild）：每学习阶段 ≤30 行新增代码、有可观察页面变化、业务数据流在阶段内闭合（生产者→消费者不跨阶段断链）；用户说"下一步"才推进、说"提交"才 commit。

### 0.2 硬约束（不进入逼问，挑战需回 L0 并记 ADR）

1. **Python 单栈**（用户指定）。参考项目 WeKnora 是 Go + Vue + Python docreader；本项目**只复刻思想与功能形态，不照搬技术栈**〔HANDOFF §2〕。
2. **技术栈点名 = 验收对象**（框架红线）：Streamlit（页面）、SQLite + numpy（存储与向量/图手写）、pymupdf（PDF 解析）、pytest（测试）——依赖必须真出现在 requirements.txt 且代码真调用，不许手写同构替代；反过来，学习对象本身的算法（BM25、RRF、余弦检索、图存储）**必须手写**，不许调现成库（如 rank_bm25 / sklearn / faiss / networkx）顶替——这是"吃透"与"调包"的分界。
3. **LLM/Embedding 一律走统一 gateway 接口**：真实 API（`agent-key <供应商>` 从 macOS Keychain 取）与 fake stub 同接口，业务代码不许直连厂商 SDK——这是 CI 不花钱不抖动的结构保证〔PLAN 红线〕。
4. **CI 先于业务代码**：阶段 0 已建四道门（spec gate / boundary gate / ruff / pytest），全程保持绿。
5. **开发纪律**：sdd-flow（接口先行、spec gate、lessons 落盘）× learn-by-rebuild（小步、页面可观察、用户控节奏）〔MISSION〕。

### 0.3 水位线

**宁砍组件，不降真实度；规模可小，机制必须是真的。** 全程约束：

1. **真实机制**：分块真分、BM25 真算 TF/IDF/长度归一化、向量真算余弦、RRF 真融合、实体关系真由 LLM 抽出、Wiki 真由 LLM 重写、回滚真回滚——不靠 stub 糊弄演示路径（fake stub 只用于 CI，不进演示）；
2. **可观察**：14 个学习阶段每个都有页面可观察变化，关掉某条管线能在页面上看到效果差；
3. **三对照**：每阶段讲解挂三处锚——书第三章小节、WeKnora 源码路径（〔HANDOFF §5.1〕实测 grep 核对过）、本实现；
4. **决策有据**：每个设计决策能指到本文 §8 / HANDOFF / 后续 ADR；
5. **诚实边界**：不做的（§1.2）逐条显式列出，收官对账报告按"完全复刻 / 有意简化 / 真正差距"三栏交代。

### 0.4 验收标准（源自 MISSION.md，逐条可判）

1. 14 阶段全部完成，每阶段页面可观察变化 + `lessons/NNNN.md` 落盘 + 用户亲手跑通关键链路；
2. 阶段 14 对账报告三栏清楚：完全复刻 / 有意简化（以我们为准）/ 真正差距（对照 ParadeDB、Neo4j、asynq 等真选型）；
3. 每幕收尾 3 道场景题闯关（如"关掉 keyword 开关后 kitty→cat 还能命中吗，为什么"），错题记 NOTES.md；
4. 终极自测：不看资料讲清"一份 PDF 进来，怎么变成向量、倒排、图谱、Wiki 四个维度，查询时各自怎么被用"。

---

## 1. 范围界定（"100% 核心功能"的含与不含）

> 本节逐条抄自 HANDOFF §2（调研窗口与用户过过一轮），是学习项目的范围事实底座。确认方式：用户逐条过目后本文翻「已定稿」。

### 1.1 包含（复刻目标）

1. **RAG 主链路**：文档入库 → 解析 → 分块（父子/重叠）→ 双索引（向量 + 关键词）→ 混合检索（RRF）→ 重排 → 带引用来源标记的 LLM 问答。
2. **知识图谱**：KB 级 schema 配置（实体/关系类型表）→ 逐 chunk LLM 抽取 → 图存储 → SearchNode 查询 → 与 RAG 并行汇入问答上下文。
3. **Wiki**：chunk 拼回全文 → LLM 重写成 Markdown 页 → 自动交叉链接 + 入口页 → 版本历史与一键回滚。
4. **IndexingStrategy 四开关**：vector / keyword / wiki / graph 独立启停，缺管线也能跑〔WeKnora `internal/types/indexing_strategy.go`〕。

### 1.2 明确不含（进收官对账报告讲"真 WeKnora 怎么做"，不进复刻代码）

1. 多租户 RBAC；
2. MCP 接入；
3. IM 接入；
4. 沙箱；
5. 27 厂商模型路由（本项目只接一家真实 API + fake stub，见 §8.1-5）；
6. asynq / Redis 分布式任务（同步或线程替代）；
7. docreader 六引擎（只做 2 个示范解析器：内置 txt/md + pymupdf 解析 PDF，已拍板〔MISSION〕）。

---

## 2. 业务对象与术语

> 大白话定义与比喻以 `CONTEXT.md` 为真源；本节只列名词级对象、关键属性、身份认定与多重性，供阶段 2 模块划分引用。

| 对象 | 英文/源码对应 | 关键属性 | 身份认定（靠什么算"同一个"） | 多重性 |
|---|---|---|---|---|
| **知识库** | KB / KnowledgeBase | 名称、ExtractConfig（图谱 schema）、IndexingStrategy 四开关 | kb_id 唯一 | KB 1—N 文档 |
| **文档** | Document / Knowledge | 文件名、格式（txt/md/pdf）、解析状态 | 文档 id 唯一 | 文档 1—N chunk；文档 1—1 Wiki 页（生成后） |
| **chunk（块）** | Chunk | 正文、序位、父块指针、重叠窗口、ContextHeader（标题+面包屑） | chunk id 唯一；重新入库即整批重建（幂等清理旧数据） | chunk 1—N 维度投影（见下） |
| **父块 / 子块** | parent/child chunk | 子块进索引，**父块只入库不索引**（INV-1，WeKnora `knowledge_process.go:566` 注释原话） | 同 chunk | 父块 1—N 子块；子块命中后扩展取父块上下文 |
| **四维度投影** | 向量索引 / 倒排索引 / 图谱 / Wiki | 同一份 chunk 在四条管线上的派生物；**索引是可重建的派生物，chunk 是唯一事实源**（INV-2） | 由 chunk id + 维度名共同确定 | 每 chunk 在每维度至多一条投影 |
| **图谱实体 / 关系** | Entity / Relationship（`internal/types/graph.go`） | 实体：名称+类型；关系：三元组（主语-关系-宾语）+ 权重（PMI 加权） | 实体按（名称, 类型）消歧——区分两个同名"张医生"是实体消歧不是词义消歧（书 3.3） | 实体 N—N 经关系相连；关系挂在 KB+文档 命名空间下 |
| **ExtractConfig** | ExtractConfig（`extract.go`） | Nodes/Relations 类型表（schema 引导抽取） | 每 KB 一份 | KB 1—1 ExtractConfig |
| **Wiki 页 / 版本** | WikiPage / revision（`wiki_ingest.go` / `repository/wiki_page.go`） | Markdown 正文、交叉链接、入口页归属、revision 历史 | 页 slug 唯一；revision 按版本号递增 | Wiki 页 1—N revision；回滚=切回旧 revision |
| **IndexingStrategy** | IndexingStrategy（`internal/types/indexing_strategy.go`） | vector/keyword/wiki/graph 四个布尔开关，默认只开前两个；`NeedsChunks()`=四管线都依赖分块 | 每 KB 一份配置 | KB 1—1 IndexingStrategy |

---

## 3. 四幕功能清单（对应 14 学习阶段）

> 每功能一句话说清做什么、不做什么；书锚点 = 李博杰《深入理解 AI Agent》第三章小节号；WeKnora 锚点逐条抄自〔HANDOFF §5.1〕（2026-09-10 @ commit `1c16db3` 实测核对）。每阶段 ≤30 行新增代码 + 页面可观察变化 + lessons 落盘。

**第一幕 · RAG 基础层（书 3.2）**

| # | 功能 | 做什么 / 不做什么 | 书锚点 | WeKnora 锚点 |
|---|---|---|---|---|
| 1 | 入库最小闭环 | 做：上传 txt → 固定大小分块 → SQLite chunks 表 → 页面列表展示。不做：PDF（阶段内只支持 txt）、重叠分块、父子分块 | 3.2 分块为什么必须（嵌入长度限制 + 注意力稀释） | `internal/application/service/knowledge_create.go`（入口）；`knowledge_process.go:3238 ProcessDocument` |
| 2 | BM25 稀疏检索 | 做：手写倒排索引 + BM25（k1/b），页面查询框返回带分排序。不做：调现成 BM25 库 | 3.2 稀疏嵌入（TF-IDF→BM25、词频饱和 k1 + 长度归一化 b；实验 3-5） | `internal/application/service/knowledgebase_search_fusion.go`（融合前的稀疏路） |
| 3 | 稠密向量检索 | 做：embedding 接入（gateway 接口）+ numpy 手写余弦相似度，同义词命中（kitty→cat）。不做：ANN/索引结构（暴力全扫，量级见 §5） | 3.2 稠密嵌入（余弦看方向不看长度） | `processChunks` 中 embedding 写入 `knowledge_process.go:283` |
| 4 | 混合检索 RRF + 重排 | 做：两路并行召回 → RRF(k=60) 融合 → 教学版重排（LLM 对 top-N 候选逐一打分，替代跨编码器，[AI自动补全]）→ 页面对比视图。不做：真正跨编码器模型（不引入新模型依赖） | 3.2 混合检索三阶段（并行召回→RRF k=60→重排；"重排不是补救 RRF，是换更强匹配范式"） | `knowledgebase_search_fusion.go`（加权 RRF） |
| 5 | 上下文增强 | 做：标题+面包屑前缀进索引，有/无前缀对照视图。不做：LLM 生成前缀摘要（书 3.5 原版做法，成本原因用标题面包屑平替，对账报告交代差距） | 3.5 上下文感知检索（"结合 BM25 可将检索失败率降低 49%，再结合重排序器降幅达 67%"——书 3.5 原文） | `EmbeddingContent()` + `buildKnowledgeIndexContent`（`knowledge_process.go:283` 内） |
| 6 | RAG 问答闭环 | 做：检索→注入→LLM 生成，答案带引用来源编号，检索内容以"参考资料"角色标记注入（指令与数据分离）。不做：多轮对话、会话管理 | 3.2 检索-生成 + 3.4 安全边界（来源标记） | `chat_pipeline/references.go`（引用别名）；分发枢纽 `knowledge_post_process.go` |

**第二幕 · 知识图谱（书 3.3 GraphRAG 节）**

| # | 功能 | 做什么 / 不做什么 | 书锚点 | WeKnora 锚点 |
|---|---|---|---|---|
| 7 | schema + 实体抽取 | 做：ExtractConfig（Nodes/Relations 类型表）+ 逐 chunk LLM 抽实体，节点表页面可见；只挑"有可抽取文本"的 chunk 进抽取（防 LLM 复读、防重复计费）。不做：社区发现（Community Detection）摘要 | 3.3 GraphRAG（三元组、schema 引导抽取；软肋=语义降级+错误提取致知识污染） | `internal/types/graph.go`（Entity/Relationship）；`extract.go:224 Handle`（ExtractConfig 组装结构化 prompt）；`knowledge_post_process.go:690 selectGraphChunks` / `:731 chunkHasExtractableText` |
| 8 | 关系抽取 + 图查询 | 做：实体对关系抽取 + PMI 加权 + SearchNode 实体→关系链查询。不做：Neo4j（SQLite 节点/边表手写，阶段 14 对账） | 3.3（多跳推理、实体消歧） | `service/graph.go:356 BuildGraph`（PMI 0.6 + 强度 0.4 归一化 1-10）；接口 `types/interfaces/retriever_graph.go`（AddGraph/DelGraph/SearchNode） |
| 9 | 图谱入问答 | 做：问题 NER → 图检索 → 与向量/BM25 并行汇入上下文，关系类问题前后对比。不做：Agent 工具化查询（`query_knowledge_graph.go` 那一路，属"智能体化 RAG"，列远期） | 3.3 GraphRAG 混合增强 + 3.4 工具化（只做管道版） | `chat_pipeline/extract_entity.go:150`（LLM NER）→ `chat_pipeline/search_entity.go:44`（并发 SearchNode、并行汇入上下文） |

**第三幕 · Wiki（书 3.3 OpenViking/知识更新节）**

| # | 功能 | 做什么 / 不做什么 | 书锚点 | WeKnora 锚点 |
|---|---|---|---|---|
| 10 | 文档→Wiki 页 | 做：chunk 拼回全文（重叠去重）→ LLM 重写成 Markdown 页 → 页面渲染；32K token 截断。不做：图片信息回读（OCR/caption 内联——本项目解析器不含图片管线，对账报告交代） | 3.3（重写≠检索；索引期提炼"把原始文档不加处理直接放进知识库是远远不够的"——书 3.3 原文） | `wiki_ingest.go`（`maxContentForWiki:40` 32768 截断；`reconstructContent:2865` 只取 text chunk 拼回、重叠去重） |
| 11 | 自动链接 + 索引页 | 做：linkify 交叉链接 + 入口页，页间可点击跳转；写入提示词明确要求回指已有条目。不做：L0/L1/L2 分层摘要文件体系（OpenViking 完整范式，只取"像 Wikipedia 建链接"这一核） | 3.3 文件系统范式（"把知识库组织得像 Wikipedia……在负责写入知识的提示词里必须把要求写明确"——书 3.3 原文） | `wiki_linkify.go`（交叉链接）、`wiki_slug_handles.go` |
| 12 | 版本与回滚 | 做：编辑落 revision、一键回滚。不做：Proposer-Reviewer 双 Agent 审核流（书 3.3 知识更新节的完整 PR 流水线——那是椒图 M3#4 的设计图纸，本项目只落"版本历史+回滚"这一半） | 3.3 知识更新（知识层/证据层/服务层三层分离；"把知识库当成代码库，把每次知识变更当成一个 PR"——书 3.3 原文） | `repository/wiki_page.go`（wiki 页面版本存主库） |

**第四幕 · 收官**

| # | 功能 | 做什么 / 不做什么 | 书锚点 | WeKnora 锚点 |
|---|---|---|---|---|
| 13 | 四页控制台 + 四开关 | 做：入库/问答/图谱/Wiki 四页整合 + IndexingStrategy 四开关面板，关掉某管线立刻看效果。不做：权限、多 KB 管理 UI | 3.2-3.3 综合 | `internal/types/indexing_strategy.go`（四开关，默认只开前两个）；`knowledge_post_process.go:83 Handle`（按开关分发） |
| 14 | 对账 WeKnora | 做：逐模块读真源码对照，产出选型卡 + 差距报告（完全复刻/有意简化/真正差距三栏）。不做：补做差距项 | 全章 | §5.1 全图（ParadeDB vs SQLite、Neo4j vs 图表、asynq vs 同步） |

---

## 页面清单

> Web 产品加问产出（Streamlit 多页应用）。**节名不加编号、一字不差，是 spec gate 的机器校验锚点**（`tools/check_specs.py` 按 `## 页面清单` 精确匹配）。页面归属模块为**暂定名**，阶段 2 `specs/modules.md` 定稿时逐行对齐，并由其 `## 页面映射` 节机检。

### 页面清单表（每页一行：页面名 + 用途 + 归属模块）

| 页面 | 一句话用途 | 归属模块（暂定） |
|---|---|---|
| 入库页 | 上传文档、看解析分块结果（chunk 列表）、管理 IndexingStrategy 四开关 | `ingest` |
| 问答页 | 输入问题，看双路检索排序/融合对比与带引用来源标记的回答 | `retrieval-qa` |
| 图谱页 | 看实体节点表、按实体查关系链、看 schema（ExtractConfig）配置 | `graph` |
| Wiki 页 | 看 LLM 重写的 Markdown 页、沿交叉链接跳转、查版本历史并一键回滚 | `wiki` |

四页在阶段 13 整合为统一控制台（Streamlit 多页导航），此前各阶段以"当前阶段那一页先长出来"的方式渐进出现（learn-by-rebuild 页面可观察纪律）。

### 关键用户流

- **30 秒可感知价值流**（演示主线）：入库页上传一份 txt → chunk 列表出现 → 问答页问一个同义词问题（kitty→cat）→ 看到带引用编号的回答 → 回到入库页关掉 vector 开关 → 重问同一问题，命中消失。一条流串起入库/检索/问答/四开关四个核心概念。
- **图谱流**：开 graph 开关重新入库 → 图谱页看节点出现 → 问"A 和 B 什么关系"类问题 → 问答页看关系链进入上下文的前后对比。
- **Wiki 流**：开 wiki 开关 → Wiki 页看重写页渲染 → 沿交叉链接跳两跳 → 改坏一页 → 一键回滚。

### 逐页数据需求

| 页面 | 读什么 | 触发什么操作（写） | 覆盖状态 |
|---|---|---|---|
| 入库页 | 文档列表、chunk 列表（含父块扩展）、四开关当前状态 | 上传文件触发解析/分块/索引管线；改四开关 | 文档/chunk：**现有对象已覆盖**（§2 对象表）；四开关状态：**需要新采集**——IndexingStrategy 配置存储（每 KB 一份，KV 级小对象，阶段 13 落地，已随拍板决策 3 一并覆盖，无返工风险） |
| 问答页 | 双路召回结果与 RRF 融合分、命中 chunk 的引用来源信息 | 一次检索 + 一次 LLM 生成（可选 NER）；无持久写 | **现有对象已覆盖**；融合对比视图=同一次查询的三份中间结果展示，**需要新查询面**（检索函数返回中间态，阶段 4 接口设计时落地，成本低） |
| 图谱页 | 实体表、关系表（按实体/按 KB 过滤）、ExtractConfig | 无独立写（抽取由入库管线触发） | **需要新查询面**——SearchNode 图查询接口（阶段 8 建设，本就在功能清单内，无额外采集） |
| Wiki 页 | Wiki 页 Markdown、交叉链接目标、revision 列表 | 触发重写生成（由入库管线或页内按钮）、回滚到指定 revision | **现有对象已覆盖**（Wiki 页/revision 表在阶段 10/12 建设，属功能清单内对象） |

"需要新采集"条目共 1 条（四开关配置存储），已有明确决策（阶段 13 落地），符合 Web 加问关闭标准。

---

## 5. 非功能与量级（学习项目量级，显式数字估算）

| 维度 | 口径 | 估算依据 |
|---|---|---|
| 用户与并发 | 单用户、本机、无并发（并发=1） | 学习项目，Streamlit 单进程 |
| 文档量 | ≤50 份文档、总量 ≤500 页（≈100 万字内） | 演示+捣乱实验够用即可 |
| chunk 量 | 约 1000–3000 块（固定 512 token + 10% 重叠，[AI自动补全]，书 3.2 区间 256–1024/10–20% 内取值） | 500 页 × 每页约 2–6 块 |
| 向量检索 | numpy 暴力全扫余弦，3000 × 1536 维（MiniMax embo-01）float32 ≈ 18MB 内存，单次查询 <100ms | 不需要 ANN，暴力扫即教学正确版 |
| BM25 | 内存倒排，词表数万级，查询毫秒级 | 手写实现的教学规模 |
| 图谱 | 实体/边各数千条，SQLite 节点/边表，SearchNode 查询毫秒级 | 50 份文档 × 每 chunk 抽取若干三元组 |
| LLM 调用量（真实 API） | 入库全开四管线：每 chunk 1 次 embedding（可批量）+ 至多 1 次图谱抽取（只挑有可抽取文本的 chunk）；问答每次 1–2 次（可选 NER + 生成）；Wiki 每文档 1–2 次重写 | 1000 chunk 全量入库 ≈ 千次级抽取调用——**所以图谱抽取必须支持按文档/按开关局部开启**，且每幕收尾在 lessons 记一次实际 token 消耗 |
| 延迟 | 无硬指标；页面操作秒级，LLM 问答允许 10–30s | 学习项目无 SLO |
| 存储 | SQLite 单文件 <500MB | 含向量 blob |
| 安全与合规 | 无认证（本地单用户）；API key 走 `agent-key` 从 Keychain 取，不落库、不进日志、不进 git | 〔HANDOFF §8〕 |

---

## 6. 威胁模型与安全视角（本仓库主旋律）

本项目是被调研对象也是教学载体：安全视角不是附加章节，而是理解四条管线的主轴之一。

### 6.1 投毒的爆炸半径按维度隔离

> 源自调研窗口关键认知〔HANDOFF §1〕，是四维度模型的安全推论，阶段 13 四开关面板可直接演示。

| 投毒点 | 污染半径 | 恢复方式 |
|---|---|---|
| 改 chunk 原文 | **四维全污染**——向量、倒排、图谱、Wiki 都是 chunk 的投影（INV-2），全要重建 | 重新入库（幂等清理 + 重建索引） |
| 只改图谱关系表 | 只污染图谱维度 | 重建图谱（DelGraph + 重抽） |
| 只改 Wiki 页 | 只污染 Wiki 维度 | revision 一键回滚（阶段 12） |
| 检索内容间接注入（文档里藏"忽略先前指令"） | 影响当次问答输出措辞 | 见 §6.2 两层防御 |

### 6.2 书 3.4 安全边界的本项目落点

书 3.4 原文（智能体化 RAG·RAG 的安全边界）：

> "检索到的文档正是**间接提示注入**最典型的载体……知识库投毒是同一道理，只不过污染发生在索引之前。防御要分两层。其一是**指令与数据分离**：对所有检索得到的内容做来源标记……其二是**不让检索内容直接触发高风险操作**。"

本项目落点：

1. **第一层（来源标记）**：阶段 6 问答的引用来源编号 + "以下是参考资料"角色注入，就是指令与数据分离机制的教学版实现——引用标记在本项目是安全机制落点，不是 UI 装饰。
2. **第二层（不触发高危操作）**：本项目天然满足——行动边界基本只读（见 §7 Agent 加问），LLM 只做抽取与生成，无工具调用能力，检索内容没有任何可触发的副作用动作。这是与椒图（agentjiaotu）验票闸/审批回路对照讲解的锚点。
3. **知识投毒演示面**：四开关 + 维度隔离（§6.1）使"投毒一份文档看各维度怎么烂、怎么恢复"成为收官场景题素材。

### 6.3 与椒图（AgentJiaoTu）的防御分工（预留接入，ADR 0002）

> 2026-09-10 用户拍板：本项目的安全防线在椒图到 M3 阶段后接入。椒图 PRD 附录 B 已锚定"第一个外部客户 = WeKnora"（M2#8 两阶段接入剧本）——本项目复刻版按同一剧本预留。

**防御分工矩阵（界内 = 本项目守，跨界 = 椒图守）：**

| 防线 | 界内（本项目教学落点） | 跨界（椒图 M2/M3 接管后） |
|---|---|---|
| LLM 出网 | `llm_gateway` 唯一出网口 + key 不出 Keychain | 阶段一 base_url 收口：身份验票 / LLM 扫描 / 凭证托管 / 审计流（零代码，只改配置） |
| 知识库写入 | 重新入库幂等 + 类型校验丢弃（§7 输出校验） | 阶段二：知识写入人审闸（椒图 M3 记忆/知识投毒防护：写入扫描 + 污点 + 人审闸，对位 `kb_write` L2 票型） |
| 检索内容注入 | 引用来源标记 = 指令与数据分离（§6.2 第一层） | 椒图出网扫描兜底第二层 |
| Wiki 知识更新 | revision + 一键回滚（最小切片） | 椒图 M3#4 Proposer-Reviewer 双 Agent 流水线（完整 PR 图纸在椒图，不搬进本项目） |

**接入前提（诚实边界）**：椒图 M3 尚未建成，本项目建设期与 CI **不依赖椒图在线**——`llm_gateway` 默认直连 GLM，椒图就绪后在阶段 14 收官做一次"改 base_url 收口"演示（若届时仍不就绪，对账报告如实标注"预留未接线"，与 WeKnora in-memory graphBuilder 同款诚实口径）。

---

## 7. 逼问覆盖对账（11 维 + 两个加问）

> 依 `sdd-flow/references/requirement-checklist.md`：每个维度落结论并标适用性，标注动作不省。

| 维度 | 适用性 | 结论落点 |
|---|---|---|
| ① 边界与用户 | 适用 | §1 含/不含两节；用户=学习者本人（单用户）；成功=§0.4 验收 |
| ② 业务对象与关系 | 适用 | §2 对象表（含身份认定与多重性）；页面清单见「页面清单」节 |
| ③ 功能与规则 | 适用 | §3 四幕 14 功能；不变量 INV-1/INV-2 落 `CONTEXT.md` 语义核心 |
| ④ 跨对象联动 | 适用 | 核心联动=chunk 变更 → 四维投影重建（§6.1）；文档入库 → 按开关分发四管线；Wiki 编辑 → 落 revision |
| ⑤ 流程与审批 / 状态机 | 不适用（N/A：单用户学习项目无审批流；文档解析状态、Wiki revision 为简单字段流转，不立状态机） | — |
| ⑥ 查询、统计与报表 | 适用（简化） | 查询=检索/图查询/Wiki 浏览（见逐页数据需求表）；无统计报表需求 |
| ⑦ 角色与权限、数据隔离 | 不适用（N/A：单用户本地，无角色无租户；多租户 RBAC 明确不含，§1.2-1） | — |
| ⑧ 输入输出与外部集成 | 适用 | 输入=txt/md/pdf 文件；外部集成=智谱 GLM 一家真实 API（经统一 gateway）+ fake stub；椒图网关为**预留集成**（v1.1：base_url 可配即接入面，建设期不依赖椒图在线，§6.3）；失败处理=gateway 统一错误，CI 走 stub 不依赖网络 |
| ⑨ 异常与边界 | 适用 | 重新入库幂等（先清旧数据含 DelGraph）；解析失败文档标记失败态不阻塞其他文档；LLM 抽取失败该 chunk 跳过不阻塞管线；SQLite 单写者水位线（〔HANDOFF §8〕已知翻车点）；Wiki 32K 截断 |
| ⑩ 量级与非功能 | 适用 | §5 全表数字估算 |
| ⑪ 数据生命周期 | 适用（简化） | 全部数据存本地 SQLite + 文件，可整库删除重来；无归档/审计/留存要求；Wiki revision 是唯一有历史意识的表 |

**Agent 产品加问**（本项目 LLM 做抽取/生成但无自主行动，行动边界基本只读——逐条简答）：

- **行动边界**：LLM 的动作全部只读/只生成——实体关系抽取、NER、Wiki 重写、问答生成；明确不能：调工具、改 chunk 原文、执行任何有副作用操作。无任何"会改世界"的 action。
- **人在回路**：不适用（N/A：无可逆性要求的高危 action；Wiki 回滚本身即人工操作入口）。
- **输出校验**：抽取输出结构化校验（实体/关系须在 ExtractConfig 类型表内，不在则丢弃，对应书 3.3"错误提取导致知识污染"的缓解）；问答输出以引用编号可追溯为校验替代，不做 judge 模型评分。
- **可追溯**：适用——每个答案可追到引用 chunk，每个三元组可追到来源 chunk（图谱关系挂 chunk 出处），每个 Wiki 页可追到来源文档与 revision 链。
- **可审计**：不适用（N/A：学习项目无审计留痕要求；版本历史仅限 Wiki revision）。

**Web 产品加问**：适用（Streamlit 四页）——产出即「页面清单」节：页面清单表、关键用户流（含 30 秒可感知价值流）、逐页数据需求与覆盖标注（"需要新采集"1 条已决策）。抛弃式原型：不做（N/A：页面为学习观察窗非产品门面，Streamlit 原生组件直出即够用）。

---

## 8. 决策记录

### 8.1 已拍板决策（2026-09-10，MISSION.md 为真源，原文落入）

1. **LLM/Embedding 接入**：真实 API 为主（`agent-key <供应商>` 从 Keychain 取）+ fake stub 跑 CI——测试不花钱不抖动。
2. **可观察界面**：Streamlit，阶段 1 起每阶段页面有可观察变化。
3. **存储**：SQLite + numpy 手写向量/图存储（吃透原理），阶段 14 对照真 WeKnora 的 ParadeDB/Neo4j 选型。
4. **示范解析器**：内置 txt/md 解析 + pymupdf（PDF），不复刻 docreader 六引擎。
5. **LLM/Embedding 供应商**（v1.2 修订，ADR 0003）：**chat 走智谱 GLM `glm-4-flash`（免费档）；embedding 走 MiniMax `embo-01`（1536 维）**——v1.1 原案（GLM 全包 embedding-3）因智谱 embedding 未充值（429 余额不足）变更。两家 key 均已在 Keychain（`agent-key glm` / `agent-key minimax`）。gateway 的 embed 路独立配置、响应形状自适应，换供应商只改 env 不改代码；换 embedding 模型须重建向量索引（INV-2）。备选过：充值智谱（没必要花钱）、Ollama bge-m3 本地（留作番外）。
6. **安全防线接入椒图 M3（预留）**：`llm_gateway` 保持 OpenAI 兼容请求结构且 base_url 可配置——默认直连智谱，椒图 M2/M3 就绪后只改 base_url 即完成"阶段一收口"（身份/扫描/审计，零代码，对位椒图 M2#8 两阶段接入剧本）；阶段二（知识库写入人审闸 = 椒图 M3 记忆/知识投毒防护）对位本项目 ingest 写入路径。开发与 CI **不依赖椒图在线**——椒图未建成期间本项目照常直连 GLM；收官（阶段 14）对账报告加"防御分工矩阵"一栏：跨界=椒图守，界内=本项目教学落点（ADR 0002）。

### 8.2 A 类自动补全（行业通用，不消耗用户）

- 分块参数：固定 512 token、重叠 10%（书 3.2 建议区间 256–1024 token / 10–20% 内取值）[AI自动补全]
- RRF 平滑常数 k=60（书 3.2 常取值）[AI自动补全]
- 重排实现：LLM 对 top-N 候选逐一打分的教学版，不引入跨编码器模型依赖 [AI自动补全]
- 上下文增强用"标题+面包屑"前缀（WeKnora ContextHeader 形态），不用 LLM 生成前缀摘要（书 3.5 原版），成本原因，差距进对账报告 [AI自动补全]
- 图存储：SQLite 节点/边表手写 SearchNode，不引 Neo4j/networkx（拍板决策 3 的推论）[AI自动补全]
- 图谱权重公式照搬 WeKnora：PMI×0.6 + 强度×0.4 归一化 1–10（`service/graph.go:356`）[AI自动补全]

### 8.3 B 类决策（2026-09-10 已确认）

- **问题 1：LLM/Embedding 具体供应商与模型名。** [已确认]
  结论：智谱 GLM 全包（§8.1-5）。讨论要点备查：①embedding 不是切块模型——切块是纯代码工序（WeKnora 在 Go 代码内分块），embedding 是切块之后的向量化工序；②WeKnora 模型层以 27 家 provider 的 OpenAI 兼容 HTTP API 为主（`internal/models/provider/provider.go`），另有独立 Ollama 原生客户端走本地（`internal/models/chat/ollama.go`）；③本机 Keychain 已登记 glm/kimi/minimax，GLM 是三家中唯一聊天+embedding 双全者。
