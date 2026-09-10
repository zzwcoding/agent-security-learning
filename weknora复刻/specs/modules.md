# 模块划分 · WeKnora 复刻 v1（2026-09-10，L1 设计窗口起草）

> 依据：`docs/prd.md` v1.0（已定稿）+ `CONTEXT.md`（术语/INV-1/INV-2）+ deep-modules 深模块纪律。
> 铁律：跨模块调用只许走对方公开接口（包根 `__init__.py` 暴露面）；接口卡变更回 L0 评审。
> 机读契约：模块卡 = `## 模块名` + `目录:` 行 + `### 依赖` 的 `- 模块:` 反引号依赖边；`python3 tools/check_specs.py` + `python3 tools/check_boundaries.py` 校验。
> 目录骨架本阶段不建（先写卡后建目录，spec gate 对目录缺失只 WARN）。

## 0. 全景与依赖方向

```
                 ┌──────────────────────────────────────┐
                 │  webui（Streamlit 四页，叶子上层）     │
                 └───────┬──────────┬─────────┬─────────┘
                         ▼          ▼         ▼
                 ┌────────┐  ┌──────────┐  ┌──────┐
   文件入库 ───► │ ingest │  │   qa     │  │ wiki │◄── 页内重写/回滚
                 └───┬────┘  └────┬─────┘  └──┬───┘
        四开关分发    │            │           │
        ┌────────────┼────────────┼───────────┤
        ▼            ▼            ▼           ▼
   ┌──────────┐  ┌───────┐  ┌─────────┐  ┌────────┐
   │retrieval │  │ graph │  │  store  │  │llm_    │──► 智谱 GLM API（唯一出网口）
   │(BM25/向量│  │(抽取/ │  │(SQLite  │  │gateway │    fake stub 同接口供 CI
   │ /RRF/重排)│  │Search)│  │ 唯一事实│  │(chat/  │
   └────┬─────┘  └───┬───┘  │  源)    │  │ embed) │
        └─────┬──────┴──────►└─────────┘  └────────┘
              └──────────────► 共享 dataclass 类型由 store 导出
```

依赖方向单向无环：
- 叶子（不依赖任何模块）：`llm_gateway`、`store`
- 中间层：`retrieval` → `store`,`llm_gateway`；`graph` → `store`,`llm_gateway`；`wiki` → `store`,`llm_gateway`
- 管线层：`ingest` → `store`,`retrieval`,`graph`,`wiki`（IndexingStrategy 四开关分发枢纽，对位 WeKnora `knowledge_post_process.go:83 Handle`）
- 查询层：`qa` → `retrieval`,`graph`,`store`,`llm_gateway`
- 表现层：`webui` → `ingest`,`qa`,`graph`,`wiki`,`store`（只读查询走 store，业务动作走各管线模块）

关键取舍：
- **retrieval 拥有索引投影的写入面**（`index_chunks`）：向量/倒排是检索的内部实现细节，ingest 只负责"按开关调用"，不知道 BM25/余弦怎么算——深模块，接口比实现简单。
- **不拆 parser/chunker 独立模块**：解析+分块合计 <100 行且天然一起变化（分块策略跟着解析出的结构走），拆开即浅模块瘟疫；同驻 `ingest`。
- **问答页的融合对比视图 = retrieval 返回中间态 `SearchTrace`**（PRD 逐页数据需求表标注的"需要新查询面"），qa 透传给 webui，不为 UI 单开一套查询。
- **共享 dataclass（Chunk/Document/Entity/…）由 `store` 导出**：store 是持久化地基与唯一事实源（INV-2），类型跟着事实源走，避免"类型模块"这种伪深模块。

## llm_gateway

职责: LLM/embedding 统一调用口——真实 GLM API 与 fake stub 同接口，全项目唯一出网口（PRD §0.2-3）
目录: llm_gateway/

### 公开接口

- `chat(messages: list[dict], *, temperature: float = 0.2) -> str` — 对话生成；messages 为 OpenAI 兼容角色结构
- `embed(texts: list[str]) -> list[list[float]]` — 批量嵌入（embedding-3，默认 2048 维）
- `backend_name() -> str` — 当前后端标识（`"glm"` / `"fake"`），页面上标注当前演示走的是真 API 还是 stub
- `use_fake_backend() -> None` — 切到确定性 fake stub；**只许测试路径调用**（边界规则第 6 条）

配置面（ADR 0002 椒图接入预留）：base_url / api_key / 模型名走环境变量——base_url 默认智谱端点，指向椒图网关即完成"阶段一收口"（OpenAI 兼容，零代码）；请求结构保持 OpenAI 兼容是本模块的硬约定。

