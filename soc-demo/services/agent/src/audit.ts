// agent 侧审计出口（票 10 的最小形态）。INV-8：任何状态变更/兜底强杀/resume 拒绝都要
// 有五要素审计。真相源是 M2 的 audit_entries 表（PRD FR-S5：两路汇入同一表）——M2 目前
// 只有审计查询面、没有写入口，所以这里先立 seam：MemoryAuditSink 供单测与当前演示；
// M2 开出写入口后换 HttpAuditSink（照 m1 的 M2Client adapter 先例），调用方零改动。
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

/** 生产兜底 sink：把审计打进服务日志（compose logs 可观察）。M2 开出审计写入口后，
 *  index.ts 换成 HttpAuditSink 汇入 audit_entries 表（PRD FR-S5：两路汇入同一表）。 */
export class ConsoleAuditSink implements AuditSink {
  record(entry: AuditEntry): void {
    console.log(JSON.stringify({ audit: entry }));
  }
}
