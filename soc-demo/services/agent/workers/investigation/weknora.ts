// m5 调查 worker · weknora 三工具 Memory stub（票 79③）。
//
// PRD §13.4b 预列的 weknora 三工具（能力菜单 = tools.manifest + 剧本库，CONTEXT 口径）：
//   playbook_lookup    —— 查本地剧本库 fixture（fixtures/weknora/playbooks.json）；
//   graph_query        —— 查本地只读图 fixture（fixtures/weknora/graph.json），
//                          **只回 approved 态关系**（T22/INV-5）；
//   hypothesis_register —— L1 写：假设+证据关系落本地 store，**一律 proposed 态**
//                          （T22/INV-5，人审通道票 83 对接期定端点）。
//
// 铁律（票面）：stub 是真接口假实现（换 weknora HTTP 实现不换调用方，MemoryVectorStore
// 先例）——工具契约（签名/分级/返回形状）由本文件钉死，数据源 seam（WeknoraPlaybookBackend
// / WeknoraGraphBackend）是将来 HTTP adapter 的落点。hypothesis_register 的票面语义按
// L0 裁定②：register 在父票面（outcome 收敛归档步），不入 planner 组合菜单；写动作走
// 验票闸 + 五要素审计（INV-8）——gated 语义在注入的 register seam 实现内完成（m14 只调
// 缝，ports.HypothesisRegisterSeam 公开接口零改动）：
//   · 工具面：register 作为登记工具经 hunt_task 真执行体的验票闸（L1 无票 403 no_ticket、
//     票面外 403 scope_insufficient），闸不过 = 写动作根本到不了 store（fail-closed）；
//   · 循环缝面：outcome 收敛归档步经 makeHuntRegisterSeam 注入——五要素审计在 seam 实现
//     内落账（缺省 MemoryHypothesisRegister 退场，装配层见 index.ts）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuditSink } from "../../src/audit.js";
import type {
  HypothesisRegisterSeam,
  RegisterCall,
  RegisterRecord,
} from "../../src/orchestration/ports.js";
import type { ToolCallVerdict } from "./prompt.js";

// 循环缝类型再出口（ports.HypothesisRegisterSeam 家族的消费方便利；e2e rig 用）
export type { RegisterCall, RegisterRecord, HypothesisRegisterSeam };

// ---------- fixture 缺省路径（workers/investigation → soc-demo/fixtures/weknora/） ----------

const WEKNORA_DIR_URL = new URL("../../../../fixtures/weknora/", import.meta.url);
export const WEKNORA_FIXTURES = fileURLToPath(WEKNORA_DIR_URL);
export const WEKNORA_PLAYBOOKS_FIXTURE = fileURLToPath(new URL("playbooks.json", WEKNORA_DIR_URL));
export const WEKNORA_GRAPH_FIXTURE = fileURLToPath(new URL("graph.json", WEKNORA_DIR_URL));
const GRAPH_FIXTURE = WEKNORA_GRAPH_FIXTURE;

/** weknora 三工具面（playbook_lookup/graph_query = L0 只读；hypothesis_register = L1 写）。 */
export const WEKNORA_TOOLS = [
  "playbook_lookup",
  "graph_query",
  "hypothesis_register",
] as const;

export type WeknoraTool = (typeof WEKNORA_TOOLS)[number];

/** 工具签名（LLM tool schema 的契约面，hunt.ts 同款形状）。required 给契约自证测试看。 */
export const WEKNORA_TOOL_SCHEMAS: Record<
  string,
  { description: string; required: string[]; optional: string[] }
> = {
  playbook_lookup: {
    description:
      "查狩猎剧本库（weknora stub：按族 tag/关键词检索剧本与既定查询——能力菜单的剧本半边）",
    required: [],
    optional: ["tag", "query", "max_results"],
  },
  graph_query: {
    description:
      "查实体关系图（weknora stub：只回 approved 态关系——INV-5 口径，proposed 不进检索面）",
    required: ["entity"],
    optional: ["relation", "max_results"],
  },
  hypothesis_register: {
    description:
      "登记假设-证据-结论关系（L1 写：一律 proposed 态入图，人审通道票 83 对接；走验票闸+五要素审计）",
    required: ["hypothesis_id", "verdict", "confidence", "evidence_hashes"],
    optional: [],
  },
};

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const checkMaxResults = (v: unknown): ToolCallVerdict =>
  v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 1)
    ? { ok: true }
    : { ok: false, error: "bad_max_results" };

/** weknora 工具签名契约的强制点：违约调用不执行、不碰 store，错误作为观察返回给 LLM
 *  （与 validateToolCall/validateHuntToolCall 同款语义）。 */
