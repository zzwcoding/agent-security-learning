// 审批卡页的纯逻辑层（React 之外可单测）：
// - mergeApprovals：轮询拉回的卡列表按 id 去重合并（实时反馈的客户端一半）；
// - decideErrorText：批准/驳回失败的 ApiError → 人话（409 并发后到者是主角）。
// 409 从哪来：审批卡是「单决媒体」（statemachine.ts：pending 之外无路可走），
// 两人同时批同一张卡，先到者改状态，后到者在事务里撞 INV-10 → 409 InvalidTransition。
import type { ApprovalCard } from "./api";

/** 把新拉回的卡并进已有列表：同 id 以新数据为准（状态会翻），不同 id 合并；
 *  新到在上（createdAt 降序）。与 audit.ts 的 mergeAudit 同款套路，差别是
 *  审批卡状态会变——所以同 id 必须「覆盖」而不是「跳过」。 */
export function mergeApprovals(existing: ApprovalCard[], incoming: ApprovalCard[]): ApprovalCard[] {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** 裁决失败 → 页面上直接能念的提示。status 语义：
 *  - 409（并发后到者/卡已裁决）：正常剧情，提示后刷新列表即可；
 *  - 502（gateway 铸 ApprovalToken 失败）：卡还 pending，可重试；
 *  - 400/404/…：透传后端 error code。 */
export function decideErrorText(e: unknown): string {
  const status = typeof e === "object" && e !== null && "status" in e ? Number((e as { status: unknown }).status) : NaN;
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (status === 409) {
    return "手慢了：这张审批卡刚被别人裁决过（并发后到者 409），列表已刷新";
  }
  if (status === 502) {
    return "铸 ApprovalToken 失败（gateway 未起？）：卡仍是待审批，可重试";
  }
  return `裁决失败：${code || String(e)}`;
}

/** 卡状态 → antd Tag 颜色/文案（唯一渲染映射，页面不自己 if）。 */
export function statusTag(status: ApprovalCard["status"]): { color: string; text: string } {
  switch (status) {
    case "pending":
      return { color: "gold", text: "待审批" };
    case "approved":
      return { color: "green", text: "已批准" };
    case "rejected":
      return { color: "red", text: "已驳回" };
    case "expired": // 票 47：审批卡保质期到点，未被裁决即作废（对应 run 已 failed）
      return { color: "default", text: "已过期" };
    default:
      return { color: "default", text: status };
  }
}
