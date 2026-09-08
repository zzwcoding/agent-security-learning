// m2 深模块：六实体 CRUD + 三结局 + 审计信号 + outbox + 焚毁表。
// 公开接口是这批函数；REST 面（app.ts）只是薄装配。所有写操作在同一事务内
// 落审计条目（INV-8「审计同库同事务」）——这是 audit-signal 拦截器的实现方式。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { assertTransition, InvalidTransitionError } from "./statemachine.js";

export const VERDICTS = [
  "false_positive",
  "benign_true_positive",
  "true_positive",
  "uncertain",
] as const;

export class NotFoundError extends Error {
  readonly code = "not_found";
  readonly httpStatus = 404;
  constructor(what: string) {
    super(`not_found: ${what}`);
    this.name = "not_found";
  }
}
export class VerdictRequiredError extends Error {
  readonly code = "verdict_required";
  readonly httpStatus = 409;
  constructor() {
    super("verdict_required");
    this.name = "verdict_required";
  }
}
export class MergeTargetClosedError extends Error {
  readonly code = "merge_target_closed";
  readonly httpStatus = 409;
  constructor() {
    super("merge_target_closed");
    this.name = "merge_target_closed";
  }
}
export class VerdictLockedError extends Error {
  readonly code = "verdict_locked";
  readonly httpStatus = 409;
  constructor(what: string) {
    super(`verdict_locked: ${what}`);
    this.name = "verdict_locked";
  }
}
export class JtiExistsError extends Error {
  readonly code = "jti_exists";
  readonly httpStatus = 409;
  constructor(jti: string) {
    super(`jti_exists: ${jti}`);
    this.name = "jti_exists";
  }
}

export interface Actor {
  type: string;
  id: string;
  role?: string;
}
export interface Ctx {
  actor: Actor;
  requestId: string;
}

export interface ObservableInput {
  dataType: string;
  data: string;
  message?: string;
  tlp?: number;
  pap?: number;
  ioc?: boolean;
  tags?: string[];
}

export interface AlertInput {
  type: string;
  source: string;
  sourceRef: string;
  title: string;
  description?: string;
  severity?: number;
  tlp?: number;
  pap?: number;
  tags?: string[];
  date?: number;
  raw?: unknown;
  observables?: ObservableInput[];
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

function recordAudit(
  db: DB,
  ctx: Ctx,
  action: string,
  objectId: string,
  objectType: string,
  details: unknown,
  result = "SUCCESS",
): void {
  db.prepare(
    `INSERT INTO audit_entries (id, action, actor, object_id, object_type, details, request_id, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    action,
    j(ctx.actor),
    objectId,
    objectType,
    j(details),
    ctx.requestId,
    result,
    nowMs(),
  );
}

function emitEvent(db: DB, topic: string, payload: unknown): void {
  db.prepare(
    "INSERT INTO outbox_events (topic, payload, created_at) VALUES (?, ?, ?)",
  ).run(topic, j(payload), nowMs());
}

// ---------- alerts ----------

function mapAlert(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    sourceRef: row.source_ref,
    title: row.title,
    description: row.description,
    severity: row.severity,
    tlp: row.tlp,
    pap: row.pap,
    status: row.status,
    tags: pj<string[]>(row.tags as string, []),
    verdict: row.verdict,
    verdictAi: pj(row.verdict_ai as string, null),
    date: row.date,
    newDate: row.new_date,
    lastSeen: row.last_seen,
    occurrences: row.occurrences,
    inProgressDate: row.in_progress_date,
    importedDate: row.imported_date,
    closedDate: row.closed_date,
  };
}

function alertObservables(db: DB, alertId: string): unknown[] {
  return (
    db.prepare("SELECT * FROM observables WHERE alert_id = ? ORDER BY rowid").all(alertId) as Record<string, unknown>[]
  ).map(mapObservable);
}

function mapObservable(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    dataType: row.data_type,
    data: row.data,
    message: row.message,
    tlp: row.tlp,
    pap: row.pap,
    ioc: !!row.ioc,
    sighted: !!row.sighted,
    sightedAt: row.sighted_at,
    tags: pj<string[]>(row.tags as string, []),
    sourceAlertId: row.source_alert_id,
    caseId: row.case_id,
    alertId: row.alert_id,
  };
}

export function createAlert(db: DB, input: AlertInput): Record<string, unknown> {
  const create = db.transaction(() => {
    const id = randomUUID();
    const date = input.date ?? nowMs();
    db.prepare(
      `INSERT INTO alerts (id, type, source, source_ref, title, description, severity, tlp, pap,
                           status, tags, raw, date, new_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?)`,
    ).run(
      id, input.type, input.source, input.sourceRef, input.title,
      input.description ?? "", input.severity ?? 2, input.tlp ?? 2, input.pap ?? 2,
      j(input.tags ?? []), input.raw ? j(input.raw) : null, date, nowMs(),
    );
    for (const o of input.observables ?? []) {
      db.prepare(
        `INSERT INTO observables (id, alert_id, data_type, data, message, tlp, pap, ioc, tags, source_alert_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), id, o.dataType, o.data, o.message ?? null,
        o.tlp ?? 2, o.pap ?? 2, o.ioc ? 1 : 0, j(o.tags ?? []), id,
      );
    }
    const ctx: Ctx = { actor: { type: "system", id: "m2:ingest" }, requestId: randomUUID() };
    recordAudit(db, ctx, "create", id, "alert", { created: { title: input.title, sourceRef: input.sourceRef } });
    emitEvent(db, "alert.created", { alertId: id, source: input.source, sourceRef: input.sourceRef });
    return id;
  });
  const id = create();
  return getAlert(db, id) as Record<string, unknown>;
}

