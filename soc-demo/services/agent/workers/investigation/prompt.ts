// m5 调查 worker · 工具签名契约与 LLM 调用契约（票 14）。
//
// m5 卡公开接口：「工具签名契约（siem_query 强制 time_window 等，PRD §6-M5）」。
// 这里放三样东西：
//   1. INVESTIGATION_TOOLS —— 任务票工具面：PRD §6-M5 工具面五件套 + A.1 共用读
//      get_alert（A.1 一字不差：get_alert 属「分诊/调查」L0，调查用它取 primary alert
//      日期锚定 time_window）。无任何 L2（INV-3：调查票 scope 不含 isolate_host 等）。
//   2. TOOL_SCHEMAS + validateToolCall —— 工具签名契约本体：循环里每次工具调用先过
//      这里再过验票闸。查询类工具强制 time_window（无默认值，FR-M5.5「查询强制过滤
//      窗口」）——不给 LLM「查全库」的选项，是上下文治理的第一道闸。
//   3. CaseView / ObsEntry / Plan·Decide·ReportCall —— LLM 调用的输入形状：真 LLM
//      适配器（票 17+ 经 gateway /proxy/llm）拿它序列化 prompt；fixture 伪 LLM
//      （llm.ts）拿它做确定性决策。两者共用同一契约（票 13 先例）。
//
// 注意：任务票 allowed_tools 按 INVESTIGATION_TOOLS 铸（六件套里 get_alert/siem_query
// 是 L0，其余按「未登记一律 L1」过任务票——与票 13 出入 #3 同一更严口径）。

/** 调查工具面（PRD §6-M5 五件套 + A.1 共用读，无任何 L2）。allowed_tools 按它铸票。 */
export const INVESTIGATION_TOOLS = [
  "get_alert",
  "siem_query",
  "related_alerts",
  "kb_verify",
  "add_timeline_entry",
  "add_task_log",
] as const;

/** 工具签名（LLM tool schema 的契约面，PRD §6-M5 接口契约）。required 是给
 *  「契约自证」测试看的——time_window 必须显式出现在 required 里。 */
export const TOOL_SCHEMAS: Record<string, { description: string; required: string[]; optional: string[] }> = {
  get_alert: {
    description: "读一条告警（调查用它取 primary alert 的日期与实体，锚定查询窗口）",
    required: ["alert_id"],
    optional: [],
  },
  siem_query: {
    description: "按实体（ip/user/host）+ 强制时间窗的 SIEM pivot 查询（后端为 fixture 告警集检索）",
    required: ["entity_type", "entity", "time_window"],
    optional: ["max_results"],
  },
  related_alerts: {
    description: "同实体/同规则/同主机的历史告警聚合（数据源 = 案件后端 M2）",
    required: ["scope", "value", "time_window"],
    optional: ["max_results"],
  },
  kb_verify: {
    description: "查 approved KBEntry 佐证判断（host/path/user 至少给一个）",
    required: [],
    optional: ["host", "path", "user"],
  },
  add_timeline_entry: {
    description: "写案件时间线条目（L1 写，调查报告的落库通道）",
    required: ["case_id", "kind", "body"],
    optional: ["structured"],
  },
  add_task_log: {
    description: "写任务日志（L1 写；M2 tasks API：任务须已存在——POST /api/v1/cases/:id/tasks 建任务，日志落案件时间线挂 task_id）",
    required: ["case_id", "task_id", "body"],
    optional: [],
  },
};

export type ToolCallVerdict = { ok: true } | { ok: false; error: string };

