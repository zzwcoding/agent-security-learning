# 17: m7 知识沉淀 + chroma 检索面

**What to build:** 案件关闭 → 提炼 KBEntry 草稿（proposed）→ kb_write L2 人审闸 → approved 进 chroma 检索面。kb/proposals REST 挂 m2。驳回后检索面确定性查不到。

**Blocked by:** 03, 11, 13, 23

**Touches modules:** `m2`, `m7`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 提炼子图产出 KBEntry 草稿 proposed（kind/title/body/tags）（源：m7 卡职责·PRD §5.10）
- [x] kb_write 为 L2 工具：人审 approve → approved 进检索面；驳回 → rejected 永不检索（源：PRD FR-M7.2·INV-5）
- [x] knowledge/02_poison_rejected：驳回后检索面确定性查不到（源：m7 卡测试计划）
- [x] kb/proposals REST 挂 M2 侧（源：m7 卡公开接口决策）
- [x] 检索 top-k=5；replay 对结论一致且工具调用数下降（源：决策记录 #6·m7 卡测试计划）

## 实现记录（2026-09-08）

**m2 侧（账面，数据归属案件后端）**：`case-backend/src/kb.ts`（KBEntry 深模块：createKbProposal/listKbProposals/decideKbProposal/searchApprovedKb，审计同事务 INV-8，kbentry 状态机 proposed→approved/rejected 仲裁、终态再裁 409 INV-10，kind 出 §5.10 三值枚举 400，source_case_id 不存在 404 ASP 门控）+ db.ts 增 `kb_entries` 表 + statemachine.ts 增 kbentry 流转 + app.ts 挂 PRD §6-M7 五端点（POST/GET /api/v1/kb/proposals、:id/approve、:id/reject、GET /api/v1/kb/search 仅 approved、k 缺省 5）+ closeCase 增 `case.closed` outbox 事件（PRD 图的触发信号，测试断言 payload）。测试 `src/kb.test.ts` 9 条。

**m7 侧（提炼子图 + 检索面，workers/knowledge/）**：
- `flow.ts`：makeKnowledgeFlow 两节点（PRD 图：knowledge_distill → kb_write）。distill = 读案（get_case 过闸，票面绑定 case_id）→ ASP 门控（无 verdict skip + 审计）→ LLM 提炼（parseDraft 把关，坏 schema 重试 1 次 → skip，宁可不错提不可编造）→ kb_propose 在 M2 建档 proposed。kb_write = executeApproved（PRD 的 human_review_gate = 开卡 interrupt，审批卡 params 带草稿全文——值班长在卡上看到要入库的东西，D8 投毒防线）：批准 → 闸验签 → 焚毁 → 执行体（M2 approve 账面留痕 + chroma upsert 进检索面）；驳回 → M2 reject，检索面零写入。resume 重入幂等（M2 裁决 409 视为已完成，chroma upsert 幂等）。
- `prompt.ts`/`schema.ts`/`llm.ts`/`llm-real.ts`：KNOWLEDGE_TOOLS=[get_case, kb_propose]（**不含 kb_write**，INV-3 任务票物理无 L2）+ 输出契约（kind/title/body/tags 或 skip）+ wrapUntrusted 包装案件不可信段 + FakeKnowledgeLlm（verdict→草稿确定性版：fp→fp_pattern、btp→env_fact、tp→runbook、uncertain/无→skip）+ RealKnowledgeLlm（经 gateway /proxy/llm，上游病了回标记回包走 skip 降级）。
- `vector-store.ts`：VectorStore seam + MemoryVectorStore（内存替身，m7 卡 Adapter 行授权）+ RealChromaClient（chroma 官方容器 REST v2 的 fetch client——引擎是 chroma 的，我们只说它的 REST；不引 chromadb npm client 避免把 server 版本耦合进 lockfile）+ hashEmbedding（确定性本地 TF 哈希向量，ascii 词 + CJK 单字分词，FNV-1a 投 256 维 L2 归一）+ chromaSmokeProbe（能力探测，票 16/27 先例）+ KB_TOP_K=5。
- `kb.ts`：ChromaKb 实现 triage 的 TriageKb（m7→m4 adapter：host/path/user 拼查询 → 向量检索 top-k=5 → KbHit；检索面不可达 fail-open 降级 0 命中——PRD「检索 0 命中 → 正常降级」，知识库是提速件不是安全闸）。票 13 的 MemoryKb 语义原样保留（triage 契约测试原样绿）。
- `index.ts`：KB_CHROMA_URL 设了（compose 默认 http://chroma:8000）→ 分诊 KB = ChromaKb(真容器)、沉淀 store = 真容器；未设（本机离线开发）→ MemoryKb 种子 + 内存面。AGENT_FLOW=approval_demo 保留。