// m1 告警接入的写入口（票 09）：upsert 语义，重复 (source, sourceRef) 走唯一索引冲突
// → occurrences+1 + 刷新 last_seen，不新建行、不发 alert.created（INV-6：不重复触发流水线），
// 但记一条审计 diff（INV-8：occurrences 变了就是写操作）。与 createAlert 的区别：
// createAlert 是「无脑新建」（手工/测试路径），这里才是带去重的正门。
export interface IngestAlertResult {
  alert: Record<string, unknown>;
  dedup: boolean;
}

export function ingestAlert(db: DB, input: AlertInput): IngestAlertResult {
  return db.transaction(() => {
    const seenAt = nowMs();
    const row = db
      .prepare(
        `INSERT INTO alerts (id, type, source, source_ref, title, description, severity, tlp, pap,
                             status, tags, raw, date, new_date, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_ref)
         DO UPDATE SET occurrences = occurrences + 1, last_seen = excluded.last_seen
         RETURNING id, occurrences`,
      )
      .get(
        randomUUID(), input.type, input.source, input.sourceRef, input.title,
        input.description ?? "", input.severity ?? 2, input.tlp ?? 2, input.pap ?? 2,
        j(input.tags ?? []), input.raw ? j(input.raw) : null, input.date ?? seenAt, seenAt, seenAt,
      ) as { id: string; occurrences: number };
    const dedup = row.occurrences > 1;
    const ctx: Ctx = { actor: { type: "system", id: "m1:ingest" }, requestId: randomUUID() };
    if (dedup) {
      recordAudit(db, ctx, "update", row.id, "alert", {
        occurrences: { from: row.occurrences - 1, to: row.occurrences },
        lastSeen: "refreshed",
      });
    } else {
      for (const o of input.observables ?? []) {
        db.prepare(
          `INSERT INTO observables (id, alert_id, data_type, data, message, tlp, pap, ioc, tags, source_alert_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(), row.id, o.dataType, o.data, o.message ?? null,
          o.tlp ?? 2, o.pap ?? 2, o.ioc ? 1 : 0, j(o.tags ?? []), row.id,
        );
      }
      recordAudit(db, ctx, "create", row.id, "alert", {
        created: { title: input.title, sourceRef: input.sourceRef },
      });
      emitEvent(db, "alert.created", { alertId: row.id, source: input.source, sourceRef: input.sourceRef });
    }
    return { alert: getAlert(db, row.id) as Record<string, unknown>, dedup };
  })();
}

export function getAlert(db: DB, id: string): Record<string, unknown> | null {  const row = db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  const alert = mapAlert(row);
  if (!alert) return null;
  alert.observables = alertObservables(db, id);
  return alert;
}

export function listAlerts(
  db: DB,
  filter: { status?: string; host?: string } = {},
): unknown[] {
  let sql = "SELECT * FROM alerts WHERE 1=1";
  const params: unknown[] = [];
  if (filter.status) {
    sql += " AND status = ?";
    params.push(filter.status);
  }
  if (filter.host) {
    sql += ` AND EXISTS (SELECT 1 FROM observables o
             WHERE o.alert_id = alerts.id AND o.data_type = 'hostname' AND o.data = ?)`;
    params.push(filter.host);
  }
  sql += " ORDER BY date DESC";
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map((row) => ({
    ...mapAlert(row),
    observables: alertObservables(db, row.id as string),
  }));
}

// ---------- cases ----------

function mapCase(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    severity: row.severity,
    tlp: row.tlp,
    pap: row.pap,
    status: row.status,
    verdict: row.verdict,
    verdictNote: row.verdict_note,
    assignee: row.assignee,
    tags: pj<string[]>(row.tags as string, []),
    linkedAlerts: pj<string[]>(row.linked_alerts as string, []),
    startDate: row.start_date,
    endDate: row.end_date,
    intakeSource: row.intake_source,
  };
}

function nextCaseIdentity(db: DB): { id: string; number: number } {
  const number =
    (db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM cases").get() as { n: number }).n + 1;
  return { id: `case_${String(number).padStart(6, "0")}`, number };
}

function insertCase(
  db: DB,
  fields: {
    title: string; description?: string; severity?: number; tlp?: number; pap?: number;
    tags?: string[]; linkedAlerts?: string[]; intakeSource?: string; assignee?: string;
  },
): Record<string, unknown> {
  const { id, number } = nextCaseIdentity(db);
  db.prepare(
    `INSERT INTO cases (id, number, title, description, severity, tlp, pap, status, tags,
                        linked_alerts, start_date, intake_source, assignee)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, ?, ?)`,
  ).run(
    id, number, fields.title, fields.description ?? "",
    fields.severity ?? 2, fields.tlp ?? 2, fields.pap ?? 2,
    j(fields.tags ?? []), j(fields.linkedAlerts ?? []),
    nowMs(), fields.intakeSource ?? "manual", fields.assignee ?? null,
  );
  return getCase(db, id) as Record<string, unknown>;
}

function requireCase(db: DB, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`case ${id}`);
  return mapCase(row) as Record<string, unknown>;
}

export function getCase(db: DB, id: string): Record<string, unknown> | null {
  try {
    return requireCase(db, id);
  } catch {
    return null;
  }
}

export function getCaseDetail(db: DB, id: string): Record<string, unknown> | null {
  const c = getCase(db, id);
  if (!c) return null;
  c.observables = (
    db.prepare("SELECT * FROM observables WHERE case_id = ? ORDER BY rowid").all(id) as
      Record<string, unknown>[]
  ).map(mapObservable);
  c.tasks = db.prepare("SELECT * FROM tasks WHERE case_id = ? ORDER BY rowid").all(id);
  c.timeline = listTimeline(db, id);
  return c;
}

export function listCases(db: DB, filter: { status?: string } = {}): unknown[] {
  const rows = filter.status
    ? db.prepare("SELECT * FROM cases WHERE status = ? ORDER BY number DESC").all(filter.status)
    : db.prepare("SELECT * FROM cases ORDER BY number DESC").all();
  return (rows as Record<string, unknown>[]).map((r) => mapCase(r));
}

// 三结局之一：成新案（FR-M2.3）。alert New→InProgress，observables 归案，链接 + 系统时间线。
export function createCaseFromAlert(
  db: DB,
  alertId: string,
  opts: { title?: string; description?: string; assignee?: string },
  ctx: Ctx,
): { case: Record<string, unknown>; alert: Record<string, unknown> } {
  return db.transaction(() => {
    const alert = getAlert(db, alertId);
    if (!alert) throw new NotFoundError(`alert ${alertId}`);
    assertTransition("alert", alert.status as string, "InProgress");
    const observables = alertObservables(db, alertId);
    const primary =
      (observables.find((o) => (o as { dataType: string }).dataType === "hostname") as
        | { data: string }
        | undefined)?.data ?? (alert.sourceRef as string);
    const day = new Date(alert.date as number).toISOString().slice(0, 10);
    const title =
      opts.title ?? `[${alert.type}] - ${primary} - ${day}`;
    const kase = insertCase(db, {
      title,
      description: opts.description ?? (alert.description as string),
      severity: alert.severity as number,
      tlp: alert.tlp as number,
      pap: alert.pap as number,
      tags: alert.tags as string[],
      linkedAlerts: [alertId],
      intakeSource: "auto_pipeline",
      assignee: opts.assignee,
    });
    db.prepare("UPDATE observables SET case_id = ? WHERE alert_id = ?").run(kase.id, alertId);
    addSystemTimeline(db, kase.id as string, ctx, `case created from alert ${alertId}`);
    db.prepare("UPDATE alerts SET status = 'InProgress', in_progress_date = ? WHERE id = ?").run(
      nowMs(), alertId,
    );
    recordAudit(db, ctx, "create", kase.id as string, "case", {
      created: { title, fromAlert: alertId },
    });
    recordAudit(db, ctx, "update", alertId, "alert", {
      status: { from: alert.status, to: "InProgress" },
    });
    return { case: getCaseDetail(db, kase.id as string) as Record<string, unknown>, alert: getAlert(db, alertId) as Record<string, unknown> };
  })();
}

// 三结局之二：并入旧案。照 TheHive：observables 复制、tags 并入、timeline 记系统条目，
// 源 alert 置 Imported 记 importedDate；目标已 Closed → 409（PRD 异常与边界）。
export function mergeAlertIntoCase(
  db: DB,
  alertId: string,
  targetCaseId: string,
  ctx: Ctx,
): { case: Record<string, unknown>; alert: Record<string, unknown> } {
  return db.transaction(() => {
    const alert = getAlert(db, alertId);
    if (!alert) throw new NotFoundError(`alert ${alertId}`);
    const target = requireCase(db, targetCaseId);
    if (target.status === "Closed") throw new MergeTargetClosedError();
    assertTransition("alert", alert.status as string, "Imported");

    const rows = db.prepare("SELECT * FROM observables WHERE alert_id = ?").all(alertId) as
      Record<string, unknown>[];
    for (const o of rows) {
      db.prepare(
        `INSERT INTO observables (id, case_id, data_type, data, message, tlp, pap, ioc, tags, source_alert_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), targetCaseId, o.data_type, o.data, o.message,
        o.tlp, o.pap, o.ioc, o.tags, alertId,
      );
    }
    const caseTags = target.tags as string[];
    const tagDiff = (alert.tags as string[]).filter((t) => !caseTags.includes(t));
    if (tagDiff.length > 0) {
      db.prepare("UPDATE cases SET tags = ? WHERE id = ?").run(
        j([...caseTags, ...tagDiff]), targetCaseId,
      );
    }
    db.prepare("UPDATE cases SET linked_alerts = ? WHERE id = ?").run(
      j([...(target.linkedAlerts as string[]), alertId]), targetCaseId,
    );
    addSystemTimeline(db, targetCaseId, ctx, `alert ${alertId} merged into case`);

    db.prepare("UPDATE alerts SET status = 'Imported', imported_date = ? WHERE id = ?").run(
      nowMs(), alertId,
    );
    recordAudit(db, ctx, "merge", alertId, "alert", {
      targetCase: targetCaseId,
      observablesCopied: rows.length,
      tagsAdded: tagDiff,
    });
    recordAudit(db, ctx, "update", targetCaseId, "case", {
      linkedAlerts: { from: target.linkedAlerts, to: [...(target.linkedAlerts as string[]), alertId] },
      tagsAdded: tagDiff,
    });
    return { case: getCaseDetail(db, targetCaseId) as Record<string, unknown>, alert: getAlert(db, alertId) as Record<string, unknown> };
  })();
}

