// Eval 结果页的数据映射（FR-M10.6 的纯函数层，React 之外可单测）。
// 数据源 = m11 产物 eval-results/latest.json（vite 静态面原样读，不加工不代理）。
// 票 19 的骨架只有「分诊准确率 + totals + 逐用例 token/耗时」；攻击面拦截率分面
// （attack_block_rate）和成本 CSV 是票 22 的产出——映射按「有什么渲染什么」：
// 没有的维度返回空并标 hasAttackData=false，绝不合成分面数字（零特权原则的
// 数据版：页面只能展示产物里真实存在的字段）。
import type { EvalReport } from "./api";

/** 0-1 比例 → 整数百分比文案；null/undefined → null（没数不编数）。 */
export function pct(v: number | null | undefined): string | null {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return `${Math.round(v * 100)}%`;
}

const FACE_LABELS: Record<string, string> = {
  injection: "注入",
  privesc: "越权",
  rag_poison: "RAG 投毒",
};

export interface AttackFace {
  key: string;
  label: string;
  pct: string | null;
}

/** 攻击面拦截率分面（票 22 起才有数据）。没见过的攻击面键原样当标签——
 *  后端加维度，页面不用改就能显示。 */
export function attackFaces(report: EvalReport): AttackFace[] {
  const rate = report.attack_block_rate ?? {};
  return Object.entries(rate).map(([key, v]) => ({
    key,
    label: FACE_LABELS[key] ?? key,
    pct: pct(v),
  }));
}

export interface CostTotals {
  tokens: number;
  durationMs: number;
  toolCalls: number;
}

/** 成本口径的账面合计：逐用例 tokens/耗时/工具调用求和（M507 cost_all.csv 的
 *  合计栏精神；票 22 落 CSV 后页面可再挂下载，不在本票范围）。 */
export function costTotals(report: EvalReport): CostTotals {
  return report.cases.reduce<CostTotals>(
    (acc, c) => ({
      tokens: acc.tokens + (c.tokens ?? 0),
      durationMs: acc.durationMs + (c.durationMs ?? 0),
      toolCalls: acc.toolCalls + (c.toolCalls ?? 0),
    }),
    { tokens: 0, durationMs: 0, toolCalls: 0 },
  );
}

export interface EvalView {
  runAt: string;
  lane: string;
  testedModel?: string;
  accuracy: string | null;
  passRate: string | null;
  totals: EvalReport["totals"];
  faces: AttackFace[];
  hasAttackData: boolean;
  cost: CostTotals;
  cases: EvalReport["cases"];
  judgeNote: string;
}

/** latest.json → 页面视图模型（三维：准确率 / 攻击面拦截 / 成本耗时）。 */
export function evalView(report: EvalReport): EvalView {
  const faces = attackFaces(report);
  return {
    runAt: report.run_at,
    lane: report.lane,
    testedModel: report.tested_model,
    accuracy: pct(report.triage_accuracy),
    passRate: report.totals.ran > 0 ? pct(report.totals.passed / report.totals.ran) : null,
    totals: report.totals,
    faces,
    hasAttackData: faces.length > 0,
    cost: costTotals(report),
    cases: report.cases,
    judgeNote: report.judge?.note ?? "",
  };
}
