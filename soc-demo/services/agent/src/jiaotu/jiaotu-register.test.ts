import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerJiaotuAgent, upsertEnvKey } from "../../../../scripts/jiaotu-register.js";

// 狗粮票 62：scripts/jiaotu-register.ts 的跨仓契约锁。该脚本是 soc-demo → 椒图的注册
// 正门（GET /api/v1/agents?q= 查重 + POST /api/v1/agents 注册 + .env upsert），椒图侧
// identity.test.ts:32-41 已锁 201 {agent_id, api_key}（^agent_/^ajt_）与「重名不冲突、
// 唯一性在 agent_id」，soc-demo 侧这里对齐同一口径。锁法照 token-ports-jiaotu.test.ts
// 的 mockFetch 出站捕获先例，fetchImpl 注入（脚本既有测试缝），测试绝不真出网。
// 落位说明：scripts/ 不在任何 vitest project 内（根 package.json 无 test script，
// workspace = services/*、packages/*、evals），故按票 62 预案放 services/agent 收编，
// 相对路径引 scripts 源文件。

const JT_BASE = "http://jiaotu-register-stub:8080";

interface SeenReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 出站 seam：捕获请求（方法/URL/头/体），回固定 JSON 回包；reply 可按 seen.length 分支。 */
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

const register = (impl: typeof fetch): ReturnType<typeof registerJiaotuAgent> =>
  registerJiaotuAgent({ baseUrl: JT_BASE, fetchImpl: impl });

// ---------- 先查后建幂等（GET /api/v1/agents?q=<name> 精确匹配 → 命中不 POST） ----------

