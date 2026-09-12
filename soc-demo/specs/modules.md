# 模块划分图 · SOC 数字员工（v1，2026-09-04；2026-09-08 机读化）

> 依据：PRD v1.1 §4-§6 + codebase-design 深模块纪律。每个模块一张接口卡。
> 铁律：跨模块调用只许走对方公开接口；接口卡变更必须回总窗口评审并记 ADR。
> 通过标准（阶段 2）：用户逐卡确认 + 依赖无环 + 无浅模块 + 架构图 v4 过审（2026-09-08 用户「过审」）。
> 机读契约（2026-09-08 起）：模块卡 = `## 模块名`（单 token，票的 Touches modules 行引用它）+ `目录:` 行 + `### 依赖` 的 `- 模块:` 反引号依赖边；`python3 tools/check_specs.py` 校验无环与拼写。

## 0. 全景与依赖方向

12 个 PRD 模块 → 7 个可部署单元（compose 服务）+ 2 个非运行时件：

> 2026-09-12 增补第 13 卡 **m13 压测工具面**——非运行时件（宿主侧 scripts/bench），不在下图 compose 拓扑内，只走各服务公开 HTTP/SSE 面（PRD 变更记录 #7）。
> 2026-09-12 增补第 14 卡 **m14 编排循环**——agent 服务内子模块（与 m4-m7 同层，无独立 HTTP 面），假设驱动的轮次机器（PRD §13，票 70 定稿、票 71 落卡）。

```
                        ┌─────────────┐
  fixtures/alerts ─────►│ M1 告警接入  │  services/ingest
                        └──────┬──────┘
                               ▼ 写 Alert / 发事件
                        ┌─────────────┐        ┌──────────────────┐
                        │ M2 案件后端  │◄───────│ M10 Web 演示窗    │  services/web（薄，纯消费 API+SSE）
                        └──────┬──────┘        └──────────────────┘
                               ▼ alert.created（EventBus seam）
                        ┌─────────────┐
                        │ M3 编排     │  services/agent
                        │ (supervisor)│
                        └──────┬──────┘
              拉起子图+申领票据  │  ┌───────┴────────┬─────────────┬─────────────┐
                               ▼ ▼                ▼             ▼             ▼
                            ┌──────┐        ┌──────────┐  ┌──────────┐  ┌──────────┐
                            │ M4   │        │ M5 调查   │  │ M6 富化   │  │ M7 沉淀   │  （agent 服务内子模块，无独立 HTTP 面）
                            │ 分诊 │        │          │  │          │  │          │
                            └──┬───┘        └────┬─────┘  └────┬─────┘  └────┬─────┘
                               └─────────────────┴──────┬──────┴─────────────┘
                                                        ▼ 一切工具调用先过闸
                                            ┌───────────────────────┐
                                            │ M9 安全控制面          │  跨服务（TS 闸 + Python 件）
                                            │ S2 验票 → S1 凭证注入  │
                                            └───────┬───────────────┘
                        ┌─────────────┐             ▼
                        │ M8 对话     │    ┌──────────────┐  ┌─────────────┐
                        │ Copilot     │───►│ guards        │  │ gateway      │
                        └─────────────┘    │ llm-guard+PII │  │ 铸币/RBAC/FGA│
                                           │ (C4, py)      │  │ (C5, py+镜像)│
                                           └──────────────┘  └─────────────┘
   M6 analyzer 沙箱：microsandbox（一次性 microVM，PRD v1.1 变更 2/3）
   M7 检索面：chroma 容器
   M11 evals/（非运行时，CI+本地）  M12 packages/mcp-audit（独立 CLI）
```

依赖方向单向无环：`fixtures → M1 → M2 → M3 → M4/M5/M6/M7 →（工具调用）→ M9 → M2/外部`；M8 复用 M3 的 chat_flow；M10 只消费公开 REST+SSE；M11 是唯一允许"俯视全局"的件（评测驱动器）。

跨语言契约（防漂移）：任务票/审批票票面 = 固定 fixture 字符串 + 期望验票结果，py 签发侧与 TS 验票侧共用（`fixtures/tickets/`）。

## 1. 模块接口卡

## m1

**M1 告警接入** → services/ingest（:3001）

职责: Wazuh 告警进系统的唯一入口：webhook 接收、去重、映射、不可信标记、触发流水线
目录: services/ingest

### 公开接口

