import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import {
  GatewayLlmClient,
  LlmUpstreamError,
  llmSmokeProbe,
  unwrapJsonText,
} from "./llm-client.js";

// 票 27 验收①③：真 LLM client 的出站契约测试——出站请求形态（经 gateway /proxy/llm/*
// 的 OpenAI 兼容 chat/completions，minimax-m2；m3/m4 卡口径）+ 响应解析 + 错误映射
// fail-closed。出站 seam = 注入 fetchImpl 捕获请求（票 08 test_proxy.py 的
// httpx.MockTransport 先例在 TS 侧的等价物），测试绝不真出网。

const PROXY_BASE = "http://gateway-stub:8002/proxy/llm";

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 出站 seam：捕获发给「gateway 代理」的请求（方法/URL/头/体），回固定 OpenAI 形态回包。 */
function mockFetch(reply: () => Response): { impl: typeof fetch; seen: SeenReq[] } {
  const seen: SeenReq[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return reply();
  }) as typeof fetch;
  return { impl, seen };
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const openAiReply = (content: string, totalTokens = 42): Response =>
  jsonResponse(200, {
    id: "cmpl-stub-27",
    model: "minimax-m2",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: totalTokens - 30, total_tokens: totalTokens },
  });

function makeClient(impl: typeof fetch, over: ConstructorParameters<typeof GatewayLlmClient>[0] = {}) {
  return new GatewayLlmClient({ baseUrl: PROXY_BASE, model: "minimax-m2", fetchImpl: impl, ...over });
}

// env 保存/恢复：冒烟探测测试要动 SECRETS_LLM_API_KEY，绝不漏出测试进程
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

