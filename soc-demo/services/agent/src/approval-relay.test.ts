// 狗粮票 58：审批回路外部化（批准中继形态）的分支测试。裁决真相在椒图 g4，本地卡只是
// 镜像——本文件锁四路新行为：graph 挂起申报（成功落 external_id / 失败留 pending 可重试）、
// app 批准/驳回中继（409 映射 InvalidTransition、401 透传、无 external_id 不可批）、
// dispatcher G9 对账（expired 镜像结算）、旧库迁移；另锁内部模式（无 seam）原路径不变。
// 端到端五验收（内部模式全链）在 approval-loop.test.ts，原样全绿即内部模式零回归。
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { MemoryBurnRegistry, paramsHash, verifyTicket } from "./verify-ticket.js";
import { eventsAfter } from "./events.js";
import { loadRunState } from "./checkpointer.js";
import { createRun, transitionRun } from "./runs.js";
import { executeRun, resumeRun, type FlowNode } from "./graph.js";
import {
  ApprovalGatewayError,
  getApproval,
  openApprovalCard,
  setApprovalExternalId,
  toWire,
  type ApprovalDeclareInput,
  type ApprovalGateway,
} from "./approvals.js";
import { dispatchOnce } from "./run-dispatcher.js";
import type { MintRequest } from "./token-ports.js";
import { waitForRunStatus, waitForRunTerminal } from "./testkit.js";

const CONTRACT = JSON.parse(
  readFileSync(new URL("../../../fixtures/tickets/contract.json", import.meta.url), "utf8"),
) as { hmac_key: { value: string } };
const KEY = CONTRACT.hmac_key.value;

// ---------- 假件：椒图 g4 的批准中继替身（按申报入参铸可过闸的真签名票，模拟 g4 形态） ----------

function signApprovalToken(input: {
  jti: string;
  approvalId: string;
  approvedBy: string;
  tool: string;
  params: unknown;
  caseId: string | null;
}): { token: string; jti: string } {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    jti: input.jti,
    approval_id: input.approvalId,
    approved_by: input.approvedBy,
    tool: input.tool,
    params_hash: paramsHash(input.params),
    case_id: input.caseId ?? "",
    iat,
    exp: iat + 300,
    used: false,
  };
  const b64p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", Buffer.from(KEY, "utf8"))
    .update(`${header}.${b64p}`)
    .digest("hex");
  return { token: `${header}.${b64p}.${sig}`, jti: input.jti };
}

interface FakeGateway {
  gateway: ApprovalGateway;
  declared: ApprovalDeclareInput[];
  approvals: { externalId: string; approverToken: string }[];
  rejections: { externalId: string; approverToken: string; reason: string }[];
  statusCalls: string[];
  minted: { token: string; jti: string }[];
}

function makeFakeGateway(
  over: {
    declare?: (card: ApprovalDeclareInput) => Promise<{ externalId: string }>;
    fetchStatus?: (externalId: string) => Promise<{ status: string }>;
    approve?: (externalId: string, approverToken: string) => Promise<{ token: string; jti: string; exp: number }>;
    reject?: (externalId: string, approverToken: string, reason: string) => Promise<void>;
  } = {},
): FakeGateway {
  const declared: ApprovalDeclareInput[] = [];
  const approvals: { externalId: string; approverToken: string }[] = [];
  const rejections: { externalId: string; approverToken: string; reason: string }[] = [];
  const statusCalls: string[] = [];
  const minted: { token: string; jti: string }[] = [];
  const externalOf = new Map<string, ApprovalDeclareInput>();
  const gateway: ApprovalGateway = {
    async declare(card) {
      declared.push(card);
      if (over.declare) return over.declare(card);
      const externalId = `apr_ext_${declared.length}`;
      externalOf.set(externalId, card);
      return { externalId };
    },
    async fetchStatus(externalId) {
      statusCalls.push(externalId);
      if (over.fetchStatus) return over.fetchStatus(externalId);
      return { status: "pending" };
    },
    async approve(externalId, approverToken) {
      approvals.push({ externalId, approverToken });
      if (over.approve) return over.approve(externalId, approverToken);
      // 模拟 g4 批准铸票：按申报时的 tool/params/case_id（票 14 透传）铸一次性票
      const card = externalOf.get(externalId);
      if (!card) throw new ApprovalGatewayError(404);
      const signed = signApprovalToken({
        jti: `ap_ext_${approvals.length}`,
        approvalId: externalId,
        approvedBy: "值班长(口令)",
        tool: card.tool,
        params: card.params,
        caseId: card.caseId,
      });
      minted.push(signed);
      return { token: signed.token, jti: signed.jti, exp: 0 };
    },
    async reject(externalId, approverToken, reason) {
      rejections.push({ externalId, approverToken, reason });
      if (over.reject) return over.reject(externalId, approverToken, reason);
    },
  };
  return { gateway, declared, approvals, rejections, statusCalls, minted };
}

