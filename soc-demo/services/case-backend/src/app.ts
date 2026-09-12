import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { openDb } from "./db.js";
import {
  JtiExistsError,
  MergeTargetClosedError,
  NotFoundError,
  TaskCaseMismatchError,
  VerdictRequiredError,
  VerdictLockedError,
  TASK_GROUPS,
  addCaseObservable,
  addTaskLog,
  addTimelineEntry,
  closeAlert,
  closeCase,
  createCaseFromAlert,
  createCaseManual,
  createTask,
  findActiveCases,
  getAlert,
  getCaseDetail,
  ingestAlert,
  ingestAuditEntry,
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
import { registerUnderPressure } from "./under-pressure.js";
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
    // 票 68：under-pressure 的过载 503 原样放行（插件自带语义：503 + Retry-After 头 +
    // FST_UNDER_PRESSURE body）——不落通用 500 兜底（卸载面必须诚实）；off 时该 code
    // 不会出现，本分支零触发，既有错误行为逐字节不变。
    if ((err as { code?: string }).code === "FST_UNDER_PRESSURE") {
      return reply.send(err);
    }
    if (
      err instanceof InvalidTransitionError ||
      err instanceof VerdictRequiredError ||
      err instanceof VerdictLockedError ||
      err instanceof MergeTargetClosedError ||
      err instanceof JtiExistsError ||
      err instanceof TaskCaseMismatchError ||
      err instanceof KbInvalidError ||
      err instanceof NotFoundError
    ) {
      return reply.status(err.httpStatus).send({ error: err.code });
    }
    return reply.status(500).send({ error: "internal_error" });
  });

  // 票 68（框架红线）：under-pressure 过载卸载装配——UNDER_PRESSURE=on 才 register
  //（env 缺省/其他值 = 零注册 = 默认形态逐字节不变，开关与阈值见 under-pressure.ts）；
  // 503 语义与 /status 指标口都是插件自带。
  registerUnderPressure(app);

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

  // ---- tasks（票 36·G2-5 收口：FR-M2.5 Task log 写口）----
  // m2 卡六实体的 Task 补上写半边：建任务 + 任务日志。日志 = 挂 task_id 的时间线条目
  // （PRD §5.4 Task.logs: TimelineEntry[]），调查工具面 add_task_log 落这里。
  // 与 /internal/audit 同款薄口纪律：只拦字段必填/枚举，业务裁决在 store。
  app.post("/api/v1/cases/:id/tasks", (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: string; group?: string; assignee?: string };
    if (!body.title) return reply.status(400).send({ error: "title_required" });
    if (body.group !== undefined && !(TASK_GROUPS as readonly string[]).includes(body.group)) {
      return reply.status(400).send({ error: "invalid_task_group", details: [...TASK_GROUPS] });
    }
    // title 的必填窄化过不了整对象传参（TS 不沿控制流收窄属性到对象类型），显式钉回
    return reply.status(201).send(createTask(db, id, { ...body, title: body.title }, ctxOf(req.headers)));
  });

  // 任务日志 kind 复用 PRD §5.5 TimelineEntry.kind 枚举（缺省 note）
  const TASK_LOG_KINDS = new Set(["note", "investigation_report", "enrichment_report", "approval", "execution", "system"]);
  app.post("/api/v1/tasks/:id/log", (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { case_id?: string; author?: string; body?: string; kind?: string };
    if (!body.case_id) return reply.status(400).send({ error: "case_id_required" });
    if (!body.author) return reply.status(400).send({ error: "author_required" });
    if (!body.body) return reply.status(400).send({ error: "body_required" });
    if (body.kind !== undefined && !TASK_LOG_KINDS.has(body.kind)) {
      return reply.status(400).send({ error: "invalid_kind" });
    }
    return reply.status(201).send(
      addTaskLog(
        db, id,
        { caseId: body.case_id, author: body.author, body: body.body, kind: body.kind },
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

  // 票 35（FR-S5 两路汇入）：跨服务审计写口（内部面先例 /internal/used-tokens、/internal/mint）。
  // agent HttpAuditSink 与 ingest webhook FAILURE 把五要素条目 POST 进来，落 audit_entries
  // 真相源（INV-8）。M2 信任内网调用方传入的 actor/五要素（同 ctxOf 的内网信任口径）；
  // 薄口只拦必填缺失与 result 白名单外——字段层校验，不做业务裁决。
  const AUDIT_RESULTS = new Set(["SUCCESS", "FAILURE", "DENIED"]);
  app.post("/internal/audit", (req, reply) => {
    const body = (req.body ?? {}) as {
      action?: string;
      actor?: { type?: string; id?: string };
      object_id?: string;
      object_type?: string;
      details?: unknown;
      request_id?: string;
      result?: string;
      created_at?: number;
    };
    const filled = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;
    const resultOk = body.result === undefined || AUDIT_RESULTS.has(body.result);
    if (!filled(body.action) || !filled(body.object_id) || !filled(body.object_type) ||
        !filled(body.request_id) || !resultOk) {
      return reply.status(400).send({ error: "invalid_audit" });
    }
    return reply.status(201).send(
      ingestAuditEntry(db, {
        action: body.action,
        actor: { type: body.actor?.type ?? "system", id: body.actor?.id ?? "external" },
        objectId: body.object_id,
        objectType: body.object_type,
        details: body.details,
        requestId: body.request_id,
        result: body.result,
        createdAt: body.created_at,
      }),
    );
  });

  return app;
}