- `POST /api/v1/webhooks/alerts`（契约见 PRD §6-M1）
- 回放：`scripts/replay.ts` CLI（2026-09-04 定案，不设 HTTP 端点；2026-09-09 收官体检删幽灵行）

### 依赖

- 模块: `m2`
- 外部: Wazuh webhook（回放时由 scripts/replay.ts 扮演）

### Seam 与测试

- Seam: 出站写库 = M2 REST（adapter：真实 HTTP / 内存 stub 供单测）
- Adapter: 内存 stub 写库
- 测试计划: 同一 fixture 连推 3 次只建 1 条；7 类具名 fixture 映射全过；注入变体带 `untrusted` 标记（eval 断言）

### 备注

- 映射表、去重键约束均为确定性代码，无 LLM
- 内部：接收校验 → 去重（唯一约束兜底在 M2 SQLite）→ 映射 → 不可信标记 → 写 M2 → 发事件；内部架构图见 `docs/architecture-m1-internal.html`
- 回放载体（2026-09-04 与用户讨论定案）：`scripts/replay.ts` 几十行 CLI——读 fixture 目录按速率 POST 进 webhook，扮演外部 Wazuh。三条铁律：① 数据绝不直接塞数据库，必须走 webhook 正门（否则 M1 的去重/映射/不可信标记演了空城计）；② 推模式，不做定时轮询；③ 不进 compose，非运行时件；Web 告警列表页回放按钮（FR-M10.1）背后是同一个东西
- 重复计数（2026-09-04 用户提出，PRD v1.1 变更 4）：重复推送时 `occurrences` +1 并刷新 `lastSeen`
- 过载卸载（票 68，2026-09-13 收口）：`src/under-pressure.ts`——`UNDER_PRESSURE=on` 才 register `@fastify/under-pressure`（env 缺省=零注册=默认形态逐字节不变）；阈值 `UNDER_PRESSURE_MAX_*` env 可覆盖；503 语义插件自带，setErrorHandler 仅放行 `FST_UNDER_PRESSURE`；on 时 `/status` 为插件自带指标口

## m2

**M2 案件后端** → services/case-backend（:3002）

职责: 六实体 CRUD + 状态机 + 三结局 + 审计落库（全系统数据地基）
目录: services/case-backend

### 公开接口

- PRD §6-M2 的 REST 面（alerts/cases/timeline/audit/active 查询），另有实现长出的写面（2026-09-09 收官体检补卡）：
  `POST /api/v1/alerts`（ingest 唯一写正门，201 新建/200 去重）、`PATCH /api/v1/alerts/:id`（verdict 生命周期，FR-M4.5）、
  `POST /api/v1/alerts/:id/reopen`（FR-M2.1，保留待消费方）、`POST /api/v1/cases/:id/observables`（FR-M6.3 回写，去重合并）、
  `POST /api/v1/cases/:id/tasks` + `POST /api/v1/tasks/:id/log`（m5 add_task_log 消费）
- 事件出口：`GET /api/v1/events?after=`（outbox 游标；alert.created / case.closed；autorun 消费者，票 40）
- 内部面：`POST /internal/audit`（FR-S5 两路汇入写口，票 35）、`POST /internal/used-tokens` + `GET /internal/used-tokens/:jti`（INV-2 焚毁写/读，验票闸生产依赖）

### 依赖

- 模块: 无（叶子模块）
- 外部: SQLite（better-sqlite3 真 / 内存 SQLite 测）

### Seam 与测试

- Seam: ① 存储：better-sqlite3（真）/ 内存 SQLite（测）；② EventBus：SQLite outbox 表轮询（首版）/ 将来可换 Kafka（ADR 记录"为什么不上 Kafka"）
- Adapter: 内存 SQLite
- 测试计划: 状态机迁移表全组合（非法转移 100% 409）；三结局具名 fixture；任意写操作必产审计 diff 条目

### 备注

- 内部模块：`statemachine`（迁移函数集中定义，非法转移抛 InvalidTransition→409）、`audit-signal`（写操作拦截器自动落审计）、`autorun`（outbox 事件→自动拉起，EVENT_DRIVEN 开关，票 40）、`langfuse`（可选观测镜像旁路，票 37）——内部 seam，不进公开接口
- 过载卸载（票 68，2026-09-13 收口）：`src/under-pressure.ts`——`UNDER_PRESSURE=on` 才 register `@fastify/under-pressure`（env 缺省=零注册=默认形态逐字节不变）；阈值 `UNDER_PRESSURE_MAX_*` env 可覆盖；503 语义插件自带，setErrorHandler 仅放行 `FST_UNDER_PRESSURE`；on 时 `/status` 为插件自带指标口

