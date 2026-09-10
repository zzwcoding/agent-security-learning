# 第一幕 · RAG 基础层（rag-core）

状态: 已定稿
来源: `docs/prd.md` §3 第一幕（学习阶段 1–6）+ §5 量级 + §0.2 硬约束；模块接口真源 `specs/modules.md`
定稿: 2026-09-10 主窗口核审通过（三项落位决定照准：重叠+父子分块归阶段 5；KB 创建走种子脚本；INV-1 哨兵测试先行落位票 0005 起受力）

## 目标

让学习者在本机跑通 RAG 主链路最小闭环：txt 文档入库分块 → 手写 BM25 / 稠密向量双路检索 → RRF 融合 + 教学版重排 → 上下文增强 → 带引用来源标记的 LLM 问答，每一环都有页面可观察变化（书 3.2 / 3.5 / 3.4）。

## 不做什么

- PDF 解析不进阶段 1（pymupdf 扩充为独立票 0007）；docreader 六引擎整体不含（PRD §1.2-7）
- 阶段 1 不做重叠分块、父子分块；重叠（10%）与父子分块随阶段 5 一并引入（同属 chunk 上下文机制，且阶段 6 父块扩展注入依赖之——PRD §3 阶段 5 行未显式点名，此处为本 spec 的落位决定）
- 不做 ANN / 索引结构（numpy 暴力全扫即教学正确版，PRD §5）
- 不做真正跨编码器重排模型（LLM 逐一打分的教学版平替，PRD §8.2）；不引入新模型依赖
- 不做 LLM 生成前缀摘要（书 3.5 原版；用标题+面包屑平替，差距进对账报告）
- 不做多轮对话、会话管理
- 不调现成算法库（rank_bm25 / sklearn / faiss 等，PRD §0.2-2 调包红线）
- IndexingStrategy 四开关面板属阶段 13，本幕不动；graph / wiki 两管线本幕不触及

## 触及的模块

| 模块 | 改动类型 | 说明 |
|---|---|---|
| ingest | 新增 | 解析（txt 内置）+ 固定分块（阶段 5 扩为重叠+父子+ContextHeader）+ 入库；阶段 1 不分发图谱/Wiki |
| store | 新增 | SQLite 建库、KB/文档/chunk 表、向量投影 blob 存取 |
| retrieval | 新增 | BM25 倒排、numpy 余弦、RRF(k=60)、LLM 教学版重排、`SearchTrace` 中间态 |
| qa | 新增 | 检索→参考资料注入→LLM 生成带引用编号回答 |
| llm_gateway | 新增 | GLM chat/embed 真实后端 + fake stub；配置面 base_url 可配（ADR 0002 椒图预留） |
| webui | 新增 | 入库页先行（阶段 1 起），问答页阶段 4 起渐进长成 |

> 接口真源在 `specs/modules.md` 八张卡；本 spec 验收全部落在卡内既有签名上，无改卡需求（接口缺口见末节：无）。

## 接口定义

本幕消费的公开接口（逐条引自 `specs/modules.md`，不一致以卡为准）：

- `llm_gateway`：`chat(messages, *, temperature=0.2) -> str`、`embed(texts) -> list[list[float]]`、`backend_name() -> str`；配置面：base_url / api_key / 模型名走环境变量，OpenAI 兼容请求结构（ADR 0002）
- `store`：`init_db(path)`、`create_kb(name) -> int`、`create_document(kb_id, filename, fmt) -> int`、`get_document(doc_id)`、`list_documents(kb_id)`、`set_document_status(doc_id, status)`、`replace_chunks(doc_id, chunks)`、`list_chunks(doc_id)`、`list_child_chunks(kb_id)`、`get_chunk(chunk_id)`、`save_embeddings(kb_id, items)`、`load_embeddings(kb_id)`；共享 dataclass `Document` / `Chunk`（含 parent_id、ContextHeader）
- `retrieval`：`index_chunks(kb_id) -> int`、`bm25_search(kb_id, query, top_k=10)`、`vector_search(kb_id, query, top_k=10)`、`hybrid_search(kb_id, query, top_k=10, *, rerank=True) -> SearchTrace`、`expand_to_parent(chunks)`；`ScoredChunk` / `SearchTrace`（含 `bm25_hits` / `vector_hits` / `fused` / `reranked` 四份中间态）
- `qa`：`ask(kb_id, question, *, top_k=5, use_graph=True) -> Answer`（`text` 带 [N] 引用编号、`citations`、`trace`、`graph_hits`）；本幕 `use_graph` 恒 `False`（图谱管线属第二幕），但签名本幕即按卡落地
- `ingest`：`ingest_file(kb_id, path) -> int`、`reingest_document(doc_id)`、`parse_file(path) -> str`
- `webui`：`main()`

## 行为约定

**入库（阶段 1）**

