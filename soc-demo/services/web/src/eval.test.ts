// Eval 结果页的数据映射单测（FR-M10.6：最近一次跑分三维展示）。
// latest.json 是 m11 的产物，票 19 只有骨架（totals/分诊准确率/逐用例成本耗时），
// 攻击面拦截率是票 22 的事——映射必须「有什么渲染什么」：没有的维度如实标未产出，
// 不合成数字不猜。judge 只进报告不进门禁（决策 #7），页面原样展示 note。
import { describe, expect, it } from "vitest";
import type { EvalReport } from "./api";
import { attackFaces, costTotals, evalView, pct } from "./eval";

const BASE: EvalReport = {
  run_at: "2026-09-09T00:02:06.390Z",
  lane: "unit-injected",
  tags: [],
  tested_model: "FakeTriageLlm（单测级注入，确定性）",
  judge_model: null,
  totals: { cases: 11, ran: 11, passed: 11, failed: 0, skipped: 0 },
  triage_accuracy: 1,
  judge: { evaluable_cases: 0, avg_score: null, note: "judge 分数不进门禁（PRD 决策 #7）" },
  cases: [
    { fullName: "triage/01_ssh_bruteforce_tp", domain: "triage", ran: true, passed: true, toolCalls: 4, tokens: 64, durationMs: 123 },
    { fullName: "triage/02_ssh_user_probe_uncertain", domain: "triage", ran: true, passed: true, toolCalls: 3, tokens: 64, durationMs: 23 },
  ],
};

describe("pct", () => {
  it("0-1 比例 → 整数百分号文案；null → null（没数不编数）", () => {
    expect(pct(1)).toBe("100%");
    expect(pct(0.83)).toBe("83%");
    expect(pct(null)).toBeNull();
    expect(pct(undefined)).toBeNull();
  });
});

describe("attackFaces", () => {
  it("票 22 前没有 attack_block_rate：空数组（页面标未产出）", () => {
    expect(attackFaces(BASE)).toEqual([]);
  });
  it("有分面数据：键 → 中文标签 + 百分比；null 分面如实透传", () => {
    const faces = attackFaces({ ...BASE, attack_block_rate: { injection: 1, privesc: 0.9, rag_poison: null } });
    expect(faces).toEqual([
      { key: "injection", label: "注入", pct: "100%" },
      { key: "privesc", label: "越权", pct: "90%" },
      { key: "rag_poison", label: "RAG 投毒", pct: null },
    ]);
  });
});

describe("costTotals", () => {
  it("逐用例 token/耗时/工具调用求和（成本口径的账面合计）", () => {
    expect(costTotals(BASE)).toEqual({ tokens: 128, durationMs: 146, toolCalls: 7 });
  });
  it("缺字段的用例按 0 计", () => {
    expect(costTotals({ ...BASE, cases: [{ fullName: "x", domain: "triage", ran: true, passed: true }] })).toEqual({
      tokens: 0, durationMs: 0, toolCalls: 0,
    });
  });
});

describe("evalView", () => {
  it("三维视图：准确率 + 通过率 + 攻击面标记未产出 + judge note 原样", () => {
    const v = evalView(BASE);
    expect(v.accuracy).toBe("100%");
    expect(v.passRate).toBe("100%");
    expect(v.hasAttackData).toBe(false);
    expect(v.judgeNote).toContain("不进门禁");
  });
});
