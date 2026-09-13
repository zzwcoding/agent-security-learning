// API client：Web（薄客户端）消费的公开 REST 面全在这里列队。
// 原则（m10 卡）：页面数据全部走公开 REST + SSE，无 Web 特权接口——所以这里没有
// 任何带签名的特权调用，也没有 /internal 之外的口子（/internal/runs 是 m3 卡
// 「公开接口」一节列明的 run 拉起面，演示页从这里拿 run_id）。
// 路径全是同源相对路径：跨源问题由 vite dev 代理解决（vite.config.ts，后端无 CORS 头）。

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`api ${status}: ${code}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, typeof body.error === "string" ? body.error : "unknown");
  }
  return body as T;
}

// ---- m8 登录（services/agent POST /api/v1/auth/login，票 18）----

export interface LoginResponse {
  session_id: string;
  token: string;
  username: string;
  role: string;
  role_label: string;
  visible_tools: string[];
  expires_at: number;
}

export function login(username: string): Promise<LoginResponse> {
  return request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ username }) });
}

// ---- m2 告警/审计查询（services/case-backend）----

export interface AlertRow {
  id: string;
  type: string;
  source: string;
  sourceRef: string;
  title: string;
  severity: number;
  status: string;
  /** worker 写回的原始判定对象 {verdict:"tp",...}（老数据可能是字符串） */
  verdictAi: unknown;
  tags: string[];
  date: number;
  lastSeen: number;
  occurrences: number;
}

export function listAlerts(filter: { status?: string; host?: string } = {}): Promise<AlertRow[]> {
  const q = new URLSearchParams();
  if (filter.status) q.set("status", filter.status);
  if (filter.host) q.set("host", filter.host);
  const qs = q.toString();
  return request(`/api/v1/alerts${qs ? `?${qs}` : ""}`);
}

export interface AuditRow {
  id: string;
  action: string;
  actor: { type: string; id: string };
  objectId: string;
  objectType: string;
  details: Record<string, unknown>;
  requestId: string;
  result: string;
  createdAt: number;
}

export function listAudit(filter: { requestId?: string; objectId?: string } = {}): Promise<AuditRow[]> {
  const q = new URLSearchParams();
  if (filter.requestId) q.set("requestId", filter.requestId);
  if (filter.objectId) q.set("objectId", filter.objectId);
  const qs = q.toString();
  return request(`/api/v1/audit${qs ? `?${qs}` : ""}`);
}

// ---- m3 run 拉起（POST /internal/runs，m3 卡公开接口）----

export interface RunHandle {
  runId: string;
}

export function startRun(kind: string, alertId: string, opts: { actorId?: string } = {}): Promise<RunHandle> {
  // 票 39：确认类动作带 x-actor-id（agent 侧按 user 记审计，INV-8 确认人可回放）。
  // request() 的 init 展开会整体覆盖默认 headers，这里自己补齐 content-type。
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.actorId) headers["x-actor-id"] = opts.actorId;
  return request("/internal/runs", {
    method: "POST",
    headers,
    body: JSON.stringify({ kind, alert_id: alertId }),
  }).then((r) => ({ runId: (r as { run_id: string }).run_id }));
}

// ---- m1 回放正门（POST /api/v1/webhooks/alerts；FR-M10.1 回放按钮背后就是它，
//      与 scripts/replay.ts 同一动作：数据只走 webhook 正门，绝不直接塞库）----

export interface ReplayResult {
  alertId: string;
  dedup: boolean;
}

export function replayAlert(payload: unknown): Promise<ReplayResult> {
  return request<{ alert_id: string; dedup?: boolean }>("/api/v1/webhooks/alerts", {
    method: "POST",
    body: JSON.stringify(payload),
  }).then((r) => ({ alertId: r.alert_id, dedup: r.dedup === true }));
}

// ---- m9 审批卡 REST（services/agent，票 11/18；FR-M10.3 的数据面）----
// wire 形状 = agent approvals.ts toWire()（snake_case），这里收拢成前端命名。

// 票 47（ADR 0004-1）：审批卡有保质期——超时未决的 pending 卡被 agent 分发循环
// 自动作废成 expired（时间出的裁决），web 端如实渲染。
export type ApprovalStatusWire = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalCard {
  id: string;
  runId: string;
  node: string;
  tool: string;
  params: unknown;
  paramsHash: string;
  caseId: string | null;
  reason: string | null;
  status: ApprovalStatusWire;
  approver: string | null;
  rejectReason: string | null;
  executed: boolean;
  createdAt: number;
  decidedAt: number | null;
}

function toCard(w: Record<string, unknown>): ApprovalCard {
  return {
    id: String(w.id),
    runId: String(w.run_id ?? ""),
    node: String(w.node ?? ""),
    tool: String(w.tool ?? ""),
    params: w.params,
    paramsHash: String(w.params_hash ?? ""),
    caseId: typeof w.case_id === "string" ? w.case_id : null,
    reason: typeof w.reason === "string" ? w.reason : null,
    status: (w.status as ApprovalStatusWire) ?? "pending",
    approver: typeof w.approver === "string" ? w.approver : null,
    rejectReason: typeof w.reject_reason === "string" ? w.reject_reason : null,
    executed: w.executed === true,
    createdAt: Number(w.created_at ?? 0),
    decidedAt: typeof w.decided_at === "number" ? w.decided_at : null,
  };
}

export function listApprovals(status?: ApprovalStatusWire): Promise<ApprovalCard[]> {
  return request<{ approvals: Record<string, unknown>[] }>(
    `/api/v1/approvals${status ? `?status=${status}` : ""}`,
  ).then((r) => (r.approvals ?? []).map(toCard));
}

export interface DecisionResult {
  approvalId: string;
  runId: string;
  runStatus: string | null;
  decision?: string;
  /** 批准才有：铸出的 ApprovalToken（一次性，M9 验签用，页面只展示形态不存它） */
  approvalToken?: string;
}

/** 裁决（批准/驳回）。approver 必填（INV-8 审计要记是谁）；驳回可带 reason。
 *  并发后到者 → 409 ApiError("InvalidTransition")（statemachine INV-10 仲裁）。
 *  狗粮票 58：approverToken 选填（外部模式 = 椒图审批口令，放 x-approver-token 头
 *  透传给裁决真相方；内部模式留空 → 头不发，后端原路径不变）。 */
export function decideApproval(
  id: string,
  d: { approve: boolean; approver: string; reason?: string; approverToken?: string },
): Promise<DecisionResult> {
  const path = `/api/v1/approvals/${encodeURIComponent(id)}/${d.approve ? "approve" : "reject"}`;
  const body: Record<string, unknown> = { approver: d.approver };
  if (!d.approve && d.reason) body.reason = d.reason;
  // 票 58：init.headers 整体覆盖默认头（startRun 同款注意），content-type 自己补齐
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (d.approverToken) headers["x-approver-token"] = d.approverToken;
  return request<Record<string, unknown>>(path, { method: "POST", headers, body: JSON.stringify(body) }).then(
    (r) => ({
      approvalId: String(r.approval_id ?? id),
      runId: String(r.run_id ?? ""),
      runStatus: typeof r.run_status === "string" ? r.run_status : null,
      ...(typeof r.decision === "string" ? { decision: r.decision } : {}),
      ...(typeof r.approval_token === "string" ? { approvalToken: r.approval_token } : {}),
    }),
  );
}

// ---- m2 案件（services/case-backend；FR-M10.4 案件时间线页数据面）----

export interface CaseRow {
  id: string;
  number: number;
  title: string;
  severity: number;
  status: string;
  linkedAlerts: string[];
  startDate: number;
  /** 票 73/75：命中建案回填的假设锚（m2 cases.hypothesis_id 列；狩猎页收敛结论的
   *  Case 链接就靠它反查——页面映射「收敛结论」行的既有案件查询面）。 */
  hypothesisId: string | null;
}

export interface TimelineEntry {
  id: string;
  case_id: string;
  /** system / investigation_report / enrichment_report / …（worker 写什么透传什么） */
  kind: string;
  author: string;
  body: string;
  /** 机读负载原样（PRD §5.5；富化报告的四档标签在这里） */
  structured: unknown;
  created_at: number;
}

export interface CaseDetail extends CaseRow {
  description: string;
  tlp: number;
  pap: number;
  verdict: string | null;
  verdictNote: string | null;
  assignee: string | null;
  tags: string[];
  endDate: number | null;
  intakeSource: string;
  observables: { id: string; dataType: string; data: string; tlp: number; pap: number; ioc: boolean }[];
  timeline: TimelineEntry[];
}

export function getCaseDetail(id: string): Promise<CaseDetail> {
  return request<CaseDetail>(`/api/v1/cases/${encodeURIComponent(id)}`);
}

export function listCases(): Promise<CaseRow[]> {
  return request<CaseRow[]>("/api/v1/cases");
}

/** 告警 → 案件的客户端反查（M2 没有 alert→case 直查口，薄客户端拿全量列表自己找：
 *  案件的 linkedAlerts 数组里有它就是）。找不到返回 null（告警还没建案）。 */
export function findCaseIdByAlert(cases: CaseRow[], alertId: string): string | null {
  return (cases.find((c) => c.linkedAlerts.includes(alertId)) ?? null)?.id ?? null;
}

/** 假设 → 案件反查（票 75 命中建案回填 hypothesis_id；票 82 收敛结论的 Case 链接）。
 *  同为既有案件查询面的客户端过滤，无新端点。 */
export function findCaseIdByHypothesis(cases: CaseRow[], hypothesisId: string): string | null {
  return (cases.find((c) => c.hypothesisId === hypothesisId) ?? null)?.id ?? null;
}

// ---- m2 假设（services/case-backend，票 73 落卡面；票 82 狩猎页数据源）----
// 页面映射「狩猎页」六行的全部读/写都落在这里：列表（五态）/ 发起 / 取消 / 详情
// （内嵌轮次归集段）；收敛结论的 Case 链接复用上面的既有案件查询面。零 Web 专属接口。

export type HypothesisStatusWire = "proposed" | "hunting" | "concluded" | "refuted" | "cancelled";

/** wire = case-backend mapHypothesis()（snake_case，hypothesis_id/id 双键出线）。 */
export interface HypothesisRow {
  id: string;
  hypothesisId: string;
  templateId: string;
  text: string;
  status: HypothesisStatusWire;
  proposedBy: string;
  cancelReason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** 子 run 簿记的假设侧视图（m14 dispatch/join 上报，形状照 flow.ts children）。 */
export interface HuntChild {
  run_id: string;
  status: string;
}

/** 轮次归集段（m2 hypothesis_rounds）：{round_no, tasks[], children[], judge, gap}。 */
export interface HypothesisRoundWire {
  round_no: number;
  tasks: unknown[];
  children: HuntChild[];
  judge: unknown;
  gap: unknown;
  created_at: number;
}

/** 详情 = 账面行 + 轮次归集段（页面映射「轮次视图/judge+gap/收敛结论」三行的读面）。 */
export interface HypothesisDetail extends HypothesisRow {
  rounds: HypothesisRoundWire[];
}

function toHypothesis(w: Record<string, unknown>): HypothesisRow {
  return {
    id: String(w.id ?? ""),
    hypothesisId: String(w.hypothesis_id ?? w.id ?? ""),
    templateId: String(w.template_id ?? ""),
    text: String(w.text ?? ""),
    status: (w.status as HypothesisStatusWire) ?? "proposed",
    proposedBy: String(w.proposed_by ?? ""),
    cancelReason: typeof w.cancel_reason === "string" ? w.cancel_reason : null,
    createdAt: Number(w.created_at ?? 0),
    decidedAt: typeof w.decided_at === "number" ? w.decided_at : null,
  };
}

export function listHypotheses(status?: HypothesisStatusWire): Promise<HypothesisRow[]> {
  return request<{ hypotheses: Record<string, unknown>[] }>(
    `/api/v1/hypotheses${status ? `?status=${status}` : ""}`,
  ).then((r) => (r.hypotheses ?? []).map(toHypothesis));
}

/** 发起假设（POST /api/v1/hypotheses → 201 proposed + outbox hypothesis.created 同事务，
 *  agent autorun 消费它拉起 hunt_flow）。发起人走 x-actor-id 头（票 39 同款：取消的
 *  「仅发起人」比对锚在 INV-8 审计可回放）。template_id 缺省 = 机制默认档。 */
export function createHypothesis(d: { text: string; templateId?: string; actorId?: string }): Promise<HypothesisRow> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (d.actorId) headers["x-actor-id"] = d.actorId;
  return request<Record<string, unknown>>("/api/v1/hypotheses", {
    method: "POST",
    headers,
    body: JSON.stringify({ text: d.text, ...(d.templateId ? { template_id: d.templateId } : {}) }),
  }).then(toHypothesis);
}

/** 人取消（POST :id/cancel，行为约定 12）：仅发起人 + 仅 hunting 态 + 四因枚举；
 *  后到者/非发起人 409/403 原样抛 ApiError。 */
export function cancelHypothesis(
  id: string,
  d: { by?: string; reason?: string; actorId?: string } = {},
): Promise<HypothesisRow> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (d.actorId) headers["x-actor-id"] = d.actorId;
  return request<Record<string, unknown>>(`/api/v1/hypotheses/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...(d.by ? { by: d.by } : {}), ...(d.reason ? { reason: d.reason } : {}) }),
  }).then(toHypothesis);
}

