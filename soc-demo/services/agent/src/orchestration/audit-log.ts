// m14 编排循环 · 五要素审计出口（票 74 从 flow.ts 上提为独立小件）。
//
// planner 节点体（planner.ts）与轮次链图（flow.ts）都要落 INV-8 审计——放任一边都会
// 造成机制目录内循环 import，故独立成件：谁消费谁 import，方向单向（flow → planner、
// flow → audit-log、planner → audit-log）。
//
// 五要素（INV-8）：actor/objectId/objectType/details + requestId/createdAt/result。
// 带 run 关联的 requestId（hunt_<run_id>，异步执行无 HTTP 头可借，dispatch_* 同款口径）。
import type { AuditSink } from "../audit.js";

export const HUNT_ACTOR = { type: "agent", id: "agent:hunt_flow" } as const;

export function recordAudit(
  audit: AuditSink,
  runId: string,
  entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  },
): void {
  audit.record({ ...entry, actor: HUNT_ACTOR, requestId: `hunt_${runId}`, createdAt: Date.now() });
}