export function validateWeknoraToolCall(tool: string, params: Record<string, unknown>): ToolCallVerdict {
  if (!(WEKNORA_TOOLS as readonly string[]).includes(tool)) return { ok: false, error: "unknown_tool" };
  switch (tool) {
    case "playbook_lookup": {
      // 与 kb_verify 同款：至少一个过滤维度（防「全库捞」的上下文治理起点）
      if (!nonEmpty(params.tag) && !nonEmpty(params.query)) return { ok: false, error: "lookup_requires_filter" };
      return checkMaxResults(params.max_results);
    }
    case "graph_query": {
      if (!nonEmpty(params.entity)) return { ok: false, error: "entity_required" };
      if (params.relation !== undefined && !nonEmpty(params.relation)) return { ok: false, error: "bad_relation" };
      return checkMaxResults(params.max_results);
    }
    case "hypothesis_register": {
      if (!nonEmpty(params.hypothesis_id)) return { ok: false, error: "hypothesis_id_required" };
      if (params.verdict !== "hit" && params.verdict !== "miss") return { ok: false, error: "bad_verdict" };
      if (
        typeof params.confidence !== "number" ||
        !Number.isFinite(params.confidence) ||
        params.confidence < 0 ||
        params.confidence > 1
      ) {
        return { ok: false, error: "bad_confidence" };
      }
      if (
        !Array.isArray(params.evidence_hashes) ||
        params.evidence_hashes.length === 0 ||
        !params.evidence_hashes.every((h) => nonEmpty(h))
      ) {
        return { ok: false, error: "evidence_hashes_required" };
      }
      return { ok: true };
    }
  }
  // 已登记工具的 switch 之上全部 return；能走到这里只可能是漏登记的调用方
  return { ok: false, error: "unknown_tool" };
}

// ---------- 数据源 seam（换 weknora HTTP 实现不换调用方） ----------

export interface GraphEntity {
  type: string;
  value: string;
}

export interface GraphRelation {
  subject: GraphEntity;
  predicate: string;
  object: GraphEntity;
  status: "approved" | "proposed";
  source: string;
}

export interface PlaybookEntry {
  id: string;
  title: string;
  family: string;
  purpose: string;
  queries: { tool: string; params: Record<string, unknown> }[];
  refs: string[];
}

export interface WeknoraLookupParams {
  tag?: string;
  query?: string;
  max_results?: number;
}

export interface WeknoraGraphQueryParams {
  entity: string;
  relation?: string;
  max_results?: number;
}

/** 剧本库数据源 seam：生产 stub = MemoryPlaybookLibrary（本文件），票 83 换 HTTP adapter。 */
export interface WeknoraPlaybookBackend {
  lookup(params: WeknoraLookupParams): Promise<{ total: number; hits: PlaybookEntry[] }>;
}

/** 关系图数据源 seam：query 只回 approved（T22/INV-5）；register 只写 proposed。 */
export interface WeknoraGraphBackend {
  query(params: WeknoraGraphQueryParams): Promise<{ total: number; hits: GraphRelation[] }>;
  register(call: RegisterCall): Promise<RegisterRecord>;
}

const DEFAULT_MAX_RESULTS = 50;

