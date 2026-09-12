// m14 编排循环 · 父子 run 簿记（票 73：fanout 子 run 独立 run 行 + parent/round 簿记）。
//
// run 行本身不扩列（本票禁改 runs schema）——簿记落 agent 自持 SQLite 的一张 m14 领地
// 表（hunt_run_links，run_id 主键），语义上就是 run 行的编排侧补记：每个 hunt_flow 轮次
// run / hunt_task 子 run 一行，parent_run_id + round_no 可查（轮次归集的假设侧视图在 m2
// hypothesis_rounds.children，两处口径同源：轮次 outcome 一起上报）。
//
// 轮次接力幂等（INV-6 同族）：findByRound 有行 = 该轮已拉起，relay 重放同事件不再起 run。
// Memory 版供单测；生产装配（index.ts）用 SQLite 版。
import type { DB } from "../db.js";
import type { HuntLedger, HuntLink, PlannedTask } from "./ports.js";

export class MemoryHuntLedger implements HuntLedger {
  private readonly byRun = new Map<string, HuntLink>();

  put(link: HuntLink): void {
    this.byRun.set(link.runId, { ...link });
  }
  get(runId: string): HuntLink | null {
    return this.byRun.get(runId) ?? null;
  }
  findByRound(hypothesisId: string, roundNo: number): HuntLink | null {
    for (const l of this.byRun.values()) {
      if (l.role === "round" && l.hypothesisId === hypothesisId && l.roundNo === roundNo) return l;
    }
    return null;
  }
  childrenOf(parentRunId: string): HuntLink[] {
    return [...this.byRun.values()].filter((l) => l.role === "task" && l.parentRunId === parentRunId);
  }
  rounds(hypothesisId: string): HuntLink[] {
    return [...this.byRun.values()]
      .filter((l) => l.role === "round" && l.hypothesisId === hypothesisId)
      .sort((a, b) => a.roundNo - b.roundNo);
  }
  all(): HuntLink[] {
    return [...this.byRun.values()];
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS hunt_run_links (
  run_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL,
  round_no INTEGER NOT NULL,
  parent_run_id TEXT,
  task TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hunt_links_hyp ON hunt_run_links(hypothesis_id, round_no, role);
CREATE INDEX IF NOT EXISTS idx_hunt_links_parent ON hunt_run_links(parent_run_id);
`;

export class SqliteHuntLedger implements HuntLedger {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
    // m14 领地表的建表自洽在机制件内（lazy CREATE IF NOT EXISTS，幂等）——不动 db.ts
    // 的既有 DDL（本票禁改清单），老库新库都靠这里补齐。
    db.exec(DDL);
  }

  put(link: HuntLink): void {
    this.db
      .prepare(
        `INSERT INTO hunt_run_links (run_id, role, hypothesis_id, round_no, parent_run_id, task, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET role = excluded.role, parent_run_id = excluded.parent_run_id`,
      )
      .run(
        link.runId, link.role, link.hypothesisId, link.roundNo,
        link.parentRunId, link.task ? JSON.stringify(link.task) : null, Date.now(),
      );
  }

  private map(row: Record<string, unknown> | undefined): HuntLink | null {
    if (!row) return null;
    return {
      runId: row.run_id as string,
      role: row.role as HuntLink["role"],
      hypothesisId: row.hypothesis_id as string,
      roundNo: row.round_no as number,
      parentRunId: (row.parent_run_id as string | null) ?? null,
      task: row.task ? (JSON.parse(row.task as string) as PlannedTask) : null,
    };
  }

  get(runId: string): HuntLink | null {
    return this.map(
      this.db.prepare("SELECT * FROM hunt_run_links WHERE run_id = ?").get(runId) as Record<string, unknown>,
    );
  }

  findByRound(hypothesisId: string, roundNo: number): HuntLink | null {
    return this.map(
      this.db
        .prepare("SELECT * FROM hunt_run_links WHERE hypothesis_id = ? AND round_no = ? AND role = 'round'")
        .get(hypothesisId, roundNo) as Record<string, unknown>,
    );
  }

  childrenOf(parentRunId: string): HuntLink[] {
    return (
      this.db
        .prepare("SELECT * FROM hunt_run_links WHERE parent_run_id = ? AND role = 'task' ORDER BY created_at, rowid")
        .all(parentRunId) as Record<string, unknown>[]
    ).map((r) => this.map(r) as HuntLink);
  }

  rounds(hypothesisId: string): HuntLink[] {
    return (
      this.db
        .prepare("SELECT * FROM hunt_run_links WHERE hypothesis_id = ? AND role = 'round' ORDER BY round_no")
        .all(hypothesisId) as Record<string, unknown>[]
    ).map((r) => this.map(r) as HuntLink);
  }

  all(): HuntLink[] {
    return (
      this.db.prepare("SELECT * FROM hunt_run_links ORDER BY created_at, rowid").all() as Record<string, unknown>[]
    ).map((r) => this.map(r) as HuntLink);
  }
}
