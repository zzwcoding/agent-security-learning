# 35-m2-audit-ingest: 审计汇入 M2 一弦：HttpAuditSink + FAILURE 审计 + INV-4 金丝雀（G2-2）

**What to build:** ① worker AuditSink 生产实现换 HttpAuditSink（FR-S5 两路汇入同一 audit_entries 表，票 10 线头）；② ingest webhook 层 FAILURE 审计补齐（票 09-3：畸形/校验失败进审计）；③ evals 补 m9 凭证金丝雀全链路断言（票 08-1：SECRETS 值除出站瞬间外 grep 不到——账面/事件/审计/时间线全可观测面）。

**Blocked by:** 28

**Touches modules:** `m2`, `m3`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** ready-for-agent

- [ ] worker 审计五要素落 M2 audit_entries（源：遗留标记 10-1·FR-S5·INV-8）
- [ ] webhook FAILURE 审计（源：遗留标记 09-3·PRD S1 异常与边界）
- [ ] evals 金丝雀全链路断言（源：遗留标记 08-1·INV-4）
