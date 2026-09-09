# 34-m2-burn-registry-live: 焚毁表跨进程读口接通（G2-1，安全置顶）

**What to build:** verify-ticket.ts 生产装配的 used 读口从 MemoryBurnRegistry 换成 M2 真相：agent 生产路径接 case-backend /internal/used-tokens（票 03 已有 POST/GET），跨进程 ApprovalToken 重放第二次必 403 token_used（不再只靠 executed_at+TTL 兜底）；读口不可达 fail-closed（INV-1）；app.test 补跨实例重放断言。

**Blocked by:** 28

**Touches modules:** `m2`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] 生产 verifyTicket 焚毁读口查 M2 真相，跨进程重放 403 token_used（源：遗留标记 11-1·INV-2）
- [ ] 读口不可达 fail-closed 拒绝执行（源：INV-1）
- [ ] 性能仍在验证预算内（票 07 ≤5ms 口径复核）（源：m9 卡测试计划）