// ---------- 布景：带一个 L2 动作的最小图（approval-loop 同款） ----------

function l2Flow(views: { executions: Record<string, unknown>[] }): FlowNode[] {
  return [
    {
      name: "response_advice",
      run: (ctx) => {
        ctx.state.recommendation = { tool: "isolate_host", params: { host: "centos7" } };
      },
    },
    {
      name: "execute_action",
      run: async (ctx) => {
        ctx.state.execution = await ctx.executeApproved(
          "isolate_host",
          { host: "centos7" },
          { reason: "调查报告建议遏制" },
          (p) => {
            const params = p as { host: string };
            views.executions.push({ host: params.host });
            return { mock_edr: "isolated", host: params.host };
          },
        );
      },
    },
  ];
}

/** 外部模式 app：mint 造的审批票必须一次都未被调（INV-2 单口在椒图，调到即测试炸响）。 */
function makeExternalApp(gw: FakeGateway) {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const used = new MemoryBurnRegistry();
  const executions: Record<string, unknown>[] = [];
  const mintApprovalCalls: MintRequest[] = [];
  const app = buildApp({
    db,
    audit,
    nodes: l2Flow({ executions }),
    mint: {
      async mintApprovalToken(req) {
        mintApprovalCalls.push(req);
        throw new Error("INV-2 单口在椒图：外部模式不许本地铸审批票");
      },
      async mintTaskTicket() {
        throw new Error("mintTaskTicket not expected in this test");
      },
    },
    burn: used,
    used,
    hmacKey: KEY,
    approvalGateway: gw.gateway,
    dispatcher: { intervalMs: 5 },
  });
  return { db, audit, used, executions, mintApprovalCalls, app };
}

async function startRun(app: ReturnType<typeof buildApp>, db: DB): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/internal/runs",
    payload: { kind: "alert_flow", alert_id: "al-5712" },
  });
  expect(res.statusCode).toBe(202);
  const runId = res.json().run_id as string;
  await waitForRunStatus(db, runId, "awaiting_approval");
  return runId;
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function pendingCards(
  app: ReturnType<typeof buildApp>,
): Promise<{ id: string; external_id: string | null; status: string }[]> {
  const res = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
  expect(res.statusCode).toBe(200);
  return res.json().approvals as { id: string; external_id: string | null; status: string }[];
}

// ---------- app 层：批准中继（外部批准全链 / 409 / 401 / 无 external_id） ----------