## m3

**M3 supervisor 编排** → services/agent（:3003）

职责: 图编排与路由、checkpointer、票据申领、审批 interrupt、SSE 事件总线、资源兜底。自己不持工具不做安全判断
目录: services/agent

### 公开接口

- `POST /internal/runs` → `202 {run_id}`；kind ∈ {alert_flow, case_flow, knowledge_flow, chat_flow, close_flow}（注册表单一来源 src/run-kinds.ts），intake 按 kind 取 alert_id/case_id（chat 另带 message/role）；actor 经 `x-actor-type`/`x-actor-id` 头
- `GET /api/v1/events/stream?run_id=`（SSE，事件自增 id 落盘，`Last-Event-ID` 补发——已定决策 9）

### 依赖

- 模块: `m2`、`m4`、`m5`、`m6`、`m7`、`m9`
- 外部: gateway 铸票/凭证代理（m9 的 py 侧容器）

### Seam 与测试

- Seam: checkpointer 存储 = SQLite（信封 hash 链）；LLM 调用 = 经凭证代理（S1）
- Adapter: 内存 checkpointer
- 测试计划: 5712 fixture 全链路无人干预跑完；审批 interrupt 杀进程重启后状态可恢复且绑定原 (run, tool_call)；信封篡改 resume 必拒；超 token 预算 run 被强杀 + 审计

### 备注

- 资源兜底口径（PRD 决策记录 #4/#5/#12，2026-09-07 过 M3 节点用户复核确认）：LLM 超时统一 60s（留 per-node env 口子）、max_steps 20、token 50k/run——任一超限强杀 + 审计
- 内部模块：`graph`（图定义）、`events`（SSE 总线 + offset 重放）、`envelope`（信封 hash）、`budget`（资源兜底计数）、`autorun`（票 40：M2 outbox 消费循环——alert.created/case.closed 事件自动拉起 run，EVENT_DRIVEN 开关）
- 内部架构图见 `docs/architecture-m3-internal.html`
- 过载卸载（票 68，2026-09-13 收口）：`src/under-pressure.ts`——`UNDER_PRESSURE=on` 才 register `@fastify/under-pressure`（env 缺省=零注册=默认形态逐字节不变）；阈值 `UNDER_PRESSURE_MAX_*` env 可覆盖；503 语义插件自带，setErrorHandler 仅放行 `FST_UNDER_PRESSURE`；on 时 `/status` 为插件自带指标口

## m4

**M4 分诊 agent** → services/agent 内子模块 `workers/triage`

职责: 单条告警 → 四分类 verdict + 处置建议。物理无 L2 票
目录: services/agent/workers/triage

### 公开接口

- 无独立 HTTP 面；子图输入 `{alert_id, ticket}`，输出写回 M2（verdict_ai + 三结局动词）

### 依赖

- 模块: `m2`、`m7`、`m9`
- 外部: LLM minimax-m2（经凭证代理）/ eval fixture 伪 LLM

### Seam 与测试

- Seam: LLM 调用（adapter：minimax-m2 经凭证代理 / eval fixture 伪 LLM）；prompt 装配器 `wrapUntrusted`
- Adapter: 双 adapter 落地（票 27）：`RealTriageLlm`（minimax-m2 经凭证代理，生产默认）+ `FakeTriageLlm`（确定性，测试默认；`AGENT_LLM` 切换）
- 测试计划: 标注集宏准确率 ≥80%；同主机 24h 两条 TP 只建 1 案；自我审计 checkpoint 100% 出现；并发同告警只分诊 1 次

### 备注

- prompt 契约（结构化输出 schema）是这个模块的事实接口，改动视同接口变更
- 内部架构图见 `docs/architecture-m4-internal.html`

## m5

**M5 调查 agent** → services/agent 内子模块 `workers/investigation`

职责: TP 案件关联调查 → 结构化调查报告进 Timeline。只提建议不动手
目录: services/agent/workers/investigation

### 公开接口

- 子图输入 `{case_id, ticket}`；工具签名契约（`siem_query` 强制 time_window 等，PRD §6-M5）

### 依赖

- 模块: `m2`、`m7`、`m9`
- 外部: SIEM 后端（fixture 告警集检索 / 将来真 Wazuh）

### Seam 与测试

