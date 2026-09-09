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
import { NotFoundError, UnauthorizedError } from "./errors.js";
import { MemoryAuditSink, type AuditSink } from "./audit.js";
import { HttpMintClient, HttpTokenBurner, type MintClient, type TokenBurner, type UsedTokenReader } from "./token-ports.js";
import type { BurnRegistry } from "./verify-ticket.js";
import { THIN_CHAT_FLOW } from "../workers/chat/flow.js";
import { PRESET_IDENTITIES, SESSION_TTL_S, signSession, verifySession } from "../workers/chat/session.js";
import { visibleTools } from "../workers/chat/visible-tools.js";
import type { RunRow } from "./runs.js";
import { requireRunKind, runKindOf, type RunGraphFactory } from "./run-kinds.js";

// run kind 的放行/拉起实体/票面规格全部在 src/run-kinds.ts 注册表（票 44：一处注册
// 处处消费；原 RUN_KINDS/CASE_KINDS/TICKET_SPECS 三张平行表由此删除）。本文件只保留
// chat_flow 的公开 SSE 面路由（launchChatRun）——那是 app 层的 wire 形态，不是 kind
// 元数据。fail-closed 口径不变：不在册的 kind 直接 400，不给「什么都接」留口子。

// chat 流的 SSE wire 只出对话语义帧（PRD §6-M8 的 data.type 枚举 + 审批过程可见）；
// node_enter/node_exit/audit 是流水线视图的帧（/events/stream 原样给全量），对话流里
// 是噪声。票 31：本子集 ⊆ SSE_EVENT_TYPES（events.ts）这一事实由 sse-contract.test.ts
// 对 fixtures/sse-events.json 锁死——改名单先改样品，两端测试各自咬住对端。
export const CHAT_WIRE_TYPES = new Set([
  "token", "tool_call", "tool_result", "approval_required", "approval_decided", "denied", "done",
]);