### 依赖

- 模块: （无——叶子模块）
- 外部: 智谱 GLM API（adapter: httpx 真实调用 / fake stub 确定性返回）；API key 经 `agent-key glm` 从 macOS Keychain 取，不落库不进日志（PRD §5）

### Seam 与测试

- Seam: HTTP 出口 + key 获取（adapter: 真实 httpx / fake stub）
- Adapter: fake stub（确定性向量与文本，CI 不花钱不抖动）
- 测试计划: fake 后端同输入同输出（确定性）；`chat`/`embed` 两后端签名与返回形状一致；key 缺失时报统一错误不泄漏 key 内容；stub 返回的向量维度与配置一致

## store

职责: SQLite 唯一持久化口——KB/文档/chunk/图谱节点边/Wiki 页与 revision/IndexingStrategy 与 ExtractConfig 配置；chunk 表是唯一事实源（INV-2）
目录: store/

### 公开接口

共享类型（dataclass，全项目词汇表）：`Document`、`Chunk`（含 parent_id、ContextHeader）、`Entity`、`Relation`、`WikiPage`、`Revision`、`IndexingStrategy`（vector/keyword/wiki/graph 四布尔）、`ExtractConfig`（Nodes/Relations 类型表）

- 初始化：`init_db(path: str) -> None`（建表幂等）
- KB：`create_kb(name: str) -> int`、`get_kb(kb_id) -> KB`、`list_kbs() -> list[KB]`
- 文档：`create_document(kb_id, filename, fmt, path="") -> int`、`get_document(doc_id) -> Document`、`list_documents(kb_id) -> list[Document]`、`set_document_status(doc_id, status) -> None`（path 记录原文件路径，reingest 重建时按它重读原文——阶段 1.2 落位）
- chunk：`replace_chunks(doc_id, chunks: list[Chunk]) -> None`（重新入库幂等：先清旧 chunk 及其全部投影，PRD §7-⑨）、`list_chunks(doc_id) -> list[Chunk]`（含父块）、`list_child_chunks(kb_id) -> list[Chunk]`（只含子块=可索引集合）、`get_chunk(chunk_id) -> Chunk`
- 向量投影：`save_embeddings(kb_id, items: list[tuple[int, list[float]]]) -> None`、`load_embeddings(kb_id) -> list[tuple[int, numpy.ndarray]]`（存 blob，数学运算不归本模块）
- 图谱投影：`add_graph(kb_id, doc_id, entities: list[Entity], relations: list[Relation]) -> None`、`del_graph(doc_id) -> None`（重入库清理）、`search_node(kb_id, entity_name) -> tuple[Entity | None, list[Relation]]`、`list_entities(kb_id) -> list[Entity]`、`list_relations(kb_id, entity_name: str | None = None) -> list[Relation]`
- Wiki：`upsert_wiki_page(kb_id, doc_id, slug, markdown, links) -> None`、`get_wiki_page(slug) -> WikiPage`、`list_wiki_pages(kb_id) -> list[WikiPage]`、`add_revision(page_id, markdown) -> int`（返回版本号）、`list_revisions(page_id) -> list[Revision]`、`rollback(page_id, revision_no) -> None`
- 配置：`get_strategy(kb_id) -> IndexingStrategy`、`set_strategy(kb_id, strategy) -> None`、`get_extract_config(kb_id) -> ExtractConfig`、`set_extract_config(kb_id, config) -> None`

### 依赖

- 模块: （无——叶子模块）
- 外部: SQLite 单文件（adapter: 文件库 / 内存库 `:memory:` 供测试）

### Seam 与测试

- Seam: SQLite 连接（adapter: 文件 / 内存）
- Adapter: 内存 SQLite
- 测试计划: `replace_chunks` 幂等（重入库不产生重复 chunk/孤儿投影，INV-2）；`rollback` 后页面正文=指定 revision；`search_node` 按（名称,类型）消歧返回正确邻居；四开关默认值=只开 vector/keyword

## retrieval

职责: 手写稀疏+稠密检索——BM25 倒排（k1/b 真算）+ numpy 暴力余弦 + RRF(k=60) 融合 + LLM 逐一打分的教学版重排；索引投影的唯一写入面
目录: retrieval/

### 公开接口

