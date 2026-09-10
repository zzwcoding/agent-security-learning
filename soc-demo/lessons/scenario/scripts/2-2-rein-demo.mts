// 2.2 教学演示：注入式假 LLM 让调查子图的四道防线逐一生效（生产代码零改动）。
// 运行（在 soc-demo/ 下）：cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/2-2-rein-demo.mts
// 教学道具（2-2.md 亲手验证①）：只 import 生产代码并注入假 LLM/假 SIEM，不改生产任何一行。
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInvestigationFlow } from "../../../services/agent/workers/investigation/flow.js";
import type { InvestigationLlm } from "../../../services/agent/workers/investigation/llm.js";
import type { CaseView, ObsEntry } from "../../../services/agent/workers/investigation/prompt.js";
import { INVESTIGATION_TOOLS } from "../../../services/agent/workers/investigation/prompt.js";
import { MemoryKb } from "../../../services/agent/workers/triage/kb.js";
import { KEY, makeTaskTicket } from "../../../services/agent/workers/triage/testkit.js";
import { MemoryAuditSink } from "../../../services/agent/src/audit.js";

const W = { from: "2023-04-24T14:10:09Z", to: "2023-04-26T14:10:09Z" }; // 锚点 ±24h
const CASE: CaseView = {
  caseId: "case_demo", title: "[demo] db-01 rootkit", severity: 2, status: "New",
  entities: { ips: [], users: [], hosts: ["db-01"], files: [] },
  primaryAlertDate: 1682431809412,
};

function makeM2() {
  const timeline: { id: string; body: string }[] = [];
  return {
    m2: {
      getCaseDetail: async () => ({ id: CASE.caseId, title: CASE.title, severity: 2, status: "New", tags: [], linkedAlerts: ["a1"], startDate: Date.now(), observables: [{ dataType: "hostname", data: "db-01" }] }),
      getAlert: async () => ({ id: "a1", title: "rootkit", severity: 2, status: "in-progress", tags: [], date: CASE.primaryAlertDate }),
      listAlerts: async () => [],
      addTimelineEntry: async (_c: string, e: { body: string }) => { const id = `tl_${timeline.length + 1}`; timeline.push({ id, body: e.body }); return { id }; },
      addTaskLog: async () => ({ id: "log1" }),
    },
    timeline,
  };
}

function makeSiem(sizes: number[]) {
  let calls = 0;
  const counts: string[] = [];
  return {
    siem: { query: async (p: { entity: string }) => {
      const chars = sizes[calls] ?? 100; calls += 1;
      counts.push(`#${calls} entity=${p.entity} full_log=${chars}chars`);
      return { total: 1, hits: [{ id: "x", timestamp: "2023-04-25T14:10:09Z", rule_id: "510", rule_description: "rootkit", agent_name: p.entity, full_log: "A".repeat(chars) }] };
    } },
    counts,
  };
}

function scriptedLlm(script: (call: { observations: ObsEntry[] }) => any): InvestigationLlm {
  return {
    plan: async () => ({ tasks: ["demo 任务"], tokens: 32 }),
    decide: async (call) => { const d = script(call.input); return { ...d, tokens: 32 }; },
    summarize: async (c) => ({ summary: `【摘要】${c.text.slice(0, 50)}…(共 ${c.text.length} 字符)`, tokens: 16 }),
    report: async (call) => ({
      text: JSON.stringify({
        summary: `demo 报告（incomplete=${call.input.incomplete}，steps=${call.input.stepsUsed}）`,
        severity_assessment: 2, confidence: 0.8, findings: [], affected_assets: ["db-01"],
        recommended_actions: [], kb_refs: [], incomplete: call.input.incomplete || undefined,
      }), tokens: 32,
    }),
  };
}

async function runScenario(name: string, opts: {
  llm: InvestigationLlm; sizes: number[]; maxSteps?: number;
}) {
  const { m2, timeline } = makeM2();
  const { siem, counts } = makeSiem(opts.sizes);
  const audit = new MemoryAuditSink();
  const events: { type: string; payload: any }[] = [];
  const spillDir = mkdtempSync(join(tmpdir(), "rein22-"));
  const runId = `run_demo_${name}`;
  const nodes = makeInvestigationFlow({
    runId, requestId: "req_demo", caseId: CASE.caseId,
    ticket: makeTaskTicket(runId, [...INVESTIGATION_TOOLS], { sub: "agent:investigation", caseId: CASE.caseId }),
    hmacKey: KEY, m2: m2 as any, siem: siem as any, kb: new MemoryKb(),
    llm: opts.llm,
    scan: async () => ({ blocked: false, action: "flag", score: 0.9 }),
    audit, spillDir, ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
  });
  const ctx: any = {
    runId, state: {},
    emit: (type: string, payload: any) => events.push({ type, payload }),
    charge: () => {}, checkLlm: () => {},
    awaitApproval: () => { throw new Error("demo 不该走到审批"); },
    executeApproved: () => { throw new Error("demo 不该走到审批"); },
  };
  for (const n of nodes) await n.run(ctx);
  return { ctx, events, audit, spillDir, runId, counts, timeline };
}

