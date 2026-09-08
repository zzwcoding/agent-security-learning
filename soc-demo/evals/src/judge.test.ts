import { afterEach, describe, expect, test } from "vitest";
import { LlmUpstreamError } from "../../services/agent/src/llm-client.js";
import { FixedJudge, StrictPointJudge, makeJudgeClient, selectJudge } from "./judge.js";

// 票 19 验收④（FR-M11.2 + 决策 #7）：judge strict 要点覆盖（expected_output 全部命中才
// 1 分）、judge 与被测模型分离（JUDGE_MODEL env 走 GatewayLlmClient → gateway /proxy/llm）、
// 分数不进门禁（门禁只认确定性断言）。
// 测试绝不真出网：seam 注入 stub（票 27 llm-client.test.ts 的 mockFetch 先例）。

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const judgeReply = (points: { point: string; hit: boolean }[]): Response =>
  jsonResponse(200, {
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ points }) }, finish_reason: "stop" }],
    usage: { total_tokens: 37 },
  });

interface Seen { url: string; body: Record<string, unknown>; headers: Record<string, string> }
function mockJudge(reply: () => Response): { judge: StrictPointJudge; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    return reply();
  }) as typeof fetch;
  return { judge: new StrictPointJudge(makeJudgeClient({ fetchImpl: impl }), "judge-stub"), seen };
}

const POINTS = ["verdict 为 true_positive", "recommended_action 为 create_case"];

describe("StrictPointJudge：strict 要点覆盖打分", () => {
  test("全部命中才 1 分；命中明细回填", async () => {
    const { judge } = mockJudge(() => judgeReply(POINTS.map((p) => ({ point: p, hit: true }))));
    const r = await judge.judge({ expectedOutput: POINTS, transcript: "transcript-text" });
    expect(r.evaluable).toBe(true);
    if (r.evaluable) {
      expect(r.score).toBe(1);
      expect(r.missed).toEqual([]);
      expect(r.hit).toEqual(POINTS);
    }
  });

  test("有一条没命中就是 0 分，missed 点名那一条（strict 口径）", async () => {
    const { judge } = mockJudge(() =>
      judgeReply([{ point: POINTS[0], hit: true }, { point: POINTS[1], hit: false }]));
    const r = await judge.judge({ expectedOutput: POINTS, transcript: "t" });
    if (r.evaluable) {
      expect(r.score).toBe(0);
      expect(r.missed).toEqual([POINTS[1]]);
    } else expect.unreachable();
  });

  test("judge 回包不合 schema：重试 1 次后仍坏 → not_evaluable，不算失败（PRD 异常与边界）", async () => {
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return jsonResponse(200, {
        choices: [{ index: 0, message: { role: "assistant", content: "sorry 我说人话" }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      });
    }) as typeof fetch;
    const judge = new StrictPointJudge(makeJudgeClient({ fetchImpl: impl }), "judge-model-x");
    const r = await judge.judge({ expectedOutput: POINTS, transcript: "t" });
    expect(calls).toBe(2);
    expect(r.evaluable).toBe(false);
  });

  test("上游病了（传输层异常 → LlmUpstreamError）→ not_evaluable 带原因，不裸抛", async () => {
    const impl = (async () => {
      throw new LlmUpstreamError("timeout");
    }) as unknown as typeof fetch;
    const judge = new StrictPointJudge(makeJudgeClient({ fetchImpl: impl }), "judge-model-x");
    const r = await judge.judge({ expectedOutput: POINTS, transcript: "t" });
    expect(r.evaluable).toBe(false);
    if (!r.evaluable) expect(r.reason).toContain("judge 上游不可用");
  });

  test("judge prompt 里带期望要点与执行记录；temperature 固定 0（评分要稳）", async () => {
    const { judge, seen } = mockJudge(() => judgeReply(POINTS.map((p) => ({ point: p, hit: true }))));
    await judge.judge({ expectedOutput: POINTS, transcript: "执行记录XYZ" });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/proxy/llm/v1/chat/completions");
    expect(seen[0].body.temperature).toBe(0);
    const content = (seen[0].body.messages as { content: string }[])[0].content;
    expect(content).toContain("verdict 为 true_positive");
    expect(content).toContain("执行记录XYZ");
  });
});

describe("judge 与被测模型分离（决策 #7）：JUDGE_MODEL 独立可配，走票 27 代理路径", () => {
  const savedEnv: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("makeJudgeClient：model 取 JUDGE_MODEL，actor=eval:judge，x-request-id 关联调用链", async () => {
    savedEnv.JUDGE_MODEL = process.env.JUDGE_MODEL;
    process.env.JUDGE_MODEL = "judge-glm-x";
    const seen: Seen[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return judgeReply([]);
    }) as typeof fetch;
    const seam = makeJudgeClient({ fetchImpl: impl, requestId: "req-eval-1" });
    const judge = new StrictPointJudge(seam, seam.model);
    await judge.judge({ expectedOutput: POINTS, transcript: "t" });
    expect(seen[0].body.model).toBe("judge-glm-x");
    expect(seen[0].headers["x-actor-id"]).toBe("eval:judge");
    expect(seen[0].headers["x-request-id"]).toBe("req-eval-1");
  });
});

describe("FixedJudge（测试固定分 stub）与 selectJudge（真网能力探测 skip 先例）", () => {
  test("FixedJudge：回固定分，不碰网络", async () => {
    expect((await new FixedJudge(1).judge({ expectedOutput: POINTS, transcript: "t" })).evaluable).toBe(true);
    const zero = await new FixedJudge(0).judge({ expectedOutput: POINTS, transcript: "t" });
    expect(zero.evaluable && zero.score).toBe(0);
  });

  test("selectJudge：EVAL_JUDGE=fake → FixedJudge（单测确定性，不探测不出网）", async () => {
    const saved = process.env.EVAL_JUDGE;
    try {
      process.env.EVAL_JUDGE = "fake";
      const j = await selectJudge();
      expect(j).toBeInstanceOf(FixedJudge);
    } finally {
      if (saved === undefined) delete process.env.EVAL_JUDGE;
      else process.env.EVAL_JUDGE = saved;
    }
  });

  test("selectJudge：无真凭证 → null（套件按 not_evaluable 留痕，显式 skip 不静默）", async () => {
    const savedKey = process.env.SECRETS_LLM_API_KEY;
    const savedMode = process.env.EVAL_JUDGE;
    try {
      delete process.env.SECRETS_LLM_API_KEY;
      delete process.env.EVAL_JUDGE;
      const j = await selectJudge();
      expect(j).toBeNull();
    } finally {
      if (savedKey !== undefined) process.env.SECRETS_LLM_API_KEY = savedKey;
      if (savedMode !== undefined) process.env.EVAL_JUDGE = savedMode;
    }
  });
});
