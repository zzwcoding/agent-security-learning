# SOC 数字员工（soc-demo）

为被告警淹没的 SOC 提供一名"数字员工"：自动分诊告警、调查取证、沉淀知识，危险动作永远等人点头。

- 需求与验收口径：`specs/` 与 PRD（见下方文档地图）

## 启动（2026-09-09 实测口径）

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

## 文档地图

- PRD v1.1（冻结+变更记录）：`../deliverables/route5/product-handbook.md`
- 模块划分：`specs/modules.md`
- 术语表：`CONTEXT.md`
- 架构决策：`docs/adr/`
- 架构图：`docs/architecture-v4.html`（点节点跳详情页 `docs/nodes/`）；M1 内部结构图 `docs/architecture-m1-internal.html`
- 节点注解源文件：`docs/arch-notes.json`（改注解改它，改完跑 `node scripts/inject-arch-notes.mjs`；archify 重出主图后也要重跑一次）
