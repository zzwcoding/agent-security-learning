# WeKnora 复刻项目 · 交接文档（L0 启动包）

> 交接日期：2026-09-10。由调研窗口（已完成 WeKnora 源码级调研 + 理论框架研读 + 路线设计）交接给新的规划/执行窗口。
> **一句话任务**：用 Python 从零分阶段复刻 WeKnora 的 **RAG + 知识图谱 + Wiki** 三条核心管线——学习项目，目的是吃透这部分知识，不是造产品。
> **方法约定（用户已拍板）**：`sdd-flow` 出骨架产物（PRD/模块卡/spec/票/CI），`learn-by-rebuild` 出执行纪律（小步/可观察变化/讲解落盘/用户控节奏）。两个 skill 都在本机，新窗口按需加载。

---

## 0. 新窗口起步清单（按序执行）

1. 通读本文档（尤其是 §3 待拍板决策、§4 阶段路线、§6 纪律）。
2. 向用户确认 §3 的**三个未决决策**（带推荐去问，用户可选其他）。
3. 落状态文件：`MISSION.md`、`RESOURCES.md`、`NOTES.md`（模板与必填内容见 §7）。
4. sdd-flow 阶段 0：项目骨架 + CI（pytest + spec gate 占位）——**CI 先于第一行业务代码**。
5. sdd-flow 阶段 1（轻量）：把 §2 的范围界定过成 `docs/prd.md` 定稿 + `CONTEXT.md` 术语表。这是学习项目，逼问从简，但范围（含/不含）必须用户逐条确认。
6. 用户确认路线后，按 §4 逐阶段开工（learn-by-rebuild：用户说"下一步"才推进，说"提交"才 commit）。

---

## 1. 本窗口已完成的工作（背景脉络）

按时间序，全部产物已落盘、可复查：

| 产物 | 路径 | 内容 |
|---|---|---|
| WeKnora 深度调研报告 | `../WeKnora调研.md`（仓库根） | 十章，~3 万字；基于官方仓库 @ commit `1c16db3`（2026-09-10 浅克隆）逐文件阅读；每个论断附源码路径 |
| 与椒图(agentjiaotu)的安全对照 | `../agentjiaotu/docs/research/2026-09-10-WeKnora安全工程对照.md` | WeKnora 安全工程 × 用户另一项目 M1/M2/M3 的对照；本复刻项目可借其"不照搬"判断 |
| 书第三章原文 | `/tmp/chapter3.md`（临时，重取命令见 §8） | 李博杰《深入理解 AI Agent》第三章《用户记忆和知识库》，698 行，本窗口已通读 |
| 阶段路线设计 | 本文 §4 | 已在本窗口与用户过过一轮框架，三个决策未答（见 §3） |

本窗口对话中与用户共同建立的关键认知（新窗口可直接引用，不必重推）：

- **四维度模型**：一份 chunk 是四条管线之间的"契约"——向量、关键词、图谱、Wiki 各自投影；向量+关键词吃同一份增强料（第一层：检索范式），图谱和 Wiki 是对 chunk 的再加工（第二层：知识组织）。
- **四种吃法不一样**：向量怕缺上下文（加标题面包屑）；图谱怕没实体（挑 chunk 防复读 few-shot、防重复 LLM 计费）；Wiki 怕拼不回全文（重叠去重+图片信息回读）；父块不索引只做命中后上下文扩展。
- **安全视角**：投毒的爆炸半径按维度隔离——改 chunk 会污染四维（都会重建），只改 Neo4j 关系则只污染图谱维度。书 3.4"RAG 的安全边界"（间接注入/知识投毒/指令与数据分离）是理论侧印证。
- **书↔WeKnora↔本项目的定位**：书给理论，WeKnora 给工程源码样本，复刻项目打通两者。书走得更远的地方（Proposer-Reviewer 双 Agent 知识更新流水线）正是用户另一项目椒图 M3#4 的设计图纸。

---

