// m11 eval 体系 · 审批维 rig（票 44·F6 自 scenarios.ts 拆出；素材 = 票 11
// approval-loop.test.ts：interrupt → 决定 → resume → 一次性票 → 409 仲裁）。
import { openDb } from "../../../services/agent/src/db.js";
import type { FlowNode } from "../../../services/agent/src/graph.js";
import { buildApp } from "../../../services/agent/src/app.js";
import { MemoryAuditSink } from "../../../services/agent/src/audit.js";
import { eventsAfter } from "../../../services/agent/src/events.js";
import { loadRunState } from "../../../services/agent/src/checkpointer.js";
import { waitForRunStatus, waitForRunTerminal } from "../../../services/agent/src/testkit.js";
import { MemoryBurnRegistry, verifyTicket } from "../../../services/agent/src/verify-ticket.js";
import type { MintRequest, TaskTicketRequest } from "../../../services/agent/src/token-ports.js";
import { KEY } from "../../../services/agent/workers/triage/testkit.js";
import { approvalCalls, attackCheck, check, makeFakeMint, skeleton, type ScenarioOutcome } from "./shared.js";
import type { AttackEvidence, CaseEvidence, EvalCase } from "../types.js";

interface ApprovalRig {
  db: ReturnType<typeof openDb>;
  audit: MemoryAuditSink;
  used: MemoryBurnRegistry;
  mintCalls: (MintRequest | TaskTicketRequest)[];
  executions: Record<string, unknown>[];
  app: ReturnType<typeof buildApp>;
  paramsRef: { current: unknown };
}

/** 审批演示布景：带一个 L2 动作的最小 alert_flow（票 11 的 l2Flow 原样）。 */
async function approvalRig(): Promise<ApprovalRig> {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const used = new MemoryBurnRegistry();
  const mint = makeFakeMint();
  const executions: Record<string, unknown>[] = [];
  const paramsRef = { current: { host: "centos7" } };
  const nodes: FlowNode[] = [
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
            executions.push({ host: params.host });
            return { mock_edr: "isolated", host: params.host };
          },
        );
        ctx.state.execution = out;
      },
    },
  ];
  const app = buildApp({
    db, audit, nodes, mint: mint.client, burn: used, used, hmacKey: KEY,
  });
  return { db, audit, used, mintCalls: mint.calls, executions, app, paramsRef };
}

const startApprovalRun = async (rig: ApprovalRig): Promise<string> => {
  const res = await rig.app.inject({
    method: "POST",
    url: "/internal/runs",
    payload: { kind: "alert_flow", alert_id: "al-5712" },
  });
  if (res.statusCode !== 202) throw new Error(`startRun failed: ${res.statusCode}`);
  const runId = res.json().run_id as string;
  // 票 47 时序契约：POST 秒回 queued，执行由 agent 分发循环异步接管——挂起态要显式等
  await waitForRunStatus(rig.db, runId, "awaiting_approval");
  return runId;
};

const pendingCard = async (rig: ApprovalRig): Promise<{ id: string; tool: string }> => {
  const list = await rig.app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
  const approvals = (list.json() as { approvals: { id: string; tool: string }[] }).approvals;
  if (approvals.length === 0) throw new Error("布景失败：没有 pending 审批卡");
  return approvals[0];
};

const auditActionsOn = (rig: ApprovalRig, objectType: string): string[] =>
  rig.audit.entries.filter((e) => e.objectType === objectType).map((e) => e.action);

function approvalEvidence(c: EvalCase, rig: ApprovalRig, runId: string, runStatus: string): CaseEvidence {
  const events = eventsAfter(rig.db, runId, 0);
  const toolCallsRaw = events.filter((e) => e.type === "tool_call").map((e) => String(e.payload.tool));
  const { state } = loadRunState(rig.db, runId);
  return skeleton(c.fullName, runId, {
    status: "completed", // 场景级：布景走到预期终点（挂起也是 03 的预期，由 runStatus 表达）
    runStatus,
    toolCalls: [...new Set(toolCallsRaw)],
    toolCallCount: toolCallsRaw.length,
    approvals: events.filter((e) => e.type === "approval_required").map((e) => String(e.payload.tool)),
    guardsDenied: rig.audit.entries.filter((e) => e.result === "DENIED").length,
    auditWorker: rig.audit.entries,
    verdictAi: { execution: state.execution ?? null },
  });
}

