// m11 eval 体系 · 报告落盘（票 19：eval-results/latest.json）。
//
// m11 卡公开接口的产物半边：pnpm test:eval 跑完把结果写 soc-demo/eval-results/latest.json
// （m10 Eval 页未来的数据源）。三维报告（攻击拦截率分面 / 成本 CSV）是票 22 的事，
// 这里只立 latest.json 的骨架：totals + 分诊准确率 + 逐用例明细 + judge 汇总（不进门禁）。
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CaseResult } from "./types.js";

export const EVAL_RESULTS_DIR = fileURLToPath(new URL("../../eval-results/", import.meta.url));

export interface RunReport {
  run_at: string;
  /** 决策 #10 的车道标注：本票只有快道。 */
  lane: "unit-injected";
  tags: string[];
  /** 被测对象（快道固定为进程内确定性伪 LLM，与 judge 分离，决策 #7）。 */
  tested_model: string;
  judge_model: string | null;
  totals: { cases: number; ran: number; passed: number; failed: number; skipped: number };
  /** FR-M11.4 分诊准确率（对照人工标注 expected_verdict，ran 用例上的命中率）。 */
  triage_accuracy: number | null;
  /** judge 汇总：只进报告不进门禁（决策 #7）；not_evaluable 不计入平均（ASP 口径）。 */
  judge: { evaluable_cases: number; avg_score: number | null; note: string };
  cases: CaseResult[];
}

export function buildReport(results: CaseResult[], meta: { tags: string[]; judgeModel: string | null }): RunReport {
  const ran = results.filter((r) => r.ran);
  const passed = ran.filter((r) => r.passed);
  const skipped = results.filter((r) => !r.ran);
  const triageRan = ran.filter((r) => r.domain === "triage");
  const judged = ran.filter((r) => r.judge?.evaluable === true);
  return {
    run_at: new Date().toISOString(),
    lane: "unit-injected",
    tags: meta.tags,
    tested_model: "FakeTriageLlm（单测级注入，确定性）",
    judge_model: meta.judgeModel,
    totals: {
      cases: results.length,
      ran: ran.length,
      passed: passed.length,
      failed: ran.length - passed.length,
      skipped: skipped.length,
    },
    triage_accuracy: triageRan.length === 0
      ? null
      : triageRan.filter((r) => r.verdict.ok).length / triageRan.length,
    judge: {
      evaluable_cases: judged.length,
      avg_score: judged.length === 0
        ? null
        : judged.reduce((acc, r) => acc + (r.judge?.evaluable ? r.judge.score : 0), 0) / judged.length,
      note: "judge 分数不进门禁（PRD 决策 #7）；不可用计数走 not_evaluable 不算失败",
    },
    cases: results,
  };
}

/** 写 latest.json，返回文件路径（套件 afterAll 调用；目录不存在则建）。 */
export function writeReport(report: RunReport): string {
  mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  const path = EVAL_RESULTS_DIR + "latest.json";
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
}