- Seam: SIEM 后端（adapter：fixture 告警集检索 / 将来真 Wazuh）；上下文治理（llm_summarize 小模型 / spill 落盘）
- Adapter: fixture 告警集检索
- 测试计划: `invest/01_ssh_tp_full` 报告 schema 过 + findings 引用真实工具输出；超大结果落盘且上下文未超窗；防打转（同参数重复调用报错）

### 备注

- 内部架构图见 `docs/architecture-m5-internal.html`

## m6

**M6 富化 agent** → services/agent 内子模块 `workers/enrichment` + 沙箱运行时（v1.1 变更）

职责: observables 跑 analyzer（Cortex 契约子集）+ TLP/PAP 闸门 + artifacts 回写
目录: services/agent/workers/enrichment

### 公开接口

- 子图输入 `{case_id, ticket}`；analyzer 调用/返回契约照 PRD §6-M6

### 依赖

- 模块: `m2`
- 外部: microsandbox（analyzer 在一次性 microVM 里真跑——至少一个 analyzer 为真实脚本）

### Seam 与测试

- Seam: ① analyzer 执行（adapter：microsandbox 真跑 / fixture 表 mock——默认 mock，演示攻击面切真跑）；② TLP/PAP 闸门在工具包装层（确定性中间件，不靠 prompt）
- Adapter: fixture 表 mock analyzer
- 测试计划: `enrich/01_vt_malicious_hash` taxonomy 正确；`enrich/02_tlp_red_blocked` 超限必拒 + DENIED 审计；`attack/sandbox/01_poisoned_analyzer`：投毒 analyzer 尝试外联/读宿主 env 被沙箱拦截（第四攻击面）

### 备注

- 内部架构图见 `docs/architecture-m6-internal.html`

## m7

**M7 知识沉淀** → services/agent 内子模块 `workers/knowledge` + chroma

职责: 案件关闭 → 提炼 KBEntry 草稿 → 人审入库 → 检索注入提速下次分诊
目录: services/agent/workers/knowledge

### 公开接口

- PRD §6-M7 的 kb/proposals REST 面（**决策：REST 面挂 M2**——数据归属案件后端，agent 侧只出提炼子图）

### 依赖

- 模块: `m2`、`m9`
- 外部: chroma 向量库（adapter：chroma 容器 / 内存 stub 供单测）

### Seam 与测试

- Seam: 向量库（adapter：chroma 容器 / 内存 stub 供单测）
- Adapter: 内存 stub 向量库
- 测试计划: `knowledge/01_fp_pattern_distill`；`knowledge/02_poison_rejected`（驳回后检索面确定性查不到）；replay 对结论一致且工具调用数下降

### 备注

- 检索注入内容同样过不可信包装（guards kb 通道）
- 内部架构图见 `docs/architecture-m7-internal.html`

## m8

**M8 对话 Copilot** → services/agent（chat_flow）+ gateway + guards

职责: 登录角色会话 → RBAC 可见工具 → 输入预检 → 意图闸 → 执行 → SSE 流式回答
目录: services/agent

### 公开接口

- `POST /api/v1/auth/login`（四预置身份会话签发，四预置身份 soc1/duty_lead/admin/redteam；2026-09-09 补卡钉路径）
- `POST /api/v1/chat`（SSE，契约见 PRD §6-M8）；会话登录端点（4 预置身份）

### 依赖

- 模块: `m2`、`m3`、`m9`
- 外部: gateway（RBAC 可见性 + FGA 裁决 + 铸票，m9 py 侧容器）、guards（输入预检，m9 py 侧容器）

### Seam 与测试

- Seam: FGA 裁决（adapter：openfga 容器 / 静态规则表 stub 供单测）
- Adapter: 静态规则表 stub
- 测试计划: `chat/01_ip_pivot`；`chat/02_injection_input` 拒答+审计；soc1 发起 L2 意图 100% deny；可见工具清单按角色快照 diff

### 备注

- 上下游补边说明（2026-09-08 过图定案）：上游=Web 对话页（agent REST 面上的 POST /chat）；追问数据从 M2 只读面来

## m9

**M9 安全控制面** → 跨服务（TS 闸在 agent，Python 件在 gateway/guards）

职责: LLM 是不可信决策者的全部强制落地：凭证代理 / 验票闸 / 注入防线 / PII / 审计 / 子 agent 权限收窄
目录: services/agent

### 公开接口