describe("app 层：外部模式批准中继", () => {
  test("批准全链：申报→中继铸票→镜像裁决 token 落卡→resume 执行→焚毁登记→重放 403 token_used", async () => {
    const gw = makeFakeGateway();
    const { db, audit, used, executions, mintApprovalCalls, app } = makeExternalApp(gw);
    const runId = await startRun(app, db);
    const card = (await pendingCards(app))[0];

    // 申报已发生：g4 收到领域卡的逐字段投影（reason→risk、caseId→case_id 是 adapter 的映射，
    // 端口收到的仍是领域命名），external_id 落卡且 toWire 带出
    await waitFor(() => getApproval(db, card.id)?.externalId !== null, "external_id 落卡");
    expect(gw.declared).toEqual([
      {
        tool: "isolate_host",
        params: { host: "centos7" },
        paramsHash: paramsHash({ host: "centos7" }),
        reason: "调查报告建议遏制",
        caseId: null,
      },
    ]);
    expect(getApproval(db, card.id)).toMatchObject({ externalId: "apr_ext_1", status: "pending" });
    expect((await pendingCards(app))[0]).toMatchObject({ external_id: "apr_ext_1" });

    // 值班长批准（口令走 x-approver-token 头）→ 椒图 200 → 镜像裁决 + resume 入队秒回
    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      headers: { "x-approver-token": "demo-approver-token" },
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(200);
    const body = apr.json() as { approval_id: string; approval_token: string; run_id: string; run_status: string };
    // 响应 wire 形与内部模式逐字段相同（票 58 验收：web 响应 wire 形不变）
    expect(body).toMatchObject({
      approval_id: card.id,
      approval_token: gw.minted[0].token, // 票随批准响应中继回来
      run_id: runId,
      run_status: "awaiting_approval", // 票 47 时序契约：秒回时续跑还在队里
    });
    // 口令原样中继给椒图（批准人身份由椒图口令证明）
    expect(gw.approvals).toEqual([{ externalId: "apr_ext_1", approverToken: "demo-approver-token" }]);

    // resume：节点重跑拿卡上 token → 闸验签 → 执行原 tool_call → 焚毁登记
    await waitForRunTerminal(db, runId);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({ status: "completed" });
    expect(executions).toEqual([{ host: "centos7" }]);

    // 镜像裁决：椒图铸的票原样落本地卡（token/tokenJti）
    expect(getApproval(db, card.id)).toMatchObject({
      status: "approved",
      approver: "duty_lead",
      token: gw.minted[0].token,
      tokenJti: "ap_ext_1",
    });

    // INV-2 单口：外部模式全链 soc-demo 一次都没铸审批票
    expect(mintApprovalCalls).toHaveLength(0);

    // 审批链审计：create→declare→approve→execute（INV-8）
    expect(
      audit.entries.filter((e) => e.objectType === "approval").map((e) => e.action),
    ).toEqual(["create", "declare", "approve", "execute"]);

    // token 重放：焚毁账已登记（外部模式即椒图 burned=true 的等价物）→ 403 token_used（INV-2）
    const replay = verifyTicket(
      { name: "isolate_host", params: { host: "centos7" } },
      { approvalToken: body.approval_token, used },
      Math.floor(Date.now() / 1000),
      { hmacKey: KEY },
    );
    expect(replay).toEqual({ allow: false, code: 403, reason: "token_used" });
    await app.close();
  });

  test("并发后到：椒图 409 → soc-demo 409 {error:InvalidTransition}（INV-10 仲裁权在椒图），卡留原状", async () => {
    const gw = makeFakeGateway({ approve: async () => { throw new ApprovalGatewayError(409); } });
    const { db, app } = makeExternalApp(gw);
    const runId = await startRun(app, db);
    const card = (await pendingCards(app))[0];
    await waitFor(() => getApproval(db, card.id)?.externalId !== null, "external_id 落卡");

    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      headers: { "x-approver-token": "demo-approver-token" },
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(409);
    expect(apr.json().error).toBe("InvalidTransition");
    // 裁决没发生：卡仍 pending、run 仍挂起（与本地状态机 409 同款后状态）
    expect((await pendingCards(app)).map((c) => c.id)).toEqual([card.id]);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({
      status: "awaiting_approval",
    });
    await app.close();
  });

  test("口令错/缺：椒图 401 → 401 透传（缺头按空口令中继，fail-closed 不本地造 403）", async () => {
    const gw = makeFakeGateway({ approve: async () => { throw new ApprovalGatewayError(401); } });
    const { db, app } = makeExternalApp(gw);
    const runId = await startRun(app, db);
    const card = (await pendingCards(app))[0];
    await waitFor(() => getApproval(db, card.id)?.externalId !== null, "external_id 落卡");

    // 不带口令头：空口令原样中继（椒图 401 裁决，soc-demo 不预判不代答）
    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(401);
    expect(apr.json().error).toBe("unauthorized");
    expect(gw.approvals[0]).toMatchObject({ externalId: "apr_ext_1", approverToken: "" });
    expect((await pendingCards(app)).map((c) => c.id)).toEqual([card.id]);
    expect(runId).toBeTruthy();
    await app.close();
  });
});

