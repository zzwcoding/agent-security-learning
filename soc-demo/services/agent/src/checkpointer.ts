// checkpointer（m3 卡 Seam：checkpointer 存储 = SQLite 信封 hash 链）。
// 写入 = 盖信封追加一行；读出/resume = 整链复核后才交出状态（INV-1 fail-closed 的持久化版：
// 宁可不恢复，不可恢复出被篡改的状态）。测试 adapter = :memory: SQLite（m3 卡「内存
// checkpointer」在本仓的落法，与 case-backend 的内存 SQLite 同理）。
import type { DB } from "./db.js";
import {
  sealEnvelope,
  verifyChain,
  TamperedCheckpointError,
  type Envelope,
  type EnvelopeRow,
} from "./envelope.js";
import type { AuditSink } from "./audit.js";

const nowMs = () => Date.now();

/** 追加一个检查点：runner 在每个节点跑完后调用。 */
export function putCheckpoint(db: DB, envelope: Envelope, stateJson: string): void {
  db.prepare(
    `INSERT INTO checkpoints (run_id, seq, node, state, state_ref, prev_hash, hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    envelope.runId, envelope.seq, envelope.node, stateJson,
    envelope.stateRef, envelope.prevHash, envelope.hash, nowMs(),
  );
}

function loadRows(db: DB, runId: string): EnvelopeRow[] {
  return (
    db.prepare("SELECT * FROM checkpoints WHERE run_id = ? ORDER BY seq").all(runId) as
      Record<string, unknown>[]
  ).map((row) => ({
    runId: row.run_id as string,
    seq: row.seq as number,
    node: row.node as string,
    state: row.state as string,
    stateRef: row.state_ref as string,
    prevHash: row.prev_hash as string,
    hash: row.hash as string,
  }));
}

export interface Checkpointed {
  state: Record<string, unknown>;
  envelopes: EnvelopeRow[];
}

/** 读末态（先整链复核）：诚实链 → 最后一个快照 + 全链；被动过 → 抛 TamperedCheckpointError。 */
export function loadRunState(db: DB, runId: string): Checkpointed {
  const rows = loadRows(db, runId);
  verifyChain(rows); // 空链/断链/篡改都在这里炸
  if (rows.length === 0) {
    throw new TamperedCheckpointError(`no checkpoint for ${runId}`);
  }
  const last = rows[rows.length - 1];
  return { state: JSON.parse(last.state) as Record<string, unknown>, envelopes: rows };
}

export interface ResumeDeps {
  audit: AuditSink;
  requestId: string;
}

/** resume 入口（票 11 审批回路的落点；本票先被中断-篡改测试消费）：
 *  复核通过交出末态；校验失败 = 拒绝恢复 + 审计 FAILURE（PRD FR-M3.3），状态原样不动。 */
export function resumeRun(db: DB, runId: string, deps: ResumeDeps): Checkpointed {
  try {
    return loadRunState(db, runId);
  } catch (e) {
    if (e instanceof TamperedCheckpointError) {
      deps.audit.record({
        action: "resume",
        actor: { type: "system", id: "m3:supervisor" },
        objectId: runId,
        objectType: "run",
        details: { reason: e.message },
        requestId: deps.requestId,
        result: "FAILURE",
        createdAt: nowMs(),
      });
    }
    throw e;
  }
}

/** 盖信封 + 落库一步到位（runner 用）。 */
export function checkpoint(db: DB, prev: Envelope | null, input: {
  runId: string;
  node: string;
  stateJson: string;
}): Envelope {
  const envelope = sealEnvelope(prev, input);
  putCheckpoint(db, envelope, input.stateJson);
  return envelope;
}