- `verifyTicket(toolCall, ctx) → allow|403+reason`（TS 中间件签名，PRD §6-M9-S2）
- 审批卡 REST：`GET /api/v1/approvals?status=pending`、`POST .../approve|reject`（挂 agent 服务；内部模式铸票调 gateway，外部模式经椒图中继——请求头 `x-approver-token` 透传、409 仲裁权在椒图，2026-09-11 票 58；approvals wire 带 `external_id`）
- gateway：`POST /internal/mint`（签任务票/ApprovalToken，py 侧，手写 HMAC 三段式票型——ADR 0001 搬票型不搬代码，fixtures/tickets/ 契约）
- gateway：`/proxy/llm/*`（凭证代理转发，proxy.py 参数化，LLM base_url 指这里）
- guards：`POST /scan/injection`、`POST /pii/anonymize`、`POST /pii/reveal`（受控反查，票 49；审计只记「谁查了占位符、命中几条」不记原文）
- agent pii 反查代理：`POST /api/v1/pii/reveal`（挂 agent 服务，转发 guards 反查口，票 49；走线由 vite-proxy.test.ts 机器锁定）

### 依赖

- 模块: `m2`
- 外部: openfga 镜像（FGA）、contextforge 镜像（RBAC 渠道面）；jiaotu-gateway（env `JIAOTU_GATEWAY_URL` 设定时的狗粮外接，见备注）

### Seam 与测试

- Seam: 铸币（adapter：HMAC 自签教学版 / 蓝图 STS）；验票与签发跨语言共享 `fixtures/tickets/` 契约
- Adapter: HMAC 自签教学版
- 测试计划: `attack/privesc/01_triage_calls_isolate` 403+DENIED；伪造审批文本 403；token 重放第二次 403；金丝雀凭证全链路 grep 不到；验票闸延迟 ≤5ms；worker × 非 scope 工具遍历 100% 403

### 备注

- 决策：焚毁表（used_tokens）放 M2——审计同库同事务
- 这是差异化主体，六张卡（S1-S6）共用这一张模块卡，但每个 S 的验收标准独立可测
- 内部架构图见 `docs/architecture-gateway-internal.html`、`docs/architecture-guards-internal.html`
- 狗粮外接形态（2026-09-11 票 57/58/59 落地，soc-demo 合流 7b4cd9c；CONTEXT「防线换防」）：env `JIAOTU_GATEWAY_URL`/`JIAOTU_API_KEY` 设定时，四件安全职能（LLM 代理/任务票铸发/审批铸票/焚毁账本）在运行面整体交棒椒图（adapter 见 `services/agent/src/jiaotu/`：token-ports-jiaotu + approval-gateway），soc-demo 永不自铸审批票（INV-2 单口在椒图 g4），保留消费侧验票闸/KB 人审/业务审计；未设 = 内部 gateway 形态逐字节不变（默认形态即教学资产本貌）。六幕经椒图活体冒烟全绿（`scripts/jiaotu-smoke-11.sh`，默认 fake LLM）；compose jiaotu 形态见 `docker-compose.jiaotu.yml` overlay
- 外部模式装配面（票 58）：`buildApp` opts `approvalGateway?` 注入 seam（生产 = `JiaoTuApprovalGateway`，测试注入假件）；审批申报/对账/中继/G9 四路共用该端口，接口立在领域模块 approvals.ts

## m10

**M10 Web 演示窗** → services/web（:5173）

职责: 六页面薄客户端，全部数据走公开 REST+SSE，无特权接口
目录: services/web

### 公开接口

- 六个路由（告警列表/流水线视图/审批卡/案件时间线/审计流/Eval 结果），之外无任何路由

### 依赖

- 模块: `m2`、`m3`、`m8`、`m9`
- 外部: 数据源 adapter（真后端 / vi.stubGlobal fetch 打桩供前端单测，票 21/31 形态）

### Seam 与测试

- Seam: 数据源（adapter：真后端 / fetch stub 供前端单测）
- Adapter: vi.stubGlobal fetch stub（2026-09-09 收官体检对齐实现）
- 测试计划: 六幕剧本 Web 全通 + 每幕 curl 等价脚本；路由快照防范围蔓延

### 备注

- 技术选型（2026-09-08 拍板）：Vite + React + Ant Design 5（表格/抽屉/Tag/Steps 用 antd，不自己撸基础组件）；不引状态管理库；SSE 原生 EventSource

## m11

**M11 Eval 体系** → evals/（非运行时）

职责: 三维评估（分诊准确率/防线拦截率/成本口径）+ CI 快慢两道
目录: evals

