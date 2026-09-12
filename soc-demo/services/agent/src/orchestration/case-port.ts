// m14 编排循环 · m2 案件实体公开面的 HTTP adapter（票 75）。
//
// 收敛分岔（行为约定 9）的建案半边：hit 建案挂 hypothesis_id / miss 落归档案承载 note
// 结论条目——只走 m2 公开 REST（POST /api/v1/cases、POST /api/v1/cases/:id/timeline，
// 边界规则 R1：跨服务不 import 源码内部，hypothesis-port.ts 同款 adapter 纪律）。
// kind/author 是机制常量收在本件内（机制层不见 m2 wire 细节）；生产装配零改动——
// OrchestrationDeps.cases 缺省即本件（scan 缝同款缺省法），测试注内存假件。
import type { CaseCreateInput, CasePort } from "./ports.js";

export const CONCLUSION_NOTE_KIND = "note" as const;
export const CONCLUSION_AUTHOR = "agent:hunt_flow" as const;

export class HttpCasePort implements CasePort {
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  private async call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`case ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  async create(input: CaseCreateInput): Promise<string> {
    const body = await this.call("/api/v1/cases", {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.hypothesis_id ? { hypothesis_id: input.hypothesis_id } : {}),
      }),
      headers: { "x-actor-id": CONCLUSION_AUTHOR, "x-actor-type": "agent" },
    });
    const id = body.id;
    if (typeof id !== "string" || !id) throw new Error("case create: missing id in m2 response");
    return id;
  }

  async addNote(caseId: string, entry: { body: string; structured?: unknown }): Promise<void> {
    await this.call(`/api/v1/cases/${encodeURIComponent(caseId)}/timeline`, {
      method: "POST",
      body: JSON.stringify({
        kind: CONCLUSION_NOTE_KIND,
        author: CONCLUSION_AUTHOR,
        body: entry.body,
        ...(entry.structured !== undefined ? { structured: entry.structured } : {}),
      }),
      headers: { "x-actor-id": CONCLUSION_AUTHOR, "x-actor-type": "agent" },
    });
  }
}

/** 生产缺省件（OrchestrationDeps.cases 缺省）：无状态 HTTP adapter，进程内单例即可。 */
let defaultPort: HttpCasePort | null = null;
export function defaultCasePort(): CasePort {
  defaultPort ??= new HttpCasePort();
  return defaultPort;
}