export function getHypothesisDetail(id: string): Promise<HypothesisDetail> {
  return request<Record<string, unknown>>(`/api/v1/hypotheses/${encodeURIComponent(id)}`).then((w) => ({
    ...toHypothesis(w),
    rounds: (Array.isArray(w.rounds) ? (w.rounds as Record<string, unknown>[]) : []).map((r) => ({
      round_no: Number(r.round_no ?? 0),
      tasks: Array.isArray(r.tasks) ? r.tasks : [],
      children: (Array.isArray(r.children) ? r.children : []) as HuntChild[],
      judge: r.judge ?? null,
      gap: r.gap ?? null,
      created_at: Number(r.created_at ?? 0),
    })),
  }));
}

// ---- m14 模板清单（services/agent GET /api/v1/templates，票 92 补卡面）----
// 狩猎页模板下拉的数据源。wire = 登记面只读投影行，字段名照模板文件原样（template_id/
// 假设句式族/菜单子集/轮次上限）——薄客户端零加工（票 91 eval purple 同款「原样透传」）。

/** 模板清单投影行（agent toTemplateListRow 出线；内容层查询计划不外发，见 agent app.ts）。 */
export interface HuntTemplateRow {
  template_id: string;
  hypothesis_patterns: string[];
  menu: string[];
  max_rounds: number;
}

