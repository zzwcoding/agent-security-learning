// 审批卡领域模块（票 11）：L2 动作 interrupt 时开卡、值班长在卡上裁决。
// 「审批决定绑定 (run, tool_call)」落在卡的三个字段上——run_id + tool + params_hash：
// 换 run、换工具、换参数都定位不到同一张卡，决定就套不上去（验收 1/4 的绑定锚）。
// INV-8：开卡/裁决/执行全链审计；INV-10：裁决走审批状态机，表之外一律 409。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { RunCtx } from "./runs.js";
import { transitionRun, getRun } from "./runs.js";
import { assertApprovalTransition, type ApprovalStatus } from "./statemachine.js";
import { NotFoundError } from "./errors.js";
import { emitEvent } from "./events.js";
import { paramsHash } from "./verify-ticket.js";

export interface ApprovalRow {
  id: string;
  runId: string;
  node: string;
  tool: string;
  params: unknown;
  paramsHash: string;
  caseId: string | null;
  /** 狗粮票 58：卡在椒图 g4 的申报 id（外部模式申报成功落卡；内部模式恒 null）。 */
  externalId: string | null;
  reason: string | null;
  status: ApprovalStatus;
  approver: string | null;
  rejectReason: string | null;
  token: string | null;
  tokenJti: string | null;
  executedAt: number | null;
  createdAt: number;
  decidedAt: number | null;
}

const nowMs = () => Date.now();

// ---------- 审批外接端口（狗粮票 58，设计 §3-G5/G6/G9 批准中继形态） ----------
//
// 外部模式（JIAOTU_GATEWAY_URL 设定，index.ts 装配 JiaoTuApprovalGateway）下 soc-demo
// 永不自铸审批票（INV-2 单口在椒图 g4）：挂起时申报（declare）→ 值班长批准由本进程
// 中继（approve，口令 X-Approver-Token 证明身份）→ 票随批准响应中继回来落卡 → 执行
// → 焚毁。裁决真相全在椒图；本地卡只是镜像。内部模式不装配此端口，下面五个函数不
// 被触达，行为逐字节不变。接口立在本文件（领域模块）、adapter 在 jiaotu/（57 idiom）。

/** 申报入参（领域命名；wire 映射是 adapter 的事：reason→risk、caseId→case_id）。 */
export interface ApprovalDeclareInput {
  tool: string;
  params: unknown;
  paramsHash: string;
  reason: string | null;
  caseId: string | null;
}

export interface ApprovalGateway {
  /** 挂起申报：把本地 pending 卡申报到椒图 g4 → {externalId}（椒图 approval_id）。 */
  declare(card: ApprovalDeclareInput): Promise<{ externalId: string }>;
  /** 公开面对账（G9）：GET /api/v1/approvals/:id → {status}（pending/approved/rejected/expired）。 */
  fetchStatus(externalId: string): Promise<{ status: string }>;
  /** 批准中继：椒图铸一次性 ApprovalToken 并只在响应里交付 → {token, jti, exp}。 */
  approve(externalId: string, approverToken: string): Promise<{ token: string; jti: string; exp: number }>;
  /** 驳回中继（椒图要求 reason 必填）。 */
  reject(externalId: string, approverToken: string, reason: string): Promise<void>;
}

/** 椒图按原码拒绝（401/404/409 透传，不自吞不自造；正文一个字节不进 message——
 *  上游错误文本不许流入我们的审计/事件面，57 同款卫生）。 */
export class ApprovalGatewayError extends Error {
  constructor(
    readonly status: number,
  ) {
    super(`approval gateway: HTTP ${status}`);
    this.name = "ApprovalGatewayError";
  }
}

/** 申报成功：external_id 落卡 + 审计 declare（INV-8：卡上的外部锚也要可回放）。 */
export function setApprovalExternalId(db: DB, id: string, externalId: string, ctx: RunCtx): void {
  db.prepare("UPDATE approvals SET external_approval_id = ? WHERE id = ?").run(externalId, id);
  ctx.audit.record({
    action: "declare",
    actor: ctx.actor ?? { type: "system", id: "m3:supervisor" },
    objectId: id,
    objectType: "approval",
    details: { external_id: externalId },
    requestId: ctx.requestId,
    result: "SUCCESS",
    createdAt: nowMs(),
  });
}

/** 挂起申报的候选集：本 run 尚未申报（无 external_id）的 pending 卡。
 *  常态 0 或 1 张——图一次只在一个 interrupt 处挂起；多张时逐张申报也幂等。 */
export function listPendingApprovalsByRun(db: DB, runId: string): ApprovalRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM approvals WHERE run_id = ? AND status = 'pending' AND external_approval_id IS NULL ORDER BY created_at",
      )
      .all(runId) as Record<string, unknown>[]
  ).map((r) => mapApproval(r) as ApprovalRow);
}

/** G9 对账的候选集：已申报（external_id 非空）且仍 pending 的卡——run 挂着等裁决，
 *  而椒图侧可能已先过期（900s vs 本地 86400s），保质期扫描要拿公开面核对。 */
