// m6 富化 worker · 富化子图（票 15）。
//
// PRD §6-M6：对 Case observables 跑 analyzer（Cortex 契约子集）+ TLP/PAP 闸门控制外发
// + artifacts 回写。富化是**确定性管线**——查什么、按什么顺序、拒绝怎么办全在代码里，
// 没有 LLM 决策点（m6 卡职责里没有「判断」，只有「查、闸、回写」），所以本 worker 没有
// llm seam；与票 13/14 共享的是安全骨架：gated() 唯一入口过验票闸（任务票 scope 无 L2，
// INV-3），闸拒 = 审计 DENIED + 抛错强杀（INV-1 不吞错）。
//
// 子图三节点：load_case（读案件 observables）→ enrich（逐项：闸→查→扫→回写）→
// write_report（富化报告进 timeline）。子图输入 {case_id, ticket}（m6 卡公开接口）。
//
// 每个可外发 observable 的旅程（顺序即安全设计）：
//   ① 验票闸（gated：任务票 allowed_tools 含该 analyzer，run 绑定）
//   ② TLP/PAP 确定性闸门（m6 卡 Seam：observable 的 tlp/pap > analyzer max → 拒 +
//      DENIED 审计 + 报告如实记录拒因，一个字节都不外发——fail-closed 不等于摊牌，
//      拒绝是工具级结果，run 照常跑完出报告）
//   ③ analyzer 查询（FixtureAnalyzerTable / 将来 microsandbox 真跑，票 16）
//   ④ guards 扫描 analyzer 输出（tool_output 通道 = flag 策略，票 04：投毒输出放行
//      但打标，原文保留待人工复核——analyzer 是第三方可污染件，这是第四攻击面的
//      内容半边）。票 50：扫描显式 failMode:"flag"——guards 不可达折成 flag 打标
//      留痕（reason 可 grep），不再静默放行。
//   ⑤ artifacts 回写（analyzer 提取的新 observable 经 add_observable L1 写回，M2 按
//      dataType+data 去重合并）
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { makeGatedCall } from "../../src/gated-call.js";
import type { AuditSink } from "../../src/audit.js";
import type { ScanChannel, ScanDecision, ScanOptions } from "../../src/guards-client.js";
import { ANALYZERS, tlpPapGate, type AnalyzerBackend, type AnalyzerCall, type AnalyzerName, type AnalyzerResult } from "./analyzers.js";
import { validateToolCall } from "./tools.js";
import { renderReportMarkdown, worstLevel, type EnrichedItem } from "./report.js";
import type { EnrichmentM2 } from "./m2.js";

const ACTOR = { type: "agent", id: "agent:enrichment" } as const;

/** observable 类型 → analyzer 的映射。只有 IOC 形态的类型外发（hash/domain/fqdn →
 *  vt_lookup，ip → ip_reputation）；hostname/filename/url 等内部实体不查外部信誉
 *  （「不外发」清单的另一半：类型不外发 + 敏感度超限不外发，两道各管各的）。 */
const ANALYZER_OF: Record<string, AnalyzerName | undefined> = {
  hash: "vt_lookup",
  domain: "vt_lookup",
  fqdn: "vt_lookup",
  ip: "ip_reputation",
};

export interface EnrichmentDeps {
  runId: string;
  requestId: string;
  /** 子图输入：案件 id（m6 卡公开接口 {case_id, ticket}）。 */
  caseId: string;
  /** L1 任务票 wire 串（m3 拉起 worker 时经 gateway 铸出，allowed_tools=ENRICHMENT_TOOLS）。 */
  ticket: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  m2: EnrichmentM2;
  /** analyzer backend（m6 卡 Seam ①：fixture 表 mock / microsandbox 真跑）。 */
  analyzers: AnalyzerBackend;
  /** guards 扫描口（tool_output 通道；生产 = scanInjection，测试 = fakeScan）。
   *  票 50（方案 a）：消费点显式传 {failMode:"flag"}——guards 不可达时客户端折成
   *  flag 打标裁决（reason=guards_unreachable 可 grep），不再按缺省 block 折成
   *  fail_closed 被消费点落空即静默放行。签名风格与 triage 的 ScanFn 一致。 */
  scan: (text: string, channel: ScanChannel, opts?: ScanOptions) => Promise<ScanDecision>;
  audit: AuditSink;
}

interface EnrichmentState {
  items: EnrichedItem[];
  artifacts_written: { dataType: string; data: string; dedup: boolean }[];
  refused_count: number;
  skipped_internal: number;
}

