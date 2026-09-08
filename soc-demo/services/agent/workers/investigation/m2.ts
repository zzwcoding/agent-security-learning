// m5 调查 worker · M2 出站 adapter（票 14）。
//
// 消费 m2 卡公开接口的三个面：案件详情读（实体/observables 是调查的输入）、
// 告警读（get_alert 取 primary alert 日期锚定窗口；listAlerts 支撑 FR-M5.2
// related_alerts 的同实体/同规则/同主机聚合）、timeline 写（FR-M5.4 报告落库）。
// adapter 形态照票 13 的 HttpTriageM2 先例：生产 HTTP，测试打真 case-backend。
export interface ObservableDto {
  dataType: string;
  data: string;
  tags?: string[];
}

/** GET /api/v1/alerts/:id 与列表项的子集（camelCase，对齐 M2 mapAlert wire 形状）。 */
export interface AlertDto {
  id: string;
  title: string;
  severity: number;
  status: string;
  tags: string[];
  date: number;
  observables?: ObservableDto[];
}

export interface CaseDetailDto {
  id: string;
  title: string;
  severity: number;
  status: string;
  tags: string[];
  linkedAlerts: string[];
  startDate: number;
  observables?: ObservableDto[];
}

export interface TimelineEntryInput {
  kind: string;
  author: string;
  body: string;
  structured?: unknown;
}

export interface InvestigationM2 {
  getCaseDetail(caseId: string): Promise<CaseDetailDto | null>;
  getAlert(alertId: string): Promise<AlertDto | null>;
  listAlerts(): Promise<AlertDto[]>;
  addTimelineEntry(caseId: string, entry: TimelineEntryInput): Promise<{ id: string }>;
}

export class HttpInvestigationM2 implements InvestigationM2 {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async getCaseDetail(caseId: string): Promise<CaseDetailDto | null> {
    const { status, json } = await this.call("GET", `/api/v1/cases/${caseId}`);
    return status === 200 ? (json as unknown as CaseDetailDto) : null;
  }

  async getAlert(alertId: string): Promise<AlertDto | null> {
    const { status, json } = await this.call("GET", `/api/v1/alerts/${alertId}`);
    return status === 200 ? (json as unknown as AlertDto) : null;
  }

  async listAlerts(): Promise<AlertDto[]> {
    const { json } = await this.call("GET", "/api/v1/alerts");
    return json as unknown as AlertDto[];
  }

  async addTimelineEntry(caseId: string, entry: TimelineEntryInput): Promise<{ id: string }> {
    const { status, json } = await this.call("POST", `/api/v1/cases/${caseId}/timeline`, entry);
    if (status >= 300) throw new Error(`m2 add_timeline_entry failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { id: String(json.id ?? "") };
  }
}

// ---------- FR-M5.2：related_alerts 的同实体/同规则/同主机聚合（确定性过滤） ----------

export type RelatedScope = "entity" | "rule" | "host";

export interface RelatedAlertsParams {
  scope: RelatedScope;
  value: string;
  time_window: { from: string; to: string };
  max_results?: number;
}

export interface RelatedAlertsResult {
  total: number;
  alerts: { id: string; title: string; severity: number; status: string; date: number }[];
}

function matchesScope(alert: AlertDto, scope: RelatedScope, value: string): boolean {
  const obs = alert.observables ?? [];
  if (scope === "host") return obs.some((o) => o.dataType === "hostname" && o.data === value);
  if (scope === "rule") return alert.tags.includes(value);
  // entity：ip observable 或 srcuser（seed 映射口径 srcuser → dataType "other"）
  return obs.some(
    (o) => (o.dataType === "ip" || o.dataType === "other") && o.data === value,
  );
}

/** related_alerts 工具的执行体（flow 里经 gated 调用）。数据源 = M2 告警库：
 *  系统内见过的历史告警聚合，与 siem_query（fixture SIEM 语料）互补。 */
export async function relatedAlerts(m2: InvestigationM2, params: RelatedAlertsParams): Promise<RelatedAlertsResult> {
  const all = await m2.listAlerts();
  const from = Date.parse(params.time_window.from);
  const to = Date.parse(params.time_window.to);
  const matched = all.filter((a) => {
    const t = typeof a.date === "number" ? a.date : Date.parse(String(a.date));
    return t >= from && t <= to && matchesScope(a, params.scope, params.value);
  });
  return {
    total: matched.length,
    alerts: matched.slice(0, params.max_results ?? 10).map((a) => ({
      id: a.id,
      title: a.title,
      severity: a.severity,
      status: a.status,
      date: a.date,
    })),
  };
}
