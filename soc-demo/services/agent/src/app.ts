import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "./db.js";
import { createRun, getRun } from "./runs.js";
import { executeRun, type FlowNode } from "./graph.js";
import { eventsAfter, formatSse } from "./events.js";
import { InvalidRunTransitionError, isTerminalRun } from "./statemachine.js";
import { TamperedCheckpointError } from "./envelope.js";
import { NotFoundError } from "./errors.js";
import { MemoryAuditSink, type AuditSink } from "./audit.js";

// 本票放行的 run kind。chat_flow（票 18）/知识沉淀（票 17）到票再放——fail-closed：
// 不认识的 kind 直接 400，不给「什么都接」留口子。
const RUN_KINDS = new Set(["alert_flow"]);

// buildApp 纯工厂（全仓 seam 约定）：测试注入 :memory: db + MemoryAuditSink，
// 生产注入文件 db。REST 只是壳——run 生命周期在 runs.ts、执行在 graph.ts、
// SSE 的补发选择与 wire 格式在 events.ts（流式响应 app.inject 打不了，逻辑必须可单测）。
export function buildApp(opts: { db?: DB; audit?: AuditSink; nodes?: FlowNode[] } = {}) {
  const db = opts.db ?? openDb(":memory:");
  const audit = opts.audit ?? new MemoryAuditSink();
  const app = Fastify();

  app.get("/healthz", () => ({ ok: true, service: "agent" }));

  app.setErrorHandler((err, _req, reply) => {
    if (
      err instanceof InvalidRunTransitionError ||
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
  // （PRD：内部触发 = M2 alert.created → 这里；本票 run 无 worker 直 END）
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
    // 薄径同步直跑（SQLite 全同步、无真 LLM）：返回时 run 已终态。
    // worker/LLM 接入后这里换异步调度；executeRun 自带失败兜底，壳不用改。
    executeRun(db, run.id, { nodes: opts.nodes, audit, requestId });
    return reply.status(202).send({ run_id: run.id });
  });

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
