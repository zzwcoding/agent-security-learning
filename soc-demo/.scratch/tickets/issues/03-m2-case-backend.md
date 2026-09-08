# 03: m2 案件后端：六实体 + 状态机 + 审计 + outbox

**What to build:** 全系统数据地基：六实体 SQLite CRUD、状态机迁移（非法转移 409）、三结局、写操作审计拦截、outbox 事件出口、used_tokens 焚毁表。全部确定性代码无 LLM。

**Blocked by:** None (can start immediately)

**Touches modules:** `m2`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 六实体 REST CRUD 全过（源：m2 卡公开接口·PRD §6-M2 REST 面）
- [x] 状态机迁移表全组合：非法转移 100% 409 InvalidTransition（源：m2 卡测试计划·INV-10）
- [x] 三结局具名 fixture：成新案/并入旧案（observables 复制+源 alert 置 Imported）/关案缺 verdict 409（源：m2 卡测试计划·PRD FR-M2.2）
- [x] 任意写操作后 audit_entries 存在对应 diff 条目（源：m2 卡测试计划·INV-8）
- [x] used_tokens 焚毁表就位、jti 唯一（源：m9 卡依赖·焚毁表放 M2 决策）
- [x] alert.created 写后事件可从 outbox 轮询消费（源：m2 卡公开接口·EventBus seam）
- [x] 内存 SQLite adapter 供单测（源：m2 卡 Seam）

---

## 实现记录（2026-09-08）

**产物**：`services/case-backend/src/` 四件——`db.ts`（8 张表 DDL：六实体 + outbox_events +
used_tokens；WAL + busy_timeout 5s）、`statemachine.ts`（迁移表唯一来源=CONTEXT.md 语义
核心；InvalidTransitionError）、`store.ts`（深模块：六实体 CRUD、三结局、审计同事务落库、
outbox、焚毁表）、`app.ts`（REST 薄装配）；`m2.test.ts` 29 测试 + 骨架 healthz = 30 全绿。
依赖：better-sqlite3 13（根 package.json 增 `pnpm.onlyBuiltDependencies` 放行原生构建，
CI frozen install 同样生效）。

**扩展路由（PRD 面之外，均有必要性和票内依据）**：
- `GET /api/v1/cases/:id` 案件详情（含 observables/tasks/timeline）——三结局「数据转移
  完整」验收要有读取口；
- `POST /api/v1/alerts/:id/reopen`——FR-M2.1「Closed 可重开（记审计）」是状态机合法
  流转，必须有入口；
- `GET /api/v1/events?after=`——outbox 轮询出口，验收要求事件「可从 outbox 轮询消费」；
- `POST/GET /internal/used-tokens`——焚毁表读写口给 m9（票 07/08），避免有表无路
  （数据流断裂）；重复登记 jti → 409 jti_exists（INV-2 唯一性）。

**契约裁决**：
- `PATCH /cases/:id` 带 `status:"Closed"` → 409 verdict_required（关案必须走 /close 带
  verdict，防旁路）；已 Closed 的 case 再 PATCH → 409 InvalidTransition（终态冻结）。
- 并入旧案要求 alert 已 InProgress（New→Imported 非法）：测试先走一次成新案再 merge。
- merge 语义照 TheHive：observables **复制**（新行挂 case_id，保留 source_alert_id 链）、
  tags 并入去重、linked_alerts 追加、目标 case 加系统时间线条目。
- actor/requestId 从 `x-actor-id`/`x-request-id` 头取（M2 信任内网调用方，PRD 职责边界）。

**测试矩阵口径**：alert 16 格中「变回 New」4 格无对应动作可试，跳过 → 12 格；case 9 格
同理 → 6 格。每格 = 把实体开到 from 状态，再试指向 to 的动作，断言放行/409 与
CONTEXT.md 迁移表逐格一致。

**踩坑**：InvalidTransitionError 起初没带 `httpStatus/code`，Fastify 错误处理器
`reply.status(undefined)` → 500 `FST_ERR_BAD_STATUS_CODE`——错误类必须自带 HTTP 映射，
否则 INV-10 的 409 全变 500。

**验证**：case-backend 30/30 绿、tsc --noEmit 过、eslint 过、全仓 TS 三连绿、spec gate
PASS（同前 6 条规划警告）；真服务冒烟 :3002（healthz / 空查询 / 手工建案 case_000001 /
文件库落 data/case-backend.sqlite）后已关停清库。CI 首次推送时留意 better-sqlite3 在
ubuntu 的预编译下载（本地 darwin arm64 已验证）。