// ---------- app 层：驳回中继 ----------

describe("app 层：外部模式驳回中继", () => {
  test("驳回半边：中继→椒图 200→镜像 rejected→resume 跳过执行，审计 create→declare→reject", async () => {
    const gw = makeFakeGateway();
    const { db, audit, executions, app } = makeExternalApp(gw);
    const runId = await startRun(app, db);
    const card = (await pendingCards(app))[0];
    await waitFor(() => getApproval(db, card.id)?.externalId !== null, "external_id 落卡");

    const rej = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/reject`,
      headers: { "x-approver-token": "demo-approver-token" },
      payload: { approver: "duty_lead", reason: "证据不足，先补调查" },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json()).toMatchObject({
      approval_id: card.id,
      decision: "rejected",
      run_id: runId,
      run_status: "awaiting_approval",
    });
    expect(gw.rejections).toEqual([
      { externalId: "apr_ext_1", approverToken: "demo-approver-token", reason: "证据不足，先补调查" },
    ]);

    // resume：节点拿 rejected 决定跳过执行（不执行、无 tool_call）
    await waitForRunTerminal(db, runId);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({ status: "completed" });
    expect(executions).toEqual([]);
    const { state } = loadRunState(db, runId);
    expect(state.execution).toMatchObject({ executed: false, outcome: "rejected" });

    // 本地卡镜像 rejected；审计 create→declare→reject（无 execute）
    expect(getApproval(db, card.id)).toMatchObject({ status: "rejected", rejectReason: "证据不足，先补调查" });
    expect(
      audit.entries.filter((e) => e.objectType === "approval").map((e) => e.action),
    ).toEqual(["create", "declare", "reject"]);
    const types = eventsAfter(db, runId, 0).map((e) => e.type);
    expect(types).toContain("approval_decided");
    expect(types).not.toContain("tool_call");
    await app.close();
  });
});

// ---------- app 层：无 external_id 的卡（申报未成功）不可裁决 ----------

describe("app 层：申报未成功的卡不可裁决", () => {
  test("approve/reject → 502 declare_pending，绝不本地补铸或跳过申报（INV-2 单口）；卡留 pending 可重试", async () => {
    const gw = makeFakeGateway({ declare: async () => { throw new ApprovalGatewayError(503); } });
    const { db, audit, app } = makeExternalApp(gw);
    const runId = await startRun(app, db);
    const card = (await pendingCards(app))[0];

    // 申报失败的面（graph 层语义在此顺带可见）：审计 FAILURE + error 事件 + 卡留 pending
    await waitFor(
      () => audit.entries.some((e) => e.action === "declare" && e.result === "FAILURE"),
      "declare FAILURE 审计",
    );
    expect(getApproval(db, card.id)).toMatchObject({ status: "pending", externalId: null });
    const errEvent = eventsAfter(db, runId, 0).find((e) => e.type === "error");
    expect(errEvent?.payload).toMatchObject({ code: "approval_declare_failed", approval_id: card.id });
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({
      status: "awaiting_approval",
    });

    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      headers: { "x-approver-token": "demo-approver-token" },
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(502);
    expect(apr.json().error).toBe("declare_pending");
    const rej = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/reject`,
      headers: { "x-approver-token": "demo-approver-token" },
      payload: { approver: "duty_lead", reason: "x" },
    });
    expect(rej.statusCode).toBe(502);
    expect(rej.json().error).toBe("declare_pending");
    // 中继一次都没发生（椒图面不可达就不该有批准/驳回请求出去）
    expect(gw.approvals).toHaveLength(0);
    expect(gw.rejections).toHaveLength(0);
    await app.close();
  });
});