## 2. 项目定位与范围（"100% 核心功能"的界定）

- **目录**：`/Users/divh/Downloads/安全评估agent/weknora复刻/`（与 soc-demo、harness复刻、执行工具复刻 同级，沿用本仓库"主题+复刻"命名惯例）
- **语言**：Python（用户指定）。参考项目 WeKnora 是 Go+Vue+Python docreader，本项目**只复刻思想与功能形态，不照搬技术栈**。
- **包含（复刻目标）**：
  - 文档入库 → 解析 → 分块（父子/重叠）→ 双索引（向量+关键词）→ 混合检索（RRF）→ 重排 → 带引用来源标记的 LLM 问答
  - 知识图谱：KB 级 schema 配置（实体/关系类型）→ 逐 chunk LLM 抽取 → 图存储 → SearchNode 查询 → 与 RAG 并行汇入问答上下文
  - Wiki：chunk 拼回全文 → LLM 重写成 Markdown 页 → 自动交叉链接 + 入口页 → 版本历史与一键回滚
  - IndexingStrategy 四开关（vector/keyword/wiki/graph 独立启停，缺管线也能跑）
- **明确不含（进收官对照报告讲"真 WeKnora 怎么做"，不进复刻代码）**：多租户 RBAC、MCP、IM 接入、沙箱、27 厂商模型路由、asynq/Redis 分布式任务（同步或线程替代）、docreader 六引擎（选 2 个解析器示范，建议纯文本/Markdown 内置 + 一个 PDF 解析库，具体和用户确认）。

---

## 3. 待用户拍板的三个决策（新窗口第一件事）

| # | 决策 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| 1 | LLM/Embedding 接入 | A. 真实 API 为主（`agent-key <供应商>` 从 Keychain 取）+ fake stub 跑 CI；B. Ollama 本地；C. 纯 fake 确定性 | **A** | 影响 RAG 问答/实体抽取/wiki 生成的质量与 CI 稳定性；A 的 fake stub 让测试不花钱不抖动 |
| 2 | 可观察界面 | A. Streamlit 从阶段 1 就有页面；B. FastAPI+HTML；C. 纯 CLI+日志 | **A**（Python 单栈出页面最快，符合"每阶段页面可观察变化"） | 决定每阶段的"可观察变化"长什么样 |
| 3 | 存储深度 | A. SQLite+numpy 手写向量/图存储（吃透原理）；B. 直接 pgvector+Neo4j（工程向） | **A**，阶段 14 对照真 WeKnora 选型（ParadeDB/Neo4j） | 决定"吃透"的深度与工作量 |

补充小决策（可随 §2 PRD 逼问一起确认）：示范解析器选型（建议：内置 txt/md + pymupdf 或 markitdown 二选一）。

---

## 4. 阶段路线（阶段 0 + 14 阶段，简单→复杂）

每阶段 ≤30 行新增代码、有可观察变化、业务数据流在阶段内闭合（生产者→消费者不跨阶段断链）。每阶段标配三对照：书第三章小节 + WeKnora 源码路径（§5.1 地图）+ `lessons/NNNN-阶段名.md` 落盘。

**阶段 0（前置）**：目录骨架 + CI（pytest + `tools/check_specs.py` 占位，来源 sdd-flow references/spec-validator.py）+ issue tracker（本地 markdown 票即可）。

