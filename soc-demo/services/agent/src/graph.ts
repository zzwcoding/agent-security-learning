// 图执行器（m3 内部模块 graph）。票 10 落了薄径：run 生命周期 queued→running→(节点循环)
// →completed/failed，每步都有 SSE 事件 + 审计 + checkpointer 信封。票 11 在循环里接入
// 审批回路：节点走到 L2 动作时经 awaitApproval() 开卡挂起（run→awaiting_approval），
// 值班长在审批卡 REST 上裁决后经 resumeRun() 从信封链末态续跑——「决定绑定 (run,
// tool_call)」由审批卡字段定位（见 approvals.ts）。执行一律过 verifyTicket 闸 + 用后焚毁
// （INV-2/INV-3），闸拒则强杀不吞错（INV-1）。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { getRun, requireRun, saveProgress, transitionRun, type RunCtx, type RunRow } from "./runs.js";
import { emitEvent, type SseEventType } from "./events.js";
import { checkpoint, resumeRun as restoreCheckpoint } from "./checkpointer.js";
import type { Envelope } from "./envelope.js";
import { BudgetExceededError, budgetFromEnv, type RunBudget } from "./budget.js";
import type { AuditSink } from "./audit.js";
import { findDecidableCard, markApprovalExecuted, openApprovalCard } from "./approvals.js";
import {
  paramsHash,
  verifyTicket,
  type ApprovalClaims,
  type BurnRegistry,
} from "./verify-ticket.js";
import type { TokenBurner } from "./token-ports.js";
import { InvalidRunTransitionError } from "./statemachine.js";

/** 节点执行上下文：worker/确定性节点拿到的全部能力。emit 供 tool_call/tool_result 事件用；
 *  charge/checkLlm 是资源兜底的计费口（真 LLM 适配器接上后必须走这两个口）；
 *  executeApproved 是 L2 动作的唯一正门：开卡挂起 → 值班长批准 → 闸验签 → 执行 → 焚毁。 */
export interface NodeCtx {
  runId: string;
  state: Record<string, unknown>;
  emit(type: SseEventType, payload: Record<string, unknown>): void;
  charge(tokens: number): void;
  checkLlm(startedAtMs: number, nowMs: number): void;
  /** L2 审批闸口：首次调用开卡并中断本 run（awaiting_approval）；resume 后再进来时
   *  按卡上的决定返回。驳回 → {approved:false}。 */
  awaitApproval(tool: string, params: unknown, opts?: ApproveOpts): ApprovalDecision;
  /** L2 动作全程：awaitApproval 拿决定 → 驳回直接返回不执行 → 批准则过验票闸执行
   *  action → 焚毁登记 + 执行标记。闸拒（票过期/参数被换/重放）抛错强杀，绝不带病执行。 */
  executeApproved(
    tool: string,
    params: unknown,
    opts: ApproveOpts,
    action: (params: unknown) => Record<string, unknown>,
  ): ExecutionOutcome;
}

export interface ApproveOpts {
  reason?: string;
  caseId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  approvalId: string;
  /** 批准时铸出的 ApprovalToken wire 串（验票闸唯一依据，INV-9：验签不信文本）。 */
  token?: string;
}

export type ExecutionOutcome =
  | { executed: true; approvalId: string; jti: string; result: Record<string, unknown> }
  | { executed: false; outcome: "rejected"; approvalId: string };

/** 中断控制流：awaitApproval 开完卡抛出，runner 捕获后原地收手——不是错误，是挂起。 */
class ApprovalInterrupt extends Error {
  constructor(readonly approvalId: string) {
    super(`approval_interrupt: ${approvalId}`);
    this.name = "ApprovalInterrupt";
  }
}

export interface FlowNode {
  name: string;
  run(ctx: NodeCtx): void;
}

// PRD 图：alert_flow: intake(已落库) → triage → …。薄径只保留确定性节点：
export const THIN_ALERT_FLOW: FlowNode[] = [
  {
    name: "intake",
    // 交接上下文确认（PRD：状态信封只携带 case_id/alert_id/run_id/ticket）——
    // 真正读 M2 告警、拉起分诊子图是票 13 的事
    run: (ctx) => {
      if (!ctx.state.alert_id) throw new Error("missing alert_id in handoff state");
    },
  },
  {
    name: "route",
    // supervisor 的路由点：本票无 worker 注册，直 END；后续票在这里路由到 triage 子图
    run: (ctx) => {
      ctx.state.route = "end";
    },
  },
];

