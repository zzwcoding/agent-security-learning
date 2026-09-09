// 票 49（ADR 0004-3）：受控反查口 POST /api/v1/pii/reveal。
// 反查是「人」的动作不是工具调用——不走 FGA 工具闸（A.2 四族装不下 PII 反查，
// 票面记票交 L0 追认），走登录会话 + 端点级角色白名单（duty_lead/admin，soc1/
// redteam 403）。每查必审计（INV-8）：查了什么占位符、谁查的、结果如何；
// 映射表内容（原文）属敏感面——审计 details 只记命中条数，绝不记原文（金丝雀
// 式断言，INV-4 的类推口径）。guards 转发走 guards-client.revealPii 出站 seam，
// 测试注入假件，契约行为在本文件用本地样例服务器验。
import http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AddressInfo } from "node:net";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { revealPii, type PiiRevealOutcome } from "./guards-client.js";
import { KEY } from "../workers/triage/testkit.js";

const ORIGINAL = "13812345678";

function makeApp(over: {
  audit?: MemoryAuditSink;
  reveal?: (placeholder: string) => Promise<PiiRevealOutcome>;
} = {}) {
  const db = openDb(":memory:");
  const audit = over.audit ?? new MemoryAuditSink();
  const app = buildApp({ db, audit, hmacKey: KEY, dispatcher: false, revealPii: over.reveal });
  return { audit, app };
}

async function tokenOf(app: ReturnType<typeof buildApp>, username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username } });
  return (res.json() as { token: string }).token;
}

const fakeReveal = async (placeholder: string) =>
  placeholder === "<NO_SUCH_TYPE>"
    ? { ok: false as const, reason: "placeholder_unknown" }
    : { ok: true as const, placeholder, originals: [ORIGINAL] };

describe("POST /api/v1/pii/reveal 角色闸（A.2 特殊化的端点白名单）", () => {
  test("duty_lead / admin 可用：原文返回 + SUCCESS 审计", async () => {
    const { audit, app } = makeApp({ reveal: fakeReveal });
    for (const username of ["duty_lead@soc.local", "admin@soc.local"]) {
      const token = await tokenOf(app, username);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/pii/reveal",
        headers: { authorization: `Bearer ${token}` },
        payload: { placeholder: "<PHONE_NUMBER>" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ placeholder: "<PHONE_NUMBER>", originals: [ORIGINAL] });
    }
    const reveals = audit.entries.filter((e) => e.action === "pii_reveal");
    expect(reveals).toHaveLength(2);
    for (const e of reveals) {
      expect(e.result).toBe("SUCCESS");
      expect(e.actor).toMatchObject({ type: "user" });
      expect(e.objectType).toBe("pii_placeholder");
      expect(e.details).toEqual({ match_count: 1 });
    }
    await app.close();
  });

  test("soc1 / redteam 不可用：403 + DENIED 审计（每查必审计含被拒的查）", async () => {
    const { audit, app } = makeApp({ reveal: fakeReveal });
    for (const username of ["soc1@soc.local", "redteam@soc.local"]) {
      const token = await tokenOf(app, username);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/pii/reveal",
        headers: { authorization: `Bearer ${token}` },
        payload: { placeholder: "<PHONE_NUMBER>" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "pii_reveal_forbidden" });
    }
    const denied = audit.entries.filter((e) => e.action === "pii_reveal");
    expect(denied).toHaveLength(2);
    expect(denied.every((e) => e.result === "DENIED")).toBe(true);
    expect(denied.every((e) => e.details.role === "soc1" || e.details.role === "redteam")).toBe(true);
    await app.close();
  });

  test("无 token / 坏 token → 401；缺 placeholder → 400；缺 HMAC 密钥 → 503", async () => {
    const { app } = makeApp({ reveal: fakeReveal });
    const noAuth = await app.inject({ method: "POST", url: "/api/v1/pii/reveal", payload: { placeholder: "<PHONE_NUMBER>" } });
    expect(noAuth.statusCode).toBe(401);
    const badAuth = await app.inject({
      method: "POST", url: "/api/v1/pii/reveal",
      headers: { authorization: "Bearer junk.junk" },
      payload: { placeholder: "<PHONE_NUMBER>" },
    });
    expect(badAuth.statusCode).toBe(401);
    const token = await tokenOf(app, "duty_lead@soc.local");
    const noParam = await app.inject({
      method: "POST", url: "/api/v1/pii/reveal",
      headers: { authorization: `Bearer ${token}` },
      payload: { placeholder: "   " },
    });
    expect(noParam.statusCode).toBe(400);
    expect(noParam.json()).toEqual({ error: "placeholder_required" });
    const keyless = buildApp({ db: openDb(":memory:"), audit: new MemoryAuditSink(), dispatcher: false });
    const res = await keyless.inject({ method: "POST", url: "/api/v1/pii/reveal", payload: { placeholder: "<PHONE_NUMBER>" } });
    expect(res.statusCode).toBe(503);
    await keyless.close();
    await app.close();
  });
});

