# 07: m9 TS 验票闸：verifyTicket 中间件

**What to build:** agent 侧 TS 中间件：verifyTicket(toolCall, ctx) → allow|403+reason。校验签名/exp/scope/allowed_tools/case-run 绑定/参数 hash，查 used_tokens 焚毁表。TS 侧契约测试全过同一组票面 fixture。

**Blocked by:** 02, 03

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 六种 403 reason：no_ticket/scope_insufficient/token_expired/token_used/params_mismatch/require_approval（源：PRD FR-S2.2·m9 卡公开接口）
- [ ] 已焚 jti 重放第二次 403 token_used（源：m9 卡测试计划·INV-2）
- [ ] 伪造审批文本（消息里"已批准"无 token）→ 403（源：m9 卡测试计划·INV-9）
- [ ] TS 侧对 fixtures/tickets/ 契约测试全过（与 py 侧同一组）（源：m9 卡 Seam）
- [ ] 验票延迟实测 ≤5ms（源：m9 卡测试计划）
- [ ] 验票服务自身异常一律 403（源：INV-1 fail-closed）