### 公开接口

- `pnpm test:eval [-- --tags regression]`；产出 `eval-results/latest.json + cost_all.csv`

### 依赖

- 模块: `m1`、`m2`、`m3`、`m4`、`m5`、`m6`、`m7`、`m8`、`m9`、`m10`
- 外部: judge（`JUDGE_MODEL`，只评分不进门槛）

### Seam 与测试

- Seam: 被测栈（adapter：单测级注入=PR 门禁快道 / 全栈 compose=每日慢道——已定决策 10）；judge（`JUDGE_MODEL`，只评分不进门槛）
- Adapter: 单测级注入（快道）/ 全栈 compose（慢道）
- 测试计划: 用例 ≥30（分诊 ≥10 / 攻击 ≥10(四面) / 审批 ≥3 / replay ≥2 / 对话 ≥3）

## m12

**M12 MCP 体检 CLI** → packages/mcp-audit（独立 npm bin）

职责: MCP server 静态体检：投毒描述/权限面/凭证暴露/rug-pull 提示
目录: packages/mcp-audit

### 公开接口

- `soc-mcp-audit <cmd-or-url>` → `mcp-audit-report.{md,json}`

### 依赖

- 模块: `m9`
- 外部: MCP transport（stdio/sse 各一 adapter）

### Seam 与测试

- Seam: MCP transport（stdio/sse 各一 adapter）；注入扫描复用 guards，可降级为本地规则（已定决策 11 CLI 内嵌）
- Adapter: 本地规则内嵌
- 测试计划: ≥3 公开 server + 1 内置恶意 fixture server 投毒 100% 检出

## m13

**M13 压测工具面（非运行时件）** → scripts/bench（宿主侧独立小包，不进 compose 拓扑）

职责: 对公开 HTTP/SSE 面施压，实测四个理论天花板（分发循环 ~10 run/s / autorun 2s 消费 / SQLite 单写者水位线 / SSE 每订阅者 100ms 扇出预算），输出同机可比的延迟分布与压测拐点（每张结果表带机器规格，不当生产 SLO）
目录: scripts/bench

### 公开接口

- `node scripts/bench/b1-endpoints.mjs <case>` → 单端点微基准（ingest webhook / M2 upsert / gateway mint / M2 读口，四张卡）
- `node scripts/bench/b3-dispatcher.mjs <并发档>` → run 并发爬坡：run_jobs 队列深度时间序列 + 实测分发吞吐 vs 理论 ~10 run/s
- `node scripts/bench/b2-chain.mjs <burst|sustained 档位>` → 链路突发与持续流：e2e 延迟分布（alert→run）+ cursor 滞后 + ingest 拐点
- `node scripts/bench/b4-sse.mjs <订阅者数>` → SSE 扇出：订阅者滞后 + 1s 轮询对照
- 报告汇总 → `docs/research/2026-09-12-压力测试报告.md`（每层一表：数字+机器规格+复现命令）

### 依赖

- 模块: `m1`、`m2`、`m3`、`m9`（只走公开 HTTP/SSE 面；观察口=现有 REST 读口与表的既有读路径，缺读口停下回报 L0，不顺手加端点）
- 外部: autocannon（scripts/bench 自有 package.json 的 devDependency；框架红线：必须真引入且被脚本调用）

### Seam 与测试

- Seam: HTTP 客户端注入（fetch 包装，可指向 stub 服务做离线单测）；多步链路用 autocannon 的 requests/context API
- Adapter: autocannon 编程 API；B1-B4 零生产代码（B5 防线实验亦零代码——只停/杀容器与灌压）。唯一服务端改动=票 68 under-pressure 装配（三 Fastify 服务 env 开关件，缺省形态逐字节不变，见 m1/m2/m3 卡备注）
- 测试计划: harness 单测（stub 服务 200/422/超时三态断言 + sourceRef 唯一化生成器）；中立层边界由 check_boundary.py 既有"scripts/ 禁 import services 内部"规则覆盖

## m14

**M14 编排循环（假设驱动）** → services/agent 内子模块（m3 领地新目录，无独立 HTTP 面；PRD §13）

职责: 假设进、轮次机器跑、结论出——planner 从能力菜单选组合 → 扇出子 run 并行取证 → judge 裁决 → gap 缺口 → 再组合，直到证据收敛；**本卡不含任何业务分支**（狩猎/应急取证等只是内容层模板）
目录: services/agent

### 公开接口

