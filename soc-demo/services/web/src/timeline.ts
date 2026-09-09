// 案件时间线装配（FR-M10.4 的纯函数层，React 之外可单测）。
//
// 「时间线」从哪来？两路公开数据，页面把它们合成一条：
// ① M2 timeline_entries（GET /api/v1/cases/:id 的 timeline 字段）——worker 们写的
//    系统条目/调查报告/富化报告（kind 是写入口透传的，读什么渲染什么）；
// ② agent 审批卡 REST（GET /api/v1/approvals）里 case_id 对得上的卡——审批与执行
//    条目不另立数据源：审批卡（INV-8 有全链审计）本来就是这些动作的事实来源。
// 原则：不猜时间。每行的 ts 都来自数据本身的 created_at/decided_at；执行的
// 「已执行」标记并进审批行文案（wire 只有 executed 布尔，没有执行时间戳，编一个
// 就是造假）。
import type { ApprovalCard, CaseDetail, TimelineEntry } from "./api";

export interface TimelineRow {
  key: string;
  ts: number;
  /** system / investigation_report / enrichment_report / approval */
  kind: string;
  label: string;
  color: string;
  title: string;
  body: string;
  /** 富化条目才有：taxonomy 四档标签序列（info/safe/suspicious/malicious + refused） */
  levels?: string[];
}

const KIND_META: Record<string, { label: string; color: string }> = {
  system: { label: "系统", color: "default" },
  investigation_report: { label: "调查报告", color: "blue" },
  enrichment_report: { label: "富化报告", color: "purple" },
  approval: { label: "审批", color: "gold" },
};

function metaOf(kind: string): { label: string; color: string } {
  // 没见过的 kind 不瞎翻译：原样当标签（worker 写什么透传什么）
  return KIND_META[kind] ?? { label: kind, color: "default" };
}

/** 富化 structured（enrichment/report.ts ReportInput）→ 四档标签序列。
 *  没外发的行给 refused——「为什么只有 N 项有评级」的对账。 */
function levelsOf(structured: unknown): string[] | undefined {
  const results = (structured as { results?: { ok?: boolean; level?: string }[] } | null | undefined)
    ?.results;
  if (!Array.isArray(results)) return undefined;
  return results.map((r) => (r.ok ? (r.level ?? "info") : "refused"));
}

function entryRow(e: TimelineEntry): TimelineRow {
  const meta = metaOf(e.kind);
  const levels = e.kind === "enrichment_report" ? levelsOf(e.structured) : undefined;
  return {
    key: e.id,
    ts: e.created_at,
    kind: e.kind,
    label: meta.label,
    color: meta.color,
    title: `${meta.label} · ${e.author}`,
    body: e.body,
    ...(levels ? { levels } : {}),
  };
}

function approvalRows(c: ApprovalCard): TimelineRow[] {
  const meta = metaOf("approval");
  if (c.status === "pending") {
    return [{
      key: c.id,
      ts: c.createdAt,
      kind: "approval",
      label: meta.label,
      color: meta.color,
      title: `审批卡：${c.tool} 等待值班长裁决`,
      body: c.reason ?? "",
    }];
  }
  const decided = [
    {
      key: c.id,
      ts: c.decidedAt ?? c.createdAt,
      kind: "approval",
      label: meta.label,
      color: meta.color,
      title: c.status === "approved"
        ? `审批卡：${c.tool} 已批准（${c.approver ?? "?"}）${c.executed ? " · 已执行（一次性 token 用后即焚）" : " · 待执行"}`
        : `审批卡：${c.tool} 已驳回（${c.approver ?? "?"}）`,
      body: c.status === "rejected" ? (c.rejectReason ?? "") : (c.reason ?? ""),
    },
  ];
  return decided;
}

/** 详情里的 timeline 条目 + 该案件的审批卡 → 按时间升序的一条时间线。 */
export function assembleTimeline(d: CaseDetail, approvals: ApprovalCard[]): TimelineRow[] {
  const fromTimeline = (d.timeline ?? []).map(entryRow);
  const fromApprovals = approvals
    .filter((c) => c.caseId === d.id)
    .flatMap(approvalRows);
  return [...fromTimeline, ...fromApprovals].sort((a, b) => a.ts - b.ts);
}
