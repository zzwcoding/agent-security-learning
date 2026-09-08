// m4 分诊 worker · M2 出站 adapter（票 13；票 10 记录「M2Client 接线随票 13」）。
//
// m2 卡公开接口（REST）就是这里消费的面：alert 读 / PATCH 写回（verdict_ai + verdict
// 锁）、FR-M2.4 同主机活跃 case 查询、FR-M2.3 三结局动词里的建案/并案。adapter 形态
// 照 m1 的 M2Client 先例：生产 HttpTriageM2（CASE_BACKEND_URL），测试用 app.inject
// 打真 case-backend（状态机/409 语义都在环内，见 flow.test.ts 的 InjectM2）。
import type { MergeCheck } from "./prompt.js";

export interface ObservableDto {
  dataType: string;
  data: string;
  tags?: string[];
}

/** getAlert 返回的子集（camelCase，对齐 M2 mapAlert 的 wire 形状）。 */
export interface AlertDto {
  id: string;
  sourceRef: string;
  title: string;
  description: string;
  severity: number;
  status: string;
  tags: string[];
  verdict: string | null;
  verdictAi: unknown;
  observables?: ObservableDto[];
}

export interface M2Patch {
  verdict?: string;
  verdict_ai?: unknown;
  status?: string;
}

export type ClaimResult = { ok: true } | { ok: false; reason: string };
export type PatchResult = { ok: true } | { ok: false; reason: string };

export interface TriageM2 {
  getAlert(alertId: string): Promise<AlertDto | null>;
  /** FR-M4.5 拾取锁：PATCH {verdict:"in-progress"}（M2 侧条件更新 WHERE verdict IS NULL）。
   *  409 = 已被其他 run 拾取/已有终值 → reason "verdict_locked"。 */
  claimVerdict(alertId: string): Promise<ClaimResult>;
  patchOutcome(alertId: string, patch: M2Patch): Promise<PatchResult>;
  /** FR-M2.4：同主机 + 时间窗查活跃 case。 */
  findActiveCases(host: string, withinHours: number): Promise<{ id: string; title: string }[]>;
  createCase(alertId: string): Promise<{ caseId: string }>;
  mergeAlert(alertId: string, caseId: string): Promise<{ caseId: string }>;
}

export class HttpTriageM2 implements TriageM2 {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      // content-type 只在真带 body 时给——空 body + json 头会被 Fastify 当坏请求拒掉
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async getAlert(alertId: string): Promise<AlertDto | null> {
    const { status, json } = await this.call("GET", `/api/v1/alerts/${alertId}`);
    return status === 200 ? (json as unknown as AlertDto) : null;
  }

  async claimVerdict(alertId: string): Promise<ClaimResult> {
    const { status, json } = await this.call("PATCH", `/api/v1/alerts/${alertId}`, {
      verdict: "in-progress",
    });
    return status < 300 ? { ok: true } : { ok: false, reason: String(json.error ?? `http_${status}`) };
  }

  async patchOutcome(alertId: string, patch: M2Patch): Promise<PatchResult> {
    const { status, json } = await this.call("PATCH", `/api/v1/alerts/${alertId}`, patch);
    return status < 300 ? { ok: true } : { ok: false, reason: String(json.error ?? `http_${status}`) };
  }

  async findActiveCases(host: string, withinHours: number): Promise<{ id: string; title: string }[]> {
    const { json } = await this.call(
      "GET",
      `/api/v1/cases/active?host=${encodeURIComponent(host)}&within_hours=${withinHours}`,
    );
    return json as unknown as { id: string; title: string }[];
  }

  async createCase(alertId: string): Promise<{ caseId: string }> {
    const { status, json } = await this.call("POST", `/api/v1/alerts/${alertId}/create-case`, {});
    if (status >= 300) throw new Error(`m2 create_case failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { caseId: String((json as { case: { id: string } }).case.id) };
  }

  async mergeAlert(alertId: string, caseId: string): Promise<{ caseId: string }> {
    const { status, json } = await this.call("POST", `/api/v1/alerts/${alertId}/merge/${caseId}`);
    if (status >= 300) throw new Error(`m2 merge_alert failed: HTTP ${status} ${JSON.stringify(json)}`);
    return { caseId };
  }
}

/** merge_check 结果的装配（flow 用）：把 M2 的活跃 case 列表折成 MergeCheck。 */
export function toMergeCheck(host: string, withinHours: number, cases: { id: string }[]): MergeCheck {
  return {
    host,
    withinHours,
    openCasesChecked: cases.length,
    sameHostCaseFound: cases.length > 0,
    candidateCaseId: cases[0]?.id ?? null,
  };
}
