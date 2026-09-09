// 票 47：run 异步化（ADR 0004-1）——分发循环（run-dispatcher）的领域测试 + 与
// buildApp 的接线集成测试。同步时代「POST 返回时已终态」的时序契约在本票有意翻转：
// POST /internal/runs 落 queued 即秒回，执行由后台消费循环接管（autorun 同款形态）。
// 领域规则在本文件锁；既有端到端契约的时序改写落在各自测试文件（票内逐条列表）。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { createRun, transitionRun, type RunCtx } from "./runs.js";
import { openApprovalCard } from "./approvals.js";
import { eventsAfter } from "./events.js";
import {
  approvalTtlSecondsFromEnv,
  claimRunJobs,
  completeRunJob,
  dispatchOnce,
  enqueueRunJob,
  recoverDispatcherState,
  runDispatchConcurrency,
  startRunDispatcher,
} from "./run-dispatcher.js";
import { waitForRunTerminal } from "./testkit.js";

function makeDb(): DB {
  return openDb(":memory:");
}

const CTX = (audit = new MemoryAuditSink()): RunCtx => ({
  audit,
  requestId: "req-dispatch",
  actor: { type: "system", id: "m3:dispatcher" },
});

// ---------- env 解析：并发上限与审批卡保质期（fail-closed 缺省） ----------

describe("env 解析（RUN_DISPATCH / APPROVAL_TTL_SECONDS）", () => {
  test("RUN_DISPATCH：缺省 1；正整数透传；0/负数/非数字一律回 1（并发上限不猜）", () => {
    expect(runDispatchConcurrency({})).toBe(1);
    expect(runDispatchConcurrency({ RUN_DISPATCH: "3" })).toBe(3);
    expect(runDispatchConcurrency({ RUN_DISPATCH: "0" })).toBe(1);
    expect(runDispatchConcurrency({ RUN_DISPATCH: "-2" })).toBe(1);
    expect(runDispatchConcurrency({ RUN_DISPATCH: "abc" })).toBe(1);
  });

  test("APPROVAL_TTL_SECONDS：缺省 86400；可覆盖；非数字回缺省", () => {
    expect(approvalTtlSecondsFromEnv({})).toBe(86400);
    expect(approvalTtlSecondsFromEnv({ APPROVAL_TTL_SECONDS: "3600" })).toBe(3600);
    expect(approvalTtlSecondsFromEnv({ APPROVAL_TTL_SECONDS: "oops" })).toBe(86400);
  });
});

// ---------- 队列原语：入队 / 领取 / 完结（队列 = SQLite 表 + 消费循环，ADR 0004-1） ----------

