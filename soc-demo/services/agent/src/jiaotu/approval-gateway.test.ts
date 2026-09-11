import { afterEach, describe, expect, test } from "vitest";
import { JiaoTuApprovalGateway } from "./approval-gateway.js";
import { ApprovalGatewayError } from "../approvals.js";
import type { JiaoTuClientOpts } from "./token-ports-jiaotu.js";

// 狗粮票 58：JiaoTuApprovalGateway 的出站 wire 形契约锁（对齐椒图 g4 approval/index.ts）。
// 这四个请求是跨系统契约：申报按 body["tool"]/["params_hash"]/["risk"]/["case_id"] 取值
// （reason→risk、caseId→case_id 是仅有的两处领域→wire 映射）；批准/驳回口令只走
// x-approver-token 头（g4 只认头）；对账走公开面 GET /api/v1/approvals/:id。
// 锁法照 token-ports-jiaotu.test.ts（57）的出站捕获先例：fetchImpl 构造注入，绝不真出网。
// 错误映射：非 2xx 一律 ApprovalGatewayError(原 status)——401/404/409 原码透传，
// 不自吞不自造；正文不进 message（上游错误文本不流入审计/事件面）。

const JT_BASE = "http://jiaotu-stub:8080";

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  hasBody: boolean;
  signal: unknown;
}

function mockFetch(reply: () => Response | Promise<Response>): { impl: typeof fetch; seen: SeenReq[] } {
  const seen: SeenReq[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      hasBody: init?.body !== undefined,
      signal: init?.signal,
    });
    return reply();
  }) as typeof fetch;
  return { impl, seen };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const makeGateway = (impl: typeof fetch, over: Partial<JiaoTuClientOpts> = {}): JiaoTuApprovalGateway =>
  new JiaoTuApprovalGateway({ baseUrl: JT_BASE, apiKey: "jt-key-58", fetchImpl: impl, ...over });

const CARD = {
  tool: "isolate_host",
  params: { host: "centos7" },
  paramsHash: "sha256:" + "a".repeat(64),
  reason: "调查报告建议遏制",
  caseId: "case_000012",
};

// env 保存/恢复：缺省 baseUrl/apiKey 读 JIAOTU_GATEWAY_URL / JIAOTU_API_KEY，绝不漏出测试进程
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
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

// ---------- 申报（POST /internal/approvals，g4 SubmitApprovalInput） ----------