- `index_chunks(kb_id) -> int` — 从 store 取 `list_child_chunks` 建/重建向量+倒排投影（embedding 输入=标题+面包屑 ContextHeader+正文）；返回索引条数；**只索引子块（INV-1）**
- `bm25_search(kb_id, query: str, top_k: int = 10) -> list[ScoredChunk]`
- `vector_search(kb_id, query: str, top_k: int = 10) -> list[ScoredChunk]`
- `hybrid_search(kb_id, query: str, top_k: int = 10, *, rerank: bool = True) -> SearchTrace` — **新查询面**：`SearchTrace` dataclass 含 `bm25_hits` / `vector_hits` / `fused`（RRF 融合分）/ `reranked` 四份中间态，问答页对比视图的数据源
- `expand_to_parent(chunks: list[ScoredChunk]) -> list[Chunk]` — 命中子块扩展取父块上下文（父块本身不进索引，INV-1）

`ScoredChunk` dataclass：`chunk`、`score`、`source`（`"bm25"`/`"vector"`/`"rrf"`/`"rerank"`）

### 依赖

- 模块: `store`、`llm_gateway`
- 外部: numpy（手写余弦，不许调 sklearn/faiss/rank_bm25——PRD §0.2-2 调包红线）

### Seam 与测试

- Seam: `llm_gateway`（embed/rerank 打分）、`store`（chunk 与向量读取）
- Adapter: fake gateway + 内存 SQLite
- 测试计划: BM25 数值手算对照（词频饱和 k1、长度归一化 b 各一例）；余弦方向不看长度（同义 kitty→cat 命中，fake 向量手工构造）；RRF k=60 融合名次手算对照；INV-1 断言（任何检索路径结果无父块）；`SearchTrace` 四份中间态齐全且 fused 名次 = 两路名次的 RRF 结果

## ingest

职责: 入库管线——解析 txt/md/pdf + 父子/重叠分块（固定 512 token + 10% 重叠）+ 入库 + 按 IndexingStrategy 四开关分发到四维投影（对位 WeKnora `knowledge_post_process.go:83 Handle`）
目录: ingest/

### 公开接口

- `ingest_file(kb_id, path: str) -> int` — 全管线入口：解析 → 分块（含 ContextHeader 标题+面包屑）→ `store.replace_chunks` → 按四开关分发（vector/keyword → `retrieval.index_chunks`；graph → `graph.extract_document`；wiki → `wiki.generate_for_document`）；返回 doc_id
- `reingest_document(doc_id) -> None` — 幂等重建（先清旧数据含 DelGraph，PRD §7-⑨）
- `parse_file(path: str) -> str` — txt/md 内置解析、pdf 走 pymupdf；解析失败抛 `ParseError`（调用方置文档失败态，不阻塞其他文档）

### 依赖

- 模块: `store`、`retrieval`、`graph`、`wiki`
- 外部: pymupdf（PDF 解析；txt/md 内置，docreader 六引擎明确不含——PRD §1.2-7）

### Seam 与测试

- Seam: `store`（内存库）、`retrieval`/`graph`/`wiki`（可注入 spy 验证分发）、文件系统（fixture 文档）
- Adapter: 内存 SQLite + fake gateway（间接经 retrieval/graph/wiki）
- 测试计划: 分块尺寸/重叠率断言（512 token ±0、重叠 10%）；父子块指针正确且父块不进索引（INV-1，经 retrieval 结果断言）；四开关逐一关闭时对应分发不被调用（spy 计数）；重入库幂等（chunk 数不变、图谱旧边清除）；解析失败文档置失败态且队列继续

## graph

职责: 知识图谱管线——ExtractConfig schema 引导的逐 chunk LLM 实体/关系抽取 + PMI 加权（0.6/0.4 归一化 1–10）+ SearchNode 图查询 + 问题 NER
目录: graph/

### 公开接口

- `extract_document(kb_id, doc_id) -> ExtractStats` — 入库钩子：按 ExtractConfig 组装结构化 prompt 逐 chunk 抽取（只挑有可抽取文本的 chunk，防复读防重复计费）；抽取结果类型不在 schema 表内的丢弃（PRD §7 输出校验）；写 `store.add_graph`；`ExtractStats` 含 chunk 数/实体数/关系数/丢弃数
- `search_node(kb_id, entity_name: str) -> GraphHit` — SearchNode 查询面（图谱页"按实体查关系链"数据源）；`GraphHit` 含实体 + 按权重降序的关系链
- `extract_entities_from_query(query: str) -> list[str]` — 问题 NER（LLM，对位 `chat_pipeline/extract_entity.go`），供 `qa` 并行汇入图谱上下文
- `list_entities(kb_id) -> list[Entity]`、`list_relations(kb_id, entity_name: str | None = None) -> list[Relation]` — 图谱页节点/关系表数据源（含 chunk 出处，可追溯）

### 依赖

- 模块: `store`、`llm_gateway`
- 外部: 无（图存储手写 SQLite 节点/边表，不引 Neo4j/networkx——PRD §8.2）