| # | 阶段 | 新增什么 | 可观察变化 | 学到什么（书 ↔ WeKnora） |
|---|---|---|---|---|
| **第一幕 · RAG 基础层（书 3.2）** |
| 1 | 入库最小闭环 | 上传 txt → 固定大小分块 → SQLite chunks 表 → 页面列表展示 | 页面看到块 | 分块为什么必须（嵌入长度限制+注意力稀释）；chunk 是契约 |
| 2 | BM25 稀疏检索 | 手写倒排索引 + BM25(k1/b) | 查询框返回带分排序 | TF-IDF→BM25、词频饱和、长度归一化（书实验 3-5） |
| 3 | 稠密向量检索 | embedding 接入 + 余弦相似度 | 同义词命中（kitty→cat） | 嵌入、余弦看方向不看长度（书 3.2） |
| 4 | 混合检索 RRF | 两路融合 | 排序更稳、有对比视图 | RRF(k=60)、两路分数不可直接加（书 3.2 / WeKnora fusion） |
| 5 | 上下文增强 | 标题+面包屑前缀进索引，有/无前缀对照 | 指代类查询命中改善 | 上下文感知检索、失败率 -49%/-67%（书 3.5 / WeKnora EmbeddingContent） |
| 6 | RAG 问答闭环 | LLM 生成 + 引用来源标记 | 问答页带引用编号 | 检索→注入→生成；指令与数据分离（书 3.4 安全边界） |
| **第二幕 · 知识图谱（书 GraphRAG 节）** |
| 7 | schema + 实体抽取 | ExtractConfig（Nodes/Relations 类型表）+ 逐 chunk LLM 抽实体 | 节点表出现 | 三元组、schema 引导抽取、语义降级（WeKnora ExtractConfig/extract.go） |
| 8 | 关系抽取 + 图查询 | 实体对关系抽取 + PMI 加权 + SearchNode | 实体→关系链查询 | 多跳推理、实体消歧（WeKnora graph.go 权重公式） |
| 9 | 图谱入问答 | 问题 NER → 图检索 → 与向量/BM25 并行汇入上下文 | 关系类问题前后对比 | GraphRAG 混合增强（WeKnora search_entity 插件） |
| **第三幕 · Wiki（书 OpenViking/知识更新节）** |
| 10 | 文档→Wiki 页 | 拼回全文（重叠去重+图片信息回读）→ LLM 重写成 Markdown 页 | 页面渲染出来 | 重写≠检索、32K 截断（WeKnora reconstructContent） |
| 11 | 自动链接 + 索引页 | linkify 交叉链接 + 入口页 | 页间可点击跳转 | 文件系统范式、"像 Wikipedia"建链接（书 OpenViking 节） |
| 12 | 版本与回滚 | 编辑落 revision、一键回滚 | 改一页滚回去 | 知识层/证据层分离、PR 思想（书 3.3.3；WeKnora wiki revision） |
| **第四幕 · 收官** |
| 13 | 四页控制台 + 四开关 | 入库/问答/图谱/Wiki 页整合 + IndexingStrategy 开关 | 关掉某管线看效果 | 管线分发枢纽（WeKnora knowledge_post_process） |
| 14 | 对账 WeKnora | 逐模块读真源码对照 | 选型卡 + 差距报告 | 原理→工程差距（ParadeDB vs SQLite、Neo4j vs 图表、asynq vs 同步） |

---

## 5. 知识底座（浓缩版，避免新窗口重新调研）

> 以下源码路径均为 2026-09-10 在 WeKnora @ `1c16db3` 实测 grep 核对过；写进 lessons 引用前建议再核一次行号（learn-by-rebuild 教训：凭记忆写证据地图会漂移）。

### 5.1 WeKnora 关键源码地图

**入库与解析链**：
- 任务定义 `internal/types/task.go:236`（`document:process`）；入口 `internal/application/service/knowledge_create.go`
- 主处理 worker `knowledge_process.go:3238 ProcessDocument`（幂等/取消检查、格式前置闸：图片要开多模态、音频要配 ASR、视频不支持）
- 四条导入分支 `knowledge_process.go:3400-3540`（file_url 带 SSRF 复检防 DNS 重绑定 / URL / 文本段落 / 文件）
- 引擎选择 `convert` `knowledge_process.go:3691`：三级规则（KB `parser_engine_rules` → 类型默认 ppt→markitdown/anydoc 优先 → 空）+ 自定义 endpoint 过 SSRF
- 引擎注册表 `internal/infrastructure/docparser/engine_registry.go:69 NewReader`（本地引擎进程内解析；远程/未知引擎全路由 docreader gRPC，靠 ListEngines 自动发现）；Python 侧 `docreader/parser/registry.py:68 get_parser_class`（请求引擎→类型默认→builtin 兜底）与 `:150` 注册表
- 分块与索引 `processChunks` `knowledge_process.go:283`：UTF-8 清洗→幂等清理旧数据（含 DelGraph）→父子分块→**父块只入库不索引**（`:566` 注释原话）→embedding 输入=标题+ContextHeader 面包屑+正文（`EmbeddingContent()`+`buildKnowledgeIndexContent`）→BatchIndex 一趟写双索引
- summary chunk 生成后也入索引 `knowledge_process.go:1343-1391`