describe("registerJiaotuAgent 契约（只走椒图公开正门 /api/v1/agents，对齐 identity.test.ts:32-41）", () => {
  test("未命中 → 先 GET 查重再 POST /api/v1/agents，body {name,scope,owner} 逐字对齐；201 {agent_id,api_key} 解包", async () => {
    // 列表只回子串同名（q 是服务端子串过滤），客户端必须精确匹配 name → 不算命中
    let call = 0;
    const { impl, seen } = mockFetch(() => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { agents: [{ agent_id: "agent_decoy62", name: "soc-demo-62" }] })
        : jsonResponse(201, { agent_id: "agent_reg62", api_key: "ajt_once62" });
    });
    const out = await register(impl);

    // 201 回包三键解包：created=true 才有 apiKeyOnce（明文仅此一次的承诺在结果形上可见）
    expect(out).toEqual({ created: true, agentId: "agent_reg62", apiKeyOnce: "ajt_once62" });
    // 对齐椒图侧已锁的身份形（identity.test.ts:38-39）
    expect(out.agentId).toMatch(/^agent_/);
    expect(out.apiKeyOnce).toMatch(/^ajt_/);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe(`${JT_BASE}/api/v1/agents?q=soc-demo`);
    expect(seen[1]?.method).toBe("POST");
    expect(seen[1]?.url).toBe(`${JT_BASE}/api/v1/agents`);
    expect(seen[1]?.headers["content-type"]).toBe("application/json");
    // 注册 body 一字不增不减：scope 缺省三项按 soc-demo 对椒图的三件事、owner 缺省归属人
    expect(seen[1]?.body).toEqual({
      name: "soc-demo",
      scope: ["任务票申领", "票据焚毁", "LLM 出站"],
      owner: "soc-demo 数字员工",
    });
  });

  test("命中同名 → 只发一次 GET 不 POST，返回 {created:false, agentId} 且无 apiKeyOnce（不重吐 key）", async () => {
    const { impl, seen } = mockFetch(() =>
      jsonResponse(200, { agents: [{ agent_id: "agent_hit62", name: "soc demo 62" }] }),
    );
    const out = await registerJiaotuAgent({ baseUrl: JT_BASE, name: "soc demo 62", fetchImpl: impl });

    expect(out).toEqual({ created: false, agentId: "agent_hit62" });
    expect(out.apiKeyOnce).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    // name 进 q 前经 encodeURIComponent（子串过滤的 wire 形，同 jti 编码先例）
    expect(seen[0]?.url).toBe(`${JT_BASE}/api/v1/agents?q=soc%20demo%2062`);
  });

  test("同 name 二次注册走查重命中路径（椒图重名不冲突语义的幂等回归锚：全程只 POST 一次）", async () => {
    let call = 0;
    const { impl, seen } = mockFetch(() => {
      call += 1;
      if (call === 1) return jsonResponse(200, { agents: [] });
      if (call === 2) return jsonResponse(201, { agent_id: "agent_idem62", api_key: "ajt_first62" });
      return jsonResponse(200, { agents: [{ agent_id: "agent_idem62", name: "soc-demo" }] });
    });
    const first = await register(impl);
    const second = await register(impl);

    expect(first).toEqual({ created: true, agentId: "agent_idem62", apiKeyOnce: "ajt_first62" });
    // 第二次：查重命中 → 跳过注册，不产生第二把 key（重启重跑承诺）
    expect(second).toEqual({ created: false, agentId: "agent_idem62" });
    expect(second.apiKeyOnce).toBeUndefined();
    expect(seen.map((r) => r.method)).toEqual(["GET", "POST", "GET"]);
    expect(seen.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("网络不可达 → 大声抛错，信息含完整 URL 与原始错误语义（绝不静默）", async () => {
    // reject 路径 mockFetch 的 reply 形覆盖不到，这里直接手写注入缝（同 token-ports 先例）
    const rejecting = (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const err = await register(rejecting).catch((e: unknown) => e);
    expect((err as Error).message).toContain(`${JT_BASE}/api/v1/agents?q=soc-demo`);
    expect((err as Error).message).toContain("fetch failed"); // 原始错误语义不被吞
  });

  test("失败分支大声抛：列表非 ok 抛 HTTP 状态且不进 POST；POST 非 201（含 200 冒充）也算病", async () => {
    const list500 = mockFetch(() => jsonResponse(500, { error: "x" }));
    const err1 = await register(list500.impl).catch((e: unknown) => e);
    expect((err1 as Error).message).toContain("GET /api/v1/agents → HTTP 500");
    expect(list500.seen).toHaveLength(1); // 查重就失败，注册请求一个字节都不出

    let call = 0;
    const post200 = mockFetch(() => {
      call += 1;
      return call === 1
        ? jsonResponse(200, { agents: [] })
        : jsonResponse(200, { agent_id: "agent_x62", api_key: "ajt_x62" });
    });
    const err2 = await register(post200.impl).catch((e: unknown) => e);
    expect((err2 as Error).message).toContain("POST /api/v1/agents → HTTP 200");
  });
});

// ---------- upsertEnvKey 三态（仓库根 .env 的单键 upsert，tmp 目录、测试后无残留） ----------

describe("upsertEnvKey 三态（JIAOTU_API_KEY 落盘形态）", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });
  const makeEnvPath = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "jiaotu-register-test-"));
    tmpDirs.push(dir);
    return join(dir, ".env");
  };

  test("文件不存在 → 新建：注释行 + 键行各占一行", () => {
    const envFile = makeEnvPath();
    upsertEnvKey(envFile, "JIAOTU_API_KEY", "ajt_new62", "票 62：明文仅此一次");
    expect(readFileSync(envFile, "utf8")).toBe("# 票 62：明文仅此一次\nJIAOTU_API_KEY=ajt_new62\n");
  });

  test("已有该键 → 整行替换，其他行一字不动，不产生重复键行", () => {
    const envFile = makeEnvPath();
    writeFileSync(
      envFile,
      "# header\nOTHER=keep\nJIAOTU_API_KEY=ajt_old\nTAIL=line\n",
      "utf8",
    );
    upsertEnvKey(envFile, "JIAOTU_API_KEY", "ajt_rotated62", "不新增注释");
    expect(readFileSync(envFile, "utf8")).toBe(
      "# header\nOTHER=keep\nJIAOTU_API_KEY=ajt_rotated62\nTAIL=line\n",
    );
  });

  test("无该键 → 尾部追加注释行 + 键行；文件无尾换行时先补 glue 换行", () => {
    const withNl = makeEnvPath();
    writeFileSync(withNl, "OTHER=keep\n", "utf8");
    upsertEnvKey(withNl, "JIAOTU_API_KEY", "ajt_app62", "追加");
    expect(readFileSync(withNl, "utf8")).toBe("OTHER=keep\n# 追加\nJIAOTU_API_KEY=ajt_app62\n");

    const noNl = makeEnvPath();
    writeFileSync(noNl, "TAIL=no-trailing-newline", "utf8");
    upsertEnvKey(noNl, "JIAOTU_API_KEY", "ajt_glue62");
    expect(readFileSync(noNl, "utf8")).toBe(
      "TAIL=no-trailing-newline\nJIAOTU_API_KEY=ajt_glue62\n",
    );
  });
});
