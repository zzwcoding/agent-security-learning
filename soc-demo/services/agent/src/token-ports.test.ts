import { afterEach, describe, expect, test, vi } from "vitest";
import { HttpMintClient, HttpTokenBurner, HttpUsedTokenReader } from "./token-ports.js";

// 票 33（体检 结构-13 / D3 前半）：token-ports 的出站 wire 形契约锁——此前整模块零测试。
// 这两个请求体是跨服务契约：gateway app.py 按 body["case_id"]/body["allowed_tools"] 这些
// snake_case 键取值（TS 接口是 camelCase，映射错一个键名 = 运行时 400 missing field）；
// case-backend /internal/used-tokens 要求 body.jti 必填。锁法照 llm-client.test.ts 的
// 出站捕获先例；HttpMintClient/HttpTokenBurner 直用全局 fetch（无构造注入点，本票实现
// 零改动），打桩走 web/api.test.ts 的 vi.stubGlobal 先例——测试绝不真出网。

const MINT_BASE = "http://gateway-stub:8002";
const BURN_BASE = "http://case-backend-stub:3002";

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: unknown;
}

/** 出站 seam：捕获请求（方法/URL/头/体/超时 signal），回固定 JSON 回包。 */
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

// env 保存/恢复：默认 baseUrl 读 GATEWAY_URL / CASE_BACKEND_URL，绝不漏出测试进程
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  vi.unstubAllGlobals();
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

// ---------- 铸票（gateway /internal/mint，py 侧契约在 gateway/test_mint.py） ----------