- `POST /internal/runs {kind:"hunt_flow", hypothesis_id}` → 拉起循环 run（m3 run 机器标准入口，与其他 kind 同权）
- `run_hypothesis(template_id, hypothesis_text, actor)` → run_id（m14 组图入口：m3 makeNodes 对 hunt_flow 调它；交接态按 m3 信封口径装 hypothesis_id/模板菜单）
- 模板登记面：模板 = `template_id + 假设句式族 + 菜单子集 + max_rounds/单轮任务数改写`（格式契约归本卡，模板文件归内容层票 79）
- 子 run 契约：kind=`hunt_task`，标准 run 机器拉起（m3 公开面），m14 只在 dispatch 节点经 m3 调用，子 run 复用 m5 plan/decide 循环（hunt 版 prompt 为内容层）
- 轮次/子 run 归集读面 + 假设 CRUD（发起/取消/列表/详情）→ **m2 卡面新增**（PRD §13.7 页面映射的两条新查询面）

### 依赖

- 模块: `m3`（run 机器/事件/分发/组图——循环拓扑落 dispatcher 层，**禁改 compileFlowGraph 串行链模型**）、`m9`（两票票务只走公开铸票面）、`m5`（子 run plan/decide 循环与 SIEM/KB adapter，经公开接口）、`m2`（假设实体经 REST）
- 外部: @langchain/langgraph（框架红线：走 m3 现有 compileFlowGraph 节点包装机制）

### Seam 与测试

- Seam: planner/judge/gap_analyzer 各 LLM adapter（fake/real 双件，走 m3 llm-client 口径）；票务口注入（父票 planner 面 + dispatch 子票）；事件唤醒口（子 run 终态→父 run，禁轮询）；playbook/graph 查询 adapter（Memory stub → weknora HTTP，票 79/83）
- 测试计划: fake LLM 全轮次轨迹契约测试（C₂≠C₁ 或单轮收敛）；INV-11 子票 ⊆ 父菜单遍历断言；相邻轮同组合防转掐断；预算双闸四触发（详表归票 72 spec 定稿时逐条落）

### 备注

- 拓扑约束（已定案）：循环性 = round k outcome 发 outbox 事件拉起 round k+1 run + 父子 run 簿记；图内永远是一轮一条串行链
- 预算约束：hunt_flow 预算按 kind 分档（PRD §13.5 ⑩），档位数字票 72 定并回测压测四天花板
- 内容层位置：模板文件与 hunt prompt 归票 79，本卡只定义格式契约

## 2. 新增 compose 服务（相对阶段 0.2 骨架）

- `openfga`（官方镜像，M9-S6/M8 FGA 裁决）——setup 脚本按 ADR 0001 思路幂等重建授权模型
- `contextforge`（官方镜像，替代 gateway 占位 FastAPI 的 RBAC/渠道面；自写插件挂载）
- gateway 服务形态 = **三个容器并排**（2026-09-04 用户拍板）：`contextforge` 镜像（RBAC/渠道面）+ `openfga` 镜像（FGA 裁决）+ 自写小 FastAPI（铸币 `POST /internal/mint` + 凭证代理 `/proxy/llm/*`，proxy.py 近乎原样可用）。自写件不动镜像内部，排障简单
- `microsandbox`：不是常驻服务，按需拉起一次性 microVM（M6 调用时创建）
- Langfuse：**不进默认 compose**（v1.1 变更 1），可选 profile `observability`（票 37 落地：`langfuse`+`langfuse-db` 双服务，v2 镜像按 digest 钉）

## 3. 明确砍掉/不做的

- Redis/Kafka：不引入；EventBus seam 用 SQLite outbox adapter 首版（将来换实现不换接口）
- M2 多租户/认证、M10 配置管理、M7 自动入库：照 PRD §11 边界声明

## 页面映射

> 票 71 落（2026-09-12）。逐行把 PRD §13.7 页面数据需求追到公开接口；追不到 = 接口有洞当场补卡。两条"新查询面"即 m2/m14 卡面新增行的来源。

