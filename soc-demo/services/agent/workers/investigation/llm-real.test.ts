import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { executeRun } from "../../src/graph.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { GatewayLlmClient, LlmUpstreamError, type LlmChatResult } from "../../src/llm-client.js";
import { MemoryKb } from "../triage/kb.js";
import { fakeScan, httpJson, KEY, makeTaskTicket, seedAlert, startCaseBackend, type CaseBackend } from "../triage/testkit.js";
import { makeInvestigationFlow } from "./flow.js";
import { RealInvestigationLlm } from "./llm-real.js";
import { HttpInvestigationM2 } from "./m2.js";
import { buildDecidePrompt, buildPlanPrompt, INVESTIGATION_TOOLS, type DecideCall, type PlanCall } from "./prompt.js";
import { parseReport } from "./schema.js";
import { FixtureSiem, type SiemBackend } from "./siem.js";

// 票 27 验收②③④：RealInvestigationLlm（生产 adapter）——seam 接口 InvestigationLlm
// 四方法不变；mock 上游锁 plan/decide 的输出 JSON 形态与 report 的 schema 通道；
// 上游病了 → plan/decide/summarize（无 worker 降级路径）fail-closed 强杀，
// report（有降级路径）走既有「重试 1 次 → 降级自由文本 + 标记」——与 Fake 版一致。

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/alerts/", import.meta.url));

function chatOf(script: () => LlmChatResult | Promise<LlmChatResult>) {
  const calls: string[] = [];
  return {
    calls,
    chat: async (prompt: string): Promise<LlmChatResult> => {
      calls.push(prompt);
      return script();
    },
  };
}

const canned = (obj: unknown, tokens = 48): LlmChatResult => ({ text: JSON.stringify(obj), tokens });

const PLAN = { tasks: ["siem_query 按 ip pivot 查询（强制时间窗）", "related_alerts 聚合同主机历史告警"] };
const TOOL_DECISION = {
  action: "tool",
  tool: "siem_query",
  params: { entity_type: "ip", entity: "18.18.18.18", time_window: { from: "2023-04-24T13:51:36.409Z", to: "2023-04-26T13:51:36.409Z" } },
};
const FINISH_DECISION = { action: "finish" };
const REPORT = {
  summary: "18.18.18.18 对 centos7 的 SSH 暴力破解：SIEM 有同源命中，建议关注。",
  severity_assessment: 3,
  confidence: 0.85,
  findings: [{ entity: "18.18.18.18", evidence: "Oct 15 21:07:00 linux-agent sshd[29205]: Invalid user blimey from 18.18.18.18 port 48928", source_tool: "siem_query" }],
  affected_assets: ["centos7"],
  recommended_actions: [],
  kb_refs: [],
};