describe("反查的失败面（guards 出站分类 + 审计 FAILURE）", () => {
  test("占位符查无此人 → 404 placeholder_unknown + FAILURE 审计", async () => {
    const { audit, app } = makeApp({ reveal: fakeReveal });
    const token = await tokenOf(app, "duty_lead@soc.local");
    const res = await app.inject({
      method: "POST", url: "/api/v1/pii/reveal",
      headers: { authorization: `Bearer ${token}` },
      payload: { placeholder: "<NO_SUCH_TYPE>" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "placeholder_unknown" });
    const e = audit.entries.find((x) => x.action === "pii_reveal");
    expect(e?.result).toBe("FAILURE");
    expect(e?.details.reason).toBe("placeholder_unknown");
    await app.close();
  });

  test("guards 不可达 → 502 guards_unavailable + FAILURE 审计（fail-closed 不编原文）", async () => {
    const { audit, app } = makeApp({
      reveal: async () => ({ ok: false, reason: "guards_unreachable" }),
    });
    const token = await tokenOf(app, "duty_lead@soc.local");
    const res = await app.inject({
      method: "POST", url: "/api/v1/pii/reveal",
      headers: { authorization: `Bearer ${token}` },
      payload: { placeholder: "<PHONE_NUMBER>" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "guards_unavailable" });
    const e = audit.entries.find((x) => x.action === "pii_reveal");
    expect(e?.result).toBe("FAILURE");
    await app.close();
  });
});

describe("金丝雀式断言：映射原文不进任何审计面（INV-4 类推）", () => {
  test("成功/被拒/失败三路全走一遍，审计序列化后 grep 不到原文", async () => {
    const { audit, app } = makeApp({ reveal: fakeReveal });
    for (const username of ["duty_lead@soc.local", "soc1@soc.local"]) {
      const token = await tokenOf(app, username);
      await app.inject({
        method: "POST", url: "/api/v1/pii/reveal",
        headers: { authorization: `Bearer ${token}` },
        payload: { placeholder: "<PHONE_NUMBER>" },
      });
    }
    // 占位符本身可以进审计（它就是要审的对象），原文一个字节都不许
    const dump = JSON.stringify(audit.entries);
    expect(dump).toContain("<PHONE_NUMBER>");
    expect(dump).not.toContain(ORIGINAL);
    await app.close();
  });
});

// ---------- guards-client.revealPii：HTTP 出站契约（本地样例服务器，不出网） ----------

describe("guards-client.revealPii 出站行为", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { placeholder?: string };
        if (body.placeholder === "<NO_SUCH_TYPE>") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "placeholder_unknown" }));
          return;
        }
        if (body.placeholder === "<BOOM>") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ placeholder: body.placeholder, originals: ["a@b.com"], count: 1 }));
      });
    });
    server.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  test("200 → ok + originals；404 → placeholder_unknown；500 → guards_http_500", async () => {
    const okRes = await revealPii("<EMAIL_ADDRESS>", { baseUrl });
    expect(okRes).toEqual({ ok: true, placeholder: "<EMAIL_ADDRESS>", originals: ["a@b.com"] });
    const miss = await revealPii("<NO_SUCH_TYPE>", { baseUrl });
    expect(miss).toEqual({ ok: false, reason: "placeholder_unknown" });
    const boom = await revealPii("<BOOM>", { baseUrl });
    expect(boom).toEqual({ ok: false, reason: "guards_http_500" });
  });

  test("连不上 → guards_unreachable（fail-closed 收口成 {ok:false, reason}）", async () => {
    const dead = await revealPii("<EMAIL_ADDRESS>", { baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    expect(dead).toEqual({ ok: false, reason: "guards_unreachable" });
  });
});
