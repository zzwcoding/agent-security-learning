// 票 11：审批卡领域测试——状态机（INV-10 同源仲裁）、开卡、裁决仲裁、一次性执行标记。
// REST 回路的端到端在 approval-loop.test.ts；这里只锁领域规则。
import { describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { createRun, getRun, transitionRun, type RunCtx, type RunRow } from "./runs.js";
import {
  APPROVAL_STATES,
  InvalidApprovalTransitionError,
  InvalidRunTransitionError,
  assertApprovalTransition,
} from "./statemachine.js";
import {
  decideApproval,
  getApproval,
  listApprovals,
  markApprovalExecuted,
  openApprovalCard,
  toWire,
} from "./approvals.js";
import { eventsAfter } from "./events.js";
import { paramsHash } from "./verify-ticket.js";
import { NotFoundError } from "./errors.js";

function makeDb(): DB {
  return openDb(":memory:");
}

const CTX = (): RunCtx => ({ audit: new MemoryAuditSink(), requestId: "req-appr" });

function makeRunningRun(db: DB): RunRow {
  const run = createRun(db, { kind: "alert_flow", alertId: "al-5712" }, CTX());
  transitionRun(db, run.id, "running", CTX());
  return run;
}

const CARD = {
  node: "execute_action",
  tool: "isolate_host",
  params: { host: "centos7" },
  reason: "调查报告建议遏制",
};

// ---------- 审批卡状态机（INV-10 同源仲裁：表之外的裁决一律 409） ----------

describe("approval 状态机迁移表全组合（INV-10）", () => {
  // 票 47（ADR 0004-1）：pending→expired 是审批卡保质期的合法迁移（时间出的裁决，
  // 分发循环的扫描器走它）；expired 是吸收态。
  const LEGAL = new Set(["pending>approved", "pending>rejected", "pending>expired"]);
  for (const from of APPROVAL_STATES) {
    for (const to of APPROVAL_STATES) {
      if (from === to) continue;
      const label = `${from} → ${to}`;
      if (LEGAL.has(`${from}>${to}`)) {
        test(`合法：${label}`, () => {
          expect(() => assertApprovalTransition(from, to)).not.toThrow();
        });
      } else {
        test(`非法：${label} → 409`, () => {
          expect(() => assertApprovalTransition(from, to)).toThrow(InvalidApprovalTransitionError);
        });
      }
    }
  }
});

// ---------- 开卡：卡与 (run, tool_call) 绑定，SSE 广播 approval_required（FR-M3.5） ----------

describe("openApprovalCard", () => {
  test("开卡即挂起：run running→awaiting_approval，卡 pending，广播 approval_required + 审计 create", () => {
    const db = makeDb();
    const run = makeRunningRun(db);
    const audit = new MemoryAuditSink();
    const card = openApprovalCard(db, { runId: run.id, ...CARD }, { audit, requestId: "req-open" });

    expect(card.id).toMatch(/^apr_/);
    expect(card).toMatchObject({
      runId: run.id,
      node: "execute_action",
      tool: "isolate_host",
      status: "pending",
      reason: "调查报告建议遏制",
    });
    // 参数指纹绑定：决定将来只对这份参数生效（INV-2 的锚）
    expect(card.paramsHash).toBe(paramsHash(CARD.params));
    expect(card.token).toBeNull();
    expect(card.executedAt).toBeNull();
    expect(getRun(db, run.id)?.status).toBe("awaiting_approval");

    const req = eventsAfter(db, run.id, 0).find((e) => e.type === "approval_required");
    expect(req?.payload).toMatchObject({
      approval_id: card.id,
      node: "execute_action",
      tool: "isolate_host",
      params: { host: "centos7" },
      reason: "调查报告建议遏制",
    });

    const entry = audit.entries.find((e) => e.objectType === "approval");
    expect(entry).toMatchObject({ action: "create", objectId: card.id, result: "SUCCESS" });
  });

  test("run 不在 running（queued）→ run 状态机 409，卡不开（同一事务回滚）", () => {
    const db = makeDb();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-1" }, CTX()); // queued
    expect(() => openApprovalCard(db, { runId: run.id, ...CARD }, CTX())).toThrow(
      InvalidRunTransitionError,
    );
    expect(listApprovals(db, "pending")).toHaveLength(0);
  });
});

// ---------- 裁决仲裁：先到先得，后到 409（PRD M10 并发审批后到者 409） ----------

describe("decideApproval 仲裁", () => {
  test("approve：pending→approved，记审批人与铸出的 token，审计 approve + 广播 approval_decided", () => {
    const db = makeDb();
    const run = makeRunningRun(db);
    const card = openApprovalCard(db, { runId: run.id, ...CARD }, CTX());
    const audit = new MemoryAuditSink();

    const decided = decideApproval(
      db,
      card.id,
      { approve: true, approver: "duty_lead", token: "h.p.s", tokenJti: "ap_j1" },
      { audit, requestId: "req-ok" },
    );

    expect(decided).toMatchObject({
      status: "approved",
      approver: "duty_lead",
      token: "h.p.s",
      tokenJti: "ap_j1",
    });
    expect(decided.decidedAt).not.toBeNull();

    expect(audit.entries[0]).toMatchObject({
      action: "approve",
      actor: { type: "user", id: "duty_lead" },
      objectType: "approval",
      objectId: card.id,
      result: "SUCCESS",
      details: { status: { from: "pending", to: "approved" } },
    });
    const ev = eventsAfter(db, run.id, 0).find((e) => e.type === "approval_decided");
    expect(ev?.payload).toMatchObject({ approval_id: card.id, decision: "approved", by: "duty_lead" });
  });

  test("reject：pending→rejected 带 reason，审计 reject（FR-S2.4 驳回留痕）", () => {
    const db = makeDb();
    const run = makeRunningRun(db);
    const card = openApprovalCard(db, { runId: run.id, ...CARD }, CTX());
    const audit = new MemoryAuditSink();

    const decided = decideApproval(
      db,
      card.id,
      { approve: false, approver: "duty_lead", reason: "证据不足，先补调查" },
      { audit, requestId: "req-no" },
    );

    expect(decided).toMatchObject({
      status: "rejected",
      approver: "duty_lead",
      rejectReason: "证据不足，先补调查",
    });
    expect(decided.token).toBeNull(); // 驳回不铸票
    expect(audit.entries[0]).toMatchObject({
      action: "reject",
      actor: { type: "user", id: "duty_lead" },
      details: { status: { from: "pending", to: "rejected" }, reason: "证据不足，先补调查" },
    });
    const ev = eventsAfter(db, run.id, 0).find((e) => e.type === "approval_decided");
    expect(ev?.payload).toMatchObject({ decision: "rejected", reason: "证据不足，先补调查" });
  });

  test.each([
    ["approve 后再 approve", "approve"],
    ["approve 后再 reject", "reject"],
    ["reject 后再 approve", "approve"],
    ["reject 后再 reject", "reject"],
  ])("并发审批：%s → 后到者 409（INV-10 同源仲裁）", (_label, second) => {
    const db = makeDb();
    const run = makeRunningRun(db);
    const card = openApprovalCard(db, { runId: run.id, ...CARD }, CTX());
    decideApproval(db, card.id, { approve: true, approver: "duty_lead", token: "h.p.s" }, CTX());
    expect(() =>
      decideApproval(
        db,
        card.id,
        { approve: second === "approve", approver: "duty_lead" },
        CTX(),
      ),
    ).toThrow(InvalidApprovalTransitionError);
  });

  test("未知卡 → NotFoundError（404）", () => {
    const db = makeDb();
    expect(() => decideApproval(db, "apr_nope", { approve: true, approver: "duty_lead" }, CTX())).toThrow(
      NotFoundError,
    );
  });
});

// ---------- 一次性执行标记（INV-2 的一次性在卡层面的锚） ----------

describe("markApprovalExecuted", () => {
  test("执行后打 executed_at + 审计 execute（记操作不记内容：工具名+参数hash+jti）", () => {
    const db = makeDb();
    const run = makeRunningRun(db);
    const card = openApprovalCard(db, { runId: run.id, ...CARD }, CTX());
    decideApproval(db, card.id, { approve: true, approver: "duty_lead", token: "h.p.s" }, CTX());
    const audit = new MemoryAuditSink();

    markApprovalExecuted(db, card.id, "ap_j1", { audit, requestId: "req-exec" });

    const after = getApproval(db, card.id);
    expect(after?.executedAt).not.toBeNull();
    expect(audit.entries[0]).toMatchObject({
      action: "execute",
      objectType: "approval",
      objectId: card.id,
      result: "SUCCESS",
      details: { tool: "isolate_host", jti: "ap_j1", params_hash: card.paramsHash },
    });
  });
});

// ---------- 列表与 wire 形状（m9 卡公开接口：GET /api/v1/approvals?status=pending） ----------

describe("listApprovals / toWire", () => {
  test("按 status 过滤；wire 是 snake_case 且 params 是原对象、executed 是布尔", () => {
    const db = makeDb();
    const runA = makeRunningRun(db);
    openApprovalCard(db, { runId: runA.id, ...CARD }, CTX());
    const runB = makeRunningRun(db);
    const decided = openApprovalCard(
      db,
      { runId: runB.id, ...CARD, params: { host: "web-01" } },
      CTX(),
    );
    decideApproval(db, decided.id, { approve: true, approver: "duty_lead", token: "h.p.s" }, CTX());

    expect(listApprovals(db, "pending").map((c) => c.runId)).toEqual([runA.id]);
    expect(listApprovals(db, "approved").map((c) => c.id)).toEqual([decided.id]);
    expect(listApprovals(db, "rejected")).toHaveLength(0);
    expect(listApprovals(db)).toHaveLength(2);

    const wire = toWire(listApprovals(db, "pending")[0]);
    expect(wire).toMatchObject({
      run_id: runA.id,
      node: "execute_action",
      tool: "isolate_host",
      params: { host: "centos7" },
      params_hash: paramsHash({ host: "centos7" }),
      status: "pending",
      executed: false,
    });
    expect(wire.approver).toBeNull();
  });
});
