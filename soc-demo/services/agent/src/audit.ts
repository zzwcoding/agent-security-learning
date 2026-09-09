// agent 侧审计出口（票 10 的最小形态）。INV-8：任何状态变更/兜底强杀/resume 拒绝都要
// 有五要素审计。真相源是 M2 的 audit_entries 表（PRD FR-S5：两路汇入同一表）——
// MemoryAuditSink 供单测与 evals 布景；生产装配（index.ts）用 HttpAuditSink 汇入 M2
// （票 35 接通 M2 的 /internal/audit 写口，照 m1 的 M2Client adapter 先例），调用方零改动。
export interface AuditEntry {
  action: string;
  actor: { type: string; id: string };
  objectId: string;
  objectType: string;
  details: Record<string, unknown>;
  requestId: string;
  result: "SUCCESS" | "FAILURE" | "DENIED";
  createdAt: number;
}

export interface AuditSink {
  record(entry: AuditEntry): void;
}

export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

/** 生产兜底 sink：把审计打进服务日志（compose logs 可观察）。M2 写口不可达时的降级路径：
 *  index.ts 换一行装配即回此实现（FR-S5 的另一路先例，票 10 形态原样保留）。 */
export class ConsoleAuditSink implements AuditSink {
  record(entry: AuditEntry): void {
    console.log(JSON.stringify({ audit: entry }));
  }
}

// ---------- 票 35（FR-S5）：生产 sink，汇入 M2 audit_entries ----------
//
// 审计失败口径（记票交 L0 备案）：INV-8 要审计存在，但审计通道病了不能把业务也打死——
// worker 的 record() 全在执行路径上，这里 fire-and-forget（HttpTokenBurner 同款纪律），
// 出站失败只打结构化日志（warn=audit_ingest_failed，可 grep 可接告警）。若 L0 认为审计
// 应 fail-closed（业务同步等审计落账），换「本地镜像表 + outbox 补偿」adapter，调用方
// 零改动（seam 立在这里的意义）。flush() 只给测试等确定性场景排空在途请求，不在业务路径。

export class HttpAuditSink implements AuditSink {
  private readonly baseUrl: string;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(baseUrl = process.env.CASE_BACKEND_URL ?? "http://case-backend:3002") {
    this.baseUrl = baseUrl;
  }

  record(entry: AuditEntry): void {
    const send = fetch(`${this.baseUrl}/internal/audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 五要素 wire 映射：case-backend app.ts 按 snake_case 键取值（object_id/request_id/
      // created_at…），错一个键 = 400 invalid_audit。created_at 透传调用方观测时刻。
      body: JSON.stringify({
        action: entry.action,
        actor: entry.actor,
        object_id: entry.objectId,
        object_type: entry.objectType,
        details: entry.details,
        request_id: entry.requestId,
        result: entry.result,
        created_at: entry.createdAt,
      }),
      signal: AbortSignal.timeout(2000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`audit ingest failed: HTTP ${res.status}`);
      })
      .catch((e: unknown) => {
        // 业务成功优先、审计失败记本地结构化日志（与 ConsoleAuditSink 同为可观察面）
        console.error(JSON.stringify({
          warn: "audit_ingest_failed",
          action: entry.action,
          objectType: entry.objectType,
          objectId: entry.objectId,
          requestId: entry.requestId,
          error: String(e),
        }));
      });
    const tracked = send.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /** 排空在途出站（测试确定性用；业务路径绝不 await 它）。 */
  flush(): Promise<void> {
    return Promise.all([...this.inFlight]).then(() => undefined);
  }
}
