// 票 11：审批回路端到端——五条验收逐条落点。
// 铸票在测试里用 TS 侧假件（wire 形态照 fixtures/tickets/ 契约，与 gateway py 同形，
// 验票闸 verifyTicket 能真验签）；生产走 HttpMintClient → gateway POST /internal/mint（票 06）。
// 「杀进程重启」用文件库 + 两个全新 app 实例模拟：进程内状态全换，只剩 SQLite 落盘真相。
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { MemoryBurnRegistry, paramsHash, verifyTicket } from "./verify-ticket.js";
import { eventsAfter } from "./events.js";
import { loadRunState } from "./checkpointer.js";
import { createRun } from "./runs.js";
import { InvalidRunTransitionError } from "./statemachine.js";
import { resumeRun, type FlowNode } from "./graph.js";
import type { MintClient, MintRequest } from "./token-ports.js";

const CONTRACT = JSON.parse(
  readFileSync(new URL("../../../fixtures/tickets/contract.json", import.meta.url), "utf8"),
) as { hmac_key: { value: string } };
const KEY = CONTRACT.hmac_key.value;

// TS 侧假铸票（测试替身）：token = b64url(header).b64url(payload).hex(hmac_sha256(key,"b64h.b64p"))，
// payload 字段集照 PRD §5.9（fixtures/tickets 契约的铸造参数动态版）。
function makeFakeMint(over: { ttl?: number; iatShift?: number } = {}) {
  const calls: MintRequest[] = [];
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const client: MintClient = {
    async mintApprovalToken(req: MintRequest) {
      calls.push(req);
      const iat = Math.floor(Date.now() / 1000) + (over.iatShift ?? 0);
      const payload = {
        jti: req.jti,
        approval_id: req.approvalId,
        approved_by: req.approvedBy,
        tool: req.tool,
        params_hash: paramsHash(req.params),
        case_id: req.caseId ?? "",
        iat,
        exp: iat + (over.ttl ?? 300),
        used: false,
      };
      const b64p = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = createHmac("sha256", Buffer.from(KEY, "utf8"))
        .update(`${header}.${b64p}`)
        .digest("hex");
      return { token: `${header}.${b64p}.${sig}`, payload };
    },
  };
  return { client, calls };
}

// 带一个 L2 动作的最小图：response_advice（建议遏制）→ execute_action（审批闸执行）。
// executions 收集 mock 动作真正执行到的参数——断言「执行的就是原 tool_call」的探针。
function l2Flow(views: {
  executions: Record<string, unknown>[];
  paramsRef?: { current: unknown };
}): FlowNode[] {
  const paramsRef = views.paramsRef ?? { current: { host: "centos7" } };
  return [
    {
      name: "response_advice",
      run: (ctx) => {
        ctx.state.recommendation = { tool: "isolate_host", params: paramsRef.current };
      },
    },
    {
      name: "execute_action",
      run: (ctx) => {
        const out = ctx.executeApproved(
          "isolate_host",
          paramsRef.current,
          { reason: "调查报告建议遏制" },
          (p) => {
            const params = p as { host: string };
            views.executions.push({ host: params.host });
            return { mock_edr: "isolated", host: params.host };
          },
        );
        ctx.state.execution = out;
      },
    },
  ];
}

function makeApp(over: { paramsRef?: { current: unknown } } = {}) {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const used = new MemoryBurnRegistry();
  const mint = makeFakeMint();
  const executions: Record<string, unknown>[] = [];
  const app = buildApp({
    db,
    audit,
    nodes: l2Flow({ executions, paramsRef: over.paramsRef }),
    mint: mint.client,
    burn: used,
    used,
    hmacKey: KEY,
  });
  return { db, audit, used, mint, executions, app };
}

async function startRun(app: ReturnType<typeof buildApp>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/internal/runs",
    payload: { kind: "alert_flow", alert_id: "al-5712" },
  });
  expect(res.statusCode).toBe(202);
  return res.json().run_id as string;
}

// ---------- 验收 1：L2 动作 interrupt 挂起 → Web 审批 → resume，决定绑定 (run, tool_call) ----------

