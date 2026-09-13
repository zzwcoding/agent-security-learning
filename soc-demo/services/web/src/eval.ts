// Eval 结果页的数据映射（FR-M10.6 的纯函数层，React 之外可单测）。
// 数据源 = m11 产物 eval-results/latest.json（vite 静态面原样读，不加工不代理）。
// 票 29：对齐票 22 产物的真实形状 defense_interception（by_face 拦截率 + by_facet
// 分面计数 + skipped 留痕）——旧键 attack_block_rate 是 PRD 早期样例的第三种形状，
// 三方漂移的幽灵键（体检 A1），已删；契约由 fixtures/eval-report/latest.json
// 两端共读锁定（evals 侧 report.contract.test.ts 是另一半）。
// 映射仍按「有什么渲染什么」：字段缺席（票 19 时代的旧产物）返回空并标
// hasAttackData=false，绝不合成分面数字（零特权原则的数据版）。
import type { EvalReport } from "./api";

/** 0-1 比例 → 整数百分比文案；null/undefined → null（没数不编数）。 */
export function pct(v: number | null | undefined): string | null {
  if (typeof v !== "number" || Number.isNaN(v)) return null;
  return `${Math.round(v * 100)}%`;
}

// 攻击面键 = test_case.yaml 的 attack 字段（runner 照抄产物，别处不造）。没见过的
// 键原样当标签——后端加维度，页面不用改就能显示。
const FACE_LABELS: Record<string, string> = {
  alert_injection: "告警注入",
  rag: "RAG 投毒",
  privesc: "越权",
  sandbox: "沙箱",
  chat_injection: "对话注入",
};

export interface AttackFace {
  key: string;
  label: string;
  /** 分母 = ran 攻击用例数（skipped 不进分母——生产端口径，页面只负责说清）。 */
  total: number;
  intercepted: number;
  pct: string | null;
}

/** 攻击面拦截率（by_face：拦截率按攻击面分别计）。 */
export function attackFaces(report: EvalReport): AttackFace[] {
  const byFace = report.defense_interception?.by_face ?? {};
  return Object.entries(byFace).map(([key, s]) => ({
    key,
    label: FACE_LABELS[key] ?? key,
    total: s.total,
    intercepted: s.intercepted,
    pct: pct(s.rate),
  }));
}

// 拦截方式键 = InterceptFacet 词表（FR-M11.4：扫描拦与行为兜底分别计）。
const FACET_LABELS: Record<string, string> = {
  guard_scan: "扫描拦 D2",
  behavior_gate: "行为兜底 403/无票",
  review_reject: "人审驳回 D8",
  sandbox_boundary: "沙箱边界",
  credential_boundary: "凭证边界 INV-4", // 票 35：m9 金丝雀（SECRETS 值不落持久面）
};

export interface FacetCount {
  key: string;
  label: string;
  count: number;
}

/** 拦截方式分面计数（by_facet：这道防线各拦了几次）。 */
export function interceptFacets(report: EvalReport): FacetCount[] {
  const byFacet = report.defense_interception?.by_facet ?? {};
  return Object.entries(byFacet).map(([key, count]) => ({
    key,
    label: FACET_LABELS[key] ?? key,
    count,
  }));
}

/** 环境原因显式 skip 的攻击用例（不冒充拦截成功，也不算拦截失败——只留痕）。 */
export function attackSkipped(report: EvalReport): string[] {
  return report.defense_interception?.skipped ?? [];
}

export interface CostTotals {
  tokens: number;
  durationMs: number;
  toolCalls: number;
}

/** 成本口径的账面合计：逐用例 tokens/耗时/工具调用求和（M507 cost_all.csv 的
 *  合计栏精神；CSV 行数/口径说明走 costs 字段，页面只挂数字不搬文件）。 */
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

// 票 91：紫队闭环加性段（latest.json.purple，evals rigs/purple.ts 投影并入）——
// 「有什么渲染什么」：字段缺席（旧产物 / rig 没跑）返回 null，页面标未产出不猜数。
export interface PurpleBlindSpotView {
  family: string;
  misses: number;
  /** 该族未发现的 fixture 名（rig 盲区聚类原样）。 */
  fixtures: string[];
  /** 该补的工具维度（映射表标注 + 循环 gap 口径，rig 原样）。 */
  missingDimensions: string[];
}

export interface PurpleView {
  discovered: number;
  fixtures: number;
  /** "5/11" 形态（页面直挂）。 */
  fraction: string;
  pct: string | null;
  weakestFamily: string | null;
  blindSpots: PurpleBlindSpotView[];
}

/** latest.json.purple → 页面视图模型（自主发现率 + 盲区聚类摘要）。 */
export function purpleView(report: EvalReport): PurpleView | null {
  const p = report.purple;
  if (!p) return null;
  return {
    discovered: p.discovered,
    fixtures: p.fixtures,
    fraction: `${p.discovered}/${p.fixtures}`,
    pct: pct(p.discovery_rate),
    weakestFamily: p.weakest_family ?? null,
    blindSpots: (p.blind_spots ?? []).map((c) => ({
      family: c.family,
      misses: c.misses,
      fixtures: c.fixtures,
      missingDimensions: c.missing_dimensions,
    })),
  };
}

export interface EvalView {
  runAt: string;
  lane: string;
  testedModel?: string;
  accuracy: string | null;
  passRate: string | null;
  totals: EvalReport["totals"];
  faces: AttackFace[];
  facets: FacetCount[];
  skipped: string[];
  defenseNote: string;
  hasAttackData: boolean;
  cost: CostTotals;
  costs?: EvalReport["costs"];
  /** 票 91：紫队闭环（自主发现率 + 盲区聚类）；null = 旧产物没有这段。 */
  purple: PurpleView | null;
  cases: EvalReport["cases"];
  judgeNote: string;
}

/** latest.json → 页面视图模型（三维：准确率 / 防线拦截 / 成本耗时；票 91 起加紫队段）。 */
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
    facets: interceptFacets(report),
    skipped: attackSkipped(report),
    defenseNote: report.defense_interception?.note ?? "",
    hasAttackData: faces.length > 0,
    cost: costTotals(report),
    costs: report.costs,
    purple: purpleView(report),
    cases: report.cases,
    judgeNote: report.judge?.note ?? "",
  };
}
