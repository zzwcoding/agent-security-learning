import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb, type DB } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { executeRun } from "../../src/graph.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { eventsAfter, type RunEvent } from "../../src/events.js";
import { httpJson, KEY, makeTaskTicket, seedAlert, startCaseBackend, fakeScan, type CaseBackend } from "../triage/testkit.js";
import { makeEnrichmentFlow } from "./flow.js";
import { ENRICHMENT_TOOLS } from "./tools.js";
import { FixtureAnalyzerTable, type AnalyzerBackend, type AnalyzerCall, type AnalyzerName } from "./analyzers.js";
import { HttpEnrichmentM2 } from "./m2.js";

// 票 15 验收主战场：富化子图打在真 case-backend（observables/timeline/审计语义在环内）
// + 生产 HttpEnrichmentM2 adapter + FixtureAnalyzerTable（fixtures/ti 情报表 mock analyzer）
// 的 seam 组合上。布景：
//   enrich/01_vt_malicious_hash —— vt-87105 真实告警 → 建案 → hash 富化 → malicious
//   enrich/02_tlp_red_blocked  —— tlp=4 observable 查询被拒 + DENIED 审计
// （evals/ 具名 fixture 属 m11；按票 13/14 先例用既有 fixture + 种子复现同一布景。）

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/alerts/", import.meta.url));
const TI = fileURLToPath(new URL("../../../../fixtures/ti/", import.meta.url));

const EICAR_SHA256 = "c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a";

interface Probe {
  lookups: { analyzer: AnalyzerName; call: AnalyzerCall }[];
}

/** 情报表外面包一层探针：谁真被打到（「TLP:RED 不外发」的断言就压在这里）。 */
function probeTi(base: FixtureAnalyzerTable, probe: Probe): AnalyzerBackend {
  return {
    lookup: async (analyzer, call) => {
      probe.lookups.push({ analyzer, call });
      return base.lookup(analyzer, call);
    },
  };
}