**四管线开关与分发枢纽**：
- `internal/types/indexing_strategy.go`：IndexingStrategy{Vector/Keyword/Wiki/Graph}Enabled，默认只开前两个；`NeedsChunks()`=四管线都依赖分块
- 分发枢纽 `knowledge_post_process.go`（`Handle:83`）：按开关分发；图谱走 `selectGraphChunks:690`（丢 caption、OCR 仅在父文本无可读正文时收、text 必须过 `chunkHasExtractableText:731`——防 LLM 复读 few-shot、防重复计费）

**知识图谱**：
- 数据模型 `internal/types/graph.go`（Entity/Relationship/GraphBuilder 接口）
- 每 chunk 一个异步任务 `extract.go:224 Handle`：取消/过期短路→ExtractConfig 组装结构化 prompt（带示例）→一次 LLM 抽 `GraphData{Text,Node[],Relation[]}`→`graphEngine.AddGraph(namespace=KB+文档ID)`
- 存储 Neo4j（`internal/container/container.go:163` 装配；`repository/retriever/neo4j/repository.go`；接口 `types/interfaces/retriever_graph.go` AddGraph/DelGraph/SearchNode——图谱存储是唯一绑死的组件）
- 权重与可视化 `service/graph.go:356 BuildGraph`：PMI(0.6)+强度(0.4) 归一化 1-10、实体度数、chunk 级关系图、自动 mermaid 图
- 查询两路：RAG 管线 `chat_pipeline/extract_entity.go:150`（LLM NER）→`chat_pipeline/search_entity.go:44`（ENTITY_SEARCH 事件、并发 SearchNode、并行汇入上下文）；Agent 工具 `agent/tools/query_knowledge_graph.go`（≤10 KB、scope fail-closed）
- **注意**：in-memory `graphBuilder` 的 `BuildGraph/GetRelationChunks` 当前无调用方（预留未接线）；调研报告引用的 `internal/llmreference/` 路径不存在，引用别名 fail-closed 实际在 `internal/modelcontext` + `chat_pipeline/references.go`

**Wiki**：
- `wiki_ingest.go`（3246 行）：`maxContentForWiki:40`（32768 截断）、`reconstructContent:2865`（只取 text chunk 拼回、重叠去重）、`reconstructEnrichedContent:2883`（回读 image_ocr/caption 内联——否则纯图片文档产出空内容）
- 配套：`wiki_linkify.go`（交叉链接）、`wiki_slug_handles.go`、wiki 页面版本存主库（`repository/wiki_page.go`，gorm）

**检索引擎层（可插拔）**：`repository/retriever/` 下 postgres(默认 ParadeDB=业务表+pgvector+BM25 一库三角色)/opensearch/doris/qdrant/weaviate/tencentvectordb/sqlite 七种实现；融合在 `application/service/knowledgebase_search_fusion.go`（加权 RRF）

### 5.2 书第三章知识地图（《深入理解 AI Agent》book/chapter3.md）

