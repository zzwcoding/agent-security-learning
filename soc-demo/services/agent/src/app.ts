import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "./db.js";
import { createRun, getRun, type RunCtx } from "./runs.js";
import { executeRun, resumeRun, type ExecuteOpts, type FlowNode } from "./graph.js";
import { eventsAfter, formatSse } from "./events.js";
import {
  APPROVAL_STATES,
  InvalidApprovalTransitionError,
  InvalidRunTransitionError,
  isTerminalRun,
  type ApprovalStatus,
} from "./statemachine.js";
import { decideApproval, listApprovals, requireApproval, toWire, type DecideInput } from "./approvals.js";
import { TamperedCheckpointError } from "./envelope.js";
import { NotFoundError } from "./errors.js";
import { MemoryAuditSink, type AuditSink } from "./audit.js";
import { HttpMintClient, HttpTokenBurner, type MintClient, type TokenBurner } from "./token-ports.js";
import type { BurnRegistry } from "./verify-ticket.js";

// 本票放行的 run kind。chat_flow（票 18）/知识沉淀（票 17）到票再放——fail-closed：
// 不认识的 kind 直接 400，不给「什么都接」留口子。
const RUN_KINDS = new Set(["alert_flow"]);

// buildApp 纯工厂（全仓 seam 约定）：测试注入 :memory: db + MemoryAuditSink + 假铸票，
// 生产注入文件 db + HttpMintClient/HttpTokenBurner。REST 只是壳——审批卡领域在
// approvals.ts、执行在 graph.ts、SSE 的补发选择与 wire 格式在 events.ts（流式响应
// app.inject 打不了，逻辑必须可单测）。
export function buildApp(opts: {
  db?: DB;
  audit?: AuditSink;
  nodes?: FlowNode[];
  /** 铸 ApprovalToken 的出站 seam（m9 卡：铸票调 gateway）。 */
  mint?: MintClient;
  /** 执行后的焚毁登记口（INV-2，M2 used_tokens）。 */
  burn?: TokenBurner;
  /** 验票闸重放读口（不传 = 闸不查焚毁表，见 verify-ticket 的 seam 说明）。 */
  used?: BurnRegistry;
  /** 验票 HMAC 密钥（缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
} = {}) {
  const db = opts.db ?? openDb(":memory:");
  const audit = opts.audit ?? new MemoryAuditSink();
  const mint = opts.mint ?? new HttpMintClient();
  const burn = opts.burn ?? new HttpTokenBurner();
  const app = Fastify();

  const httpCtx = (headers: Record<string, unknown>): RunCtx => ({
    audit,
    requestId: (headers["x-request-id"] as string) ?? randomUUID(),
  });
  const runOpts = (headers: Record<string, unknown>): ExecuteOpts => ({
    nodes: opts.nodes,
    audit,
    requestId: (headers["x-request-id"] as string) ?? randomUUID(),
    burn,
    used: opts.used,
    hmacKey: opts.hmacKey,
  });

  app.get("/healthz", () => ({ ok: true, service: "agent" }));

  app.setErrorHandler((err, _req, reply) => {
    if (
      err instanceof InvalidRunTransitionError ||
      err instanceof InvalidApprovalTransitionError ||
      err instanceof TamperedCheckpointError
    ) {
      return reply.status(err.httpStatus).send({ error: err.code });
    }
    if (err instanceof NotFoundError) {
      return reply.status(err.httpStatus).send({ error: err.code });
    }
    return reply.status(500).send({ error: "internal_error" });
  });

  // m3 卡公开接口：POST /internal/runs {kind, alert_id} → 202 {run_id}
  // （PRD：内部触发 = M2 alert.created → 这里；薄径 run 无 worker 直 END，
  //   AGENT_FLOW=approval_demo 时挂带 L2 动作的演示图，可 curl 走通审批回路）
  app.post("/internal/runs", (req, reply) => {
    const body = (req.body ?? {}) as { kind?: string; alert_id?: string };
    if (!body.kind || !body.alert_id) {
      return reply.status(400).send({ error: "kind_and_alert_id_required" });
    }
    if (!RUN_KINDS.has(body.kind)) {
      return reply.status(400).send({ error: "unknown_kind", details: [body.kind] });
    }
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const actorId = (req.headers["x-actor-id"] as string) ?? "internal";
    const run = createRun(db, { kind: body.kind, alertId: body.alert_id }, {
      audit,
      requestId,
      actor: { type: "system", id: actorId },
    });
    // 薄径同步直跑（SQLite 全同步、无真 LLM）：无 L2 时返回即终态；有 L2 时停在
    // awaiting_approval（审批是异步的人的输入）。worker/LLM 接入后这里换异步调度；
    // executeRun 自带失败兜底，壳不用改。
    executeRun(db, run.id, { nodes: opts.nodes, audit, requestId });
    return reply.status(202).send({ run_id: run.id });
  });

  // m9 卡公开接口：审批卡 REST（FR-S2.4）。批准 → 铸 ApprovalToken → resume；
  // 驳回 → 不铸票不执行，resume 让 run 走完（动作跳过）。两路都先裁决后由
  // resumeRun 推进 run；并发后到者在审批状态机处 409（approvals.ts 仲裁）。
  app.get("/api/v1/approvals", (req, reply) => {
    const q = req.query as { status?: string };
    let status: ApprovalStatus | undefined;
    if (q.status) {
      if (!APPROVAL_STATES.includes(q.status as ApprovalStatus)) {
        return reply.status(400).send({ error: "unknown_status", details: [q.status] });
      }
      status = q.status as ApprovalStatus;
    }
    return { approvals: listApprovals(db, status).map(toWire) };
  });

  app.post("/api/v1/approvals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approver?: string };
    if (!body.approver) return reply.status(400).send({ error: "approver_required" });
    const card = requireApproval(db, id); // 404
    // 廉价预检：卡已被裁决就别去麻烦 gateway（真仲裁仍在 decideApproval 事务里，
    // 这里只为省掉「后到者白铸一枚随即作废」的票）
    if (card.status !== "pending") {
      throw new InvalidApprovalTransitionError(card.status, "approved");
    }
    // 先铸票后裁决：铸票失败 → 卡仍 pending 可重试，不留「已批准无票」的悬置态。
    // 并发双批会各铸一枚，但裁决事务只放行先到者，后到的票随 409 一起作废（300s 自焚）。
    let minted: Awaited<ReturnType<MintClient["mintApprovalToken"]>>;
    try {
      minted = await mint.mintApprovalToken({
        jti: `ap_${randomUUID()}`,
        approvalId: id,
        approvedBy: body.approver,
        tool: card.tool,
        params: card.params,
        caseId: card.caseId,
      });
    } catch {
      return reply.status(502).send({ error: "mint_failed" });
    }
    decideAndResume(id, { approve: true, approver: body.approver, token: minted.token, tokenJti: String(minted.payload.jti ?? "") }, req.headers);
    return {
      approval_id: id,
      approval_token: minted.token,
      run_id: card.runId,
      run_status: getRun(db, card.runId)?.status ?? null,
    };
  });

  app.post("/api/v1/approvals/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approver?: string; reason?: string };
    if (!body.approver) return reply.status(400).send({ error: "approver_required" });
    const card = requireApproval(db, id); // 404
    decideAndResume(id, { approve: false, approver: body.approver, reason: body.reason }, req.headers);
    return {
      approval_id: id,
      decision: "rejected",
      run_id: card.runId,
      run_status: getRun(db, card.runId)?.status ?? null,
    };
  });

  // 裁决（409 仲裁在审批状态机）→ resume 推进 run：批准路径执行 L2 动作，
  // 驳回路径节点拿到 rejected 决定跳过执行；两条路 run 都由信封链末态续跑。
  function decideAndResume(id: string, decision: DecideInput, headers: Record<string, unknown>): void {
    const card = requireApproval(db, id);
    decideApproval(db, id, decision, httpCtx(headers));
    resumeRun(db, card.runId, runOpts(headers));
  }

  // m3 卡公开接口：GET /api/v1/events/stream?run_id=（SSE，INV-7）
  // 断线重连带 Last-Event-ID 头（EventSource 自动带）→ 按 id>cursor 补发，不丢不重。
  // ?after= 是同一游标的显式写法（与 M2 outbox 的 ?after= 同名，curl 调试方便）。
  app.get("/api/v1/events/stream", (req, reply) => {
    const q = req.query as { run_id?: string; after?: string };
    if (!q.run_id) return reply.status(400).send({ error: "run_id_required" });
    const run = getRun(db, q.run_id);
    if (!run) return reply.status(404).send({ error: "not_found" });

    const h = req.headers["last-event-id"];
    const raw = (Array.isArray(h) ? h[0] : h) ?? q.after ?? "0";
    const last = Number(raw);
    const events = eventsAfter(db, run.id, Number.isFinite(last) ? last : 0);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    reply.raw.write(formatSse(events));
    // run 进行中保持连接（实时推送等 run 异步化后接）；终态写完补发即收流，
    // EventSource 收到关闭，Web 端据此知道这条 run 播完了
    if (isTerminalRun(run.status)) reply.raw.end();
    return reply;
  });

  return app;
}