**m3/m9 接线（本票动了两处编排地基，均有测试）**：
- `graph.ts`：executeApproved 的 action 允许异步（kb_write 出站 chroma 是 promise）；**挂起判定保持同步**——本函数刻意不是 async 函数，interrupt() 对 sync 节点（approval_demo）同步抛出的票 11 语义逐字节不变；焚毁/执行标记/tool_result 收尾统一 finish，同步动作收尾顺序与票 11 完全一致。
- `runs.ts`/db.ts：runs 增 case_id 列（DDL + 老库 migrate 补列；alert_id 保持 NOT NULL，knowledge run 存空串），交接信封按 run 行拼 case_id。
- `app.ts`：RUN_KINDS 增 knowledge_flow（按 kind 校验 alert_id/case_id）+ TICKET_SPECS 按 kind 铸任务票（knowledge：sub=agent:knowledge，scope=[case:read, kb:propose]，allowedTools 无 L2；case_id 绑票，FR-S2.2）+ **resume 重组图**：裁决端点 resume 前按原 run.kind 重铸任务票并重组 worker 图——原实现 resume 只带静态 opts.nodes，makeNodes 工厂的 worker 图会被换成薄径图，LangGraph 找不到挂起节点直接 completed、L2 动作静默丢失（票 17 是第一个需要 resume worker 图的票，修复有 flow 测试覆盖）。静态 nodes 的审批回路（票 11 测试）不受影响。

**compose（ADR 0002 框架红线：真 chromadb 落 compose）**：chroma 镜像按 digest 钉 `chromadb/chroma@sha256:1e0b73a187a28757c572acba508c46f48c9e8b0acaf5c20e6d95cdedce1acdf6`（实测 = chroma 1.0.0，票 26 digest 钉法先例），宿主口 18000（8000 高频占用口，openfga/8080 同款处理；容器间仍 http://chroma:8000）；agent 增 depends_on chroma + KB_CHROMA_URL/KB_EMBEDDING env。CI compose job `config -q` 通过（不拉镜像）。

**真容器冒烟（本地留证据）**：`KB_CHROMA_SMOKE_URL=http://127.0.0.1:18000`（compose up chroma）跑 vector-store.test.ts：get_or_create 集合 → upsert 3 条（hash embedding 显式出站，服务端零模型下载）→ top-k 检索词面重合最多者第一 → where kind 过滤确定性 → 按名清场，全过。输出留痕：`[票 17 真容器冒烟证据] chroma 1.0.0 集合 kb_smoke_1788905911279：3 upsert / top-k 检索 / kind 过滤 / 清场 全过`。CI 无 docker → probe 不可达显式 skip 并打印原因（票 16 msbProbe / 票 27 llmSmokeProbe 先例）。实测 chroma 1.0.0 REST v2 集合操作在 `/api/v2/tenants/{t}/databases/{d}/collections` 前缀下、DELETE 按 collection name——以真容器 openapi 为准，不凭记忆猜 API。

