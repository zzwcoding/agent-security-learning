import { expect, test, vi } from "vitest";
import { buildApp } from "./app.js";
import { HttpM2Client, MemoryM2Client, type M2Client } from "./m2client.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fixtures/alerts 的 5712（与 PRD §6-M1 契约示例同源）
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/alerts/${name}`, import.meta.url)), "utf8"),
  );

test("GET /healthz 返回 200 与服务名", async () => {
  const app = buildApp({ m2: new MemoryM2Client() });
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "ingest" });
  await app.close();
});

test("POST /api/v1/webhooks/alerts 全链路：接收校验→去重→映射→不可信标记→写 M2→发事件", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });

  const first = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks/alerts",
    payload: fixture("ssh-5712-real.json"),
  });
  expect(first.statusCode).toBe(201);
  expect(first.json()).toEqual({ alert_id: "al_stub_0001", dedup: false });

  // 同一 fixture 连推 3 次（INV-6）：响应幂等回既有 id；stub 收到的每次都带
  // 不可信标记——真库的 occurrences/唯一约束语义在 case-backend m2.test.ts 对真 SQLite 验证
  for (const expected of [
    { status: 200, dedup: true },
    { status: 200, dedup: true },
  ]) {
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/alerts",
      payload: fixture("ssh-5712-real.json"),
    });
    expect(again.statusCode).toBe(expected.status);
    expect(again.json().dedup).toBe(expected.dedup);
    expect(again.json().alert_id).toBe("al_stub_0001");
  }
  expect(m2.calls).toHaveLength(3);
  expect(new Set(m2.results.map((r) => r.alertId)).size).toBe(1); // 只建 1 条
  await app.close();
});

test("缺 rule.id → 422 invalid_alert 带 details（PRD §6-M1 契约）", async () => {
  const app = buildApp({ m2: new MemoryM2Client() });
  const bad: Record<string, unknown> = { ...fixture("ssh-5712-real.json") };
  delete bad.rule; // 缺 rule.id
  const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/alerts", payload: bad });
  expect(res.statusCode).toBe(422);
  expect(res.json().error).toBe("invalid_alert");
  expect(res.json().details).toEqual(["[0] rule.id_missing"]); // 批量时 [i] 定位到第几条
  await app.close();
});

test("畸形 JSON → 422 invalid_alert（盖掉 Fastify 默认 400，PRD 异常与边界）", async () => {
  const app = buildApp({ m2: new MemoryM2Client() });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks/alerts",
    payload: "{not json",
    headers: { "content-type": "application/json" },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error).toBe("invalid_alert");
  await app.close();
});

test("批量数组（FR-M1.1 单条/批量）：逐条映射，各自 dedup", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks/alerts",
    payload: [fixture("ssh-5712-real.json"), fixture("ssh-5712-real.json"), fixture("web-31103-cgi-500.json")],
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual([
    { alert_id: "al_stub_0001", dedup: false },
    { alert_id: "al_stub_0001", dedup: true },
    { alert_id: "al_stub_0002", dedup: false },
  ]);
  await app.close();
});

test("HttpM2Client（真实 HTTP adapter）：POST {base}/api/v1/alerts，201/200 → {alertId,dedup}", async () => {
  const seen: unknown[] = [];
  const { default: Fastify } = await import("fastify");
  const upstream = Fastify();
  upstream.post("/api/v1/alerts", async (req, reply) => {
    seen.push(req.body);
    return reply.status(201).send({ alert: { id: "al_real_1" }, dedup: false });
  });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const port = (upstream.server.address() as { port: number }).port;

  const client: M2Client = new HttpM2Client(`http://127.0.0.1:${port}`);
  const out = await client.ingestAlert({
    type: "wazuh_alert",
    source: "wazuh:centos7",
    sourceRef: "1682430696.3725",
    title: "t",
  });
  expect(out).toEqual({ alertId: "al_real_1", dedup: false });
  expect(seen).toHaveLength(1);
  await upstream.close();
});

// ---------- 票 35（票 09-3 线头清偿）：webhook 422 → M2 FAILURE 审计 ----------
// PRD §6-M1 异常与边界「畸形 JSON → 422 且进审计（result: FAILURE）」的后半句：
// 校验失败/畸形 JSON 时向 M2 审计五要素 FAILURE 条目（actor=ingest，details 带原因摘要）。
// 审计挂在 422 路径上但绝不改变 422 本身——M2 不可达只降级记日志（业务成功优先）。

