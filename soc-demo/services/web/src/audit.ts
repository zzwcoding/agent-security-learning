// 审计流（FR-M10.5「实时滚动 + 按 requestId/case 过滤」）的客户端合并逻辑。
// 审计面没有全局 SSE——后端审计真相在 M2 audit_entries（INV-8），公开查询口
// GET /api/v1/audit（支持 requestId/objectId 服务端过滤）。实时滚动 = 定时轮询 +
// 本模块按 id 去重合并（audit id 是 UUID，无自增游标，只能集合去重）。
import type { AuditRow } from "./api";

export type { AuditRow };

/** 把新拉回的条目并进已有列表：id 去重 → createdAt 降序（新到在上）。 */
export function mergeAudit(existing: AuditRow[], incoming: AuditRow[]): AuditRow[] {
  const seen = new Set(existing.map((r) => r.id));
  const fresh = incoming.filter((r) => !seen.has(r.id));
  return [...existing, ...fresh].sort((a, b) => b.createdAt - a.createdAt);
}