// analyze 包装层的返回：refused（闸拒/analyzer 报错）与 result（真查到了）二选一
type AnalyzerOutcome =
  | { kind: "refused"; errorMessage: string }
  | { kind: "result"; payload: AnalyzerResult };

export function makeEnrichmentFlow(deps: EnrichmentDeps): FlowNode[] {
  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    deps.audit.record({ ...entry, actor: ACTOR, requestId: deps.requestId, createdAt: Date.now() });
  };

  /** 工具调用唯一入口：广播 tool_call → verifyTicket（L1 任务票）→ 放行执行 →
   *  tool_result。闸拒 = 审计 DENIED + 抛错（runner 强杀 run；INV-1 不吞错）。
   *  票 43：闸体收进共享 makeGatedCall（与票 13/14 同款——全 worker 一个安全骨架，
   *  差别只在执行体与本文件的三个差异点声明）。 */
  const cursor = { node: "" };
  const gated = makeGatedCall({
    prefix: "enrichment",
    hmacKey: deps.hmacKey,
    creds: () => ({ ticket: deps.ticket, runId: deps.runId }),
    deny: () => ({
      record,
      objectId: deps.runId,
      objectType: "tool_call",
      extraDetails: { node: cursor.node },
    }),
    emitToolCall: (ctx, { tool, paramsHash: hash }) =>
      ctx.emit("tool_call", { node: cursor.node, tool, params_hash: hash }),
    emitToolResult: (ctx, { tool }) => ctx.emit("tool_result", { node: cursor.node, tool, ok: true }),
  });

  /** analyzer 工具的执行包装层：签名契约 → 验票闸（gated）→ TLP/PAP 确定性闸门 →
   *  才轮到 backend。闸拒在包装层就地解决：DENIED 审计 + refused 结论，不外发、
   *  不抛不杀（拒绝是数据敏感度语义，不是授权链缺口——授权链缺口才强杀）。 */
  async function analyze(ctx: NodeCtx, call: AnalyzerCall, analyzer: AnalyzerName): Promise<AnalyzerOutcome> {
    const sig = validateToolCall(analyzer, { ...call });
    if (!sig.ok) return { kind: "refused", errorMessage: `signature:${sig.error}` };
    const payload = await gated(ctx, analyzer, { ...call }, async (): Promise<AnalyzerOutcome> => {
      const gate = tlpPapGate(call, ANALYZERS[analyzer]); // 确定性中间件：同入同出，不靠 prompt
      if (!gate.ok) {
        record({
          action: "tlp_pap_denied",
          objectId: deps.caseId,
          objectType: "analyzer_call",
          details: { analyzer, ...call, error: gate.errorMessage },
          result: "DENIED",
        });
        return { kind: "refused", errorMessage: gate.errorMessage };
      }
      return { kind: "result", payload: await deps.analyzers.lookup(analyzer, call) };
    });
    return payload;
  }

  const nodes: FlowNode[] = [
    {
      name: "load_case",
      run: async (ctx) => {
        cursor.node = "load_case";
        // run 主体的装配读（case_id 来自 run 交接态）——M2 直连 adapter 读，不经
        // 工具面（票 13/14 的 load/claim 同类：读自己要处理的上下文不算工具调用）。
        const detail = await deps.m2.getCaseDetail(deps.caseId);
        if (!detail) throw new Error(`case_not_found:${deps.caseId}`);
        ctx.state.case = detail;
      },
    },
    {
      name: "enrich",
      run: async (ctx) => {
        cursor.node = "enrich";
        const detail = ctx.state.case as { id: string; observables?: { dataType: string; data: string; tlp: number; pap: number }[] };
        const state: EnrichmentState = {
          items: [],
          artifacts_written: [],
          refused_count: 0,
          skipped_internal: 0,
        };

        for (const o of detail.observables ?? []) {
          const analyzer = ANALYZER_OF[o.dataType];
          if (!analyzer) {
            state.skipped_internal += 1; // 内部实体不外发，报告对账栏交代去向
            continue;
          }
          const call: AnalyzerCall = { data: o.data, dataType: o.dataType, tlp: o.tlp, pap: o.pap };
          const outcome = await analyze(ctx, call, analyzer);
          if (outcome.kind === "refused") {
            state.refused_count += 1;
            state.items.push({ analyzer, ...call, ok: false, refused: outcome.errorMessage });
            continue;
          }

          // guards：analyzer 输出属 tool_output 通道（票 04 策略表 = flag）——analyzer
          // 是可被污染的第三方件，命中注入特征的输出放行但打标，原文保留待人复核。
          // 票 50（方案 a）：显式传 failMode:"flag"——guards 不可达时客户端折成
          // {action:"flag", reason:"guards_unreachable"} 走同一打标语义，降级成为
          // 看得见的事件；details 的 score/reason 一律 ?? null 兜底，不落 undefined
          // 字段（JSON 序列化不丢键）。
          const payload = outcome.payload;
          let flagged = false;
          if (!payload.success) {
            // analyzer 本体报错 ≠ 闸拒：如实记 refused，不编造「查过了」
            state.refused_count += 1;
            state.items.push({ analyzer, ...call, ok: false, refused: payload.errorMessage ?? "analyzer_error" });
            continue;
          }
          const decision = await deps.scan(JSON.stringify(payload), "tool_output", { failMode: "flag" });
          if (decision.action === "flag") {
            flagged = true;
            record({
              action: "tool_output_flagged",
              objectId: deps.caseId,
              objectType: "analyzer_output",
              details: { analyzer, data: call.data, dataType: call.dataType, channel: "tool_output", score: decision.score ?? null, reason: decision.reason ?? null },
              result: "SUCCESS",
            });
          }

          state.items.push({
            analyzer,
            ...call,
            ok: true,
            level: worstLevel(payload.summary.taxonomies),
            taxonomies: payload.summary.taxonomies,
            ...(flagged ? { flagged: true } : {}),
          });

          // FR-M6.3：analyzer 提取的 artifacts 经 L1 add_observable 回写案件
          for (const a of payload.artifacts ?? []) {
            const params = { case_id: deps.caseId, dataType: a.dataType, data: a.data, tags: [`from:${analyzer}`] };
            const { dedup } = await gated(ctx, "add_observable", params, () =>
              deps.m2.addObservable(deps.caseId, { dataType: a.dataType, data: a.data, tags: [`from:${analyzer}`] }),
            );
            state.artifacts_written.push({ dataType: a.dataType, data: a.data, dedup });
          }
        }

        ctx.state.enrichment = state;
      },
    },
    {
      name: "write_report",
      run: async (ctx) => {
        cursor.node = "write_report";
        const detail = ctx.state.case as { title: string };
        const en = ctx.state.enrichment as EnrichmentState;
        const summary = buildSummary(en);
        const body = renderReportMarkdown({
          case_id: deps.caseId,
          title: detail.title,
          summary,
          results: en.items,
          artifacts_written: en.artifacts_written,
          refused_count: en.refused_count,
          skipped_internal: en.skipped_internal,
        });
        const structured = {
          case_id: deps.caseId,
          summary,
          results: en.items,
          artifacts_written: en.artifacts_written,
          refused_count: en.refused_count,
          skipped_internal: en.skipped_internal,
        };
        const params: Record<string, unknown> = { case_id: deps.caseId, kind: "enrichment_report", body, structured };
        await gated(ctx, "add_timeline_entry", params, () =>
          deps.m2.addTimelineEntry(deps.caseId, {
            kind: "enrichment_report",
            author: ACTOR.id,
            body,
            structured,
          }),
        );
        ctx.state.outcome = { report_written: true };
      },
    },
  ];
  return nodes;
}

/** summary 一句话对账：几项查了、评级分布、几项 no-record、几项被拒、几项内部跳过。
 *  评级名与 no-record 字样进 summary（机读面 eval 直接 grep 这两个字段）。 */
function buildSummary(en: EnrichmentState): string {
  const byLevel = { malicious: 0, suspicious: 0, safe: 0, info: 0 };
  let noRecord = 0;
  for (const i of en.items) {
    if (i.ok && i.level) byLevel[i.level] += 1;
    if (i.taxonomies?.some((t) => t.predicate === "no-record")) noRecord += 1;
  }
  const noRecordPart = noRecord > 0 ? `（其中 no-record ${noRecord} 项）` : "";
  return (
    `查了 ${en.items.length} 个 observable：malicious ${byLevel.malicious}、suspicious ${byLevel.suspicious}、` +
    `safe ${byLevel.safe}、info ${byLevel.info}${noRecordPart}；TLP/PAP 拒绝 ${en.refused_count} 项；内部实体跳过 ${en.skipped_internal} 项。`
  );
}
