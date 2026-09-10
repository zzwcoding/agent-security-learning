// list_approvals · 审批台账查询（场景 7 落地的第一个新工具）。
//
// 出身：票 48 gen:tool 脚手架生成的空壳（`pnpm gen:tool list_approvals --tier L1
// --family readonly_query --owner m3`），7.2 把"一句话空壳"换成真逻辑——agent 库
// approvals 表（票 11 审批卡）的台账读口。登记行在 fixtures/tools.manifest.json
// （tier=L1）：只读但按更严口径过任务票，不做免验（get_case 同款先例）。
//
// 安全语义（三条都落在结构上，不靠自觉）：
//   - 物理只读：better-sqlite3 以 readonly 打开——handler 想写也写不进（钥匙就没给）；
//   - 数据最小化：台账只吐 id/tool/status/case_id/reason/created_at 六个台账字段，
//     params/params_hash/token_jti 等卡面细节不出读口（审批卡 params 可能带 L2 草稿全文，
//     场景 3/5 的 kb 草稿就是先例——台账是"有哪些卡"，不是"卡上写了什么"）；
//   - fail-closed：库打不开（路径错/文件缺）直接抛——读台账的病不许伪装成"空台账"；
//     status 白名单外的过滤值当场拒绝，SQL 一律 prepared statement（参数不拼串）。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** 缺省数据源：agent 服务自持库（compose 挂 ./data/agent:/app/data，票 41 口径）。 */
export const DEFAULT_AGENT_DB = fileURLToPath(
  new URL("../../../data/agent/agent.sqlite", import.meta.url),
);

const STATUSES = new Set(["pending", "approved", "rejected", "expired"]);

export interface ListApprovalsResult {
  /** 过滤后的台账总数（分页的 total，不是截断后的行数）。 */
  total: number;
  approvals: {
    id: string;
    tool: string;
    status: string;
    case_id: string | null;
    reason: string | null;
    created_at: number;
  }[];
}

/** 审批台账查询：按状态过滤（可选）、按创建时间倒序，limit 夹在 1..100。 */
export async function list_approvals(
  params: Record<string, unknown> = {},
): Promise<ListApprovalsResult> {
  const dbPath =
    typeof params.dbPath === "string" && params.dbPath ? params.dbPath : DEFAULT_AGENT_DB;
  const status = typeof params.status === "string" && params.status ? params.status : undefined;
  if (status !== undefined && !STATUSES.has(status)) {
    throw new Error(`bad_status:${status}（只认 pending/approved/rejected/expired）`);
  }
  const rawLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 20;
  const limit = Math.min(Math.max(Math.floor(rawLimit), 1), 100);
  if (!existsSync(dbPath)) throw new Error(`db_not_found:${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = (
      status
        ? db.prepare(
            `SELECT id, tool, status, case_id, reason, created_at FROM approvals
              WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
        : db.prepare(
            `SELECT id, tool, status, case_id, reason, created_at FROM approvals
              ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
    ).all(...(status ? [status, limit] : [limit])) as Record<string, unknown>[];
    const count = (
      status
        ? db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = ?`).get(status)
        : db.prepare(`SELECT COUNT(*) AS n FROM approvals`).get()
    ) as { n: number };
    return {
      total: count.n,
      approvals: rows.map((r) => ({
        id: r.id as string,
        tool: r.tool as string,
        status: r.status as string,
        case_id: (r.case_id as string | null) ?? null,
        reason: (r.reason as string | null) ?? null,
        created_at: r.created_at as number,
      })),
    };
  } finally {
    db.close();
  }
}