async function rig(over: { ti?: AnalyzerBackend; ticketTools?: string[] } = {}) {
  const caseBackend: CaseBackend = await startCaseBackend();
  const db: DB = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const m2 = new HttpEnrichmentM2(caseBackend.url);
  const probe: Probe = { lookups: [] };
  const ti = over.ti ?? probeTi(new FixtureAnalyzerTable(TI), probe);

  const runCase = async (caseId: string) => {
    const run = createRun(db, { kind: "case_flow", alertId: "" }, { audit, requestId: "req-enrich" });
    const flow = makeEnrichmentFlow({
      runId: run.id,
      requestId: "req-enrich",
      caseId,
      ticket: makeTaskTicket(run.id, over.ticketTools ?? [...ENRICHMENT_TOOLS], { sub: "agent:enrichment" }),
      hmacKey: KEY,
      m2,
      analyzers: ti,
      scan: fakeScan,
      audit,
    });
    const done = await executeRun(db, run.id, { nodes: flow, audit, requestId: "req-enrich", hmacKey: KEY });
    const events: RunEvent[] = eventsAfter(db, run.id, 0);
    return { done, runId: run.id, events };
  };

  /** 布景：fixture 告警种子进 M2 → 直拉建案（分诊 outcome 的 TP 动词，票 13 已验）。 */
  const seedCaseFromFixture = async (fixture: string) => {
    const alertId = await seedAlert(caseBackend.url, join(FIXTURES, fixture));
    const { status, json } = await httpJson(caseBackend.url, "POST", `/api/v1/alerts/${alertId}/create-case`, {});
    if (status >= 300) throw new Error(`create-case failed: ${status} ${JSON.stringify(json)}`);
    return { alertId, caseId: String((json as { case: { id: string } }).case.id) };
  };

  /** eval 布景专用：往案件里种一条自定义 tlp/pap 的 observable（TLP:RED 情报从
   *  合作方 feed 来；现行 m1 映射/REST 都只产 tlp=2，出入记票 15）。 */
  const seedObservable = (caseId: string, o: { dataType: string; data: string; tlp: number; pap?: number }) => {
    caseBackend.db
      .prepare(
        "INSERT INTO observables (id, case_id, data_type, data, tlp, pap, ioc, tags) VALUES (?, ?, ?, ?, ?, ?, 1, '[]')",
      )
      .run(randomUUID(), caseId, o.dataType, o.data, o.tlp, o.pap ?? 2);
  };

  return {
    caseBackend, db, audit, probe, runCase, seedCaseFromFixture, seedObservable,
    caseObservables: async (caseId: string) =>
      (await httpJson(caseBackend.url, "GET", `/api/v1/cases/${caseId}`)).json as unknown as {
        observables: { dataType: string; data: string; tlp: number; pap: number; tags: string[]; message: string | null }[];
      },
    timeline: async (caseId: string) =>
      (await httpJson(caseBackend.url, "GET", `/api/v1/cases/${caseId}/timeline`)).json as unknown as {
        id: string; kind: string; author: string; body: string; structured: unknown;
      }[],
  };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function track<T extends { caseBackend: CaseBackend }>(rigged: T): Promise<T> {
  closers.push(() => rigged.caseBackend.close());
  return rigged;
}

const structuredOf = (entry: { structured: unknown } | undefined) => entry?.structured as {
  summary: string;
  results: { analyzer: string; data: string; dataType: string; ok: boolean; level?: string; refused?: string; flagged?: boolean }[];
  artifacts_written: { dataType: string; data: string; dedup: boolean }[];
  refused_count: number;
};

describe("enrich/01_vt_malicious_hash：taxonomy 正确 + 富化报告进 timeline（验收 1）", () => {
  test("vt-87105 的 sha256 查 VT 情报 → malicious，artifacts 回写，四档进报告", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("vt-87105-malware.json");

    const { done, events } = await r.runCase(caseId);
    expect(done.status).toBe("completed");

    // 富化报告进 timeline（kind=enrichment_report，author=agent:enrichment）
    const tl = await r.timeline(caseId);
    const report = tl.find((e) => e.kind === "enrichment_report");
    expect(report).toBeDefined();
    expect(report?.author).toBe("agent:enrichment");

    // taxonomy 正确（m6 卡测试计划）：VT reputation 5/70 → level=malicious
    const structured = structuredOf(report);
    const hashHit = structured.results.find((x) => x.dataType === "hash");
    expect(hashHit).toMatchObject({
      analyzer: "vt_lookup",
      data: EICAR_SHA256,
      ok: true,
      level: "malicious",
    });
    expect(structured.summary).toContain("malicious");
    expect(report?.body).toContain("[malicious]");
    expect(report?.body).toContain(EICAR_SHA256);

    // FR-M6.3：analyzer 提取的 artifacts 真回写了案件（M2 observables 多一条 filename）
    const detail = await r.caseObservables(caseId);
    expect(detail.observables.some((o) => o.dataType === "filename" && o.data === "invoice_apr.zip")).toBe(true);

    // 工具轨迹：vt_lookup → add_observable → add_timeline_entry（全程过闸）
    const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => e.payload.tool);
    expect(toolCalls).toEqual(["vt_lookup", "add_observable", "add_timeline_entry"]);
    expect(r.audit.entries.some((e) => e.result === "DENIED")).toBe(false);
  });
});