| 页面·数据需求 | 类型 | 追到接口 | 状态 |
|---|---|---|---|
| 狩猎页·假设列表（五态 Tag） | 读 | m2 `GET /api/v1/hypotheses`（卡面新增） | 需要新查询面（票 73 随假设实体建） |
| 狩猎页·发起假设（选模板+填假设句） | 写 | m2 `POST /api/v1/hypotheses` → outbox 拉起 m3 hunt_flow | 需要新接口（票 73） |
| 狩猎页·取消假设（hunting 态） | 写 | m2 取消端点（状态机 hunting→cancelled，INV-10） | 需要新接口（票 73） |
| 狩猎页·轮次视图（每轮组合/子 run 状态） | 读+SSE | m3 run 公开读面 + SSE（流水线页同款，既有）＋ m2 假设详情读面的轮次归集段 | 部分既有；归集段为新查询面（票 73） |
| 狩猎页·judge 裁决 + gap 缺口 | 读+SSE | m2 假设详情读面内嵌（轮次归集段） | 同上 |
| 狩猎页·收敛结论（Case 链接/证伪摘要） | 读 | m2 假设详情读面内嵌 + 既有案件查询面（Case 挂 hypothesis_id） | 详情段新、案件面既有 |

## 边界规则

> 2026-09-09 阶段 7 收官体检落卡（审计窗口 A 的 R1-R8 实盘为底稿）。CI 边界闸的唯一事实来源（票 28 建闸）。豁免复核归每轮体检第四条对账。

| 禁止 | 例外 | 理由 |
|---|---|---|
| `services/*` 各 workspace 包互相 import 源码内部（跨服务只走公开 REST/SSE 面） | （无；原违例已由票 28 清偿） | 深模块边界（ADR 0001/0002 一贯口径） |
| `evals/` 引用 services 内部实现 | `evals/src/{runner,scenarios,judge,assertions}.ts`、`evals/src/rigs/{shared,approval,replay,chat,investigation,triage,attack}.ts`（票 44·F6 自 scenarios.ts 拆出的布景 rig，同组装入口角色——ADR 0003 允许清单扩展已追认，票 45）与 `suite.test.ts` 的组装入口符号（buildApp/executeRun/makeXxxFlow/FakeXxxLlm/MemoryXxx/GatewayLlmClient/事件读口）；禁触 case-backend `db.ts`/`store.ts` 写路径 | 决策 #10 快道单测级注入，ADR 0003 裁决 3 |
| `scripts/`、`tools/` 中立层 import services/evals/packages 内部 | （无） | 中立层保持可独立执行（票 09 replay 三铁律同源） |
| `services/`、`evals/` 测试与 rig 反引仓库级 `scripts/` 禁止（replay 类走子进程） | 原违例已由票 28 清偿、票 46 收口 evals 向；**现行豁免**：`services/agent/src/jiaotu/jiaotu-register.test.ts`（票 62，2026-09-12 L0 补记） | scripts 不在模块图内；豁免理由：注册脚本是 soc-demo→椒图的跨仓契约正门、无任何运行时被依赖，契约锁需要函数级注入（mockFetch 测试缝），子进程化会丢失注入能力——豁免精确到该测试文件，体检复核 |
| `packages/mcp-audit` import 任何 workspace 包（独立 CLI） | （无） | m12 卡独立交付（ADR 0002 票 25 沿革） |
| `services/web` import 任何他包源码（数据全走同源代理 REST/SSE） | （无） | m10 卡：web 是纯展示壳 |
| `services/guards` 与 `services/gateway` 互不 import（py 侧经 REST） | （无） | C4/C5 分工（PRD §4.1） |
| 依赖方向单向：fixtures→ingest→case-backend→agent→{guards,gateway,chroma,openfga}；反向/环状引用 | （无） | 依赖无环（check_specs 卡级锁的代码级延伸） |
| 服务级 `/healthz` 等基础设施端点计入卡面公开接口对账 | 全体服务 `/healthz` | 体检对账三-12 统一豁免 |
| m14 机制目录（services/agent 编排循环件）引用内容层模板实现或含业务分支常量（hunting/ir 等模板名出现在机制层源码/常量） | 模板**格式类型定义**（纯类型无行为，单文件） | PRD §13.1 分层铁律：机制/内容分离，票 80 零增量断言的机器半边（check_boundary 需加内容型检查器） |
| m14 自签/改面任务票（铸票只许经 m9 公开铸票面，票面 scope 生成后不可再改） | （无） | INV-11 执行缝：子票 ⊆ 父菜单靠"铸票唯一通道"结构保证，票 76 遍历断言的静态半边 |
| m14 与 m5 子 run 流程 import `src/approvals.ts` 的审批内部（开卡/ApprovalToken 通道） | （无） | M9-S6 沿用：worker 物理无 L2 通道，L2 只经 graph.ts NodeCtx 的 executeApproved 正门（m3 卡面） |
