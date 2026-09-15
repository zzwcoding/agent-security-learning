# SOC 数字员工（soc-demo）

> 为被告警淹没的 SOC 提供一名"数字员工"：自动分诊告警、调查取证、沉淀知识，危险动作永远等人点头。能力对标真实 SOC 工作流，安全上把八道防线落到每个 agent 动作上——**员工零权限、出站全凭手令、高危必经人审、全链路留痕**。

[![CI](https://github.com/zzwcoding/agent-security-learning/actions/workflows/ci.yml/badge.svg)](https://github.com/zzwcoding/agent-security-learning/actions/workflows/ci.yml)

**概览 • 功能总览 • 架构 • 服务与 Profile • 快速开始 • 压测与防线实验 • 安全声明 • 文档地图**

---

## 📌 概览

这不是一个"调了个 prompt 的 demo"：它是一个 **9 容器、多 agent 协同、可一键复现**的完整系统，同时是一份"怎么给 LLM 系统上安全治理"的施工档案——近百张工程票（每张带验收证据与实现记录）、14 张模块卡、11 条语义不变量（INV-1~11）、三道自研 CI 闸。

- **默认形态**：fake LLM 全栈确定性，零出网，每次演示同一结果；
- **v2 主体**：假设驱动的**编排循环**——分析师提假设，系统自动"选组合 → 扇出取证 → 裁决 → 换思路再来一轮"直到收敛；换一个业务（应急取证）只写一张数据模板，机制层零改动（CI 里的零增量闸看守）；
- **教学**：13 场景 66 步 + 13 张 per-scenario 大图（见 `lessons/scenario/`），每个设计决策都有"为什么"。

---

## 🧩 功能总览

### 告警处理链（v1 主干）

| 能力 | 细节 |
|---|---|
| 告警接入（m1） | Wazuh 格式 webhook 正门：验型 422、severity 映射、不可信字段标记（D1），重复推送只 occurrences+1（INV-6） |
| 案件后端（m2） | 档案室：告警/案件/线索/时间线/审计/KB 账面/outbox/坟场全归它；事务型 outbox 与业务写同事务，档案和叫号屏永远对得上账 |
| 分诊 agent（m4） | 四分类 verdict（TP/FP/BTP/Uncertain）+ 关闭建议；假 LLM 确定性可断言，真 LLM 走凭证代理 |
| 调查 agent（m5） | 六工具取证实战（siem_query / related_alerts / kb_verify…）、同主机归并、调查报告进时间线；上游产物进 prompt 前过注入扫描 |
| 富化 agent（m6） | 案件 observables 逐项富化，工具调用/返回全审计 |
| 知识沉淀（m7） | 关案提炼经验 → KB 账面 proposed → **人审 approved 才进 chroma 检索面**（INV-5） |
| 对话 Copilot（m8） | 案件页追问；高危意图先过 FGA 意图闸三态（allow/require_approval/deny），可见≠可直查 |

### 安全治理（八道防线 × 11 条不变量）

| 编号 | 防线 | 落点 |
|---|---|---|
| D1 | 不可信内容标记 | prompt 装配器（M1/M9-S3） |
| D2 | llm-guard 注入扫描 | guards 服务（:8001） |
| D3 | PII 脱敏 | Presidio（guards 服务） |
| D4 | 工具分级验票闸 | agent 工具中间件（gated-call） |
| D5 | 审批铸票回路 | 审批卡 interrupt + 签名 ApprovalToken |
| D6 | 凭证代理 | gateway 服务——真密钥只活在代理与出站瞬间 |
| D7 | 子 agent 权限收窄 | 最小 scope 票（两票票务） |
| D8 | 知识人审入库闸 | KB 账面 approved 才进检索面 |

审计流（M9-S5）横切记录层：任何写操作/LLM 调用/工具调用/审批/状态变更都有五要素 AuditEntry（INV-8），**每道防线的每一次拦截都有账**。11 条不变量（fail-closed 覆盖 allow、令牌一次性、票面永不含 L2、金丝雀防凭证泄漏、KB 人审、去重、SSE 恰一次、状态机 409 等）见 [CONTEXT.md 语义核心](../soc-demo/CONTEXT.md)。

### 编排循环（v2 主体，m14）

| 能力 | 细节 |
|---|---|
| 假设实体（m2 第七实体） | 五态状态机 proposed→hunting→concluded/refuted/cancelled，发起/取消/列表/详情（轮次归集），CRUD 走公开 REST |
| planner | 只许从能力菜单选组合（菜单外 fail-closed 零重试），输出 schema 校验失败重试一次再败本轮终止；连续两轮失败假设取消 |
| 扇出执行 | dispatch 按组合逐任务拉起独立子 run（hunt_task），**两票票务**：父票=菜单只读面、子票=每任务单工具；INV-11 遍历矩阵 93 格全 403 |
| 跨 run 等待 | await_children 只经事件唤醒（子 run 终态事件），全仓禁轮询（静态断言守着） |
| judge / gap | 裁决证据充分性（防改写：子报告 hash 锁定），不充分则结构化缺口驱动下一轮换组合；相邻轮同组合指纹即掐（防转） |
| 预算双闸 | 按 run/轮次/任务三级分档（run 900s/200 步/500k token…env 可覆写），触发即强杀不冒充证伪 |
| 收敛分岔 | 命中建案挂 hypothesis_id / 证伪归档+图谱登记（proposed 待人审）；取消竞态不留孤儿案 |
| 业务复用 | 模板=数据文件（狩猎三族+应急取证）；零增量闸保证换业务不碰机制层 |

### 演示、验证与质量

| 能力 | 细节 |
|---|---|
| Web 前台（m10，antd5） | 七页：告警列表/流水线视图（SSE 实时+断线补发）/审批卡/案件时间线/审计流/Eval 结果/狩猎页（假设入口+轮次卡片实时推进） |
| Eval 体系（m11） | 33 场景回归（分诊/注入/越权/投毒…）+ **紫队闭环**：攻击 fixture 自动转假设，自主发现率 5/11（ground truth 机器判定、同 seed 可复现）+ 盲区报告 |
| MCP 体检（m12） | mcp-audit CLI：对陌生 MCP server 做安全体检 |
| 压测工具面（m13） | autocannon 四天花板实测 + 防线压下实验（见下节），一键复现 |
| 质量门禁 | spec gate（验收绑定机器校验）/ 边界闸（R1-R12 两向锁）/ 零增量闸 / lint / ~1100 测试，CI 不绿不合并 |

---

## 🏗️ 架构

```mermaid
flowchart LR
    REPLAY["pnpm replay<br/>（scripts/replay.ts，推模式）"]
    FX[("fixtures/alerts/*.json")]

    subgraph SVC["九服务拓扑"]
        INGEST["ingest :3001<br/>验型·映射·不可信标记"]
        M2[("case-backend :3002<br/>SQLite 档案室：alerts/cases/<br/>kb/outbox/used_tokens/hypotheses")]
        AGENT["agent :3003<br/>autorun 2s·分发循环 100ms<br/>五 worker + 编排循环 m14<br/>验票闸·串联闸·预算双闸"]
        GUARDS["guards :8001<br/>llm-guard 注入扫描·Presidio 脱敏"]
        GW["gateway :8002<br/>HMAC 铸票·凭证代理·审批铸票"]
        WEB["web :5173<br/>antd5 七页·SSE 实时"]
        CHROMA["chroma<br/>KB 检索面（:18000）"]
        FGA["openfga<br/>意图闸授权（:18080）"]
        CF["contextforge :4444<br/>RBAC/渠道面"]
    end

    FX --> REPLAY --> INGEST --> M2
    M2 -- "outbox 事件（同事务写屏）<br/>autorun 2s 消费" --> AGENT
    AGENT -- "铸票/凭证出站" --> GW
    AGENT -- "出站扫描" --> GUARDS
    AGENT -- "kb_check / 正门写入" --> CHROMA
    AGENT -- "意图三态" --> FGA
    AGENT -- "SSE 事件流" --> WEB
    WEB -- "REST" --> M2
    CF -.-> AGENT
```

要点：**跨服务只走公开 REST/SSE，谁也不翻墙开别人的库**（两台 SQLite 分属 case-backend 与 agent，边界闸 R2 看守）；事务型 outbox 取代消息中间件（单机量级最简解）；`parksOnEvents` 分发放行让编排循环的挂起父 run 不堵死串行分发——循环拓扑落在 dispatcher 层，LangGraph 图内永远一轮一条串行链。

可交互架构图：`docs/architecture-v4.html`（点节点跳详情）+ M1-M12 内部结构图 `docs/architecture-m*-internal.html`；13 张场景大图 `lessons/scenario/N-big-picture.html`（每场景的代码落点索引）。

## 🧱 组件清单（PRD §4.1，v1.2 冻结口径）

| # | 组件 | 技术栈 | 职责 | 部署形态 |
|---|---|---|---|---|
| C1 | 告警接入服务 | TypeScript / Node + **Fastify**（待定项①已决） | Wazuh 格式告警 webhook 接收、字段映射、`source+sourceRef` 去重、severity 映射、fixture 回放入口 | docker-compose 服务 `ingest`，单容器 |
| C2 | mock 案件后端 | TypeScript + SQLite（better-sqlite3） | TheHive 风格 Alert/Case/Task/Observable/Timeline/Audit 的 CRUD 与状态机；审计条目落库 | docker-compose 服务 `case-backend`，SQLite 文件挂卷 |
| C3 | agent 编排服务 | TypeScript + LangChain.js / LangGraph.js | supervisor + 4 worker 图编排、checkpointer、工具注册表、验票中间件、SSE 事件总线 | docker-compose 服务 `agent` |
| C4 | llm-guard / Presidio 微服务 | Python + FastAPI（复用路线 1-3 管线） | 注入扫描（llm-guard）与 PII 识别/脱敏（Presidio），可同服务多端点 | docker-compose 服务 `guards` |
| C5 | 已有 Python 后端（复用） | Python（ContextForge 网关 / OpenFGA / microsandbox / Langfuse） | RBAC 工具可见性、FGA 裁决、铸币（票签签）、trace 收集 | docker-compose 服务 `gateway`（复用现有镜像/代码） |
| C6 | Chroma 向量库 | Chroma（独立容器） | 知识沉淀条目（KBEntry）的向量存储与检索 | docker-compose 服务 `chroma` |
| C7 | Web 演示窗 | Vite + React + Ant Design 5 + SSE，不引状态管理库 | 六个页面的薄演示窗（§M10） | docker-compose 服务 `web`（dev 模式 vite，演示用静态构建 + 静态服务均可） |
| C8 | Eval 体系 | vitest + fixture 目录 + LLM judge | 回归评测（分诊准确率/防线拦截率/成本口径） | 非运行时组件，CI 与本地 `pnpm test:eval` |
| C9 | MCP 体检 CLI | TypeScript CLI | 对接入的 MCP server 做体检（工具描述投毒/权限范围/凭证暴露面） | 独立 npm bin，不进 compose |
| C10 | 告警 fixture 数据集 | JSON 文件 | 7+ 类真实 Wazuh 告警落盘 + 注入变体 | 仓库内目录 `fixtures/alerts/` |

部署拓扑：开发/演示均为单机 docker-compose；Wazuh manager 容器为可选 profile `real-wazuh`，非默认路径（决策记录 #4）。

> 实现演进注记（读表时对齐现状）：C7 页面现为**七个**（+狩猎页，票 82）；C3 内 v2 已长出**编排循环 m14**（hunt_flow/hunt_task，PRD §13）；C5 中的 openfga/chroma/contextforge 在 compose 里已是独立服务（见上架构图）；C10 语料随四维度狩猎告警与四条注入变体扩充。需求期原貌以此表为准，现状以 `specs/modules.md` 14 张卡为准。

---

## 🔌 服务与 Profile

| 服务 | 端口 | 角色 |
|---|---|---|
| ingest | 3001 | 收案窗口（Wazuh webhook） |
| case-backend | 3002 | 档案室（SQLite） |
| agent | 3003 | 数字员工（workers + 编排循环） |
| guards | 8001 | 安检员（注入扫描/PII 脱敏） |
| gateway | 8002 | 保安处（铸票/凭证代理/审批铸票） |
| web | 5173 | 值班台（antd5 七页） |
| chroma / openfga / contextforge | 18000 / 18080 / 4444 | 检索面 / 授权裁决 / RBAC 渠道面（官方镜像） |

| Profile | 起什么 | 什么时候用 |
|---|---|---|
| 默认（九服务） | 上表全部 | 日常演示/教学/压测 |
| `observability` | +langfuse(+db) | 看 LLM trace 时间线（key 空=旁路自动关闭） |
| `real-wazuh` | +wazuh-manager | 真 Wazuh 规则引擎判同一批 fixture（`pnpm wazuh:feed`） |
| `jiaotu`（overlay 双件套） | +椒图网关，**不启内部 gateway** | 四件安全职能整体外接产品网关（狗粮形态） |

---

## 🚀 快速开始（2026-09-09 实测口径）

```bash
cp .env.example .env          # 教学假值可跑；真部署按票 06 口径由环境注入真值
docker compose up -d --build  # 首次或代码更新后带 --build
bash scripts/setup-openfga.sh # 幂等重建 FGA 授权世界（openfga 是内存存储，容器重启后需重跑）
pnpm replay                   # 告警 fixture 走 ingest webhook 正门（同 web 告警页回放按钮）
```

打开 http://localhost:5173 选脸登录（无密码，四预置身份）。LLM 切换在 `.env`：
`AGENT_LLM=fake`（离线确定性）或 `real` + `SECRETS_LLM_API_KEY=…`（真出站，key 只挂
gateway，票 27）。演示动线：PRD §8 六幕剧本。

### 可选：Langfuse 观测 profile（票 37，ADR 0001 拍板不进默认启动）

```bash
docker compose --profile observability up -d langfuse   # v2 镜像 + postgres，宿主 13000
# .env 追加两行并重启 agent（key 空 = 镜像旁路不启用，默认链路零改动）：
#   LANGFUSE_PUBLIC_KEY=pk-lf-local-demo
#   LANGFUSE_SECRET_KEY=sk-lf-local-demo
docker compose up -d agent && pnpm replay
```

打开 http://localhost:13000（demo@soc-demo.local / teaching-demo-pass-not-for-prod）看
run trace 时间线；每个 run 一条 trace，SSE 事件与审计五要素镜像为观察条目。
真容器冒烟：`bash scripts/langfuse-smoke-37.sh`。

### 可选：Wazuh 真实规则引擎 profile（票 38，PRD FR-M1.6；默认链路零改动）

```bash
docker compose --profile real-wazuh up -d wazuh-manager   # 官方 4.14.7 镜像 digest 钉，宿主 15500
pnpm wazuh:feed                                           # fixture 灌真引擎 PUT /logtest，真回包回推 webhook 正门
docker compose --profile real-wazuh stop wazuh-manager    # 用完即停（logtest 无状态，重跑幂等）
```

`pnpm replay` 推的是手造 fixture；`pnpm wazuh:feed` 把同一批 fixture 的 full_log 喂进
真 Wazuh 规则引擎，由引擎重新判（如 ssh fixture 实测回 rule 5710 / level 5 /
MITRE T1110.001），判定为真告警的回包原样走 ingest webhook 正门——默认九服务
一个不碰，不 OPEN profile 时引擎与脚本都不存在。

### 可选：椒图狗粮形态（票 59，jiaotu profile 全外接；默认链路零改动）

把 soc-demo 的四件安全职能（LLM 代理/任务票铸发/审批铸票/焚毁账本）在**运行面**
整体交棒给治理网关椒图（agentjiaotu 仓）——`docker compose up -d` 的九服务拓扑
**一字不动**；jiaotu 形态用 overlay 双件套表达（单文件 profile 只能加服务不能减，
`docker-compose.jiaotu.yml` 以 `!reset null` 删内部 gateway 并重写依赖图）：

```bash
# up（jiaotu-gateway 构建上下文来自 agentjiaotu 检出；worktree 里先在 .env 设
# JIAOTU_REPO_PATH 指向主工作区检出，见 .env.example）
docker compose -f docker-compose.yml -f docker-compose.jiaotu.yml --profile jiaotu up -d --build
pnpm jiaotu:register --url http://localhost:8080          # 注册 soc-demo，api_key 落 .env
JIAOTU_GATEWAY_URL=http://jiaotu-gateway:8080 AGENT_LLM=real SOC_LLM_PROXY_URL=http://jiaotu-gateway:8080 \
  docker compose -f docker-compose.yml -f docker-compose.jiaotu.yml --profile jiaotu up -d agent
bash scripts/setup-openfga.sh && pnpm replay              # FGA 世界 + 回放（同默认形态）
# down（-f 对要成对给，否则残留 jiaotu 侧容器）
docker compose -f docker-compose.yml -f docker-compose.jiaotu.yml --profile jiaotu down
```

六幕验收冒烟：`bash scripts/jiaotu-smoke-11.sh`（幂等：自动 down -v + 清运行态数据；
默认 fake LLM=upstream-stub 假上游不出网；`--real-llm` 真网可选，需
`JIAOTU_LLM_UPSTREAM`/`JIAOTU_UPSTREAM_AUTHORIZATION`/`SECRETS_LLM_API_KEY` 三把钥匙）。

**诚实边界（票 59，裁决 Q7；①已由票 17 收口）**：①椒图的 `/internal/*` 口（任务票
mint/burn、审批申报）**已统一 Bearer agent api_key 认证**（椒图票 17，2026-09-11：本仓
出站三 adapter 全带 `authorization` 头，key=env `JIAOTU_API_KEY`）——残余边界在网络层与
key 分发面：jiaotu-gateway 只 publish 8080 公开面一个口，internal 口与公开面同口同源
（椒图单端口产品形态，未额外 publish），同一 Docker 网络里的任何容器仍能直呼这些口，
而凡拿到 `JIAOTU_API_KEY` 的容器即持该 agent 身份——key 经 `.env`/compose env 进容器，
分发面按信任边界管理；网络层隔离加固记椒图 M2（其 README 诚实边界 6 同口径）。②jiaotu
形态的 LLM 上游默认是 upstream-stub（确定性伪 LLM，`deploy/jiaotu/fake-llm-upstream.mjs`），
真网是**可选**环节（`--real-llm`），钥匙经环境注入、绝不进仓库；手工真网（不走冒烟脚本）
需在 env 给足资源预算三键 `LLM_TIMEOUT_MS=300000`/`MAX_STEPS=40`/`MAX_TOKENS_PER_RUN=200000`
（真实推理模型的 investigation 单节点 23 次 LLM 调用，教学保守缺省会被 fail-closed/
budget_exceeded 强杀——口径见 `.env.example` 同名注释，票 96 转正）。③切回默认形态 =
上面的 down + unset `JIAOTU_GATEWAY_URL`/`JIAOTU_API_KEY` 再 `docker compose up -d`，
零残留。

---

## 🧪 压测与防线实验（Apple M4 单机，fake LLM，只同机比）

| 层 | 测了什么 | 结果 |
|---|---|---|
| B1 单端点 | 四热点微基准 | 写面 500/s 稳；**首个瓶颈=M2 读口 76 req/s**（全表扫+N+1，待修复票） |
| B3 分发水位 | 1→50 并发爬坡 | 净室 **4.6-4.8 run/s**（理论 10 的缺口=单 tick 内串行执行 106ms）；吞吐恒定延迟线性 |
| B2 链路 | burst 100/500 + 持续 2-8/s | ingest 无错误拐点（500 条秒灌 P99 51ms）；**链路积压分界 4↔6 alerts/s**，只延不丢；带写入水位收缩 ~3.4-3.9 run/s |
| B4 SSE 扇出 | 50/100/200 订阅者 vs 轮询 | 每订阅者 ~0.1% 容器 CPU，延迟钉 100ms tick；**SSE 快轮询 13-16×** |
| B5 防线压下 | 杀 guards / 停 gateway / SQLite 写锤 | fail-closed 全成立：零绕过（人均恰 3 DENIED 帧）、无"已批准无票"悬置态、写锤 C=64 零错误 p99 96ms |
| shedding | under-pressure 三腿对照 | 默认阈值不触发=健康；机制演示档 503 出现且服务存活压后恢复——保险丝被证明会跳 |

全表与复现命令：[docs/research/2026-09-12-压力测试报告.md](docs/research/2026-09-12-压力测试报告.md)，脚本在 `scripts/bench/`，教学版 [lessons/50](lessons/50-压力也是一种异常-防线在压下.md)。**一句话总论：四个天花板压到底没有一处"崩"，全是"排队"和"拒绝"。**

---

## 🔒 安全声明

本仓为个人学习与研究用途：soc-demo 是**教学演示系统，不是生产可用的 SOC 产品**——量级为单机演示（fake LLM 确定性可复现），PII 一律假数据，密钥经环境注入绝不进仓库，压测数字只同机比、不当生产 SLO。安全机制用于学习"怎么设计"，不替代真实 SOC 的运营合规要求。

---

## 📄 文档地图

- PRD v1.1（冻结+变更记录）：`../deliverables/route5/product-handbook.md`
- 模块划分：`specs/modules.md`
- 术语表：`CONTEXT.md`
- 编排循环 spec（验收 T01-T23 真源）：`specs/orchestration-loop.md`
- 架构决策：`docs/adr/`
- 架构图：`docs/architecture-v4.html`（点节点跳详情页 `docs/nodes/`）；M1-M12 内部结构图 `docs/architecture-m*-internal.html`
- 教学场景：`lessons/scenario/00-导览总纲.md`（13 场景总入口）+ `lessons/scenario/0-0.md`（全景地图：编制表/常驻循环/全局数字）
- 节点注解源文件：`docs/arch-notes.json`（改注解改它，改完跑 `node scripts/inject-arch-notes.mjs`；archify 重出主图后也要重跑一次）