describe("JiaoTuApprovalGateway.declare 出站 wire 形", () => {
  test("POST {base}/internal/approvals：Bearer api_key + tool/params/params_hash/risk/case_id 五键逐字对齐", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(201, { approval_id: "apr_jt58A" }));
    const out = await makeGateway(impl).declare(CARD);
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${JT_BASE}/internal/approvals`);
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["authorization"]).toBe("Bearer jt-key-58");
    // 领域→wire 的全部映射：reason→risk、caseId→case_id；agent_identity 不自带
    // （g4 只认 api_key 解析身份）、kind 缺省 tool_execution 不发
    expect(req.body).toEqual({
      tool: "isolate_host",
      params: { host: "centos7" },
      params_hash: CARD.paramsHash,
      risk: "调查报告建议遏制",
      case_id: "case_000012",
    });
    expect(req.signal).toBeInstanceOf(AbortSignal); // 2s 超时闸在出站请求上挂着
    expect(out).toEqual({ externalId: "apr_jt58A" });
  });

  test("reason/caseId 为 null → risk/case_id 空串占位（g4 两字段缺省口径一致）", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(201, { approval_id: "apr_jt58B" }));
    await makeGateway(impl).declare({ ...CARD, reason: null, caseId: null });
    expect(seen[0].body).toMatchObject({ risk: "", case_id: "" });
  });

  test("非 2xx → ApprovalGatewayError 原码透传；正文一个字节不进 message", async () => {
    for (const status of [400, 401, 403, 500]) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: "上游错误控文本不得外流" }));
      const err = await makeGateway(impl)
        .declare(CARD)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGatewayError);
      expect((err as ApprovalGatewayError).status).toBe(status);
      expect((err as Error).message).not.toContain("上游错误控文本");
    }
  });

  test("网络不可达 → 出站异常原样上抛（graph 申报失败路径据此落审计 FAILURE + error 事件）", async () => {
    const { impl } = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    const err = await makeGateway(impl)
      .declare(CARD)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
  });

  test("未传 baseUrl/apiKey → env JIAOTU_GATEWAY_URL / JIAOTU_API_KEY 决定出站", async () => {
    setEnv("JIAOTU_GATEWAY_URL", "http://env-jt:8080");
    setEnv("JIAOTU_API_KEY", "env-key-58");
    const { impl, seen } = mockFetch(() => jsonResponse(201, { approval_id: "apr_env" }));
    await makeGateway(impl, { baseUrl: undefined, apiKey: undefined }).declare(CARD);
    expect(seen[0].url).toBe("http://env-jt:8080/internal/approvals");
    expect(seen[0].headers["authorization"]).toBe("Bearer env-key-58");
  });
});

// ---------- G9 对账（GET /api/v1/approvals/:id，公开面） ----------

describe("JiaoTuApprovalGateway.fetchStatus 出站 wire 形", () => {
  test("GET {base}/api/v1/approvals/:id（公开面无认证头）→ 详情里的 approval.status", async () => {
    const { impl, seen } = mockFetch(() =>
      jsonResponse(200, { approval: { approval_id: "apr_jt58C", status: "expired" }, audit: [] }),
    );
    const out = await makeGateway(impl).fetchStatus("apr_jt58C");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`${JT_BASE}/api/v1/approvals/apr_jt58C`);
    expect(seen[0].headers["authorization"]).toBeUndefined(); // 公开面，椒图不收 api_key
    expect(out).toEqual({ status: "expired" });
  });

  test("externalId 进 URL 前经 encodeURIComponent", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(200, { approval: { status: "pending" } }));
    await makeGateway(impl).fetchStatus("apr/a b");
    expect(seen[0].url).toBe(`${JT_BASE}/api/v1/approvals/apr%2Fa%20b`);
  });

  test("非 200 → ApprovalGatewayError 原码透传（404=椒图没这张卡，dispatcher 只记日志不动卡）", async () => {
    for (const status of [401, 404, 500]) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: "x" }));
      const err = await makeGateway(impl)
        .fetchStatus("apr_x")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGatewayError);
      expect((err as ApprovalGatewayError).status).toBe(status);
    }
  });

  test("网络不可达 → 抛（对账口病了绝不能冒充「未过期」）", async () => {
    const { impl } = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(makeGateway(impl).fetchStatus("apr_x")).rejects.toThrow("fetch failed");
  });
});

// ---------- 批准中继（POST /api/v1/approvals/:id/approve，口令走头，票在响应） ----------

describe("JiaoTuApprovalGateway.approve 出站 wire 形", () => {
  test("POST {base}/api/v1/approvals/:id/approve：x-approver-token 头、无请求体；200 票随响应中继", async () => {
    const { impl, seen } = mockFetch(() =>
      jsonResponse(200, { approval_token: { token: "h.p.s", jti: "ap_58A", exp: 1726000000 } }),
    );
    const out = await makeGateway(impl).approve("apr_jt58D", "demo-approver-token");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(`${JT_BASE}/api/v1/approvals/apr_jt58D/approve`);
    expect(seen[0].headers["x-approver-token"]).toBe("demo-approver-token");
    expect(seen[0].hasBody).toBe(false); // 口令在头不在体（g4 只认 X-Approver-Token 头）
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual({ token: "h.p.s", jti: "ap_58A", exp: 1726000000 });
  });

  test("409/401/404 → ApprovalGatewayError 原码透传（app 层据此映射 409 InvalidTransition/401）", async () => {
    for (const status of [409, 401, 404]) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: "x" }));
      const err = await makeGateway(impl)
        .approve("apr_x", "tok")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGatewayError);
      expect((err as ApprovalGatewayError).status).toBe(status);
    }
  });

  test("200 但响应缺 approval_token → 结构错炸响（不静默造票，INV-2 票只来自椒图）", async () => {
    const { impl } = mockFetch(() => jsonResponse(200, { approval_token: null }));
    await expect(makeGateway(impl).approve("apr_x", "tok")).rejects.toThrow("approval_token");
  });
});

// ---------- 驳回中继（POST /api/v1/approvals/:id/reject，reason 必填进体） ----------

describe("JiaoTuApprovalGateway.reject 出站 wire 形", () => {
  test("POST {base}/api/v1/approvals/:id/reject：x-approver-token 头 + body {reason}；200 即中继成功", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(200, { ok: true }));
    await makeGateway(impl).reject("apr_jt58E", "demo-approver-token", "证据不足，先补调查");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(`${JT_BASE}/api/v1/approvals/apr_jt58E/reject`);
    expect(seen[0].headers["x-approver-token"]).toBe("demo-approver-token");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].body).toEqual({ reason: "证据不足，先补调查" });
  });

  test("400（缺原因）/409（非 pending）/401 → ApprovalGatewayError 原码透传", async () => {
    for (const status of [400, 409, 401]) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: "x" }));
      const err = await makeGateway(impl)
        .reject("apr_x", "tok", "")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApprovalGatewayError);
      expect((err as ApprovalGatewayError).status).toBe(status);
    }
  });

  test("网络不可达 → 抛（app 层归 502 gateway_failed，卡留 pending 可重试）", async () => {
    const { impl } = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(makeGateway(impl).reject("apr_x", "tok", "r")).rejects.toThrow("fetch failed");
  });
});
