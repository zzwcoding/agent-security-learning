// 票 73 · m2 假设实体（第七实体，kb.ts 同款套路：账面 + 状态机 + 审计同事务 + outbox）。
//
// 编排循环（m14）的输入/结论账面归案件后端（m2 卡面新增：假设 CRUD 读面 + 轮次归集段，
// 页面映射「狩猎页」三行）。这里管四件事：
//   1. 发起：POST /api/v1/hypotheses 置 proposed，并在【同一事务】发 outbox
//      hypothesis.created（行为约定 1 的「同事务口径」——拉起信号与账面变更原子）；
//   2. 状态机：五态 proposed→hunting→concluded/refuted/cancelled（CONTEXT.md 语义核心），
//      一切迁移过 assertTransition，表外变更 409（INV-10）；hunting 是循环驱动的迁移，
//      concluded/refuted/cancelled 由编排循环经 PATCH 落账；
//   3. 取消：POST :id/cancel 仅发起人 + 仅 hunting 态，原因取四因枚举；
//   4. 轮次归集：编排循环每轮 outcome 经 POST :id/rounds 落 {round_no, tasks[],
//      children[{run_id,status}], judge, gap}，(hypothesis_id, round_no) 唯一——
//      事件重放幂等替换（INV-6 同族）；GET 详情内嵌轮次段（页面映射「轮次视图」行）。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { assertTransition } from "./statemachine.js";
import { NotFoundError, type Ctx } from "./store.js";

/** 取消原因四因枚举（行为约定 3/10/11/12：planner 连坏 / 相邻轮防转 / 预算或超时 / 人取消）。 */
export const HYPOTHESIS_CANCEL_REASONS = ["user_cancelled", "planner_broken", "spin", "budget"] as const;
export type HypothesisCancelReason = (typeof HYPOTHESIS_CANCEL_REASONS)[number];

/** hypothesis 状态全集（与 statemachine TRANSITIONS.hypothesis 同源，薄口枚举拦 400 用）。 */
export const HYPOTHESIS_STATUSES = ["proposed", "hunting", "concluded", "refuted", "cancelled"] as const;

export class HypothesisForbiddenError extends Error {
  readonly code = "hypothesis_forbidden";
  readonly httpStatus = 403;
  constructor(reason: string) {
    super(`hypothesis_forbidden: ${reason}`);
    this.name = "hypothesis_forbidden";
  }
}

export class HypothesisInvalidError extends Error {
  readonly code = "hypothesis_invalid";
  readonly httpStatus = 400;
  constructor(reason: string) {
    super(`hypothesis_invalid: ${reason}`);
    this.name = "hypothesis_invalid";
  }
}

export interface HypothesisInput {
  template_id?: string;
  text: string;
  proposed_by?: string;
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

function mapHypothesis(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    // hypothesis_id 与 id 双键出线：spec m2 接口定义 POST → 201 {hypothesis_id}
    id: row.id,
    hypothesis_id: row.id,
    template_id: row.template_id ?? "",
    text: row.text,
    status: row.status,
    proposed_by: row.proposed_by ?? "",
    cancel_reason: row.cancel_reason ?? null,
    created_at: row.created_at,
    decided_at: row.decided_at ?? null,
  };
}

function recordAudit(
  db: DB,
  ctx: Ctx,
  action: string,
  objectId: string,
  details: unknown,
  result = "SUCCESS",
): void {
  db.prepare(
    `INSERT INTO audit_entries (id, action, actor, object_id, object_type, details, request_id, result, created_at)
     VALUES (?, ?, ?, ?, 'hypothesis', ?, ?, ?, ?)`,
  ).run(randomUUID(), action, j(ctx.actor), objectId, j(details), ctx.requestId, result, nowMs());
}

function emitEvent(db: DB, topic: string, payload: unknown): void {
  db.prepare(
    "INSERT INTO outbox_events (topic, payload, created_at) VALUES (?, ?, ?)",
  ).run(topic, j(payload), nowMs());
}

