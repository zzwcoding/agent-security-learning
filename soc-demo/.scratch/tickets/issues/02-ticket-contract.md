# 02: 跨语言票面契约 fixtures/tickets/

**What to build:** 任务票/ApprovalToken 的固定票面 fixture（合法、过期、scope 不足、参数篡改、已焚毁 jti 五类）+ 期望验票结果表 + 测试密钥约定。py 签发侧与 TS 验票侧的共同"法律"，防两端实现漂移。

**Blocked by:** None (can start immediately)

**Touches modules:** `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 五类票面 fixture + 期望验票结果表就位（源：m9 卡 Seam·跨语言共享 fixtures/tickets/ 契约）
- [ ] 票面字段照 PRD §5.8/§5.9（jti/sub/case_id/run_id/scope/allowed_tools/iat/exp/sig）（源：PRD §5.8 Ticket / §5.9 ApprovalToken）
- [ ] README 写明测试固定密钥与两端消费方式（源：ADR 0001 搬票型不搬代码）
