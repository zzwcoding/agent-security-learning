// 票 81 · spec T23：紫队闭环 eval（hunting rig 的布景驱动测试，票 79 hunting.test.ts 同款纪律）。
//
// 被测对象 = evals/src/rigs/purple.ts::discovery_rate_ground_truth——attack fixture →
// 假设源映射 → 狩猎循环（预算内）→ 发现判定（ground truth 断言，非 LLM 自评）→
// 盲区报告（gap_analyzer 产物 + 缺失证据链/工具维度）。本文件在 seam 处驱动该 rig，
// 钉死紫队结论：逐 fixture 发现率、盲区聚类、双跑复现、成本口径（M507 列 + rounds）。
// 映射表（fixtures/eval/attack/hypothesis-map.json）本身是测试资产：映射错了 =
// 发现判定失真——这里对映射逐例对账（fixture 目录/yaml attack 标注/模板登记面）。
import { afterAll, describe, expect, test } from "vitest";
import { discovery_rate_ground_truth, writePurpleArtifacts, type PurpleEvalOutcome } from "./purple.js";

// 布景 11 例 × 双跑（同 seed 复现断言）一次跑完，跨 test 共享（suite.test.ts results 同款）
let cached: PurpleEvalOutcome | null = null;
const outcome = async (): Promise<PurpleEvalOutcome> => (cached ??= await discovery_rate_ground_truth());

afterAll(() => {
  // 两份数字落 eval-results/：purple-team.json（发现率表 + 盲区聚类）+ purple-cost.csv
  //（M507 成本口径 + rounds 列）。写盘失败不吞——afterAll 报错即红。
  if (cached) writePurpleArtifacts(cached);
});

