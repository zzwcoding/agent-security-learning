// M2 REST 契约的 TS 侧描述——这就是 m1 的出站 seam（m1 卡：「出站写库 = M2 REST，
// adapter：真实 HTTP / 内存 stub 供单测」）。webhook 代码只认 M2Client 接口：
// 测试换 MemoryM2Client，生产换 HttpM2Client，链路代码一行不改。

// 与 case-backend AlertInput 同构（跨包不引依赖，结构对齐即契约，票 02 的票面契约同思路）
export interface ObservableInput {
  dataType: string;
  data: string;
  message?: string;
  tlp?: number; // 票 30：observables 继承告警级 tlp（M6 富化闸门的输入随管道走）
  pap?: number;
  tags?: string[];
}

export interface AlertInput {
  type: string;
  source: string;
  sourceRef: string;
  title: string;
  description?: string;
  severity?: number;
  tlp?: number;
  pap?: number;
  tags?: string[];
  date?: number;
  raw?: unknown;
  observables?: ObservableInput[];
}

export interface IngestResult {
  alertId: string;
  dedup: boolean;
}

// 票 35（票 09-3 线头）：webhook 校验失败/畸形 JSON 的 422 路径向 M2 审计 FAILURE 条目
// （PRD §6-M1「422 且进审计」的后半句）。M2Client seam 同步长出第二个出站口——审计真相
// 在 M2 audit_entries（FR-S5 两路汇入），ingest 只报五要素里的可变部分，action/actor/
// result 这些 ingest 恒定的面由 adapter 固定，链路代码不重复。
export interface AuditFailureInput {
  /** 被拒请求的溯源锚：尽力取声明告警 id，取不到 unknown 占位。 */
  objectId: string;
  /** 原因摘要（与 422 响应体的 details 同源，不复制整包载荷）。 */
  details: Record<string, unknown>;
  requestId: string;
}

export interface M2Client {
  ingestAlert(input: AlertInput): Promise<IngestResult>;
  auditFailure(input: AuditFailureInput): Promise<void>;
}

// 真实 adapter：POST {baseUrl}/api/v1/alerts（见 case-backend app.ts）。
// 201 = 新建，200 = 命中唯一约束去重（幂等返回既有 id）；其余状态码一律视为失败抛出。
export class HttpM2Client implements M2Client {
  constructor(private readonly baseUrl: string) {}

  async ingestAlert(input: AlertInput): Promise<IngestResult> {
    const res = await fetch(`${this.baseUrl}/api/v1/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => null)) as
      | { alert?: { id?: string }; dedup?: boolean }
      | null;
    if ((res.status === 200 || res.status === 201) && body?.alert?.id) {
      return { alertId: body.alert.id, dedup: body.dedup === true };
    }
    throw new Error(`m2 ingest failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }

  // 票 35：auditFailure 自己吞错——422 是业务结论，审计通道病了只降级记结构化日志，
  // 绝不让 422 变 500，也不让调用方等一个注定失败的请求超过 2s。
  async auditFailure(input: AuditFailureInput): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/audit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "ingest",
          actor: { type: "system", id: "m1:ingest" },
          object_id: input.objectId,
          object_type: "ingest_request",
          details: input.details,
          request_id: input.requestId,
          result: "FAILURE",
        }),
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`audit ingest failed: HTTP ${res.status}`);
    } catch (e: unknown) {
      console.error(JSON.stringify({
        warn: "audit_ingest_failed",
        objectId: input.objectId,
        requestId: input.requestId,
        error: String(e),
      }));
    }
  }
}

// 内存 stub（m1 卡 Seam 的单测 adapter）：按 (source, sourceRef) 计数，模拟 M2 唯一
// 约束 upsert 的可观察行为。真实约束语义（occurrences+1 / 刷 lastSeen / 只发一次事件）
// 在 case-backend m2.test.ts 对真 SQLite 验证——stub 不承担那部分证明，只承担链路证明。
export class MemoryM2Client implements M2Client {
  readonly calls: AlertInput[] = [];
  readonly results: IngestResult[] = [];
  /** 票 35：422 路径发来的 FAILURE 审计请求（单测断言面）。 */
  readonly auditFailures: AuditFailureInput[] = [];
  private readonly byRef = new Map<string, string>();
  private seq = 0;

  async ingestAlert(input: AlertInput): Promise<IngestResult> {
    this.calls.push(input);
    const key = `${input.source}|${input.sourceRef}`;
    const existing = this.byRef.get(key);
    const result: IngestResult = existing
      ? { alertId: existing, dedup: true }
      : { alertId: `al_stub_${String(++this.seq).padStart(4, "0")}`, dedup: false };
    if (!existing) this.byRef.set(key, result.alertId);
    this.results.push(result);
    return result;
  }

  async auditFailure(input: AuditFailureInput): Promise<void> {
    this.auditFailures.push(input);
  }
}