describe("RealInvestigationLlm · seam 四方法（接口不变）", () => {
  test("plan：mock 上游回 {tasks:[...]} → {tasks, tokens}；prompt 契约文本逐字出域", async () => {
    const chat = chatOf(() => canned(PLAN));
    const llm = new RealInvestigationLlm(chat);
    const input: PlanCall = {
      prompt: buildPlanPrompt({
        caseId: "case_1", title: "SSH 暴力破解", severity: 3, status: "Active",
        entities: { ips: ["18.18.18.18"], users: ["blimey"], hosts: ["centos7"], files: [] },
        primaryAlertDate: Date.parse("2023-04-25T13:51:36.409Z"),
      }),
      input: {
        case: {
          caseId: "case_1", title: "SSH 暴力破解", severity: 3, status: "Active",
          entities: { ips: ["18.18.18.18"], users: ["blimey"], hosts: ["centos7"], files: [] },
          primaryAlertDate: Date.parse("2023-04-25T13:51:36.409Z"),
        },
      },
    };
    const r = await llm.plan(input);
    expect(r.tasks).toEqual(PLAN.tasks);
    expect(r.tokens).toBe(48);
    expect(chat.calls[0]).toContain("SOC2 调查分析师");
    expect(chat.calls[0]).toContain("time_window");
  });

  test("decide：{action:tool,tool,params} → kind:tool；{action:finish} → kind:finish", async () => {
    const llm = new RealInvestigationLlm(chatOf(() => canned(TOOL_DECISION)));
    const call: DecideCall = {
      prompt: buildDecidePrompt({
        case: {
          caseId: "case_1", title: "t", severity: 3, status: "Active",
          entities: { ips: ["18.18.18.18"], users: [], hosts: [], files: [] },
          primaryAlertDate: 0,
        },
        tasks: ["x"], observations: [],
      }),
      input: {
        case: {
          caseId: "case_1", title: "t", severity: 3, status: "Active",
          entities: { ips: ["18.18.18.18"], users: [], hosts: [], files: [] },
          primaryAlertDate: 0,
        },
        tasks: ["x"], observations: [],
      },
    };
    const d = await llm.decide(call);
    expect(d).toMatchObject({ kind: "tool", tool: "siem_query" });
    expect(d.tokens).toBe(48);
    expect((d as { params: Record<string, unknown> }).params.entity).toBe("18.18.18.18");

    const llm2 = new RealInvestigationLlm(chatOf(() => canned(FINISH_DECISION)));
    expect(await llm2.decide(call)).toMatchObject({ kind: "finish" });
  });

  test("decide 输出不合形 → 抛 LlmUpstreamError（循环无降级路径：fail-closed 强杀，绝不硬编造 finish）", async () => {
    for (const bad of ["我不是 JSON", JSON.stringify({ action: "explode" }), JSON.stringify({ action: "tool" })]) {
      const llm = new RealInvestigationLlm(chatOf(() => canned(bad)));
      const err = await llm.decide({
        prompt: "p",
        input: {
          case: { caseId: "c", title: "t", severity: 1, status: "Active", entities: { ips: [], users: [], hosts: [], files: [] }, primaryAlertDate: 0 },
          tasks: [], observations: [],
        },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUpstreamError);
    }
  });

  test("report：真模型套围栏也剥得动——text 交 parseReport 把关（schema 把关仍在 worker）", async () => {
    const llm = new RealInvestigationLlm(chatOf(() => ({ text: "```json\n" + JSON.stringify(REPORT) + "\n```", tokens: 90 })));
    const r = await llm.report({
      prompt: "p",
      input: {
        case: { caseId: "case_1", title: "t", severity: 3, status: "Active", entities: { ips: [], users: [], hosts: [], files: [] }, primaryAlertDate: 0 },
        tasks: [], observations: [], incomplete: false, stepsUsed: 3,
      },
    });
    const parsed = parseReport(r.text);
    expect(parsed.ok).toBe(true);
    expect(r.tokens).toBe(90);
  });

  test("report 上游病了 → 不抛：不合 schema 的标记回包，worker 降级路径接管（与 Fake 版一致）", async () => {
    const llm = new RealInvestigationLlm(chatOf(() => {
      throw new LlmUpstreamError("rate_limited");
    }));
    const r = await llm.report({
      prompt: "p",
      input: {
        case: { caseId: "case_1", title: "t", severity: 1, status: "Active", entities: { ips: [], users: [], hosts: [], files: [] }, primaryAlertDate: 0 },
        tasks: [], observations: [], incomplete: false, stepsUsed: 1,
      },
    });
    expect(parseReport(r.text).ok).toBe(false);
    expect(r.text).toContain("llm_upstream:rate_limited");
  });

  test("summarize：上下文治理的小模型摘要只压不做决策；上游病了 → 抛 LlmUpstreamError", async () => {
    const llm = new RealInvestigationLlm(chatOf(() => canned("SIEM 查询命中 3 条来自 18.18.18.18 的失败登录。", 16)));
    const s = await llm.summarize({ text: "…30000 字符的工具输出…", tool: "siem_query" });
    expect(s.summary).toContain("18.18.18.18");
    expect(s.tokens).toBe(16);

    const down = new RealInvestigationLlm(chatOf(() => {
      throw new LlmUpstreamError("timeout");
    }));
    const err = await down.summarize({ text: "x", tool: "siem_query" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUpstreamError);
  });
});

// ---------- 全链路：真 case-backend + FixtureSiem + 脚本化 mock 上游（真实 adapter 驱动整个工具循环） ----------

/** 按出站体里装的 prompt 认出「这是哪一次调用」，回脚本化 OpenAI 形态响应。 */
function scriptedProxy(script: { plan?: unknown; decides: unknown[]; report?: () => Response }) {
  const seen: string[] = []; // 每次出站的 prompt 头 20 字（认调用用）+ 计数
  let decideIdx = 0;
  const impl = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[] };
    const prompt: string = body.messages[0]?.content ?? "";
    seen.push(prompt.slice(0, 20));
    let content: string;
    if (prompt.includes("列一份调查任务清单")) {
      content = JSON.stringify(script.plan ?? PLAN);
    } else if (prompt.includes("决定下一步")) {
      content = JSON.stringify(script.decides[Math.min(decideIdx++, script.decides.length - 1)]);
    } else if (prompt.includes("基于已执行工具的观察")) {
      return script.report?.() ?? openAi(JSON.stringify(REPORT));
    } else {
      throw new Error(`unexpected llm call: ${prompt.slice(0, 40)}`);
    }
    return openAi(content);
  }) as typeof fetch;
  return { impl, seen };

  function openAi(content: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { total_tokens: 48 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}

describe("全链路（验收③④）：RealInvestigationLlm 驱动 plan → tool_loop → report → write_timeline", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()?.();
  });

  async function rig(llmFetch: typeof fetch) {
    const caseBackend: CaseBackend = await startCaseBackend();
    closers.push(() => caseBackend.close());
    const db: DB = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const alertId = await seedAlert(caseBackend.url, `${FIXTURES}ssh-5712-real.json`);
    const created = await httpJson(caseBackend.url, "POST", `/api/v1/alerts/${alertId}/create-case`, {});
    const caseId = String((created.json as { case: { id: string } }).case.id);

    const llm = new RealInvestigationLlm(
      new GatewayLlmClient({ baseUrl: "http://gateway-stub:8002/proxy/llm", fetchImpl: llmFetch, requestId: "req-27-inv", actor: "agent:investigation" }),
    );
    const run = createRun(db, { kind: "case_flow", alertId: "" }, { audit, requestId: "req-27-inv" });
    const flow = makeInvestigationFlow({
      runId: run.id, requestId: "req-27-inv", caseId,
      ticket: makeTaskTicket(run.id, [...INVESTIGATION_TOOLS], { sub: "agent:investigation" }),
      hmacKey: KEY,
      m2: new HttpInvestigationM2(caseBackend.url),
      siem: new FixtureSiem(FIXTURES) as SiemBackend,
      kb: new MemoryKb(),
      llm,
      scan: fakeScan, // 票 36：guards tool_output 扫描口必填（生产 = scanInjection）
      audit,
      spillDir: "/tmp/invest-27-spill",
    });
    const done = await executeRun(db, run.id, { nodes: flow, audit, requestId: "req-27-inv", hmacKey: KEY });
    const timeline = (await httpJson(caseBackend.url, "GET", `/api/v1/cases/${caseId}/timeline`)).json as unknown as {
      id: number; kind: string; body: string; structured: unknown;
    }[];
    return { done, audit, timeline };
  }

  test("happy path：真实 adapter 出报告且 schema 合法、进 Timeline（structured 落库，degraded=false）", async () => {
    const { impl } = scriptedProxy({ decides: [TOOL_DECISION, FINISH_DECISION] });
    const { done, timeline } = await rig(impl);
    expect(done.status).toBe("completed");

    const reports = timeline.filter((t) => t.kind === "investigation_report");
    expect(reports).toHaveLength(1);
    expect(reports[0].structured).toMatchObject({
      summary: REPORT.summary,
      severity_assessment: 3,
      incomplete: false,
    });
    const structured = reports[0].structured as { findings: { source_tool: string }[] };
    expect(structured.findings[0].source_tool).toBe("siem_query");
  });

  test("report 阶段上游 429 限流 → 重试 1 次仍病 → 降级自由文本进 Timeline + report_degraded 审计（与 Fake 版一致）", async () => {
    const { impl } = scriptedProxy({
      decides: [TOOL_DECISION, FINISH_DECISION],
      report: () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 }),
    });
    const { done, audit, timeline } = await rig(impl);
    expect(done.status).toBe("completed"); // 降级不杀 run

    const reports = timeline.filter((t) => t.kind === "investigation_report");
    expect(reports).toHaveLength(1);
    expect(reports[0].structured).toBeNull(); // 降级 = 无 structured，只有自由文本
    expect(reports[0].body).toContain("report_degraded");
    expect(reports[0].body).toContain("llm_upstream:rate_limited");
    expect(audit.entries.filter((e) => e.action === "llm_retry")).toHaveLength(1);
    expect(audit.entries.some((e) => e.action === "report_degraded" && e.result === "FAILURE")).toBe(true);
  });

  test("plan 阶段上游病了 → fail-closed 强杀：run failed + error 事件（循环无降级路径，绝不硬编造）", async () => {
    const { impl } = scriptedProxy({ decides: [] });
    // 让所有调用（含 plan）一律 503
    const all503 = (async () => new Response(JSON.stringify({ error: "refuse" }), { status: 503 })) as unknown as typeof fetch;
    void impl;
    const { done, audit } = await rig(all503);
    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("node_error:plan");
    expect(audit.entries.filter((e) => e.action === "llm_retry")).toHaveLength(0); // plan 无重试契约
  });
});
