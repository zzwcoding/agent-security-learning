// 审批卡纯逻辑单测：轮询合并（覆盖语义）+ 409 后到者文案 + 状态标签映射。
import { describe, expect, it } from "vitest";
import type { ApprovalCard } from "./api";
import { decideErrorText, mergeApprovals, statusTag } from "./approvals";

function card(over: Partial<ApprovalCard>): ApprovalCard {
  return {
    id: "apr_1",
    runId: "run_1",
    node: "execute_action",
    tool: "isolate_host",
    params: { host: "centos7" },
    paramsHash: "h_1",
    caseId: "case_000001",
    reason: "调查报告建议遏制",
    status: "pending",
    approver: null,
    rejectReason: null,
    executed: false,
    createdAt: 100,
    decidedAt: null,
    ...over,
  };
}

describe("mergeApprovals", () => {
  it("同 id 覆盖（状态翻面以新数据为准），新卡并入，createdAt 降序", () => {
    const old1 = card({ id: "apr_1", status: "pending", createdAt: 100 });
    const old2 = card({ id: "apr_2", status: "pending", createdAt: 300 });
    const fresh = [
      card({ id: "apr_1", status: "approved", approver: "duty_lead@soc.local", decidedAt: 200, createdAt: 100 }),
      card({ id: "apr_3", status: "pending", createdAt: 500 }),
    ];
    const merged = mergeApprovals([old1, old2], fresh);
    expect(merged.map((c) => c.id)).toEqual(["apr_3", "apr_2", "apr_1"]);
    expect(merged[2].status).toBe("approved"); // 覆盖而不是跳过：apr_1 已翻面
    expect(merged[2].approver).toBe("duty_lead@soc.local");
  });

  it("纯新列表照 createdAt 降序", () => {
    const merged = mergeApprovals([], [card({ id: "a", createdAt: 1 }), card({ id: "b", createdAt: 2 })]);
    expect(merged.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("decideErrorText", () => {
  it("409（并发后到者/卡已裁决）给正常剧情文案", () => {
    const text = decideErrorText({ status: 409, code: "InvalidTransition" });
    expect(text).toContain("409");
    expect(text).toContain("裁决");
  });
  it("502（gateway 铸票失败）提示可重试且卡未坏", () => {
    expect(decideErrorText({ status: 502, code: "mint_failed" })).toContain("重试");
  });
  it("其它错误透传 code", () => {
    expect(decideErrorText({ status: 400, code: "approver_required" })).toContain("approver_required");
    expect(decideErrorText(new Error("boom"))).toContain("boom");
  });
});

describe("statusTag", () => {
  it("pending/approved/rejected 三态都有颜色文案", () => {
    expect(statusTag("pending")).toMatchObject({ text: "待审批" });
    expect(statusTag("approved")!.text).toBe("已批准");
    expect(statusTag("rejected")!.text).toBe("已驳回");
  });
});
