// m13 harness 单测 · http.mjs 三态（200 / 422 / 超时）——specs/modules.md m13 卡测试计划：
// stub 服务打在 fetch 注入缝上，零真服务依赖（node:test，node --test test/）。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHttpClient, waitHealthy } from "../lib/http.mjs";

/** 一次性 stub：路由表 { 'METHOD /path': status | (req, body) => [status, responseBody] } */
async function withStub(routes, fn) {
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const hit = routes[`${req.method} ${req.url}`];
      if (hit === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      const [status, payload] =
        typeof hit === "function" ? hit(req, body)
        : Array.isArray(hit) ? hit
        : [hit, undefined];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    });
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(base);
  } finally {
    srv.close();
    await once(srv, "close");
  }
}

test("http.mjs 态一：200 解析 JSON 并带 ok 标志", async () => {
  await withStub({ "GET /healthz": (req) => [200, { ok: true, service: "stub" }] }, async (base) => {
    const request = createHttpClient({ baseUrl: base });
    const r = await request("/healthz");
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.deepEqual(r.json, { ok: true, service: "stub" });
  });
});

test("http.mjs 态二：422 非 2xx 原样透传（不吞不抛，throwOnError 才抛）", async () => {
  await withStub({ "POST /api/v1/webhooks/alerts": [422, { error: "invalid_alert", details: ["rule.id_missing"] }] }, async (base) => {
    const request = createHttpClient({ baseUrl: base });
    const r = await request("/api/v1/webhooks/alerts", { method: "POST", body: { timestamp: "x" } });
    assert.equal(r.status, 422);
    assert.equal(r.ok, false);
    assert.equal(r.json.error, "invalid_alert");
    const requestThrowing = createHttpClient({ baseUrl: base });
    await assert.rejects(
      requestThrowing("/api/v1/webhooks/alerts", { method: "POST", body: {}, throwOnError: true }),
      (err) => err.name === "HttpError" && err.status === 422,
    );
  });
});

test("http.mjs 态三：超时按 timeoutMs 中止并抛 request_failed", async () => {
  // stub 端收下请求但不回包——客户端 300ms 必须自己中止
  const srv = http.createServer(() => {
    /* 故意不回 */
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const request = createHttpClient({ baseUrl: `http://127.0.0.1:${srv.address().port}` });
  try {
    const t0 = Date.now();
    await assert.rejects(request("/slow", { timeoutMs: 300 }), (err) => {
      assert.match(err.message, /request_failed/);
      return true;
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 250 && elapsed < 5000, `应在 ~300ms 超时，实测 ${elapsed}ms`);
  } finally {
    srv.close();
    await once(srv, "close");
  }
});

test("http.mjs：缺 baseUrl 直接拒造（target 注入缝不可缺）", () => {
  assert.throws(() => createHttpClient({}), /baseUrl 必填/);
});

test("waitHealthy：绿则 true、持续不绿则 false（不硬起压）", async () => {
  await withStub({ "GET /healthz": [200, { ok: true }] }, async (base) => {
    const request = createHttpClient({ baseUrl: base });
    assert.equal(await waitHealthy(request, { tries: 2, intervalMs: 10 }), true);
  });
  const dead = createHttpClient({ baseUrl: "http://127.0.0.1:1" }); // 不可能有人监听的端口
  assert.equal(await waitHealthy(dead, { tries: 2, intervalMs: 10 }), false);
});
