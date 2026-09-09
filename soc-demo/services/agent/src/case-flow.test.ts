import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { eventsAfter, type RunEvent } from "./events.js";
import type { MintClient, TaskTicketRequest } from "./token-ports.js";
import {
  fakeScan,
  httpJson,
  KEY,
  seedAlert,
  sealTicket,
  startCaseBackend,
  type CaseBackend,
} from "../workers/triage/testkit.js";
import { CASE_FLOW_NODES, makeCaseFlow } from "../workers/case-flow.js";
import { makeTriageFlow } from "../workers/triage/flow.js";
import { HttpTriageM2 } from "../workers/triage/m2.js";
import { MemoryKb } from "../workers/triage/kb.js";
import { FakeTriageLlm } from "../workers/triage/llm.js";
import { makeInvestigationFlow } from "../workers/investigation/flow.js";
import { HttpInvestigationM2 } from "../workers/investigation/m2.js";
import { FixtureSiem } from "../workers/investigation/siem.js";
import { FakeInvestigationLlm } from "../workers/investigation/llm.js";
import { makeEnrichmentFlow } from "../workers/enrichment/flow.js";
import { HttpEnrichmentM2 } from "../workers/enrichment/m2.js";
import { FixtureAnalyzerTable } from "../workers/enrichment/analyzers.js";
import { ENRICHMENT_TOOLS } from "../workers/enrichment/tools.js";
import { INVESTIGATION_TOOLS } from "../workers/investigation/prompt.js";

// 票 36 验收主战场（B4 清偿）：investigation/enrichment 子图（票 14/15）此前只有
// evals 直构一个入口，PRD §4.2 消息旅程步骤 7-8 在生产上不可达。本票两路接线：
//   ① case_flow 进 RUN_KINDS——POST /internal/runs {kind:"case_flow", case_id} 直拉
//     「调查 → 富化」链（对齐 knowledge_flow/chat_flow 的 case 入口先例）；
//   ② alert_flow 的 TP 建案分支后【同一 run 内】链上同一条链——不是新 run（那是
//     票 40 事件驱动拉起的语义，本票不抢）。链序按 PRD §4.2 步骤 7-8 与 §4.4
//     路由规则：调查在前、富化在后（票面文字 enrich→investigate 与卡面冲突，按卡面）。
// 布景 = vt-87105 恶意文件告警：FakeTriageLlm 判 TP 建案（hash observable 进案），
// 调查出报告、富化查 VT 情报表得 malicious——一条命令能复现六幕剧本的第一幕全程。

const FIXTURES = fileURLToPath(new URL("../../../fixtures/alerts/", import.meta.url));
const TI = fileURLToPath(new URL("../../../fixtures/ti/", import.meta.url));

/** 测试铸票（KEY 同闸共享）：buildApp 按票面规格调 mint，这里签出真 wire 票。 */
function fakeMint(): MintClient {
  return {
    async mintTaskTicket(req: TaskTicketRequest) {
      const iat = Math.floor(Date.now() / 1000) - 10;
      const payload = {
        jti: req.jti,
        sub: req.sub,
        case_id: req.caseId ?? "",
        run_id: req.runId,
        scope: req.scope,
        allowed_tools: req.allowedTools,
        iat,
        exp: iat + 900,
      };
      return { token: sealTicket(payload), payload };
    },
    async mintApprovalToken() {
      throw new Error("mintApprovalToken not expected in this test");
    },
  };
}

interface Rig {
  cb: CaseBackend;
  db: DB;
  app: Awaited<ReturnType<typeof buildApp>>;
  audit: MemoryAuditSink;
}

