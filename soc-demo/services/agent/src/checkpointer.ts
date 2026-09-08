// checkpointer（m3 卡 Seam：checkpointer 存储 = SQLite 信封 hash 链）。
// 票 23 起（ADR 0002）：编排载体换成 LangGraph.js，checkpointer 以框架的
// BaseCheckpointSaver 接口实现（EnvelopeCheckpointSaver）——LangGraph 在每个
// superstep 调 put/getTuple/putWrites，我们把信封 hash 链装进这些接缝：
//   put      = 盖信封追加一行（state 字节 sha256 进 state_ref，prev_hash 链住上一环）
//   getTuple = 整链复核后才交出状态（INV-1 fail-closed 的持久化版：宁可不恢复，
//              不可恢复出被篡改的状态）；篡改任意字节 → TamperedCheckpointError
//   putWrites= interrupt/resume 的任务写入（框架恢复机制的账本，单独一表）
// 纯函数的链数学仍在 envelope.ts（sealEnvelope/verifyChain），这里只做「装进框架」。
import { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from "@langchain/langgraph";
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

/** 追加一个检查点：EnvelopeCheckpointSaver.put 与测试直写的共同落库口。 */
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

/** LangGraph 载体的落盘形态：{checkpoint, metadata, parentCheckpointId} 包装（一次
 *  序列化、一个 hash 盖住框架记录的全部字节）。checkpoint.channel_values.run 是
 *  图状态（run 主体的交接上下文 + worker 产出）。 */
interface SavedCheckpoint {
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata | null;
  parentCheckpointId?: string;
}

function isSavedCheckpoint(v: unknown): v is SavedCheckpoint {
  return (
    typeof v === "object" && v !== null && "checkpoint" in v &&
    typeof (v as SavedCheckpoint).checkpoint === "object" &&
    (v as SavedCheckpoint).checkpoint !== null
  );
}

/** 从落盘字节取 run 主体的末态：LangGraph 载体提取 channel_values.run；
 *  裸状态 JSON（旧形态/测试直写的信封）原样返回。 */
function runStateOf(stateJson: string): Record<string, unknown> {
  const parsed = JSON.parse(stateJson) as unknown;
  if (isSavedCheckpoint(parsed)) {
    const run = parsed.checkpoint.channel_values.run;
    return typeof run === "object" && run !== null ? run as Record<string, unknown> : {};
  }
  return parsed as Record<string, unknown>;
}

/** 读末态（先整链复核）：诚实链 → 最后一个快照 + 全链；被动过 → 抛 TamperedCheckpointError。
 *  空链不是篡改——中断发生在第一个节点跑完之前，无可恢复亦无可疑，交空态让 runner 从头起。 */
export function loadRunState(db: DB, runId: string): Checkpointed {
  const rows = loadRows(db, runId);
  verifyChain(rows); // 断链/篡改都在这里炸
  if (rows.length === 0) {
    return { state: {}, envelopes: [] };
  }
  const last = rows[rows.length - 1];
  return { state: runStateOf(last.state), envelopes: rows };
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

// ---- EnvelopeCheckpointSaver：LangGraph BaseCheckpointSaver 的信封 hash 链实现 ----

/** putWrites 的列位协议（与框架 WRITES_IDX_MAP 同源）：普通写入按序占位，特殊写入
 *  （错误/中断/resume 值）占负位避免冲突——杀进程重启后靠它们找回挂起的任务。 */
const WRITES_IDX_MAP: Record<string, number> = {
  __error__: -1,
  __scheduled__: -2,
  __interrupt__: -3,
  __resume__: -4,
};

interface WriteRow {
  taskId: string;
  channel: string;
  type: string;
  value: string;
}

export class EnvelopeCheckpointSaver extends BaseCheckpointSaver {
  constructor(
    private readonly db: DB,
    /** 信封 node 列的取值口：编排层在节点执行时更新游标，put 时读到「刚跑完的节点」；
     *  空串 = 框架自身的簿记检查点（输入态），落成 __input__。 */
    private readonly nodeLabel: () => string = () => "",
  ) {
    super();
  }

  private threadOf(config: { configurable?: Record<string, unknown> }): string {
    const threadId = config.configurable?.thread_id;
    if (typeof threadId !== "string" || threadId === "") {
      throw new TamperedCheckpointError("missing thread_id");
    }
    const ns = config.configurable?.checkpoint_ns ?? "";
    if (ns !== "") {
      // 本仓不编译子图：thread 即 run_id，单一命名空间。出现别的 ns = 用法超出契约，fail-closed。
      throw new TamperedCheckpointError(`unexpected checkpoint_ns ${String(ns)}`);
    }
    return threadId;
  }

  /** 最新一环的信封（prev_hash 链的接续点）。 */
  private latestEnvelope(runId: string): Envelope | null {
    const last = loadRows(this.db, runId).at(-1);
    if (!last) return null;
    return {
      runId: last.runId,
      seq: last.seq,
      node: last.node,
      stateRef: last.stateRef,
      prevHash: last.prevHash,
      hash: last.hash,
    };
  }

  async put(
    config: { configurable?: Record<string, unknown> },
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata | null,
  ): Promise<{ configurable: Record<string, unknown> }> {
    const runId = this.threadOf(config);
    const parentId = config.configurable?.checkpoint_id;
    const saved: SavedCheckpoint = {
      checkpoint,
      metadata,
      parentCheckpointId: typeof parentId === "string" ? parentId : undefined,
    };
    const [, bytes] = await this.serde.dumpsTyped(saved);
    const stateJson = Buffer.from(bytes).toString("utf8");
    const envelope = sealEnvelope(this.latestEnvelope(runId), {
      runId,
      node: this.nodeLabel() || "__input__",
      stateJson,
    });
    putCheckpoint(this.db, envelope, stateJson);
    return { configurable: { thread_id: runId, checkpoint_ns: "", checkpoint_id: checkpoint.id } };
  }

  private loadWrites(runId: string, checkpointId: string): Promise<WriteRow[]> {
    return Promise.all(
      (
        this.db
          .prepare(
            `SELECT task_id, channel, type, value FROM checkpoint_writes
              WHERE thread_id = ? AND checkpoint_id = ? ORDER BY rowid`,
          )
          .all(runId, checkpointId) as Record<string, unknown>[]
      ).map((row) => ({
        taskId: row.task_id as string,
        channel: row.channel as string,
        type: row.type as string,
        value: row.value as string,
      })),
    );
  }

  /** 读出 = 整链复核后才交出（篡改在 verifyChain 处抛 TamperedCheckpointError，
   *  resume 必拒；LangGraph 的 invoke/resume 从这里拿检查点）。 */
  async getTuple(config: { configurable?: Record<string, unknown> }): Promise<CheckpointTuple | undefined> {
    const runId = this.threadOf(config);
    const requested = config.configurable?.checkpoint_id;
    const rows = loadRows(this.db, runId);
    verifyChain(rows);
    if (rows.length === 0) return undefined;

    // 找目标环：指定 checkpoint_id 就按存档比对（环数少，顺序解包代价可忽略）；
    // 不指定 = 取链尾（框架的「当前状态」语义）。
    let hit: { row: EnvelopeRow; saved: SavedCheckpoint } | undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const saved = await this.serde.loadsTyped("json", rows[i].state) as SavedCheckpoint;
      if (!isSavedCheckpoint(saved)) continue;
      if (typeof requested === "string" && saved.checkpoint.id !== requested) continue;
      hit = { row: rows[i], saved };
      break;
    }
    if (!hit) return undefined;

    const pendingWrites: [string, string, unknown][] = await Promise.all(
      (await this.loadWrites(runId, hit.saved.checkpoint.id)).map(async (w) => [
        w.taskId,
        w.channel,
        await this.serde.loadsTyped(w.type, w.value),
      ] as [string, string, unknown]),
    );
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: runId, checkpoint_ns: "", checkpoint_id: hit.saved.checkpoint.id } },
      checkpoint: hit.saved.checkpoint,
      metadata: hit.saved.metadata ?? undefined,
      pendingWrites,
    };
    if (hit.saved.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: { thread_id: runId, checkpoint_ns: "", checkpoint_id: hit.saved.parentCheckpointId },
      };
    }
    return tuple;
  }

  async *list(config: { configurable?: Record<string, unknown> }): AsyncGenerator<CheckpointTuple> {
    const runId = this.threadOf(config);
    const rows = loadRows(this.db, runId);
    verifyChain(rows);
    for (let i = rows.length - 1; i >= 0; i--) {
      const saved = await this.serde.loadsTyped("json", rows[i].state) as SavedCheckpoint;
      if (!isSavedCheckpoint(saved)) continue;
      yield {
        config: { configurable: { thread_id: runId, checkpoint_ns: "", checkpoint_id: saved.checkpoint.id } },
        checkpoint: saved.checkpoint,
        metadata: saved.metadata ?? undefined,
      };
    }
  }

  async putWrites(
    config: { configurable?: Record<string, unknown> },
    writes: [string, unknown][],
    taskId: string,
  ): Promise<void> {
    const runId = this.threadOf(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string" || checkpointId === "") {
      throw new TamperedCheckpointError("putWrites missing checkpoint_id");
    }
    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const idx = WRITES_IDX_MAP[channel] ?? i;
      const [type, bytes] = await this.serde.dumpsTyped(value);
      // 普通写入先到先得（幂等重放不动账）；特殊写入（中断/resume）以最新为准
      const sql = idx >= 0
        ? `INSERT OR IGNORE INTO checkpoint_writes
             (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value, created_at)
           VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT OR REPLACE INTO checkpoint_writes
             (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value, created_at)
           VALUES (?, '', ?, ?, ?, ?, ?, ?, ?)`;
      this.db.prepare(sql).run(
        runId, checkpointId, taskId, idx, channel, type,
        Buffer.from(bytes).toString("utf8"), nowMs(),
      );
    }
  }

  async deleteThread(runId: string): Promise<void> {
    this.db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM checkpoint_writes WHERE thread_id = ?").run(runId);
  }
}
