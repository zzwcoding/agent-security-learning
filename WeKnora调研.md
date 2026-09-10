# 腾讯 WeKnora 开源项目深度调研报告

> 调研日期:2026-09-10。调研方法:浅克隆官方仓库(Tencent/WeKnora @ commit `1c16db3`,2026-09-10)逐文件阅读真实源码,并辅以 GitHub API 实时数据交叉验证。所有关键论断后附源码文件路径或 URL。除特别注明外,"源码"均指仓库本地克隆 `/tmp/weknora-research` 内的文件。

---

## 〇、一分钟结论

- WeKnora 是腾讯微信团队(微信对话开放平台技术底座)开源的**企业级 RAG 知识库 + ReAct Agent 框架**,2025-07 开源,一年时间做到 **21,967 star**,当前版本 v0.8.0(2026-09-03 发布),当天仍有提交,是同类开源项目里工程化程度最高的一档。
- 它早已不只是一个"RAG 问答系统":**文档解析微服务、事件驱动检索流水线、ReAct Agent 引擎、会话级 Docker/E2B/Cube 沙箱、技能目录、跨会话长期记忆、自动 Wiki 生成、MCP、IM 接入、RBAC 多空间**全部在一个仓库里,Go 主服务约 47 万行。
- 技术选型非常"省心":默认部署只靠 **ParadeDB(PostgreSQL 发行版)一个数据库同时扛业务数据 + BM25 全文检索 + pgvector 向量检索**,不需要独立 Elasticsearch/向量库即可跑起完整混合检索。
- 对本仓库主人(Agent 安全评估方向)的价值:**这是一个把"RAG 安全工程"写进代码里的活样本**——SSRF 三重校验、密钥 AES-256-GCM 加密、沙箱默认拒绝出网、危险工具人机审批、引用别名 fail-closed 展开、`docker.sock` 等于宿主机 root 的显式告警,全部能在源码里找到对应实现,是学习"知识库类 Agent 攻击面"的一手教材。

---

## 一、项目定位与概览

### 1.1 WeKnora 是什么

官方定义(README_CN.md:50-62):WeKnora 是一款开源的、基于大语言模型的知识管理框架,面向**企业级文档理解、语义检索与智能推理**场景,围绕三大核心能力构建:

1. **RAG 快速问答**——基于知识库的检索增强问答;
2. **ReAct Agent 智能推理**——自主编排知识检索、MCP 工具、技能目录、会话级沙箱与网络搜索,完成多步任务;
3. **Wiki 模式**——Agent 从原始文档自治生成相互链接的 Markdown 知识库与可视化知识图谱,支持人工编辑、版本历史与一键回滚。

外加跨会话长期记忆(v0.8.0)、多源数据同步(飞书/GitLab/腾讯 IMA/Notion/语雀/RSS)、网站嵌入 Widget、IM 频道问答等。

