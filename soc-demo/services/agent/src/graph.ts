// 图执行器（m3 内部模块 graph 的薄径形态，票 10）：
//   run 生命周期 queued→running→(节点循环)→completed/failed，每步都有 SSE 事件 + 审计 +
//   checkpointer 信封。本票无 worker：THIN_ALERT_FLOW 只有确定性节点，直 END——先把
//   编排骨架（事件/检查点/状态机/兜底）跑通，票 13+ 在 route 节点接 worker 子图。
// 状态机之外的分支不存在：一切失败（节点抛错/资源兜底）都收敛到 running→failed。
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import { getRun, requireRun, saveProgress, transitionRun, type RunCtx, type RunRow } from "./runs.js";
import { emitEvent, type SseEventType } from "./events.js";
import { checkpoint } from "./checkpointer.js";
import type { Envelope } from "./envelope.js";
import { BudgetExceededError, budgetFromEnv, type RunBudget } from "./budget.js";
import type { AuditSink } from "./audit.js";

/** 节点执行上下文：worker/确定性节点拿到的全部能力。emit 供将来的 tool_call/tool_result
 *  事件用；charge/checkLlm 是资源兜底的计费口（真 LLM 适配器接上后必须走这两个口）。 */
export interface NodeCtx {
  runId: string;
  state: Record<string, unknown>;
  emit(type: SseEventType, payload: Record<string, unknown>): void;
  charge(tokens: number): void;
  checkLlm(startedAtMs: number, nowMs: number): void;
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

export interface ExecuteOpts {
  nodes?: FlowNode[];
  budget?: RunBudget;
  audit?: AuditSink;
  requestId?: string;
}

/** 跑一个 run 到终态。薄径为同步直跑（better-sqlite3 全同步、无真 LLM，微秒级完成）；
 *  接 worker/LLM 后换异步调度，本函数签名与兜底语义不变。
 *  任何失败都强杀成 failed 并落审计 + error 事件（不吞错，PRD 异常与边界）。 */
export function executeRun(db: DB, runId: string, opts: ExecuteOpts = {}): RunRow {
  const run = requireRun(db, runId);
  const actor = { type: "system", id: "m3:supervisor" } as const;
  const ctx: RunCtx = {
    audit: opts.audit ?? { record: () => {} }, // 不传审计 sink = 丢弃（仅测试便利）
    requestId: opts.requestId ?? randomUUID(),
    actor,
  };
  const nodes = opts.nodes ?? THIN_ALERT_FLOW;
  const budget = opts.budget ?? budgetFromEnv();

  // 审计 → SSE 的镜像：审计是真相源，事件流是它的广播（PRD §6-M3 事件类型含 audit）
  const mirrorAudit = (entry: Record<string, unknown>) => emitEvent(db, runId, "audit", entry);
  const transitionAndMirror = (to: RunRow["status"]) => {
    const from = (getRun(db, runId) as RunRow).status;
    const after = transitionRun(db, runId, to, ctx);
    mirrorAudit({ action: "update", result: "SUCCESS", status: { from, to } });
    return after;
  };

  let prevEnvelope: Envelope | null = null;
  let currentNode = "";
  try {
    transitionAndMirror("running");
    const state: Record<string, unknown> = { kind: run.kind, alert_id: run.alertId };
    const nctx: NodeCtx = {
      runId,
      state,
      emit: (type, payload) => void emitEvent(db, runId, type, payload),
      charge: (tokens) => budget.charge(tokens),
      checkLlm: (startedAtMs, nowMs) => budget.checkLlm(currentNode, startedAtMs, nowMs),
    };
    for (const node of nodes) {
      currentNode = node.name;
      emitEvent(db, runId, "node_enter", { node: node.name });
      budget.step(); // 资源兜底之一：max_steps（默认 20）
      node.run(nctx);
      emitEvent(db, runId, "node_exit", { node: node.name });
      // 每个节点跑完盖一个信封（链式：prev_hash 逐环相扣），resume 从末态恢复
      prevEnvelope = checkpoint(db, prevEnvelope, {
        runId,
        node: node.name,
        stateJson: JSON.stringify(state),
      });
      saveProgress(db, runId, budget.steps, budget.tokens);
    }
    transitionAndMirror("completed");
  } catch (e) {
    const kill = (failReason: string, details: Record<string, unknown>) => {
      saveProgress(db, runId, budget.steps, budget.tokens);
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
        node: currentNode || undefined,
      });
    } else {
      kill(`node_error:${currentNode}`, {
        code: "node_error",
        node: currentNode || undefined,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return getRun(db, runId) as RunRow;
}