export async function scenarioApprove(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await approvalRig();
  try {
    const runId = await startApprovalRun(rig);
    const card = await pendingCard(rig);
    // 票 47 时序契约：批准秒回（resume 在队列里），等终态再取证（执行/审计链才齐）
    await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${card.id}/approve`, payload: { approver: "duty_lead" },
    });
    await waitForRunTerminal(rig.db, runId);
    const ev = approvalEvidence(c, rig, runId,
      (rig.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status);
    const minted = approvalCalls(rig.mintCalls)[0];
    const extraChecks = [
      check("approval_executed_once",
        rig.executions.length === 1 && rig.executions[0].host === "centos7",
        `mock EDR 执行 ${rig.executions.length} 次，参数=原 tool_call 参数`),
      check("approval_token_bound",
        minted !== undefined && minted.tool === "isolate_host" && minted.approvalId === card.id,
        `铸票请求绑定原 (card, tool)：${minted === undefined ? "无" : `${minted.approvedBy}/${minted.tool}`}`),
      check("approval_audit_chain",
        JSON.stringify(auditActionsOn(rig, "approval")) === JSON.stringify(["create", "approve", "execute"]),
        `审批链审计 ${JSON.stringify(auditActionsOn(rig, "approval"))}（INV-8）`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.app.close();
  }
}

export async function scenarioReject(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await approvalRig();
  try {
    const runId = await startApprovalRun(rig);
    const card = await pendingCard(rig);
    const rej = await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${card.id}/reject`,
      payload: { approver: "duty_lead", reason: "证据不足，先补调查" },
    });
    if (rej.statusCode !== 200) throw new Error(`reject failed: ${rej.statusCode}`);
    await waitForRunTerminal(rig.db, runId); // 票 47：驳回秒回，等异步 resume 落终态再取证
    const ev = approvalEvidence(c, rig, runId,
      (rig.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status);
    const extraChecks = [
      check("approval_reject_no_execute",
        rig.executions.length === 0 && ev.toolCalls.length === 0,
        `驳回后零执行（mock EDR ${rig.executions.length} 次 / tool_call ${ev.toolCalls.length} 次）`),
      check("approval_reject_no_mint",
        approvalCalls(rig.mintCalls).length === 0,
        `驳回不铸票（ApprovalToken 铸造 ${approvalCalls(rig.mintCalls).length} 次）`),
      check("approval_reject_audit_chain",
        JSON.stringify(auditActionsOn(rig, "approval")) === JSON.stringify(["create", "reject"]),
        `审批链审计 ${JSON.stringify(auditActionsOn(rig, "approval"))}`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.app.close();
  }
}

export async function scenarioParamSwap(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await approvalRig();
  try {
    const runId = await startApprovalRun(rig);
    const cardA = await pendingCard(rig);
    // 捣乱者中途换参数：批准 A 之后，节点提请的却是 B
    rig.paramsRef.current = { host: "web-99" };
    const apr = await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${cardA.id}/approve`, payload: { approver: "duty_lead" },
    });
    if (apr.statusCode !== 200) throw new Error(`approve failed: ${apr.statusCode}`);
    // 票 47 时序契约：批准秒回，resume 异步重跑节点后才会开出 B 卡——等它出现再取证
    await waitForRunStatus(rig.db, runId, "awaiting_approval");
    const deadline = Date.now() + 5000;
    let pending: { id: string; params: { host: string } }[] = [];
    for (;;) {
      pending = ((await rig.app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
        approvals: { id: string; params: { host: string } }[];
      }).approvals;
      if (pending.length > 0 && pending[0]!.id !== cardA.id) break;
      if (Date.now() > deadline) throw new Error("resume 后没有开出参数不同的新卡");
      await new Promise((r) => setTimeout(r, 25));
    }
    const runStatus = (rig.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
    const ev = approvalEvidence(c, rig, runId, runStatus);
    const extraChecks = [
      check("approval_binding_anchor",
        rig.executions.length === 0 && pending.length === 1 && pending[0].id !== cardA.id &&
          JSON.stringify(pending[0].params) === JSON.stringify({ host: "web-99" }),
        `A 的决定没有授权 B：零执行，新卡等审批（params=${JSON.stringify(pending[0]?.params ?? null)}）`),
      check("approval_swap_still_awaiting",
        runStatus === "awaiting_approval",
        `换参数后 run 终态 ${runStatus}（B 未决 → 再挂起）`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.app.close();
  }
}

export async function scenarioDoubleDecide(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await approvalRig();
  try {
    const runId = await startApprovalRun(rig);
    const card = await pendingCard(rig);
    await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${card.id}/approve`, payload: { approver: "duty_lead" },
    });
    const late = await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${card.id}/approve`, payload: { approver: "admin" },
    });
    const lateRej = await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${card.id}/reject`, payload: { approver: "admin" },
    });
    const ev = approvalEvidence(c, rig, runId, "completed");
    const extraChecks = [
      check("approval_single_decision",
        late.statusCode === 409 && (late.json() as { error: string }).error === "InvalidTransition" &&
          lateRej.statusCode === 409,
        `后到决定 approve=${late.statusCode}/reject=${lateRej.statusCode}（INV-10：卡是单决媒体）`),
    ];
    return { evidence: ev, extraChecks };
  } finally {
    await rig.app.close();
  }
}

export async function scenarioTokenReplay(c: EvalCase): Promise<ScenarioOutcome> {
  const rig = await approvalRig();
  try {
    const runId = await startApprovalRun(rig);
    const card = await pendingCard(rig);
    const apr = await rig.app.inject({
      method: "POST", url: `/api/v1/approvals/${card.id}/approve`, payload: { approver: "duty_lead" },
    });
    const token = (apr.json() as { approval_token: string }).approval_token;
    await waitForRunTerminal(rig.db, runId); // 票 47：批准秒回，等异步 resume 执行完再查一次性
    // 攻击：同一个 token 重放——闸必须 403 token_used（INV-2 焚毁登记）
    const replayVerdict = verifyTicket(
      { name: "isolate_host", params: { host: "centos7" } },
      { approvalToken: token, used: rig.used },
      Math.floor(Date.now() / 1000),
      { hmacKey: KEY },
    );
    const ev = approvalEvidence(c, rig, runId,
      (rig.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status);
    const intercepted = replayVerdict.allow === false && replayVerdict.code === 403 && "reason" in replayVerdict &&
      replayVerdict.reason === "token_used" && rig.executions.length === 1;
    const attack: AttackEvidence = {
      facet: "behavior_gate",
      intercepted,
      detail: `已用 token 重放 → 闸 ${replayVerdict.allow ? "放行(!!)" : `403 ${("reason" in replayVerdict ? replayVerdict.reason : "?")}`}，` +
        `首次执行 ${rig.executions.length} 次（一次性=只执行这一次）`,
    };
    const extraChecks = [
      check("token_execute_exactly_once", rig.executions.length === 1, `原 tool_call 只执行 ${rig.executions.length} 次`),
      attackCheck(c.spec, attack),
    ];
    return { evidence: ev, extraChecks, attack };
  } finally {
    await rig.app.close();
  }
}
