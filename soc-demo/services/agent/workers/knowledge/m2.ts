// m7 知识沉淀 worker · M2 出站 adapter（票 17）。
//
// 消费 m2 卡公开 REST（kb/proposals 面 = 票 17 新挂 M2 的五个端点 + 案件详情）。
// adapter 形态照 HttpTriageM2 先例：生产 HTTP（CASE_BACKEND_URL），测试打真
// case-backend（app.inject / 随机端口起服）。裁决 409 语义留在 M2，这里只报 ok/reason
// ——resume 重入的幂等（已裁决过的提案再裁决）由 flow 侧按 reason 放行。
export interface CaseDetailDto {
  id: string;
  title: string;
  description: string;
  severity: number;
  status: string;
  verdict: string | null;
  verdictNote: string | null;
  tags: string[];
  observables?: { dataType: string; data: string; tags?: string[] }[];
  timeline: { kind: string; author: string; body: string }[];
}

export interface KbProposalInput {
  kind: string;
  title: string;
  body: string;
  tags: string[];
  source_case_id: string | null;
  proposed_by: string;
}

export type DecideResult = { ok: true } | { ok: false; reason: string };

export interface KnowledgeM2 {
  getCase(caseId: string): Promise<CaseDetailDto | null>;
  createProposal(input: KbProposalInput): Promise<{ id: string }>;
  /** proposed→approved（kb_write 执行体调；账面留痕）。409（已裁决）→ ok:false。 */
  approveProposal(id: string, reviewer: string): Promise<DecideResult>;
  /** proposed→rejected（值班长在审批卡驳回后由 flow 调；账面留痕）。 */
  rejectProposal(id: string, reviewer: string, reason?: string): Promise<DecideResult>;
}

export class HttpKnowledgeM2 implements KnowledgeM2 {
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

  async getCase(caseId: string): Promise<CaseDetailDto | null> {
    const { status, json } = await this.call("GET", `/api/v1/cases/${caseId}`);
    return status === 200 ? (json as unknown as CaseDetailDto) : null;
  }

  async createProposal(input: KbProposalInput): Promise<{ id: string }> {
    const { status, json } = await this.call("POST", "/api/v1/kb/proposals", input);
    if (status >= 300) throw new Error(`m2 kb_propose failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { id: String(json.id) };
  }

  async approveProposal(id: string, reviewer: string): Promise<DecideResult> {
    const { status, json } = await this.call("POST", `/api/v1/kb/proposals/${id}/approve`, { reviewer });
    return status < 300 ? { ok: true } : { ok: false, reason: String(json.error ?? `http_${status}`) };
  }

  async rejectProposal(id: string, reviewer: string, reason?: string): Promise<DecideResult> {
    const { status, json } = await this.call("POST", `/api/v1/kb/proposals/${id}/reject`, { reviewer, reason });
    return status < 300 ? { ok: true } : { ok: false, reason: String(json.error ?? `http_${status}`) };
  }
}
