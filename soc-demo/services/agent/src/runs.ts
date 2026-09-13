// run 实体存取（票 10 落点：m3 卡——编排侧自持 run 生命周期，不进 M2 六实体库）。
// INV-10：一切状态变更必须过 assertRunTransition；INV-8：ctx.audit 是必传参——
// 类型上不给「改状态不审计」留后门。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { assertRunTransition, type RunStatus } from "./statemachine.js";
import type { AuditSink } from "./audit.js";
import { NotFoundError } from "./errors.js";

export interface RunCtx {
  audit: AuditSink;
  requestId: string;
  actor?: { type: string; id: string };
}

export interface RunRow {
  id: string;
  kind: string;
  alertId: string;
  /** 票 17：knowledge_flow 的目标案件（alert_flow 为 null）。alert_id 列保持 NOT NULL，
   *  无告警上下文的 run 存空串——避免老库重建表（SQLite 去 NOT NULL 代价大）。 */
  caseId: string | null;
  /** 票 90：hunt_flow/hunt_task 的拉起实体（专用列在位，票 73 的 case_id 位承载清偿；
   *  旧 kind 恒 null）。 */
  hypothesisId: string | null;
  status: RunStatus;
  failReason: string | null;
  steps: number;
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
}

const nowMs = () => Date.now();

function mapRun(row: Record<string, unknown> | undefined): RunRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    kind: row.kind as string,
    alertId: row.alert_id as string,
    caseId: (row.case_id as string | null) ?? null,
    hypothesisId: (row.hypothesis_id as string | null) ?? null,
    status: row.status as RunStatus,
    failReason: (row.fail_reason as string | null) ?? null,
    steps: row.steps as number,
    tokensUsed: row.tokens_used as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function createRun(
  db: DB,
  input: { kind: string; alertId?: string; caseId?: string | null; hypothesisId?: string | null },
  ctx: RunCtx,
): RunRow {
  const id = `run_${randomUUID()}`;
  const now = nowMs();
  db.prepare(
    `INSERT INTO runs (id, kind, alert_id, case_id, hypothesis_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(id, input.kind, input.alertId ?? "", input.caseId ?? null, input.hypothesisId ?? null, now, now);
  ctx.audit.record({
    action: "create",
    actor: ctx.actor ?? { type: "system", id: "internal" },
    objectId: id,
    objectType: "run",
    details: { created: { kind: input.kind, alertId: input.alertId ?? "", caseId: input.caseId ?? null, hypothesisId: input.hypothesisId ?? null } },
    requestId: ctx.requestId,
    result: "SUCCESS",
    createdAt: nowMs(),
  });
  return getRun(db, id) as RunRow;
}

export function getRun(db: DB, id: string): RunRow | null {
  return mapRun(db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown>);
}

export function requireRun(db: DB, id: string): RunRow {
  const run = getRun(db, id);
  if (!run) throw new NotFoundError(`run ${id}`);
  return run;
}

/** 状态迁移唯一写入口：断言合法 → 落库 → 同步落审计（失败路径的 failReason 随行）。 */
export function transitionRun(
  db: DB,
  id: string,
  to: RunStatus,
  ctx: RunCtx,
  failReason?: string,
): RunRow {
  return db.transaction(() => {
    const run = requireRun(db, id);
    assertRunTransition(run.status, to); // 非法迁移：INV-10 → 409，不静默改写
    db.prepare(
      `UPDATE runs SET status = ?,
        fail_reason = COALESCE(?, fail_reason),
        updated_at = ?
       WHERE id = ?`,
    ).run(to, to === "failed" ? (failReason ?? null) : null, nowMs(), id);
    ctx.audit.record({
      action: "update",
      actor: ctx.actor ?? { type: "system", id: "m3:supervisor" },
      objectId: id,
      objectType: "run",
      details: {
        status: { from: run.status, to },
        ...(failReason ? { failReason } : {}),
      },
      requestId: ctx.requestId,
      result: "SUCCESS",
      createdAt: nowMs(),
    });
    return getRun(db, id) as RunRow;
  })();
}

/** 执行进度回写（steps/tokens 计数，资源兜底的可观察残留）；不改状态。 */
export function saveProgress(db: DB, id: string, steps: number, tokensUsed: number): void {
  db.prepare("UPDATE runs SET steps = ?, tokens_used = ?, updated_at = ? WHERE id = ?").run(
    steps, tokensUsed, nowMs(), id,
  );
}
