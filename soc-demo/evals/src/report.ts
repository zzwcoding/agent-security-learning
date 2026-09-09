// m11 eval 体系 · 报告落盘（票 19：eval-results/latest.json；票 22：三维补齐）。
//
// m11 卡公开接口的产物半边：pnpm test:eval 跑完写 soc-demo/eval-results/latest.json +
// cost_all.csv（m10 Eval 页未来的数据源）。三维报告（FR-M11.4）：
//   ① 分诊准确率 triage_accuracy（票 19 已有）
//   ② 防线拦截率 defense_interception —— 攻击 fixture 分面计数：拦截按「怎么拦的」
//     分别计（D2 扫描拦 / D4-D7 行为兜底 403·无票 / D8 人审驳回 / 沙箱边界）
//   ③ 成本口径 costs —— 每条告警 input/cache-read/output token、耗时、估算成本，
//     CSV 列结构照 M507 cost_all.csv（模型/input/cache-read/output token/成本）
// judge 汇总照旧只进报告不进门禁（决策 #7）。
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CaseResult, InterceptFacet } from "./types.js";

export const EVAL_RESULTS_DIR = fileURLToPath(new URL("../../eval-results/", import.meta.url));

/** 占位价格表（USD / 1M tokens）：成本口径先行，换真价只改这张表。口径 = 估算成本
 *  = input×in 价 + output×out 价（cache-read 快道恒 0，列留着对齐 M507 结构）。 */
export const PRICE_PER_M = { input: 0.3, output: 1.2 } as const;
export const EST_COST_NOTE =
  "估算成本=占位价格表(in $0.3/out $1.2 每 1M tokens)×token 取证；快道无缓存 cache_read=0，列保留对齐 M507 结构";

export interface RunReport {
  run_at: string;
  /** 决策 #10 的车道标注。 */
  lane: "unit-injected";
  tags: string[];
  /** 被测对象（快道固定为进程内确定性伪 LLM，与 judge 分离，决策 #7）。 */
  tested_model: string;
  judge_model: string | null;
  totals: { cases: number; ran: number; passed: number; failed: number; skipped: number };
  /** FR-M11.4 分诊准确率（对照人工标注 expected_verdict，ran 用例上的命中率）。 */
  triage_accuracy: number | null;
  /** FR-M11.4 防线拦截率：攻击 fixture 分面计数（扫描拦与行为兜底分别计）。 */
  defense_interception: DefenseInterception;
  /** FR-M11.4 成本口径：CSV 落 eval-results/cost_all.csv，这里放口径说明与行数。 */
  costs: { csv: string; rows: number; note: string };
  /** judge 汇总：只进报告不进门禁（决策 #7）；not_evaluable 不计入平均（ASP 口径）。 */
  judge: { evaluable_cases: number; avg_score: number | null; note: string };
  cases: CaseResult[];
}

export interface DefenseInterception {
  /** 按攻击面（attack 字段）计数：A1 alert_injection / A2 rag / A3 privesc / 沙箱面 / 对话输入面。 */
  by_face: Record<string, { total: number; intercepted: number; rate: number | null }>;
  /** 按拦截方式分面计数（FR-M11.4 验收口径：扫描拦与行为兜底 403 分别计）。 */
  by_facet: Record<InterceptFacet, number>;
  /** 环境不可跑而显式 skip 的攻击用例（不冒充拦截成功，也不算拦截失败）。 */
  skipped: string[];
  note: string;
}

const FACETS: readonly InterceptFacet[] = ["guard_scan", "behavior_gate", "review_reject", "sandbox_boundary", "credential_boundary"];

export function buildDefenseInterception(results: CaseResult[]): DefenseInterception {
  const byFace: DefenseInterception["by_face"] = {};
  const byFacet = Object.fromEntries(FACETS.map((f) => [f, 0])) as Record<InterceptFacet, number>;
  const skipped: string[] = [];
  for (const r of results) {
    if (r.attack === null) continue;
    if (!r.ran) {
      skipped.push(`${r.fullName}: ${r.skippedReason ?? "未注明原因"}`);
      continue;
    }
    const face = (byFace[r.attack.kind] ??= { total: 0, intercepted: 0, rate: null });
    face.total += 1;
    if (r.attack.intercepted) {
      face.intercepted += 1;
      byFacet[r.attack.facet] += 1;
    }
  }
  for (const f of Object.values(byFace)) f.rate = f.total === 0 ? null : f.intercepted / f.total;
  return {
    by_face: byFace,
    by_facet: byFacet,
    skipped,
    note: "拦截率=ran 攻击用例上 intercepted 占比；分面按拦截方式分别计（FR-M11.4）；环境 skip 显式留痕不计入分母",
  };
}

/** M507 cost_all.csv 口径的一行（只有真跑的告警流用例有——「每条告警」的口径）。 */
export interface CostCsvRow {
  case: string;
  domain: string;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  est_cost_usd: number;
}

export const COST_CSV_HEADER =
  "case,domain,model,input_tokens,cache_read_tokens,output_tokens,total_tokens,duration_ms,est_cost_usd";

export function buildCostRows(results: CaseResult[]): CostCsvRow[] {
  return results
    .filter((r) => r.ran && r.cost !== undefined)
    .map((r) => ({
      case: r.fullName,
      domain: r.domain,
      model: r.cost!.model,
      input_tokens: r.cost!.inputTokens,
      cache_read_tokens: r.cost!.cacheReadTokens,
      output_tokens: r.cost!.outputTokens,
      total_tokens: r.cost!.totalTokens,
      duration_ms: r.durationMs,
      est_cost_usd: r.cost!.estCostUsd,
    }));
}

export function costCsv(rows: CostCsvRow[]): string {
  const lines = rows.map((r) =>
    [r.case, r.domain, r.model, r.input_tokens, r.cache_read_tokens, r.output_tokens, r.total_tokens, r.duration_ms, r.est_cost_usd].join(","),
  );
  return [COST_CSV_HEADER, ...lines].join("\n") + "\n";
}

export function buildReport(results: CaseResult[], meta: { tags: string[]; judgeModel: string | null }): RunReport {
  const ran = results.filter((r) => r.ran);
  const passed = ran.filter((r) => r.passed);
  const skipped = results.filter((r) => !r.ran);
  const triageRan = ran.filter((r) => r.domain === "triage");
  const judged = ran.filter((r) => r.judge?.evaluable === true);
  const costRows = buildCostRows(results);
  return {
    run_at: new Date().toISOString(),
    lane: "unit-injected",
    tags: meta.tags,
    tested_model: "FakeTriageLlm/FakeChatLlm/FakeKnowledgeLlm（单测级注入，确定性）",
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
    defense_interception: buildDefenseInterception(results),
    costs: { csv: "eval-results/cost_all.csv", rows: costRows.length, note: EST_COST_NOTE },
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

/** 写 cost_all.csv（M507 列结构），返回文件路径。 */
export function writeCostCsv(results: CaseResult[]): string {
  mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  const path = EVAL_RESULTS_DIR + "cost_all.csv";
  writeFileSync(path, costCsv(buildCostRows(results)));
  return path;
}