describe("审批回路：批准路径（FR-M3.5·FR-S2.4）", () => {
  test("L2 处挂起 awaiting_approval → 批准铸 ApprovalToken → resume 执行原 tool_call → run completed", async () => {
    const { db, audit, used, mint, executions, app } = makeApp();
    const runId = await startRun(app);

    // interrupt 挂起：run 停在 awaiting_approval（不吞错也不误杀）
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({
      status: "awaiting_approval",
    });

    // 审批卡 REST：pending 列表可见（m9 卡公开接口）
    const list = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    expect(list.statusCode).toBe(200);
    const card = list.json().approvals[0];
    expect(card).toMatchObject({
      run_id: runId,
      node: "execute_action",
      tool: "isolate_host",
      params: { host: "centos7" },
      status: "pending",
      executed: false,
    });
    expect(card.params_hash).toBe(paramsHash({ host: "centos7" }));

    // SSE 广播 approval_required（Web 审批页的数据源）
    expect(eventsAfter(db, runId, 0).some((e) => e.type === "approval_required")).toBe(true);

    // 值班长批准 → 铸一次性 ApprovalToken + resume
    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id as string}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(200);
    const body = apr.json() as { approval_token: string; run_id: string; run_status: string };
    expect(body.approval_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/);
    expect(body.run_id).toBe(runId);
    expect(body.run_status).toBe("completed");

    // 决定绑定原 (run, tool_call)：铸票请求带着原卡 id / 工具 / 参数
    expect(mint.calls[0]).toMatchObject({
      approvalId: card.id,
      tool: "isolate_host",
      approvedBy: "duty_lead",
    });
    // mock 动作执行到的就是原参数，且只执行了一次
    expect(executions).toEqual([{ host: "centos7" }]);

    // 一次性（INV-2）：jti 已焚毁登记，同 token 重放 → 闸 403 token_used
    const replay = verifyTicket(
      { name: "isolate_host", params: { host: "centos7" } },
      { approvalToken: body.approval_token, used },
      Math.floor(Date.now() / 1000),
      { hmacKey: KEY },
    );
    expect(replay).toEqual({ allow: false, code: 403, reason: "token_used" });

    // 卡状态：approved + 已执行；审批链审计齐全（INV-8：create→approve→execute）
    expect(db.prepare("SELECT status, approver, executed_at FROM approvals WHERE id = ?").get(card.id))
      .toMatchObject({ status: "approved", approver: "duty_lead" });
    const executedAt = (
      db.prepare("SELECT executed_at FROM approvals WHERE id = ?").get(card.id) as {
        executed_at: number;
      }
    ).executed_at;
    expect(executedAt).not.toBeNull();
    expect(
      audit.entries.filter((e) => e.objectType === "approval").map((e) => e.action),
    ).toEqual(["create", "approve", "execute"]);

    // SSE 全程可观察：approval_required → approval_decided → tool_call → tool_result
    const types = eventsAfter(db, runId, 0).map((e) => e.type);
    expect(types).toContain("approval_required");
    expect(types.indexOf("approval_decided")).toBeGreaterThan(types.indexOf("approval_required"));
    expect(types).toContain("tool_call");
    expect(types.indexOf("tool_result")).toBeGreaterThan(types.indexOf("tool_call"));
    await app.close();
  });

  test("换参数的 tool_call 不吃原决定：批准只绑定原参数，新参数要重新开卡（绑定锚）", async () => {
    const paramsRef = { current: { host: "centos7" } };
    const { db, executions, app } = makeApp({ paramsRef });
    const runId = await startRun(app);

    const list = await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    const cardA = list.json().approvals[0];

    // 捣乱者中途换参数：批准 A 之后 resume，节点提请的却是 B
    paramsRef.current = { host: "web-99" };
    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${cardA.id as string}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(200);
    expect(apr.json().run_status).toBe("awaiting_approval"); // B 没有决定 → 再挂起

    // A 的决定没有授权 B：没执行，只多了一张等审批的新卡
    expect(executions).toEqual([]);
    const pending = (
      (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string; params: { host: string } }[];
      }
    ).approvals;
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(cardA.id);
    expect(pending[0].params).toEqual({ host: "web-99" });
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({
      status: "awaiting_approval",
    });
    await app.close();
  });
});

