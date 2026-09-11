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

**诚实边界（票 59，裁决 Q7）**：①椒图的 `/internal/*` 口（任务票 mint/burn、审批申报）
在跨项目 compose 网内**无认证**——jiaotu-gateway 只 publish 8080 公开面一个口，internal
口与公开面同口同源（椒图单端口产品形态，未额外 publish），但同一 Docker 网络里的任何
容器都能直呼它们；网络层隔离加固记椒图 M2（其 README 诚实边界 6 同口径）。②jiaotu
形态的 LLM 上游默认是 upstream-stub（确定性伪 LLM，`deploy/jiaotu/fake-llm-upstream.mjs`），
真网是**可选**环节（`--real-llm`），钥匙经环境注入、绝不进仓库。③切回默认形态 =
上面的 down + unset `JIAOTU_GATEWAY_URL`/`JIAOTU_API_KEY` 再 `docker compose up -d`，
零残留。

## 文档地图

- PRD v1.1（冻结+变更记录）：`../deliverables/route5/product-handbook.md`
- 模块划分：`specs/modules.md`
- 术语表：`CONTEXT.md`
- 架构决策：`docs/adr/`
- 架构图：`docs/architecture-v4.html`（点节点跳详情页 `docs/nodes/`）；M1 内部结构图 `docs/architecture-m1-internal.html`
- 节点注解源文件：`docs/arch-notes.json`（改注解改它，改完跑 `node scripts/inject-arch-notes.mjs`；archify 重出主图后也要重跑一次）