/** 模板清单（票 92 只读 L0 面）。未登记 = 空数组；面病了原样抛 ApiError（降级决策在页面）。 */
export function listHuntTemplates(): Promise<HuntTemplateRow[]> {
  return request<{ templates?: HuntTemplateRow[] }>("/api/v1/templates").then((r) => r.templates ?? []);
}

// ---- m9 PII 受控反查（services/agent POST /api/v1/pii/reveal，票 49·ADR 0004-3）----
// 链路：本页按钮（duty_lead/admin 可见）→ agent 端点（会话 + 角色白名单 + INV-8
// 审计，details 只记命中条数不记原文）→ guards /pii/reveal（mapstore 反查）。

export interface PiiReveal {
  placeholder: string;
  originals: string[];
}

export function revealPii(placeholder: string, token: string): Promise<PiiReveal> {
  return request<Record<string, unknown>>("/api/v1/pii/reveal", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ placeholder }),
  }).then((r) => ({
    placeholder: typeof r.placeholder === "string" ? r.placeholder : placeholder,
    originals: Array.isArray(r.originals) ? r.originals.map(String) : [],
  }));
}

// ---- m11 Eval 产物（eval-results/latest.json；FR-M10.6 数据源）----
// 拿法（记票口径）：vite 静态服务 eval-results 目录（vite.config.ts 插件），URL 与磁盘
// 路径一致——m11 卡公开接口就是「产出 eval-results/latest.json」，Web 只读产物不加端点。