describe("出站请求形态（验收①：经 gateway /proxy/llm/* 出站，prompt 契约原样出域）", () => {
  test("POST {base}/v1/chat/completions：model/messages/temperature 定形，prompt 逐字进 messages", async () => {
    const { impl, seen } = mockFetch(() => openAiReply('{"verdict":"tp"}'));
    const r = await makeClient(impl, { requestId: "req-27-0001", actor: "agent:triage" }).chat(
      "你是 SOC 分诊分析师……<<<UNTRUSTED field=\"description\">>>……",
      { node: "verdict_llm" },
    );
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${PROXY_BASE}/v1/chat/completions`);
    // 代理审计五要素关联（票 08 audit 读 x-actor-id / x-request-id）
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-actor-id"]).toBe("agent:triage");
    expect(req.headers["x-request-id"]).toBe("req-27-0001");
    // OpenAI 兼容 chat/completions 形态：prompt 契约文本逐字是 user 消息，不拆不改
    expect(req.body.model).toBe("minimax-m2");
    expect(req.body.temperature).toBe(0);
    expect(req.body.messages).toEqual([
      { role: "user", content: "你是 SOC 分诊分析师……<<<UNTRUSTED field=\"description\">>>……" },
    ]);
    expect(r.text).toBe('{"verdict":"tp"}');
    expect(r.tokens).toBe(42);
  });

  test("env 全可覆盖：SOC_LLM_PROXY_URL / LLM_MODEL 未传参时取 env（m3/m4 卡口径）", async () => {
    setEnv("SOC_LLM_PROXY_URL", "http://env-gateway:8002/proxy/llm");
    setEnv("LLM_MODEL", "MiniMax-M2-test");
    const { impl, seen } = mockFetch(() => openAiReply("ok"));
    await new GatewayLlmClient({ fetchImpl: impl }).chat("hi", { node: "verdict_llm" });
    expect(seen[0].url).toBe("http://env-gateway:8002/proxy/llm/v1/chat/completions");
    expect(seen[0].body.model).toBe("MiniMax-M2-test");
  });

  test("INV-4（agent 侧金丝雀）：出站体永不含 ${{ SECRETS. 占位符，也永不含进程 env 里的 SECRETS_* 值", async () => {
    setEnv("SECRETS_CANARY_KEY", "canary-27-agent-side-never-leaks");
    const { impl, seen } = mockFetch(() => openAiReply("ok"));
    await makeClient(impl).chat(
      "出站体只有 prompt 契约文本；凭证位根本不出现在分诊/调查的调用面",
      { node: "verdict_llm" },
    );
    const raw = JSON.stringify(seen[0].body);
    expect(raw).not.toContain("${{ SECRETS.");
    expect(raw).not.toContain("canary-27-agent-side-never-leaks");
  });

  test("HTTP 超时与 budget 三闸同 env 链（LLM_TIMEOUT_MS_<NODE> > LLM_TIMEOUT_MS > 60s）——对齐不抢闸", async () => {
    setEnv("LLM_TIMEOUT_MS_VERDICT_LLM", "1234");
    const { impl } = mockFetch(() => openAiReply("ok"));
    const client = makeClient(impl);
    // 捕获 fetchImpl 收到的 signal 超时时长：AbortSignal.timeout 的微秒级痕迹不可读，
    // 改为对 client 暴露的 timeoutMs(node) 断言（内部就用它造 signal）
    expect(client.timeoutMs("verdict_llm")).toBe(1234);
    delete process.env.LLM_TIMEOUT_MS_VERDICT_LLM;
    delete process.env.LLM_TIMEOUT_MS; // 冒烟调用方可能调大全局超时，这里清掉再验默认值
    expect(client.timeoutMs("verdict_llm")).toBe(60_000); // 决策 #4 默认 60s
  });
});

describe("响应解析与错误映射（验收③：schema 把关前的自由文本通道，fail-closed 不裸抛）", () => {
  test("200 但缺 choices / content 非字符串 / body 非 JSON → bad_shape", async () => {
    for (const bad of [
      jsonResponse(200, { choices: [] }),
      jsonResponse(200, { choices: [{ message: { role: "assistant" } }] }),
      new Response("<html>gateway error page</html>", { status: 200 }),
    ]) {
      const { impl } = mockFetch(() => bad);
      const err = await makeClient(impl).chat("hi", { node: "verdict_llm" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUpstreamError);
      expect((err as LlmUpstreamError).code).toBe("bad_shape");
    }
  });

  test("429 → rate_limited；5xx → http_<status>；上游/代理的错误正文不进 error（provider 文本不许流入审计/事件）", async () => {
    const leaky = "refuse to forward (fail-closed); canary-27-never-appears";
    for (const [status, code] of [[429, "rate_limited"], [500, "http_500"], [503, "http_503"]] as const) {
      const { impl } = mockFetch(() => jsonResponse(status, { error: leaky }));
      const err = await makeClient(impl).chat("hi", { node: "verdict_llm" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUpstreamError);
      expect((err as LlmUpstreamError).code).toBe(code);
      expect((err as LlmUpstreamError).message).not.toContain("canary-27-never-appears");
    }
  });

  test("连接拒绝 → unreachable；AbortError/TimeoutError → timeout（budget 60s 墙钟仍是最终兜底闸）", async () => {
    const refused = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await makeClient(refused.impl).chat("hi", { node: "verdict_llm" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUpstreamError);
    expect((err as LlmUpstreamError).code).toBe("unreachable");

    const { impl } = mockFetch(() => {
      const e = new Error("This operation was aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const err2 = await makeClient(impl).chat("hi", { node: "verdict_llm" }).catch((e: unknown) => e);
    expect((err2 as LlmUpstreamError).code).toBe("timeout");
  });

  test("usage 缺失 → tokens=0（计费口拿不到用量就记 0，不编数）", async () => {
    const { impl } = mockFetch(() =>
      jsonResponse(200, { choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const r = await makeClient(impl).chat("hi", { node: "verdict_llm" });
    expect(r.tokens).toBe(0);
  });
});

describe("unwrapJsonText（真模型输出剥壳：think 推理段 + markdown 围栏——剥后仍由 parseVerdict/parseReport 把关）", () => {
  test("```json 围栏剥出内芯；无围栏原样 trim；围栏未闭合不误吞", () => {
    expect(unwrapJsonText('```json\n{"verdict":"tp"}\n```')).toBe('{"verdict":"tp"}');
    expect(unwrapJsonText("```\n{\"verdict\":\"fp\"}\n```")).toBe('{"verdict":"fp"}');
    expect(unwrapJsonText('  {"verdict":"btp"}  ')).toBe('{"verdict":"btp"}');
    expect(unwrapJsonText("```json\n{\"truncated\":")).toBe('```json\n{"truncated":');
  });

  test("MiniMax-M2 真网形态：<think> 推理段在前 + 围栏在后 → 只剩 JSON 内芯", () => {
    expect(unwrapJsonText('<think>\n用户要求四分类。我判断是 tp。\n</think>\n```json\n{"verdict":"tp"}\n```'))
      .toBe('{"verdict":"tp"}');
    expect(unwrapJsonText('<think>\n思考未闭合被截断')).toBe("<think>\n思考未闭合被截断");
  });
});

// ---------- 狗粮形态条件鉴权头（票 57·G1：椒图对 LLM 面验 Bearer api_key） ----------

