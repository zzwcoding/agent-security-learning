# 06: m9 铸币 py 件：POST /internal/mint

**What to build:** gateway 自写 FastAPI 的铸币端：task_token.py 票型（HMAC-SHA256 自签）签任务票与 ApprovalToken。py 侧契约测试全过 fixtures/tickets/。

**Blocked by:** 02

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] POST /internal/mint 签任务票/ApprovalToken（源：m9 卡公开接口·PRD §6-M9）
- [ ] 票型 HMAC-SHA256 + scope + exp + 任务绑定，TTL 900s（源：ADR 0001·决策记录 #3）
- [ ] py 侧对 fixtures/tickets/ 五类票面契约测试全过（源：m9 卡 Seam·票 02 产物）
- [ ] ApprovalToken 绑定参数 hash，改参数即失效（源：PRD FR-S2.2·INV-2）