describe("run_jobs 队列原语", () => {
  test("入队 start/resume；claim FIFO 领取后转 claimed；完结转 done", () => {
    const db = makeDb();
    const runA = createRun(db, { kind: "alert_flow", alertId: "al-1" }, CTX());
    const runB = createRun(db, { kind: "alert_flow", alertId: "al-2" }, CTX());
    const jobA = enqueueRunJob(db, runA.id, "start");
    const jobB = enqueueRunJob(db, runB.id, "start");

    const claimed = claimRunJobs(db, 1);
    expect(claimed.map((j) => j.id)).toEqual([jobA.id]); // FIFO：先入先领
    expect(claimed[0]).toMatchObject({ runId: runA.id, action: "start", state: "claimed" });

    // 再领领不到已 claimed 的（防双吃），limit 内拿剩下的
    expect(claimRunJobs(db, 10).map((j) => j.id)).toEqual([jobB.id]);
    expect(claimRunJobs(db, 10)).toEqual([]);

    completeRunJob(db, jobA.id);
    const row = db.prepare("SELECT state FROM run_jobs WHERE id = ?").get(jobA.id) as { state: string };
    expect(row.state).toBe("done");
  });

  test("resume 去重：同一 run 已有未完结的 resume 任务 → 复用不重发（陈旧双批不叠加）", () => {
    const db = makeDb();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-1" }, CTX());
    const first = enqueueRunJob(db, run.id, "resume");
    const again = enqueueRunJob(db, run.id, "resume");
    expect(again.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_jobs").get() as { n: number }).toMatchObject({ n: 1 });

    // 完结之后允许再次入队（下一次决定是新的续跑诉求）
    completeRunJob(db, first.id);
    const next = enqueueRunJob(db, run.id, "resume");
    expect(next.id).not.toBe(first.id);
  });

  test("start 不去重：每个 run 恰有一个 start 任务，重复入队是调用方的错但不静默吞", () => {
    const db = makeDb();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-1" }, CTX());
    enqueueRunJob(db, run.id, "start");
    enqueueRunJob(db, run.id, "start");
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_jobs").get() as { n: number }).toMatchObject({ n: 2 });
  });
});

// ---------- dispatchOnce：扫过期卡 → 领任务 → 执行（并发上限内） ----------

describe("dispatchOnce", () => {
  const executed: { runId: string; action: string }[] = [];

  function makeDeps(
    db: DB,
    over: {
      execute?: (job: { runId: string; action: string }) => Promise<void>;
      concurrency?: number;
      approvalTtlSeconds?: number;
    } = {},
  ) {
    return {
      db,
      audit: new MemoryAuditSink(),
      execute: over.execute ?? (async (job: { runId: string; action: string }) => {
        executed.push({ runId: job.runId, action: job.action });
      }),
      concurrency: over.concurrency ?? 1,
      approvalTtlSeconds: over.approvalTtlSeconds,
    };
  }

  test("领取 pending 任务执行并完结；并发上限 = 每轮最多领几个，剩余留待下轮", async () => {
    const db = makeDb();
    const runs = ["a", "b", "c"].map((s) => createRun(db, { kind: "alert_flow", alertId: s }, CTX()));
    for (const r of runs) enqueueRunJob(db, r.id, "start");

    const tick1 = await dispatchOnce(makeDeps(db, { concurrency: 2 }));
    expect(tick1.executed).toHaveLength(2);
    expect(tick1.executed.map((j) => j.action)).toEqual(["start", "start"]);
    // 只动自己那批：第三个任务仍 pending（不动它，留给下一轮）
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_jobs WHERE state = 'pending'").get())
      .toMatchObject({ n: 1 });

    const tick2 = await dispatchOnce(makeDeps(db, { concurrency: 2 }));
    expect(tick2.executed).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_jobs WHERE state != 'done'").get()).toMatchObject({ n: 0 });
  });

  test("执行抛错：任务完结不重试（毒丸不崩循环），错误进返回值与日志面", async () => {
    const db = makeDb();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-x" }, CTX());
    enqueueRunJob(db, run.id, "start");
    const tick = await dispatchOnce(makeDeps(db, {
      execute: async () => { throw new Error("boom"); },
    }));
    expect(tick.failed).toHaveLength(1);
    expect(tick.failed[0]?.error).toContain("boom");
    expect(db.prepare("SELECT state FROM run_jobs").get() as { state: string }).toMatchObject({ state: "done" });
  });
});

// ---------- 审批卡保质期：TTL 到期 pending → expired → run failed（ADR 0004-1） ----------

describe("审批卡保质期（APPROVAL_TTL_SECONDS）", () => {
  function suspendedRun(db: DB): { runId: string; cardId: string } {
    const audit = new MemoryAuditSink();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-ttl" }, CTX(audit));
    transitionRun(db, run.id, "running", CTX(audit));
    const card = openApprovalCard(db, {
      runId: run.id,
      node: "execute_action",
      tool: "isolate_host",
      params: { host: "centos7" },
      reason: "调查报告建议遏制",
    }, CTX(audit));
    return { runId: run.id, cardId: card.id };
  }

  test("TTL 到期的 pending 卡自动作废：卡 expired + run failed(approval_expired) + 审计 + 广播", async () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const { runId, cardId } = suspendedRun(db);
    // 把卡的 created_at 拨回 TTL 之前（不真等）
    db.prepare("UPDATE approvals SET created_at = created_at - ? WHERE id = ?").run(60_000, cardId);

    const tick = await dispatchOnce(makeSimpleDeps(db, audit, { approvalTtlSeconds: 30 }));
    expect(tick.expired).toEqual([cardId]);
    expect(db.prepare("SELECT status FROM approvals WHERE id = ?").get(cardId)).toMatchObject({ status: "expired" });
    expect(db.prepare("SELECT status, fail_reason FROM runs WHERE id = ?").get(runId))
      .toMatchObject({ status: "failed", fail_reason: "approval_expired" });

    // INV-8：作废有审计；SSE 有 approval_decided 广播（Web 审批页可见）
    const expire = audit.entries.find((e) => e.objectType === "approval" && e.action === "expire");
    expect(expire).toMatchObject({ objectId: cardId, result: "SUCCESS" });
    const ev = eventsAfter(db, runId, 0).find((e) => e.type === "approval_decided");
    expect(ev?.payload).toMatchObject({ approval_id: cardId, decision: "expired" });
  });

  test("未到期的 pending 卡不动（未过期链路行为不变）", async () => {
    const db = makeDb();
    const { cardId } = suspendedRun(db);
    const tick = await dispatchOnce(makeSimpleDeps(db, new MemoryAuditSink(), { approvalTtlSeconds: 3600 }));
    expect(tick.expired).toEqual([]);
    expect(db.prepare("SELECT status FROM approvals WHERE id = ?").get(cardId)).toMatchObject({ status: "pending" });
  });
});

