// 票 23 新增：LangGraph 原生载体的可观察行为（ADR 0002 框架红线——真引入、真使用，
// 不许「换个方式手写」）。既有断言（票 10/11/13-16）一条未删未放松，本文件只补
// 「换载体带来的新行为」：
//   - 信封节奏由框架 checkpoint 机制决定（输入簿记环 + 每节点一环）
//   - 落盘字节是 LangGraph checkpoint 包装（run 通道 = worker 末态，state_ref 盖整包）
//   - interrupt/resume 是框架 GraphInterrupt/Command 机制（__interrupt__/__resume__ 落盘）
//   - 红线在真载体上复核：篡改任意信封字节 → resume 必拒 + FAILURE 审计
import { describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink, type AuditSink } from "./audit.js";
import { createRun, type RunRow } from "./runs.js";
import { executeRun, resumeRun, THIN_ALERT_FLOW, type ExecuteOpts, type FlowNode } from "./graph.js";
import { loadRunState } from "./checkpointer.js";
import { verifyChain, TamperedCheckpointError } from "./envelope.js";

const REQ = "req-lg";

function makeRun(db: DB, audit: AuditSink): RunRow {
  return createRun(db, { kind: "alert_flow", alertId: "al-5712" }, { audit, requestId: REQ });
}

function envelopeRows(db: DB, runId: string): { seq: number; node: string; state: string; state_ref: string }[] {
  return db
    .prepare("SELECT seq, node, state, state_ref FROM checkpoints WHERE run_id = ? ORDER BY seq")
    .all(runId) as never;
}

function writeRows(db: DB, runId: string): { channel: string }[] {
  return db
    .prepare("SELECT channel FROM checkpoint_writes WHERE thread_id = ? ORDER BY rowid")
    .all(runId) as never;
}

