// 票 39 验收主战场：SOC1 一键确认关单（FR-M4.5 演示口径·G2-7）。
// 与 flow.test.ts 同款 rig：真 case-backend 子进程（状态机/409/审计在环内）+
// 生产 HttpTriageM2 adapter。close_flow 子图 = load_close_target → execute_close，
// close_alert 是 A.1 的 L1 工具——必须过 verifyTicket 任务票闸（INV-1/INV-3）。
import { afterEach, describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { executeRun } from "../../src/graph.js";
import { buildApp } from "../../src/app.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { eventsAfter, type RunEvent } from "../../src/events.js";
import { makeCloseFlow } from "./close.js";
import { makeTriageFlow } from "./flow.js";
import { HttpTriageM2 } from "./m2.js";
import { MemoryKb } from "./kb.js";
import { FakeTriageLlm } from "./llm.js";
import {
  fakeScan,
  httpJson,
  KEY,
  makeTaskTicket,
  seedAlert,
  startCaseBackend,
  type CaseBackend,
} from "./testkit.js";

const FIX = (f: string) =>
  fileURLToPath(new URL(`../../../../fixtures/alerts/${f}`, import.meta.url));

// 确认人（演示口径：web 告警页 soc1 一键确认；INV-8 要记是谁按的按钮）
const SOC1 = { type: "user", id: "soc1@soc.local" };

async function rig() {
  const caseBackend: CaseBackend = await startCaseBackend();
  const agentDb: DB = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const m2 = new HttpTriageM2(caseBackend.url);

  /** 先把一条告警分诊成 fp（web-31103 = 运维噪声 → close 建议，status 留在 New）。 */
  const runTriage = async (alertId: string) => {
    const run = createRun(agentDb, { kind: "alert_flow", alertId }, { audit, requestId: "req-t" });
    const flow = makeTriageFlow({
      runId: run.id,
      requestId: "req-t",
      ticket: makeTaskTicket(run.id, ["get_alert", "kb_lookup", "search_cases_by_host", "create_case", "merge_alert", "close_alert"]),
      hmacKey: KEY,
      m2,
      kb: new MemoryKb(),
      llm: new FakeTriageLlm(),
      scan: fakeScan,
      audit,
    });
    return executeRun(agentDb, run.id, { nodes: flow, audit, requestId: "req-t", hmacKey: KEY });
  };

  /** 跑关单子图（被测对象）。 */
  const runClose = async (alertId: string, over: { ticketTools?: string[]; actor?: { type: string; id: string } } = {}) => {
    const run = createRun(agentDb, { kind: "close_flow", alertId }, { audit, requestId: "req-c" });
    const flow = makeCloseFlow({
      runId: run.id,
      requestId: "req-c",
      ticket: makeTaskTicket(run.id, over.ticketTools ?? ["get_alert", "close_alert"]),
      hmacKey: KEY,
      m2,
      audit,
      actor: over.actor ?? SOC1,
    });
    const done = await executeRun(agentDb, run.id, { nodes: flow, audit, requestId: "req-c", hmacKey: KEY });
    const events: RunEvent[] = eventsAfter(agentDb, run.id, 0);
    return { done, events };
  };

  const getAlert = async (alertId: string) =>
    (await httpJson(caseBackend.url, "GET", `/api/v1/alerts/${alertId}`)).json as unknown as {
      id: string; status: string; verdict: string | null; verdictAi: unknown;
    };
  const m2Audit = async (alertId: string) =>
    (await httpJson(caseBackend.url, "GET", `/api/v1/audit?objectId=${alertId}`)).json as unknown as {
      action: string; details: Record<string, unknown>; result: string;
    }[];

  return { caseBackend, audit, runTriage, runClose, getAlert, m2Audit, seed: (f: string) => seedAlert(caseBackend.url, f) };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});
async function track<T extends { caseBackend: CaseBackend }>(rigged: T): Promise<T> {
  closers.push(() => rigged.caseBackend.close());
  return rigged;
}