async function rig(): Promise<Rig> {
  const cb = await startCaseBackend();
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const siem = new FixtureSiem(FIXTURES);
  const analyzers = new FixtureAnalyzerTable(TI);
  const kb = new MemoryKb();

  // 调查 → 富化 的组链（case_id 由交接态在运行时解析，见 workers/case-flow.ts）
  const caseChain = (run: { id: string }, ticket: string) =>
    makeCaseFlow({
      invest: {
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        hmacKey: KEY,
        m2: new HttpInvestigationM2(cb.url),
        siem,
        kb,
        llm: new FakeInvestigationLlm(),
        scan: fakeScan,
        audit,
      },
      enrich: {
        runId: run.id,
        requestId: `launch_${run.id}`,
        ticket,
        hmacKey: KEY,
        m2: new HttpEnrichmentM2(cb.url),
        analyzers,
        scan: fakeScan,
        audit,
      },
    });

  const app = buildApp({
    db,
    audit,
    mint: fakeMint(),
    hmacKey: KEY,
    makeNodes: (run, ticket) =>
      run.kind === "case_flow"
        ? caseChain(run, ticket)
        : [
            ...makeTriageFlow({
              runId: run.id,
              requestId: `launch_${run.id}`,
              ticket,
              hmacKey: KEY,
              m2: new HttpTriageM2(cb.url),
              kb,
              llm: new FakeTriageLlm(),
              scan: fakeScan,
              audit,
            }),
            ...caseChain(run, ticket),
          ],
  });
  return { cb, db, app, audit };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  // 先关 HTTP app 再杀 case-backend 子进程（注册序的逆序）
  while (closers.length) await closers.pop()?.();
});
async function track(r: Rig): Promise<Rig> {
  closers.push(async () => {
    await r.app.close();
    await r.cb.close();
  });
  return r;
}

async function seedCase(cb: CaseBackend, fixture: string): Promise<{ alertId: string; caseId: string }> {
  const alertId = await seedAlert(cb.url, join(FIXTURES, fixture));
  const { status, json } = await httpJson(cb.url, "POST", `/api/v1/alerts/${alertId}/create-case`, {});
  if (status >= 300) throw new Error(`create-case failed: ${status} ${JSON.stringify(json)}`);
  return { alertId, caseId: String((json as { case: { id: string } }).case.id) };
}

const runRow = (db: DB, runId: string) =>
  db.prepare("SELECT status, kind, alert_id, case_id FROM runs WHERE id = ?").get(runId) as {
    status: string;
    kind: string;
    alert_id: string | null;
    case_id: string | null;
  };

const events = (db: DB, runId: string): RunEvent[] => eventsAfter(db, runId, 0);

const nodeEnters = (evs: RunEvent[]): string[] =>
  evs.filter((e) => e.type === "node_enter").map((e) => String(e.payload.node));

const toolCalls = (evs: RunEvent[]): string[] =>
  evs.filter((e) => e.type === "tool_call").map((e) => String(e.payload.tool));

const timeline = async (cb: CaseBackend, caseId: string): Promise<{ id: string; kind: string; author: string; body: string; structured: unknown }[]> =>
  (await httpJson(cb.url, "GET", `/api/v1/cases/${caseId}/timeline`)).json as never;

const caseList = async (cb: CaseBackend): Promise<{ id: string }[]> =>
  (await httpJson(cb.url, "GET", "/api/v1/cases")).json as never;

describe("case_flow 直拉（RUN_KINDS 放行，验收 1 的入口半边）", () => {
  test("POST /internal/runs {kind:case_flow, case_id} → 202，调查+富化两报告进 timeline，run 跑完", async () => {
    const r = await track(await rig());
    const { caseId } = await seedCase(r.cb, "vt-87105-malware.json");

    const res = await r.app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "case_flow", case_id: caseId },
    });
    expect(res.statusCode).toBe(202);
    const runId = res.json().run_id as string;
    // alert_id 列 NOT NULL（runs.ts 票 17 注）：无告警上下文的 run 存空串——与
    // knowledge_flow/chat_flow 同一惯例，case_flow 不另造第三种口径
    expect(runRow(r.db, runId)).toEqual({ status: "completed", kind: "case_flow", alert_id: "", case_id: caseId });

    // 链序 = PRD §4.2 步骤 7-8：调查在前、富化在后
    expect(nodeEnters(events(r.db, runId))).toEqual(["investigate_case", "enrich_case"]);

    const tl = await timeline(r.cb, caseId);
    expect(tl.some((e) => e.kind === "investigation_report" && e.author === "agent:investigation")).toBe(true);
    expect(tl.some((e) => e.kind === "enrichment_report" && e.author === "agent:enrichment")).toBe(true);

    // 两个 worker 的内部子图节点经 tool_call 帧可见（siem_query=调查面，vt_lookup=富化面）
    const tools = toolCalls(events(r.db, runId));
    expect(tools).toContain("siem_query");
    expect(tools).toContain("vt_lookup");
  });

  test("kind 在册但缺 case_id → 400 case_id_required（CASE_KINDS 口径）", async () => {
    const r = await track(await rig());
    const res = await r.app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "case_flow" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("case_id_required");
  });
});