// 每-kind 的任务票规格移入注册表（run-kinds.ts 的 ticket 格，票 44）。

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
   *  不传 = 用静态 nodes（薄径/审批演示），也不铸票。
   *  票 39：第三参带调用方 actor（/internal/runs 的 x-actor-id 派生）——close_flow
   *  的确认审计要记到确认人头上（INV-8）；既有工厂不读它，零影响。 */
  makeNodes?: RunGraphFactory;
  /** 铸 ApprovalToken 的出站 seam（m9 卡：铸票调 gateway）。 */
  mint?: MintClient;
  /** 执行后的焚毁登记口（INV-2，M2 used_tokens）。 */
  burn?: TokenBurner;
  /** 验票闸重放读口（进程内真相；不传 = 闸不查，见 verify-ticket 的 seam 说明）。 */
  used?: BurnRegistry;
  /** 票 34：跨进程焚毁真相读口（M2 GET /internal/used-tokens/:jti）。不传 = 不查跨进程
   *  真相（既有测试口径不变）；生产 index.ts 显式装配 HttpUsedTokenReader（INV-2）。 */
  usedReader?: UsedTokenReader;
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
    usedReader: opts.usedReader,
    hmacKey: opts.hmacKey,
  });

  app.get("/healthz", () => ({ ok: true, service: "agent" }));

  app.setErrorHandler((err, _req, reply) => {
    if (
      err instanceof InvalidRunTransitionError ||
      err instanceof InvalidApprovalTransitionError ||
      err instanceof TamperedCheckpointError ||
      err instanceof UnauthorizedError
    ) {
      return reply.status(err.httpStatus).send({ error: err.code });
    }
    if (err instanceof NotFoundError) {
      return reply.status(err.httpStatus).send({ error: err.code });
    }
    return reply.status(500).send({ error: "internal_error" });
  });

  // 会话密钥（FR-M8.1 教学版会话的签名钥，与票同门 HMAC 纪律）：缺它 = 会话面整体
  // fail-closed——登录与 /chat 都 503，绝不开无签名的匿名会话（INV-1）。
  const sessionKey = (): string | null => opts.hmacKey ?? process.env.SOC_HMAC_KEY ?? null;

  // m8 卡公开接口：会话登录端点（FR-M8.1 四预置身份 + FR-M8.2 可见工具清单下发）。
  // 教学版 = 选脸登录（系统不设用户管理，PRD §11 边界）；token 是 HMAC 签名的会话
  // （workers/chat/session.ts），claims 只有 sub/role，没有任何工具 scope。
  app.post("/api/v1/auth/login", async (req, reply) => {
    const key = sessionKey();
    if (!key) return reply.status(503).send({ error: "hmac_key_missing" });
    const body = (req.body ?? {}) as { username?: string };
    if (!body.username) return reply.status(400).send({ error: "username_required" });
    const identity = PRESET_IDENTITIES.find((i) => i.username === body.username);
    const ctx = httpCtx(req.headers as Record<string, unknown>);
    if (!identity) {
      // 陌生脸也留审计（INV-8）：红队演示的越权尝试从这一行就可回放
      audit.record({
        action: "login",
        actor: { type: "user", id: body.username },
        objectId: body.username,
        objectType: "session",
        details: { result: "unknown_identity" },
        requestId: ctx.requestId,
        result: "DENIED",
        createdAt: Date.now(),
      });
      return reply.status(401).send({ error: "unknown_identity" });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = {
      sid: `ses_${randomUUID()}`,
      sub: identity.username,
      role: identity.role,
      iat: nowSec,
      exp: nowSec + SESSION_TTL_S,
    };
    audit.record({
      action: "login",
      actor: { type: "user", id: identity.username },
      objectId: claims.sid,
      objectType: "session",
      details: { role: identity.role },
      requestId: ctx.requestId,
      result: "SUCCESS",
      createdAt: Date.now(),
    });
    return {
      session_id: claims.sid,
      token: signSession(claims, key),
      username: identity.username,
      role: identity.role,
      role_label: identity.label,
      // FR-M8.2：可见性即第一收窄——登录响应就下发按角色过滤的工具清单（Web 直接展示）
      visible_tools: visibleTools(identity.role),
      expires_at: claims.exp,
    };
  });

  // chat run 的共同拉起路（公开面 /api/v1/chat 与编排面 /internal/runs 同路）：铸只读
  // 任务票 → makeNodes 组 chat 子图（未装配 = 薄径兜底）→ 注入交接态（message/role）
  // 同步跑到终态或挂起。铸票失败 502，不留无票 run（与 /internal/runs 同一口径）。
  async function launchChatRun(
    run: RunRow,
    message: string,
    role: string,
    headers: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    let nodes: FlowNode[] = THIN_CHAT_FLOW;
    if (opts.makeNodes) {
      try {
        const spec = requireRunKind("chat_flow").ticket;
        const minted = await mint.mintTaskTicket({
          jti: `tk_${randomUUID()}`,
          sub: spec.sub,
          caseId: run.caseId,
          runId: run.id,
          scope: [...spec.scope],
          allowedTools: [...spec.allowedTools],
        });
        nodes = (await opts.makeNodes(run, minted.token)) ?? THIN_CHAT_FLOW;
      } catch {
        return { ok: false, status: 502, error: "mint_failed" };
      }
    }
    await executeRun(db, run.id, {
      ...runOpts(headers),
      nodes,
      initialState: { kind: "chat_flow", case_id: run.caseId, message, role },
    });
    return { ok: true };
  }

  // m8 卡公开接口：POST /api/v1/chat（FR-M8.1~M8.5 全链路；SSE wire 契约见 PRD §6-M8）。
  // 会话验签（过期 → 401 引导重登录）→ 建 chat run → 同步执行 → 事件全量补发成 SSE。
  // 挂起（require_approval 等审批）的流以 approval_required 帧收尾，客户端转
  // GET /events/stream?run_id= 续听（INV-7 补发语义同一张落盘总线）。
  //
  // wire 过滤名单 CHAT_WIRE_TYPES 挪到模块顶层（票 31：词表要能被契约测试 import）。
  app.post("/api/v1/chat", async (req, reply) => {
    const key = sessionKey();
    if (!key) return reply.status(503).send({ error: "hmac_key_missing" });
    const h = req.headers.authorization;
    const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : null;
    const claims = token ? verifySession(token, key, Math.floor(Date.now() / 1000)) : null;
    if (!claims) throw new UnauthorizedError();
    const body = (req.body ?? {}) as { message?: string; case_id?: string };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return reply.status(400).send({ error: "message_required" });

    const headers = req.headers as Record<string, unknown>;
    const run = createRun(db, { kind: "chat_flow", caseId: body.case_id || null }, {
      ...httpCtx(headers),
      actor: { type: "user", id: claims.sub },
    });
    const launched = await launchChatRun(run, message, claims.role, headers);
    if (!launched.ok) return reply.status(launched.status).send({ error: launched.error });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    reply.raw.write(formatSse(eventsAfter(db, run.id, 0).filter((e) => CHAT_WIRE_TYPES.has(e.type))));
    reply.raw.end();
    return reply;
  });

  // m3 卡公开接口：POST /internal/runs {kind, alert_id} → 202 {run_id}
  // （PRD：内部触发 = M2 alert.created → 这里。票 13 起 alert_flow 经 makeNodes 接
  //   triage worker：先铸任务票（gateway /internal/mint，票面 scope=分诊六件套，
  //   无任何 L2——INV-3），再组图直跑到终态；铸票失败 502，不留无票 run。
  //   票 18 起 chat_flow 同路进柴：吃 case_id + message + role（交接态随请求注入），
  //   经 launchChatRun 铸只读票组 chat 子图——公开面 POST /api/v1/chat 是它的正门。
  //   票 36 起 case_flow 同路进柴：吃 case_id 直拉调查+富化链（index.ts 组链）。）
  app.post("/internal/runs", async (req, reply) => {
    const body = (req.body ?? {}) as { kind?: string; alert_id?: string; case_id?: string; message?: string; role?: string };
    if (!body.kind) return reply.status(400).send({ error: "kind_required" });
    // 拉起校验全部读注册表（票 44）：不在册 400；intake 决定吃 alert_id 还是 case_id；
    // requiresMessage 是 chat_flow 的「没消息就没有图可跑」——缺 message 直接 400，不造空 run。
    const desc = runKindOf(body.kind);
    if (!desc) {
      return reply.status(400).send({ error: "unknown_kind", details: [body.kind] });
    }
    if (desc.intake === "case") {
      if (!body.case_id) return reply.status(400).send({ error: "case_id_required" });
    } else if (!body.alert_id) {
      return reply.status(400).send({ error: "kind_and_alert_id_required" });
    }
    if (desc.requiresMessage) {
      if (typeof body.message !== "string" || !body.message.trim()) {
        return reply.status(400).send({ error: "message_required" });
      }
    }
    const chatMessage = typeof body.message === "string" ? body.message.trim() : "";
    const spec = desc.ticket;
    const requestId = (req.headers["x-request-id"] as string) ?? randomUUID();
    const actorId = (req.headers["x-actor-id"] as string) ?? "internal";
    // 票 39：actor 类型诚实派生（照 M2 ctxOf 的内网信任口径——不猜，缺头按 internal
    // 系统记）：带了 x-actor-id 的调用方，agent:* 是执行体，其余按发起用户记。
    // 既有调用（无头）行为不变：{type:"system", id:"internal"}。
    const actorType =
      actorId === "internal"
        ? "system"
        : ((req.headers["x-actor-type"] as string) ?? (actorId.startsWith("agent:") ? "agent" : "user"));
    const actor = { type: actorType, id: actorId };
    const run = createRun(
      db,
      desc.intake === "case"
        ? { kind: body.kind, caseId: body.case_id ?? null }
        : { kind: body.kind, alertId: body.alert_id },
      {
        audit,
        requestId,
        actor,
      },
    );
    if (body.kind === "chat_flow") {
      // 角色缺省 = 空串 → 意图闸按未知角色 fail-closed deny（INV-1），不猜身份
      const launched = await launchChatRun(run, chatMessage, typeof body.role === "string" ? body.role : "", req.headers as Record<string, unknown>);
      if (!launched.ok) return reply.status(launched.status).send({ error: launched.error });
      return reply.status(202).send({ run_id: run.id });
    }
    let nodes = opts.nodes;
    if (opts.makeNodes) {
      try {
        const minted = await mint.mintTaskTicket({
          jti: `tk_${randomUUID()}`,
          sub: spec.sub,
          // 分诊时还没有 case（闸侧跳过绑定校验）；其余 kind 绑定案件（FR-S2.2）——
          // 票 36 起 case_flow 同 knowledge_flow 口径：case_id 随拉起即在
          caseId: body.kind === "alert_flow" ? null : (body.case_id ?? null),
          runId: run.id,
          scope: [...spec.scope],
          allowedTools: [...spec.allowedTools],
        });
        nodes = await opts.makeNodes(run, minted.token, { actor });
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
    const spec = requireRunKind(run.kind).ticket;
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