// 三结局之三：关案。verdict 必填（ASP「无判定不许关案」，FR-M2.2）。
export function closeCase(
  db: DB,
  caseId: string,
  body: { verdict?: string | null; verdictNote?: string },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const kase = requireCase(db, caseId);
    if (!body.verdict || !(VERDICTS as readonly string[]).includes(body.verdict)) {
      throw new VerdictRequiredError();
    }
    assertTransition("case", kase.status as string, "Closed");
    db.prepare(
      "UPDATE cases SET status = 'Closed', verdict = ?, verdict_note = ?, end_date = ? WHERE id = ?",
    ).run(body.verdict, body.verdictNote ?? null, nowMs(), caseId);
    recordAudit(db, ctx, "update", caseId, "case", {
      status: { from: kase.status, to: "Closed" },
      verdict: { from: kase.verdict, to: body.verdict },
    });
    // 票 17（PRD 图 case_closed → knowledge_distill）：关案事件的 outbox 出口——
    // 沉淀子图的触发信号。当前触发形态与 alert_flow 同款由调用方 POST /internal/runs
    // （票 13 先例），事件先进 outbox 供下游/演示观察。
    emitEvent(db, "case.closed", { caseId, verdict: body.verdict });
    return getCase(db, caseId) as Record<string, unknown>;
  })();
}