// 简装 deps（只带 TTL 扫描要用的件；execute 永不被调——上面用例没有入队任务）
function makeSimpleDeps(
  db: DB,
  audit: MemoryAuditSink,
  over: { approvalTtlSeconds?: number } = {},
) {
  return {
    db,
    audit,
    execute: async () => { throw new Error("not expected"); },
    concurrency: 1,
    approvalTtlSeconds: over.approvalTtlSeconds,
  };
}

// ---------- 重启恢复：孤儿 running 与 claimed 任务的口径（记票定夺） ----------

describe("recoverDispatcherState（启动恢复）", () => {
  test("孤儿 running（进程被杀）→ failed(orphaned_by_restart) + 审计 + error 事件", () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-1" }, CTX(audit));
    transitionRun(db, run.id, "running", CTX(audit));

    const rec = recoverDispatcherState(db, CTX(audit));
    expect(rec.failed).toEqual([run.id]);
    expect(db.prepare("SELECT status, fail_reason FROM runs WHERE id = ?").get(run.id))
      .toMatchObject({ status: "failed", fail_reason: "orphaned_by_restart" });
    expect(audit.entries.some((e) => e.result === "FAILURE" && e.objectId === run.id)).toBe(true);
    expect(eventsAfter(db, run.id, 0).some((e) => e.type === "error")).toBe(true);
  });

  test("claimed 任务回 pending（重启后没人拿着）；孤儿 run 的 start 任务随 run 终结作废", () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const runA = createRun(db, { kind: "alert_flow", alertId: "al-a" }, CTX(audit));
    const jobA = enqueueRunJob(db, runA.id, "start");
    // runA 被上个进程拉起后正在跑、任务还挂在 claimed——双双按孤儿处理
    transitionRun(db, runA.id, "running", CTX(audit));
    db.prepare("UPDATE run_jobs SET state = 'claimed', claimed_at = ? WHERE id = ?").run(Date.now(), jobA.id);

    const rec = recoverDispatcherState(db, CTX(audit));
    expect(rec.failed).toEqual([runA.id]);
    // start 任务：run 已 failed → 直接完结，不再执行（重跑会从头重放节点）
    expect(db.prepare("SELECT state FROM run_jobs WHERE id = ?").get(jobA.id)).toMatchObject({ state: "done" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_jobs WHERE state='pending'").get()).toMatchObject({ n: 0 });
  });

  test("挂起等审批的 run 与它的 resume 任务：恢复后原样待领（queued 不丢、决定不丢）", () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = createRun(db, { kind: "alert_flow", alertId: "al-r" }, CTX(audit));
    transitionRun(db, run.id, "running", CTX(audit));
    transitionRun(db, run.id, "awaiting_approval", CTX(audit));
    const job = enqueueRunJob(db, run.id, "resume");
    db.prepare("UPDATE run_jobs SET state = 'claimed', claimed_at = ? WHERE id = ?").run(Date.now(), job.id);

    const rec = recoverDispatcherState(db, CTX(audit));
    expect(rec.failed).toEqual([]);
    const row = db.prepare("SELECT state FROM run_jobs WHERE id = ?").get(job.id) as { state: string };
    expect(row.state).toBe("pending"); // 回队，下轮被新进程领走
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(run.id)).toMatchObject({ status: "awaiting_approval" });
  });
});

// ---------- 常驻循环：stop 优雅停机（在跑的任务跑完再收手） ----------

