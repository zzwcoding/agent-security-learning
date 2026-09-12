import { afterEach, describe, expect, test, vi } from "vitest";
import {
  JiaoTuMintClient,
  JiaoTuTokenBurner,
  JiaoTuUsedTokenReader,
  type JiaoTuClientOpts,
} from "./token-ports-jiaotu.js";

// 狗粮票 57/17：椒图三 adapter 的出站 wire 形契约锁。这两个请求是跨系统契约：椒图
// identity/index.ts 按 body["agent_identity"] / params["jti"] 这些键取值（TS 接口是
// camelCase，映射错一个键名 = 运行时 400/404）；票 17 起椒图 internal 口统一认证，
// mint/lookup/burn 三口出站全带 authorization: Bearer <agent api_key>（逐字段断言）。
// 锁法照 token-ports.test.ts 的出站捕获先例；三 adapter 的 fetchImpl 构造注入
// （GatewayLlmClient idiom），测试绝不真出网。fail-closed 分支：usedReader 非 200
// 一律抛（椒图未登记 jti 也回 200 false，非 200 = 病）；burner 失败不抛、落结构化日志。

const JT_BASE = "http://jiaotu-stub:8080";

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  hasBody: boolean;
  signal: unknown;
}

/** 出站 seam：捕获请求（方法/URL/头/体/有无体/超时 signal），回固定 JSON 回包。 */
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

const makeMint = (impl: typeof fetch, over: Partial<JiaoTuClientOpts> = {}): JiaoTuMintClient =>
  new JiaoTuMintClient({ baseUrl: JT_BASE, apiKey: "jt-key-57", fetchImpl: impl, ...over });
const makeReader = (impl: typeof fetch, over: Partial<JiaoTuClientOpts> = {}): JiaoTuUsedTokenReader =>
  new JiaoTuUsedTokenReader({ baseUrl: JT_BASE, apiKey: "jt-key-57", fetchImpl: impl, ...over });
const makeBurner = (impl: typeof fetch, over: Partial<JiaoTuClientOpts> = {}): JiaoTuTokenBurner =>
  new JiaoTuTokenBurner({ baseUrl: JT_BASE, apiKey: "jt-key-57", fetchImpl: impl, ...over });

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

// ---------- 铸任务票（POST /internal/tickets/mint，椒图 identity/index.ts:751-768） ----------