- **3.2 RAG 基础**：分块三策略（固定/递归结构感知/语义），块 256-1024 token、重叠 10-20%；稠密嵌入（余弦相似度看方向）；BM25（TF-IDF→词频饱和 k1 + 长度归一化 b）；混合检索三阶段（并行召回→RRF k=60 融合→跨编码器重排，重排不是补救 RRF 而是换更强匹配范式）；指标 recall@k/MRR/nDCG
- **3.3 超越扁平文本**：两个案例（黑猫白猫计数=top-k 漏召回、Xfinity 优惠=边界语义缺失）→ 索引期就要提炼；**RAPTOR**（聚类递归摘要成树，跨层检索）与 **GraphRAG**（三元组、多跳推理、实体消歧≠词义消歧；软肋=语义降级+错误提取致知识污染）→ 推荐**分层互补**（自然语言保存核心信息+结构化索引专项）；**OpenViking 文件系统范式**（L0 摘要/L1 概览/L2 全文按需加载、Markdown+Git、必须像 Wikipedia 建链接且写入提示词要明确要求）；**知识更新**（增量=PR：Proposer-Reviewer 双 Agent 异源互审、证据层/知识层/服务层三层分离、定期全量整理、失效内容下线、**权限过滤下推到检索层**）
- **3.4 智能体化 RAG**：检索从管道变工具、ReAct 多轮迭代；**RAG 安全边界**：检索文档是间接提示注入载体、知识投毒在索引之前；防御两层=来源标记（指令与数据分离）+检索内容不得直接触发高危操作（独立授权）
- **3.5 上下文感知检索**：LLM 为块生成前缀摘要再索引，同时增强稀疏+稠密，失败率 -49%（+重排 -67%）；与第二章"上下文感知压缩"区分（索引期做加法 vs 运行期做减法）
- 读取方式：`curl -s 'https://raw.githubusercontent.com/bojieli/ai-agent-book/main/book/chapter3.md' -o /tmp/chapter3.md`（仓库 bojieli/ai-agent-book，45k star）

### 5.3 教学提示（本窗口观察到的用户偏好）

- 语言：通篇大白话，比喻**优先取自本项目业务对象**（本项目可用：chunk=知识卡片、倒排索引=书后术语索引页、RRF=两个评委只报名次不报分数、图谱=人物关系图、wiki=自动整理的笔记本）
- 结构：对照表 + 源码行号证据 + ASCII 数据流图受欢迎；诚实标注（未找到/不一致/未接线）是加分项不是减分项
- 用户会连续追问概念（本次"4 种维度"连问三轮才收口）——一次答透，不留"下次再讲"

---

## 6. 执行纪律（两个 skill 的分工与硬规则）

**learn-by-rebuild（执行纪律，L2 互动档主框架）**：
1. 小步 ≤30 行新增/阶段，禁止整文件写完再逐行讲
2. 数据流同阶段闭合：每个新字段/消息，同阶段内谁生产、谁消费、在哪能看到
3. 直接写正确版，不搞"故意写错再修"
4. 不超前写未来阶段的代码
5. 节奏用户控制："下一步/继续"推进、"提交"才 commit（消息格式 `阶段 X.Y:做了什么(关键细节)`）
6. 验证用真实页面+项目代码，不写临时脚本（/tmp 依赖级测试可）
7. 讲解落盘 `lessons/NNNN-阶段名.md`（五节：三问动机+路线图标"你在这里"/全链路 ASCII 图/跟着数据走 N 步/新技术点四要素/关键顿悟 2-3 条，可选亲手验证+捣乱实验）；对话只发 3-5 行摘要+路径
8. 教学注释随阶段轮换：文件里只留当前阶段注释，不堆积
9. 第一个可运行阶段就教用户自己起服务：`uv venv .venv` → `uv pip install --python .venv/bin/python -r requirements.txt` → 启动 → curl 验证；之后服务由用户终端托管
10. agent 代跑服务必须后台+`disable_timeout`（默认 600s 会杀服务）；用户起过服务后 agent 不抢端口，只 curl 验证；端口占用 `lsof -ti:8000 | xargs kill -9`
11. 阶段规划先行：路线给用户确认后执行，中途不合理回滚重做不硬撑

