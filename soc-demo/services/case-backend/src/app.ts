import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { openDb } from "./db.js";
import {
  JtiExistsError,
  MergeTargetClosedError,
  NotFoundError,
  VerdictLockedError,
  VerdictRequiredError,
  addCaseObservable,
  addTimelineEntry,
  closeAlert,
  closeCase,
  createCaseFromAlert,
  createCaseManual,
  findActiveCases,
  getAlert,
  getCaseDetail,
  ingestAlert,
  listAlerts,
  listCases,
  listTimeline,
  lookupUsedToken,
  mergeAlertIntoCase,
  patchAlert,
  patchCase,
  pollEvents,
  queryAudit,
  registerUsedToken,
  reopenAlert,
  type Ctx,
} from "./store.js";
import { InvalidTransitionError } from "./statemachine.js";
import {
  KbInvalidError,
  createKbProposal,
  decideKbProposal,
  listKbProposals,
  searchApprovedKb,
} from "./kb.js";

// buildApp 是纯工厂（seam，阶段 0.3 拆分沿用）：测试注入 :memory: db，生产注入文件 db。
// REST 面照 PRD §6-M2 接口契约；另有四个薄出口，决策记录见票 03 实现记录：
// GET /cases/:id（三结局要读 observables/tasks）、POST /alerts/:id/reopen（FR-M2.1 重开）、
// GET /api/v1/events（outbox 轮询 seam）、/internal/used-tokens（m9 焚毁表读写口）。
export function buildApp(opts: { db?: DB } = {}) {
  const db = opts.db ?? openDb(":memory:");
  const app = Fastify();

  app.get("/healthz", () => ({ ok: true, service: "case-backend" }));

  // M2 信任内网调用方传入的 actor（PRD 职责与边界）；requestId 串联一次请求的全部审计
  function ctxOf(h: Record<string, unknown>): Ctx {
    const actorId = (h["x-actor-id"] as string) ?? "system";
    return {
      actor: {
        type: (h["x-actor-type"] as string) ?? (actorId.startsWith("agent:") ? "agent" : "user"),
        id: actorId,
      },
      requestId: (h["x-request-id"] as string) ?? randomUUID(),
    };
  }

  app.setErrorHandler((err, _req, reply) => {
    if (
      err instanceof InvalidTransitionError ||
      err instanceof VerdictRequiredError ||
      err instanceof VerdictLockedError ||
      err instanceof MergeTargetClosedError ||
      err instanceof JtiExistsError ||
      err instanceof KbInvalidError ||
      err instanceof NotFoundError
    ) {
      return reply.status(err.httpStatus).send({ error: err.code });
    }
    return reply.status(500).send({ error: "internal_error" });
  });

  // ---- alerts ----
  // m1 写入口（票 09，m1 卡 Seam「出站写库 = M2 REST」）：去重 upsert 在 store.ingestAlert，
  // 唯一约束兜底在 SQLite；新建 201 / 重复 200（幂等返回既有 id，不产生新事件）。
  app.post("/api/v1/alerts", (req, reply) => {
    const input = (req.body ?? {}) as {
      type?: string; source?: string; sourceRef?: string; title?: string;
    };
    if (!input.type || !input.source || !input.sourceRef || !input.title) {
      return reply.status(400).send({ error: "invalid_alert" });
    }
    const { alert, dedup } = ingestAlert(
      db,
      input as unknown as Parameters<typeof ingestAlert>[1],
    );
    return reply.status(dedup ? 200 : 201).send({ alert, dedup });
  });

  app.get("/api/v1/alerts", (req) => {
    const q = req.query as { status?: string; host?: string };
    return listAlerts(db, { status: q.status, host: q.host });
  });

  app.get("/api/v1/alerts/:id", (req, reply) => {
    const alert = getAlert(db, (req.params as { id: string }).id);
    if (!alert) return reply.status(404).send({ error: "not_found" });
    return alert;
  });

  app.post("/api/v1/alerts/:id/create-case", (req, reply) => {
    const { id } = req.params as { id: string };
    return reply
      .status(201)
      .send(createCaseFromAlert(db, id, (req.body ?? {}) as object, ctxOf(req.headers)));
  });

  app.post("/api/v1/alerts/:id/merge/:caseId", (req) => {
    const { id, caseId } = req.params as { id: string; caseId: string };
    return mergeAlertIntoCase(db, id, caseId, ctxOf(req.headers));
  });

  app.post("/api/v1/alerts/:id/close", (req) => {
    const { id } = req.params as { id: string };
    return closeAlert(db, id, (req.body ?? {}) as { verdict?: string }, ctxOf(req.headers));
  });

  app.post("/api/v1/alerts/:id/reopen", (req) => {
    const { id } = req.params as { id: string };
    return reopenAlert(db, id, ctxOf(req.headers));
  });

  // m4 分诊写回（票 13）：verdict_ai 落库 + FR-M4.5 verdict 锁（claim/outcome 两拍），
  // uncertain 挂人工待办同 PATCH 带 status（走 alert 状态机）。语义见 store.patchAlert。
  app.patch("/api/v1/alerts/:id", (req) => {
    const { id } = req.params as { id: string };
    return patchAlert(
      db, id,
      (req.body ?? {}) as { verdict?: string; verdict_ai?: unknown; status?: string },
      ctxOf(req.headers),
    );
  });

  // ---- cases（/active 是静态段，注册在 :id 之前更稳）----
  app.get("/api/v1/cases/active", (req) => {
    const q = req.query as { host?: string; within_hours?: string };
    return findActiveCases(db, q.host ?? "", Number(q.within_hours ?? "24"));
  });

  app.get("/api/v1/cases", (req) => {
    const q = req.query as { status?: string };
    return listCases(db, { status: q.status });
  });

  app.post("/api/v1/cases", (req, reply) => {
    const body = (req.body ?? {}) as {
      title?: string; description?: string; severity?: number; assignee?: string; tags?: string[];
    };
    if (!body.title) return reply.status(400).send({ error: "title_required" });
    return reply.status(201).send(createCaseManual(db, { ...body, title: body.title }, ctxOf(req.headers)));
  });

  app.get("/api/v1/cases/:id", (req, reply) => {
    const detail = getCaseDetail(db, (req.params as { id: string }).id);
    if (!detail) return reply.status(404).send({ error: "not_found" });
    return detail;
  });

  app.patch("/api/v1/cases/:id", (req) => {
    const { id } = req.params as { id: string };
    return patchCase(db, id, (req.body ?? {}) as Record<string, unknown>, ctxOf(req.headers));
  });

  app.post("/api/v1/cases/:id/close", (req) => {
    const { id } = req.params as { id: string };
    return closeCase(
      db, id,
      (req.body ?? {}) as { verdict?: string; verdictNote?: string },
      ctxOf(req.headers),
    );
  });

  app.get("/api/v1/cases/:id/timeline", (req) =>
    listTimeline(db, (req.params as { id: string }).id));

  // m6 富化回写（票 15，FR-M6.3）：analyzer artifacts 经 L1 add_observable 落这里。
  // 去重合并语义在 store.addCaseObservable（按 dataType+data）；HTTP 面新建 201 /
  // 合并 200，对齐 ingest 去重的状态码口径。
  app.post("/api/v1/cases/:id/observables", (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      dataType?: string; data?: string; message?: string; tlp?: number; pap?: number; ioc?: boolean; tags?: string[];
    };
    const { dataType, data } = body;
    if (!dataType || !data) {
      return reply.status(400).send({ error: "data_type_and_data_required" });
    }
    const { observable, dedup } = addCaseObservable(db, id, { ...body, dataType, data }, ctxOf(req.headers));
    return reply.status(dedup ? 200 : 201).send({ observable, dedup });
  });

  app.post("/api/v1/cases/:id/timeline", (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { kind?: string; author?: string; body?: string; structured?: unknown };
    if (!body.kind || !body.author) {
      return reply.status(400).send({ error: "kind_and_author_required" });
    }
    // structured：机读负载（PRD §5.5 TimelineEntry.structured，票 14 起透传——
    // 调查报告 FR-M5.4 的 eval/检索依赖它原样读回）
    return reply.status(201).send(
      addTimelineEntry(
        db, id,
        {
          kind: body.kind,
          author: body.author,
          body: body.body ?? "",
          structured: body.structured,
        },
        ctxOf(req.headers),
      ),
    );
  });

  // ---- kb/proposals（票 17，m7 卡公开接口决策：REST 面挂 M2；契约 PRD §6-M7）----
  // 账面（SQLite 状态机 + 审计）在 M2；向量检索面（chroma）在 agent 侧 kb_write
  // （L2 ApprovalToken 正门）——两个面的分工见 kb.ts 文件头。
  app.post("/api/v1/kb/proposals", (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: string; title?: string; body?: string; tags?: string[];
      source_case_id?: string; proposed_by?: string;
    };
    if (!body.kind || !body.title || !body.body) {
      return reply.status(400).send({ error: "kind_title_body_required" });
    }
    return reply.status(201).send(
      createKbProposal(
        db,
        {
          kind: body.kind, title: body.title, body: body.body, tags: body.tags,
          source_case_id: body.source_case_id ?? null,
          proposed_by: body.proposed_by ?? "agent:knowledge",
        },
        ctxOf(req.headers),
      ),
    );
  });

  app.get("/api/v1/kb/proposals", (req) => {
    const q = req.query as { status?: string };
    return { proposals: listKbProposals(db, { status: q.status }) };
  });

  app.post("/api/v1/kb/proposals/:id/approve", (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reviewer?: string };
    // reviewer 缺省值班长（CONTEXT 角色：值班长是 L2 审批者）；真实人审身份锚在
    // agent 侧审批卡 + ApprovalToken.approved_by（INV-9），这里是留痕镜像
    const reviewer = body.reviewer ?? (req.headers["x-actor-id"] as string) ?? "duty_lead";
    return decideKbProposal(db, id, { approve: true, reviewer }, ctxOf(req.headers));
  });

  app.post("/api/v1/kb/proposals/:id/reject", (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reviewer?: string; reason?: string };
    const reviewer = body.reviewer ?? (req.headers["x-actor-id"] as string) ?? "duty_lead";
    return decideKbProposal(db, id, { approve: false, reviewer, reason: body.reason }, ctxOf(req.headers));
  });

  app.get("/api/v1/kb/search", (req) => {
    const q = req.query as { q?: string; kind?: string; k?: string };
    return { hits: searchApprovedKb(db, { q: q.q, kind: q.kind, k: q.k ? Number(q.k) : undefined }) };
  });

  // ---- audit / events / internal ----
  app.get("/api/v1/audit", (req) => {
    const q = req.query as { objectId?: string; requestId?: string };
    return queryAudit(db, q);
  });

  app.get("/api/v1/events", (req) => {
    const q = req.query as { after?: string; limit?: string };
    return { events: pollEvents(db, Number(q.after ?? "0"), Number(q.limit ?? "100")) };
  });

  app.post("/internal/used-tokens", (req, reply) => {
    const body = (req.body ?? {}) as { jti?: string; source?: string };
    if (!body.jti) return reply.status(400).send({ error: "jti_required" });
    return reply
      .status(201)
      .send(registerUsedToken(db, body as { jti: string; source?: string }, ctxOf(req.headers)));
  });

  app.get("/internal/used-tokens/:jti", (req, reply) => {
    const hit = lookupUsedToken(db, (req.params as { jti: string }).jti);
    if (!hit) return reply.status(404).send({ error: "not_found" });
    return hit;
  });

  return app;
}