// ---------- graph 层：挂起申报 ----------

describe("graph 层：挂起申报（executeRun 直驱，不经 app）", () => {
  function makeDbWithRun() {
    // run 落 queued 即可：executeRun 自己做 queued→running（先转 running 会撞状态机 409）
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-58" }, { audit, requestId: "req-58" });
    return { db, audit, run };
  }

  test("申报成功：declare 逐字段收到卡投影，external_id 落卡 + 审计 declare SUCCESS", async () => {
    const gw = makeFakeGateway();
    const { db, audit, run } = makeDbWithRun();
    const executions: Record<string, unknown>[] = [];
    await executeRun(db, run.id, {
      nodes: l2Flow({ executions }),
      audit,
      hmacKey: KEY,
      approvalGateway: gw.gateway,
    });

    // executeRun 返回即挂起且申报已完成（申报在挂起分支 await）
    expect(run.status ?? "awaiting_approval").toBeTruthy();
    await waitForRunStatus(db, run.id, "awaiting_approval");
    expect(gw.declared).toEqual([
      {
        tool: "isolate_host",
        params: { host: "centos7" },
        paramsHash: paramsHash({ host: "centos7" }),
        reason: "调查报告建议遏制",
        caseId: null,
      },
    ]);
    const card = (
      db.prepare("SELECT id, external_approval_id FROM approvals WHERE run_id = ?").get(run.id) as {
        id: string;
        external_approval_id: string;
      }
    );
    expect(card.external_approval_id).toBe("apr_ext_1");
    expect(
      audit.entries.filter((e) => e.objectType === "approval").map((e) => [e.action, e.result]),
    ).toEqual([["create", "SUCCESS"], ["declare", "SUCCESS"]]);
  });

  test("申报失败：审计 FAILURE + error 事件，卡留 pending 无 external_id，run 仍挂起可重试", async () => {
    const gw = makeFakeGateway({ declare: async () => { throw new ApprovalGatewayError(503); } });
    const { db, audit, run } = makeDbWithRun();
    const executions: Record<string, unknown>[] = [];
    await executeRun(db, run.id, {
      nodes: l2Flow({ executions }),
      audit,
      hmacKey: KEY,
      approvalGateway: gw.gateway,
    });

    await waitForRunStatus(db, run.id, "awaiting_approval"); // 挂起不是失败
    const card = (
      db.prepare("SELECT id, status, external_approval_id FROM approvals WHERE run_id = ?").get(run.id) as {
        id: string;
        status: string;
        external_approval_id: string | null;
      }
    );
    expect(card).toMatchObject({ status: "pending", external_approval_id: null });
    const failure = audit.entries.find((e) => e.action === "declare");
    expect(failure).toMatchObject({ objectType: "approval", objectId: card.id, result: "FAILURE" });
    expect(String(failure?.details.error)).toContain("HTTP 503");
    expect(eventsAfter(db, run.id, 0).some((e) => e.type === "error")).toBe(true);
  });

  test("重复挂起不重复申报：已有 external_id 的卡幂等跳过 declare", async () => {
    const gw = makeFakeGateway();
    const { db, audit, run } = makeDbWithRun();
    const executions: Record<string, unknown>[] = [];
    const nodes = l2Flow({ executions });
    await executeRun(db, run.id, { nodes, audit, hmacKey: KEY, approvalGateway: gw.gateway });
    // 卡仍未决 → resume 重入 → 节点重查卡再次 interrupt（第二次挂起）
    await resumeRun(db, run.id, { nodes, audit, hmacKey: KEY, approvalGateway: gw.gateway });
    await waitForRunStatus(db, run.id, "awaiting_approval");
    expect(gw.declared).toHaveLength(1); // 申报幂等：第二次挂起不再出站
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id)).toMatchObject({
      status: "awaiting_approval",
    });
  });
});