### Seam 与测试

- Seam: `llm_gateway`（抽取/NER）、`store`（图投影）
- Adapter: fake gateway（返回固定三元组）+ 内存 SQLite
- 测试计划: schema 外类型丢弃且计入 ExtractStats；无可抽取文本的 chunk 不触发 LLM 调用（spy 计数）；PMI 权重公式数值对照（照抄 WeKnora `service/graph.go:356`）；实体按（名称,类型）消歧；SearchNode 返回的关系链挂 chunk 出处

## qa

职责: RAG 问答闭环——检索（含图谱并行汇入）→ 以"参考资料"角色注入 → LLM 生成带引用编号的回答（引用标记=指令与数据分离的安全机制落点，书 3.4 / PRD §6.2）
目录: qa/

### 公开接口

- `ask(kb_id, question: str, *, top_k: int = 5, use_graph: bool = True) -> Answer` — 一站式查询面：`Answer` dataclass 含 `text`（带 [1][2] 引用编号）、`citations: list[Citation]`（编号 → chunk + 文档名，可追溯）、`trace: SearchTrace`（透传 retrieval 中间态，问答页对比视图数据源）、`graph_hits: list[Relation]`（NER→SearchNode 的关系链，前后对比演示用）

### 依赖

- 模块: `retrieval`、`graph`、`store`、`llm_gateway`
- 外部: 无

### Seam 与测试

- Seam: `llm_gateway`（fake 捕获实际发出的 messages）、`retrieval`/`graph`（内存布景）
- Adapter: fake gateway + 内存 SQLite
- 测试计划: 引用编号可回溯到真实 chunk（每个 [N] 在 citations 中有对应项）；fake gateway 捕获的 messages 中检索内容以"参考资料"角色注入且与指令分离（断言 prompt 结构）；父块扩展生效（注入的是父块上下文而非命中子块原文，INV-1 消费侧）；`use_graph=True` 时关系链进入上下文、`False` 时不进（四开关演示的数据面）

## wiki

职责: Wiki 管线——chunk 拼回全文（重叠去重 + 32K 截断）→ LLM 重写成 Markdown 页 → linkify 交叉链接 + 入口页 → revision 版本历史与一键回滚
目录: wiki/

### 公开接口

- `generate_for_document(kb_id, doc_id) -> str` — 入库钩子：拼回全文 → LLM 重写（提示词明确要求回指已有条目，书 3.3）→ linkify → 落页+首 revision；返回 slug
- `regenerate(doc_id) -> str` — Wiki 页内"重新生成"按钮触发（走同一生成链，落新 revision）
- `get_page(slug) -> WikiPage`、`list_pages(kb_id) -> list[WikiPage]`、`index_page(kb_id) -> str`（入口页 Markdown，列出全部页链接）
- `list_revisions(slug) -> list[Revision]`、`rollback(slug, revision_no) -> None` — 版本历史与一键回滚（回滚=切回旧 revision，PRD §2）

### 依赖

- 模块: `store`、`llm_gateway`
- 外部: 无

### Seam 与测试

- Seam: `llm_gateway`（重写）、`store`（页与 revision）
- Adapter: fake gateway + 内存 SQLite
- 测试计划: 重叠去重拼回=原文逐字一致（构造 10% 重叠 chunk 断言）；超 32K token 截断；每次生成都落新 revision 且回滚后正文=指定版本；linkify 产出的链接目标都存在于页表（无死链）

## webui

职责: Streamlit 四页控制台（入库/问答/图谱/Wiki + IndexingStrategy 四开关面板）——纯表现层，只调各模块公开接口，无任何业务逻辑
目录: webui/

### 公开接口

- `main() -> None` — Streamlit 多页入口（四页导航，阶段 13 整合为统一控制台；此前各阶段"当前那一页先长出来"）

### 依赖

- 模块: `ingest`、`qa`、`graph`、`wiki`、`store`（store 仅用于列表/配置类只读查询：文档列表、chunk 列表、四开关状态、ExtractConfig）、`retrieval`（阶段 2 起：检索试验台直调 bm25_search 等查询面——只读展示检索中间态，不编排；L0 2026-09-10 裁决，裁决理由：试验台是检索结果的观察窗，经 qa 转发只会造浅接口）
- 外部: Streamlit（技术栈点名框架，PRD §0.2-2）

### Seam 与测试

- Seam: 页面层不单元测试（学习项目 UI 为观察窗）；可测性下沉到各业务模块的公开接口（上方各卡测试计划）
- Adapter: 无
- 测试计划: smoke 级——`main()` 可 import 且四页函数存在；页面可观察变化由用户逐阶段亲手验证（learn-by-rebuild 纪律），不进 CI

