# 41-m3-compose-assembly: compose 装配小票：agent 数据卷 + SOC_HMAC_KEY 口径（B5+G2-10）

**What to build:** ① agent 服务挂 ./data/agent:/data 卷（票 10 实现记录承诺的卷，m3 卡杀进程重启演示在 compose 下成立）；② SOC_HMAC_KEY 部署口径：.env.example + compose 注释 + README（教学假值可跑、真值注入位明确）。

**Blocked by:** 28

**Touches modules:** `m3`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] compose up 后审批 interrupt 杀进程重启可恢复（源：遗留标记对账一-4·m3 卡测试计划）——2026-09-09 编码窗口落地，见下方记录
- [x] 铸票密钥装配口径成文（源：遗留标记 21-1）——2026-09-09 先行落地，见下方记录

### 2026-09-09 先行记录（演示会话；② 已落地，① 未动，状态保持 ready-for-agent）

compose 从零重建拉起实测撞出三处装配雷，当场修复并在此记账：

- **② 铸票密钥装配口径成文**：gateway/agent 两服务穿透 `SOC_HMAC_KEY: ${SOC_HMAC_KEY:-}`
  （不给默认值——缺失仍 fail-closed 拒铸票/拒登录，票 06 口径不变；此前 compose 完全没透，
  宿主机设了也进不了容器）+ 新增 `.env.example`（教学假值可跑、真值注入位注明、
  AGENT_LLM fake/real 切换口径）+ README「启动」一节（五步实测口径，替代旧"一键启动"行）。
  票 21 件下注「compose 网关现无 HMAC 注入，属环境装配项」就此闭合。
- **顺手修复（同装配域，超出本票原 What to build，记档免重蹈）**：
  1. ingest 服务缺 `CASE_BACKEND_URL` env → m2client 回退 `127.0.0.1:3002`，容器内指向
     ingest 自身，webhook 全量 500（404 时代为旧镜像，重建后暴露）；补
     `http://case-backend:3002` + `depends_on: case-backend healthy`。
  2. agent/case-backend Dockerfile 缺原生编译三件套：better-sqlite3 13 在 alpine/musl
     无预编译包（workspace `onlyBuiltDependencies` 已放行其构建脚本 → node-gyp 现场编译），
     镜像内无 python3/make/g++ 必炸；`apk add` 一行补齐。票 03 遗留「CI 留意
     better-sqlite3 预编译下载」的 docker 部分就地关闭（ubuntu CI 腿仍待首推观察）。
- **本机验证**：9 容器 healthy、setup-openfga.sh 幂等全绿、replay 12 条全 201、
  alert_flow SSE 全节点到 completed、选脸登录出会话、webhook 去重幂等。

### 2026-09-09 实现记录（编码窗口；① 落地，票面收口）

- **agent 数据卷**：compose agent 服务加 `./data/agent:/app/data`（RW bind mount）。
  **出入记档（票 10 承诺路径之误）**：票 10/票 41 What to build 写的 `./data/agent:/data`
  不成立——代码侧库路径是 `index.ts` 的 `new URL("../../../data/", import.meta.url)`，
  从 `services/agent/src/` 往上三级，容器内 WORKDIR=/app/services/agent → 解析到
  **/app/data**（同 case-backend 口径，先例照抄）；挂 /data 等于没挂（库照旧落容器层，
  服务无任何报错，重启照丢）。按现实挂载，`index.ts`/`db.ts` 两处陈旧 `/data` 注释
  就地修正。
- **TDD 先红后绿**：红 = `compose-topology.test.ts` 新增票 41 四条（agent 数据卷非只读
  挂载 / case-backend 对称 / FGA 两只读挂载不动 / `docker compose config` 渲染语义，
  daemon 探测 skipIf 先例）3 失败；绿 = compose 挂卷后 16/16。零删除。
- **真容器冒烟**（验收①证据）：新增 `scripts/agent-smoke-41.sh`（gateway/langfuse
  冒烟同款形态，daemon 不可用显式 SKIP）——最小栈 `up -d agent gateway case-backend`
  （guards/chroma/openfga 由 depends_on 带起，六容器 healthy）→ `AGENT_FLOW=approval_demo`
  经 /tmp override 注入（docker-compose.yml 一字不动，测的即交付形态）→ alert_flow
  挂起审批卡 → `docker compose restart agent` → 同一张卡（apr_ id 原样）回来、SSE 补发
  重启前 approval_required 事件（INV-7）→ approve 铸 ApprovalToken → resume →
  run completed + 卡 executed=true。实测全绿，容器已清理。
- **全量验证**：`python3 tools/check_specs.py` PASS（0 警告）；`pnpm check:boundary`
  PASS（0 越界）；`pnpm lint` / `pnpm -C services/agent typecheck` 绿；`pnpm test`
  全仓绿：agent **417+4sk**（基线 413+4sk，本票 +4）/ case-backend 60 / evals 99 /
  ingest 41+1sk / web 100 / mcp-audit 14。
- **教学**：lessons/41-01-compose数据卷-挂载落点与杀进程重启恢复.md。
- **范围边界**：README 启动节不动（票 41② 已写五步口径，数据卷属装配事实非操作步骤）；
  bash 注记一条：脚本 echo 里 `$VAR` 后紧跟全角括号会把多字节字符并进变量名
  （set -u 当场咬），变量一律 `${VAR}` 括起。
