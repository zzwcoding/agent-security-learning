// m7 知识沉淀 · KBEntry 账面（票 17）。数据归属案件后端（m7 卡决策「REST 面挂 M2——
// 数据归属案件后端，agent 侧只出提炼子图」），这里管三件事：
//   1. 提案入库：agent 提炼子图经 POST /api/v1/kb/proposals 建档（proposed）；
//   2. 人审裁决：approve/reject 走 kbentry 状态机（proposed→approved/rejected，
//      INV-5 人审是唯一通道；表外/重复裁决 409，INV-10），审计同事务（INV-8）；
//   3. 记录查询面：GET /api/v1/kb/search 只吐 approved（PRD §6-M7）。
// 注意两个面的分工：本文件是 SQLite 账面（人可读的记录与状态）；**向量检索面在
// agent 侧 chroma**（workers/knowledge/vector-store.ts）。chroma 的写入唯一入口是
// agent 侧 kb_write（L2，ApprovalToken 正门，executeApproved）——M2 是叶子模块，
// 不依赖 chroma；「approved 进检索面」由 kb_write 动作串起来（先 M2 approve 留痕，
// 再 chroma upsert），INV-5 由写入路径结构性保证。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { assertTransition } from "./statemachine.js";
import { NotFoundError, type Ctx } from "./store.js";

/** PRD §5.10 kind 枚举：FP 模式 / 处置经验 runbook / 内网环境事实（M507/HolmesGPT）。 */
export const KB_KINDS = ["fp_pattern", "runbook", "env_fact"] as const;
export type KbKind = (typeof KB_KINDS)[number];

export class KbInvalidError extends Error {
  readonly code = "kb_invalid";
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`kb_invalid: ${reason}`);
    this.name = "kb_invalid";
  }
}

export interface KbProposalInput {
  kind: string;
  title: string;
  body: string;
  tags?: string[];
  source_case_id?: string | null;
  proposed_by: string;
}

const nowMs = () => Date.now();
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

function mapKb(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: pj<string[]>(row.tags as string, []),
    source_case_id: row.source_case_id ?? null,
    status: row.status,
    proposed_by: row.proposed_by,
    reviewed_by: row.reviewed_by ?? null,
    reject_reason: row.reject_reason ?? null,
    created_at: row.created_at,
    decided_at: row.decided_at ?? null,
    expires_at: row.expires_at ?? null,
  };
}

function recordAudit(
  db: DB,
  ctx: Ctx,
  action: string,
  objectId: string,
  details: unknown,
): void {
  db.prepare(
    `INSERT INTO audit_entries (id, action, actor, object_id, object_type, details, request_id, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'SUCCESS', ?)`,
  ).run(randomUUID(), action, j(ctx.actor), objectId, "kb_entry", j(details), ctx.requestId, nowMs());
}

/** 提案建档（proposed）。ASP「Case 来源必须挂 case」：给了 source_case_id 就必须存在
 *  （404）；kind 出 §5.10 枚举 / title 或 body 空 → 400。这里只建档不进检索面——
 *  proposed 条目对 chroma 不可见（INV-5 的账面半边）。 */
export function createKbProposal(
  db: DB,
  input: KbProposalInput,
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    if (!(KB_KINDS as readonly string[]).includes(input.kind)) {
      throw new KbInvalidError(`kind 必须是 ${KB_KINDS.join("/")}`);
    }
    if (!input.title?.trim() || !input.body?.trim()) {
      throw new KbInvalidError("title_and_body_required");
    }
    if (input.source_case_id) {
      const c = db.prepare("SELECT id FROM cases WHERE id = ?").get(input.source_case_id);
      if (!c) throw new NotFoundError(`case ${input.source_case_id}`);
    }
    const id = `kb_${randomUUID()}`;
    db.prepare(
      `INSERT INTO kb_entries (id, kind, title, body, tags, source_case_id, status, proposed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    ).run(
      id, input.kind, input.title, input.body, j(input.tags ?? []),
      input.source_case_id ?? null, input.proposed_by, nowMs(),
    );
    recordAudit(db, ctx, "create", id, {
      created: { kind: input.kind, title: input.title, source_case_id: input.source_case_id ?? null },
    });
    return mapKb(db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as Record<string, unknown> | undefined) as Record<string, unknown>;
  })();
}

export function getKbProposal(db: DB, id: string): Record<string, unknown> | null {
  return mapKb(db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as Record<string, unknown> | undefined);
}

export function listKbProposals(
  db: DB,
  filter: { status?: string } = {},
): Record<string, unknown>[] {
  const rows = filter.status
    ? db.prepare("SELECT * FROM kb_entries WHERE status = ? ORDER BY created_at DESC, rowid DESC").all(filter.status)
    : db.prepare("SELECT * FROM kb_entries ORDER BY created_at DESC, rowid DESC").all();
  return (rows as Record<string, unknown>[]).map((r) => mapKb(r) as Record<string, unknown>);
}

/** 人审裁决（proposed → approved/rejected）。状态机在这里仲裁：只有 proposed 可裁决，
 *  终态再裁 409（INV-10）；actor 是人（reviewer，值班长），审计同事务（INV-8）。
 *  注意：approve 只翻账面状态——检索面（chroma）的写入由 agent 侧 kb_write 动作
 *  （ApprovalToken 正门）在本端点之后执行，见文件头「两个面的分工」。 */
export function decideKbProposal(
  db: DB,
  id: string,
  d: { approve: boolean; reviewer: string; reason?: string },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new NotFoundError(`kb_proposal ${id}`);
    const to = d.approve ? "approved" : "rejected";
    assertTransition("kbentry", row.status as string, to); // 终态再裁 → 409
    db.prepare(
      `UPDATE kb_entries SET status = ?, reviewed_by = ?, reject_reason = ?, decided_at = ? WHERE id = ?`,
    ).run(to, d.reviewer, d.approve ? null : (d.reason ?? null), nowMs(), id);
    recordAudit(db, ctx, d.approve ? "approve" : "reject", id, {
      status: { from: row.status, to },
      reviewer: d.reviewer,
      ...(d.approve ? {} : { reason: d.reason ?? null }),
    });
    return mapKb(db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id) as Record<string, unknown> | undefined) as Record<string, unknown>;
  })();
}

/** 记录查询面（PRD §6-M7 GET /api/v1/kb/search）：仅 approved，q 对 title/body 做
 *  LIKE，kind 精确过滤，k 缺省 5（决策记录 #6 top-k 口径）。这是给人/Web 看的
 *  账面查询；分诊/调查的向量检索走 agent 侧 chroma 检索面（ChromaKb）。 */
export function searchApprovedKb(
  db: DB,
  filter: { q?: string; kind?: string; k?: number } = {},
): Record<string, unknown>[] {
  const k = Math.min(Math.max(filter.k ?? 5, 1), 50);
  let sql = "SELECT * FROM kb_entries WHERE status = 'approved'";
  const params: unknown[] = [];
  if (filter.kind) {
    sql += " AND kind = ?";
    params.push(filter.kind);
  }
  if (filter.q) {
    sql += " AND (title LIKE ? OR body LIKE ?)";
    const like = `%${filter.q}%`;
    params.push(like, like);
  }
  sql += " ORDER BY created_at, rowid LIMIT ?";
  params.push(k);
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) =>
    mapKb(r) as Record<string, unknown>,
  );
}
