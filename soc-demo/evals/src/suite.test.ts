// m11 eval 体系 · 生成的评估套件（票 19 验收③，「vitest 自定义 runner 扫描 fixture
// 目录生成测试」的落点）。
//
// 目录制 → 测试制的翻译只发生在这里：listCases() 扫 fixtures/eval/*/*/test_case.yaml，
// 每条用例长成一个 test。门禁 = 确定性断言（assertions.ts）；judge（可选）只记分，
// 一分都不影响 passed（决策 #7，由 runner.test.ts 单独钉死）。跑完 afterAll 落
// eval-results/latest.json——CI 快道（决策 #10）与 pnpm test:eval 公开接口共用本文件。
import { afterAll, beforeAll, expect, test } from "vitest";
import { filterByTags, listCases, selectedTags } from "./loader.js";
import { runCase } from "./runner.js";
import { selectJudge, type Judge } from "./judge.js";
import { buildReport, writeReport } from "./report.js";
import type { CaseResult } from "./types.js";

const TAGS = selectedTags();
const CASES = filterByTags(listCases(), TAGS);
const TRIAGE_TOTAL = listCases().filter((c) => c.domain === "triage").length;

const results: CaseResult[] = [];
let judge: Judge | null = null;

beforeAll(async () => {
  judge = await selectJudge();
});

test(`eval 清单自检：分诊维 ≥10 条（实际 ${TRIAGE_TOTAL}），tag 过滤后 ${CASES.length} 条进场`, () => {
  expect(TRIAGE_TOTAL).toBeGreaterThanOrEqual(10);
  expect(CASES.length).toBeGreaterThan(0);
});

for (const c of CASES) {
  test(`${c.fullName}  [${c.spec.tags.join(",")}]`, async () => {
    const r = await runCase(c, judge);
    results.push(r);
    if (!r.ran) {
      // 车道不匹配（never_mock/对话流）显式留痕，不算失败也不静默
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
  console.log(
    `[eval] ${report.totals.ran} ran / ${report.totals.passed} passed / ${report.totals.failed} failed` +
    ` / ${report.totals.skipped} skipped；triage_accuracy=${report.triage_accuracy?.toFixed(3) ?? "n/a"}` +
    `；judge=${report.judge_model ?? "not_evaluable"}（avg=${report.judge.avg_score?.toFixed(2) ?? "n/a"}，不进门禁）`,
  );
  console.log(`[eval] 报告已落 ${path}`);
});
