// run 状态机迁移函数集中定义（m3 内部，与 case-backend 的 statemachine 同款模式）。
// 流转表唯一来源：CONTEXT.md 语义核心「状态机」run 行；INV-10：表之外的变更一律抛错→409。
// awaiting_approval 本票没人走（审批回路是票 11），但表必须先和语义核心一字不差。
export const RUN_STATES = [
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
] as const;

export type RunStatus = (typeof RUN_STATES)[number];

export const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["running"],
  running: ["awaiting_approval", "completed", "failed"],
  awaiting_approval: ["running"],
  completed: [],
  failed: [],
};

export class InvalidRunTransitionError extends Error {
  readonly code = "InvalidTransition";
  readonly httpStatus = 409;
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`InvalidTransition: run ${from} -> ${to}`);
    this.name = "InvalidRunTransition";
    this.from = from;
    this.to = to;
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!(RUN_TRANSITIONS[from] ?? []).includes(to)) {
    throw new InvalidRunTransitionError(from, to);
  }
}

/** 终态（completed/failed）：SSE 流对终态 run 写完补发即收流；Web 据此决定要不要重连。 */
export function isTerminalRun(status: string): boolean {
  return status === "completed" || status === "failed";
}

// 审批卡状态机（票 11）：pending 是唯一可裁决态。裁决（approve/reject）是终局——
// 「审批卡是单决媒体」，并发审批后到者 409 就从这里来（PRD M10 异常与边界；
// 与 run 状态机同源仲裁：INV-10 表之外的变更一律抛错→409，不静默改写）。
export const APPROVAL_STATES = ["pending", "approved", "rejected"] as const;

export type ApprovalStatus = (typeof APPROVAL_STATES)[number];

export const APPROVAL_TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  pending: ["approved", "rejected"],
  approved: [],
  rejected: [],
};

export class InvalidApprovalTransitionError extends Error {
  readonly code = "InvalidTransition";
  readonly httpStatus = 409;
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`InvalidTransition: approval ${from} -> ${to}`);
    this.name = "InvalidApprovalTransition";
    this.from = from;
    this.to = to;
  }
}

export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!(APPROVAL_TRANSITIONS[from] ?? []).includes(to)) {
    throw new InvalidApprovalTransitionError(from, to);
  }
}