1. `ingest_file` 对 txt：内置解析 → 固定 512 token 分块（无重叠、无父子）→ `store.replace_chunks` → 返回 doc_id；页面列表展示文档与 chunk。
2. `reingest_document` 幂等：重入库不产生重复 chunk、不留孤儿投影（`INV-2` 前置条件——chunk 表是唯一事实源）。
3. 解析失败（非 txt / 文件损坏）抛 `ParseError` 由调用方置文档失败态，不阻塞其他文档（PRD §7-⑨）。

**BM25（阶段 2，书 3.2 稀疏嵌入；WeKnora 锚点 `internal/application/service/knowledgebase_search_fusion.go` 稀疏路）**

4. 手写倒排索引 + BM25 完整公式：IDF、词频饱和 k1、长度归一化 b 三项真算，不调用任何现成库。
5. 任何检索路径的结果集合不含父块（`INV-1`）。

**稠密向量（阶段 3，书 3.2 稠密嵌入；WeKnora 锚点 `knowledge_process.go:283` embedding 写入）**

6. embedding 只经 `llm_gateway.embed` 批量获取，业务代码不直连厂商 SDK（PRD §0.2-3）。
7. 余弦相似度用 numpy 手写，暴力全扫（3000 chunk × 2048 维 ≈ 25MB，单次 <100ms，PRD §5）。

**混合检索（阶段 4，书 3.2 三阶段；WeKnora 锚点 `knowledgebase_search_fusion.go` 加权 RRF）**

8. 两路并行召回 → RRF(k=60) 融合 → 重排对融合后 top-N 由 LLM 逐一打分（教学版跨编码器平替，PRD §8.2）。
9. `hybrid_search` 返回 `SearchTrace` 四份中间态齐全，页面渲染对比视图；`rerank=False` 时结果即 `fused` 序。

**上下文增强（阶段 5，书 3.5；WeKnora 锚点 `EmbeddingContent()` + `buildKnowledgeIndexContent`，`knowledge_process.go:283` 内）**

10. 分块升级为 512 token + 10% 重叠 + 父子分块；每个子块携带 ContextHeader（标题+面包屑）。
11. 建索引时 embedding 输入与倒排文档均为 ContextHeader+正文；页面提供有/无前缀对照视图（书 3.5 原文口径："结合 BM25 可将检索失败率降低 49%，再结合重排序器降幅达 67%"）。
12. 父块只入库不进任何索引（`INV-1`）；命中子块经 `expand_to_parent` 取父块上下文。

**RAG 问答（阶段 6，书 3.2 检索-生成 + 3.4 安全边界；WeKnora 锚点 `chat_pipeline/references.go` 引用别名、分发枢纽 `knowledge_post_process.go`）**

13. `ask` = 检索 → 命中子块扩展父块 → 以"参考资料"角色标记注入（指令与数据分离，书 3.4 第一层防御，PRD §6.2-1）→ LLM 生成带 [N] 引用编号的回答。
14. 每个引用编号可回溯到真实 chunk 及其文档名（可追溯，PRD §7 Agent 加问）。
15. `Answer.trace` 透传 `SearchTrace`，问答页对比视图不另开查询面。

**gateway 配置面（ADR 0002 椒图预留）**

16. `llm_gateway` base_url / api_key / 模型名走环境变量；base_url 默认智谱端点，改指向椒图网关即完成"阶段一收口"（零代码，OpenAI 兼容）；fake stub 只许测试路径调用（边界规则第 6 条）。

## 验收测试

