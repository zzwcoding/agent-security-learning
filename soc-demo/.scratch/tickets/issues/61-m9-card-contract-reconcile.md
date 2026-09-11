# 61-m9-card-contract-reconcile: m9 卡接口契约对账修复（体检 #1/#2）

**What to build:** 阶段 7 体检（2026-09-12）接口契约对账的两条 P2 卡面修复，纯 specs/modules.md 账面，零代码：①幽灵接口上卡——`POST /pii/reveal`（guards）+ `POST /api/v1/pii/reveal`（agent 代理）实现有卡上无（票 49 交付），m9 公开接口补两行，注明"审计只记查询不记原文"口径（票 49 既有行为）；②狗粮新增面上卡——approve/reject 行改"内部模式铸票调 gateway / 外部模式经椒图中继（头 `x-approver-token`，INV-2 单口在 g4）"，补 approvals wire `external_id` 字段与 `buildApp` opts `approvalGateway` 注入 seam；依赖/外部补 env 条件外边 `jiaotu-gateway`（`JIAOTU_GATEWAY_URL` 设定时）。

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md（m9 卡）

**Blocked by:** 无

**Status:** done（2026-09-12 当票施工+主窗口验收：diff 仅 specs/modules.md，四处理入卡）

**验收：**
- [x] m9 公开接口含 pii 反查两行（guards+agent），与票 49 实现一致（guards app.py / agent app.ts 路由名逐字）
- [x] approve/reject 行双模式表述准确；external_id/approvalGateway/x-approver-token 三样在卡可 grep
- [x] 依赖/外部含 jiaotu-gateway（env 条件）；零代码改动（git diff 仅 specs/modules.md）

**实现记录：**（2026-09-12 主窗口直改）①公开接口补 `POST /pii/reveal`（guards，并入 guards 行）+ `POST /api/v1/pii/reveal`（agent 代理独立行，注明 vite-proxy.test.ts 机器锁定、审计只记查询不记原文）；②审批卡 REST 行改双模式表述（内部铸票调 gateway/外部椒图中继 + x-approver-token 头 + INV-2 单口 + wire external_id）；③依赖/外部补 jiaotu-gateway（env 条件）；④备注补"外部模式装配面"行（approvalGateway seam/申报对账中继 G9 四路共用、接口立在领域模块 approvals.ts）。