test("校验失败 422：向 M2 审计 FAILURE（objectId 尽力取告警 id，details 带原因摘要）", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  const bad: Record<string, unknown> = { ...fixture("ssh-5712-real.json") };
  delete bad.rule;
  const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/alerts", payload: bad });
  expect(res.statusCode).toBe(422);
  expect(m2.calls).toHaveLength(0); // 业务写没发生
  expect(m2.auditFailures).toHaveLength(1);
  const f = m2.auditFailures[0];
  expect(f.objectId).toBe("1682430696.3725"); // rule.id 缺，但顶层告警 id 在 → 取它溯源
  expect(f.requestId).toBeTruthy();
  expect(f.details).toEqual({ reasons: ["[0] rule.id_missing"] }); // 与 422 响应体同源
  await app.close();
});

test("畸形 JSON 422：同样 FAILURE 审计（body 解析不了 → objectId=unknown，原因=解析错误）", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks/alerts",
    payload: "{not json",
    headers: { "content-type": "application/json" },
  });
  expect(res.statusCode).toBe(422);
  expect(m2.auditFailures).toHaveLength(1);
  expect(m2.auditFailures[0].objectId).toBe("unknown");
  expect((m2.auditFailures[0].details as { reasons: string[] }).reasons.length).toBe(1);
  await app.close();
});

test("校验失败能取到告警 id 时：objectId 用声明的 id（审计可按告警溯源）", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  const bad: Record<string, unknown> = { ...fixture("ssh-5712-real.json"), id: "1682430696.9999" };
  (bad.rule as Record<string, unknown>) = { ...((fixture("ssh-5712-real.json").rule) as Record<string, unknown>) };
  delete (bad.rule as Record<string, unknown>).id; // 缺 rule.id，但顶层 id 在
  const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/alerts", payload: bad });
  expect(res.statusCode).toBe(422);
  expect(m2.auditFailures).toHaveLength(1);
  expect(m2.auditFailures[0].objectId).toBe("1682430696.9999");
  await app.close();
});

test("正常推送：零 FAILURE 审计（SUCCESS 面的审计仍由 M2 写事务负责，两边不重复记）", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/webhooks/alerts",
    payload: fixture("ssh-5712-real.json"),
  });
  expect(res.statusCode).toBe(201);
  expect(m2.auditFailures).toHaveLength(0);
  await app.close();
});

test("HttpM2Client.auditFailure（真实 HTTP adapter）：POST {base}/internal/audit 五要素 FAILURE", async () => {
  const seen: unknown[] = [];
  const { default: Fastify } = await import("fastify");
  const upstream = Fastify();
  upstream.post("/internal/audit", async (req, reply) => {
    seen.push(req.body);
    return reply.status(201).send({ id: "row-1" });
  });
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const port = (upstream.server.address() as { port: number }).port;

  const client = new HttpM2Client(`http://127.0.0.1:${port}`);
  await client.auditFailure({
    objectId: "webhook-35X",
    details: { reasons: ["[0] rule.id_missing"] },
    requestId: "req-35-wire",
  });
  expect(seen).toEqual([
    {
      action: "ingest",
      actor: { type: "system", id: "m1:ingest" },
      object_id: "webhook-35X",
      object_type: "ingest_request",
      details: { reasons: ["[0] rule.id_missing"] },
      request_id: "req-35-wire",
      result: "FAILURE",
    },
  ]);
  await upstream.close();
});

test("HttpM2Client.auditFailure：M2 病了不抛只降级记日志（422 响应不被审计可用性劫持）", async () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const { default: Fastify } = await import("fastify");
  const upstream = Fastify();
  upstream.post("/internal/audit", async (_req, reply) => reply.status(500).send({ error: "internal_error" }));
  await upstream.listen({ port: 0, host: "127.0.0.1" });
  const port = (upstream.server.address() as { port: number }).port;

  const client = new HttpM2Client(`http://127.0.0.1:${port}`);
  await expect(
    client.auditFailure({ objectId: "x", details: { reasons: [] }, requestId: "req-35-down" }),
  ).resolves.toBeUndefined();
  const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
  expect(line.warn).toBe("audit_ingest_failed");
  errSpy.mockRestore();
  await upstream.close();
});