// 票 11 演示布景：带一个 L2 动作的最小 alert_flow（调查建议遏制 → isolate_host）。
// AGENT_FLOW=approval_demo 时 index.ts 挂它，curl 就能走通「挂起 → 审批 → resume」全回路；
// mock 执行只写状态与审计（PRD §11：响应动作一律 mock，不对接真实 EDR）。
export const APPROVAL_DEMO_FLOW: FlowNode[] = [
  {
    name: "response_advice",
    run: (ctx) => {
      ctx.state.recommendation = { tool: "isolate_host", params: { host: "centos7" } };
    },
  },
  {
    name: "execute_action",
    run: (ctx) => {
      const out = ctx.executeApproved(
        "isolate_host",
        { host: "centos7" },
        { reason: "调查报告建议遏制" },
        (p) => ({ mock_edr: "isolated", host: (p as { host: string }).host }),
      );
      ctx.state.execution = out;
    },
  },
];

export interface ExecuteOpts {
  nodes?: FlowNode[];
  budget?: RunBudget;
  audit?: AuditSink;
  requestId?: string;
  /** L2 执行后的焚毁登记口（INV-2；生产 = HttpTokenBurner → M2 used_tokens）。 */
  burn?: TokenBurner;
  /** L2 执行前验票闸的重放读口（INV-2；不传 = 不查，测试便利，生产接 M2 后换 adapter）。 */
  used?: BurnRegistry;
  /** 验票 HMAC 密钥（缺省读 env SOC_HMAC_KEY，与闸同口径）。 */
  hmacKey?: string;
}

interface DriveDeps {
  ctx: RunCtx;
  nodes: FlowNode[];
  budget: RunBudget;
  burn?: TokenBurner;
  used?: BurnRegistry;
  hmacKey?: string;
}

function makeDeps(opts: ExecuteOpts): DriveDeps {
  return {
    ctx: {
      audit: opts.audit ?? { record: () => {} }, // 不传审计 sink = 丢弃（仅测试便利）
      requestId: opts.requestId ?? randomUUID(),
      actor: { type: "system", id: "m3:supervisor" },
    },
    nodes: opts.nodes ?? THIN_ALERT_FLOW,
    budget: opts.budget ?? budgetFromEnv(),
    burn: opts.burn,
    used: opts.used,
    hmacKey: opts.hmacKey,
  };
}

/** 跑节点循环直到终态或挂起。任何失败都强杀成 failed 并落审计 + error 事件（不吞错）；
 *  ApprovalInterrupt 例外——挂起不是失败，卡已开、run 已在 awaiting_approval，原地返回。 */
