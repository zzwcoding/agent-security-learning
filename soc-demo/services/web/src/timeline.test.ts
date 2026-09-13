// 案件时间线装配单测（FR-M10.4：详情 + timeline（调查报告/富化四档标签/审批/执行条目））。
// 装配 = 两路公开数据合成一条时间线：M2 timeline_entries（worker 写的报告/系统条目）
// + agent 审批卡 REST 里该案件的卡（审批/执行条目）。不猜时间：每行 ts 都来自数据本身。
import { describe, expect, it } from "vitest";
import type { ApprovalCard, CaseDetail, TimelineEntry } from "./api";
import { assembleTimeline } from "./timeline";

function detail(over: Partial<CaseDetail> = {}): CaseDetail {
  return {
    id: "case_000001", number: 1, title: "[ssh] - centos7 - 2026-09-01",
    description: "", severity: 3, tlp: 2, pap: 2, status: "Open",
    verdict: null, verdictNote: null, assignee: null, tags: [],
    linkedAlerts: ["al_1"], startDate: 100, endDate: null, intakeSource: "auto_pipeline",
    hypothesisId: null, // 票 82：m2 cases wire 新增的假设锚（本件无锚）
    observables: [], timeline: [],
    ...over,
  };
}

function entry(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    id: "t1", case_id: "case_000001", kind: "system", author: "system",
    body: "case created from alert al_1", structured: null, created_at: 100,
    ...over,
  };
}

function card(over: Partial<ApprovalCard>): ApprovalCard {
  return {
    id: "apr_1", runId: "run_1", node: "execute_action", tool: "isolate_host",
    params: { host: "centos7" }, paramsHash: "h", caseId: "case_000001",
    reason: "调查报告建议遏制", status: "pending", approver: null, rejectReason: null,
    executed: false, createdAt: 500, decidedAt: null,
    ...over,
  };
}

describe("assembleTimeline", () => {
  it("timeline 条目 → 行：kind 有中文标签；按时间升序", () => {
    const rows = assembleTimeline(
      detail({
        timeline: [
          entry({ id: "t2", kind: "investigation_report", author: "agent:investigation", body: "## 调查报告", created_at: 300 }),
          entry({ id: "t1", kind: "system", created_at: 100 }),
        ],
      }),
      [],
    );
    expect(rows.map((r) => r.ts)).toEqual([100, 300]);
    expect(rows[0].label).toBe("系统");
    expect(rows[1].label).toBe("调查报告");
    expect(rows[1].body).toBe("## 调查报告");
    expect(rows[1].levels).toBeUndefined(); // 非富化条目没有标签
  });

  it("富化条目从 structured.results 提取四档标签（含 refused）", () => {
    const rows = assembleTimeline(
      detail({
        timeline: [
          entry({
            id: "t3", kind: "enrichment_report", created_at: 400,
            body: "## 富化报告",
            structured: {
              results: [
                { analyzer: "vt", data: "abc", dataType: "sha256", ok: true, level: "malicious" },
                { analyzer: "vt", data: "def", dataType: "sha256", ok: true, level: "safe" },
                { analyzer: "siem", data: "10.0.0.1", dataType: "ip", ok: false, refused: "tlp 超限" },
              ],
            },
          }),
        ],
      }),
      [],
    );
    expect(rows[0].levels).toEqual(["malicious", "safe", "refused"]);
  });

  it("审批条目并入：pending/批准（含执行标记）/驳回，只认本案件的卡", () => {
    const rows = assembleTimeline(
      detail({ timeline: [entry({ created_at: 100 })] }),
      [
        card({ id: "apr_a", status: "approved", approver: "duty_lead@soc.local", decidedAt: 600, executed: true }),
        card({ id: "apr_b", status: "rejected", approver: "duty_lead@soc.local", decidedAt: 700, rejectReason: "证据不足" }),
        card({ id: "apr_c", status: "pending", createdAt: 800 }),
        card({ id: "apr_d", status: "approved", caseId: "case_999999", decidedAt: 900 }), // 别的案子
      ],
    );
    const approvalRows = rows.filter((r) => r.kind === "approval");
    expect(approvalRows).toHaveLength(3);
    expect(approvalRows.map((r) => r.ts)).toEqual([600, 700, 800]);
    expect(approvalRows[0].title).toContain("已批准");
    expect(approvalRows[0].title).toContain("已执行"); // 执行反馈并进审批行，不编时间戳
    expect(approvalRows[1].title).toContain("已驳回");
    expect(approvalRows[1].body).toBe("证据不足");
    expect(approvalRows[2].title).toContain("等待");
  });

  it("空案件 → 空时间线（页面自己渲染空态）", () => {
    expect(assembleTimeline(detail(), [])).toHaveLength(0);
  });
});