const show = (label: string, v: unknown) => console.log(`  ${label}:`, JSON.stringify(v).slice(0, 220));

// ---------- S1 缰绳二：防打转 ----------
{
  console.log("\n═══ S1 防打转：第 2 步重复第 1 步的同参数 siem_query ═══");
  const call = { kind: "tool" as const, tool: "siem_query", params: { entity_type: "host", entity: "db-01", time_window: W } };
  const r = await runScenario("S1", { sizes: [100], llm: scriptedLlm(({ observations }) => observations.length === 0 ? call : observations.length === 1 ? call : { kind: "finish" }) });
  const obs = r.ctx.state.loop.observations as ObsEntry[];
  show("步骤记录", obs.map((o) => ({ step: o.step, tool: o.tool, ok: o.ok, error: o.error })));
  show("相关审计", r.audit.entries.filter((e: any) => e.action === "repeat_tool_call").map((e: any) => ({ action: e.action, result: e.result, details: e.details })));
  show("SIEM 实际执行次数", r.counts);
}

// ---------- S2 签名契约：三种违约参数 ----------
{
  console.log("\n═══ S2 签名契约：缺 time_window / 坏 entity_type / 时间窗倒挂 ═══");
  const r = await runScenario("S2", { sizes: [100], llm: scriptedLlm(({ observations }) => {
    const i = observations.length;
    if (i === 0) return { kind: "tool", tool: "related_alerts", params: { scope: "host", value: "db-01" } };
    if (i === 1) return { kind: "tool", tool: "siem_query", params: { entity_type: "domain", entity: "x", time_window: W } };
    if (i === 2) return { kind: "tool", tool: "siem_query", params: { entity_type: "host", entity: "db-01", time_window: { from: "2023-04-26T00:00:00Z", to: "2023-04-25T00:00:00Z" } } };
    return { kind: "finish" };
  }) });
  const obs = r.ctx.state.loop.observations as ObsEntry[];
  show("违约回执（error 喂回 LLM）", obs.map((o) => ({ step: o.step, tool: o.tool, ok: o.ok, error: o.error })));
  show("相关审计", r.audit.entries.filter((e: any) => e.action === "tool_signature_rejected").map((e: any) => ({ details: e.details })));
  show("SIEM 实际执行次数（必须为 0）", r.counts);
}

// ---------- S3 缰绳三：上下文治理（摘要 / spill）+ guards 打标 ----------
{
  console.log("\n═══ S3 上下文治理：12k 字符→LLM 摘要；58k 字符→落盘只留引用 ═══");
  const r = await runScenario("S3", { sizes: [12000, 58000], llm: scriptedLlm(({ observations }) => observations.length < 2 ? { kind: "tool", tool: "siem_query", params: { entity_type: "host", entity: observations.length === 0 ? "db-01" : "app-01", time_window: W } } : { kind: "finish" }) });
  const obs = r.ctx.state.loop.observations as ObsEntry[];
  show("观察形态", obs.map((o) => ({ step: o.step, flagged: o.flagged, payload: o.payload })));
  show("相关审计", r.audit.entries.filter((e: any) => ["tool_output_flagged", "context_summarize", "context_spill"].includes(e.action)).map((e: any) => ({ action: e.action, details: e.details })));
  const ref = (obs[1].payload as any).hits_ref as string;
  const file = join(r.spillDir, ref.replace("spill/", ""));
  const st = statSync(file);
  show("落盘文件", { path: ref, bytes: st.size, 头40字符: readFileSync(file, "utf8").slice(0, 40) });
}

// ---------- S4 缰绳一：max_steps 截断 ----------
{
  console.log("\n═══ S4 缰绳一：max_steps=2，LLM 想查 4 次被硬截断 ═══");
  const entities = ["db-01", "app-01", "web-01", "centos7"];
  const r = await runScenario("S4", { sizes: [100], maxSteps: 2, llm: scriptedLlm(({ observations }) => ({ kind: "tool", tool: "siem_query", params: { entity_type: "host", entity: entities[observations.length], time_window: W } })) });
  show("循环账本", { ...r.ctx.state.loop, observations: `（${(r.ctx.state.loop.observations as ObsEntry[]).length} 条省略）` });
  show("截断审计", r.audit.entries.filter((e: any) => e.action === "investigation_truncated").map((e: any) => ({ details: e.details })));
  show("报告 outcome（incomplete 必须为 true）", r.ctx.state.outcome);
  show("报告正文截选", (r.timeline[0]?.body ?? "").slice(0, 160).replace(/\n/g, " ⏎ "));
  show("SIEM 实际执行次数", r.counts);
}
console.log("\n全部四场景跑完。");
