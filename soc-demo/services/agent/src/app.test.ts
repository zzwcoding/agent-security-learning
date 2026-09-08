import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { createRun, transitionRun } from "./runs.js";
import { emitEvent } from "./events.js";

function makeApp(over: { db?: DB; audit?: MemoryAuditSink } = {}) {
  const db = over.db ?? openDb(":memory:");
  const audit = over.audit ?? new MemoryAuditSink();
  const app = buildApp({ db, audit });
  return { db, audit, app };
}

// ---------- POST /internal/runs（m3 卡公开接口）----------

test("GET /healthz 返回 200 与服务名", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "agent" });
  await app.close();
});

test("POST /internal/runs {kind, alert_id} → 202 {run_id}，薄径 run 无人干预已跑完", async () => {
  const { db, app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/internal/runs",
    payload: { kind: "alert_flow", alert_id: "al-5712" },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json().run_id).toMatch(/^run_/);

  // 薄径是同步直跑（无真 LLM）：请求回来时 run 已经 queued→running→completed
  const row = db.prepare("SELECT status, kind, alert_id FROM runs WHERE id = ?").get(
    res.json().run_id,
  ) as { status: string; kind: string; alert_id: string };
  expect(row).toEqual({ status: "completed", kind: "alert_flow", alert_id: "al-5712" });
  await app.close();
});

test.each([
  // 票 17：kind 分两个入口（alert_flow 吃 alert_id / knowledge_flow 吃 case_id），
  // 错误码随之拆细——缺 kind 与缺入口参数分开报。
  // 票 18：chat_flow 已进白名单（吃 case_id+message，另有 message_required 校验），
  // 「未知 kind」样例换成永不入册的名字。
  ["缺 kind", { alert_id: "al-1" }, "kind_required"],
  ["缺 alert_id", { kind: "alert_flow" }, "kind_and_alert_id_required"],
  ["未知 kind", { kind: "nope_flow", alert_id: "al-1" }, "unknown_kind"],
])("%s → 400", async (_label, payload, error) => {
  const { app } = makeApp();
  const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe(error);
  await app.close();
});

// ---------- GET /api/v1/events/stream（SSE，INV-7）----------

describe("SSE 流端点", () => {
  test("缺 run_id → 400；未知 run → 404（都是 JSON 错误，流开始前）", async () => {
    const { app } = makeApp();
    const noId = await app.inject({ method: "GET", url: "/api/v1/events/stream" });
    expect(noId.statusCode).toBe(400);
    expect(noId.json().error).toBe("run_id_required");

    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream?run_id=run_nope",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("not_found");
    await app.close();
  });

  test("Last-Event-ID 补发端到端：真端口 SSE，从游标后逐条补齐、wire 格式正确、终态收流", async () => {
    const { db, app } = makeApp();
    // 手工布景：一个已完成的 run + 3 条事件（真 run 的执行细节在 graph/envelope 单测锁）
    const sseCtx = { audit: new MemoryAuditSink(), requestId: "req-sse" };
    const run = createRun(db, { kind: "alert_flow", alertId: "al-1" }, sseCtx);
    transitionRun(db, run.id, "running", sseCtx);
    transitionRun(db, run.id, "completed", sseCtx); // 开到终态，服务端才会收流
    const e1 = emitEvent(db, run.id, "node_enter", { node: "intake" });
    const e2 = emitEvent(db, run.id, "node_exit", { node: "intake" });
    emitEvent(db, run.id, "audit", { action: "update" });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    // 客户端收到过 e1，断线重连带 Last-Event-ID → 恰好补 e2、e3
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events/stream?run_id=${run.id}`, {
      headers: { "last-event-id": String(e1.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text(); // run 已终态 → 服务端收流，fetch 能读完整
    const blocks = text.split("\n\n").filter((b) => b.trim());
    expect(blocks).toHaveLength(2);
    const parsed = blocks.map((b) => {
      const lines = b.split("\n");
      return {
        id: Number(lines.find((l) => l.startsWith("id:"))?.slice(4)),
        event: lines.find((l) => l.startsWith("event:"))?.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data:"))?.slice(6) ?? "{}"),
      };
    });
    expect(parsed.map((p) => p.id)).toEqual([e2.id, e2.id + 1]); // 不丢不重、严格递增
    expect(parsed.map((p) => p.event)).toEqual(["node_exit", "audit"]);
    expect(parsed[0].data).toMatchObject({ type: "node_exit", run_id: run.id, node: "intake" });

    // 游标已到末尾：200 + 空流（EventSource 挂着等新事件；终态则立刻收流）
    const caught = await fetch(
      `http://127.0.0.1:${port}/api/v1/events/stream?run_id=${run.id}`,
      { headers: { "last-event-id": String(e2.id + 1) } },
    );
    expect(caught.status).toBe(200);
    expect(await caught.text()).toBe("");
    await app.close();
  });
});
