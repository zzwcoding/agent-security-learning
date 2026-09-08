// m6 富化 worker · 工具签名契约（票 15）。
//
// A.1 富化工具面 + Cortex 契约子集：vt_lookup / ip_reputation 的参数就是 Cortex
// analyzer 调用契约四元组 {data, dataType, tlp, pap}（PRD §6-M6「工具签名即 Cortex
// 契约子集」），tlp/pap 随 observable 传入——闸门吃的是可信数值，所以签名层先把
// 「不是整数 / 越枚举界」的调用挡在门外，TLP/PAP 闸门（analyzers.ts）只管业务语义。
//
// 分层（本票最容易混的地方）：
//   签名契约（本文件）= 数值类型与枚举界：tlp ∈ 0-4、pap ∈ 0-3（PRD §5.3 TheHive
//   5.2 后口径）。tlp=4 的调用签名合法——拒它是 TLP 闸门的活，不是这里的活。
//   TLP/PAP 闸门（analyzers.tlpPapGate）= analyzer 描述符的 max_tlp/max_pap 语义：
//   超限即拒 + DENIED 审计，不外发（FR-M6.2，OPSEC）。
import type { AnalyzerCall, AnalyzerName } from "./analyzers.js";

/** 富化工具面（PRD A.1 富化行一字不差）：analyzer 只读两件套（L0 flavor）+ 写回两件套
 *  （add_observable artifacts 回写、add_timeline_entry 富化报告落库，均 L1 共用写）。
 *  无任何 L2（INV-3：isolate_host/block_ip/kb_write 不在任何 worker 票面里）。 */
export const ENRICHMENT_TOOLS = [
  "vt_lookup",
  "ip_reputation",
  "add_observable",
  "add_timeline_entry",
] as const;

/** 工具签名（契约自证面）：analyzer 两件套的 required 就是 §6-M6 调用契约四元组。 */
export const TOOL_SCHEMAS: Record<string, { description: string; required: string[]; optional: string[] }> = {
  vt_lookup: {
    description: "VirusTotal 风格 hash/domain/fqdn 信誉查询（Cortex analyzer 只读 flavor，max_tlp=2/max_pap=2 闸门）",
    required: ["data", "dataType", "tlp", "pap"],
    optional: [],
  },
  ip_reputation: {
    description: "IP 信誉查询（Cortex analyzer 只读 flavor，同上闸门）",
    required: ["data", "dataType", "tlp", "pap"],
    optional: [],
  },
  add_observable: {
    description: "analyzer 提取的新 observable 回写案件（L1 写；按 dataType+data 去重合并，FR-M6.3）",
    required: ["case_id", "dataType", "data"],
    optional: ["tags", "message"],
  },
  add_timeline_entry: {
    description: "写案件时间线条目（L1 写；富化报告的落库通道，kind 限 §5.5 枚举）",
    required: ["case_id", "kind", "body"],
    optional: ["structured"],
  },
};

export type ToolCallVerdict = { ok: true } | { ok: false; error: string };

// PRD §5.3 observable.dataType 十类枚举（15 枚举裁掉 demo 用不到的）
const OBSERVABLE_DATA_TYPES = new Set([
  "ip", "domain", "fqdn", "url", "uri_path", "hash", "filename", "hostname", "mail", "other",
]);

// PRD §5.5 TimelineEntry.kind 枚举（add_timeline_entry 的 kind 契约）
const TIMELINE_KINDS = new Set([
  "note", "investigation_report", "enrichment_report", "approval", "execution", "system",
]);

// TLP/PAP 枚举界（PRD §5.3：TLP 0-4 CLEAR/GREEN/AMBER/AMBER+STRICT/RED；PAP 0-3 WHITE/GREEN/AMBER/RED）。
// 只验「是整数且在枚举界内」；超 analyzer max_tlp/max_pap 是闸门的语义，不在这层管。
const TLP_MAX = 4;
const PAP_MAX = 3;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const isIntInRange = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** analyzer 调用四元组把关：data/dataType/tlp/pap 全给、dataType 在该 analyzer 的
 *  dataTypes 里、tlp/pap 是界内整数。返回错误码逐一可断言（契约即测试）。 */
function checkAnalyzerCall(analyzer: AnalyzerName, params: Record<string, unknown>): ToolCallVerdict {
  if (!nonEmpty(params.data)) return { ok: false, error: "data_required" };
  if (!nonEmpty(params.dataType)) return { ok: false, error: "dataType_required" };
  const call = params as unknown as AnalyzerCall;
  if (!ANALYZER_DATA_TYPES[analyzer].includes(call.dataType)) return { ok: false, error: "bad_dataType" };
  if (params.tlp === undefined) return { ok: false, error: "tlp_required" };
  if (!isIntInRange(params.tlp, TLP_MAX)) return { ok: false, error: "bad_tlp" };
  if (params.pap === undefined) return { ok: false, error: "pap_required" };
  if (!isIntInRange(params.pap, PAP_MAX)) return { ok: false, error: "bad_pap" };
  return { ok: true };
}

// 各 analyzer 可接受的 observable 类型（与 analyzers.ts 描述符 dataTypes 同源——
// 这里只做「调不调得通」的签名判断，max_tlp/max_pap 闸门在 analyzers.tlpPapGate）
const ANALYZER_DATA_TYPES: Record<AnalyzerName, readonly string[]> = {
  vt_lookup: ["hash", "domain", "fqdn"],
  ip_reputation: ["ip"],
};

/** 工具签名契约的强制点。富化子图是确定性管线（不产自由参数），这里是给「谁将来
 *  想接 LLM 决策」立的契约门：违约调用不执行、不烧 analyzer 配额，错误码逐字可断言。 */
export function validateToolCall(tool: string, params: Record<string, unknown>): ToolCallVerdict {
  if (!(ENRICHMENT_TOOLS as readonly string[]).includes(tool)) return { ok: false, error: "unknown_tool" };
  switch (tool) {
    case "vt_lookup":
    case "ip_reputation":
      return checkAnalyzerCall(tool, params);
    case "add_observable": {
      if (!nonEmpty(params.case_id)) return { ok: false, error: "case_id_required" };
      if (!nonEmpty(params.dataType)) return { ok: false, error: "dataType_required" };
      if (!OBSERVABLE_DATA_TYPES.has(params.dataType as string)) return { ok: false, error: "bad_dataType" };
      if (!nonEmpty(params.data)) return { ok: false, error: "data_required" };
      if (params.tags !== undefined) {
        const tags = params.tags;
        if (!Array.isArray(tags) || tags.some((t) => !nonEmpty(t))) return { ok: false, error: "bad_tags" };
      }
      return { ok: true };
    }
    case "add_timeline_entry": {
      if (!nonEmpty(params.case_id)) return { ok: false, error: "case_id_required" };
      if (!nonEmpty(params.kind) || !TIMELINE_KINDS.has(params.kind as string)) return { ok: false, error: "bad_kind" };
      return nonEmpty(params.body) ? { ok: true } : { ok: false, error: "body_required" };
    }
    default:
      return { ok: false, error: "unknown_tool" };
  }
}