export function closeAlert(
  db: DB,
  alertId: string,
  body: { verdict?: string | null },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const alert = getAlert(db, alertId);
    if (!alert) throw new NotFoundError(`alert ${alertId}`);
    assertTransition("alert", alert.status as string, "Closed");
    if (body.verdict && !(VERDICTS as readonly string[]).includes(body.verdict)) {
      throw new VerdictRequiredError();
    }
    db.prepare("UPDATE alerts SET status = 'Closed', closed_date = ?, verdict = ? WHERE id = ?").run(
      nowMs(), body.verdict ?? null, alertId,
    );
    recordAudit(db, ctx, "update", alertId, "alert", {
      status: { from: alert.status, to: "Closed" },
    });
    return getAlert(db, alertId) as Record<string, unknown>;
  })();
}

// 重开（FR-M2.1：Closed 可重开，记审计）
export function reopenAlert(db: DB, alertId: string, ctx: Ctx): Record<string, unknown> {
  return db.transaction(() => {
    const alert = getAlert(db, alertId);
    if (!alert) throw new NotFoundError(`alert ${alertId}`);
    assertTransition("alert", alert.status as string, "InProgress");
    db.prepare("UPDATE alerts SET status = 'InProgress', in_progress_date = ? WHERE id = ?").run(
      nowMs(), alertId,
    );
    recordAudit(db, ctx, "update", alertId, "alert", {
      status: { from: alert.status, to: "InProgress" },
    });
    return getAlert(db, alertId) as Record<string, unknown>;
  })();
}

