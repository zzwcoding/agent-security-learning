import { describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import {
  GENESIS_PREV_HASH,
  sealEnvelope,
  verifyChain,
  TamperedCheckpointError,
  type EnvelopeRow,
} from "./envelope.js";
import { putCheckpoint, loadRunState, resumeRun } from "./checkpointer.js";
import { MemoryAuditSink } from "./audit.js";

function makeDb(): DB {
  return openDb(":memory:");
}

function chain(db: DB): { runId: string } {
  const runId = "run_chain";
  const s1 = JSON.stringify({ kind: "alert_flow", alert_id: "al-5712" });
  const e1 = sealEnvelope(null, { runId, node: "intake", stateJson: s1 });
  putCheckpoint(db, e1, s1);
  const s2 = JSON.stringify({ kind: "alert_flow", alert_id: "al-5712", route: "end" });
  const e2 = sealEnvelope(e1, { runId, node: "route", stateJson: s2 });
  putCheckpoint(db, e2, s2);
  return { runId };
}

describe("信封 hash 链（PRD：{run_id, node, state_ref, prev_hash, hash} 链式计算）", () => {
  test("seal：state_ref 是状态字节的 sha256；hash 盖住信封全字段；prev_hash 链住上一个", () => {
    const s1 = JSON.stringify({ alert_id: "al-1" });
    const e1 = sealEnvelope(null, { runId: "run_1", node: "intake", stateJson: s1 });
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe(GENESIS_PREV_HASH);
    expect(e1.stateRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e1.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e1.hash).not.toBe(e1.stateRef);

    const s2 = JSON.stringify({ alert_id: "al-1", route: "end" });
    const e2 = sealEnvelope(e1, { runId: "run_1", node: "route", stateJson: s2 });
    expect(e2.seq).toBe(2);
    expect(e2.prevHash).toBe(e1.hash); // 链：改信封 1 的任何字节，信封 2 立刻对不上
  });

  test("verifyChain：诚实链通过", () => {
    const db = makeDb();
    const { runId } = chain(db);
    expect(() => loadRunState(db, runId)).not.toThrow();
  });

  test.each([
    ["落盘状态任意字节", "UPDATE checkpoints SET state = '{\"kind\":\"alert_flow\",\"alert_id\":\"tampered\"}' WHERE run_id = ? AND seq = 1"],
    ["信封 hash 列", "UPDATE checkpoints SET hash = 'sha256:deadbeef' WHERE run_id = ? AND seq = 2"],
    ["prev_hash 链环", "UPDATE checkpoints SET prev_hash = 'sha256:deadbeef' WHERE run_id = ? AND seq = 2"],
    ["node 名", "UPDATE checkpoints SET node = 'evil' WHERE run_id = ? AND seq = 1"],
    ["state_ref 引用", "UPDATE checkpoints SET state_ref = 'sha256:deadbeef' WHERE run_id = ? AND seq = 1"],
  ])("篡改%s → resume 必拒（TamperedCheckpointError）", (_label, sql) => {
    const db = makeDb();
    const { runId } = chain(db);
    db.prepare(sql).run(runId);
    expect(() => loadRunState(db, runId)).toThrow(TamperedCheckpointError);
  });

  test("抽掉一环（缺 seq=1）→ 链断裂必拒", () => {
    const db = makeDb();
    const { runId } = chain(db);
    db.prepare("DELETE FROM checkpoints WHERE run_id = ? AND seq = 1").run(runId);
    expect(() => loadRunState(db, runId)).toThrow(TamperedCheckpointError);
  });

  test("resume：诚实链返回末态；篡改后必拒且审计 FAILURE（PRD：拒绝恢复 + 审计 FAILURE）", () => {
    const db = makeDb();
    const { runId } = chain(db);
    const audit = new MemoryAuditSink();
    const ok = resumeRun(db, runId, { audit, requestId: "req-resume" });
    expect(ok.state).toMatchObject({ route: "end" });
    expect(audit.entries).toHaveLength(0); // 诚实读不产审计

    db.prepare("UPDATE checkpoints SET state = '{}' WHERE run_id = ? AND seq = 2").run(runId);
    expect(() => resumeRun(db, runId, { audit, requestId: "req-resume-2" })).toThrow(
      TamperedCheckpointError,
    );
    const failure = audit.entries[0];
    expect(failure).toMatchObject({
      action: "resume",
      objectId: runId,
      objectType: "run",
      result: "FAILURE",
      requestId: "req-resume-2",
    });
  });
});

describe("verifyChain 纯函数边界", () => {
  test("空链通过；错序 seq 必拒", () => {
    const s = JSON.stringify({ a: 1 });
    const e1: EnvelopeRow = {
      ...sealEnvelope(null, { runId: "r", node: "n", stateJson: s }),
      state: s,
    };
    expect(() => verifyChain([e1])).not.toThrow();
    const e2 = { ...sealEnvelope(e1, { runId: "r", node: "n2", stateJson: s }), state: s, seq: 5 };
    expect(() => verifyChain([e1, e2])).toThrow(TamperedCheckpointError);
  });
});
