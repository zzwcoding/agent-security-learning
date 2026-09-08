// m5 调查 worker · LLM seam + fixture 伪 LLM（票 14）。
//
// m5 卡 Seam 的 LLM 侧照票 13 先例：真 minimax-m2 经凭证代理（票 17+ 接，base_url
// 指 gateway /proxy/llm）/ eval fixture 伪 LLM。伪 LLM 的决策规则 = prompt 契约里
// 的调查步法的确定性版（SIEM pivot → 关联告警 → KB 核验 → 收口出报告），不偷看
// fixture 名——它只读 CaseView 与观察记录，测试里「说谎的 LLM」另外注入。
import type {
  DecideCall,
  PlanCall,
  ReportCall,
  SummarizeCall,
} from "./prompt.js";
import type { InvestigationReport } from "./schema.js";

/** 循环一步的裁决：要么发起一次工具调用，要么收口（HolmesGPT ToolCallingLLM.call()
 *  范式的最小形态——「LLM 决定调什么工具」是决策，「能不能调」是闸的事）。 */
export type LoopDecision =
  | { kind: "tool"; tool: string; params: Record<string, unknown> }
  | { kind: "finish" };

export interface InvestigationLlm {
  plan(call: PlanCall): Promise<{ tasks: string[]; tokens: number }>;
  decide(call: DecideCall): Promise<LoopDecision & { tokens: number }>;
  /** 上下文治理的小模型摘要（llm_summarize）：只压工具输出，不做决策。 */
  summarize(call: SummarizeCall): Promise<{ summary: string; tokens: number }>;
  report(call: ReportCall): Promise<{ text: string; tokens: number }>;
}

const DAY_MS = 24 * 3_600_000;

/** primary alert 日期 ±24h 的查询窗（FR-M5.1 强制 time_window：窗从案件事实来）。 */
function windowAround(anchorMs: number): { from: string; to: string } {
  return {
    from: new Date(anchorMs - DAY_MS).toISOString(),
    to: new Date(anchorMs + DAY_MS).toISOString(),
  };
}

export class FakeInvestigationLlm implements InvestigationLlm {
  private readonly tokensPerCall: number;

  constructor(tokensPerCall = 32) {
    this.tokensPerCall = tokensPerCall;
  }

  async plan(call: PlanCall): Promise<{ tasks: string[]; tokens: number }> {
    const e = call.input.case.entities;
    const pivot = e.ips[0] ?? e.users[0] ?? e.hosts[0];
    const tasks: string[] = [];
    if (pivot) tasks.push(`siem_query 按 ${pivot} pivot 查询（强制时间窗）`);
    if (e.hosts[0]) tasks.push(`related_alerts 聚合同主机 ${e.hosts[0]} 的历史告警`);
    if (e.hosts[0] || e.users[0]) tasks.push("kb_verify 内部事实核验（资产/用户清单）");
    return { tasks, tokens: this.tokensPerCall };
  }

  async decide(call: DecideCall): Promise<LoopDecision & { tokens: number }> {
    const { case: kase, observations } = call.input;
    const done = new Set(observations.filter((o) => o.ok).map((o) => o.tool));
    const e = kase.entities;
    const win = windowAround(kase.primaryAlertDate);

    if (!done.has("siem_query")) {
      // FR-M5.1 pivot 顺序：ip → user → host（有哪个实体查哪个）
      if (e.ips[0]) return { kind: "tool", tool: "siem_query", params: { entity_type: "ip", entity: e.ips[0], time_window: win }, tokens: this.tokensPerCall };
      if (e.users[0]) return { kind: "tool", tool: "siem_query", params: { entity_type: "user", entity: e.users[0], time_window: win }, tokens: this.tokensPerCall };
      if (e.hosts[0]) return { kind: "tool", tool: "siem_query", params: { entity_type: "host", entity: e.hosts[0], time_window: win }, tokens: this.tokensPerCall };
    }
    if (!done.has("related_alerts") && e.hosts[0]) {
      // FR-M5.2 同主机历史告警聚合
      return { kind: "tool", tool: "related_alerts", params: { scope: "host", value: e.hosts[0], time_window: win }, tokens: this.tokensPerCall };
    }
    if (!done.has("kb_verify") && (e.hosts[0] || e.users[0])) {
      // FR-M5.3 KB 核验（approved 条目）
      return {
        kind: "tool",
        tool: "kb_verify",
        params: { host: e.hosts[0] ?? "", user: e.users[0] ?? "" },
        tokens: this.tokensPerCall,
      };
    }
    return { kind: "finish", tokens: this.tokensPerCall };
  }

