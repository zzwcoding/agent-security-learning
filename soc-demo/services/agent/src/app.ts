import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "./db.js";
import { createRun, getRun, requireRun, type RunCtx } from "./runs.js";
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
import { TRIAGE_TOOLS } from "../workers/triage/prompt.js";
import { KNOWLEDGE_TOOLS } from "../workers/knowledge/prompt.js";
import type { RunRow } from "./runs.js";

// 本票放行的 run kind。chat_flow（票 18）到票再放——fail-closed：不认识的 kind 直接
// 400，不给「什么都接」留口子。knowledge_flow = 票 17 沉淀子图（案件关闭 → 提炼 →
// kb_write 人审闸）。
const RUN_KINDS = new Set(["alert_flow", "knowledge_flow"]);

// 每-kind 的任务票规格（FR-M3.4 worker 拉起即申领最小 scope 票；INV-3：票面永不含 L2
// ——kb_write 不在 knowledge 的 allowed_tools 里，L2 走审批卡铸 ApprovalToken）。
const TICKET_SPECS: Record<string, { sub: string; scope: string[]; allowedTools: string[] }> = {
  alert_flow: { sub: "agent:triage", scope: ["alert:update", "case:write"], allowedTools: [...TRIAGE_TOOLS] },
  knowledge_flow: { sub: "agent:knowledge", scope: ["case:read", "kb:propose"], allowedTools: [...KNOWLEDGE_TOOLS] },
};

// buildApp 纯工厂（全仓 seam 约定）：测试注入 :memory: db + MemoryAuditSink + 假铸票，
// 生产注入文件 db + HttpMintClient/HttpTokenBurner。REST 只是壳——审批卡领域在
// approvals.ts、执行在 graph.ts、SSE 的补发选择与 wire 格式在 events.ts（流式响应
// app.inject 打不了，逻辑必须可单测）。
export function buildApp(opts: {
  db?: DB;
  audit?: AuditSink;
  nodes?: FlowNode[];
  /** 每-run 图工厂（票 13）：alert_flow 拉起时先向 gateway 铸任务票（PRD FR-M3.4：
   *  worker 拉起即申领任务级最小 scope 票），再把票交进图工厂组 triage 子图。
   *  不传 = 用静态 nodes（薄径/审批演示），也不铸票。 */
  makeNodes?: (run: RunRow, ticket: string) => FlowNode[] | Promise<FlowNode[]>;
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
  // （PRD：内部触发 = M2 alert.created → 这里。票 13 起 alert_flow 经 makeNodes 接
  //   triage worker：先铸任务票（gateway /internal/mint，票面 scope=分诊六件套，
  //   无任何 L2——INV-3），再组图直跑到终态；铸票失败 502，不留无票 run。）
  app.post("/internal/runs", async (req, reply) => {
    const body = (req.body ?? {}) as { kind?: string; alert_id?: string; case_id?: string };
    if (!body.kind) return reply.status(400).send({ error: "kind_required" });
    if (!RUN_KINDS.has(body.kind)) {
      return reply.status(400).send({ error: "unknown_kind", details: [body.kind] });
    }
    // alert_flow 吃 alert_id；knowledge_flow 吃 case_id（票 17，案件关闭触发）
    if (body.kind === "knowledge_flow") {
      if (!body.case_id) return reply.status(400).send({ error: "case_id_required" });
    } else if (!body.alert_id) {
      return reply.status(400).send({ error: "kind_and_alert_id_required" });
    }
    const spec = TICKET_SPECS[body.kind];
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const actorId = (req.headers["x-actor-id"] as string) ?? "internal";
    const run = createRun(
      db,
      body.kind === "knowledge_flow"
        ? { kind: body.kind, caseId: body.case_id ?? null }
        : { kind: body.kind, alertId: body.alert_id },
      {
        audit,
        requestId,
        actor: { type: "system", id: actorId },
      },
    );
    let nodes = opts.nodes;
    if (opts.makeNodes) {
      try {
        const minted = await mint.mintTaskTicket({
          jti: `tk_${randomUUID()}`,
          sub: spec.sub,
          // 分诊时还没有 case（闸侧跳过绑定校验）；沉淀子图绑定案件（FR-S2.2）
          caseId: body.kind === "knowledge_flow" ? (body.case_id ?? null) : null,
          runId: run.id,
          scope: [...spec.scope],
          allowedTools: [...spec.allowedTools],
        });
        nodes = await opts.makeNodes(run, minted.token);
      } catch {
        return reply.status(502).send({ error: "mint_failed" });
      }
    }
    // 同步直跑到终态再 202（节点可异步：guards/LLM/M2 出站都 await）；
    // executeRun 自带失败兜底，壳不用改。真异步调度（先 202 后台跑）等后续票。
    await executeRun(db, run.id, { ...runOpts(req.headers as Record<string, unknown>), nodes });
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

  /** 票 17：makeNodes 图的 resume 组图。拉起时 worker 图是按 run 组的（票 13 工厂），
   *  resume 若不带它，runOpts 的静态 nodes 会把图换成薄径——LangGraph 找不到挂起的
   *  worker 节点直接跑完，L2 动作静默丢失。故 resume 前按原 run.kind 重新铸任务票
   *  （票面规格不变，INV-3 依旧无 L2）并重组 worker 图；静态 nodes（薄径/演示图）不受影响。 */
  async function rebuildResumeNodes(runId: string): Promise<FlowNode[] | undefined> {
    if (opts.nodes || !opts.makeNodes) return opts.nodes;
    const run = requireRun(db, runId);
    const spec = TICKET_SPECS[run.kind];
    const minted = await mint.mintTaskTicket({
      jti: `tk_${randomUUID()}`,
      sub: spec.sub,
      caseId: run.caseId,
      runId: run.id,
      scope: [...spec.scope],
      allowedTools: [...spec.allowedTools],
    });
    return opts.makeNodes(run, minted.token);
  }

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
    let resumeNodes: FlowNode[] | undefined;
    try {
      minted = await mint.mintApprovalToken({
        jti: `ap_${randomUUID()}`,
        approvalId: id,
        approvedBy: body.approver,
        tool: card.tool,
        params: card.params,
        caseId: card.caseId,
      });
      resumeNodes = await rebuildResumeNodes(card.runId);
    } catch {
      return reply.status(502).send({ error: "mint_failed" });
    }
    await decideAndResume(id, { approve: true, approver: body.approver, token: minted.token, tokenJti: String(minted.payload.jti ?? "") }, req.headers, resumeNodes);
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
    let resumeNodes: FlowNode[] | undefined;
    try {
      resumeNodes = await rebuildResumeNodes(card.runId);
    } catch {
      return reply.status(502).send({ error: "mint_failed" });
    }
    await decideAndResume(id, { approve: false, approver: body.approver, reason: body.reason }, req.headers, resumeNodes);
    return {
      approval_id: id,
      decision: "rejected",
      run_id: card.runId,
      run_status: getRun(db, card.runId)?.status ?? null,
    };
  });

  // 裁决（409 仲裁在审批状态机）→ resume 推进 run：批准路径执行 L2 动作，
  // 驳回路径节点拿到 rejected 决定跳过执行；两条路 run 都由信封链末态续跑。
  async function decideAndResume(
    id: string,
    decision: DecideInput,
    headers: Record<string, unknown>,
    resumeNodes?: FlowNode[],
  ): Promise<void> {
    const card = requireApproval(db, id);
    decideApproval(db, id, decision, httpCtx(headers));
    await resumeRun(db, card.runId, { ...runOpts(headers), nodes: resumeNodes });
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
