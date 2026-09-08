// M2 REST 契约的 TS 侧描述——这就是 m1 的出站 seam（m1 卡：「出站写库 = M2 REST，
// adapter：真实 HTTP / 内存 stub 供单测」）。webhook 代码只认 M2Client 接口：
// 测试换 MemoryM2Client，生产换 HttpM2Client，链路代码一行不改。

// 与 case-backend AlertInput 同构（跨包不引依赖，结构对齐即契约，票 02 的票面契约同思路）
export interface ObservableInput {
  dataType: string;
  data: string;
  message?: string;
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

export interface M2Client {
  ingestAlert(input: AlertInput): Promise<IngestResult>;
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
}

// 内存 stub（m1 卡 Seam 的单测 adapter）：按 (source, sourceRef) 计数，模拟 M2 唯一
// 约束 upsert 的可观察行为。真实约束语义（occurrences+1 / 刷 lastSeen / 只发一次事件）
// 在 case-backend m2.test.ts 对真 SQLite 验证——stub 不承担那部分证明，只承担链路证明。
export class MemoryM2Client implements M2Client {
  readonly calls: AlertInput[] = [];
  readonly results: IngestResult[] = [];
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
}
