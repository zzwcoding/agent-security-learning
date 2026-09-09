// m11 eval 体系 · 生成的评估套件（票 19 验收③ + 票 22 全维，「vitest 自定义 runner 扫描
// fixture 目录生成测试」的落点）。
//
// 目录制 → 测试制的翻译只发生在这里：listCases() 扫 fixtures/eval/*/*/test_case.yaml，
// 每条用例长成一个 test。门禁 = 确定性断言（assertions.ts）+ 场景专项检查（scenarios.ts
// 的 extraChecks）；judge（可选）只记分，一分都不影响 passed（决策 #7，由 runner.test.ts
// 单独钉死）。跑完 afterAll 落 eval-results/latest.json + cost_all.csv——CI 快道（决策 #10）
// 与 pnpm test:eval 公开接口共用本文件。
import { afterAll, beforeAll, expect, test } from "vitest";
import { filterByTags, listCases, selectedTags } from "./loader.js";
import { runCase } from "./runner.js";
import { selectJudge, type Judge } from "./judge.js";
import { buildReport, writeCostCsv, writeReport } from "./report.js";
import type { CaseResult } from "./types.js";

const TAGS = selectedTags();
const CASES = filterByTags(listCases(), TAGS);
const ALL = listCases();
const count = (domain: string): number => ALL.filter((c) => c.domain === domain).length;

const results: CaseResult[] = [];
let judge: Judge | null = null;

beforeAll(async () => {
  judge = await selectJudge();
});

test(`eval 清单自检：六维下限（分诊 ${count("triage")}/攻击 ${count("attack")}/审批 ${count("approval")}` +
  `/replay ${count("replay")}/对话 ${count("chat")}/调查 ${count("investigation")}，共 ${ALL.length}），tag 过滤后 ${CASES.length} 条进场`, () => {
  // m11 卡测试计划的分维下限（票 22 验收①）+ 调查维（票 42：遗留标记 14-1 收口）
  expect(ALL.length).toBeGreaterThanOrEqual(30);
  expect(count("triage")).toBeGreaterThanOrEqual(10);
  expect(count("attack")).toBeGreaterThanOrEqual(10);
  expect(count("approval")).toBeGreaterThanOrEqual(3);
  expect(count("replay")).toBeGreaterThanOrEqual(2);
  expect(count("chat")).toBeGreaterThanOrEqual(3);
  expect(count("investigation")).toBeGreaterThanOrEqual(1);
  expect(CASES.length).toBeGreaterThan(0);
});

for (const c of CASES) {
  test(`${c.fullName}  [${c.spec.tags.join(",")}]`, async () => {
    const r = await runCase(c, judge);
    results.push(r);
    if (!r.ran) {
      // 车道/环境不匹配（never_mock、沙箱能力缺失）显式留痕，不算失败也不静默
      console.warn(`[eval] skip ${r.fullName}: ${r.skippedReason}`);
      expect(r.skippedReason, "skip 必须带原因").toBeTruthy();
      return;
    }
    const failed = r.checks.filter((x) => !x.ok);
    expect(
      failed,
      `${r.fullName} 确定性断言失败: ${JSON.stringify(failed)}`,
    ).toEqual([]);
    expect(r.passed, `${r.fullName} 应通过全部门槛`).toBe(true);
  });
}

afterAll(() => {
  const report = buildReport(results, {
    tags: TAGS,
    judgeModel: judge === null ? null : judge.model,
  });
  const path = writeReport(report);
  const csvPath = writeCostCsv(results);
  const di = report.defense_interception;
  const faces = Object.entries(di.by_face)
    .map(([k, v]) => `${k}=${v.intercepted}/${v.total}`).join(" ");
  console.log(
    `[eval] ${report.totals.ran} ran / ${report.totals.passed} passed / ${report.totals.failed} failed` +
    ` / ${report.totals.skipped} skipped；triage_accuracy=${report.triage_accuracy?.toFixed(3) ?? "n/a"}` +
    `；拦截率 ${faces || "n/a"}（分面 ${JSON.stringify(di.by_facet)}）` +
    `；cost rows=${report.costs.rows}` +
    `；judge=${report.judge_model ?? "not_evaluable"}（avg=${report.judge.avg_score?.toFixed(2) ?? "n/a"}，不进门禁）`,
  );
  if (di.skipped.length > 0) console.log(`[eval] 攻击用例 skip：${di.skipped.join("; ")}`);
  console.log(`[eval] 报告已落 ${path} + ${csvPath}`);
});