function requireHypothesisRow(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`hypothesis ${id}`);
  return row;
}

/** 发起假设（proposed）。text 必填非空；outbox hypothesis.created 与建档同事务——
 *  拉起 hunt_flow 的信号不会出现在「账面还没落」的库里（行为约定 1 同事务口径）。 */
export function createHypothesis(
  db: DB,
  input: HypothesisInput,
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    if (!input.text?.trim()) throw new HypothesisInvalidError("text_required");
    const id = `hyp_${randomUUID()}`;
    db.prepare(
      `INSERT INTO hypotheses (id, template_id, text, status, proposed_by, created_at)
       VALUES (?, ?, ?, 'proposed', ?, ?)`,
    ).run(id, input.template_id ?? "", input.text, input.proposed_by ?? ctx.actor.id, nowMs());
    recordAudit(db, ctx, "create", id, {
      created: { template_id: input.template_id ?? "", proposed_by: input.proposed_by ?? ctx.actor.id },
    });
    emitEvent(db, "hypothesis.created", { hypothesisId: id, templateId: input.template_id ?? "" });
    return mapHypothesis(requireHypothesisRow(db, id)) as Record<string, unknown>;
  })();
}

/** 状态迁移唯一写口（编排循环驱动：hunting/concluded/refuted/cancelled）。
 *  状态机外变更抛 InvalidTransitionError → 409（INV-10）；迁移与审计同事务（INV-8）。 */
export function transitionHypothesis(
  db: DB,
  id: string,
  to: string,
  opts: { reason?: string } = {},
  ctx: Ctx = { actor: { type: "agent", id: "agent:hunt_flow" }, requestId: randomUUID() },
): Record<string, unknown> {
  return db.transaction(() => {
    if (!(HYPOTHESIS_STATUSES as readonly string[]).includes(to)) {
      throw new HypothesisInvalidError(`unknown_status: ${to}`);
    }
    const row = requireHypothesisRow(db, id);
    assertTransition("hypothesis", row.status as string, to); // 表外迁移 → 409
    const terminal = to === "concluded" || to === "refuted" || to === "cancelled";
    db.prepare(
      `UPDATE hypotheses SET status = ?,
        cancel_reason = CASE WHEN ? = 'cancelled' THEN ? ELSE cancel_reason END,
        decided_at = CASE WHEN ? THEN ? ELSE decided_at END
       WHERE id = ?`,
    ).run(to, to, to === "cancelled" ? (opts.reason ?? null) : null, terminal ? 1 : 0, nowMs(), id);
    recordAudit(db, ctx, "transition", id, {
      status: { from: row.status, to },
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    return mapHypothesis(requireHypothesisRow(db, id)) as Record<string, unknown>;
  })();
}

/** 人取消（POST :id/cancel，行为约定 12）：仅发起人 + 仅 hunting 态 + 四因枚举。
 *  发起人比对在 store 层（薄口只拦枚举/必填）——403 与 409 的裁决在这里。 */
export function cancelHypothesis(
  db: DB,
  id: string,
  d: { by?: string; reason?: string },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const row = requireHypothesisRow(db, id);
    if ((row.proposed_by as string) && d.by && d.by !== row.proposed_by) {
      throw new HypothesisForbiddenError("cancel_only_by_owner");
    }
    const reason = d.reason ?? "user_cancelled";
    if (!(HYPOTHESIS_CANCEL_REASONS as readonly string[]).includes(reason)) {
      throw new HypothesisInvalidError(`cancel_reason 必须是 ${HYPOTHESIS_CANCEL_REASONS.join("/")}`);
    }
    assertTransition("hypothesis", row.status as string, "cancelled"); // proposed/终态 → 409
    db.prepare(
      "UPDATE hypotheses SET status = 'cancelled', cancel_reason = ?, decided_at = ? WHERE id = ?",
    ).run(reason, nowMs(), id);
    recordAudit(db, ctx, "cancel", id, {
      status: { from: row.status, to: "cancelled" },
      reason,
      by: d.by ?? ctx.actor.id,
    });
    return mapHypothesis(requireHypothesisRow(db, id)) as Record<string, unknown>;
  })();
}

