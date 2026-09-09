import { afterEach, describe, expect, test, vi } from "vitest";
import { ConsoleAuditSink, HttpAuditSink, MemoryAuditSink, type AuditEntry } from "./audit.js";
import { httpJson, startCaseBackend } from "../workers/triage/testkit.js";

// 票 35（FR-S5「两路汇入同一 audit_entries 表」）：HttpAuditSink 出站 wire 形契约锁。
// 请求体是跨服务契约：case-backend /internal/audit 按 body["object_id"]/body["request_id"]
// 这些 snake_case 键取值（AuditEntry 是 camelCase，映射错一个键名 = 运行时 400
// invalid_audit）。锁法照 token-ports.test.ts 的 vi.stubGlobal 出站捕获先例——
// 测试绝不真出网。审计失败口径：业务成功优先，出站失败不抛不阻塞，只打结构化日志
// （ConsoleAuditSink 降级路径保留，见 audit.ts 文件头）。

const BASE = "http://case-backend-stub:3002";

const ENTRY: AuditEntry = {
  action: "guards_block",
  actor: { type: "agent", id: "agent:triage" },
  objectId: "run-35X",
  objectType: "run",
  details: { reason: "injection_blocked", channel: "alert_field" },
  requestId: "req-35-audit-1",
  result: "DENIED",
  createdAt: 1757300000000,
};

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: unknown;
}

function stubFetch(reply: () => Response | Promise<Response>): { seen: SeenReq[] } {
  const seen: SeenReq[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal,
    });
    return reply();
  }) as typeof fetch;
  vi.stubGlobal("fetch", impl);
  return { seen };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

const setEnv = (k: string, v: string | undefined): void => {
  savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

describe("HttpAuditSink 出站 wire 形（对齐 case-backend app.ts /internal/audit 的 body[...] 取值键）", () => {
  test("record：POST {base}/internal/audit，五要素 snake_case 键逐字对齐（含 created_at 透传）", async () => {
    const { seen } = stubFetch(() => jsonResponse(201, { id: "row-1" }));
    const sink = new HttpAuditSink(BASE);
    sink.record(ENTRY);
    await sink.flush();
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/internal/audit`);
    expect(req.headers["content-type"]).toBe("application/json");
    // camelCase 接口字段在 adapter 完成映射：objectId→object_id / objectType→object_type /
    // requestId→request_id / createdAt→created_at——错一个键 = M2 400 invalid_audit
    expect(req.body).toEqual({
      action: "guards_block",
      actor: { type: "agent", id: "agent:triage" },
      object_id: "run-35X",
      object_type: "run",
      details: { reason: "injection_blocked", channel: "alert_field" },
      request_id: "req-35-audit-1",
      result: "DENIED",
      created_at: 1757300000000,
    });
    expect(req.signal).toBeInstanceOf(AbortSignal); // 2s 超时闸在出站请求上挂着
  });

  test("未传 baseUrl → env CASE_BACKEND_URL 决定出站目的地（compose 服务名口径）", async () => {
    setEnv("CASE_BACKEND_URL", "http://env-cb:3002");
    const { seen } = stubFetch(() => jsonResponse(201, {}));
    const sink = new HttpAuditSink();
    sink.record(ENTRY);
    await sink.flush();
    expect(seen[0].url).toBe("http://env-cb:3002/internal/audit");
  });

  test("fire-and-forget：record 同步返回不抛；出站失败不阻塞业务，flush 后见结构化日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const sink = new HttpAuditSink(BASE);
    expect(() => sink.record(ENTRY)).not.toThrow(); // 审计挂了不能把业务也打死
    await sink.flush();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.warn).toBe("audit_ingest_failed"); // 结构化：可 grep、可接告警
    expect(line.requestId).toBe(ENTRY.requestId);
    errSpy.mockRestore();
  });

  test("M2 非 2xx 同样降级：记日志不抛（审计通道病了 ≠ 业务失败，INV-8 缺口靠日志可见）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => jsonResponse(500, { error: "internal_error" }));
    const sink = new HttpAuditSink(BASE);
    sink.record(ENTRY);
    await sink.flush();
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.warn).toBe("audit_ingest_failed");
    expect(String(line.error)).toContain("500");
    errSpy.mockRestore();
  });
});

// ---------- 验收①真汇入：真 case-backend 上落 audit_entries，查询面查得回 ----------

describe("HttpAuditSink × 真 case-backend：worker 审计五要素落 M2 audit_entries（FR-S5）", () => {
  test("record → flush → GET /api/v1/audit 按 requestId 查回同一五要素条目", async () => {
    const backend = await startCaseBackend();
    try {
      const sink = new HttpAuditSink(backend.url);
      sink.record(ENTRY);
      await sink.flush();
      const res = await httpJson(backend.url, "GET", "/api/v1/audit?requestId=req-35-audit-1");
      expect(res.status).toBe(200);
      const rows = res.json as unknown as {
        action: string;
        actor: { type: string; id: string };
        objectId: string;
        objectType: string;
        details: Record<string, unknown>;
        requestId: string;
        result: string;
        createdAt: number;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "guards_block",
        actor: { type: "agent", id: "agent:triage" },
        objectId: "run-35X",
        objectType: "run",
        details: { reason: "injection_blocked", channel: "alert_field" },
        requestId: "req-35-audit-1",
        result: "DENIED",
      });
      expect(rows[0].createdAt).toBe(1757300000000); // 调用方观测时刻优先，不被落库时刻覆盖
    } finally {
      await backend.close();
    }
  });
});

// ---------- 既有两实现不回退（票 10 seam 契约原样） ----------

describe("Memory/Console sink 不回退（票 10 的 seam 契约）", () => {
  test("MemoryAuditSink：entries 可读，测试断言面不变", () => {
    const mem = new MemoryAuditSink();
    mem.record(ENTRY);
    expect(mem.entries).toEqual([ENTRY]);
  });

  test("ConsoleAuditSink：结构化一行进日志（compose logs 可观察的降级路径保留）", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    new ConsoleAuditSink().record(ENTRY);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ audit: ENTRY });
    logSpy.mockRestore();
  });
});
