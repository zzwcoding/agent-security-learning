// 票 18：m8 公开接口的 REST 壳测试——登录端点（4 预置身份）、POST /api/v1/chat 的
// 认证门与 SSE wire 契约（PRD §6-M8）、/internal/runs 的 chat_flow 白名单扩展。
// worker 图逻辑在 workers/chat/flow.test.ts（真 case-backend + 伪 LLM 布景）；
// 这里用薄径/确定性假件，只打壳的行为。
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { KEY } from "../workers/triage/testkit.js";
import { PRESET_IDENTITIES } from "../workers/chat/session.js";

function makeApp() {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const app = buildApp({ db, audit, hmacKey: KEY });
  return { db, audit, app };
}

async function loginAs(app: ReturnType<typeof buildApp>, username: string): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username } });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

// ---------- 验收①：4 预置身份登录（铸门票①，FR-M8.1 + FR-M8.2）----------

describe("POST /api/v1/auth/login（m8 卡公开接口：会话登录端点）", () => {
  test("四个预置身份都能登：会话绑定角色 claims + 按角色的可见工具清单", async () => {
    const { app, audit } = makeApp();
    for (const identity of PRESET_IDENTITIES) {
      const { status, json } = await loginAs(app, identity.username);
      expect(status).toBe(200);
      expect(json).toMatchObject({ username: identity.username, role: identity.role });
      expect(json.session_id).toMatch(/^ses_/);
      expect(String(json.token)).toMatch(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
      expect(Array.isArray(json.visible_tools)).toBe(true);
      // 会话过期时刻下发（Web 据此引导重登录）
      expect(Number(json.expires_at)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
    // redteam 可见清单是空的（A.2 全「—」）——登录就看到第一层收窄
    const red = await loginAs(app, "redteam@soc.local");
    expect(red.json.visible_tools).toEqual([]);
    // 登录有审计（INV-8）
    expect(audit.entries.filter((e) => e.objectType === "session").map((e) => e.action)).toEqual([
      "login", "login", "login", "login", "login",
    ]);
    await app.close();
  });

  test("陌生身份 401 + DENIED 审计；缺 username 400；缺 HMAC 密钥 503（fail-closed）", async () => {
    const { app, audit } = makeApp();
    const bad = await loginAs(app, "stranger@evil.example");
    expect(bad.status).toBe(401);
    expect(bad.json).toEqual({ error: "unknown_identity" });
    expect(audit.entries.some((e) => e.action === "login" && e.result === "DENIED")).toBe(true);

    const none = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {} });
    expect(none.statusCode).toBe(400);

    const keyless = buildApp({ db: openDb(":memory:"), audit: new MemoryAuditSink() });
    const res = await keyless.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "soc1@soc.local" } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "hmac_key_missing" });
    await keyless.close();
    await app.close();
  });
});

// ---------- POST /api/v1/chat：认证门 + 参数门 ----------

describe("POST /api/v1/chat 认证与参数（会话过期 → 401 引导重登录）", () => {
  test("无 token / 坏 token / 过期 token 一律 401；缺 message 400", async () => {
    const { app } = makeApp();
    const noAuth = await app.inject({ method: "POST", url: "/api/v1/chat", payload: { message: "hi" } });
    expect(noAuth.statusCode).toBe(401);
    expect(noAuth.json()).toEqual({ error: "unauthorized" });

    const badAuth = await app.inject({
      method: "POST", url: "/api/v1/chat",
      headers: { authorization: "Bearer not.a.realtoken" },
      payload: { message: "hi" },
    });
    expect(badAuth.statusCode).toBe(401);

    const expired = await app.inject({
      method: "POST", url: "/api/v1/chat",
      headers: { authorization: "Bearer ZXhwaXJlZA.0000000000000000000000000000000000000000000000000000000000000000" },
      payload: { message: "hi" },
    });
    expect(expired.statusCode).toBe(401);

    const { json } = await loginAs(app, "soc1@soc.local");
    const noMsg = await app.inject({
      method: "POST", url: "/api/v1/chat",
      headers: { authorization: `Bearer ${json.token as string}` },
      payload: { message: "   " },
    });
    expect(noMsg.statusCode).toBe(400);
    expect(noMsg.json()).toEqual({ error: "message_required" });
    await app.close();
  });
});