describe("enrich/02_tlp_red_blocked：超限必拒 + DENIED 审计（验收 2/3）", () => {
  test("tlp=4 observable：TLP 闸门拒 → analyzer 一个字节都没收到（不外发）+ DENIED 审计", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("vt-87105-malware.json");
    r.seedObservable(caseId, { dataType: "ip", data: "203.0.113.66", tlp: 4 });

    const { done } = await r.runCase(caseId);
    expect(done.status).toBe("completed"); // 拒绝是工具级结果，不是 run 处决（fail-closed ≠ 摊牌）

    // 不外发：情报表 adapter 从没收到 203.0.113.66（hash 照查，说明只是超限项被拦）
    expect(r.probe.lookups.map((l) => l.call.data)).toEqual([EICAR_SHA256]);

    // DENIED 审计（m6 卡测试计划）：tlp_pap_denied，逐字 errorMessage
    const deny = r.audit.entries.find((e) => e.result === "DENIED");
    expect(deny).toBeDefined();
    expect(deny).toMatchObject({
      action: "tlp_pap_denied",
      actor: { type: "agent", id: "agent:enrichment" },
      objectType: "analyzer_call",
    });
    expect(String((deny?.details as { error?: string }).error)).toBe(
      "tlp_exceeded: observable tlp=4 > max_tlp=2",
    );

    // 报告如实记录拒绝（不降级不外发——写明被拒原因，评级栏标 refused）
    const tl = await r.timeline(caseId);
    const structured = structuredOf(tl.find((e) => e.kind === "enrichment_report"));
    const refusedItem = structured.results.find((x) => x.data === "203.0.113.66");
    expect(refusedItem).toMatchObject({ ok: false, refused: "tlp_exceeded: observable tlp=4 > max_tlp=2" });
    expect(structured.refused_count).toBe(1);
    expect(tl.find((e) => e.kind === "enrichment_report")?.body).toContain("tlp_exceeded");
  });

  test("pap 超限同理：pap=3 observable → pap_exceeded 拒绝，且确定性（同入同出）", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("vt-87105-malware.json");
    r.seedObservable(caseId, { dataType: "ip", data: "203.0.113.77", tlp: 1, pap: 3 });

    const { done } = await r.runCase(caseId);
    expect(done.status).toBe("completed");
    expect(r.probe.lookups.map((l) => l.call.data)).toEqual([EICAR_SHA256]);
    const deny = r.audit.entries.find((e) => e.result === "DENIED");
    expect(String((deny?.details as { error?: string }).error)).toBe(
      "pap_exceeded: observable pap=3 > max_pap=2",
    );
  });
});

describe("artifacts 回写 m2 + 去重合并（验收 4，FR-M6.3）", () => {
  test("M2 落库口去重单测：同 (dataType,data) 二次回写 → 不新建行，tags 并入，201→200", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("ssh-5712-real.json");

    const first = await httpJson(r.caseBackend.url, "POST", `/api/v1/cases/${caseId}/observables`, {
      dataType: "filename",
      data: "invoice_apr.zip",
      tags: ["from:vt_lookup"],
    });
    expect(first.status).toBe(201);
    const second = await httpJson(r.caseBackend.url, "POST", `/api/v1/cases/${caseId}/observables`, {
      dataType: "filename",
      data: "invoice_apr.zip",
      tags: ["from:analyzer", "from:vt_lookup"], // 部分重复 + 部分新增
      message: "vt_lookup artifact",
    });
    expect(second.status).toBe(200); // 去重语义对 HTTP 面可见（ingest 去重 201→200 同款）
    expect((second.json as { dedup: boolean }).dedup).toBe(true);

    const detail = await r.caseObservables(caseId);
    const hits = detail.observables.filter((o) => o.dataType === "filename" && o.data === "invoice_apr.zip");
    expect(hits).toHaveLength(1); // 不新建行
    expect(hits[0].tags).toEqual(["from:vt_lookup", "from:analyzer"]); // tags 去重合并
    expect(hits[0].message).toBe("vt_lookup artifact"); // 原空 message 回填

    // 缺 dataType/data → 400（fail-closed 的 REST 面）
    const bad = await httpJson(r.caseBackend.url, "POST", `/api/v1/cases/${caseId}/observables`, { data: "x" });
    expect(bad.status).toBe(400);
  });

  test("整案重放富化：第二次 artifacts 全部 dedup，案件 observables 不膨胀（幂等）", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("vt-87105-malware.json");

    await r.runCase(caseId);
    const before = await r.caseObservables(caseId);
    const countBefore = before.observables.length;

    const { done } = await r.runCase(caseId);
    expect(done.status).toBe("completed");
    const after = await r.caseObservables(caseId);
    expect(after.observables).toHaveLength(countBefore); // 一行不多

    const tl = await r.timeline(caseId);
    const reports = tl.filter((e) => e.kind === "enrichment_report");
    expect(reports).toHaveLength(2); // 报告照写（两次运行各一份）
    expect(structuredOf(reports[1]).artifacts_written.every((a) => a.dedup)).toBe(true);
  });
});

