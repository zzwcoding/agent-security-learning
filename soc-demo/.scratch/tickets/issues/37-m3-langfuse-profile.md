# 37-m3-langfuse-profile: Langfuse observability profile 落地（B1）

**What to build:** docker-compose 增 langfuse 服务与 `profiles: [observability]`（ADR 0001 承诺兑现）；agent 审计/事件按可选 env 开关镜像到 Langfuse（不进默认链路）；文档口径对齐（ADR 0001/PRD v1.1 变更 1 引用本票）。

**Blocked by:** 28

**Touches modules:** `m3`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] compose profile observability 一键起 Langfuse（源：遗留 ADR 0001·对账一-1）
- [x] 默认链路零改动（不开 profile 行为不变）（源：ADR 0001 拍板）
- [x] 可选接通时 trace 可查（源：PRD C5 trace 收集）

## 实现记录（2026-09-09，编码窗口）

**① compose profile observability（验收①）**：`docker-compose.yml` 增 `langfuse` +
`langfuse-db` 双服务，都挂 `profiles: ["observability"]`（**成对挂**——只给主服务挂，
depends_on 的 healthcheck 会踢到铁板）。形态 = 官方 `langfuse/langfuse:2` 单镜像 +
postgres:17-alpine（v3 依赖栈 postgres+clickhouse+valkey+minio 违反水位线，PRD v1.1
变更 1 原文口径；v2 镜像 label 实测 = 2.95.11）。镜像按 **index digest** 钉：票 26 [26-1]
常设口径是钉 arm64 子 manifest，那是 ghcr+containerd store 的实证限制；Docker Hub 的
index digest 本机 daemon 实证可 pull 且 CI amd64 同用一枚（子 manifest 跨 arch 反而拉
不动），故此处钉 index、升级跟踪照 [26-2] 以 index 前进为准（出入备案）。宿主口 13000
（3000 高频占用，同 openfga 18080 口径）；`LANGFUSE_INIT_*` 首启自动种组织/项目/用户 +
教学假 key（`pk-lf-local-demo`/`sk-lf-local-demo`，与 .env.example/冒烟脚本同串）；
ENCRYPTION_KEY 固定教学值（换它 = 数据卷里已存 key 解不开）；TELEMETRY_ENABLED=false
（离线纪律）；healthcheck 用镜像自带 node 发 `/api/public/health` 探活（镜像无 wget/curl）。
机器断言：`services/agent/src/compose-topology.test.ts`（票 12 test_compose_topology.py
同类风格，落点按票面准许放 agent vitest，CI 的 pnpm test 原地跑）——静态：双服务存在 +
profiles 含 observability + digest 钉 + 不 build + agent env 穿透 + agent 不许 depends_on
langfuse（依赖会隐式激活 profile）；语义（docker 探测 skip 先例）：默认 config 恰好九服务
且不含 langfuse、开 profile 两个都在。

**② agent 可选镜像旁路（验收②默认零改动）**：新模块 `services/agent/src/langfuse.ts`——
`makeLangfuseMirror()` 以 `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`（+ 可选
`LANGFUSE_HOST`，缺省容器服务名）三把 env 钥匙当开关，**key 双空 = 返回 null，tap 不挂、
audit 保持原单 sink，与装本模块之前逐字节一致**。镜像面两处：`onEvent`（SSE 事件 → 每
run 一 trace，id = sha256("run:"+runId) 截 32 hex 确定性，事件为 point observation，
payload 原样进 metadata）+ `record`（审计五要素 → 独立 trace，id = hash(audit:requestId)，
DENIED/FAILURE 抬 WARNING、error 事件抬 ERROR）。出站 = HttpAuditSink 同款
fire-and-forget（POST `{host}/api/public/ingestion`，Basic 认证，2s 超时闸，失败只打
`warn=langfuse_mirror_failed`）；**不引 OpenTelemetry SDK / 官方 SDK（重件）**，刻意做薄：
不做 node span 配对与 LLM generation 面，真需要时在 send 换 span-create/generation-create，
wire 闸已在测试。接线最小化：`events.ts` emitEvent 末尾加默认 null 的 `setEventTap`
（tap 异常 try 包裹，旁路永不拖垮落库主链路）；`index.ts` 生产装配 key 缺 = 逐字节原样，
key 齐 = `TeeAuditSink([HttpAuditSink, 镜像])`（M2 真相源在前）+ 挂 tap。compose 侧 agent
穿三把 env（`${VAR:-}` 空缺省；HOST 缺省 `http://langfuse:3000`）。**出入备案**：v2.95.11
自托管 ingestion 实证收下 `externalId` 但落库恒 null（wire 照发无害），查询锚点 = 确定性
traceId + metadata.run_id/request_id。未动任何既有测试（默认链路零改动的可执行证明）。

**③ trace 可查（验收③）**：单测 19 例（env 开关/wire 形/去重/抬档/fire-and-forget/tap
隔离/Tee）+ 真容器冒烟 2 例（能力探测 skip 先例：POST 真 ingestion → GET
`/api/public/traces/{id}` 查回同一 trace；CI/未起栈显式 skip 打印原因）。真机三层验证：
`scripts/langfuse-smoke-37.sh`（默认 config 九服务断言 → profile 一键起 → 探活 → 跑
langfuse.test.ts 真容器例，全 PASS）；真 agent 进程整链（`AGENT_FLOW=approval_demo` 带
LANGFUSE env 本地起 index.ts → POST /internal/runs → run trace 查回 5 条观察
`audit.update`/`node_enter.response_advice`/`node_exit.response_advice`/
`node_enter.execute_action`/`approval_required.execute_action`，audit 独立 trace 同查回，
零 mirror 失败，case-backend 不可达时 audit_ingest_failed 降级日志符合口径）。

**④ 文档对齐**：ADR 0001 拍板行、PRD v1.1 变更 1、specs/modules.md §2 各补票 37 引用；
README 启动节后加「可选：Langfuse 观测 profile」段（五步实测口径未动）；.env.example 加
注释掉的 LANGFUSE 块（默认关——配了 key 不起容器只会徒增 warn）；教学文档
`lessons/37-01-Langfuse可选观测-profile-compose与镜像旁路.md`。

**门禁与基线（2026-09-09 实测）**：`python3 tools/check_specs.py` PASS（0 警告）；
`pnpm check:boundary` PASS（self-test 17/17，0 越界）；`pnpm test` 全绿——agent 381 passed
| 1 skipped（基线 357+1sk + 本票 24 新例，真容器 2 例随栈起跑）、case-backend 60、evals
97、ingest 37、web 82、mcp-audit 14（全部与基线持平）。本票文件 eslint 干净；HEAD 上
case-flow.test.ts 存在两处既有 unused-import lint error（票 36 遗留，非本票范畴未动）。
