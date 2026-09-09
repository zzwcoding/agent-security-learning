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
  verdictAi: string | null;
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