## 边界规则

| 禁止 | 例外 | 理由 |
|---|---|---|
| 业务模块（`ingest`/`retrieval`/`graph`/`wiki`/`qa`/`webui`）直连厂商 LLM SDK 或自行发起 LLM/embedding HTTP 调用（只许走 `llm_gateway` 公开接口） | （无） | — |
| 业务模块直接读写 SQLite / 构造 SQL（只许走 `store` 公开接口） | （无） | — |
| 任何业务模块 import `webui`（webui 是叶子表现层，依赖方向只许向下） | （无） | — |
| 任何模块绕过包根直引其他模块内部子模块（如 `from store.xxx import ...`；只许 `import store` / `from store import X` 走 `__init__.py` 公开面） | （无） | — |
| `llm_gateway` / `store` 依赖任何业务模块（叶子模块禁反向依赖，防循环与关注点倒灌） | （无） | — |
| 业务/演示代码调用 `llm_gateway.use_fake_backend`（fake stub 只许测试路径；演示用 stub = 作弊，PRD §0.3-1） | `tests/` 目录 | CI 不花钱不抖动的结构保证（PRD §0.2-3）；tests/ 被 check_boundaries.py 跳过，由 code review 与本条文档约束 |
| 引入现成算法库顶替手写实现（rank_bm25 / sklearn / faiss / networkx 等） | （无） | — |

## 页面映射

| 页面 | 数据需求 | 提供接口(模块) |
|---|---|---|
| 入库页 | 文档列表、chunk 列表（含父块扩展） | `store` list_documents / list_chunks |
| 入库页 | 四开关当前状态读取与修改（需要新采集：IndexingStrategy 配置存储） | `store` get_strategy / set_strategy |
| 入库页 | 上传文件触发解析/分块/索引管线、重新入库 | `ingest` ingest_file / reingest_document |
| 问答页 | 关键词检索试验台（阶段 2 先行：BM25 带分排序展示；阶段 4 长成双路对照视图） | `retrieval` bm25_search |
| 问答页 | 双路召回结果与 RRF 融合分对比视图（需要新查询面：检索函数返回中间态） | `qa` ask(...).trace（SearchTrace 中间态，由 `retrieval` hybrid_search 产出） |
| 问答页 | 带引用来源编号的回答、命中 chunk 的来源信息 | `qa` ask(...).text / .citations |
| 问答页 | 图谱关系链并行汇入上下文的前后对比 | `qa` ask(..., use_graph=...).graph_hits |
| 图谱页 | 实体表、关系表（按实体/按 KB 过滤） | `graph` list_entities / list_relations |
| 图谱页 | 按实体查关系链（SearchNode 查询面） | `graph` search_node |
| 图谱页 | ExtractConfig（schema）查看与配置 | `store` get_extract_config / set_extract_config |
| Wiki 页 | Wiki 页 Markdown 渲染、交叉链接跳转、入口页 | `wiki` get_page / list_pages / index_page |
| Wiki 页 | revision 版本列表、一键回滚 | `wiki` list_revisions / rollback |
| Wiki 页 | 触发重写生成（页内按钮） | `wiki` regenerate |

> 说明：逐行覆盖 PRD「逐页数据需求」表全部四页；第 3 列反引号模块名为机检锚点。

## 过审决策点（主窗口带用户逐条确认）

1. **8 模块边界**：两个叶子（`llm_gateway`/`store`）+ 三管线（`retrieval`/`graph`/`wiki`）+ 两编排（`ingest` 入库分发 / `qa` 查询编排）+ 表现层（`webui`）。
2. **索引写入面归 retrieval**：ingest 不知道向量/倒排怎么建，只按开关调用——四开关分发逻辑（对位 WeKnora post_process 枢纽）是 ingest 的核心职责。
3. **共享 dataclass 由 store 导出**：类型跟唯一事实源走，不立独立 types 模块。
4. **SearchTrace 中间态进公开接口**：问答页对比视图不是 UI 私货，是检索的正式查询面（PRD 标注的"需要新查询面"在此闭环）。
5. **webui 可只读直连 store**：列表类查询不经过业务模块转发（转发只会造出浅接口）；写操作一律走 ingest/qa/wiki。
6. **椒图 M3 接入预留（v1.1 变更，ADR 0002）**：`llm_gateway` 保持 OpenAI 兼容 + base_url 可配 = 唯一接入面；建设期不依赖椒图在线；防御分工=跨界椒图守/界内本项目守（PRD §6.3）。2026-09-10 用户拍板。