**血缘**:WeKnora 是[微信对话开放平台](https://chatbot.weixin.qq.com)的核心技术框架(README_CN.md:275-281),官网 https://weknora.weixin.qq.com。目标用户是要求数据自主可控、私有化部署的企业/团队,以及微信生态内的智能问答运营方。

### 1.2 基本信息

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | https://github.com/Tencent/WeKnora | GitHub |
| 当前版本 | 0.8.0(`VERSION` 文件;CHANGELOG.md 头部) | 源码 |
| License | **MIT** + 第三方组件声明(paddle/playwright/grpc-health 等按 Apache-2.0 附带);GitHub API 因 LICENSE 内嵌第三方许可文本标为 NOASSERTION | `LICENSE`(注意该文件 158KB,不是纯 MIT 文本)、[GitHub API](https://api.github.com/repos/Tencent/WeKnora) |
| 主语言 | Go 1.26.0(`go.mod`);Python(docreader/mcp-server);TypeScript(前端) | `go.mod` |
| Star / Fork | 21,967 / 3,173(2026-09-10 实时) | [GitHub API](https://api.github.com/repos/Tencent/WeKnora) |
| 代码量 | Go 后端 `internal/` 约 47.3 万行;docreader Python 约 1.4 万行;前端 vue/ts 约 23.3 万行(wc -l 统计) | 本地统计 |
| 官方文档站 | 仓库内 `website-docs/`(VitePress,六大板块约 50 篇) | `website-docs/README.md` |

---

## 二、整体架构与服务组成

### 2.1 三进程核心 + 两个基础设施依赖

来源:`website-docs/02-architecture/01-overview.md`、`docker-compose.yml`。

```mermaid
graph LR
    subgraph 客户端
        Browser["浏览器 Vue3 SPA"]
        IM["IM 平台×10"]
        CLI["CLI / Go SDK"]
        MCP["MCP 客户端"]
        Mini["微信小程序"]
    end
    subgraph Docker Compose 核心五件套
        FE["frontend: NGINX+Vue3 :80"]
        APP["app: Go 主服务 :8080<br/>REST+SSE / Agent / Asynq worker"]
        DR["docreader: Python gRPC :50051(仅内网)"]
        PG[("postgres: ParadeDB pg17<br/>业务数据+BM25+pgvector")]
        RD[("redis 7: 任务队列/流管理/限流")]
    end
    subgraph 可选 profile
        NEO[("neo4j 知识图谱")]
        VDB[("qdrant/milvus/weaviate/doris")]
        SX["searxng 联网搜索"]
        MINIO[("minio 对象存储")]
        LF["langfuse 可观测栈"]
    end
    Browser -->|HTTP/SSE| FE -->|反代 /api| APP
    APP -->|gRPC(TLS 可选)| DR
    APP --> PG & RD
    APP -.-> NEO & VDB & SX & MINIO
    APP -.->|trace| LF
    IM & CLI & MCP & Mini --> APP
```

**默认启动服务清单**(docker-compose.yml 逐项核实):

| 服务 | 镜像/构建 | 端口 | 职责 | compose 位置 |
|---|---|---|---|---|
| `frontend` | `wechatopenai/weknora-ui`(frontend/ 多阶段构建) | 宿主 80 | Web UI + NGINX 反代 `/api` 到 app | docker-compose.yml:2-34 |
| `app` | `wechatopenai/weknora-app`(docker/Dockerfile.app,Go) | 8080 | REST API、RAG、Agent 引擎、异步 worker、IM/Embed 渠道 | :36-385 |
| `docreader` | `wechatopenai/weknora-docreader`(Python) | 50051(仅 compose 网络内) | gRPC 文档解析微服务 | :398-503 |
| `postgres` | `paradedb/paradedb:v0.22.2-pg17` | 5432(内网) | 业务数据 + BM25 全文 + pgvector 向量,**默认无需独立向量库** | :521-541 |
| `redis` | redis:7.0-alpine(appendonly + requirepass) | 6379(内网) | Asynq 队列、SSE 流管理、system_settings Pub/Sub、限流、按模型并发闸门 | :542-554 |

**可选组件(profile)**:

| Profile | 组件 | 用途 |
|---|---|---|
| `neo4j` / `full` | neo4j | GraphRAG 知识图谱(开关 `NEO4J_ENABLE`) |
| `minio` / `full` | minio | 对象存储 |
| `searxng` / `full` | searxng(+init) | 自托管元搜索引擎,给 Agent 提供 Web 搜索 |
| `qdrant` / `milvus` / `weaviate` / `doris` | 各向量检索引擎 | `RETRIEVE_DRIVER` 切换 |
| `odl-hybrid` | OpenDataLoader 后端 | PDF 版式分析混合解析(HTTP :5002) |
| `dex` | Dex IdP | OIDC 联调 |
| `langfuse` | langfuse-web/worker/clickhouse/minio/db-init | 自建 LLM 可观测栈 |

**进程间通信**:`app`→`docreader` 走 gRPC(proto 在 `docreader/proto/docreader.proto`,支持 TLS + `GRPC_AUTH_TOKEN`),大文件走流式 `ReadStream`,图片产物经共享卷 `docreader-tmp` 传递;聊天走 SSE;全部链路见 `website-docs/02-architecture/01-overview.md` §3。

### 2.2 后端代码组织(Go)

来源:`internal/` 目录实测。

| 目录 | 职责 |
|---|---|
| `internal/handler/` | HTTP 层(Gin),含 `session/qa.go` 等聊天入口 |
| `internal/application/service/` | 业务服务(知识处理、chat_pipeline、retriever、agent_service 等 100+ 文件) |
| `internal/application/repository/retriever/` | **10 种检索引擎适配**:postgres、elasticsearch、opensearch、milvus、qdrant、weaviate、doris、sqlite、tencentvectordb、neo4j |
| `internal/infrastructure/chunker/` | 分块器(自适应分层策略) |
| `internal/infrastructure/docparser/` | 解析引擎目录(`engines.go` 注册 builtin/simple/anydoc/cloud 等引擎) |
| `internal/agent/` | ReAct 引擎、工具注册表(`tools/` 60+ 文件)、技能、沙箱审批、记忆 |
| `internal/sandbox/` | Docker/E2B/Cube 三后端沙箱运行时(70+ 文件) |
| `internal/models/` | 模型抽象:chat/embedding/rerank/vlm/asr 五类 + `provider/` 27 厂商适配 |
| `internal/im/` | 9 个 IM 平台目录:wechat/wecom/feishu/dingtalk/slack/telegram/qqbot/mattermost/yunzhijia |
| `internal/mcp/`、`internal/stream/`、`internal/llmreference/`、`internal/llmresource/` | MCP 客户端(含 OAuth)、SSE 流管理、引用别名、资源句柄别名 |
| `internal/container/` | uber/dig 依赖注入装配 |

依赖注入用 `go.uber.org/dig`,异步任务用 `hibiken/asynq`(基于 Redis),Web 框架 Gin,ORM GORM——均见 `go.mod` 与 `website-docs/02-architecture/02-backend-design.md`。

---

## 三、文档处理管线

### 3.1 支持的文档格式(以代码为准)

来源:`internal/application/service/knowledge_util.go` 的 `supportedImportFileExtensions`(统一白名单,上传/URL 导入/worker 复检三处共用):

```
pdf txt docx doc epub html htm mhtml md markdown
png jpg jpeg gif csv xlsx xls pptx ppt json
mp3 wav m4a flac ogg
```

外加 v0.8.0 新增的 XMind(`docreader/parser/xmind_parser.py`)与网页 URL 抓取。表格类(csv/xlsx/xls)额外挂"表摘要"任务生成 `table_summary`/`table_column` chunk 用于表格问答(`website-docs/02-architecture/03-document-pipeline.md` §2.1.1)。

### 3.2 解析引擎矩阵(README 声称 vs 代码核实)

| 引擎 | 实现位置 | 能力 | 核实结果 |
|---|---|---|---|
| **builtin**(docreader,默认) | `docreader/parser/`(Python gRPC) | PDF 用 **pypdfium2**(`pdf_parser.py:16` 自述"text extraction + page bitmap",无内嵌 OCR);DOCX 用 python-docx;EPUB(ebooklib);Excel(openpyxl/pandas);HTML(trafilatura);网页(Playwright);MHTML;**PPT/PPTX/CSV 只能走 markitdown**(`registry.py:26-30` 硬编码回退) | 属实 |
| **simple**(Go 原生) | `internal/infrastructure/docparser/builtin_converter.go` | md/txt/csv/json/图片/音频占位,不发 gRPC | 属实 |
| **anydoc**(v0.8.0 新增) | `third_party/anydoc-go/`(cgo 链接 Rust 库) | **Go 进程内**解析 doc/docx/ppt/pptx/xlsx/xls/odf/rtf/epub/csv/pdf,免 docreader 往返;扫描件 PDF 回退 docreader 整页渲染 | 属实(compose 构建参数 `WITH_ANYDOC=1`,docker-compose.yml:19-21) |
| **markitdown** | `docreader/parser/markitdown_parser.py` | 微软 MarkItDown(`markitdown[docx,pdf,xls,xlsx,pptx]>=0.1.3`,见 `docreader/pyproject.toml`) | 属实 |
| **opendataloader** | `docreader/parser/opendataloader_parser.py` + `odl-hybrid` 服务 | PDF **版式分析**(需 Java 11+) | 属实 |
| **mineru / mineru_cloud / paddleocr_vl / paddleocr_vl_cloud / weknoracloud** | `internal/infrastructure/docparser/engines.go` HTTP 转换器 | 高精度/OCR/版式解析云服务 | 属实(按 endpoint 配置判定可用性) |

**OCR 与 VLM 的位置**:docreader 的 Parser 门面自述 "No chunking, no storage, no OCR, no VLM"(`docreader/parser/parser.py:32-34`)——**OCR 和图片描述不在解析器里**,而是 Go 侧按图片粒度入队 `TypeImageMultimodal` 任务(`internal/application/service/image_multimodal.go`):VLM 生成 Caption + OCR 文本,写成 `image_caption`/`image_ocr` 两类**子 chunk 并独立入向量索引**,使"搜图片描述能召回原文块"。这是检索层面多模态融合的一个干净设计。

### 3.3 切片(Chunking)策略

来源:`internal/infrastructure/chunker/strategy.go`、`website-docs/03-features/04-chunking.md`。

- 分块在 **Go 侧**(不是 docreader)完成;策略五档:`auto`(默认,按文档画像自适应选层)/`heading`(按标题层级)/`heuristic`/`recursive`/`legacy`(`strategy.go:19-23`)。
- **父子分块**(parent-child):子块进向量索引,父块只入 DB 供检索命中后回捞上下文(`website-docs/02-architecture/03-document-pipeline.md` §6.5)。
- chunk 带 `StartAt/EndAt`(rune 偏移)+ 标题面包屑(内存态 `ContextHeader`,不落库);**分块可手工编辑且带版本历史**,编辑后自动重建索引——这是 WeKnora 区别于多数 RAG 项目的"知识加工可控"特性(README_CN.md:144)。

### 3.4 入库全流程(异步管道)

来源:`website-docs/02-architecture/03-document-pipeline.md`(与源码逐文件对应,该文档明确列出每个环节的源码位置)。

```
上传/URL/手动 → MD5 去重(knowledge_create.go) → 存储后端落盘(8 种:local/minio/cos/oss/s3/tos/obs/ks3,file/factory.go)
  → Asynq 入队 TypeDocumentProcess(队列 default,MaxRetry 3,超时 30min)
  → 核心 Worker:docreader 解析(gRPC)→ ASR 转写(音频)→ 图片提取转存+SSRF 校验 → Go 分块 → 写 chunks → 批量 Embedding + 向量/BM25 索引(失败补偿回滚)
  → 多模态扇出(每图一任务:OCR+Caption 子 chunk)
  → 后处理编排(knowledge_post_process.go):摘要 ×1 + 问题生成(每 20 chunk 一批)+ 图谱抽取(每 chunk 一任务)+ Wiki 生成,原子计数器 pending_subtasks_count 收敛
  → Housekeeping 每 5 分钟扫僵尸任务(knowledge_housekeeping.go,三重判据:updated_at + span 心跳 + 队列检查)
```

状态机:`pending → processing → finalizing → completed`(失败/取消/删除另有分支)。Worker 池分队列治理:核心 8 / 后处理 2 / 富化 12 / 维护 4(`internal/types/task.go` 默认并发)。**FAQ 类知识库不走解析管线**:每条问答对一个 chunk,支持相似问合并/分离索引、负例问题(反例问不参与索引)、导入归一化去重 SHA256(`knowledge_faq.go`、`knowledge_faq_import.go`)。

### 3.5 知识图谱(GraphRAG)

`NEO4J_ENABLE=true` 开启(默认 false,`.env.example:330`,并注明旧变量 `ENABLE_GRAPH_RAG` 已废弃)。入库时每 chunk 一个 LLM 抽取任务(`TypeChunkExtract`,模板 `config/prompt_templates/graph_extraction.yaml`)抽实体/关系写 Neo4j(`internal/application/repository/retriever/neo4j/repository.go`);查询侧 PluginExtractEntity 抽取查询实体后 `SearchNode` 召回图节点/关系,与向量检索并行合并(见 §4.2)。另有 **Wiki 图谱可视化**(前端 `docs/images/wiki-graph.png`),与 Neo4j GraphRAG 是两回事:前者是 Wiki 页面链接图,后者是实体关系图。

---

## 四、检索与问答链路

### 4.1 检索引擎与混合检索

**引擎映射**(`internal/types/tenant.go:17-57`,硬编码映射表):

| RETRIEVE_DRIVER | 关键词 | 向量 |
|---|---|---|
| `postgres`(默认) | ParadeDB BM25(`paradedb.score(id)`,repository.go:215) | pgvector HNSW(1024 维表达式索引,`SET LOCAL hnsw.ef_search` + `iterative_scan` 调优,repository.go:265-441) |
| `elasticsearch_v7/v8` | v7 仅关键词 / v8 双能力 | ES kNN |
| `opensearch` / `qdrant` / `milvus` / `weaviate` / `doris` / `tencent_vectordb` / `sqlite` | 双能力 | 双能力(sqlite 用 sqlite-vec 扩展,go.mod) |

**混合检索融合**(`internal/application/service/knowledgebase_search*.go`):
- 跨库检索按 **embedding 模型身份**分组(拒绝跨 embedding 空间混检),查询向量只算一次;
- 过召回:`matchCount = max(TopK×5, 50) × KB数`,上限 500;
- 向量 + 关键词双路结果用**加权 RRF** 融合:`score = vectorWeight/(k+rank) + keywordWeight/(k+keywordRank)`(`knowledgebase_search_fusion.go:80-120`,k 与权重来自租户 RetrievalConfig);
- FAQ 库支持迭代扩检(最多 5 轮翻倍)与负例问题精确过滤。

### 4.2 RAG 问答流水线(事件驱动插件架构)

来源:`website-docs/02-architecture/04-rag-pipeline.md` + `internal/application/service/chat_pipeline/`(源码逐一对应)。

RAG 请求被组装成一条 **EventType 链**,每个阶段是一个实现 `Plugin` 接口的插件,责任链串联(`chat_pipeline.go`):

```
LOAD_HISTORY → QUERY_UNDERSTAND → CHUNK_SEARCH_PARALLEL → CHUNK_RERANK
  → [WEB_FETCH] → CHUNK_MERGE → FILTER_TOP_K → [DATA_ANALYSIS] → INTO_CHAT_MESSAGE → CHAT_COMPLETION_STREAM
```

各阶段亮点(均有对应源码文件):

| 阶段 | 实现要点 | 源码 |
|---|---|---|
| QUERY_UNDERSTAND | LLM 改写 + **意图分类**(kb_search/web_search/greeting/chitchat/follow_up/image_only/doc_only/summarize/clarification),非检索意图直接跳过全链检索;输出 JSON 容错解析 | `query_understand.go`,模板 `config/prompt_templates/rewrite.yaml` |
| CHUNK_SEARCH_PARALLEL | chunk 检索与 Neo4j 实体检索 **Clone 后并发**;召回不足触发**无 LLM 的本地查询扩展**(jieba 分词生成变体,信号量 16 并发) | `search_parallel.go`、`query_expansion.go` |
| CHUNK_RERANK | passage 清洗(脱 Markdown 语法但保留代码/公式正文)→ Rerank 模型打分 → 阈值过滤/降级/top1 兜底 → **复合分 0.6×模型 + 0.3×检索基础 + 0.1×来源** → FAQ 加权 → **MMR 多样性选择(λ=0.7)** → PluginWikiBoost 后置 ×1.3 | `rerank.go`(720 行)、`wiki_boost.go` |
| CHUNK_MERGE | 八步融合:历史引用注入(Jaccard 0.15 阈值,打 0.6 折)→ 父子块回捞 → 分组顺序合并 → FAQ 答案填充 → 短块邻居扩展(350→850 字符)→ 二次去重 | `merge.go` 及 merge_*.go 五个文件 |
| INTO_CHAT_MESSAGE | 上下文模板渲染,`utils.ValidateInput` 校验查询(注入防护);FAQ 优先分节;渲染后内容异步回写审计 | `into_chat_message.go` |
| CHAT_COMPLETION_STREAM | SSE 流式;thinking/answer 双通道;**引用先行**(`references` 事件先于答案推送) | `chat_completion_stream.go` |

**检索无结果**触发兜底策略(固定文案 or 模型自由回答),而不是报错(`handleFallbackResponse`)。

### 4.3 流式输出与引用

- **StreamManager**(append-only 事件流,memory/redis 双实现,`internal/stream/factory.go`):生成 goroutine 与 SSE 连接完全解耦,100ms 轮询推送;断线后 `GET /sessions/continue-stream/:id` 从 offset 0 **重放全部事件再续推**——刷新页面不中断生成。SSE 事件类型全集见 `internal/types/chat.go`(thinking/answer/references/tool_call/tool_approval_*/mcp_oauth_*/complete 等 15 种)。
- **引用机制**(`internal/llmreference/registry.go`):模型上下文里不出现内部 ID,只给低熵别名 `cN`(chunk)/`wN`(网页);要求模型输出 `ref id="cN"` 自闭合标签,流式 `StreamExpander` 展开成携带 chunk_id/knowledge_id 的公开标签,**未知别名 fail-closed 直接删除**。`internal/llmresource/` 把 `minio://`、`cos://` 等高熵存储句柄替换为 `res://0001` 别名,防止模型复述时篡改 URL。

---

## 五、模型接入

### 5.1 模型类型与厂商

模型按五类抽象(`internal/models/` 子目录):**chat / embedding / rerank / vlm / asr**。厂商适配在 `internal/models/provider/provider.go:15-101` 硬编码注册表,共 **27 个 provider**:

> openai、anthropic、aliyun(DashScope/Qwen)、zhipu(智谱)、openrouter、**litellm**(v0.8.0 新增,一个网关接 100+ 上游)、requesty、siliconflow、jina、**generic**(任意 OpenAI 兼容端点)、deepseek、gemini、volcengine(豆包/火山)、hunyuan(混元)、minimax、mimo(小米)、gpustack(私有化)、moonshot(Kimi)、modelscope(魔搭)、qianfan(百度)、qiniu、longcat(美团)、lkeap(腾讯云)、nvidia、novita、azure_openai、weknoracloud(官方托管)

另有独立的 **Ollama 原生客户端**(`internal/models/chat/ollama.go`,README_CN.md:227 指引用 `ollama serve` 配合)。

- **本地模型**:Ollama 直连;vLLM/GPUStack 等**没有专门适配器**,走 `generic` OpenAI 兼容端点或 LiteLLM 网关接入(源码中未找到 vLLM 专有集成,如此表述以源码为准)。
- 配置方式:租户级模型管理 API + **YAML 声明式内置模型**(`config/builtin_models.yaml.example`,挂进容器只读生效,docker-compose.yml:56-58)。
- 工程细节:`provider.DetectProvider()` 按 BaseURL 自动识别厂商(provider.go:225-285);按模型并发闸门(Redis 信号量)、Prompt Cache 标记(Anthropic/OpenAI 兼容)、per-turn token 用量归账(`internal/models/chat/prompt_cache.go`、`usage.go`)。

### 5.2 网络搜索与 MCP

- **Web 搜索 11 种**:DuckDuckGo/Bing/Google/Tavily/Baidu/Ollama/SearXNG/Keenable/智谱/Exa/Metaso(`internal/infrastructure/web_search/`,README_CN.md:164);SearXNG 可 compose 自托管(127.0.0.1:8888)。
- **MCP 客户端**(`internal/mcp/`,mark3labs/mcp-go v0.52.0):远程 MCP 工具接入 Agent,支持 **OAuth2 授权、会话内 OAuth、危险工具人机审批**(`internal/agent/approval/gate.go`、SSE 事件 `tool_approval_required`);内置 MCP 服务管理员统一配置、敏感字段脱敏只读(`docs/BUILTIN_MCP_SERVICES.md`)。

---

## 六、部署与运维

### 6.1 Docker Compose 一键部署

README_CN.md:215-263(与 compose 文件核实一致):

```bash
cp .env.example .env && docker compose pull && docker compose up -d
# 访问 http://localhost(Web UI),API 在 :8080,Langfuse :3000
```

- `.env.example` 达 42KB(约 150 个环境变量,website-docs 自述),分组涵盖日志、存储、模型、检索驱动、沙箱、安全;
- 部署形态五档:**Docker Compose / Lite 单二进制 / Kubernetes(Helm)/ 裸机 systemd(deploy/)/ macOS Homebrew(Formula/)**,另有 Wails 桌面版(`cmd/desktop`)与微信小程序(`miniprogram/`)。
- **Lite 模式**(`docs/LITE.md`):`DB_DRIVER=sqlite`(内置 sqlite-vec)+ 不配 Redis(Asynq 退化进程内执行),零外部依赖、免注册单空间、前端静态资源内嵌进 Go 二进制——个人本机试用的最短路径。

### 6.2 资源要求与运维能力

- **最低资源要求:未在源码/文档中找到明确数字**(README、website-docs 均未声明最低 CPU/内存;仅 `.env.example` 有并发/池大小等调节项)。此条如实标注。
- 运维特性:启动自动数据库迁移(`AUTO_MIGRATE`,`migrations/versioned/*.up.sql`);运行时任务队列观测面板 + Worker 池治理(队列深度/按模型并发/失败重试);Housekeeping 僵尸任务自愈;日志 request_id 贯穿 + lumberjack 轮转;`weknora` CLI 约 30 个子命令(部署/日志/备份/诊断,`cli/`)。
- 可观测:Langfuse 为唯一追踪后端(v0.6.2 移除 Jaeger),LLM 调用级 trace + 文档解析 Span 时间线(`internal/tracing/langfuse`、`docs/Langfuse集成.md`)。

---

## 七、API 与二次开发

| 通道 | 说明 | 来源 |
|---|---|---|
| REST API | 约 360 个端点(官方文档站口径);Swagger OpenAPI 文件在 `docs/api/swagger.json`;非 release 模式暴露 `/swagger`(swaggo) | `docs/api/`、`website-docs/04-api/` |
| 认证 | JWT Bearer / X-API-Key / OIDC 三态;**权限范围 API Key**(能力级授权 + 按 KB 限制)+ Principal 模型 + 集成调试台 | `website-docs/03-features/01-tenant-auth.md` |
| MCP Server | Python 实现,**官方 PyPI 包 `tencent-weknora-mcp`**,stdio/SSE/HTTP 三种传输,把 WeKnora API 封装成工具(hybrid_search、create_knowledge_*、chat、agent_chat、wiki_* 等) | `mcp-server/weknora_mcp_server.py` |
| Go SDK | `client/` 目录,HTTP 客户端封装 | 源码 |
| CLI | `weknora` 命令行(约 30 子命令) | `cli/` |
| 深度集成 | DeepSeek Harness 插件 `@wxg-prc-cpg/dsh-weknora`(4 个只读检索工具);ClawHub Skill;Chrome 插件(网页采集) | `packages/dsh-weknora/`、README_CN.md:199-207 |
| IM 渠道 | 10 个平台:企业微信/飞书/Lark/QQBot/Slack/Telegram/钉钉/Mattermost/微信/云之家(`internal/im/` 9 个平台目录,feishu 目录覆盖 Lark) | 源码 |
| 嵌入 Widget | 网站嵌入,域名白名单 + 限流 + 安全模式 Token 交换(`embed-secure-mode.md`) | docs/ |
| Agent Skills | 空间技能目录,从 ClawHub/SkillHub/git/zip 安装,快照化,沙箱内执行;示例 `examples/skills/` | `internal/agent/skills/` |

**二次开发的现实评价**:API 面非常宽(360 端点 + MCP + SDK + CLI + 嵌入),文档站 `website-docs/` 质量罕见地高——每个架构文档末尾都有"实现参考"表把功能映射到源码文件,二次开发定位代码的成本很低。

---

## 八、项目成熟度与社区

数据获取时间:2026-09-10,GitHub API([repos endpoint](https://api.github.com/repos/Tencent/WeKnora)、[releases endpoint](https://api.github.com/repos/Tencent/WeKnora/releases))。

| 指标 | 值 | 解读 |
|---|---|---|
| Star / Fork | 21,967 / 3,173 | 一年(2025-07-22 创建)破 2 万,增长极快 |
| 最近推送 | 2026-09-10(调研当天) | 高频维护,浅克隆单日即有新提交 |
| Release 节奏 | v0.6.3(06-26)→ v0.7.0(07-17)→ v0.7.1(07-24)→ v0.7.2(08-07)→ v0.8.0(09-03) | 约每 2-4 周一个 minor/patch |
| Open issues | 703 | 社区活跃但 issue 积压不小(体量大、功能多) |
| 贡献者 | 约 222(含匿名,GitHub contributors API 分页推算) | 超出典型公司主导项目 |
| CHANGELOG | 15.5 万字级,逐项列出 migration 编号与 issue 号 | 工程纪律严格 |
| 文档 | README 四语(EN/中/日/韩)+ 50 篇文档站 + 30+ 篇 docs/ | 少数"文档比代码还好读"的开源 AI 项目 |
| 安全声明 | 官方明确建议内网部署、勿暴露公网(v0.1.3 起有登录鉴权) | README_CN.md:352-359 |
| 版本状态 | 0.8.0,**仍是 0.x** | API 可能变动,生产采用需锁版本 |

**README 与代码的不一致点(交叉验证发现)**:
1. README_CN.md:166 称 MCP Server "29 个工具",实际代码 `@mcp.tool` 计数 **33 个**(29 是 v0.7.2 时期的数字,README 功能表未随代码更新);
2. LICENSE 文件内嵌第三方许可全文导致 GitHub API 标 NOASSERTION,实际项目本体是 MIT(文件头部声明)——使用方需自行分辨;
3. `docs/` 下部分早期文档已过时,`website-docs/01-overview.md:202` 自己也标注"docs/: 早期文档,部分内容已过时"——查文档以 website-docs 为准。

---

## 九、与"安全评估 / Agent 学习"的关联点

WeKnora 对本仓库(Agent 安全评估学习)是一个**难得的全链路攻击面样本**:它同时具备 RAG 知识库、工具调用 Agent、代码执行沙箱、MCP、IM 入口、对外嵌入六类暴露面,而且防御措施大多可读到源码级细节。

### 9.1 天然的 RAG 攻击面(可做评估实验的靶点)

| 风险类别 | WeKnora 的暴露点 | 源码证据 |
|---|---|---|
| **知识投毒 / 检索注入** | 文档内容(含外部 URL 抓取、飞书/GitLab/Notion/RSS 同步)直接进向量索引与 BM25,再被拼进 prompt(`INTO_CHAT_MESSAGE` 的 ContextTemplate)——投毒文档=持久化注入;分块可编辑 + API 可写(create_knowledge_from_text)扩大了投毒面 | `chat_pipeline/into_chat_message.go`、`mcp-server/weknora_mcp_server.py:763` |
| **越权召回** | 跨库检索按 KB 授权逐库 `authorizeKBAccess`,但"检索上下文注入 prompt 后"的边界完全交给模型;权限范围 API Key 的"按 KB 限制"是否覆盖 Agent 工具的间接读取路径,值得审 | `knowledgebase_search.go`(授权在检索入口)、`website-docs/03-features/01-tenant-auth.md` |
| **间接提示注入→工具升级** | RAG 结果与 Web 搜索结果都进入 Agent 上下文;Agent 持有 shell_exec/文件写/wiki 写/MCP 工具——被注入内容若诱导调用工具,防御依赖审批 gate 与沙箱 egress 策略 | `internal/agent/tools/shell_exec.go`、`internal/agent/approval/gate.go` |
| **SSRF(文档管道特色)** | URL 导入/网页抓取/远程图片转存三处都有 `ValidateURLForSSRF`,Handler + Service + Worker **三重防线防 TOCTOU**(`website-docs/02-architecture/03-document-pipeline.md` §2.2);白名单 `SSRF_WHITELIST_EXTRA` 默认放行 compose 内组件 | `internal/utils/security.go:1200` |
| **沙箱逃逸面** | Docker 后端挂 `docker.sock` 等于宿主机 root——官方在 compose 注释里直接写明并**默认关闭、管理员显式开启**(docker-compose.yml:44-48);exec 以 uid 1000 运行,关闭 symlink chown 逃逸;egress 默认拒绝 | CHANGELOG.md v0.8.0 Sandbox security 条目、`internal/sandbox/url_guard.go` |

### 9.2 值得精读的"防御工程"代码

- **引用别名 fail-closed**(`internal/llmreference/`):模型输出未知引用别名直接删除而不是猜测——防"伪造引用";资源句柄别名(`internal/llmresource/`)防模型复述篡改存储 URL。
- **危险工具审批流**(`internal/agent/approval/tool_policy.go` + SSE `tool_approval_required` 事件):MCP 危险工具人机审批的完整工程实现,可直接作为"工具治理"参考。
- **输入校验的真实水位**(`internal/utils/security.go:81-106`):`ValidateInput` 只查控制字符/UTF-8/XSS 正则——**它防的是格式层攻击,不是语义层提示注入**。这本身就是很好的教学素材:代码里叫"注入防护"的函数和提示注入防御是两回事,评估时不要混为一谈。
- **密钥工程**:API Key/MCP/数据源凭据 AES-256-GCM 静态加密 + 轮换、响应脱敏、技能环境变量"只注入不回读"(CHANGELOG v0.8.0),测试文件即安全需求清单(`internal/handler/tenant_secret_disclosure_test.go` 等)。
- **与既有调研的衔接**:《沙箱机制与传统安全业务选型调研.md》的"不跑不可信代码,只处理不可信数据"原则,在 WeKnora 的设计里能找到镜像——文档解析(docreader 独立容器、解析器 0day 爆炸限损在解析容器内)与代码执行(会话级沙箱)严格分离。

**建议的下一步**:以本仓库为靶场做三类实验——(1) 知识投毒后检索命中的注入成功率(改分块 API 投毒→观察 RAG 回答);(2) MCP 危险工具审批绕过尝试;(3) URL 导入 SSRF 三重校验的绕过(TOCTOU 防线的实证检验)。三者都有明确源码入口可对照。

---

## 十、参考来源清单

**一手来源(源码,本地克隆 /tmp/weknora-research @ 1c16db3)**:
1. `README_CN.md` / `README.md` — 项目定位、功能表、部署指引
2. `docker-compose.yml` / `.env.example` / `docker/Dockerfile.*` — 服务组成、端口、profile
3. `go.mod` / `VERSION` / `LICENSE` / `THIRD_PARTY_NOTICES.md` — 技术栈与许可
4. `website-docs/02-architecture/01-overview.md`(总体架构)、`02-backend-design.md`、`03-document-pipeline.md`(入库管线)、`04-rag-pipeline.md`(检索问答)、`05-async-tasks.md`
5. `internal/types/tenant.go`(检索驱动映射)、`internal/application/repository/retriever/postgres/repository.go`(BM25+HNSW)、`internal/application/service/knowledgebase_search_fusion.go`(RRF)
6. `internal/application/service/chat_pipeline/`(插件流水线)、`internal/agent/engine.go` + `internal/agent/tools/definitions.go`(ReAct 引擎与工具)
7. `internal/models/provider/provider.go`(27 厂商注册表)、`internal/models/chat/ollama.go`
8. `docreader/pyproject.toml`、`docreader/parser/parser.py`、`registry.py`、`pdf_parser.py`、`docreader/proto/docreader.proto`
9. `mcp-server/weknora_mcp_server.py`(33 工具)、`internal/agent/approval/`、`internal/utils/security.go`
10. `internal/sandbox/`(Docker/E2B/Cube 运行时)、`docs/LITE.md`、`docs/BUILTIN_MCP_SERVICES.md`、`CHANGELOG.md`
11. `frontend/package.json`、`frontend/src/`、`miniprogram/`、`cli/`、`client/`、`packages/dsh-weknora/`

**二手来源(实时 API)**:
12. [GitHub API: repos/Tencent/WeKnora](https://api.github.com/repos/Tencent/WeKnora) — star/fork/创建时间/推送时间/license 标记(2026-09-10 查询)
13. [GitHub API: releases](https://api.github.com/repos/Tencent/WeKnora/releases) — v0.8.0~v0.6.3 发布时间线
14. [GitHub API: contributors](https://api.github.com/repos/Tencent/WeKnora/contributors) — 贡献者规模
15. 官网 https://weknora.weixin.qq.com 、微信对话开放平台 https://chatbot.weixin.qq.com(README_CN.md 引用)

**未找到一手信息的问题**:最低硬件资源要求(CPU/内存)未在 README/docs/compose 中声明;vLLM 无专门适配器(仅可经 OpenAI 兼容接口/LiteLLM 接入),报告中已如实标注。
