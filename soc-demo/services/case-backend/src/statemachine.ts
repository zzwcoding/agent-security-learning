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
  // 票 17（INV-5）：知识条目 proposed → approved/rejected，人审是唯一迁移口；
  // 终态不可再迁移——表外变更一律 409（INV-10）
  kbentry: {
    proposed: ["approved", "rejected"],
    approved: [],
    rejected: [],
  },
  // 票 73（m2 假设实体，流转表唯一来源 = CONTEXT.md 语义核心 hypothesis 行）：
  // proposed→hunting（hunt_flow 首轮开始时前置，行为约定 1）；hunting 的三个出路
  // concluded/refuted/cancelled 全由编排循环驱动；终态不可回退——表外变更一律 409
  //（INV-10；取消四因 user_cancelled/planner_broken/spin/budget 是 cancelled 的
  // 原因标注，不是独立状态）。
  hypothesis: {
    proposed: ["hunting"],
    hunting: ["concluded", "refuted", "cancelled"],
    concluded: [],
    refuted: [],
    cancelled: [],
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

export function assertTransition(
  entity: "alert" | "case" | "kbentry" | "hypothesis",
  from: string,
  to: string,
): void {
  const legal = TRANSITIONS[entity]?.[from] ?? [];
  if (!legal.includes(to)) {
    throw new InvalidTransitionError(entity, from, to);
  }
}
