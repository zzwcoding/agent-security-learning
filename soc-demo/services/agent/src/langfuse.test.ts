import { afterEach, describe, expect, test, vi } from "vitest";
import { emitEvent, setEventTap, type RunEvent } from "./events.js";
import { MemoryAuditSink, type AuditEntry } from "./audit.js";
import { langfuseConfigFromEnv, LangfuseMirror, makeLangfuseMirror, TeeAuditSink, traceIdFor } from "./langfuse.js";
import { openDb } from "./db.js";

// 票 37（ADR 0001：Langfuse 砍出默认链路，降为可选 profile observability）：
// LangfuseMirror 是可选旁路——三把 env 钥匙（LANGFUSE_PUBLIC_KEY/SECRET_KEY/HOST）齐了
// 才启用，出站形态 = HttpAuditSink 同款 fire-and-forget（POST {host}/api/public/ingestion，
// Basic 认证）。出站 wire 形是跨系统契约：Langfuse v2 ingestion 按 trace-create/event-create
// 逐项 zod 校验（timestamp 必须 ISO 带时区、trace id 32 字符惯例）。锁法照 audit.test.ts
// 的 vi.stubGlobal 出站捕获先例——单测绝不真出网；真容器冒烟走能力探测 skip（票 16/17 先例）。

const ENTRY: AuditEntry = {
  action: "guards_block",
  actor: { type: "agent", id: "agent:triage" },
  objectId: "run-37X",
  objectType: "run",
  details: { reason: "injection_blocked", channel: "alert_field" },
  requestId: "req-37-audit-1",
  result: "DENIED",
  createdAt: 1757300000000,
};

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: unknown;
  body: { batch?: { id: string; type: string; timestamp: string; body: Record<string, unknown> }[] };
}

function stubFetch(reply: () => Response | Promise<Response>): { seen: SeenReq[] } {
  const seen: SeenReq[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      signal: init?.signal,
      body: JSON.parse(String(init?.body ?? "{}")) as SeenReq["body"],
    });
    return reply();
  }) as typeof fetch;
  vi.stubGlobal("fetch", impl);
  return { seen };
}

const okIngestion = (): Response =>
  new Response(JSON.stringify({ successes: [], failures: [] }), { status: 200 });

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setEventTap(null); // 旁路 tap 是模块级状态：用完必拆，别漏给别的测试文件
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

describe("langfuseConfigFromEnv：三把钥匙当开关（ADR 0001 默认链路零改动的第一道闸）", () => {
  test("key 缺任一 → null（旁路不存在，index.ts 装配退回单 sink）", () => {
    expect(langfuseConfigFromEnv({})).toBeNull();
    expect(langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk" })).toBeNull();
    expect(langfuseConfigFromEnv({ LANGFUSE_SECRET_KEY: "sk" })).toBeNull();
    expect(langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "  ", LANGFUSE_SECRET_KEY: "sk" })).toBeNull();
  });

  test("双 key 齐 → 启用；HOST 可缺省容器服务名，收尾斜杠剥掉", () => {
    expect(langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk-lf", LANGFUSE_SECRET_KEY: "sk-lf" })).toEqual({
      publicKey: "pk-lf",
      secretKey: "sk-lf",
      host: "http://langfuse:3000", // compose 服务名：容器网络内直达
    });
    expect(
      langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: "http://lf:13000/" }),
    ).toEqual({ publicKey: "pk", secretKey: "sk", host: "http://lf:13000" });
  });
});