| 验收标准 | 对应测试 |
|---|---|
| 具名 fixture `fixture_2000tokens.txt` 经 `ingest_file` 入库后，每个 chunk ≤512 token 且 chunk 数 = ⌈2000/512⌉ = 4（阶段 1，书 3.2 分块为什么必须） | `test_chunk_fixed_size_512` |
| 同一文件 `reingest_document` 两次后 chunk 总数与首次一致、无重复 chunk 无孤儿投影（`INV-2`） | `test_reingest_idempotent_chunks` |
| 具名 fixture `fixture_corrupted.bin`（非 txt）入库：文档置失败态，其余文档正常入库不阻塞（PRD §7-⑨） | `test_parse_failure_marks_document_failed` |
| 入库页冒烟：Streamlit `main()` 可 import 且入库页函数存在（阶段 1 页面可观察变化进 CI 的最小面） | `test_webui_smoke_ingest_page` |
| BM25 IDF 手算对照：3 文档具名语料 fixture 下 `bm25_search` 的 IDF 分量与手算值逐项相等（书 3.2 稀疏嵌入） | `test_bm25_idf_formula` |
| BM25 词频饱和手算对照：同一词在 doc A 出现 1 次 / doc B 出现 5 次，k1=1.2 下两文档 TF 分量与手算值相等且非线性（边际递减） | `test_bm25_tf_saturation_k1` |
| BM25 长度归一化手算对照：同词频、长度差 4 倍的两文档，b=0.75 下长文档得分低于短文档且数值与手算一致 | `test_bm25_length_norm_b` |
| `bm25_search` 结果集合不含任何父块（`INV-1`） | `test_bm25_results_no_parent_chunks` |
| 余弦相似度 numpy 手写：方向相同、模长差 10 倍的两向量得分相等（书 3.2"余弦看方向不看长度"），与 numpy 公式手算值一致 | `test_cosine_direction_not_magnitude` |
| fake stub 手工构造向量下 `vector_search` 对同义查询命中语义近邻（kitty→cat 教学例，书 3.2 稠密嵌入） | `test_vector_search_synonym_hit` |
| `llm_gateway.embed` 批量调用：fake 后端返回向量数=输入文本数、维度=配置维度（默认 2048），真实/fake 两后端签名与返回形状一致 | `test_embed_batch_shape` |
| `vector_search` 结果集合不含任何父块（`INV-1`） | `test_vector_results_no_parent_chunks` |
| RRF(k=60) 融合手算对照：给定两路各 top-3 名次 fixture，`fused` 的融合分与名次与手算 Σ1/(60+rank) 完全一致 | `test_rrf_fusion_rank_handcalc` |
| `hybrid_search` 返回 `SearchTrace` 四份中间态（bm25_hits/vector_hits/fused/reranked）齐全且 fused 名次=两路名次的 RRF 结果 | `test_search_trace_intermediate_states` |
| 教学版重排：fake gateway 打分注入下 top-N 顺序按 LLM 分翻转，且打分提示词逐候选一次调用（spy 计数=N） | `test_llm_rerank_reorders_topn` |
| `hybrid_search(..., rerank=False)` 结果序与 `fused` 序逐项一致 | `test_hybrid_search_rerank_off` |
| ContextHeader 生成：具名带章节标题 fixture `fixture_headings.txt` 入库后，chunk 的 ContextHeader = 文档标题+所属章节面包屑 | `test_context_header_generation` |
| 建索引时 fake gateway 捕获的 embed 输入文本 = ContextHeader + 正文（非裸正文），书 3.5 上下文感知检索 | `test_embedding_input_includes_header` |
| 有/无前缀对照：同一指代类查询在含 ContextHeader 索引下命中、裸正文索引下落出 top-5（对照视图数据面） | `test_context_header_improves_hit` |
| 倒排索引同样吃前缀：标题词（正文不出现）可经 `bm25_search` 命中该 chunk | `test_bm25_index_includes_header_terms` |
| 重叠分块：具名 fixture 下相邻 chunk 存在 10% token 重叠；父子指针正确且父块不出现在 `list_child_chunks`（`INV-1` 入库侧） | `test_overlap_and_parent_child_chunking` |
| 引用编号可回溯：`ask` 返回 text 中每个 [N] 在 `citations` 有对应项，且对应 chunk 真实存在于 store（含文档名） | `test_citations_resolve_to_chunks` |
| 指令与数据分离：fake gateway 捕获的 messages 中检索内容以"参考资料"角色标记注入，与系统指令分属不同 message（书 3.4 第一层防御，PRD §6.2-1） | `test_reference_role_injection` |
| 父块扩展注入：注入 LLM 的上下文为父块正文而非命中子块原文（`INV-1` 消费侧） | `test_answer_uses_parent_context` |
| `Answer.trace` 透传 `SearchTrace`：与直接调 `hybrid_search` 同参数结果逐项一致（问答页对比视图不另开查询面） | `test_answer_trace_passthrough` |
| gateway 配置面：环境变量改 base_url 后请求发往新端点（fake transport 断言 URL），默认=智谱端点，请求结构 OpenAI 兼容（ADR 0002 椒图预留） | `test_gateway_base_url_configurable` |
| PDF 解析（票 0007）：具名 fixture `fixture_sample.pdf` 经 `parse_file` 返回全文文本且含已知句，pymupdf 真出现在 requirements.txt 且被真调用 | `test_parse_pdf_via_pymupdf` |

## 依赖与风险

- 外部依赖：智谱 GLM API（embedding-3 / glm-4-flash，经 `llm_gateway`；key 走 `agent-key glm` 从 Keychain 取，不落库不进日志）；CI 全程 fake stub 不依赖网络（PRD §0.2-3）。
- 技术栈点名对账：Streamlit（票 0001 入库页）、numpy（票 0003 余弦）、pytest（阶段 0 CI 已在，全票验收落 pytest）、pymupdf（票 0007）。
- 量级：≤50 文档、约 1000–3000 chunk、向量 numpy 暴力扫 <100ms、SQLite 单文件 <500MB（PRD §5）——验收均在此量级内有效，不做超量级承诺。
- 风险：①LLM 教学版重排的真实 API 成本（每查询 N 次调用）——验收与 CI 一律走 fake，真实演示由用户手动；②重叠+父子分块归入阶段 5 为本 spec 落位决定（PRD §3 阶段行未显式点名），若 L0 有不同意见回本节改；③KB 创建入口本幕走种子脚本调 `store.create_kb`（webui 只读直连 store 的卡约定不做写转发），多 KB 管理 UI 属阶段 13 明确不含。

## 接口缺口

无。本幕全部验收落在 `specs/modules.md` 八张卡既有公开签名上。