describe("狗粮形态条件鉴权头（票 57：JIAOTU_API_KEY 设了附 Bearer，未设逐字节现状）", () => {
  test("未设 JIAOTU_API_KEY：头集合与现状逐字节相同——一个 authorization 键都不多（内部网关形态）", async () => {
    setEnv("JIAOTU_API_KEY", undefined);
    const { impl, seen } = mockFetch(() => openAiReply("ok"));
    await makeClient(impl, { requestId: "req-57a", actor: "agent:triage" }).chat("hi", { node: "verdict_llm" });
    expect(seen).toHaveLength(1);
    // 深等整个头集合：authorization 键不存在 = 请求与票 57 之前逐字节相同
    expect(seen[0].headers).toEqual({
      "content-type": "application/json",
      "x-actor-id": "agent:triage",
      "x-request-id": "req-57a",
    });
    expect(seen[0].url).toBe(`${PROXY_BASE}/v1/chat/completions`); // 路径也不受开关影响
  });

  test("设定 JIAOTU_API_KEY（env 或构造注入）：authorization: Bearer 附上，其余头不动", async () => {
    setEnv("JIAOTU_API_KEY", "jt-env-key-57");
    const { impl, seen } = mockFetch(() => openAiReply("ok"));
    await makeClient(impl, { actor: "agent:triage" }).chat("hi", { node: "verdict_llm" });
    expect(seen[0].headers["authorization"]).toBe("Bearer jt-env-key-57");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].headers["x-actor-id"]).toBe("agent:triage");

    const injected = mockFetch(() => openAiReply("ok"));
    await makeClient(injected.impl, { apiKey: "jt-opt-key-57" }).chat("hi", { node: "verdict_llm" });
    expect(injected.seen[0].headers["authorization"]).toBe("Bearer jt-opt-key-57");
  });
});

// ---------- 真网冒烟（验收⑤：能力探测——SECRETS_LLM_API_KEY 有真值且 gateway 可达才跑） ----------

const SMOKE_BASE = process.env.SOC_LLM_SMOKE_URL ?? "http://127.0.0.1:8002/proxy/llm";
const smokeProbe = await llmSmokeProbe(SMOKE_BASE);
if (!smokeProbe.ok) console.warn(`[票 27 真网冒烟 skip] ${smokeProbe.reason}`);

describe.skipIf(!smokeProbe.ok)("真网冒烟：真实告警经 gateway 代理出站产出结构合法 verdict（ADR 0002 决策 2）", { timeout: 120_000 }, () => {
  test("5712 暴力破解告警 → minimax verdict，parseVerdict 结构合法（证据打印留痕）", async () => {
    const { alertInputFromWazuh } = await import("../workers/triage/testkit.js");
    const { buildTriagePrompt } = await import("../workers/triage/prompt.js");
    const { parseVerdict } = await import("../workers/triage/schema.js");
    const { RealTriageLlm } = await import("../workers/triage/llm-real.js");
    const { readFileSync } = await import("node:fs");

    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../fixtures/alerts/ssh-5712-real.json", import.meta.url)), "utf8"),
    ) as Record<string, unknown>;
    const mapped = alertInputFromWazuh(raw) as unknown as {
      title: string; severity: number; tags: string[]; description: string;
      observables: { dataType: string; data: string }[];
    };
    const host = mapped.observables.find((o) => o.dataType === "hostname")?.data ?? "unknown";
    const input = {
      alert: { id: String(raw.id), title: mapped.title, severity: mapped.severity, tags: mapped.tags, host },
      untrusted: [{ field: "description", content: mapped.description }],
      kbHits: [],
      merge: { host, withinHours: 24, openCasesChecked: 0, sameHostCaseFound: false, candidateCaseId: null },
    };
    const llm = new RealTriageLlm(
      new GatewayLlmClient({ baseUrl: SMOKE_BASE, actor: "agent:triage", requestId: "smoke-ticket-27" }),
    );
    const reply = await llm.verdict({ prompt: buildTriagePrompt(input), input });
    const parsed = parseVerdict(reply.text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      // 证据打印：模型名/用量/四分类结果（不含任何凭证面），人工复核 5712 是否如标注意见判 tp
      console.log(`[票 27 真网冒烟证据] model=${process.env.LLM_MODEL ?? "minimax-m2"} tokens=${reply.tokens} ` +
        `verdict=${parsed.verdict.verdict} confidence=${parsed.verdict.confidence} action=${parsed.verdict.recommended_action}`);
      console.log(`  rationale=${parsed.verdict.rationale} self_audit=${JSON.stringify(parsed.verdict.self_audit)}`);
    }
  });
});

// 兜底观察面：无 key/无网关时「为什么 skip」必须说在明面上（票 16 msbProbe 先例）
describe("能力探测可观察", () => {
  test("llmSmokeProbe 返回形状良定：无 key / 网关不可达都带明确原因，绝不静默", async () => {
    setEnv("SECRETS_LLM_API_KEY", undefined);
    const noKey = await llmSmokeProbe(SMOKE_BASE);
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.reason).toMatch(/SECRETS_LLM_API_KEY/);

    setEnv("SECRETS_LLM_API_KEY", "probe-key-not-a-real-secret");
    const dead = await llmSmokeProbe("http://127.0.0.1:9/proxy/llm"); // discard 端口，必拒
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.reason).toMatch(/不可达/);
  });
});