describe("闸门在工具包装层（m6 卡 Seam 的行为面）与 fail-closed", () => {
  test("票面缺 add_timeline_entry → 验票闸拒 → 强杀 + DENIED 审计 + 0 报告", async () => {
    const r = await track(await rig({
      ticketTools: ENRICHMENT_TOOLS.filter((t) => t !== "add_timeline_entry"),
    }));
    const { caseId } = await r.seedCaseFromFixture("vt-87105-malware.json");

    const { done } = await r.runCase(caseId);
    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("node_error:write_report"); // enrichment_gate_denied:scope_insufficient

    const deny = r.audit.entries.find((e) => e.result === "DENIED");
    expect(deny?.details).toMatchObject({ tool: "add_timeline_entry", reason: "scope_insufficient" });
    const tl = await r.timeline(caseId);
    expect(tl.filter((e) => e.kind === "enrichment_report")).toHaveLength(0);
  });

  test("富化任务票 × L2 工具遍历全部 403（INV-3：analyzer 票里没有 isolate_host）", async () => {
    const { verifyTicket } = await import("../../src/verify-ticket.js");
    const ticket = makeTaskTicket("run_enrich", [...ENRICHMENT_TOOLS], { sub: "agent:enrichment" });
    const now = Math.floor(Date.now() / 1000);
    for (const tool of ["isolate_host", "block_ip", "kb_write"]) {
      const verdict = verifyTicket({ name: tool, params: {} }, { ticket, runId: "run_enrich" }, now, { hmacKey: KEY });
      expect(verdict).toEqual({ allow: false, code: 403, reason: "scope_insufficient" });
    }
  });
});

describe("analyzer 输出 = tool_output 通道（票 04 策略 flag）：投毒输出放行但打标", () => {
  test("fixtures/ti 里的投毒 IP：命中可疑指令模式 → guards flag + 审计，原文仍进报告待人复核", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("vt-87105-malware.json");
    r.seedObservable(caseId, { dataType: "ip", data: "198.51.100.23", tlp: 2 });

    const { done } = await r.runCase(caseId);
    expect(done.status).toBe("completed");

    // flag ≠ 拦截：查询真发出去了（tool_output 通道策略就是放行但打标）
    expect(r.probe.lookups.map((l) => l.call.data)).toContain("198.51.100.23");
    const flag = r.audit.entries.find((e) => e.action === "tool_output_flagged");
    expect(flag).toBeDefined();
    expect(flag?.objectType).toBe("analyzer_output");

    const tl = await r.timeline(caseId);
    const structured = structuredOf(tl.find((e) => e.kind === "enrichment_report"));
    const poisoned = structured.results.find((x) => x.data === "198.51.100.23");
    expect(poisoned).toMatchObject({ ok: true, level: "suspicious", flagged: true });
    expect(tl.find((e) => e.kind === "enrichment_report")?.body).toContain("guards");
  });
});

describe("无记录与不可富化项：报告如实，不编造（PRD no-record 语义）", () => {
  test("情报表未命中的 ip → info/no-record；hostname 等内部实体不查外部信誉", async () => {
    const r = await track(await rig());
    const { caseId } = await r.seedCaseFromFixture("ssh-5712-real.json");

    const { done } = await r.runCase(caseId);
    expect(done.status).toBe("completed");

    const tl = await r.timeline(caseId);
    const structured = structuredOf(tl.find((e) => e.kind === "enrichment_report"));
    const ip = structured.results.find((x) => x.dataType === "ip");
    expect(ip).toMatchObject({ ok: true, level: "info", analyzer: "ip_reputation" });
    expect(structured.results.every((x) => x.dataType !== "hostname")).toBe(true); // 主机名不外发
    expect(structured.summary).toContain("no-record");
  });
});
