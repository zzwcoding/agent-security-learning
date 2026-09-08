import { expect, test } from "vitest";
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
