import { expect, test } from "vitest";
import { buildApp } from "./app.js";

test("GET /healthz 返回 200 与服务名", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "agent" });
  await app.close();
});