// 分诊写回（票 13，m4 卡接口契约 PATCH /api/v1/alerts/:id）：verdict 生命周期
// null → in-progress（锁定）→ 终值（PRD §5.1）。
//   - in-progress = 拾取锁（FR-M4.5）：条件更新 WHERE verdict IS NULL，两个 run 同时
//     拾取同一条告警只有先到者成功，后到者 409 verdict_locked——「并发同告警只分诊
//     1 次」的并发安全就压在这一条 SQL 上，不靠应用层查-改。
//   - 终值只能从 in-progress 来（先拾取后判定）；终值即终局，不许再改。
//   - verdict_ai（AI 判断双轨列）必须在拾取之后写——没锁就写结果等于绕过防重复拾取。
//   - status 走 alert 状态机（uncertain 挂人工待办 = New→InProgress）。
export function patchAlert(
  db: DB,
  alertId: string,
  body: { verdict?: string | null; verdict_ai?: unknown; status?: string },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const alert = getAlert(db, alertId);
    if (!alert) throw new NotFoundError(`alert ${alertId}`);
    const details: Record<string, unknown> = {};

    if (body.verdict !== undefined) {
      if (body.verdict === "in-progress") {
        const res = db.prepare(
          "UPDATE alerts SET verdict = 'in-progress' WHERE id = ? AND verdict IS NULL",
        ).run(alertId);
        if (res.changes === 0) throw new VerdictLockedError(alertId); // 别人已拾取/已终值
      } else if (typeof body.verdict === "string" && (VERDICTS as readonly string[]).includes(body.verdict)) {
        if (alert.verdict !== "in-progress") throw new VerdictLockedError(alertId);
        db.prepare("UPDATE alerts SET verdict = ? WHERE id = ?").run(body.verdict, alertId);
      } else {
        throw new VerdictRequiredError();
      }
      details.verdict = { from: alert.verdict, to: body.verdict };
    }

    if (body.verdict_ai !== undefined) {
      if (alert.verdict === null && body.verdict === undefined) {
        throw new VerdictLockedError(alertId); // 未拾取不许写 AI 判断
      }
      db.prepare("UPDATE alerts SET verdict_ai = ? WHERE id = ?").run(j(body.verdict_ai), alertId);
      details.verdict_ai = { from: alert.verdictAi, to: body.verdict_ai };
    }

    if (body.status !== undefined && body.status !== alert.status) {
      assertTransition("alert", alert.status as string, body.status);
      db.prepare("UPDATE alerts SET status = ? WHERE id = ?").run(body.status, alertId);
      details.status = { from: alert.status, to: body.status };
    }

    if (Object.keys(details).length > 0) {
      recordAudit(db, ctx, "patch", alertId, "alert", details);
    }
    return getAlert(db, alertId) as Record<string, unknown>;
  })();
}