describe("SOC1 一键确认关单（FR-M4.5·G2-7）", () => {
  test("状态机合法驱动 New→InProgress→Closed：close_alert 过闸执行，审计与时间线双留痕", async () => {
    const r = await track(await rig());
    const alertId = await r.seed(FIX("web-31103-cgi-500.json"));

    // 前半场：分诊产出 close 建议（fp + recommended_action=close，status 留在 New）
    const triaged = await r.runTriage(alertId);
    expect(triaged.status).toBe("completed");
    const before = await r.getAlert(alertId);
    expect(before.verdict).toBe("false_positive");
    expect((before.verdictAi as Record<string, unknown>).recommended_action).toBe("close");
    expect(before.status).toBe("New");

    // 后半场：SOC1 一键确认 → close_flow 执行关单
    const { done, events } = await r.runClose(alertId);
    expect(done.status).toBe("completed");

    const alert = await r.getAlert(alertId);
    expect(alert.status).toBe("Closed");
    expect(alert.verdict).toBe("false_positive");

    // 工具轨迹：L0 读 + L1 写，全部过闸（票面就这两个工具）
    const toolCalls = events.filter((e) => e.type === "tool_call").map((e) => e.payload.tool);
    expect(toolCalls).toEqual(["get_alert", "close_alert"]);

    // 审计留痕（INV-8 五要素）：确认动作记到确认人头上
    const confirm = r.audit.entries.find((e) => e.action === "close_confirm");
    expect(confirm).toBeDefined();
    expect(confirm?.actor).toEqual(SOC1);
    expect(confirm?.result).toBe("SUCCESS");
    expect(confirm?.details).toMatchObject({ alert_id: alertId, verdict: "false_positive" });

    // 时间线留痕：确认动作镜像进 run 事件流（流水线视图可见）
    expect(events.some((e) => e.type === "audit" && (e.payload as Record<string, unknown>).action === "close_confirm")).toBe(true);

    // M2 侧审计：状态机合法路径的 diff 快照 New→InProgress→Closed（INV-10 的对账面）
    const entries = await r.m2Audit(alertId);
    const statusDiffs = entries
      .map((e) => (e.details as { status?: { from: string; to: string } }).status)
      .filter((s) => s !== undefined)
      .map((s) => `${s.from}->${s.to}`);
    expect(statusDiffs).toContain("New->InProgress"); // 票 13 偏差②：先置 InProgress
    expect(statusDiffs).toContain("InProgress->Closed");
  });

  test("没有关单建议就不执行（未分诊/verdict 未定）：run 失败人话留痕，告警原样", async () => {
    const r = await track(await rig());
    const alertId = await r.seed(FIX("web-31103-cgi-500.json"));

    const { done, events } = await r.runClose(alertId);
    expect(done.status).toBe("failed");
    const err = events.find((e) => e.type === "error");
    expect(String((err?.payload as Record<string, unknown>).message)).toContain("close_verdict_missing");

    // 告警一个字节没动（闸前的预检挡住，不产生任何 M2 写）
    const alert = await r.getAlert(alertId);
    expect(alert.status).toBe("New");
    expect(alert.verdict).toBeNull();
    expect(r.audit.entries.some((e) => e.action === "close_confirm")).toBe(false);
  });

  test("重复确认：已 Closed 再确认 → 拒绝（409 语义的人话路径），状态不被静默改写", async () => {
    const r = await track(await rig());
    const alertId = await r.seed(FIX("web-31103-cgi-500.json"));
    await r.runTriage(alertId);
    const first = await r.runClose(alertId);
    expect(first.done.status).toBe("completed");

    const second = await r.runClose(alertId);
    expect(second.done.status).toBe("failed");
    const err = second.events.find((e) => e.type === "error");
    expect(String((err?.payload as Record<string, unknown>).message)).toContain("close_already_closed");
    expect((await r.getAlert(alertId)).status).toBe("Closed");
  });

  test("闸 fail-closed：票面缺 close_alert → DENIED + run 强杀，告警一个字节不动（INV-1）", async () => {
    const r = await track(await rig());
    const alertId = await r.seed(FIX("web-31103-cgi-500.json"));
    await r.runTriage(alertId);

    const { done } = await r.runClose(alertId, { ticketTools: ["get_alert"] });
    expect(done.status).toBe("failed");

    const deny = r.audit.entries.find((e) => e.result === "DENIED");
    expect(deny).toBeDefined();
    expect(deny?.details).toMatchObject({ tool: "close_alert", reason: "scope_insufficient" });

    // 无票不落地：先置 InProgress 也不许发生（闸前的预检过了，但写被闸拦在执行前）
    const alert = await r.getAlert(alertId);
    expect(alert.status).toBe("New");
    const entries = await r.m2Audit(alertId);
    expect(entries.some((e) => e.details && "status" in e.details)).toBe(false);
  });

  test("gate 拒绝时的错误事件与 failReason 可定位（node_error:execute_close）", async () => {
    const r = await track(await rig());
    const alertId = await r.seed(FIX("web-31103-cgi-500.json"));
    await r.runTriage(alertId);

    const { done, events } = await r.runClose(alertId, { ticketTools: ["get_alert"] });
    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("node_error:execute_close");
    const err = events.find((e) => e.type === "error");
    expect(String((err?.payload as Record<string, unknown>).message)).toContain("triage_gate_denied:scope_insufficient");
  });
});