/** 目录形态 → 剧本库文件（weknora 目录即数据面入口的调用方便利）。 */
function playbooksFileOf(source: string | URL): string {
  const s = source instanceof URL ? fileURLToPath(source) : source;
  return s.endsWith("/") ? `${s}playbooks.json` : s;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// ---------- Memory 实现（真接口假实现；账面随进程存续，票 83 整体换 HTTP） ----------

/** 本地剧本库：fixtures/weknora/playbooks.json 的只读检索面（L0 口径：查询无副作用）。
 *  source 收剧本库文件或其所在目录（目录形态自动补 playbooks.json）。 */
export class MemoryPlaybookLibrary implements WeknoraPlaybookBackend {
  private readonly playbooks: PlaybookEntry[];

  constructor(source: string | URL = WEKNORA_PLAYBOOKS_FIXTURE) {
    const raw = JSON.parse(readFileSync(playbooksFileOf(source), "utf8")) as { playbooks?: unknown };
    this.playbooks = Array.isArray(raw.playbooks) ? (raw.playbooks as PlaybookEntry[]) : [];
  }

  async lookup(params: WeknoraLookupParams): Promise<{ total: number; hits: PlaybookEntry[] }> {
    const tag = str(params.tag);
    const query = str(params.query);
    const matched = this.playbooks.filter((p) => {
      const byTag = tag === "" || p.family === tag;
      const byQuery =
        query === "" ||
        p.title.includes(query) ||
        p.purpose.includes(query) ||
        p.id.includes(query);
      return byTag && byQuery;
    });
    const sliced = matched.slice(0, params.max_results ?? DEFAULT_MAX_RESULTS);
    return { total: matched.length, hits: sliced };
  }
}

/** 本地只读图 + 假设登记 store（T22 的实现本体）：
 *  · query：**只回 approved**——proposed/unlisted 关系对检索面不存在（INV-5）；
 *  · register：**只写 proposed**——RegisterRecord.status 类型面即字面量 "proposed"
 *   （ports.ts 契约），运行时不再给第二种值；写进图的关系在 query 面不可见，
 *    直到人审通道（票 83）把它翻成 approved。 */
export class MemoryWeknoraGraph implements WeknoraGraphBackend {
  readonly relations: GraphRelation[];
  readonly entries: RegisterRecord[] = [];

  constructor(source: string | URL | GraphRelation[] = GRAPH_FIXTURE) {
    if (Array.isArray(source)) {
      this.relations = [...source];
      return;
    }
    const raw = JSON.parse(readFileSync(source, "utf8")) as { relations?: unknown };
    this.relations = Array.isArray(raw.relations) ? (raw.relations as GraphRelation[]) : [];
  }

  async query(params: WeknoraGraphQueryParams): Promise<{ total: number; hits: GraphRelation[] }> {
    const matched = this.relations
      .filter((r) => r.status === "approved") // T22/INV-5：proposed 一律不进检索面
      .filter(
        (r) =>
          r.subject.value === params.entity ||
          r.object.value === params.entity ||
          str(r.subject.type) === params.entity ||
          str(r.object.type) === params.entity,
      )
      .filter((r) => params.relation === undefined || r.predicate === params.relation);
    const sliced = matched.slice(0, params.max_results ?? DEFAULT_MAX_RESULTS);
    return { total: matched.length, hits: sliced };
  }

  async register(call: RegisterCall): Promise<RegisterRecord> {
    // 一律 proposed（T22）：status 只此一值——写侧没有任何翻 approved 的通道（INV-5）
    const record: RegisterRecord = { ...call, status: "proposed", registered_at: Date.now() };
    this.entries.push(record);
    return record;
  }
}

// ---------- 工具执行分发（契约校验后的唯一分发点，executeHuntTool 同款形状） ----------

export async function executeWeknoraTool(
  playbook: WeknoraPlaybookBackend,
  graph: WeknoraGraphBackend,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const maxResults = typeof params.max_results === "number" ? params.max_results : undefined;
  switch (tool) {
    case "playbook_lookup":
      return playbook.lookup({
        tag: typeof params.tag === "string" && params.tag ? params.tag : undefined,
        query: typeof params.query === "string" && params.query ? params.query : undefined,
        max_results: maxResults,
      } satisfies WeknoraLookupParams);
    case "graph_query":
      return graph.query({
        entity: String(params.entity),
        relation: typeof params.relation === "string" && params.relation ? params.relation : undefined,
        max_results: maxResults,
      } satisfies WeknoraGraphQueryParams);
    case "hypothesis_register":
      return graph.register({
        hypothesis_id: String(params.hypothesis_id),
        verdict: params.verdict as RegisterCall["verdict"],
        confidence: params.confidence as number,
        evidence_hashes: params.evidence_hashes as string[],
      } satisfies RegisterCall);
    default:
      throw new Error(`unreachable_tool:${tool}`);
  }
}

// ---------- 循环缝面（outcome 收敛归档步，L0 裁定②的 seam 半边） ----------

/** hypothesis_register 循环缝的生产件（OrchestrationDeps.register 装配注入）：
 *  m14 的 converge 只调缝（ports.HypothesisRegisterSeam 零改动），gated 语义在本实现内
 *  完成——写经 MemoryWeknoraGraph.register（只写 proposed），五要素审计（INV-8）在 seam
 *  内落账（action=hypothesis_register，details 带全 record 可回放）。 */
export function makeHuntRegisterSeam(opts: {
  graph: WeknoraGraphBackend;
  audit: AuditSink;
  /** 五要素的 requestId（缝面无 HTTP 头可借——hunt_<run_id> 同款惯例的 seam 常量）。 */
  requestId?: string;
}): HypothesisRegisterSeam {
  return async (call: RegisterCall): Promise<RegisterRecord> => {
    const record = await opts.graph.register(call);
    opts.audit.record({
      action: "hypothesis_register",
      actor: { type: "agent", id: "agent:hunt_flow" },
      objectId: call.hypothesis_id,
      objectType: "hypothesis",
      details: { ...record },
      requestId: opts.requestId ?? "hunt_register_seam",
      result: "SUCCESS",
      createdAt: Date.now(),
    });
    return record;
  };
}
