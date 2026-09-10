// 2.3 教学演示：注入「说谎的报告 LLM」，看 findings 证据约束与降级路径生效。
// 运行（在 soc-demo/ 下）：cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/2-3-report-demo.mts
// 教学道具：只 import 生产代码并注入假 LLM/假 SIEM，不改生产任何一行。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInvestigationFlow } from "../../../services/agent/workers/investigation/flow.js";
import type { InvestigationLlm } from "../../../services/agent/workers/investigation/llm.js";
import type { CaseView, ObsEntry, ReportCall } from "../../../services/agent/workers/investigation/prompt.js";
import { INVESTIGATION_TOOLS } from "../../../services/agent/workers/investigation/prompt.js";
import { MemoryKb } from "../../../services/agent/workers/triage/kb.js";
import { KEY, makeTaskTicket } from "../../../services/agent/workers/triage/testkit.js";
import { MemoryAuditSink } from "../../../services/agent/src/audit.js";

const W = { from: "2023-04-24T14:10:09Z", to: "2023-04-26T14:10:09Z" };
const CASE: CaseView = {
  caseId: "case_demo", title: "[demo] db-01 rootkit", severity: 2, status: "New",
  entities: { ips: [], users: [], hosts: ["db-01"], files: [] },
  primaryAlertDate: 1682431809412,
};

/** 循环里真实执行过的工具会进 executed；报告校验拿它对 findings 的 source_tool。 */
function baseLlm(): InvestigationLlm {
  return {
    plan: async () => ({ tasks: ["查 siem"], tokens: 32 }),
    decide: async (call) => call.input.observations.length === 0
      ? { kind: "tool", tool: "siem_query", params: { entity_type: "host", entity: "db-01", time_window: W }, tokens: 32 }
      : { kind: "finish", tokens: 32 },
    summarize: async (c) => ({ summary: `摘要(${c.text.length}字符)`, tokens: 16 }),
    report: async (call) => {
      attempts.push(call.input);
      return { text: "", tokens: 32 }; // text 由场景脚本覆盖
    },
  };
}

async function run(name: string, reportFn: (attempt: number, input: ReportCall["input"]) => string) {
  const timeline: { id: string; body: string }[] = [];
  const m2 = {
    getCaseDetail: async () => ({ id: CASE.caseId, title: CASE.title, severity: 2, status: "New", tags: [], linkedAlerts: ["a1"], startDate: Date.now(), observables: [{ dataType: "hostname", data: "db-01" }] }),
    getAlert: async () => ({ id: "a1", title: "rootkit", severity: 2, status: "in-progress", tags: [], date: CASE.primaryAlertDate }),
    listAlerts: async () => [],
    addTimelineEntry: async (_c: string, e: { body: string }) => { const id = `tl_${timeline.length + 1}`; timeline.push({ id, body: e.body }); return { id }; },
    addTaskLog: async () => ({ id: "log1" }),
  };
  const siem = { query: async () => ({ total: 1, hits: [{ id: "x", timestamp: "2023-04-25T14:10:09Z", rule_id: "510", rule_description: "rootkit", agent_name: "db-01", full_log: "Rootkit t0rn detected" }] }) };
  const audit = new MemoryAuditSink();
  const events: { type: string; payload: any }[] = [];
  const attempts: ReportCall["input"][] = [];
  const llm = baseLlm();
  llm.report = async (call) => ({ text: reportFn(attempts.push(call.input), call.input), tokens: 32 });
  const spillDir = mkdtempSync(join(tmpdir(), "rein23-"));
  const runId = `run_demo_${name}`;
  const nodes = makeInvestigationFlow({
    runId, requestId: "req_demo", caseId: CASE.caseId,
    ticket: makeTaskTicket(runId, [...INVESTIGATION_TOOLS], { sub: "agent:investigation", caseId: CASE.caseId }),
    hmacKey: KEY, m2: m2 as any, siem: siem as any, kb: new MemoryKb(),
    llm, scan: async () => ({ blocked: false, action: "allow", score: 0 }),
    audit, spillDir,
  });
  const ctx: any = { runId, state: {}, emit: (t: string, p: any) => events.push({ type: t, payload: p }), charge: () => {}, checkLlm: () => {}, awaitApproval: () => { throw new Error("x"); }, executeApproved: () => { throw new Error("x"); } };
  for (const n of nodes) await n.run(ctx);
  return { ctx, audit, timeline };
}

const show = (label: string, v: unknown) => console.log(`  ${label}:`, JSON.stringify(v).slice(0, 260));

// ---------- S1 报告两次都撒谎：source_tool 没执行过 → 重试 1 次 → 降级自由文本 ----------
{
  console.log("\n═══ S1 findings 引用未执行的工具(web_search)，两次都谎 → report_degraded ═══");
  const lie = (input: ReportCall["input"]) => JSON.stringify({
    summary: "凭空捏造：我上网搜过了，主机很危险",
    severity_assessment: 4, confidence: 0.99,
    findings: [{ entity: "db-01", evidence: "（网上说的）", source_tool: "web_search" }],
    affected_assets: ["db-01"],
    recommended_actions: [{ tool: "isolate_host", params: { host: "db-01" }, justification: "上网查的" }],
    kb_refs: [],
  });
  const r = await run("S1", lie);
  const outcome = r.ctx.state.outcome;
  const report = r.ctx.state.report;
  show("报告 outcome（degraded 必须为 true）", outcome);
  show("降级审计", r.audit.entries.filter((e: any) => ["llm_retry", "report_degraded"].includes(e.action)).map((e: any) => ({ action: e.action, details: e.details })));
  show("时间线落了什么（前 120 字符）", r.timeline[0]?.body.slice(0, 120));
  show("structured 是否为 null（机读真相缺席）", report.structured);
}

// ---------- S2 第一次撒谎、重试改口 → 结构化报告正常落库（重试不是降级） ----------
{
  console.log("\n═══ S2 第一次谎 web_search，重试改口 siem_query → 重试后通过 ═══");
  const r = await run("S2", (attempt, input) => {
    if (attempt === 1) {
      return JSON.stringify({
        summary: "撒谎版：引用没执行过的工具", severity_assessment: 2, confidence: 0.8,
        findings: [{ entity: "db-01", evidence: "编的", source_tool: "web_search" }],
        affected_assets: ["db-01"], recommended_actions: [], kb_refs: [],
      });
    }
    return JSON.stringify({
      summary: "诚实版：证据全部来自已执行工具", severity_assessment: 2, confidence: 0.8,
      findings: [{ entity: "db-01", evidence: "Rootkit t0rn detected", source_tool: "siem_query" }],
      affected_assets: ["db-01"], recommended_actions: [], kb_refs: [],
      ...(input.incomplete ? { incomplete: true } : {}),
    });
  });
  const report = r.ctx.state.report;
  show("报告 outcome（degraded 必须 false）", r.ctx.state.outcome);
  show("重试审计", r.audit.entries.filter((e: any) => e.action === "llm_retry").map((e: any) => ({ details: e.details })));
  show("findings（evidence=真实工具输出）", report.structured ? (report.structured as any).findings : null);
  show("时间线正文截选", (r.timeline[0]?.body ?? "").slice(0, 90).replace(/\n/g, " ⏎ "));
}
console.log("\n两场景跑完。");