export interface EvalCaseRow {
  fullName: string;
  domain: string;
  ran: boolean;
  passed: boolean;
  toolCalls?: number;
  tokens?: number;
  durationMs?: number;
}

export interface EvalFaceStat {
  /** 分母 = ran 攻击用例数（环境 skip 的攻击用例不进分母，票 22 口径）。 */
  total: number;
  intercepted: number;
  /** intercepted/total；total=0 时 null（没数不编数）。 */
  rate: number | null;
}

/** 防线拦截率（票 22 产出、票 29 契约对齐）：按攻击面 by_face + 按拦截方式 by_facet
 *  + 环境 skip 留痕。形状以 fixtures/eval-report/latest.json 共享样例为契约。 */
export interface EvalDefenseInterception {
  by_face: Record<string, EvalFaceStat>;
  by_facet: Record<string, number>;
  skipped: string[];
  note: string;
}

/** 票 91：紫队闭环加性段（evals rigs/purple.ts PurpleReport 的展示投影，字段名照
 *  rig 结果对象原样——per_fixture=逐 fixture 发现率表、blind_spots=盲区聚类）。 */
export interface EvalPurpleFixtureRow {
  fixture: string;
  family: string;
  expected: "hit" | "miss";
  discovered: boolean;
}

export interface EvalPurpleCluster {
  family: string;
  misses: number;
  discovered: number;
  fixtures: string[];
  missing_dimensions: string[];
}

export interface EvalPurpleSummary {
  discovered: number;
  fixtures: number;
  discovery_rate: number;
  per_fixture: EvalPurpleFixtureRow[];
  blind_spots: EvalPurpleCluster[];
  weakest_family: string | null;
}

export interface EvalReport {
  run_at: string;
  lane: string;
  tags?: string[];
  tested_model?: string;
  judge_model?: string | null;
  totals: { cases: number; ran: number; passed: number; failed: number; skipped: number };
  triage_accuracy: number | null;
  /** 可选 = 兼容票 19 时代的旧产物：缺席按「未产出」渲染，不猜数。 */
  defense_interception?: EvalDefenseInterception;
  /** 成本口径（CSV 落 eval-results/cost_all.csv，这里带口径说明与行数）。 */
  costs?: { csv: string; rows: number; note: string };
  judge: { evaluable_cases: number; avg_score: number | null; note: string };
  /** 票 91：紫队闭环加性段（票 29 契约的兼容扩展）；可选 = 紫队 rig 没跑的旧产物。 */
  purple?: EvalPurpleSummary;
  cases: EvalCaseRow[];
}

export function fetchEvalReport(): Promise<EvalReport> {
  return request<EvalReport>("/eval-results/latest.json");
}