describe("app 接线：POST /internal/runs {kind:close_flow}（m3 拉起面·最小票）", () => {
  test("铸 get_alert+close_alert 最小任务票（scope=alert:update）→ 跑完关单；确认人进审计（INV-8）", async () => {
    const r = await track(await rig());
    const alertId = await r.seed(FIX("web-31103-cgi-500.json"));
    await r.runTriage(alertId);

    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const mintCalls: { sub: string; runId: string; scope: string[]; allowedTools: string[] }[] = [];
    const app = buildApp({
      db,
      audit,
      hmacKey: KEY,
      mint: {
        async mintTaskTicket(req) {
          mintCalls.push({ sub: req.sub, runId: req.runId, scope: [...req.scope], allowedTools: [...req.allowedTools] });
          return { token: makeTaskTicket(req.runId, req.allowedTools), payload: {} };
        },
        async mintApprovalToken() {
          throw new Error("close_flow 不应申请 ApprovalToken（INV-3：物理无 L2 票）");
        },
      },
      makeNodes: (run, ticket, ctx) =>
        makeCloseFlow({
          runId: run.id,
          requestId: "req-wire",
          ticket,
          hmacKey: KEY,
          m2: new HttpTriageM2(r.caseBackend.url),
          audit,
          actor: ctx?.actor,
        }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "close_flow", alert_id: alertId },
      headers: { "x-actor-id": "soc1@soc.local" },
    });
    expect(res.statusCode).toBe(202);

    // 最小票（INV-3：票面无任何 L2；工具面只有本动作用到的两件）
    expect(mintCalls).toHaveLength(1);
    expect(mintCalls[0]).toMatchObject({
      sub: "agent:triage",
      allowedTools: ["get_alert", "close_alert"],
      scope: ["alert:update"],
    });
    // 确认人进 run 创建审计（带 x-actor-id 的请求按 user 记，不猜身份）
    const create = audit.entries.find((e) => e.action === "create" && e.objectType === "run");
    expect(create?.actor).toEqual({ type: "user", id: "soc1@soc.local" });
    expect((await r.getAlert(alertId)).status).toBe("Closed");
    await app.close();
  });

  test("缺 alert_id → 400 kind_and_alert_id_required（与既有 kind 同闸）", async () => {
    const app = buildApp({ hmacKey: KEY });
    const res = await app.inject({ method: "POST", url: "/internal/runs", payload: { kind: "close_flow" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("kind_and_alert_id_required");
    await app.close();
  });
});