function drive(db: DB, runId: string, deps: DriveDeps, start: {
  state: Record<string, unknown>;
  startIndex: number;
  prevEnvelope: Envelope | null;
}): RunRow {
  const { ctx, nodes, budget } = deps;
  const actor = ctx.actor ?? { type: "system", id: "m3:supervisor" };
  // 审计 → SSE 的镜像：审计是真相源，事件流是它的广播（PRD §6-M3 事件类型含 audit）
  const mirrorAudit = (entry: Record<string, unknown>) => emitEvent(db, runId, "audit", entry);
  const transitionAndMirror = (to: RunRow["status"]) => {
    const from = (getRun(db, runId) as RunRow).status;
    transitionRun(db, runId, to, ctx);
    mirrorAudit({ action: "update", result: "SUCCESS", status: { from, to } });
  };

  let prev = start.prevEnvelope;
  let completed = start.startIndex; // run.steps 口径 = 跑完的节点数（挂起的节点不算）
  const cursor = { node: "" };
  const state = start.state;

  // L2 审批闸口的两段式（Tracecat interrupt 语义：resume 后节点重跑，interrupt 处拿到决定）
  const awaitApproval = (tool: string, params: unknown, opts: ApproveOpts): ApprovalDecision => {
    const existing = findDecidableCard(db, runId, tool, paramsHash(params));
    if (existing?.status === "rejected") return { approved: false, approvalId: existing.id };
    if (existing?.status === "approved" && existing.token) {
      return { approved: true, approvalId: existing.id, token: existing.token };
    }
    // pending = 决定还没落（重启后批准前的重入），幂等再中断，不重复开卡
    const card = existing ?? openApprovalCard(db, {
      runId,
      node: cursor.node,
      tool,
      params,
      caseId: opts.caseId ?? null,
      reason: opts.reason ?? null,
    }, ctx);
    throw new ApprovalInterrupt(card.id);
  };

  const executeApproved: NodeCtx["executeApproved"] = (tool, params, opts, action) => {
    const decision = awaitApproval(tool, params, opts);
    if (!decision.approved || !decision.token) {
      return { executed: false, outcome: "rejected", approvalId: decision.approvalId };
    }
    emitEvent(db, runId, "tool_call", {
      node: cursor.node,
      tool,
      params_hash: paramsHash(params),
      approval_id: decision.approvalId,
    });
    const verdict = verifyTicket(
      { name: tool, params },
      { approvalToken: decision.token, caseId: opts.caseId, used: deps.used },
      Math.floor(Date.now() / 1000),
      { hmacKey: deps.hmacKey },
    );
    if (!verdict.allow) {
      // 闸拒 = 授权链有缺口（票过期/参数被换/重放），fail-closed：审计 DENIED 后强杀
      ctx.audit.record({
        action: "deny",
        actor,
        objectId: decision.approvalId,
        objectType: "approval",
        details: { tool, reason: verdict.reason, params_hash: paramsHash(params) },
        requestId: ctx.requestId,
        result: "DENIED",
        createdAt: Date.now(),
      });
      throw new Error(`approval_gate_denied:${verdict.reason}`);
    }
    const jti = (verdict.payload as ApprovalClaims).jti;
    const result = action(params);
    deps.burn?.burn(jti, "approval"); // INV-2：用后即焚（生产 = M2 used_tokens）
    markApprovalExecuted(db, decision.approvalId, jti, ctx);
    emitEvent(db, runId, "tool_result", {
      node: cursor.node,
      tool,
      ok: true,
      approval_id: decision.approvalId,
      result,
    });
    return { executed: true, approvalId: decision.approvalId, jti, result };
  };

  const nctx: NodeCtx = {
    runId,
    state,
    emit: (type, payload) => void emitEvent(db, runId, type, payload),
    charge: (tokens) => budget.charge(tokens),
    checkLlm: (startedAtMs, nowMs) => budget.checkLlm(cursor.node, startedAtMs, nowMs),
    awaitApproval,
    executeApproved,
  };

  try {
    transitionAndMirror("running");
    for (const node of nodes.slice(start.startIndex)) {
      cursor.node = node.name;
      emitEvent(db, runId, "node_enter", { node: node.name });
      budget.step(); // 资源兜底之一：max_steps（默认 20）
      node.run(nctx);
      emitEvent(db, runId, "node_exit", { node: node.name });
      // 每个节点跑完盖一个信封（链式：prev_hash 逐环相扣），resume 从末态恢复
      prev = checkpoint(db, prev, {
        runId,
        node: node.name,
        stateJson: JSON.stringify(state),
      });
      completed += 1;
      saveProgress(db, runId, completed, budget.tokens);
    }
    transitionAndMirror("completed");
  } catch (e) {
    if (e instanceof ApprovalInterrupt) {
      saveProgress(db, runId, completed, budget.tokens); // 挂起前的计费照记（token 兜底跨 resume 连续）
      return getRun(db, runId) as RunRow;
    }
    const kill = (failReason: string, details: Record<string, unknown>) => {
      saveProgress(db, runId, completed, budget.tokens);
      transitionRun(db, runId, "failed", ctx, failReason);
      ctx.audit.record({
        action: "kill",
        actor,
        objectId: runId,
        objectType: "run",
        details: { ...details, status: { from: "running", to: "failed" } },
        requestId: ctx.requestId,
        result: "FAILURE",
        createdAt: Date.now(),
      });
      emitEvent(db, runId, "error", details); // 资源兜底触发要 Web 可见（PRD 异常与边界）
    };
    if (e instanceof BudgetExceededError) {
      kill(`budget_exceeded:${e.kind}`, {
        code: "budget_exceeded",
        kind: e.kind,
        limit: e.limit,
        used: e.used,
        node: cursor.node || undefined,
      });
    } else {
      kill(`node_error:${cursor.node}`, {
        code: "node_error",
        node: cursor.node || undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return getRun(db, runId) as RunRow;
}

/** 跑一个 run 到终态（从 queued 开跑）。薄径为同步直跑（better-sqlite3 全同步、无真 LLM，
 *  微秒级完成）；接 worker/LLM 后换异步调度，本函数签名与兜底语义不变。 */
export function executeRun(db: DB, runId: string, opts: ExecuteOpts = {}): RunRow {
  const run = requireRun(db, runId);
  return drive(db, runId, makeDeps(opts), {
    state: { kind: run.kind, alert_id: run.alertId },
    startIndex: 0,
    prevEnvelope: null,
  });
}

/** 审批 resume（票 11）：从信封链末态续跑挂起的 run。只有 awaiting_approval 能被
 *  resume（INV-10 状态门）；信封链复核失败 → 拒绝恢复 + 审计 FAILURE（FR-M3.3）；
 *  兜底口径（steps/tokens）从 run 行接续，不因重启清零。 */
export function resumeRun(db: DB, runId: string, opts: ExecuteOpts = {}): RunRow {
  const run = requireRun(db, runId);
  if (run.status !== "awaiting_approval") {
    throw new InvalidRunTransitionError(run.status, "running");
  }
  const deps = makeDeps(opts);
  // 先验货再放行：链被动时状态原样不动（checkpointer 里已落审计 FAILURE）
  const restored = restoreCheckpoint(db, runId, {
    audit: deps.ctx.audit,
    requestId: deps.ctx.requestId,
  });
  deps.budget.steps = run.steps;
  deps.budget.tokens = run.tokensUsed;
  return drive(db, runId, deps, {
    state: restored.envelopes.length
      ? restored.state
      : { kind: run.kind, alert_id: run.alertId },
    startIndex: Math.min(run.steps, deps.nodes.length),
    prevEnvelope: restored.envelopes.at(-1) ?? null,
  });
}