// ---------- 薄径 chat（未装配 worker 图时的兜底应答，壳行为可观察）----------

describe("POST /api/v1/chat 薄径（无 makeNodes）", () => {
  test("SSE 200：token + done 帧，run 落库 completed，事件流可补发", async () => {
    const { db, app } = makeApp();
    const { json } = await loginAs(app, "soc1@soc.local");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/chat",
      headers: { authorization: `Bearer ${json.token as string}` },
      payload: { message: "你好" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const frames = res.body.split("\n\n").filter((b) => b.trim());
    const data = frames.map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data:"))!.slice(6)) as { type: string; run_id: string });
    expect(data.map((d) => d.type)).toEqual(["token", "done"]);
    const runId = data[0].run_id;
    expect(db.prepare("SELECT kind, status, case_id FROM runs WHERE id = ?").get(runId))
      .toMatchObject({ kind: "chat_flow", status: "completed", case_id: null });
    await app.close();
  });
});

// ---------- /internal/runs 白名单扩展（chat_flow 走编排骨架，票 23 载体同一路）----------

describe("POST /internal/runs 接 chat_flow", () => {
  test("chat_flow {case_id, message} → 202 薄径跑完；缺 message 400；真未知 kind 仍 400", async () => {
    const { db, app } = makeApp();
    const ok = await app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "chat_flow", case_id: "case_1", message: "在吗" },
    });
    expect(ok.statusCode).toBe(202);
    expect(db.prepare("SELECT kind, status, case_id, alert_id FROM runs WHERE id = ?").get(ok.json().run_id))
      .toMatchObject({ kind: "chat_flow", status: "completed", case_id: "case_1", alert_id: "" });

    const noMsg = await app.inject({
      method: "POST", url: "/internal/runs", payload: { kind: "chat_flow", case_id: "case_1" },
    });
    expect(noMsg.statusCode).toBe(400);
    expect(noMsg.json()).toEqual({ error: "message_required" });

    const unknown = await app.inject({
      method: "POST", url: "/internal/runs", payload: { kind: "nope_flow", alert_id: "al-1" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "unknown_kind", details: ["nope_flow"] });
    await app.close();
  });
});

// ---------- SSE wire 契约（PRD §6-M8）：真端口 + EventSource 形态 ----------

describe("POST /api/v1/chat SSE wire（真端口）", () => {
  test("帧格式 id/event/data 三行；data JSON 含 type 与 run_id；token 分帧输出", async () => {
    const { app } = makeApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "soc1@soc.local" }),
    });
    const { token } = (await login.json()) as { token: string };

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "你好" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const blocks = text.split("\n\n").filter((b) => b.trim());
    const parsed = blocks.map((b) => {
      const lines = b.split("\n");
      return {
        id: Number(lines.find((l) => l.startsWith("id:"))?.slice(4)),
        event: lines.find((l) => l.startsWith("event:"))?.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data:"))?.slice(6) ?? "{}") as { type: string; run_id: string; delta?: string },
      };
    });
    // 薄径两帧：token（带 delta）→ done（带 run_id），id 自增（INV-7 同一落盘总线）
    expect(parsed.map((p) => p.event)).toEqual(["token", "done"]);
    expect(parsed[0].data.type).toBe("token");
    expect(typeof parsed[0].data.delta).toBe("string");
    expect(parsed[1].data.type).toBe("done");
    expect(parsed[1].data.run_id).toBe(parsed[0].data.run_id);
    expect(parsed[1].id).toBeGreaterThan(parsed[0].id);
    await app.close();
  });
});