**验收 5 的 replay 对（FR-M7.4）**：ssh-5712 首跑（空检索面）→ R2 tp + create_case（探索性，tool_call 4 次）→ SOC1 复核 btp 关案（授权红队演练）→ 沉淀子图提炼 env_fact → 值班长批准入库 → 同 fixture 换 sourceRef 重放（真实的第二次发生）→ kb_check 命中 env_fact → btp + close（tool_call 3 次，下降）→ 全程零 L2。结论断言口径见「出入与偏差」第 3 条。

**测试盘点**：case-backend 50（新增 kb.test.ts 9）+ agent 270 passed / 2 skipped（skip = LLM 真网冒烟 + chroma 真容器冒烟，能力探测；本地 chroma 冒烟已真跑全过留证据）+ ingest 21 + mcp-audit 13。全仓 lint/typecheck 绿，spec gate PASS（1 警告：m11 evals 目录规划中）。

### 出入与偏差记录（不改 spec 本体）

1. **embedding 选型（m7 卡/PRD §5.10 无口径，票内裁决）**：chroma 服务端默认 embedding 首次写入会运行时下载 onnx 模型（~80MB），与 CI 离线纪律冲突。按票面授权落 adapter 双实现：默认 `hashEmbedding`（确定性本地 TF 哈希向量，离线零依赖，词面匹配对教学/演示检索语义足够，chroma 仍做向量存储与 cosine）；`KB_EMBEDDING=chroma_default` 切服务端默认模型（语义向量，需容器出网）。换语义模型不改代码、不换 seam。
2. **两个检索面的分工（m2 叶子模块约束推导）**：PRD §6-M7 的 approve 端点注释「写入 Chroma」，但 m2 卡依赖为「无（叶子模块）」，不能依赖 chroma。落成：M2 = 账面（kbentry 状态机 + 审计 + 记录查询面 kb/search，SQLite LIKE）；agent 侧 kb_write（ApprovalToken 正门）= 检索面唯一写入口（先 M2 approve 留痕，再 chroma upsert）。INV-5「只有 approved 进检索面」由写入路径结构性保证（reject/approve 之外的任何路径物理到不了 chroma）；chroma 不可达时提案挂起为 proposed（run 失败可见，PRD 异常与边界）。kb/search 是记录查询面不是向量检索面，已注释声明。
3. **「replay 对结论一致」的操作化口径（记票待 L0 认可）**：FR-M7.4 原文是「结论仍正确 + 探索性工具调用减少」。本票断言：replay 结论与人审沉淀的知识一致（btp + close，rationale 引用环境事实）+ 工具调用 4→3 下降 + 首跑是探索性建案。若按「与首跑结论字面相同」断言，知识生效本身（把探索性 tp 建案纠正为有据 btp 关单）就不会发生——与 FR-M7.4 的意图矛盾，故按 PRD 原文口径断言。
4. **FakeTriageLlm R1 匹配集扩一项（动 m4 一行，记票）**：R1「KB 已知变更优先」原只认 MemoryKb 的 `known_change`；真检索面条目 kind 是 §5.10 三值，`env_fact`（内网环境事实：资产/账号/变更/演练登记）与 known_change 同属「内部事实核验」，加入 R1 匹配。accuracy 测试全绿（MemoryKb 种子无 env_fact 条目，11 条标注 1.000 不变）；fp_pattern/runbook 不参与该规则。
5. **approve/reject 端点的 reviewed_by 缺省 duty_lead**：真实人审身份锚在 agent 侧审批卡 + ApprovalToken.approved_by（INV-9 验签不信文本），M2 的 reviewed_by 是留痕镜像，body.reviewer / x-actor-id 可覆盖。
6. **case.closed 事件已入 outbox，自动触发未接**：沉淀 run 当前与 alert_flow 同款由调用方 POST /internal/runs（票 13 先例——告警事件自动拉起 run 也未接，真异步调度属运行时编排票）；事件先进 outbox 供下游/演示观察。
