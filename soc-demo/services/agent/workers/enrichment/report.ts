// m6 富化 worker · 富化报告渲染（票 15，FR-M6.4）。
//
// taxonomy 四档 info/safe/suspicious/malicious 写进富化报告（人读 markdown 进 timeline
// body + 机读 structured 进 structured 列，票 14 起透传）。渲染是纯函数：同样的富化
// 结果永远渲出同样的报告——重放幂等测试靠它。
import type { AnalyzerTaxonomy, TaxonomyLevel } from "./analyzers.js";

/** 单个 observable 的富化结论（报告 results 行的最小完整形状）。ok=false 时 refused
 *  必填（TLP/PAP 拒因逐字进报告——「不降级不外发」的对外口径：写明为什么没查）。 */
export interface EnrichedItem {
  analyzer: string;
  data: string;
  dataType: string;
  tlp: number;
  pap: number;
  ok: boolean;
  level?: TaxonomyLevel;
  taxonomies?: AnalyzerTaxonomy[];
  /** TLP/PAP 超限或 analyzer 报错时的逐字拒因（PRD §6-M6 errorMessage 原文） */
  refused?: string;
  /** guards 命中标记（tool_output 通道 flag 策略：放行但打标，原文保留待人工复核） */
  flagged?: boolean;
}

// 严重度序：下标越大越严重；worstLevel 取最严重档
const LEVEL_ORDER: readonly TaxonomyLevel[] = ["info", "safe", "suspicious", "malicious"];

/** 取一组 taxonomy 的最严重档（报告 summary 与评级栏用它）。空数组 = 没有评级。 */
export function worstLevel(taxonomies: { level: TaxonomyLevel }[]): TaxonomyLevel | undefined {
  let worst: TaxonomyLevel | undefined;
  for (const t of taxonomies) {
    if (worst === undefined || LEVEL_ORDER.indexOf(t.level) > LEVEL_ORDER.indexOf(worst)) {
      worst = t.level;
    }
  }
  return worst;
}

export interface ReportInput {
  case_id: string;
  title: string;
  summary: string;
  results: EnrichedItem[];
  /** 本次回写的 artifacts（dedup = 案件里已有，只是并了 tags，没建新行） */
  artifacts_written: { dataType: string; data: string; dedup: boolean }[];
  refused_count: number;
  /** 内部实体（hostname/filename 等）不外发的跳过数——「为什么只查了 N 项」的对账栏 */
  skipped_internal: number;
}

const taxonomyLine = (t: AnalyzerTaxonomy): string =>
  [t.namespace, t.predicate].filter(Boolean).join(":") + (t.value ? `=${t.value}` : "");

/** 富化报告 markdown（timeline body）。可 grep 的标记是契约：[malicious]/[suspicious]/
 *  [refused] 评级栏、guards 打标说明、四档图例——Web 案件页与 eval 都靠这些锚点读。 */
export function renderReportMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`## 富化报告 · ${input.case_id}`);
  lines.push(`**案件**: ${input.title}`);
  lines.push("");
  lines.push(input.summary);
  lines.push("");
  lines.push("### 逐项结果");
  for (const r of input.results) {
    const base = `- [${r.ok ? (r.level ?? "info") : "refused"}] \`${r.analyzer}\` ${r.dataType} \`${r.data}\`（tlp=${r.tlp}/pap=${r.pap}）`;
    if (!r.ok) {
      lines.push(`${base} → 未外发：${r.refused ?? "analyzer_error"}`);
      continue;
    }
    const tax = (r.taxonomies ?? []).map(taxonomyLine).join("、") || "no-record";
    lines.push(`${base} → ${tax}`);
    if (r.flagged) {
      lines.push(`  ⚠ guards：tool_output 通道命中注入特征，已打标放行，原文保留待人工复核（flag ≠ 拦截）`);
    }
  }
  lines.push("");
  lines.push("### artifacts 回写");
  if (input.artifacts_written.length === 0) {
    lines.push("（无）");
  } else {
    for (const a of input.artifacts_written) {
      lines.push(`- ${a.dataType} \`${a.data}\`（dedup: ${a.dedup ? "是，并 tags 未建新行" : "否，新建"})`);
    }
  }
  lines.push("");
  lines.push(`> 图例：taxonomy 四档 malicious / suspicious / safe / info；[refused] = TLP/PAP 超限未外发；内部实体跳过 ${input.skipped_internal} 项。`);
  return lines.join("\n");
}
