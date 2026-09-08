// 状态机迁移函数集中定义（m2 卡内部模块 statemachine）。
// 流转表唯一来源：CONTEXT.md 语义核心「状态机」；INV-10：表之外的变更一律抛错→409。
export const TRANSITIONS: Record<string, Record<string, string[]>> = {
  alert: {
    New: ["InProgress"],
    InProgress: ["Imported", "Closed"],
    Imported: [],
    Closed: ["InProgress"], // 重开（FR-M2.1，记审计）
  },
  case: {
    New: ["InProgress"],
    InProgress: ["Closed"],
    Closed: [],
  },
};

export class InvalidTransitionError extends Error {
  readonly code = "InvalidTransition";
  readonly httpStatus = 409;
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`InvalidTransition: ${entity} ${from} -> ${to}`);
    this.name = "InvalidTransition";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(entity: "alert" | "case", from: string, to: string): void {
  const legal = TRANSITIONS[entity]?.[from] ?? [];
  if (!legal.includes(to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}