**sdd-flow（骨架产物与红线）**：
- 产物路径：`docs/prd.md`（含范围界定）、`CONTEXT.md`（术语表，可含语义核心：状态机/不变量）、`specs/modules.md`（模块卡+`## 边界规则`节+`## 页面映射`节）、`specs/<功能>.md`、issue tracker 票、`.github/workflows/ci.yml`、`docs/adr/`
- 学习项目裁剪：逼问从简（PRD 以 §2 范围为底）、架构图可用 mermaid 简版过审、CI 最小门禁（lint+pytest+spec gate+边界闸可自写几十行脚本）
- **框架红线**：技术栈表点名的框架必须真引入（依赖出现在 requirements.txt 且代码真调用），不许手写同构替代；冲突停下回报用户裁决
- **边界红线**：模块间只走公开接口，越界停下回报；边界规则落 `specs/modules.md` 且 CI 里真有人查
- 收尾五回写：spec 出入 / modules.md 实现事实 / CONTEXT.md 术语 / lessons/ 施工日志 / 架构投影同步

---

## 7. 状态文件模板（新窗口开工时落盘）

**MISSION.md**：
```
# 学习目标
用 Python 分阶段复刻 WeKnora 的 RAG+知识图谱+Wiki 核心管线，吃透"一份 chunk 如何变成四种知识维度、各维度如何被生产和消费"。
# 验收标准
- [ ] 14 阶段全部完成且每阶段有页面可观察变化
- [ ] 每阶段 lessons/NNNN.md 落盘，用户亲手跑通关键链路
- [ ] 阶段 14 对账报告：完全复刻/有意简化/真正差距 三栏清楚
- [ ] 用户能通过收官场景题（3 道，如"关掉 keyword 开关后 kitty→cat 还能命中吗，为什么"）
```

**RESOURCES.md**（信源清单）：§5.1/§5.2 的全部来源 + 本文件 §8 的获取命令；讲解论断挂信源。

**NOTES.md**：用户随口教学偏好当场记；§5.3 三条作为初始内容。

**learning-records/**：每阶段一条 ADR 式简记（学了什么/卡在哪/结论）；跨会话续学先读它+git log，不依赖对话摘要。

---

## 8. 环境与信源获取

```bash
# WeKnora 源码（调研/对照用；写 lessons 前先克隆）
git clone --depth 1 https://github.com/Tencent/WeKnora /tmp/weknora-research
# 核对版本：当前调研基于 commit 1c16db3（2026-09-10 main）

# 书第三章
curl -s 'https://raw.githubusercontent.com/bojieli/ai-agent-book/main/book/chapter3.md' -o /tmp/chapter3.md

# API key（macOS Keychain，不硬编码不自动 fetch）
agent-key <供应商>

# 已有调研文档（仓库根，直接读）
# /Users/divh/Downloads/安全评估agent/WeKnora调研.md
# /Users/divh/Downloads/安全评估agent/agentjiaotu/docs/research/2026-09-10-WeKnora安全工程对照.md
```

已知翻车点（skill 沉淀 + 本机相关）：uvicorn reload 传字符串 `"app:app"`；后台任务 600s 超时杀服务；惰性生成器+同连接查询死锁（先取完再循环）；SQLite 单写者水位线。

---

## 9. "吃透"的验收定义（learn-by-rebuild 收官口径）

1. 14 阶段全部完成，每阶段页面可观察变化 + lessons 落盘 + 用户亲手验证
2. 阶段 14 对账报告三栏清楚：完全复刻的部分 / 有意的简化（以我们为准）/ 真正的差距
3. 每幕收尾出 3 道场景题闯关（用户先答再对照代码验证），错题记 NOTES.md 学习日志
4. 终极自测：用户能不看资料，向别人讲清"一份 PDF 进来，怎么变成向量、倒排、图谱、Wiki 四个维度，查询时各自怎么被用"