// ---------- 轮次归集 ----------

export interface HypothesisRoundInput {
  round_no: number;
  tasks?: unknown;
  children?: unknown;
  judge?: unknown;
  gap?: unknown;
}

/** 落一轮归集（编排循环 outcome 经公开写口调）。(hypothesis_id, round_no) 唯一：
 *  重放/重报同轮幂等替换、不产生第二行（INV-6 同族）。 */
export function recordHypothesisRound(
  db: DB,
  hypothesisId: string,
  round: HypothesisRoundInput,
  ctx: Ctx,
): { round: Record<string, unknown>; dedup: boolean } {
  return db.transaction(() => {
    requireHypothesisRow(db, hypothesisId);
    if (!Number.isInteger(round.round_no) || (round.round_no as number) < 1) {
      throw new HypothesisInvalidError("round_no_positive_integer_required");
    }
    const existing = db
      .prepare("SELECT id FROM hypothesis_rounds WHERE hypothesis_id = ? AND round_no = ?")
      .get(hypothesisId, round.round_no) as { id: string } | undefined;
    const id = existing?.id ?? `hrnd_${randomUUID()}`;
    db.prepare(
      `INSERT INTO hypothesis_rounds (id, hypothesis_id, round_no, tasks, children, judge, gap, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hypothesis_id, round_no)
       DO UPDATE SET tasks = excluded.tasks, children = excluded.children,
                     judge = excluded.judge, gap = excluded.gap`,
    ).run(
      id, hypothesisId, round.round_no,
      j(round.tasks ?? []), j(round.children ?? []),
      round.judge === undefined ? null : j(round.judge),
      round.gap === undefined ? null : j(round.gap),
      nowMs(),
    );
    recordAudit(db, ctx, existing ? "update" : "create", id, {
      hypothesis_id: hypothesisId,
      round_no: round.round_no,
      dedup: !!existing,
    });
    return { round: mapRound(requireRoundRow(db, id)) as Record<string, unknown>, dedup: !!existing };
  })();
}

function requireRoundRow(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM hypothesis_rounds WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`hypothesis_round ${id}`);
  return row;
}

function mapRound(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    round_no: row.round_no,
    tasks: pj<unknown[]>(row.tasks as string, []),
    children: pj<unknown[]>(row.children as string, []),
    judge: pj(row.judge as string, null),
    gap: pj(row.gap as string, null),
    created_at: row.created_at,
  };
}

// ---------- 读面（m2 卡面新增两条查询面） ----------

export function listHypotheses(
  db: DB,
  filter: { status?: string } = {},
): Record<string, unknown>[] {
  const rows = filter.status
    ? db.prepare("SELECT * FROM hypotheses WHERE status = ? ORDER BY created_at DESC, rowid DESC").all(filter.status)
    : db.prepare("SELECT * FROM hypotheses ORDER BY created_at DESC, rowid DESC").all();
  return (rows as Record<string, unknown>[]).map((r) => mapHypothesis(r) as Record<string, unknown>);
}

/** 详情 = 账面行 + 轮次归集段（每轮 {round_no, tasks[], children[{run_id,status}], judge, gap}）。 */
export function getHypothesisDetail(db: DB, id: string): Record<string, unknown> | null {
  const hyp = mapHypothesis(db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined);
  if (!hyp) return null;
  hyp.rounds = (
    db.prepare("SELECT * FROM hypothesis_rounds WHERE hypothesis_id = ? ORDER BY round_no").all(id) as
      Record<string, unknown>[]
  ).map((r) => mapRound(r));
  return hyp;
}
