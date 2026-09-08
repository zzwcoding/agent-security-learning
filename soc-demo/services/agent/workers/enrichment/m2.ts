// m6 富化 worker · M2 出站 adapter（票 15）。
//
// 消费 m2 卡公开接口的两个面：案件详情读（case 的 observables 带 tlp/pap——闸门的
// 输入就在这里随 observable 进来）+ 写回两件（add_observable artifacts 回写 FR-M6.3、
// timeline 写富化报告 FR-M6.4）。adapter 形态照票 13/14 先例：生产 HTTP，测试打真
// case-backend（flow.test.ts 的 HttpEnrichmentM2 直连 startCaseBackend）。
export interface CaseObservableDto {
  dataType: string;
  data: string;
  message?: string | null;
  tlp: number;
  pap: number;
  tags: string[];
}

/** GET /api/v1/cases/:id 的子集（camelCase，对齐 M2 mapCase/mapObservable wire 形状）。 */
export interface CaseDetailDto {
  id: string;
  title: string;
  severity: number;
  status: string;
  observables?: CaseObservableDto[];
}

export interface AddObservableInput {
  dataType: string;
  data: string;
  tags?: string[];
  message?: string;
}

export interface TimelineEntryInput {
  kind: string;
  author: string;
  body: string;
  structured?: unknown;
}

export interface EnrichmentM2 {
  getCaseDetail(caseId: string): Promise<CaseDetailDto | null>;
  /** artifacts 回写（FR-M6.3）。M2 按 (case_id, dataType, data) 去重合并：新建 201
   *  dedup=false；命中既有行 200 dedup=true（tags 并入、不建新行）。 */
  addObservable(caseId: string, input: AddObservableInput): Promise<{ dedup: boolean }>;
  addTimelineEntry(caseId: string, entry: TimelineEntryInput): Promise<{ id: string }>;
}

export class HttpEnrichmentM2 implements EnrichmentM2 {
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

  async addObservable(caseId: string, input: AddObservableInput): Promise<{ dedup: boolean }> {
    const { status, json } = await this.call("POST", `/api/v1/cases/${caseId}/observables`, input);
    if (status >= 300) throw new Error(`m2 add_observable failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { dedup: json.dedup === true };
  }

  async addTimelineEntry(caseId: string, entry: TimelineEntryInput): Promise<{ id: string }> {
    const { status, json } = await this.call("POST", `/api/v1/cases/${caseId}/timeline`, entry);
    if (status >= 300) throw new Error(`m2 add_timeline_entry failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { id: String(json.id ?? "") };
  }
}