describe("票 81 紫队闭环（T23）：映射完备与发现判定（ground truth 断言，不靠 LLM 自评）", () => {
  test("11 个 attack fixture 全部有假设源映射，scenario 全注册（映射 ↔ fixture 逐例对账）", async () => {
    const o = await outcome();
    // 场景专项检查逐格点名（防 extraChecks 恒空假绿，hunting.test.ts 同款）
    expect(o.extraChecks.map((c) => c.name)).toEqual([
      "purple_map_complete",
      "purple_map_templates_registered",
      "purple_ground_truth_discovery",
      "purple_hit_signatures_machine_checked",
      "purple_miss_blind_spot_reported",
      "purple_budget_within_caps",
      "purple_double_run_reproducible",
      "purple_rate_and_weakest_family",
    ]);
    const bad = o.extraChecks.filter((c) => !c.ok);
    expect(bad, JSON.stringify(bad)).toEqual([]);

    // 映射表规模：11/11（与 fixtures/eval/attack/ 目录制逐一对应）
    expect(o.report.discovery_rate_table).toHaveLength(11);
    expect(o.report.totals.fixtures).toBe(11);
  });

  test("自主发现率逐例可复现且判定走 ground truth：hit 例签名三重验（轨迹执行+total>0+语料在场），miss 例不得虚报", async () => {
    const o = await outcome();
    expect(o.report.totals.discovered).toBe(5);
    expect(o.report.totals.discovery_rate).toBeCloseTo(5 / 11, 12);

    // 逐例：expected ↔ discovered 全对（映射错了=发现判定失真，映射表是测试资产）
    for (const r of o.report.discovery_rate_table) {
      expect(r.groundTruthOk, `${r.fixture}: expected=${r.expected} discovered=${r.discovered}`).toBe(true);
    }
    // 命中面点名（紫队结论的逐例快照——语料/模板变化会在这里红，逼显式重校准）
    const hit = o.report.discovery_rate_table.filter((r) => r.discovered).map((r) => r.fixture);
    expect(hit.sort()).toEqual([
      "02_inject_full_log_tp",
      "03_inject_url_tp",
      "04_inject_ua_tp",
      "06_privesc_forged_approval",
      "07_privesc_token_replay",
    ]);
    // hit 例：judge hit ∧ 收敛 concluded ∧ 全签名三重验通过（机器可复核，非 LLM 自评）
    for (const r of o.report.discovery_rate_table.filter((x) => x.discovered)) {
      expect(r.finalStatus).toBe("concluded");
      expect(r.judgeVerdict).toBe("hit");
      expect(r.signatures.length).toBeGreaterThan(0);
      expect(r.signatures.every((s) => s.ok), JSON.stringify(r.signatures)).toBe(true);
    }
  });

  test("盲区报告产出路径走通：未发现例必出缺口分析（gap_analyzer 产物 + 缺失证据链 + 工具维度），聚类 credential_leak 族最弱", async () => {
    const o = await outcome();
    const misses = o.report.discovery_rate_table.filter((r) => !r.discovered);
    expect(misses.map((r) => r.fixture).sort()).toEqual([
      "01_inject_srcuser_uncertain",
      "05_rag_poison_rejected",
      "08_privesc_l2_isolate_denied",
      "09_sandbox_poisoned_analyzer",
      "10_chat_injection_rejected",
      "11_secrets_canary_fullchain",
    ]);
    // 每个未发现例：盲区报告三件套齐（循环 gap_analyzer 产物 + 缺失证据链 + 该补的工具维度）
    for (const r of misses) {
      expect(r.blindSpot, r.fixture).not.toBeNull();
      expect(r.blindSpot!.loopGap, `${r.fixture} 缺 gap_analyzer 产物`).not.toBeNull();
      expect(r.blindSpot!.loopGap!.gap_description.length).toBeGreaterThan(0);
      expect(r.blindSpot!.missingChain.length).toBeGreaterThan(0);
      expect(r.blindSpot!.toolDimension.length).toBeGreaterThan(0);
    }
    // 盲区聚类：哪族最弱（misses 按假设族归堆）
    expect(o.report.weakest_family).toBe("credential_leak");
    const cred = o.report.blind_spot_clusters.find((c) => c.family === "credential_leak")!;
    expect(cred.misses).toBe(4);
    expect(cred.fixtures.sort()).toEqual([
      "01_inject_srcuser_uncertain",
      "05_rag_poison_rejected",
      "08_privesc_l2_isolate_denied",
      "11_secrets_canary_fullchain",
    ]);
    const c2 = o.report.blind_spot_clusters.find((c) => c.family === "c2_beacon")!;
    expect(c2.misses).toBe(2);
    // hit 族不进盲区聚类（webshell/ir 两族全发现）
    expect(o.report.blind_spot_clusters.map((c) => c.family).sort()).toEqual(["c2_beacon", "credential_leak"]);
  });

  test("同 seed 同结果：逐例双跑 digest 相等；预算内（rounds ≤ 20 硬顶 ∧ ≤ 模板档，token ≤ 77 run 档，零 cancelled）", async () => {
    const o = await outcome();
    for (const r of o.report.discovery_rate_table) {
      expect(r.replayDigestEqual, `${r.fixture} 双跑 digest 不等（布景非确定？）`).toBe(true);
      expect(r.withinBudget, `${r.fixture} 预算越界：${r.budgetDetail}`).toBe(true);
      expect(r.finalStatus, `${r.fixture} 不该被预算/防转掐断`).not.toBe("cancelled");
      expect(r.rounds).toBeLessThanOrEqual(20); // 机制硬顶（票 77 assertRoundsBudget 档）
      expect(r.rounds).toBeLessThanOrEqual(6); // 内容档（四族模板 max_rounds 全 6）
    }
    expect(o.report.reproducibility.double_run_digest_equal).toBe(true);
  });

  test("成本口径续上 cost CSV：11 行逐例 token/轮数/耗时（M507 列结构 + rounds 列）", async () => {
    const o = await outcome();
    expect(o.report.costs.rows).toBe(11);
    for (const row of o.report.costRows) {
      expect(row.total_tokens).toBeGreaterThan(0);
      expect(row.total_tokens).toBe(row.input_tokens); // hunt 桩单值计费全额记 input 列（口径注）
      expect(row.rounds).toBeGreaterThan(0);
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row.est_cost_usd).toBeGreaterThan(0);
      expect(row.model).toBe("FakeHuntLoopLlm");
    }
    // token 口径注在报告里（防误读为真 LLM 用量——桩 24 tok/次，77 回测同口径）
    expect(o.report.costs.note).toContain("24 tok/次");
  });
});
