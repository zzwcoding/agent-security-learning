# 03: m2 案件后端：六实体 + 状态机 + 审计 + outbox

**What to build:** 全系统数据地基：六实体 SQLite CRUD、状态机迁移（非法转移 409）、三结局、写操作审计拦截、outbox 事件出口、used_tokens 焚毁表。全部确定性代码无 LLM。

**Blocked by:** None (can start immediately)

**Touches modules:** `m2`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 六实体 REST CRUD 全过（源：m2 卡公开接口·PRD §6-M2 REST 面）
- [ ] 状态机迁移表全组合：非法转移 100% 409 InvalidTransition（源：m2 卡测试计划·INV-10）
- [ ] 三结局具名 fixture：成新案/并入旧案（observables 复制+源 alert 置 Imported）/关案缺 verdict 409（源：m2 卡测试计划·PRD FR-M2.2）
- [ ] 任意写操作后 audit_entries 存在对应 diff 条目（源：m2 卡测试计划·INV-8）
- [ ] used_tokens 焚毁表就位、jti 唯一（源：m9 卡依赖·焚毁表放 M2 决策）
- [ ] alert.created 写后事件可从 outbox 轮询消费（源：m2 卡公开接口·EventBus seam）
- [ ] 内存 SQLite adapter 供单测（源：m2 卡 Seam）