// ---------- dispatcher 层：G9 对账 ----------

describe("dispatcher 层：G9 对账（椒图先过期的镜像结算）", () => {
  function suspendedWithExternal(db: DB, audit: MemoryAuditSink): { runId: string; cardId: string } {
    const run = createRun(db, { kind: "alert_flow", alertId: "al-g9" }, { audit, requestId: "req-g9" });
    transitionRun(db, run.id, "running", { audit, requestId: "req-g9" });
    const card = openApprovalCard(db, {
      runId: run.id,
      node: "execute_action",
      tool: "isolate_host",
      params: { host: "centos7" },
      reason: "调查报告建议遏制",
    }, { audit, requestId: "req-g9" });
    setApprovalExternalId(db, card.id, "apr_ext_g9", { audit, requestId: "req-g9" });
    return { runId: run.id, cardId: card.id };
  }

  test("fetchStatus=expired → 本地镜像结算：卡 expired + run failed(approval_expired)", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const { runId, cardId } = suspendedWithExternal(db, audit);
    const gw = makeFakeGateway({ fetchStatus: async () => ({ status: "expired" }) });

    const tick = await dispatchOnce({
      db,
      audit,
      execute: async () => { throw new Error("not expected"); },
      concurrency: 1,
      approvalTtlSeconds: 3600, // 本地 TTL 未到：过期裁决来自椒图对账而非本地扫描
      approvalGateway: gw.gateway,
    });
    expect(tick.expired).toEqual([cardId]);
    expect(gw.statusCalls).toEqual(["apr_ext_g9"]); // 对账用的就是 external_id
    expect(db.prepare("SELECT status FROM approvals WHERE id = ?").get(cardId)).toMatchObject({ status: "expired" });
    expect(db.prepare("SELECT status, fail_reason FROM runs WHERE id = ?").get(runId))
      .toMatchObject({ status: "failed", fail_reason: "approval_expired" });
  });

  test("fetchStatus=pending → 不动卡（决定走中继响应，不对账代写）", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const { runId, cardId } = suspendedWithExternal(db, audit);
    const gw = makeFakeGateway({ fetchStatus: async () => ({ status: "pending" }) });
    const tick = await dispatchOnce({
      db, audit,
      execute: async () => { throw new Error("not expected"); },
      concurrency: 1, approvalTtlSeconds: 3600, approvalGateway: gw.gateway,
    });
    expect(tick.expired).toEqual([]);
    expect(db.prepare("SELECT status FROM approvals WHERE id = ?").get(cardId)).toMatchObject({ status: "pending" });
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({ status: "awaiting_approval" });
  });

  test("对账口病了（404/网络）→ 只记日志本轮跳过，绝不当「真相是过期」动卡", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const { runId, cardId } = suspendedWithExternal(db, audit);
    const logs: Record<string, unknown>[] = [];
    const gw = makeFakeGateway({ fetchStatus: async () => { throw new ApprovalGatewayError(404); } });
    const tick = await dispatchOnce({
      db, audit,
      execute: async () => { throw new Error("not expected"); },
      concurrency: 1, approvalTtlSeconds: 3600, approvalGateway: gw.gateway,
      log: (e) => logs.push(e),
    });
    expect(tick.expired).toEqual([]);
    expect(db.prepare("SELECT status FROM approvals WHERE id = ?").get(cardId)).toMatchObject({ status: "pending" });
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({ status: "awaiting_approval" });
    expect(logs.some((l) => l.warn === "approval_reconcile_failed")).toBe(true);
  });
});