const PATCHABLE = ["title", "description", "severity", "tlp", "pap", "assignee", "tags"] as const;

export function patchCase(
  db: DB,
  caseId: string,
  patch: Record<string, unknown>,
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const kase = requireCase(db, caseId);
    if (kase.status === "Closed") {
      // 已关案件冻结：任何改写都按状态机终态拒绝（INV-10 口径，见票 03 记录）
      throw new InvalidTransitionError("case", "Closed", "Closed");
    }
    const details: Record<string, unknown> = {};
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const f of PATCHABLE) {
      if (!(f in patch)) continue;
      const from = kase[f];
      const to = patch[f];
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      details[f] = { from, to };
      sets.push(`${f} = ?`);
      params.push(typeof to === "string" ? to : j(to));
    }
    if (patch.status !== undefined) {
      const to = patch.status as string;
      if (to === "Closed") throw new VerdictRequiredError(); // 关案必须走 /close 带 verdict
      assertTransition("case", kase.status as string, to);
      details.status = { from: kase.status, to };
      sets.push("status = ?");
      params.push(to);
    }
    if (sets.length > 0) {
      params.push(caseId);
      db.prepare(`UPDATE cases SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      recordAudit(db, ctx, "update", caseId, "case", details);
    }
    return getCase(db, caseId) as Record<string, unknown>;
  })();
}

// 票 15 FR-M6.3：analyzer 提取的新 observable 回写案件，与既有 observable 重复 →
// 去重合并（PRD §6-M6 异常与边界）：按 (case_id, dataType, data) 找既有行——命中就不
// 新建行，tags 去重并入（旧在前新在后）、message 仅原空时回填，201→200 的语义对齐
// ingest 去重（INV-6 同款幂等口径）；审计照 INV-8 记 diff（tags/message 的 from→to）。
export interface AddCaseObservableResult {
  observable: Record<string, unknown>;
  dedup: boolean;
}

export function addCaseObservable(
  db: DB,
  caseId: string,
  input: ObservableInput,
  ctx: Ctx,
): AddCaseObservableResult {
  return db.transaction(() => {
    requireCase(db, caseId);
    const existing = db
      .prepare("SELECT * FROM observables WHERE case_id = ? AND data_type = ? AND data = ?")
      .get(caseId, input.dataType, input.data) as Record<string, unknown> | undefined;
    if (existing) {
      const oldTags = pj<string[]>(existing.tags as string, []);
      const merged = [...oldTags, ...(input.tags ?? []).filter((t) => !oldTags.includes(t))];
      const newMessage = existing.message ?? input.message ?? null;
      db.prepare("UPDATE observables SET tags = ?, message = COALESCE(message, ?) WHERE id = ?").run(
        j(merged), input.message ?? null, existing.id as string,
      );
      recordAudit(db, ctx, "update", existing.id as string, "observable", {
        tags: { from: oldTags, to: merged },
        message: { from: existing.message ?? null, to: newMessage },
        dedup: true,
      });
      return {
        observable: mapObservable(
          db.prepare("SELECT * FROM observables WHERE id = ?").get(existing.id as string) as Record<string, unknown>,
        ),
        dedup: true,
      };
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO observables (id, case_id, data_type, data, message, tlp, pap, ioc, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, caseId, input.dataType, input.data, input.message ?? null,
      input.tlp ?? 2, input.pap ?? 2, input.ioc ? 1 : 0, j(input.tags ?? []),
    );
    recordAudit(db, ctx, "create", id, "observable", {
      created: { caseId, dataType: input.dataType, data: input.data },
    });
    return {
      observable: mapObservable(db.prepare("SELECT * FROM observables WHERE id = ?").get(id) as Record<string, unknown>),
      dedup: false,
    };
  })();
}

// 手工建案（intake_source=manual）：POST /api/v1/cases 用，不经 alert
export function createCaseManual(
  db: DB,
  fields: { title: string; description?: string; severity?: number; assignee?: string; tags?: string[] },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const kase = insertCase(db, { ...fields, intakeSource: "manual" });
    recordAudit(db, ctx, "create", kase.id as string, "case", {
      created: { title: fields.title, intakeSource: "manual" },
    });
    return kase;
  })();
}

// FR-M2.4：同主机归并查询——活跃 case 挂着该主机名的 observable、开案时间在窗口内
export function findActiveCases(db: DB, host: string, withinHours: number): unknown[] {
  const since = nowMs() - withinHours * 3_600_000;
  return (
    db
      .prepare(
        `SELECT c.* FROM cases c
         JOIN observables o ON o.case_id = c.id AND o.data_type = 'hostname' AND o.data = ?
         WHERE c.status IN ('New', 'InProgress') AND c.start_date >= ?
         GROUP BY c.id ORDER BY c.number DESC`,
      )
      .all(host, since) as Record<string, unknown>[]
  ).map((r) => mapCase(r));
}

// ---------- timeline / audit / outbox / used_tokens ----------

function addSystemTimeline(db: DB, caseId: string, ctx: Ctx, bodyText: string): void {
  db.prepare(
    `INSERT INTO timeline_entries (id, case_id, kind, author, body, created_at)
     VALUES (?, ?, 'system', ?, ?, ?)`,
  ).run(randomUUID(), caseId, ctx.actor.id, bodyText, nowMs());
}

export function addTimelineEntry(
  db: DB,
  caseId: string,
  entry: { kind: string; author: string; body: string; structured?: unknown },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    requireCase(db, caseId);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO timeline_entries (id, case_id, kind, author, body, structured, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, caseId, entry.kind, entry.author, entry.body, entry.structured ? j(entry.structured) : null, nowMs());
    recordAudit(db, ctx, "create", id, "timeline_entry", {
      created: { caseId, kind: entry.kind, author: entry.author },
    });
    return db
      .prepare("SELECT * FROM timeline_entries WHERE id = ?")
      .get(id) as Record<string, unknown>;
  })();
}

export function listTimeline(db: DB, caseId: string): unknown[] {
  return db
    .prepare("SELECT * FROM timeline_entries WHERE case_id = ? ORDER BY created_at, rowid")
    .all(caseId)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, structured: pj(row.structured as string, null) };
    });
}

export function queryAudit(
  db: DB,
  filter: { objectId?: string; requestId?: string } = {},
): unknown[] {
  let sql = "SELECT * FROM audit_entries WHERE 1=1";
  const params: unknown[] = [];
  if (filter.objectId) {
    sql += " AND object_id = ?";
    params.push(filter.objectId);
  }
  if (filter.requestId) {
    sql += " AND request_id = ?";
    params.push(filter.requestId);
  }
  sql += " ORDER BY created_at, rowid";
  return (
    db.prepare(sql).all(...params) as Record<string, unknown>[]
  ).map((row) => ({
    id: row.id,
    action: row.action,
    actor: pj(row.actor as string, {}),
    objectId: row.object_id,
    objectType: row.object_type,
    details: pj(row.details as string, {}),
    requestId: row.request_id,
    result: row.result,
    createdAt: row.created_at,
  }));
}

export function pollEvents(db: DB, after: number, limit = 100): unknown[] {
  return (
    db
      .prepare("SELECT * FROM outbox_events WHERE id > ? ORDER BY id LIMIT ?")
      .all(after, limit) as Record<string, unknown>[]
  ).map((row) => ({
    id: row.id,
    topic: row.topic,
    payload: pj(row.payload as string, {}),
    createdAt: row.created_at,
  }));
}

export function registerUsedToken(
  db: DB,
  body: { jti: string; source?: string },
  ctx: Ctx,
): Record<string, unknown> {
  return db.transaction(() => {
    const burnedAt = nowMs();
    try {
      db.prepare("INSERT INTO used_tokens (jti, source, burned_at) VALUES (?, ?, ?)").run(
        body.jti, body.source ?? null, burnedAt,
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) throw new JtiExistsError(body.jti);
      throw e;
    }
    recordAudit(db, ctx, "execute", body.jti, "used_token", { source: body.source ?? null });
    return { jti: body.jti, burned: true, burnedAt };
  })();
}

export function lookupUsedToken(db: DB, jti: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM used_tokens WHERE jti = ?").get(jti) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return { jti: row.jti, burned: true, burnedAt: row.burned_at, source: row.source };
}
