// m11 eval 体系 · 快道 runner（票 19 验收③，m11 卡公开接口的单测级注入半边）。
//
// 决策 #10 的快道口径：不拉 compose，对 agent 做单测级注入——真 case-backend（内存库 +
// 随机端口，状态机/审计语义全在环内）+ 生产 HttpTriageM2 + guards 通道策略假件 +
// **FakeTriageLlm（被测对象，确定性）**。一条用例跑完 = 一包证据（CaseEvidence），
// 交给确定性断言器判门槛、交给 judge（可选）判要点分。
//
// 取证与判分分离：本模块只负责把 run 跑完并把两路审计、事件流、终值收集成证据；
// 好坏全部由 assertions.ts 的确定性检查下结论——runner 自己不下任何一个 pass/fail。
import { openDb } from "../../services/agent/src/db.js";
import { createRun } from "../../services/agent/src/runs.js";
import { executeRun } from "../../services/agent/src/graph.js";
import { MemoryAuditSink } from "../../services/agent/src/audit.js";
import { eventsAfter } from "../../services/agent/src/events.js";
import { makeTriageFlow } from "../../services/agent/workers/triage/flow.js";
import { MemoryKb } from "../../services/agent/workers/triage/kb.js";
import { FakeTriageLlm } from "../../services/agent/workers/triage/llm.js";
import { HttpTriageM2 } from "../../services/agent/workers/triage/m2.js";
import { TRIAGE_TOOLS } from "../../services/agent/workers/triage/prompt.js";
import {
  fakeScan,
  httpJson,
  KEY,
  makeTaskTicket,
  seedAlert,
  startCaseBackend,
} from "../../services/agent/workers/triage/testkit.js";
import { runChecks } from "./assertions.js";
import type { Judge } from "./judge.js";
import type { CaseEvidence, CaseResult, EvalCase, M2AuditRow } from "./types.js";

const REQUEST_ID = "req-eval";

/** 把执行记录渲染成 judge 的评分对象（人可读的纯文本，FR-M11.2 的评分对象）。 */
export function renderTranscript(ev: CaseEvidence): string {
  return [
    `case: ${ev.fullName}`,
    `run: ${ev.runId} 终态=${ev.status}`,
    `alert: ${JSON.stringify(ev.verdictAi)}`,
    `M2 终值 verdict: ${ev.verdict ?? "null"}`,
    `工具调用序列: ${ev.toolCalls.join(" → ")}`,
    `审批卡: ${ev.approvals.length === 0 ? "无" : ev.approvals.join(", ")}`,
    `guards DENIED 次数: ${ev.guardsDenied}`,
    `tokens: ${ev.tokensUsed}，耗时: ${ev.durationMs}ms`,
  ].join("\n");
}

/** 单测级注入跑一条分诊用例，收集证据。真 case-backend 用完即关，用例之间零串台。 */
export async function executeTriage(c: EvalCase): Promise<CaseEvidence> {
  if (c.alertFixturePath === null) {
    throw new Error(`${c.fullName}：快道只支持 alert_fixture 用例（对话流是票 22 的全栈慢道）`);
  }
  const backend = await startCaseBackend();
  try {
    const agentDb = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const alertId = await seedAlert(backend.url, c.alertFixturePath);
    const run = createRun(agentDb, { kind: "alert_flow", alertId }, { audit, requestId: REQUEST_ID });
    const flow = makeTriageFlow({
      runId: run.id,
      requestId: REQUEST_ID,
      ticket: makeTaskTicket(run.id, [...TRIAGE_TOOLS]),
      hmacKey: KEY,
      m2: new HttpTriageM2(backend.url),
      kb: new MemoryKb(),
      llm: new FakeTriageLlm(), // 被测对象（确定性）；judge 与它分离（决策 #7）
      scan: fakeScan,
      audit,
    });
    const t0 = Date.now();
    const done = await executeRun(agentDb, run.id, {
      nodes: flow, audit, requestId: REQUEST_ID, hmacKey: KEY,
    });
    const durationMs = Date.now() - t0;

    const alert = await httpJson(backend.url, "GET", `/api/v1/alerts/${alertId}`);
    const events = eventsAfter(agentDb, run.id, 0);
    const auditRes = await httpJson(backend.url, "GET", `/api/v1/audit?objectId=${alertId}`);
    const auditM2 = auditRes.json as unknown as M2AuditRow[];

    const toolCallsRaw = events.filter((e) => e.type === "tool_call").map((e) => String(e.payload.tool));
    const toolCalls = [...new Set(toolCallsRaw)];
    const verdictAi = alert.json.verdictAi as Record<string, unknown> | undefined;
    const evidence: CaseEvidence = {
      fullName: c.fullName,
      runId: run.id,
      status: done.status,
      verdict: (alert.json.verdict as string | null) ?? null,
      verdictAi: verdictAi ?? null,
      toolCalls,
      toolCallCount: toolCallsRaw.length,
      approvals: events.filter((e) => e.type === "approval_required").map((e) => String(e.payload.tool)),
      tokensUsed: done.tokensUsed,
      guardsDenied: audit.entries.filter((e) => e.action === "guards_block" && e.result === "DENIED").length,
      caseId: auditM2.find((a) => a.action === "create" && a.objectType === "case")?.objectId ?? null,
      auditWorker: audit.entries,
      auditM2,
      durationMs,
      transcript: "",
    };
    evidence.transcript = renderTranscript(evidence);
    return evidence;
  } finally {
    await backend.close();
  }
}

/** 快道跑一条用例 → 全部结论。judge 可为 null（不可用），分数照样不进门禁（决策 #7）。 */
export async function runCase(c: EvalCase, judge: Judge | null): Promise<CaseResult> {
  const base = {
    fullName: c.fullName,
    domain: c.domain,
    tags: c.spec.tags,
    toolCalls: 0,
    tokens: 0,
    durationMs: 0,
  };

  // never_mock = 必须打真 LLM/真栈，是票 22 全栈慢道的用例——快道显式跳过并留痕，
  // 既不假装通过也不误报失败（FR-M11.6 mock 政策三档的车道归属）。
  if (c.spec.mock_policy === "never_mock") {
    return {
      ...base, ran: false, passed: false,
      skippedReason: "mock_policy=never_mock：快道（单测级注入）跑不了真 LLM 用例，归票 22 全栈慢道",
      verdict: { expected: c.spec.expected_verdict, got: null, ok: false },
      checks: [], judge: null,
    };
  }
  if (c.alertFixturePath === null) {
    return {
      ...base, ran: false, passed: false,
      skippedReason: "非 alert_fixture 用例：对话流（user_prompt）归票 22",
      verdict: { expected: c.spec.expected_verdict, got: null, ok: false },
      checks: [], judge: null,
    };
  }

  // mock_policy=inherit 在快道解析为 always_mock（FR-M11.6：演示/快道一律 mock）
  const ev = await executeTriage(c);
  const checks = runChecks(ev, c.spec);
  const j = judge === null ? null : await judge.judge({
    expectedOutput: c.spec.expected_output,
    transcript: ev.transcript,
  });
  return {
    fullName: c.fullName,
    domain: c.domain,
    tags: c.spec.tags,
    ran: true,
    passed: checks.every((x) => x.ok),
    verdict: { expected: c.spec.expected_verdict, got: ev.verdict, ok: checks.find((x) => x.name === "expected_verdict")!.ok },
    checks,
    judge: j,
    toolCalls: ev.toolCallCount,
    tokens: ev.tokensUsed,
    durationMs: ev.durationMs,
  };
}