describe("JiaoTuMintClient 出站 wire 形（对齐椒图 MintTicketInput 的 body[...] 取值键）", () => {
  test("mintTaskTicket：POST {base}/internal/tickets/mint，sub→agent_identity 等 snake_case 六键逐字对齐", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(201, { token: "h.p.s", jti: "tk_57A", exp: 1726000000 }));
    const out = await makeMint(impl).mintTaskTicket({
      jti: "tk_57TEST0001", sub: "agent:chat", caseId: "case_000012",
      runId: "run_57TEST0001", scope: ["alert:update"],
      allowedTools: ["get_alert", "siem_query"],
    });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${JT_BASE}/internal/tickets/mint`);
    expect(req.headers["content-type"]).toBe("application/json");
    // 票 17：椒图 internal 口统一认证，出站头逐字段断言
    expect(req.headers["authorization"]).toBe("Bearer jt-key-57");
    // 椒图端点即票型：无 type 判别字段；sub→agent_identity 是唯一非平凡映射（§4.1）；
    // jti 由 soc-demo 侧生成（同 HttpMintClient 现口径）
    expect(req.body).toEqual({
      agent_identity: "agent:chat",
      scope: ["alert:update"],
      case_id: "case_000012",
      run_id: "run_57TEST0001",
      allowed_tools: ["get_alert", "siem_query"],
      jti: "tk_57TEST0001",
    });
    expect(req.signal).toBeInstanceOf(AbortSignal); // 2s 超时闸在出站请求上挂着
    // 响应合成（差距 G4）：{token,jti,exp} → {token, payload:{jti,exp}}，消费方只用
    // .token 与 .payload.jti
    expect(out.token).toBe("h.p.s");
    expect(out.payload).toEqual({ jti: "tk_57A", exp: 1726000000 });
  });

  test("caseId null → case_id 空串占位（字段在，不是缺键——票面契约一字不增不减）", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(201, { token: "t", jti: "j", exp: 1 }));
    await makeMint(impl).mintTaskTicket({
      jti: "tk_57TEST0002", sub: "agent:triage", caseId: null,
      runId: "run_57TEST0002", scope: [], allowedTools: [],
    });
    expect(seen[0].body).toMatchObject({ case_id: "", agent_identity: "agent:triage" });
  });

  test("非 2xx → 抛（401/409/500 都算：铸票在同步路径上，worker 拉起必须立刻看见失败）", async () => {
    for (const status of [401, 409, 500]) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: "upstream 控文本不进 error" }));
      const err = await makeMint(impl)
        .mintTaskTicket({ jti: "tk_x", sub: "s", caseId: null, runId: "r", scope: [], allowedTools: [] })
        .catch((e: unknown) => e);
      expect((err as Error).message).toBe(`jiaotu mint failed: HTTP ${status}`);
      expect((err as Error).message).not.toContain("upstream 控文本");
    }
  });

  test("网络不可达 → 出站异常原样上抛（铸票失败立即可见，与内部 HttpMintClient 同口径）", async () => {
    const { impl } = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    const err = await makeMint(impl)
      .mintTaskTicket({ jti: "tk_x", sub: "s", caseId: null, runId: "r", scope: [], allowedTools: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError); // 出站异常原样上抛，与内部 HttpMintClient 同口径
  });

  test("未传 baseUrl → env JIAOTU_GATEWAY_URL 决定出站目的地", async () => {
    setEnv("JIAOTU_GATEWAY_URL", "http://env-jt:8080");
    const { impl, seen } = mockFetch(() => jsonResponse(201, { token: "t", jti: "j", exp: 1 }));
    await makeMint(impl, { baseUrl: undefined }).mintTaskTicket({
      jti: "tk_e", sub: "s", caseId: null, runId: "r", scope: [], allowedTools: [],
    });
    expect(seen[0].url).toBe("http://env-jt:8080/internal/tickets/mint");
  });

  test("未传 apiKey → env JIAOTU_API_KEY 决定 Bearer 值（票 17：mint 出站同样带认证头）", async () => {
    setEnv("JIAOTU_API_KEY", "env-key-57");
    const { impl, seen } = mockFetch(() => jsonResponse(201, { token: "t", jti: "j", exp: 1 }));
    await makeMint(impl, { apiKey: undefined }).mintTaskTicket({
      jti: "tk_e", sub: "s", caseId: null, runId: "r", scope: [], allowedTools: [],
    });
    expect(seen[0].headers["authorization"]).toBe("Bearer env-key-57");
  });
});

// ---------- INV-2 单口（审批铸票只许椒图 g4，identity/index.ts:772-788 的 x-internal-caller 闸） ----------

describe("mintApprovalToken：外部模式不可达（防误用炸响，票 58 走批准响应中继）", () => {
  test("抛错且信息点名 g4；一个字节都不出站", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(201, {}));
    const err = await makeMint(impl)
      .mintApprovalToken()
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("approval mint belongs to gateway g4");
    expect(seen).toHaveLength(0);
  });
});

// ---------- 焚毁读口（GET /internal/tickets/:jti/burned，INV-1 fail-closed 纪律） ----------

describe("JiaoTuUsedTokenReader 出站 wire 形（椒图未登记 jti 也回 200 {burned:false}）", () => {
  test("已焚/未焚：200 {burned} → 布尔；请求 URL 带编码后的 jti 路径段，头带 Bearer（票 17）", async () => {
    const hit = mockFetch(() => jsonResponse(200, { burned: true }));
    expect(await makeReader(hit.impl).lookup("tk_57B")).toBe(true);
    expect(hit.seen[0].method).toBe("GET");
    expect(hit.seen[0].url).toBe(`${JT_BASE}/internal/tickets/tk_57B/burned`);
    expect(hit.seen[0].headers["authorization"]).toBe("Bearer jt-key-57");

    const miss = mockFetch(() => jsonResponse(200, { burned: false }));
    expect(await makeReader(miss.impl).lookup("tk_absent")).toBe(false);
  });

  test("非 200 一律抛（401/404/409/502）：「查不到真相」不能冒充「真相是没有」（INV-1）", async () => {
    for (const status of [401, 404, 409, 502]) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: "x" }));
      await expect(makeReader(impl).lookup("tk_x")).rejects.toThrow(`HTTP ${status}`);
    }
  });

  test("网络不可达 → 抛（读口病了必须让闸看见，绝不静默当未焚）", async () => {
    const { impl } = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(makeReader(impl).lookup("tk_x")).rejects.toThrow("fetch failed");
  });

  test("jti 进 URL 前经 encodeURIComponent（票面 jti 是自铸 id，防线照挂）", async () => {
    const { impl, seen } = mockFetch(() => jsonResponse(200, { burned: false }));
    await makeReader(impl).lookup("tk/a b");
    expect(seen[0].url).toBe(`${JT_BASE}/internal/tickets/tk%2Fa%20b/burned`);
  });

  test("未传 baseUrl → env JIAOTU_GATEWAY_URL 决定出站目的地", async () => {
    setEnv("JIAOTU_GATEWAY_URL", "http://env-jt:8080");
    const { impl, seen } = mockFetch(() => jsonResponse(200, { burned: true }));
    await makeReader(impl, { baseUrl: undefined }).lookup("tk_env");
    expect(seen[0].url).toBe("http://env-jt:8080/internal/tickets/tk_env/burned");
  });

  test("未传 apiKey → env JIAOTU_API_KEY 决定 Bearer 值（票 17：lookup 出站同样带认证头）", async () => {
    setEnv("JIAOTU_API_KEY", "env-key-57");
    const { impl, seen } = mockFetch(() => jsonResponse(200, { burned: true }));
    await makeReader(impl, { apiKey: undefined }).lookup("tk_env");
    expect(seen[0].headers["authorization"]).toBe("Bearer env-key-57");
  });
});

// ---------- 焚毁发起（POST /internal/tickets/:jti/burn，Bearer api_key，fire-and-forget） ----------

describe("JiaoTuTokenBurner 出站 wire 形（identity/index.ts:817-847：只认路径 jti + Bearer 头）", () => {
  test("burn：POST {base}/internal/tickets/:jti/burn，authorization: Bearer 逐字对齐；无请求体（wire 无 body 字段）", () => {
    const { impl, seen } = mockFetch(() => jsonResponse(200, { jti: "ap_57C", first_time: true }));
    expect(() => makeBurner(impl).burn("ap_57C")).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(`${JT_BASE}/internal/tickets/ap_57C/burn`);
    expect(seen[0].headers["authorization"]).toBe("Bearer jt-key-57");
    expect(seen[0].hasBody).toBe(false); // source 不进椒图 wire（接口形保留，实现只发 jti）
    expect(seen[0].signal).toBeInstanceOf(AbortSignal); // 2s 超时闸（fire-and-forget 也挂）
  });

  test("fire-and-forget：网络错/2s 超时不抛不阻塞执行器，只打结构化日志（重放防线另有 executed_at+TTL 兜底）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { impl } = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    expect(() => makeBurner(impl).burn("ap_57D")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // 让被吞掉的 rejection 走完 .catch 日志路径
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.warn).toBe("jiaotu_burn_failed");
    expect(line.jti).toBe("ap_57D");
    expect(String(line.error)).toContain("fetch failed");
    errSpy.mockRestore();
  });

  test("网关侧拒绝（401 未注册/非 active）同样落结构化日志不抛，正文不进日志", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { impl } = mockFetch(() => jsonResponse(401, { error: "api_key 无效或 agent 非 active:未注册 agent 的一切请求拒绝(INV-6)" }));
    expect(() => makeBurner(impl).burn("ap_57E")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(line.warn).toBe("jiaotu_burn_failed");
    expect(line.jti).toBe("ap_57E");
    expect(line.error).toBe("HTTP 401"); // 只记状态码，不记上游错误正文
    errSpy.mockRestore();
  });

  test("未传 apiKey → env JIAOTU_API_KEY 决定 Bearer 值", async () => {
    setEnv("JIAOTU_API_KEY", "env-key-57");
    const { impl, seen } = mockFetch(() => jsonResponse(200, {}));
    makeBurner(impl, { apiKey: undefined }).burn("ap_env");
    expect(seen[0].headers["authorization"]).toBe("Bearer env-key-57");
  });
});