describe("alert_flow TP 建案后同 run 链上调查+富化（验收 1，B4/遗留 15-4/27-2）", () => {
  test("vt-87105 → TP 建案 → 调查报告 + 富化报告，全链一个生产 run 可达", async () => {
    const r = await track(await rig());
    const alertId = await seedAlert(r.cb.url, join(FIXTURES, "vt-87105-malware.json"));

    const res = await r.app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "alert_flow", alert_id: alertId },
    });
    expect(res.statusCode).toBe(202);
    const runId = res.json().run_id as string;

    // run 本尊仍是 alert_flow（同 run 链上，不是新 run——票 40 的事件驱动拉起另算）
    expect(runRow(r.db, runId)).toMatchObject({ status: "completed", kind: "alert_flow", alert_id: alertId });

    // TP → 建案（FakeTriageLlm R2 判 tp，无活跃同主机案 → create_case）
    const cases = await caseList(r.cb);
    expect(cases).toHaveLength(1);
    const caseId = cases[0].id;

    const tl = await timeline(r.cb, caseId);
    const investigate = tl.find((e) => e.kind === "investigation_report");
    const enrich = tl.find((e) => e.kind === "enrichment_report");
    expect(investigate).toBeDefined();
    expect(enrich).toBeDefined();

    // 节点轨迹：分诊六节点之后接链上两节点，顺序 investigate → enrich
    const nodes = nodeEnters(events(r.db, runId));
    expect(nodes.slice(0, 6)).toEqual(["load_alert", "kb_check", "merge_check", "self_audit_checkpoint", "verdict_llm", "outcome"]);
    expect(nodes.slice(6)).toEqual(["investigate_case", "enrich_case"]);

    // 调查真干了 pivot、富化真查了 VT 情报表（malicious 命中在报告里）
    const tools = toolCalls(events(r.db, runId));
    expect(tools).toContain("siem_query");
    expect(tools).toContain("vt_lookup");
    expect(JSON.stringify(enrich)).toContain("malicious");

    // 建案分支才链：state.case_id 由 outcome 的 create_case 写入——run 行的 case_id
    // 是拉起时的交接态（alert_flow 拉起时为 null），链上读的是运行态。
    // 建案的 create 审计落在 M2 audit_entries（INV-8 的 M2 半边），agent 侧 sink 只有
    // worker 自记条目——查 M2 审计查询面，别查错门。
    const m2Audit = (await httpJson(r.cb.url, "GET", `/api/v1/audit?objectId=${caseId}`)).json as unknown as {
      action: string;
      objectType: string;
    }[];
    expect(m2Audit.some((e) => e.action === "create" && e.objectType === "case")).toBe(true);
  });

  test("FP 告警不建案，链上节点空转跳过（不出调查/富化报告，run 照常完成）", async () => {
    const r = await track(await rig());
    const alertId = await seedAlert(r.cb.url, join(FIXTURES, "web-31103-cgi-500.json"));

    const res = await r.app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "alert_flow", alert_id: alertId },
    });
    expect(res.statusCode).toBe(202);
    const runId = res.json().run_id as string;
    expect(runRow(r.db, runId)).toMatchObject({ status: "completed", kind: "alert_flow" });

    expect(await caseList(r.cb)).toHaveLength(0);
    // 链上节点照走（supervisor 的路由决策点可见），但没建案就没调查/富化
    expect(nodeEnters(events(r.db, runId))).toEqual([
      "load_alert", "kb_check", "merge_check", "self_audit_checkpoint", "verdict_llm", "outcome",
      "investigate_case", "enrich_case",
    ]);
    expect(toolCalls(events(r.db, runId))).not.toContain("siem_query");
    expect(toolCalls(events(r.db, runId))).not.toContain("vt_lookup");
  });
});

describe("节点名单两端契约（FR-M10.2，票 31 先例）", () => {
  test("CASE_FLOW_NODES ≡ fixtures/sse-events.json flow_nodes.case_flow（web 消费侧闸在 pipeline.test.ts）", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../fixtures/sse-events.json", import.meta.url), "utf8"),
    ) as { flow_nodes: Record<string, string[]> };
    expect([...CASE_FLOW_NODES]).toEqual(fixture.flow_nodes.case_flow);
  });

  test("票面规格：case_flow 任务票 = 两 worker 工具面并集，仍无任何 L2（INV-3）", () => {
    const union = [...new Set([...INVESTIGATION_TOOLS, ...ENRICHMENT_TOOLS])];
    expect(union).not.toContain("isolate_host");
    expect(union).toContain("add_task_log");
    expect(union).toContain("add_observable");
  });
});