describe("HttpMintClient 出站 wire 形（对齐 gateway app.py 的 body[...] 取值键）", () => {
  test("mintTaskTicket：POST {base}/internal/mint，请求体 type + snake_case 六键逐字对齐", async () => {
    const { seen } = stubFetch(() => jsonResponse(200, { token: "h.p.s", payload: { jti: "tk_1" } }));
    const out = await new HttpMintClient(MINT_BASE).mintTaskTicket({
      jti: "tk_33TEST0001", sub: "agent:chat", caseId: "case_000012",
      runId: "run_33TEST0001", scope: ["alert:update"],
      allowedTools: ["get_alert", "siem_query"],
    });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${MINT_BASE}/internal/mint`);
    expect(req.headers["content-type"]).toBe("application/json");
    // gateway 端逐键取值：jti/sub/case_id/run_id/scope/allowed_tools——camelCase 接口字段
    // 在 adapter 完成 caseId→case_id、runId→run_id、allowedTools→allowed_tools 映射
    expect(req.body).toEqual({
      type: "task_ticket",
      jti: "tk_33TEST0001",
      sub: "agent:chat",
      case_id: "case_000012",
      run_id: "run_33TEST0001",
      scope: ["alert:update"],
      allowed_tools: ["get_alert", "siem_query"],
    });
    expect(req.signal).toBeInstanceOf(AbortSignal); // 2s 超时闸在出站请求上挂着
    expect(out).toEqual({ token: "h.p.s", payload: { jti: "tk_1" } });
  });

  test("mintApprovalToken：approval_id/approved_by 映射；caseId null → 空串占位（闸侧跳过 case 校验）", async () => {
    const { seen } = stubFetch(() => jsonResponse(200, { token: "h.p.s", payload: {} }));
    await new HttpMintClient(MINT_BASE).mintApprovalToken({
      jti: "ap_33TEST0001", approvalId: "apr_33TEST0001", approvedBy: "duty_lead",
      tool: "isolate_host", params: { host: "web-01" }, caseId: null,
    });
    expect(seen[0].url).toBe(`${MINT_BASE}/internal/mint`);
    expect(seen[0].body).toEqual({
      type: "approval_token",
      jti: "ap_33TEST0001",
      approval_id: "apr_33TEST0001",
      approved_by: "duty_lead",
      tool: "isolate_host",
      params: { host: "web-01" }, // params 原样进 wire——params_hash 规范化在 gateway 铸票侧
      case_id: "", // alert_flow 前段还没有 case：null 铸成空串，不是缺键（缺键 = gateway 400）
    });
  });

  test("gateway 非 2xx → 抛错（铸票在同步路径上：审批/worker 拉起必须立刻看见失败，非 fire-and-forget）", async () => {
    stubFetch(() => jsonResponse(500, { detail: "SOC_HMAC_KEY not set; refuse to mint (fail-closed)" }));
    const err = await new HttpMintClient(MINT_BASE)
      .mintTaskTicket({ jti: "tk_x", sub: "s", caseId: null, runId: "r", scope: [], allowedTools: [] })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("gateway mint failed: HTTP 500");
  });

  test("未传 baseUrl → env GATEWAY_URL / CASE_BACKEND_URL 决定出站目的地（compose 服务名口径）", async () => {
    setEnv("GATEWAY_URL", "http://env-gw:8002");
    const mint = stubFetch(() => jsonResponse(200, { token: "t", payload: {} }));
    await new HttpMintClient().mintTaskTicket({
      jti: "tk_e", sub: "s", caseId: null, runId: "r", scope: [], allowedTools: [],
    });
    expect(mint.seen[0].url).toBe("http://env-gw:8002/internal/mint");

    setEnv("CASE_BACKEND_URL", "http://env-cb:3002");
    const burn = stubFetch(() => jsonResponse(201, {}));
    new HttpTokenBurner().burn("tk_e");
    expect(burn.seen[0].url).toBe("http://env-cb:3002/internal/used-tokens");
  });
});

// ---------- 焚毁登记（case-backend /internal/used-tokens，INV-2 用后焚毁） ----------

describe("HttpTokenBurner 出站 wire 形（对齐 case-backend app.ts：body.jti 必填）", () => {
  test("burn：POST {base}/internal/used-tokens {jti, source}，source 缺省 approval", () => {
    const { seen } = stubFetch(() => jsonResponse(201, {}));
    new HttpTokenBurner(BURN_BASE).burn("ap_33TEST0002");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(`${BURN_BASE}/internal/used-tokens`);
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].body).toEqual({ jti: "ap_33TEST0002", source: "approval" });
  });

  test("source 显式覆盖（任务票用后焚毁记自己的来源面，jti 照传）", () => {
    const { seen } = stubFetch(() => jsonResponse(201, {}));
    new HttpTokenBurner(BURN_BASE).burn("tk_33TEST0002", "task");
    expect(seen[0].body).toEqual({ jti: "tk_33TEST0002", source: "task" });
  });

  test("fire-and-forget：出站失败不抛不阻塞执行器，只打结构化日志（登记缺口的兜底 = 300s TTL + executed_at）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(() => new HttpTokenBurner(BURN_BASE).burn("ap_33TEST0003")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // 让被吞掉的 rejection 走完 .catch 日志路径
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.warn).toBe("used_tokens_register_failed");
    expect(line.jti).toBe("ap_33TEST0003");
    errSpy.mockRestore();
  });
});

// ---------- 焚毁读口（M2 GET /internal/used-tokens/:jti，票 34 接通 INV-2 跨进程读） ----------

describe("HttpUsedTokenReader 出站 wire 形（对齐 case-backend app.ts GET /internal/used-tokens/:jti）", () => {
  test("已焚：200 {jti, burned} → true；请求 URL 带 jti 路径段（content-type 不必设）", async () => {
    const { seen } = stubFetch(() => jsonResponse(200, { jti: "ap_t34X", burned: true, burnedAt: 1 }));
    const hit = await new HttpUsedTokenReader(BURN_BASE).lookup("ap_t34X");
    expect(hit).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe(`${BURN_BASE}/internal/used-tokens/ap_t34X`);
  });

  test("未焚：404 {error} → false（查无此票是正常回答，不是病）", async () => {
    stubFetch(() => jsonResponse(404, { error: "not_found" }));
    expect(await new HttpUsedTokenReader(BURN_BASE).lookup("ap_absent")).toBe(false);
  });

  test("其他状态码 → 抛（fail-closed 语义：只有 200/404 是可信回答，裁决权在闸侧）", async () => {
    stubFetch(() => jsonResponse(502, { error: "internal_error" }));
    await expect(new HttpUsedTokenReader(BURN_BASE).lookup("ap_x")).rejects.toThrow("HTTP 502");
  });

  test("网络不可达 → 抛（INV-1：读口病了必须让闸看见，不能默默当未焚）", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(new HttpUsedTokenReader(BURN_BASE).lookup("ap_x")).rejects.toThrow("fetch failed");
  });

  test("jti 进 URL 前经 encodeURIComponent（票面 jti 是自铸 id，防线照挂）", async () => {
    const { seen } = stubFetch(() => jsonResponse(404, {}));
    await new HttpUsedTokenReader(BURN_BASE).lookup("ap/a b");
    expect(seen[0].url).toBe(`${BURN_BASE}/internal/used-tokens/ap%2Fa%20b`);
  });

  test("未传 baseUrl → env CASE_BACKEND_URL 决定目的地（compose 服务名口径）", async () => {
    setEnv("CASE_BACKEND_URL", "http://env-cb:3002");
    const { seen } = stubFetch(() => jsonResponse(200, { burned: true }));
    await new HttpUsedTokenReader().lookup("ap_env");
    expect(seen[0].url).toBe("http://env-cb:3002/internal/used-tokens/ap_env");
  });
});