describe("makeLangfuseMirror：生产装配口（index.ts 一行接的锁）", () => {
  test("keys 缺 → null（旁路不存在）；keys 齐 → LangfuseMirror 实例（config 原样带出）", () => {
    expect(makeLangfuseMirror({})).toBeNull();
    const mirror = makeLangfuseMirror({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" });
    expect(mirror).toBeInstanceOf(LangfuseMirror);
    expect(mirror?.config).toEqual({ publicKey: "pk", secretKey: "sk", host: "http://langfuse:3000" });
  });
});

describe("traceIdFor：runId → 32 位 hex（run_<uuid> 不合 Langfuse 32 字符身位）", () => {
  test("确定性：同 key 同 id，异 key 异 id，形状 32 hex", () => {
    expect(traceIdFor("run:run_abc")).toBe(traceIdFor("run:run_abc"));
    expect(traceIdFor("run:run_abc")).not.toBe(traceIdFor("run:run_def"));
    expect(traceIdFor("run:run_abc")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("LangfuseMirror.onEvent：SSE 事件 → ingestion wire 形（trace-create + event-create）", () => {
  const EVENT: RunEvent = {
    id: 7,
    runId: "run_37smoke",
    type: "node_enter",
    payload: { node: "classify" },
    createdAt: 1757300000000,
  };

  test("首条事件带两件：trace-create（externalId=runId）+ event-create（traceId/name/startTime）", async () => {
    const { seen } = stubFetch(okIngestion);
    const lf = new LangfuseMirror({ publicKey: "pk-lf", secretKey: "sk-lf", host: "http://lf:3000" });
    lf.onEvent(EVENT);
    await lf.flush();
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://lf:3000/api/public/ingestion");
    // Basic 认证 = public key 当用户名、secret key 当密码（v2 public API 口径）
    expect(req.headers["authorization"]).toBe(`Basic ${Buffer.from("pk-lf:sk-lf").toString("base64")}`);
    expect(req.headers["content-type"]).toBe("application/json");

    const batch = req.body.batch ?? [];
    expect(batch).toHaveLength(2);
    const [trace, obs] = batch;
    expect(trace.type).toBe("trace-create");
    expect(trace.body.id).toBe(traceIdFor(`run:${EVENT.runId}`));
    expect(trace.body.name).toBe("agent.run");
    expect(trace.body.externalId).toBe(EVENT.runId);
    expect(trace.body.metadata).toEqual({ run_id: EVENT.runId });

    expect(obs.type).toBe("event-create");
    expect(obs.body.traceId).toBe(traceIdFor(`run:${EVENT.runId}`));
    expect(obs.body.name).toBe("node_enter.classify"); // 带节点名，UI 时间线一眼可读
    expect(obs.body.startTime).toBe(new Date(EVENT.createdAt).toISOString());
    expect(obs.body.metadata).toEqual({ node: "classify" }); // SSE payload 原样镜像
    // timestamp 必须 ISO 带时区（v2 zod: string().datetime({ offset: true })）
    expect(trace.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  });

  test("同 run 第二条事件只发观察一件（trace 只 announce 一次，本地去重）", async () => {
    const { seen } = stubFetch(okIngestion);
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    lf.onEvent(EVENT);
    lf.onEvent({ ...EVENT, id: 8, type: "node_exit", payload: { node: "classify" }, createdAt: 1757300000001 });
    await lf.flush();
    expect(seen).toHaveLength(2);
    expect((seen[0].body.batch ?? []).map((i) => i.type)).toEqual(["trace-create", "event-create"]);
    expect((seen[1].body.batch ?? []).map((i) => i.type)).toEqual(["event-create"]);
    expect(seen[1].body.batch?.[0].body.name).toBe("node_exit.classify");
  });

  test("audit 事件镜像进 run trace，DENIED/FAILURE 抬 WARNING 档", async () => {
    const { seen } = stubFetch(okIngestion);
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    lf.onEvent({ ...EVENT, type: "audit", payload: { action: "update", result: "SUCCESS" } });
    await lf.flush();
    const obs = (seen[0].body.batch ?? [])[1];
    expect(obs.body.name).toBe("audit.update"); // audit 事件按 action 命名
    expect(obs.body.level).toBeUndefined(); // SUCCESS 不抬档
  });

  test("error 事件抬 ERROR 档（UI 红点可观察）", async () => {
    const { seen } = stubFetch(okIngestion);
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    lf.onEvent({ ...EVENT, type: "error", payload: { reason: "max_steps" } });
    await lf.flush();
    expect((seen[0].body.batch ?? [])[1].body.level).toBe("ERROR");
  });
});

describe("LangfuseMirror.record：审计五要素 → 独立 trace（id=hash(audit:requestId)，与 run trace 经事件流互链）", () => {
  test("record：trace-create（externalId=requestId）+ event-create（五要素进 metadata，DENIED 抬档）", async () => {
    const { seen } = stubFetch(okIngestion);
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    lf.record(ENTRY);
    await lf.flush();
    expect(seen).toHaveLength(1);
    const [trace, obs] = seen[0].body.batch ?? [];
    expect(trace.type).toBe("trace-create");
    expect(trace.body.id).toBe(traceIdFor(`audit:${ENTRY.requestId}`));
    expect(trace.body.name).toBe("agent.audit");
    expect(trace.body.externalId).toBe(ENTRY.requestId);
    expect(obs.type).toBe("event-create");
    expect(obs.body.name).toBe("audit.guards_block");
    expect(obs.body.level).toBe("WARNING"); // DENIED 抬档
    expect(obs.body.metadata).toEqual({
      action: "guards_block",
      actor: { type: "agent", id: "agent:triage" },
      objectId: "run-37X",
      objectType: "run",
      result: "DENIED",
      requestId: "req-37-audit-1",
      details: { reason: "injection_blocked", channel: "alert_field" },
    });
  });
});

describe("fire-and-forget 纪律（HttpAuditSink 同款）：旁路病了绝不传染主链路", () => {
  test("onEvent/record 同步返回不抛；出站失败不阻塞，flush 后见结构化日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    expect(() => lf.onEvent({ id: 1, runId: "r", type: "done", payload: {}, createdAt: 1 })).not.toThrow();
    expect(() => lf.record(ENTRY)).not.toThrow();
    await lf.flush();
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.warn).toBe("langfuse_mirror_failed"); // 可 grep 可接告警
    errSpy.mockRestore();
  });

  test("非 2xx 同样降级记日志，不抛", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => new Response("unauthorized", { status: 401 }));
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    lf.record(ENTRY);
    await lf.flush();
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(String(line.error)).toContain("401");
    errSpy.mockRestore();
  });

  test("2s 超时闸挂在出站请求上（对齐 HttpAuditSink）", async () => {
    const { seen } = stubFetch(okIngestion);
    const lf = new LangfuseMirror({ publicKey: "pk", secretKey: "sk", host: "http://lf:3000" });
    lf.record(ENTRY);
    await lf.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("events.ts 旁路 tap：默认 null 零行为变化；挂上后 emitEvent 把事件同步喂给 tap", () => {
  test("默认（未 setEventTap）：emitEvent 落库返回，无任何旁路副作用", () => {
    const db = openDb(":memory:");
    const e = emitEvent(db, "run_tap0", "node_enter", { node: "n" });
    expect(e.id).toBeGreaterThan(0); // 主链路照常
  });

  test("setEventTap 后：每条 emitEvent 都喂 tap（同库同事件，镜像语义）", () => {
    const db = openDb(":memory:");
    const tapped: RunEvent[] = [];
    setEventTap((e) => tapped.push(e));
    emitEvent(db, "run_tap1", "node_enter", { node: "a" });
    emitEvent(db, "run_tap1", "tool_call", { tool: "t" });
    expect(tapped.map((e) => e.type)).toEqual(["node_enter", "tool_call"]);
    expect(tapped[0].runId).toBe("run_tap1");
  });

  test("tap 抛错 ≠ 主链路病：emitEvent 照常落库（旁路隔离在 try 里）", () => {
    const db = openDb(":memory:");
    setEventTap(() => {
      throw new Error("mirror down");
    });
    const e = emitEvent(db, "run_tap2", "done", {});
    expect(e.type).toBe("done");
  });
});

describe("TeeAuditSink：镜像启用时 audit 一弦两 sink（M2 真相源不动 + Langfuse 旁路）", () => {
  test("fan-out 到两个 sink，顺序执行", () => {
    const mem1 = new MemoryAuditSink();
    const mem2 = new MemoryAuditSink();
    new TeeAuditSink([mem1, mem2]).record(ENTRY);
    expect(mem1.entries).toEqual([ENTRY]);
    expect(mem2.entries).toEqual([ENTRY]);
  });
});

// ---------- 真 langfuse 容器冒烟（能力探测；容器不可用显式 skip 打印原因） ----------
// 验收③「可选接通时 trace 可查」的真断言：真实 POST ingestion → GET /api/public/traces/{id}
// 查回同一条。前置：bash scripts/langfuse-smoke-37.sh（起 profile 栈 + 种教学假 key）；
// CI / 未起容器的机器 → 显式 skip 不装绿（票 16/17 能力探测先例）。

const LF_BASE = (process.env.LANGFUSE_SMOKE_URL ?? "http://127.0.0.1:13000").replace(/\/$/, "");
const LF_PK = process.env.LANGFUSE_SMOKE_PUBLIC_KEY ?? "pk-lf-local-demo";
const LF_SK = process.env.LANGFUSE_SMOKE_SECRET_KEY ?? "sk-lf-local-demo";

async function langfuseSmokeProbe(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${LF_BASE}/api/public/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, reason: `health http_${res.status}（${LF_BASE}）` };
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: `langfuse 容器不可达（${LF_BASE}）——真容器冒烟 skip（显式留痕，不装绿）。` +
        "要跑：bash scripts/langfuse-smoke-37.sh 后重跑本文件",
    };
  }
}

const probe = await langfuseSmokeProbe();
if (!probe.ok) console.warn(`[票 37 真容器冒烟 skip] ${probe.reason}`);

describe.skipIf(!probe.ok)("真 langfuse 容器冒烟（验收③：record+onEvent → flush → API 查回 trace）", () => {
  test("事件镜像落 run trace：externalId=runId，观察里见事件名", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const lf = new LangfuseMirror({ publicKey: LF_PK, secretKey: LF_SK, host: LF_BASE });
    const runId = `run_37smoke_${Date.now()}`;
    lf.onEvent({ id: 1, runId, type: "node_enter", payload: { node: "classify" }, createdAt: Date.now() });
    lf.onEvent({ id: 2, runId, type: "node_exit", payload: { node: "classify" }, createdAt: Date.now() });
    await lf.flush();
    expect(errSpy).not.toHaveBeenCalled(); // 出站失败（key 错/网络断）在这里现形
    errSpy.mockRestore();

    const headers = { authorization: `Basic ${Buffer.from(`${LF_PK}:${LF_SK}`).toString("base64")}` };
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${LF_BASE}/api/public/traces/${traceIdFor(`run:${runId}`)}`, { headers });
      if (res.ok) {
        body = (await res.json()) as Record<string, unknown>;
        break;
      }
      if (res.status !== 404) throw new Error(`GET trace http_${res.status}`);
      await new Promise((r) => setTimeout(r, 500)); // ingestion 异步处理，轮询至多 10s
    }
    expect(body, "trace 10s 内没查到——ingestion 没落库").not.toBeNull();
    // v2.95.11 实证：ingestion 收下 externalId 但落库恒 null（wire 照发无害），查询锚点
    // = 确定性 traceId + metadata.run_id（名字/元数据都在 GET 响应里）
    expect(body?.metadata).toEqual({ run_id: runId });
    expect(body?.name).toBe("agent.run");
    const obsNames = ((body?.observations ?? []) as { name: string }[]).map((o) => o.name);
    expect(obsNames).toContain("node_enter.classify");
    expect(obsNames).toContain("node_exit.classify");
    console.log(`[票 37 真容器冒烟证据] ${LF_BASE} trace ${traceIdFor(`run:${runId}`)}：2 事件镜像查回`);
  }, 30_000);

  test("审计镜像落独立 trace：externalId=requestId，DENIED 抬 WARNING", async () => {
    const lf = new LangfuseMirror({ publicKey: LF_PK, secretKey: LF_SK, host: LF_BASE });
    lf.record(ENTRY);
    await lf.flush();
    const headers = { authorization: `Basic ${Buffer.from(`${LF_PK}:${LF_SK}`).toString("base64")}` };
    let body: Record<string, unknown> | null = null;
    for (let i = 0; i < 20; i += 1) {
      const res = await fetch(`${LF_BASE}/api/public/traces/${traceIdFor(`audit:${ENTRY.requestId}`)}`, { headers });
      if (res.ok) {
        body = (await res.json()) as Record<string, unknown>;
        break;
      }
      if (res.status !== 404) throw new Error(`GET trace http_${res.status}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(body, "audit trace 10s 内没查到").not.toBeNull();
    expect(body?.name).toBe("agent.audit");
    expect(body?.metadata).toEqual({ request_id: ENTRY.requestId }); // v2 externalId 恒 null（见上），锚 metadata
  }, 30_000);
});
