// m14 编排循环 · m2 假设实体公开面的 HTTP adapter（票 73）。
// 生产装配（index.ts）注入；测试注入内存假件。只走 m2 公开 REST（边界规则 R1：
// 跨服务不 import 源码内部——与 HttpTriageM2/HttpAuditSink 同款 adapter 纪律）。
import type {
  HypothesisDetail,
  HypothesisPort,
  RoundRecord,
} from "./ports.js";

export class HttpHypothesisPort implements HypothesisPort {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`hypothesis ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async getDetail(id: string): Promise<HypothesisDetail | null> {
    const res = await fetch(`${this.baseUrl}/api/v1/hypotheses/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`hypothesis detail failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      status: HypothesisDetail["status"]; template_id: string; text: string; rounds: RoundRecord[];
    };
    return {
      id,
      status: body.status,
      template_id: body.template_id,
      text: body.text,
      rounds: body.rounds ?? [],
    };
  }

  async startHunting(id: string): Promise<void> {
    await this.call(`/api/v1/hypotheses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "hunting" }),
      headers: { "x-actor-id": "agent:hunt_flow", "x-actor-type": "agent" },
    });
  }

  async transition(id: string, to: "concluded" | "refuted" | "cancelled", opts?: { reason?: string }): Promise<void> {
    await this.call(`/api/v1/hypotheses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: to, ...(opts?.reason ? { reason: opts.reason } : {}) }),
      headers: { "x-actor-id": "agent:hunt_flow", "x-actor-type": "agent" },
    });
  }

  async recordRound(id: string, round: RoundRecord): Promise<void> {
    await this.call(`/api/v1/hypotheses/${encodeURIComponent(id)}/rounds`, {
      method: "POST",
      body: JSON.stringify(round),
      headers: { "x-actor-id": "agent:hunt_flow", "x-actor-type": "agent" },
    });
  }
}
