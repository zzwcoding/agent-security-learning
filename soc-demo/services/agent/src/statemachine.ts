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