  async summarize(call: SummarizeCall): Promise<{ summary: string; tokens: number }> {
    // 确定性摘要替身：截头 + 计数标记（真件 = 小模型摘要，只压上下文不做决策）
    const head = call.text.slice(0, 120).replace(/\s+/g, " ");
    return { summary: `${head}…[llm_summarize: 原文 ${call.text.length} 字符已摘要]`, tokens: 16 };
  }

  async report(call: ReportCall): Promise<{ text: string; tokens: number }> {
    const { case: kase, observations, incomplete } = call.input;
    const siem = observations.find((o) => o.tool === "siem_query" && o.ok);
    const rel = observations.find((o) => o.tool === "related_alerts" && o.ok);
    const kb = observations.find((o) => o.tool === "kb_verify" && o.ok);

    // findings 只从真实观察里长出来——evidence 逐字取自工具输出/摘要/落盘引用
    const findings: InvestigationReport["findings"] = [];
    const totalOf = (o: { payload?: unknown }): number => {
      const p = o.payload as { total?: unknown } | undefined;
      return typeof p?.total === "number" ? p.total : 0;
    };
    if (siem && totalOf(siem) > 0) {
      const p = siem.payload as { hits?: { full_log: string }[]; summary?: string; hits_ref?: string };
      findings.push({
        entity: String(siem.params.entity),
        evidence: p.hits?.[0]?.full_log ?? p.summary ?? p.hits_ref ?? "",
        source_tool: "siem_query",
      });
    }
    if (rel && totalOf(rel) > 0) {
      const p = rel.payload as { alerts: { id: string }[] };
      findings.push({ entity: String(rel.params.value), evidence: p.alerts[0].id, source_tool: "related_alerts" });
    }

    const counts = [
      `siem_query 命中 ${siem ? totalOf(siem) : 0} 条`,
      `related_alerts 命中 ${rel ? totalOf(rel) : 0} 条`,
      `kb_verify 命中 ${kb ? (kb.payload as { hits?: unknown[] }).hits?.length ?? 0 : 0} 条`,
    ].join("，");
    // PRD 异常与边界：0 命中如实写「无关联事件」，不编造
    const noHit = !siem || totalOf(siem) === 0;
    const summary = `${kase.title}：${counts}。${noHit ? "SIEM 无关联事件（如实记录，未编造）。" : ""}`.trim();

    const kbRefs = kb
      ? ((kb.payload as { hits: { kind: string; title: string }[] }).hits ?? []).map((h) => `kb:${h.kind}:${h.title}`)
      : [];

    const report: InvestigationReport = {
      summary,
      severity_assessment: kase.severity,
      confidence: 0.8,
      findings,
      affected_assets: [...kase.entities.hosts],
      recommended_actions:
        kase.severity >= 3 && kase.entities.hosts[0]
          ? [{
              tool: "isolate_host",
              params: { host: kase.entities.hosts[0] },
              justification: "调查认定严重度 ≥3，建议隔离主机（只建议：worker 无 L2 票，执行须人审铸票）",
            }]
          : [],
      kb_refs: kbRefs,
      incomplete: incomplete || undefined,
    };
    return { text: JSON.stringify(report), tokens: this.tokensPerCall };
  }
}