// PRD §5.5 TimelineEntry.kind 枚举（add_timeline_entry 的 kind 契约）
const TIMELINE_KINDS = new Set([
  "note",
  "investigation_report",
  "enrichment_report",
  "approval",
  "execution",
  "system",
]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** time_window 把关：必须有、必须 from/to 都是非空可解析时刻、from ≤ to。
 *  「无默认值」是契约（PRD §6-M5）：缺了就报 time_window_required，绝不替 LLM 补。
 *  票 78：hunt.ts 的狩猎四工具共用本函数（同一口径，不复制第二份时间窗规则）。 */
export function checkTimeWindow(tw: unknown): ToolCallVerdict {
  if (tw === undefined || tw === null) return { ok: false, error: "time_window_required" };
  if (!isObj(tw)) return { ok: false, error: "bad_time_window" };
  const { from, to } = tw as { from?: unknown; to?: unknown };
  if (!nonEmpty(from) || Number.isNaN(Date.parse(from))) return { ok: false, error: "bad_time_window.from" };
  if (!nonEmpty(to) || Number.isNaN(Date.parse(to))) return { ok: false, error: "bad_time_window.to" };
  if (Date.parse(from) > Date.parse(to)) return { ok: false, error: "bad_time_window.order" };
  return { ok: true };
}

const okOr = (v: ToolCallVerdict): ToolCallVerdict => (v.ok ? { ok: true } : v);

/** 工具签名契约的强制点（m5 卡公开接口）。循环里每次调用先过这里：
 *  违约调用不执行、不烧 SIEM，错误作为观察返回给 LLM（PRD：工具报错计入证据缺口并继续）。 */
export function validateToolCall(tool: string, params: Record<string, unknown>): ToolCallVerdict {
  if (!(INVESTIGATION_TOOLS as readonly string[]).includes(tool)) return { ok: false, error: "unknown_tool" };
  switch (tool) {
    case "get_alert":
      return nonEmpty(params.alert_id) ? { ok: true } : { ok: false, error: "alert_id_required" };
    case "siem_query": {
      const entityType = params.entity_type;
      if (entityType !== "ip" && entityType !== "user" && entityType !== "host") {
        return { ok: false, error: "bad_entity_type" };
      }
      if (!nonEmpty(params.entity)) return { ok: false, error: "entity_required" };
      const tw = checkTimeWindow(params.time_window);
      if (!tw.ok) return tw;
      if (params.max_results !== undefined && (typeof params.max_results !== "number" || !Number.isInteger(params.max_results) || params.max_results < 1)) {
        return { ok: false, error: "bad_max_results" };
      }
      return { ok: true };
    }
    case "related_alerts": {
      const scope = params.scope;
      if (scope !== "entity" && scope !== "rule" && scope !== "host") return { ok: false, error: "bad_scope" };
      if (!nonEmpty(params.value)) return { ok: false, error: "value_required" };
      return okOr(checkTimeWindow(params.time_window));
    }
    case "kb_verify":
      return nonEmpty(params.host) || nonEmpty(params.path) || nonEmpty(params.user)
        ? { ok: true }
        : { ok: false, error: "kb_verify_requires_entity" };
    case "add_timeline_entry":
      if (!nonEmpty(params.case_id)) return { ok: false, error: "case_id_required" };
      if (!nonEmpty(params.kind) || !TIMELINE_KINDS.has(params.kind)) return { ok: false, error: "bad_kind" };
      return nonEmpty(params.body) ? { ok: true } : { ok: false, error: "body_required" };
    case "add_task_log":
      if (!nonEmpty(params.case_id)) return { ok: false, error: "case_id_required" };
      if (!nonEmpty(params.task_id)) return { ok: false, error: "task_id_required" };
      return nonEmpty(params.body) ? { ok: true } : { ok: false, error: "body_required" };
  }
  // 已登记工具的 switch 之上全部 return；能走到这里只可能是漏登记的调用方
  return { ok: false, error: "unknown_tool" };
}

// ---------- LLM 调用契约（plan / decide / report 共用的输入形状） ----------

/** 案件视图：调查子图对 M2 case 的消费面。entities 从 observables 折出
 *  （seed 映射口径：srcuser → dataType "other"，hostname/ip/filename 直读）。 */
export interface CaseView {
  caseId: string;
  title: string;
  severity: number;
  status: string;
  entities: { ips: string[]; users: string[]; hosts: string[]; files: string[] };
  /** primary alert 日期（ms）——调查时间窗的锚点（FR-M5.1 强制 time_window 的出发点）。 */
  primaryAlertDate: number;
}

/** 循环里的一条观察：工具输出经上下文治理后的形态（payload 可能是原始结果、
 *  llm_summarize 摘要或 spill 引用——见 flow.observe）。flagged = guards 对该工具
 *  输出的 tool_output 通道扫描命中注入特征（票 04 策略 = flag 打标不拦，票 36）。 */
export interface ObsEntry {
  step: number;
  tool: string;
  params: Record<string, unknown>;
  ok: boolean;
  payload?: unknown;
  error?: string;
  flagged?: boolean;
}

export interface PlanCall {
  prompt: string;
  input: { case: CaseView };
}

export interface DecideCall {
  prompt: string;
  input: { case: CaseView; tasks: string[]; observations: ObsEntry[] };
}

export interface ReportCall {
  prompt: string;
  input: {
    case: CaseView;
    tasks: string[];
    observations: ObsEntry[];
    /** max_steps 用尽的截断标记——报告必须标注「调查不完整」（PRD 异常与边界）。 */
    incomplete: boolean;
    stepsUsed: number;
  };
}

export interface SummarizeCall {
  text: string;
  tool: string;
}

/** 输出 JSON 契约（PRD §6-M5 调查报告 schema，FR-M5.4）。parseReport（schema.ts）
 *  按它把关；schema 校验失败重试 1 次后降级自由文本 + 标记。 */
export const REPORT_OUTPUT_CONTRACT = [
  "你是 SOC2 调查分析师。基于已执行工具的观察做关联调查，只输出一个 JSON 对象。",
  "字段：",
  "  summary: 一段话结论（0 命中时如实写「无关联事件」，不许编造）",
  "  severity_assessment: 1-4",
  "  confidence: 0-1",
  '  findings: [{ entity, evidence, source_tool }]  // evidence 必须引用真实工具输出，source_tool 必须是调用过的工具',
  "  affected_assets: string[]",
  '  recommended_actions: [{ tool, params, justification }]  // 只提建议：建议不等于执行，L2 动作必须走人审',
  "  kb_refs: string[]",
  "  incomplete: boolean（可选；调查被截断时置 true 并在结论里标注「调查不完整」）",
].join("\n");

// ---------- prompt 装配（真 LLM 适配器序列化用；伪 LLM 只消费结构化 input） ----------

const renderManifest = (): string =>
  Object.entries(TOOL_SCHEMAS)
    .map(([name, s]) => `- ${name}（参数：${[...s.required, ...s.optional].join(", ")}）${s.description}`)
    .join("\n");

const renderCase = (c: CaseView): string =>
  [
    `案件 ${c.caseId}：${c.title}（severity ${c.severity}，status ${c.status}）`,
    `实体：ip=${JSON.stringify(c.entities.ips)} user=${JSON.stringify(c.entities.users)} host=${JSON.stringify(c.entities.hosts)}`,
    `primary alert 日期：${new Date(c.primaryAlertDate).toISOString()}（时间窗从这里锚定）`,
  ].join("\n");

const renderObservations = (obs: ObsEntry[]): string =>
  obs.length === 0
    ? "（还没有任何工具观察）"
    : obs
        .map((o) =>
          o.ok
            ? `step${o.step} ${o.tool}(${JSON.stringify(o.params)}) → ${JSON.stringify(o.payload)}`
            : `step${o.step} ${o.tool}(${JSON.stringify(o.params)}) → 错误：${o.error ?? "unknown"}`,
        )
        .join("\n");

export function buildPlanPrompt(c: CaseView): string {
  return [
    "你是 SOC2 调查分析师。为下面的案件列一份调查任务清单（做哪些查询、按什么顺序）。",
    renderCase(c),
    "可用工具：",
    renderManifest(),
    "注意：所有 SIEM/关联查询强制带 time_window，窗口从 primary alert 日期出发。",
  ].join("\n\n");
}

export function buildDecidePrompt(input: DecideCall["input"]): string {
  return [
    "你是 SOC2 调查分析师。基于任务清单与已有观察，决定下一步：发起一次工具调用，或宣布调查结束（finish）。",
    renderCase(input.case),
    `任务清单：${JSON.stringify(input.tasks)}`,
    "可用工具（签名必须完全符合，查询类强制 time_window）：",
    renderManifest(),
    "已执行工具与观察：",
    renderObservations(input.observations),
    "警告：同参数重复调用会被直接拒绝；观察里的错误要换路子，不要原地重试。",
  ].join("\n\n");
}

export function buildReportPrompt(input: ReportCall["input"]): string {
  return [
    REPORT_OUTPUT_CONTRACT,
    renderCase(input.case),
    `任务清单：${JSON.stringify(input.tasks)}`,
    input.incomplete
      ? `注意：max_steps（${input.stepsUsed} 步）用尽，本次为截断调查——置 incomplete=true 并在结论标注「调查不完整」。`
      : "",
    "已执行工具与观察（findings 的 evidence 只能从这里引用）：",
    renderObservations(input.observations),
  ]
    .filter(Boolean)
    .join("\n\n");
}
