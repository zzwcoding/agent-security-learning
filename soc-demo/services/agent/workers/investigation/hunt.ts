// m5 调查 worker · 狩猎查询工具 ×4 的签名契约与执行封装（票 78）。
//
// PRD §13.4b「新增维度工具」（五业务共用底座）：file_change_query / outbound_conn_query /
// web_access_query / proc_lineage_query。与调查六工具（prompt.ts）同构同口径：
//   1. HUNT_QUERY_TOOLS —— 狩猎查询工具面（与 INVESTIGATION_TOOLS 零交集：调查六件套
//      零变化 = 旧链零回归；hunt 版菜单/票面接线归内容层票 79，本件只供能力面）。
//   2. HUNT_TOOL_SCHEMAS + validateHuntToolCall —— 签名契约本体：查询类强制 time_window
//      （复用 prompt.ts 的 checkTimeWindow，同一份规则）；缺窗报错不替 LLM 补。
//   3. executeHuntTool —— 契约校验通过后的唯一分发点：按工具调 HuntQueryBackend 的
//      对应维度方法（siem.ts 的 FixtureSiem 生产实现 / 测试注入 fake——数据源 seam）。
//
// 登记与分级：四工具全部 L0 只读，登记单一来源 = fixtures/tools.manifest.json
// （「未登记一律 L1」的 fail-closed 闸照常生效——hunt.test.ts 有登记前/后双向断言）。
import { checkTimeWindow, type ToolCallVerdict } from "./prompt.js";
import type {
  HuntQueryBackend,
  ProcLineageQueryParams,
  OutboundConnQueryParams,
  WebAccessQueryParams,
  FileChangeQueryParams,
} from "./siem.js";

/** 狩猎查询工具面（PRD §13.4b 四新维度工具，全 L0 只读，无任何 L2）。 */
export const HUNT_QUERY_TOOLS = [
  "file_change_query",
  "outbound_conn_query",
  "web_access_query",
  "proc_lineage_query",
] as const;

/** 工具签名（LLM tool schema 的契约面）。required 里显式含 time_window——契约自证测试咬死。 */
export const HUNT_TOOL_SCHEMAS: Record<string, { description: string; required: string[]; optional: string[] }> = {
  file_change_query: {
    description: "按路径/哈希查文件新增/篡改（FIM 维度——webshell 落盘取证；后端为 fixture 告警集检索）",
    required: ["field", "value", "time_window"],
    optional: ["max_results"],
  },
  outbound_conn_query: {
    description: "按目的 IP/域名/频率查外联（C2 心跳维度；freq = rule.firedtimes ≥ N 的重复信标）",
    required: ["field", "value", "time_window"],
    optional: ["max_results"],
  },
  web_access_query: {
    description: "按 URL 模式查 web 访问异常（web 攻击痕迹维度；模式 = URL 子串）",
    required: ["url_pattern", "time_window"],
    optional: ["max_results"],
  },
  proc_lineage_query: {
    description: "按进程名查父子关系（持久化/提权维度；role = child/parent/any，缺省 any）",
    required: ["process", "time_window"],
    optional: ["role", "max_results"],
  },
};

const isOneOf = <T extends string>(v: unknown, choices: readonly T[]): v is T =>
  typeof v === "string" && (choices as readonly string[]).includes(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const checkMaxResults = (v: unknown): ToolCallVerdict =>
  v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 1)
    ? { ok: true }
    : { ok: false, error: "bad_max_results" };

/** 狩猎工具签名契约的强制点：违约调用不执行、不烧后端，错误作为观察返回给 LLM
 *  （与 validateToolCall 同款语义——查询缺窗报 time_window_required，绝不补默认窗）。 */
export function validateHuntToolCall(tool: string, params: Record<string, unknown>): ToolCallVerdict {
  if (!(HUNT_QUERY_TOOLS as readonly string[]).includes(tool)) return { ok: false, error: "unknown_tool" };
  switch (tool) {
    case "file_change_query": {
      if (!isOneOf(params.field, ["path", "hash"] as const)) return { ok: false, error: "bad_field" };
      if (!nonEmpty(params.value)) return { ok: false, error: "value_required" };
      const tw = checkTimeWindow(params.time_window);
      if (!tw.ok) return tw;
      return checkMaxResults(params.max_results);
    }
    case "outbound_conn_query": {
      if (!isOneOf(params.field, ["dst_ip", "domain", "freq"] as const)) return { ok: false, error: "bad_field" };
      if (!nonEmpty(params.value)) return { ok: false, error: "value_required" };
      if (params.field === "freq" && !/^[1-9]\d*$/.test(params.value)) {
        return { ok: false, error: "bad_freq_value" };
      }
      const tw = checkTimeWindow(params.time_window);
      if (!tw.ok) return tw;
      return checkMaxResults(params.max_results);
    }
    case "web_access_query": {
      if (!nonEmpty(params.url_pattern)) return { ok: false, error: "pattern_required" };
      const tw = checkTimeWindow(params.time_window);
      if (!tw.ok) return tw;
      return checkMaxResults(params.max_results);
    }
    case "proc_lineage_query": {
      if (!nonEmpty(params.process)) return { ok: false, error: "process_required" };
      if (params.role !== undefined && !isOneOf(params.role, ["child", "parent", "any"] as const)) {
        return { ok: false, error: "bad_role" };
      }
      const tw = checkTimeWindow(params.time_window);
      if (!tw.ok) return tw;
      return checkMaxResults(params.max_results);
    }
  }
  // 已登记工具的 switch 之上全部 return；能走到这里只可能是漏登记的调用方
  return { ok: false, error: "unknown_tool" };
}

/** 执行封装（契约校验后的唯一分发点）：与 flow.ts execTool 同款形状——参数按签名
 *  收口成强类型后透传 backend，不加工不猜测。面外工具直接炸响（unreachable）。 */
export async function executeHuntTool(
  backend: HuntQueryBackend,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const timeWindow = params.time_window as { from: string; to: string };
  const maxResults = typeof params.max_results === "number" ? params.max_results : undefined;
  switch (tool) {
    case "file_change_query":
      return backend.queryFileChanges({
        field: params.field as FileChangeQueryParams["field"],
        value: String(params.value),
        time_window: timeWindow,
        max_results: maxResults,
      } satisfies FileChangeQueryParams);
    case "outbound_conn_query":
      return backend.queryOutboundConns({
        field: params.field as OutboundConnQueryParams["field"],
        value: String(params.value),
        time_window: timeWindow,
        max_results: maxResults,
      } satisfies OutboundConnQueryParams);
    case "web_access_query":
      return backend.queryWebAccess({
        url_pattern: String(params.url_pattern),
        time_window: timeWindow,
        max_results: maxResults,
      } satisfies WebAccessQueryParams);
    case "proc_lineage_query":
      return backend.queryProcLineage({
        process: String(params.process),
        role: params.role as ProcLineageQueryParams["role"],
        time_window: timeWindow,
        max_results: maxResults,
      } satisfies ProcLineageQueryParams);
    default:
      throw new Error(`unreachable_tool:${tool}`);
  }
}
