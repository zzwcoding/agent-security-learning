// m6 富化 worker · analyzer 描述符 + TLP/PAP 确定性闸门 + fixture 情报表（票 15）。
//
// m6 卡 Seam ①②：analyzer 执行 = adapter（microsandbox 真跑 / fixture 表 mock，默认
// mock）；TLP/PAP 闸门 = 确定性中间件，在工具包装层执行、不靠 prompt 自觉。
//
// 三个部件：
//   ANALYZERS      —— Cortex analyzer 描述符子集：dataTypes（可接受的 observable 类型）
//                     + max_tlp/max_pap（数据敏感度超过即拒绝执行，OPSEC，A.1 一字不差
//                     两个 analyzer 都是 2/2）。
//   tlpPapGate     —— 闸门本体：observable 的 tlp > max_tlp（或 pap > max_pap）→ 拒绝，
//                     errorMessage 照 PRD §6-M6 拒绝样例逐字（`tlp_exceeded: observable
//                     tlp=4 > max_tlp=2`）。纯函数、同入同出——「确定性」就是这个意思。
//   FixtureAnalyzerTable —— 情报表 mock backend：fixtures/ti/<data>.json 命中即回
//                     Cortex 返回契约（success/summary.taxonomies/full/artifacts），
//                     未命中回 no-record 而非错误（PRD：对齐 VT 87104 无记录语义）。
//
// 谁生产、谁消费：flow 的 analyze 包装层在验票（gated）之后、外发（lookup）之前调闸门；
// 闸拒的调用一个字节都到不了 fixture 表/真 analyzer——「TLP:RED 不外发」压在这里。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type AnalyzerName = "vt_lookup" | "ip_reputation";

/** Cortex analyzer 调用契约四元组（PRD §6-M6 调用样例原样）。tlp/pap 随 observable
 *  挂载（§5.3「observable 级独立挂载，是 M6 富化闸门的输入」）。 */
export interface AnalyzerCall {
  data: string;
  dataType: string;
  tlp: number;
  pap: number;
}

/** analyzer 描述符（Cortex dataTypeList + max_tlp/max_pap 裁剪版，PRD §4.3）。
 *  A.1：vt_lookup / ip_reputation 都挂 max_tlp=2 / max_pap=2 闸门。 */
export interface AnalyzerDescriptor {
  max_tlp: number;
  max_pap: number;
  dataTypes: readonly string[];
}

export const ANALYZERS: Record<AnalyzerName, AnalyzerDescriptor> = {
  vt_lookup: { max_tlp: 2, max_pap: 2, dataTypes: ["hash", "domain", "fqdn"] },
  ip_reputation: { max_tlp: 2, max_pap: 2, dataTypes: ["ip"] },
};

/** taxonomy 四档（FR-M6.1/FR-M6.4）：info/safe/suspicious/malicious，渲染进富化报告。 */
export type TaxonomyLevel = "info" | "safe" | "suspicious" | "malicious";

export interface AnalyzerTaxonomy {
  namespace?: string;
  predicate: string;
  value?: string;
  level: TaxonomyLevel;
}

/** Cortex analyzer 返回契约（PRD §6-M6 返回样例）：成功带 taxonomies/full/artifacts，
 *  拒绝带 success:false + errorMessage（闸门拒也走这个形状，对调用方一视同仁）。 */
export interface AnalyzerResult {
  success: boolean;
  summary: { taxonomies: AnalyzerTaxonomy[] };
  full?: unknown;
  artifacts?: { dataType: string; data: string }[];
  errorMessage?: string;
}

export type GateVerdict = { ok: true } | { ok: false; errorMessage: string };

/** TLP/PAP 闸门本体（m6 卡 Seam ②，FR-M6.2）。先 tlp 后 pap（先撞先报）；边界不冤枉：
 *  等于 max 放行，只有「大于」才拒。errorMessage 是契约——审计与富化报告逐字引用。 */
export function tlpPapGate(call: AnalyzerCall, analyzer: AnalyzerDescriptor): GateVerdict {
  if (call.tlp > analyzer.max_tlp) {
    return { ok: false, errorMessage: `tlp_exceeded: observable tlp=${call.tlp} > max_tlp=${analyzer.max_tlp}` };
  }
  if (call.pap > analyzer.max_pap) {
    return { ok: false, errorMessage: `pap_exceeded: observable pap=${call.pap} > max_pap=${analyzer.max_pap}` };
  }
  return { ok: true };
}

/** analyzer backend seam：真跑（microsandbox，票 16 攻击面切真）/ fixture 表 mock
 *  都实现它；flow 的探针（测试）也包一层它来断言「谁真被打到」。 */
export interface AnalyzerBackend {
  lookup(analyzer: AnalyzerName, call: AnalyzerCall): Promise<AnalyzerResult>;
}

/** 未命中的固定返回（PRD 原文：`{"success":true,"summary":{"taxonomies":[{"level":
 *  "info","predicate":"no-record"}]}}`）——是「没查到」，不是错误。 */
export const NO_RECORD: AnalyzerResult = {
  success: true,
  summary: { taxonomies: [{ level: "info", predicate: "no-record" }] },
};

/** fixture 表 mock analyzer（m6 卡 Adapter，FR-M6.1「结果由内置情报 fixture 表驱动」）。
 *  表文件按 observable 的 data 值命名：fixtures/ti/<sha1|ip|domain>.json——情报库就是
 *  一个目录，命中读文件、未命中 no-record，没有任何网络。 */
export class FixtureAnalyzerTable implements AnalyzerBackend {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async lookup(_analyzer: AnalyzerName, call: AnalyzerCall): Promise<AnalyzerResult> {
    let raw: { taxonomies?: AnalyzerTaxonomy[]; full?: unknown; artifacts?: { dataType: string; data: string }[] };
    try {
      raw = JSON.parse(await readFile(join(this.dir, `${call.data}.json`), "utf8"));
    } catch {
      return { ...NO_RECORD, summary: { taxonomies: NO_RECORD.summary.taxonomies.map((t) => ({ ...t })) } };
    }
    return {
      success: true,
      summary: { taxonomies: (raw.taxonomies ?? []).map((t) => ({ ...t })) },
      full: raw.full,
      artifacts: (raw.artifacts ?? []).map((a) => ({ ...a })),
    };
  }
}
