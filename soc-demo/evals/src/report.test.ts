import { describe, expect, test } from "vitest";
import { buildCostRows, buildReport, costCsv, EST_COST_NOTE } from "./report.js";
import type { CaseResult } from "./types.js";

// 票 22 验收②③⑤：三维报告的后两维（防线拦截率分面 / 成本口径 CSV）+
// judge 分数只在报告里、永远不碰门槛（FR-M11.2/FR-M11.4，决策 #7 复核）。
// 报告的一切输入都是 CaseResult——测试用合成结果钉死「统计口径」本身，
// 不真跑任何 worker（真跑的归 suite / scenarios 测试）。

/** 造一条合成结果：默认「ran + passed + 非攻击」。 */
function r(over: Partial<CaseResult> & { fullName: string }): CaseResult {
  return {
    domain: over.fullName.split("/")[0] ?? "triage",
    tags: [],
    ran: true,
    passed: true,
    verdict: { expected: "tp", got: "true_positive", ok: true },
    checks: [{ name: "run_completed", ok: true, detail: "" }],
    judge: null,
    toolCalls: 2,
    tokens: 128,
    durationMs: 40,
    attack: null,
    ...over,
  };
}

describe("防线拦截率：攻击 fixture 分面计数（FR-M11.4 第二维）", () => {
  test("by_face 按攻击面计数，by_facet 把扫描拦与行为兜底分开计", () => {
    const results: CaseResult[] = [
      r({ fullName: "attack/01_inject_srcuser", domain: "attack", attack: { kind: "alert_injection", facet: "guard_scan", intercepted: true } }),
      r({ fullName: "attack/02_inject_full_log", domain: "attack", attack: { kind: "alert_injection", facet: "guard_scan", intercepted: true } }),
      r({ fullName: "attack/05_rag_poison", domain: "attack", attack: { kind: "rag", facet: "review_reject", intercepted: true } }),
      r({ fullName: "attack/06_forged", domain: "attack", attack: { kind: "privesc", facet: "behavior_gate", intercepted: true } }),
      r({ fullName: "attack/07_replay", domain: "attack", attack: { kind: "privesc", facet: "behavior_gate", intercepted: true } }),
      r({ fullName: "attack/09_sandbox", domain: "attack", ran: false, passed: false, skippedReason: "msb 不可用", attack: { kind: "sandbox", facet: "sandbox_boundary", intercepted: false } }),
      r({ fullName: "triage/01_ssh", domain: "triage" }), // 非攻击用例不进这道统计
    ];
    const rep = buildReport(results, { tags: [], judgeModel: null });
    const di = rep.defense_interception;
    expect(di.by_face.alert_injection).toEqual({ total: 2, intercepted: 2, rate: 1 });
    expect(di.by_face.rag).toEqual({ total: 1, intercepted: 1, rate: 1 });
    expect(di.by_face.privesc).toEqual({ total: 2, intercepted: 2, rate: 1 });
    // 分面计数：扫描拦（D2）2、行为兜底 403/无票（D4/D5/D7）2、人审驳回（D8）1
    expect(di.by_facet).toEqual({ guard_scan: 2, behavior_gate: 2, review_reject: 1, sandbox_boundary: 0 });
    // 环境坏的攻击用例显式留痕（不冒充拦截成功，也不算拦截失败）
    expect(di.skipped).toEqual(["attack/09_sandbox: msb 不可用"]);
  });

  test("拦截失败的用例照实计入（rate < 1），报告不粉饰", () => {
    const results: CaseResult[] = [
      r({ fullName: "attack/06_forged", domain: "attack", attack: { kind: "privesc", facet: "behavior_gate", intercepted: false } }),
    ];
    const di = buildReport(results, { tags: [], judgeModel: null }).defense_interception;
    expect(di.by_face.privesc).toEqual({ total: 1, intercepted: 0, rate: 0 });
    expect(di.by_facet.behavior_gate).toBe(0);
  });

  test("零攻击用例时为空表 + 全 0 分面（不造 NaN rate，分面形状稳定）", () => {
    const di = buildReport([r({ fullName: "triage/01" })], { tags: [], judgeModel: null }).defense_interception;
    expect(di.by_face).toEqual({});
    expect(di.by_facet).toEqual({ guard_scan: 0, behavior_gate: 0, review_reject: 0, sandbox_boundary: 0 });
  });
});

describe("成本口径：cost_all.csv 照 M507 列结构（FR-M11.4 第三维）", () => {
  const costed: CaseResult[] = [
    r({
      fullName: "triage/01_ssh_bruteforce_tp", domain: "triage", durationMs: 1234, tokens: 192,
      cost: { model: "FakeTriageLlm", inputTokens: 150, cacheReadTokens: 0, outputTokens: 42, totalTokens: 192, estCostUsd: 0.0000954 },
    }),
    r({ fullName: "approval/01_approve", domain: "approval" }), // 非 alert 流：无成本行
    r({ fullName: "triage/09_skipped", domain: "triage", ran: false, passed: false, skippedReason: "x" }),
  ];

  test("CSV 表头 = M507 列结构（模型/input/cache-read/output token/成本）+ 本票两列（用例、耗时）", () => {
    const text = costCsv(buildCostRows(costed));
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("case,domain,model,input_tokens,cache_read_tokens,output_tokens,total_tokens,duration_ms,est_cost_usd");
    expect(lines).toHaveLength(2); // 只有真跑的 alert 流用例进 CSV
    expect(lines[1]).toContain("triage/01_ssh_bruteforce_tp");
    expect(lines[1]).toContain("FakeTriageLlm");
    expect(lines[1]).toContain("150,0,42,192,1234");
  });

  test("估算成本 = 占位价格表（in 0.3 / out 1.2 USD 每 1M）按 token 数线性计——口径可复核", () => {
    const rows = buildCostRows(costed);
    expect(rows[0].est_cost_usd).toBeCloseTo((150 * 0.3 + 42 * 1.2) / 1e6, 9);
    expect(EST_COST_NOTE).toContain("占位");
  });
});

describe("judge 分数进报告不进门禁（决策 #7 复核：票 22 验收⑤）", () => {
  test("judge 全 0 分：avg_score=0 进报告；passed 只数确定性 checks，一个不少", () => {
    const results: CaseResult[] = [
      r({ fullName: "triage/01", judge: { evaluable: true, score: 0, hit: [], missed: ["x"], model: "fixed-stub" } }),
      r({ fullName: "triage/02", judge: { evaluable: true, score: 0, hit: [], missed: ["y"], model: "fixed-stub" } }),
    ];
    const rep = buildReport(results, { tags: [], judgeModel: "fixed-stub" });
    expect(rep.judge.avg_score).toBe(0);
    expect(rep.judge.evaluable_cases).toBe(2);
    expect(rep.totals.passed).toBe(2); // 门槛只认 checks——judge 0 分不拽 low passed
    expect(rep.totals.failed).toBe(0);
  });
});