// ---------- 验收 3（驳回半边）：驳回 → 不执行 + 审计 ----------

describe("审批回路：驳回路径（FR-S2.4）", () => {
  test("驳回 → 不铸票不执行，run completed（动作跳过），审计 reject 留痕", async () => {
    const { db, audit, mint, executions, app } = makeApp();
    const runId = await startRun(app);
    const card = (
      (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string }[];
      }
    ).approvals[0];

    const rej = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/reject`,
      payload: { approver: "duty_lead", reason: "证据不足，先补调查" },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json()).toMatchObject({ approval_id: card.id, run_id: runId, run_status: "completed" });

    // 不执行：mock 动作没跑，run 终态里留下「被驳回」的可观察残留
    expect(executions).toEqual([]);
    expect(mint.calls).toHaveLength(0); // 驳回不铸票
    const { state } = loadRunState(db, runId);
    expect(state.execution).toMatchObject({ executed: false, outcome: "rejected" });

    // 审计：create → reject，没有 execute；广播里有 approval_decided、没有 tool_call
    expect(
      audit.entries.filter((e) => e.objectType === "approval").map((e) => e.action),
    ).toEqual(["create", "reject"]);
    const types = eventsAfter(db, runId, 0).map((e) => e.type);
    expect(types).toContain("approval_decided");
    expect(types).not.toContain("tool_call");
    await app.close();
  });
});

// ---------- 验收 4：审批 interrupt 处杀 agent 进程重启，决定仍绑定原 (run, tool_call) ----------

describe("中断-恢复：杀进程重启（m3 卡测试计划·Tracecat 持久性语义）", () => {
  test("重启后 pending 卡还在，批准后 resume 绑定原 run/tool/参数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-approval-"));
    const dbPath = join(dir, "agent.sqlite");
    const executions: Record<string, unknown>[] = [];

    // —— 进程 1：跑到审批 interrupt 处「被杀」——
    const mint1 = makeFakeMint();
    const app1 = buildApp({
      db: openDb(dbPath),
      audit: new MemoryAuditSink(),
      nodes: l2Flow({ executions }),
      mint: mint1.client,
      burn: new MemoryBurnRegistry(),
      used: new MemoryBurnRegistry(),
      hmacKey: KEY,
    });
    const runId = await startRun(app1);
    const card = (
      (await app1.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string }[];
      }
    ).approvals[0];
    await app1.close(); // ← 进程消失；进程内一切（审批/焚毁/铸票记录）随之蒸发

    // —— 进程 2：同一份 SQLite，全新 app（全新 audit/mint/焚毁表）——
    const mint2 = makeFakeMint();
    const used2 = new MemoryBurnRegistry();
    const audit2 = new MemoryAuditSink();
    const app2 = buildApp({
      db: openDb(dbPath),
      audit: audit2,
      nodes: l2Flow({ executions }),
      mint: mint2.client,
      burn: used2,
      used: used2,
      hmacKey: KEY,
    });

    // pending 卡从盘上恢复：同一张卡，绑定同一个 run
    const list = await app2.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    expect(list.json().approvals.map((c: { id: string }) => c.id)).toEqual([card.id]);

    // 重启后批准：决定落在原 (run, tool_call) 上
    const apr = await app2.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(200);
    expect(apr.json()).toMatchObject({ run_id: runId, run_status: "completed" });

    // 铸票与执行都指向中断前的那次 tool_call
    expect(mint2.calls[0]).toMatchObject({ approvalId: card.id, tool: "isolate_host" });
    expect(executions).toEqual([{ host: "centos7" }]);
    expect(audit2.entries.some((e) => e.action === "approve" && e.objectId === card.id)).toBe(true);
    await app2.close();
  });
});

// ---------- 验收 5：并发审批后到者 409 ----------

describe("并发审批仲裁（PRD M10·INV-10 同源仲裁）", () => {
  test("approve 后再 approve/reject → 409 InvalidTransition；未知卡 404；缺 approver 400", async () => {
    const { app } = makeApp();
    const runId = await startRun(app);
    const card = (
      (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string }[];
      }
    ).approvals[0];

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(first.statusCode).toBe(200);

    // 两人同时批：后到者 409（此时 run 已被第一次批准推进，卡已裁决）
    const late = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "admin" },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("InvalidTransition");
    // 批完再驳同样 409：卡是单决媒体
    const lateRej = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/reject`,
      payload: { approver: "admin" },
    });
    expect(lateRej.statusCode).toBe(409);

    // 404 / 400 面
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/approvals/apr_nope/approve",
      payload: { approver: "duty_lead" },
    });
    expect(unknown.statusCode).toBe(404);
    const noApprover = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/reject`,
      payload: {},
    });
    expect(noApprover.statusCode).toBe(400);
    expect(runId).toBeTruthy();
    await app.close();
  });

  test("status 过滤参数非法 → 400（fail-closed：不静默当全量）", async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/approvals?status=whatever" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// ---------- 铸票失败与闸拒绝：两条 fail-closed 路（INV-1） ----------

describe("fail-closed 边界", () => {
  test("gateway 铸票失败 → 502 mint_failed，卡仍 pending 可重试（不留「已批准无票」悬置态）", async () => {
    const db = openDb(":memory:");
    const used = new MemoryBurnRegistry();
    const app = buildApp({
      db,
      audit: new MemoryAuditSink(),
      nodes: l2Flow({ executions: [] }),
      mint: {
        async mintApprovalToken() {
          throw new Error("gateway down");
        },
      },
      burn: used,
      used,
      hmacKey: KEY,
    });
    const runId = await startRun(app);
    const card = (
      (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string }[];
      }
    ).approvals[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("mint_failed");
    // 卡原封不动：仍 pending、run 仍 awaiting_approval——批准人可以重试
    const again = (
      (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string }[];
      }
    ).approvals;
    expect(again.map((c) => c.id)).toEqual([card.id]);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(runId)).toMatchObject({
      status: "awaiting_approval",
    });
    await app.close();
  });

  test("批准铸出的票过闸被拒（token_expired）→ 不执行 + DENIED 审计 + run failed（INV-1 fail-closed）", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const used = new MemoryBurnRegistry();
    const app = buildApp({
      db,
      audit,
      nodes: l2Flow({ executions: [] }),
      mint: makeFakeMint({ iatShift: -1000 }).client, // 铸出来就已过期（值班长姗姗来迟的极端形态）
      burn: used,
      used,
      hmacKey: KEY,
    });
    const runId = await startRun(app);
    const card = (
      (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string }[];
      }
    ).approvals[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${card.id}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run_status).toBe("failed"); // 闸拒了，强杀不吞错

    expect(db.prepare("SELECT status, fail_reason FROM runs WHERE id = ?").get(runId))
      .toMatchObject({ status: "failed", fail_reason: "node_error:execute_action" });
    const deny = audit.entries.find((e) => e.result === "DENIED");
    expect(deny).toMatchObject({
      action: "deny",
      objectType: "approval",
      objectId: card.id,
      details: { tool: "isolate_host", reason: "token_expired" },
    });
    await app.close();
  });
});

// ---------- resume 的状态门（INV-10：只有 awaiting_approval 能被 resume） ----------

describe("resumeRun 状态门", () => {
  test("queued / completed 的 run 不能 resume → 409 InvalidRunTransition；未知 run → 404", () => {
    const db = openDb(":memory:");
    const audit = { record: () => {} };
    const queued = createRun(db, { kind: "alert_flow", alertId: "al-1" }, {
      audit,
      requestId: "req-gate",
    });
    expect(() => resumeRun(db, queued.id, { audit, requestId: "req-gate" })).toThrow(
      InvalidRunTransitionError,
    );
    expect(() => resumeRun(db, "run_nope", { audit, requestId: "req-gate" })).toThrow(
      /not_found/,
    );
  });
});
