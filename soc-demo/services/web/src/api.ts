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

export function startRun(kind: string, alertId: string): Promise<RunHandle> {
  return request("/internal/runs", {
    method: "POST",
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

export type ApprovalStatusWire = "pending" | "approved" | "rejected";

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
 *  并发后到者 → 409 ApiError("InvalidTransition")（statemachine INV-10 仲裁）。 */
export function decideApproval(
  id: string,
  d: { approve: boolean; approver: string; reason?: string },
): Promise<DecisionResult> {
  const path = `/api/v1/approvals/${encodeURIComponent(id)}/${d.approve ? "approve" : "reject"}`;
  const body: Record<string, unknown> = { approver: d.approver };
  if (!d.approve && d.reason) body.reason = d.reason;
  return request<Record<string, unknown>>(path, { method: "POST", body: JSON.stringify(body) }).then(
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

export interface EvalReport {
  run_at: string;
  lane: string;
  tags?: string[];
  tested_model?: string;
  judge_model?: string | null;
  totals: { cases: number; ran: number; passed: number; failed: number; skipped: number };
  triage_accuracy: number | null;
  /** 票 22 起才有：三/四攻击面拦截率分面（现在读不到就显示未产出，不猜数） */
  attack_block_rate?: Record<string, number | null>;
  judge: { evaluable_cases: number; avg_score: number | null; note: string };
  cases: EvalCaseRow[];
}

export function fetchEvalReport(): Promise<EvalReport> {
  return request<EvalReport>("/eval-results/latest.json");
}