describe("startRunDispatcher", () => {
  test("循环按 interval 消费；stop 后不再领新任务，且等在跑任务跑完", async () => {
    const db = makeDb();
    const runs = ["a", "b"].map((s) => createRun(db, { kind: "alert_flow", alertId: s }, CTX()));
    for (const r of runs) enqueueRunJob(db, r.id, "start");

    let inflight = 0;
    let sawInflight = false;
    const loop = startRunDispatcher({
      db,
      audit: new MemoryAuditSink(),
      execute: async (job) => {
        inflight += 1;
        await new Promise((r) => setTimeout(r, 30));
        sawInflight = inflight > 0;
        inflight -= 1;
        void job;
      },
      concurrency: 1,
    }, { intervalMs: 5 });

    await new Promise((r) => setTimeout(r, 10));
    await loop.stop(); // 优雅：等在跑任务落定
    expect(sawInflight).toBe(true);
    expect(inflight).toBe(0);
    // stop 只保证不再启动新的：已领取/完结的任务如实落库
    const states = db.prepare("SELECT state, COUNT(*) AS n FROM run_jobs GROUP BY state").all();
    expect(states.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});

// ---------- buildApp 接线：POST 秒回 queued + 消费循环执行 + SSE 真流 ----------

describe("异步化端到端（buildApp × dispatcher）", () => {
  function makeAsyncApp(over: { dispatcher?: false | { intervalMs?: number } } = {}) {
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const app = buildApp({
      db,
      audit,
      dispatcher: over.dispatcher ?? { intervalMs: 5 },
    });
    return { db, audit, app };
  }

  test("POST /internal/runs 落 queued 即 202 {run_id, status:queued}；随后消费循环跑到 completed", async () => {
    const { db, app } = makeAsyncApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "alert_flow", alert_id: "al-5712" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ run_id: expect.stringMatching(/^run_/), status: "queued" });

    const done = await waitForRunTerminal(db, res.json().run_id as string);
    expect(done.status).toBe("completed");
    await app.close();
  });

  test("dispatcher 关掉：run 停在 queued（队列真在跑，不是 POST 里偷跑）", async () => {
    const { db, app } = makeAsyncApp({ dispatcher: false });
    const res = await app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "alert_flow", alert_id: "al-5712" },
    });
    expect(res.statusCode).toBe(202);
    await new Promise((r) => setTimeout(r, 40)); // 给「万一偷跑」留窗口
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(res.json().run_id))
      .toMatchObject({ status: "queued" });
    await app.close();
  });

  test("SSE 订阅看到 queued→running→completed 真流，终态收流（INV-7 同一条落盘总线）", async () => {
    const { app } = makeAsyncApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "alert_flow", alert_id: "al-5712" },
    });
    const runId = res.json().run_id as string;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const sse = await fetch(`http://127.0.0.1:${port}/api/v1/events/stream?run_id=${runId}`);
    expect(sse.status).toBe(200);
    const text = await sse.text(); // 终态才收流 → fetch 能读完整
    const frames = text.split("\n\n").filter((b) => b.trim());
    const parsed = frames.map((f) => {
      const data = JSON.parse(f.split("\n").find((l) => l.startsWith("data:"))!.slice(6)) as {
        type: string; status?: { from?: string; to?: string };
      };
      return { type: data.type, status: data.status };
    });

    // 真流 = 状态迁移镜像（audit 事件带 status {from,to}）+ 节点帧，全程可回放
    const statusMoves = parsed.filter((p) => p.type === "audit" && p.status).map((p) => p.status);
    expect(statusMoves).toContainEqual({ from: "queued", to: "running" });
    expect(statusMoves).toContainEqual({ from: "running", to: "completed" });
    expect(parsed.some((p) => p.type === "node_enter")).toBe(true);
    // wire 形态：id 自增 + event 名（INV-7）
    const ids = frames.map((f) => Number(f.split("\n").find((l) => l.startsWith("id:"))!.slice(4)));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    await app.close();
  }, 15_000);

  test("进程重启后续跑：app1（dispatcher 关）入队后「被杀」，app2 同库接手把 queued 跑完", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-dispatch-"));
    const dbPath = join(dir, "agent.sqlite");
    const app1 = buildApp({ db: openDb(dbPath), audit: new MemoryAuditSink(), dispatcher: false });
    const res = await app1.inject({
      method: "POST",
      url: "/internal/runs",
      payload: { kind: "alert_flow", alert_id: "al-5712" },
    });
    const runId = res.json().run_id as string;
    await app1.close(); // 进程消失：run queued、任务 pending，全在盘上

    const db2 = openDb(dbPath);
    const app2 = buildApp({ db: db2, audit: new MemoryAuditSink(), dispatcher: { intervalMs: 5 } });
    const done = await waitForRunTerminal(db2, runId);
    expect(done.status).toBe("completed"); // queued 不丢：新进程的消费循环接手跑完
    await app2.close();
  }, 15_000);
});