// ---------- 迁移：approvals.external_approval_id（旧库查缺补列） ----------

describe("迁移：旧库无 external_approval_id 列 → openDb 幂等补列，旧卡不受影响", () => {
  test("旧 schema 库文件迁移后有列；旧卡 externalId=null 可读可继续流转", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-relay-mig-"));
    const dbPath = join(dir, "agent.sqlite");
    // 票 58 之前的 approvals 形状（旧 DDL 一字不差）
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node TEXT NOT NULL,
        tool TEXT NOT NULL,
        params TEXT NOT NULL,
        params_hash TEXT NOT NULL,
        case_id TEXT,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        approver TEXT,
        reject_reason TEXT,
        token TEXT,
        token_jti TEXT,
        executed_at INTEGER,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );
    `);
    raw.prepare(
      `INSERT INTO approvals (id, run_id, node, tool, params, params_hash, case_id, reason, status, created_at)
       VALUES ('apr_old', 'run_old', 'execute_action', 'isolate_host', '{}', 'sha256:x', 'case_1', '票 58 前的旧卡', 'pending', 1)`,
    ).run();
    raw.close();

    const db = openDb(dbPath);
    const cols = (db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("external_approval_id");
    // 旧卡不受影响：字段原样读出，externalId 是 null（内部模式语义）
    const old = getApproval(db, "apr_old");
    expect(old).toMatchObject({ id: "apr_old", status: "pending", reason: "票 58 前的旧卡", externalId: null });
    expect(toWire(old as NonNullable<typeof old>).external_id).toBeNull();
    // 新列可用：外部锚落卡不碰其余字段
    setApprovalExternalId(db, "apr_old", "apr_ext_old", { audit: new MemoryAuditSink(), requestId: "req-mig" });
    expect(getApproval(db, "apr_old")).toMatchObject({ externalId: "apr_ext_old", status: "pending" });
    db.close();
  });
});

// ---------- 内部模式（无 approvalGateway seam）：原路径逐字节不变 ----------

describe("内部模式（无 seam）：挂起不申报、批准仍本地铸票", () => {
  test("无 approvalGateway：卡无 external_id，approve 走 mint 本地铸票原路径", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const used = new MemoryBurnRegistry();
    const executions: Record<string, unknown>[] = [];
    const mintCalls: MintRequest[] = [];
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const app = buildApp({
      db,
      audit,
      nodes: l2Flow({ executions }),
      mint: {
        async mintApprovalToken(req: MintRequest) {
          mintCalls.push(req);
          const iat = Math.floor(Date.now() / 1000);
          const payload = { jti: req.jti, approval_id: req.approvalId, approved_by: req.approvedBy, tool: req.tool, params_hash: paramsHash(req.params), case_id: req.caseId ?? "", iat, exp: iat + 300, used: false };
          const b64p = Buffer.from(JSON.stringify(payload)).toString("base64url");
          const sig = createHmac("sha256", Buffer.from(KEY, "utf8")).update(`${header}.${b64p}`).digest("hex");
          return { token: `${header}.${b64p}.${sig}`, payload };
        },
        async mintTaskTicket() {
          throw new Error("mintTaskTicket not expected in this test");
        },
      },
      burn: used,
      used,
      hmacKey: KEY,
      dispatcher: { intervalMs: 5 },
      // 不传 approvalGateway —— 内部模式
    });
    const runId = await startRun(app, db);
    const card = (await pendingCards(app))[0];
    // 挂起分支无申报：卡没有外部锚
    expect(card.external_id).toBeNull();
    await new Promise((r) => setTimeout(r, 60)); // 给「万一偷偷申报」留观察窗（无出站 seam，只看卡面）
    expect(getApproval(db, card.id)?.externalId).toBeNull();

    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(200);
    expect(mintCalls).toHaveLength(1); // 本地铸票原路径
    expect(apr.json().approval_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    await waitForRunTerminal(db, runId);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({ status: "completed" });
    await app.close();
  });
});
