# 41-m3-compose-assembly: compose 装配小票：agent 数据卷 + SOC_HMAC_KEY 口径（B5+G2-10）

**What to build:** ① agent 服务挂 ./data/agent:/data 卷（票 10 实现记录承诺的卷，m3 卡杀进程重启演示在 compose 下成立）；② SOC_HMAC_KEY 部署口径：.env.example + compose 注释 + README（教学假值可跑、真值注入位明确）。

**Blocked by:** 28

**Touches modules:** `m3`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] compose up 后审批 interrupt 杀进程重启可恢复（源：遗留标记对账一-4·m3 卡测试计划）
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