export function listDeclaredPendingApprovals(db: DB): ApprovalRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM approvals WHERE status = 'pending' AND external_approval_id IS NOT NULL ORDER BY created_at",
      )
      .all() as Record<string, unknown>[]
  ).map((r) => mapApproval(r) as ApprovalRow);
}

function mapApproval(row: Record<string, unknown> | undefined): ApprovalRow | null {
  if (!row) return null;
  return {
    id: row.id as string,
    runId: row.run_id as string,
    node: row.node as string,
    tool: row.tool as string,
    params: JSON.parse(row.params as string) as unknown,
    paramsHash: row.params_hash as string,
    caseId: (row.case_id as string | null) ?? null,
    externalId: (row.external_approval_id as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    status: row.status as ApprovalStatus,
    approver: (row.approver as string | null) ?? null,
    rejectReason: (row.reject_reason as string | null) ?? null,
    token: (row.token as string | null) ?? null,
    tokenJti: (row.token_jti as string | null) ?? null,
    executedAt: (row.executed_at as number | null) ?? null,
    createdAt: row.created_at as number,
    decidedAt: (row.decided_at as number | null) ?? null,
  };
}

/** 开卡即挂起（一个事务里做三件事）：插卡 → 广播 approval_required → run 转 awaiting_approval。
 *  run 不在 running 时状态机抛 409，整卡回滚——「挂起」这个动作本身就是原子的。 */
export function openApprovalCard(
  db: DB,
  input: {
    runId: string;
    node: string;
    tool: string;
    params: unknown;
    caseId?: string | null;
    reason?: string | null;
  },
  ctx: RunCtx,
): ApprovalRow {
  const id = `apr_${randomUUID()}`;
  const hash = paramsHash(input.params);
  const now = nowMs();
  return db.transaction(() => {
    // run 状态门：只有 running 能挂起（INV-10）
    transitionRun(db, input.runId, "awaiting_approval", ctx);
    db.prepare(
      `INSERT INTO approvals (id, run_id, node, tool, params, params_hash, case_id, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(
      id, input.runId, input.node, input.tool,
      JSON.stringify(input.params) ?? "null", hash,
      input.caseId ?? null, input.reason ?? null, now,
    );
    emitEvent(db, input.runId, "approval_required", {
      approval_id: id,
      node: input.node,
      tool: input.tool,
      params: input.params,
      params_hash: hash,
      reason: input.reason ?? null,
    });
    ctx.audit.record({
      action: "create",
      actor: ctx.actor ?? { type: "system", id: "m3:supervisor" },
      objectId: id,
      objectType: "approval",
      details: { run_id: input.runId, node: input.node, tool: input.tool, params_hash: hash },
      requestId: ctx.requestId,
      result: "SUCCESS",
      createdAt: nowMs(),
    });
    return getApproval(db, id) as ApprovalRow;
  })();
}

/** 找该 (run, tool_call) 最新一张「还能生效」的卡。已执行过的卡排除——同一 run 里
 *  再次提请同样的 tool_call 要开新卡走新审批（一次性语义的结构面）。 */
export function findDecidableCard(
  db: DB,
  runId: string,
  tool: string,
  hash: string,
): ApprovalRow | null {
  return mapApproval(
    db
      .prepare(
        `SELECT * FROM approvals
          WHERE run_id = ? AND tool = ? AND params_hash = ? AND executed_at IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(runId, tool, hash) as Record<string, unknown>,
  );
}

export function getApproval(db: DB, id: string): ApprovalRow | null {
  return mapApproval(db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Record<string, unknown>);
}

export function requireApproval(db: DB, id: string): ApprovalRow {
  const card = getApproval(db, id);
  if (!card) throw new NotFoundError(`approval ${id}`);
  return card;
}

export function listApprovals(db: DB, status?: ApprovalStatus): ApprovalRow[] {
  const rows = (
    status
      ? db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC, rowid DESC").all(status)
      : db.prepare("SELECT * FROM approvals ORDER BY created_at DESC, rowid DESC").all()
  ) as Record<string, unknown>[];
  return rows.map((r) => mapApproval(r) as ApprovalRow);
}

export interface DecideInput {
  approve: boolean;
  approver: string;
  reason?: string;
  /** 批准时铸出的 ApprovalToken wire 串与 jti（approve 端点先铸票再裁决，见 app.ts）。 */
  token?: string;
  tokenJti?: string;
}

/** 裁决（批准/驳回），审批状态机在这里仲裁：先到先得，后到 409（并发审批后到者 409）。
 *  actor 是人（值班长），INV-8 的审批审计从这里落。 */
export function decideApproval(db: DB, id: string, d: DecideInput, ctx: RunCtx): ApprovalRow {
  return db.transaction(() => {
    const card = requireApproval(db, id);
    const to: ApprovalStatus = d.approve ? "approved" : "rejected";
    assertApprovalTransition(card.status, to); // INV-10：pending 之外全是 409
    const now = nowMs();
    db.prepare(
      `UPDATE approvals SET status = ?, approver = ?, reject_reason = ?, token = ?, token_jti = ?, decided_at = ?
        WHERE id = ?`,
    ).run(
      to, d.approver, d.approve ? null : (d.reason ?? null),
      d.approve ? (d.token ?? null) : null, d.approve ? (d.tokenJti ?? null) : null,
      now, id,
    );
    ctx.audit.record({
      action: d.approve ? "approve" : "reject",
      actor: { type: "user", id: d.approver },
      objectId: id,
      objectType: "approval",
      details: {
        status: { from: card.status, to },
        tool: card.tool,
        params_hash: card.paramsHash,
        run_id: card.runId,
        ...(d.approve ? {} : { reason: d.reason ?? null }),
      },
      requestId: ctx.requestId,
      result: "SUCCESS",
      createdAt: now,
    });
    emitEvent(db, card.runId, "approval_decided", {
      approval_id: id,
      node: card.node,
      tool: card.tool,
      decision: to,
      by: d.approver,
      ...(d.approve ? {} : { reason: d.reason ?? null }),
    });
    return getApproval(db, id) as ApprovalRow;
  })();
}

/** 执行标记：闸放行 + 动作跑完后打。执行过的卡不再授权第二次执行（一次性）。 */
export function markApprovalExecuted(db: DB, id: string, jti: string, ctx: RunCtx): void {
  const card = requireApproval(db, id);
  db.prepare("UPDATE approvals SET executed_at = ? WHERE id = ?").run(nowMs(), id);
  ctx.audit.record({
    action: "execute",
    actor: ctx.actor ?? { type: "agent", id: "m3:supervisor" },
    objectId: id,
    objectType: "approval",
    // 记操作不记内容（FR-S5.2）：工具名 + 参数指纹 + 票 jti，不落参数原文与执行输出
    details: { tool: card.tool, params_hash: card.paramsHash, jti },
    requestId: ctx.requestId,
    result: "SUCCESS",
    createdAt: nowMs(),
  });
}

/** 审批卡保质期（票 47·ADR 0004-1）：超时 pending 卡由分发循环自动作废。
 *  一个事务里做完四件事：卡 pending→expired（审批状态机仲裁，非 pending 抛 409 回滚）
 *  → 审计 expire → 广播 approval_decided(decision=expired) → 对应 run 落
 *  failed(reason=approval_expired)。「过期」是时间出的裁决，run 必须有个可观察的
 *  终局，不能永远挂在 awaiting_approval 上。run 已在终态（陈旧卡）则只废卡不动 run。 */
export function expireApprovalCard(db: DB, id: string, ctx: RunCtx, ttlSeconds: number): ApprovalRow {
  return db.transaction(() => {
    const card = requireApproval(db, id);
    assertApprovalTransition(card.status, "expired"); // INV-10：只有 pending 能过期
    const now = nowMs();
    db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(now, id);
    ctx.audit.record({
      action: "expire",
      actor: ctx.actor ?? { type: "system", id: "m3:dispatcher" },
      objectId: id,
      objectType: "approval",
      details: {
        status: { from: card.status, to: "expired" },
        tool: card.tool,
        params_hash: card.paramsHash,
        run_id: card.runId,
        ttl_seconds: ttlSeconds,
      },
      requestId: ctx.requestId,
      result: "SUCCESS",
      createdAt: now,
    });
    emitEvent(db, card.runId, "approval_decided", {
      approval_id: id,
      node: card.node,
      tool: card.tool,
      decision: "expired",
      by: "system:approval_ttl",
    });
    // run 终局：awaiting_approval 不能直接 failed（状态机无此迁移）——照消费循环的
    // 认领语义先转回 running 再强杀，两步都是合法迁移，审计各留一条（INV-8）。
    const run = getRun(db, card.runId);
    if (run && (run.status === "awaiting_approval" || run.status === "running")) {
      if (run.status === "awaiting_approval") transitionRun(db, card.runId, "running", ctx);
      transitionRun(db, card.runId, "failed", ctx, "approval_expired");
    }
    return getApproval(db, id) as ApprovalRow;
  })();
}

/** 超时未决的 pending 卡（created_at 早于 TTL 之前）：保质期扫描器的候选集。 */
export function listExpiredPendingApprovals(db: DB, ttlSeconds: number): ApprovalRow[] {
  const cutoff = nowMs() - ttlSeconds * 1000;
  return (
    db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND created_at < ? ORDER BY created_at")
      .all(cutoff) as Record<string, unknown>[]
  ).map((r) => mapApproval(r) as ApprovalRow);
}

/** REST wire 形状（m9 卡公开接口）：snake_case，params 是原对象。 */
export function toWire(row: ApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.runId,
    node: row.node,
    tool: row.tool,
    params: row.params,
    params_hash: row.paramsHash,
    case_id: row.caseId,
    external_id: row.externalId,
    reason: row.reason,
    status: row.status,
    approver: row.approver,
    reject_reason: row.rejectReason,
    executed: row.executedAt !== null,
    created_at: row.createdAt,
    decided_at: row.decidedAt,
  };
}
