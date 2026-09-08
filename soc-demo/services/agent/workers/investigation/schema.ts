// m5 调查 worker · 调查报告 schema（票 14，FR-M5.4）。
//
// PRD §6-M5 输出契约逐字段把关——LLM 回包是自由文本，不合 schema 重试 1 次后
// 降级自由文本 + 标记（PRD 异常与边界）。findings 的 source_tool 是否真被调用过
// 由 flow 在循环记录上复核（「引用真实工具输出」的确定性半边；逐字证据比对是
// eval/测试层的另一半断言）。

export interface InvestigationFinding {
  entity: string;
  evidence: string;
  source_tool: string;
}

export interface RecommendedAction {
  tool: string;
  params: Record<string, unknown>;
  justification: string;
}

/** PRD §6-M5 调查报告 schema（输出契约）。incomplete 是 max_steps 截断的部分报告标记。 */
export interface InvestigationReport {
  summary: string;
  severity_assessment: number;
  confidence: number;
  findings: InvestigationFinding[];
  affected_assets: string[];
  recommended_actions: RecommendedAction[];
  kb_refs: string[];
  incomplete?: boolean;
}

export type ReportParseResult =
  | { ok: true; report: InvestigationReport }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** 显式验型（票 13 parseVerdict 同款纪律）：undefined 参与比较会静默漏过，
 *  必须逐字段把关——fail-closed 的 schema 版。 */
export function parseReport(raw: unknown): ReportParseResult {
  try {
    const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!isObj(obj)) return { ok: false, error: "not_an_object" };

    if (!nonEmpty(obj.summary)) return { ok: false, error: "bad_summary" };
    const sev = obj.severity_assessment;
    if (typeof sev !== "number" || !Number.isInteger(sev) || sev < 1 || sev > 4) {
      return { ok: false, error: "bad_severity_assessment" };
    }
    const confidence = obj.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, error: "bad_confidence" };
    }
    if (!Array.isArray(obj.findings)) return { ok: false, error: "bad_findings" };
    const findings: InvestigationFinding[] = [];
    for (const f of obj.findings) {
      if (!isObj(f) || !nonEmpty(f.entity) || !nonEmpty(f.evidence) || !nonEmpty(f.source_tool)) {
        return { ok: false, error: "bad_finding" };
      }
      findings.push({ entity: f.entity, evidence: f.evidence, source_tool: f.source_tool });
    }
    if (!isStrArray(obj.affected_assets)) return { ok: false, error: "bad_affected_assets" };
    if (!Array.isArray(obj.recommended_actions)) return { ok: false, error: "bad_recommended_actions" };
    const actions: RecommendedAction[] = [];
    for (const a of obj.recommended_actions) {
      if (!isObj(a) || !nonEmpty(a.tool) || !nonEmpty(a.justification) || !isObj(a.params)) {
        return { ok: false, error: "bad_recommended_action" };
      }
      actions.push({ tool: a.tool, params: a.params, justification: a.justification });
    }
    if (!isStrArray(obj.kb_refs)) return { ok: false, error: "bad_kb_refs" };
    if (obj.incomplete !== undefined && typeof obj.incomplete !== "boolean") {
      return { ok: false, error: "bad_incomplete" };
    }
    return {
      ok: true,
      report: {
        summary: obj.summary,
        severity_assessment: sev,
        confidence,
        findings,
        affected_assets: obj.affected_assets,
        recommended_actions: actions,
        kb_refs: obj.kb_refs,
        incomplete: obj.incomplete === true ? true : undefined,
      },
    };
  } catch (e) {
    return { ok: false, error: `unparseable:${e instanceof Error ? e.message : String(e)}` };
  }
}

/** TheHive task log 风格的渲染体（TimelineEntry.body）。structured 才是机读真相，
 *  body 是人读的渲染——两者同写一条 timeline（FR-M5.4 双形态）。 */
export function renderReportMarkdown(
  report: InvestigationReport,
  meta: { caseId: string; title: string },
): string {
  const lines: string[] = [
    `## 调查报告 · ${meta.title}`,
    "",
    `- 案件: ${meta.caseId}`,
    `- 结论: ${report.summary}`,
    `- 严重度评估: ${report.severity_assessment}（confidence ${report.confidence}）`,
    "",
    "### Findings（evidence 引用真实工具输出）",
    ...(report.findings.length
      ? report.findings.map((f) => `- [${f.source_tool}] ${f.entity} — ${f.evidence}`)
      : ["- （无——证据缺口如实留白，不编造）"]),
    "",
    `### 影响资产\n${report.affected_assets.length ? report.affected_assets.map((a) => `- ${a}`).join("\n") : "- （无）"}`,
    "",
    "### 建议动作（只建议不执行；L2 须走人审）",
    ...(report.recommended_actions.length
      ? report.recommended_actions.map(
          (a) => `- \`${a.tool}\` ${JSON.stringify(a.params)} — ${a.justification}`,
        )
      : ["- （无）"]),
    "",
    ...(report.kb_refs.length ? [`### KB 引用\n${report.kb_refs.map((k) => `- ${k}`).join("\n")}`] : []),
  ];
  if (report.incomplete) {
    lines.push("", "⚠️ **调查不完整**：max_steps 用尽被截断，以上为部分调查结果。");
  }
  return lines.join("\n");
}