describe("LangGraph 原生载体（票 23·ADR 0002）", () => {
  test("信封节奏 = 框架 checkpoint 节奏：输入簿记 __input__ 环 + 每节点一环，整链可复核", async () => {
    const db = openDb(":memory:");
    const run = makeRun(db, new MemoryAuditSink());
    await executeRun(db, run.id, { nodes: THIN_ALERT_FLOW, requestId: REQ });

    const envelopes = envelopeRows(db, run.id);
    expect(envelopes.map((e) => e.node)).toEqual(["__input__", "__input__", "intake", "route"]);
    const { envelopes: chain } = loadRunState(db, run.id);
    expect(() => verifyChain(chain)).not.toThrow();
    for (const e of envelopes) {
      expect(e.state_ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("落盘字节是 LangGraph checkpoint 包装：run 通道携带 worker 末态，superstep 记录在 metadata", async () => {
    const db = openDb(":memory:");
    const run = makeRun(db, new MemoryAuditSink());
    await executeRun(db, run.id, { nodes: THIN_ALERT_FLOW, requestId: REQ });

    const rows = envelopeRows(db, run.id);
    const saved = JSON.parse(rows[rows.length - 1].state) as {
      checkpoint: { channel_values: { run: Record<string, unknown> }; channel_versions: Record<string, unknown> };
      metadata: { source: string; step: number };
    };
    // worker 的末态在框架状态的 run 通道里（loadRunState 的提取源）
    expect(saved.checkpoint.channel_values.run).toMatchObject({ kind: "alert_flow", alert_id: "al-5712", route: "end" });
    expect(saved.checkpoint.channel_versions).toHaveProperty("run");
    expect(saved.metadata.source).toBe("loop"); // 节点跑完后的 superstep 检查点
    expect(saved.metadata.step).toBeGreaterThan(0);
  });

  test("interrupt/resume 走框架原生机制：挂起落 __interrupt__，Command(resume) 落 __resume__ 写入", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const run = makeRun(db, audit);
    // 最小 L2 图：approve 闸口挂起（决定以审批卡为准，测试里卡永远 pending）
    const flow: FlowNode[] = [
      { name: "advice", run: (ctx) => { ctx.state.recommendation = "isolate_host"; } },
      {
        name: "gate",
        run: (ctx) => {
          ctx.state.execution = ctx.awaitApproval("isolate_host", { host: "centos7" }, { reason: "票 23 载体验证" });
        },
      },
    ];
    const opts: ExecuteOpts = { nodes: flow, requestId: REQ, audit };
    const suspended = await executeRun(db, run.id, opts);
    expect(suspended.status).toBe("awaiting_approval");
    expect(writeRows(db, run.id).map((w) => w.channel)).toContain("__interrupt__");

    // resume：即使卡还没裁决，框架已收到 Command(resume) 并把 resume 值写进盘
    // （节点重跑后卡仍未决 → 幂等再中断，run 仍停在 awaiting_approval）
    const again = await resumeRun(db, run.id, opts);
    expect(again.status).toBe("awaiting_approval");
    expect(writeRows(db, run.id).map((w) => w.channel)).toContain("__resume__");
    // 挂起可观察面不变：approval_required 事件在，run 停在挂起态
    const types = db
      .prepare("SELECT type FROM run_events WHERE run_id = ? ORDER BY id")
      .all(run.id) as { type: string }[];
    expect(types.map((t) => t.type)).toContain("approval_required");
  });

  test("红线（真载体）：篡改任一信封 state 字节 → resume 必拒 + FAILURE 审计 + run 状态原样", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const run = makeRun(db, audit);
    const flow: FlowNode[] = [
      {
        name: "gate",
        run: (ctx) => {
          ctx.awaitApproval("isolate_host", { host: "centos7" });
        },
      },
    ];
    const opts: ExecuteOpts = { nodes: flow, requestId: REQ, audit };
    await executeRun(db, run.id, opts);
    expect((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string }).status)
      .toBe("awaiting_approval");

    // 动一盘字节：LangGraph checkpoint 包装里的 run 通道被改 → state_ref 对不上
    const rows = envelopeRows(db, run.id);
    db.prepare("UPDATE checkpoints SET state = ? WHERE run_id = ? AND seq = ?").run(
      JSON.stringify({ checkpoint: { channel_values: { run: { tampered: true } } } }),
      run.id, rows[0].seq,
    );
    await expect(resumeRun(db, run.id, opts)).rejects.toThrow(TamperedCheckpointError);
    const failure = audit.entries.find((e) => e.result === "FAILURE");
    expect(failure).toMatchObject({ action: "resume", objectId: run.id, objectType: "run" });
    // 状态原样不动：宁可挂起不可恢复出被篡改的状态
    expect((db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id) as { status: string }).status)
      .toBe("awaiting_approval");
  });

  test("Command(resume) 唤醒后照常跑完：决定落卡 → resume → completed，信封链在原链上继续生长", async () => {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const run = makeRun(db, audit);
    // DB 权威闸口的测试形态：decision.approved 翻转模拟值班长落卡
    const decision = { approved: false };
    const flow: FlowNode[] = [
      {
        name: "gate",
        run: (ctx) => {
          if (!decision.approved) {
            ctx.awaitApproval("isolate_host", { host: "centos7" });
            return; // awaitApproval 未决即挂起（interrupt 抛出）；防御性返回保持类型
          }
          ctx.state.execution = { approved: true };
        },
      },
      { name: "wrap", run: (ctx) => { ctx.state.wrapped = true; } },
    ];
    const opts: ExecuteOpts = { nodes: flow, requestId: REQ, audit };
    const suspended = await executeRun(db, run.id, opts);
    expect(suspended.status).toBe("awaiting_approval");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id = ?").get(run.id) as { n: number }).n;
    expect(before).toBeGreaterThanOrEqual(1);

    decision.approved = true;
    const done = await resumeRun(db, run.id, opts);
    expect(done.status).toBe("completed");
    expect(done.steps).toBe(2);
    // 链没有另起炉灶：resume 的新环接在挂起前的旧链上（prev_hash 连续、整链复核过）
    const after = (db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE run_id = ?").get(run.id) as { n: number }).n;
    expect(after).toBeGreaterThan(before);
    const { state, envelopes: chain } = loadRunState(db, run.id);
    expect(() => verifyChain(chain)).not.toThrow();
    expect(state).toMatchObject({ execution: { approved: true }, wrapped: true });
  });
});
