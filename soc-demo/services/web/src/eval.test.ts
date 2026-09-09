// Eval 结果页的数据映射单测（FR-M10.6：最近一次跑分三维展示）。
// latest.json 是 m11 的产物，票 22 起是三维形状（totals/分诊准确率/防线拦截率/
// 逐用例成本耗时），票 29 把 web 消费端对齐到它——映射必须「有什么渲染什么」：
// 没有的维度如实标未产出，不合成数字不猜。judge 只进报告不进门禁（决策 #7），
// 页面原样展示 note。文末「双端契约」节与 evals 生产端共读一份样例。
import { describe, expect, it } from "vitest";
import fixtureRaw from "../../../fixtures/eval-report/latest.json?raw";
import type { EvalReport } from "./api";
import { attackFaces, attackSkipped, costTotals, evalView, interceptFacets, pct } from "./eval";

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

describe("attackFaces / interceptFacets / attackSkipped", () => {
  it("票 19 时代旧产物没有 defense_interception：空数组（页面标未产出）", () => {
    expect(attackFaces(BASE)).toEqual([]);
    expect(evalView(BASE).facets).toEqual([]);
    expect(evalView(BASE).skipped).toEqual([]);
  });
  it("by_face 分面率：键 → 中文标签 + 百分比 + 分母；rate=null 如实透传", () => {
    const faces = attackFaces({
      ...BASE,
      defense_interception: {
        by_face: {
          alert_injection: { total: 2, intercepted: 2, rate: 1 },
          chat_injection: { total: 3, intercepted: 1, rate: 1 / 3 },
          sandbox: { total: 0, intercepted: 0, rate: null },
        },
        by_facet: { guard_scan: 2, behavior_gate: 0, review_reject: 0, sandbox_boundary: 0 },
        skipped: [],
        note: "口径说明",
      },
    });
    expect(faces).toEqual([
      { key: "alert_injection", label: "告警注入", total: 2, intercepted: 2, pct: "100%" },
      { key: "chat_injection", label: "对话注入", total: 3, intercepted: 1, pct: "33%" },
      { key: "sandbox", label: "沙箱", total: 0, intercepted: 0, pct: null },
    ]);
  });
  it("by_facet 分面计数 + 没见过的键原样当标签（后端加维度页面不改）", () => {
    const report: EvalReport = {
      ...BASE,
      defense_interception: {
        by_face: {},
        by_facet: { guard_scan: 2, new_facet_x: 1 },
        skipped: ["attack/09: 环境不可用"],
        note: "",
      },
    };
    expect(interceptFacets(report)).toEqual([
      { key: "guard_scan", label: "扫描拦 D2", count: 2 },
      { key: "new_facet_x", label: "new_facet_x", count: 1 },
    ]);
    expect(attackSkipped(report)).toEqual(["attack/09: 环境不可用"]);
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

describe("双端契约：fixtures/eval-report/latest.json（evals 产出 → web 消费两端共读）", () => {
  // 票 29：样例由 evals 生产端 buildReport 生成并被 report.contract.test.ts 钉死；
  // 这里走消费路径读同一份——evals 改形状而 web 没跟，必在这边红（A1 三方漂移的闸）。
  // ?raw = vite 原样字节（jsdom 里没有 file: URL 可读盘），两端读到的是同一份磁盘内容。
  const FIXTURE = JSON.parse(fixtureRaw) as EvalReport;

  it("消费端跟得上生产端：attackFaces 从 defense_interception.by_face 读出真分面", () => {
    const faces = attackFaces(FIXTURE);
    expect(faces.map((f) => f.key)).toEqual(["alert_injection", "privesc", "rag", "chat_injection"]);
    expect(faces.map((f) => f.pct)).toEqual(["100%", "100%", "100%", "0%"]);
    // skipped 攻击用例不进分母：sandbox 用例只在 skipped 留痕，by_face 里没有它
    expect(faces.some((f) => f.key === "sandbox")).toBe(false);
    // 旧幽灵键（PRD 第三形状）不许复活
    expect("attack_block_rate" in FIXTURE).toBe(false);
  });

  it("evalView 真渲染三维：准确率 / 分面计数 + skipped 留痕 / 成本", () => {
    const v = evalView(FIXTURE);
    expect(v.hasAttackData).toBe(true);
    expect(v.accuracy).toBe("100%");
    expect(v.facets.map((f) => `${f.label} ${f.count}`)).toEqual([
      "扫描拦 D2 1",
      "行为兜底 403/无票 1",
      "人审驳回 D8 1",
      "沙箱边界 0",
    ]);
    expect(v.skipped).toEqual(["attack/05_sandbox_msb_down: msb 不可用"]);
    expect(v.defenseNote).toContain("不计入分母");
    expect(v.costs?.rows).toBe(1);
  });
});
