import { describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import {
  InvalidRunTransitionError,
  RUN_STATES,
} from "./statemachine.js";
import {
  createRun,
  getRun,
  transitionRun,
  type RunRow,
} from "./runs.js";
import { NotFoundError } from "./errors.js";
import { executeRun, THIN_ALERT_FLOW } from "./graph.js";
import { MemoryAuditSink } from "./audit.js";
import { eventsAfter } from "./events.js";
import { loadRunState } from "./checkpointer.js";
import { budgetFromEnv } from "./budget.js";

function makeDb(): DB {
  return openDb(":memory:");
}

const CTX = { audit: new MemoryAuditSink(), requestId: "req-test" };

function makeRun(db: DB, over: Partial<{ kind: string; alertId: string }> = {}): RunRow {
  return createRun(db, { kind: "alert_flow", alertId: "al-5712", ...over }, CTX);
}

// ---------- run 状态机（CONTEXT.md 语义核心：queued→running→awaiting_approval→running→completed/failed）----------

describe("run 状态机迁移表全组合（INV-10）", () => {
  const LEGAL = new Set([
    "queued>running",
    "running>awaiting_approval",
    "awaiting_approval>running",
    "running>completed",
    "running>failed",
  ]);
  for (const from of RUN_STATES) {
    for (const to of RUN_STATES) {
      if (from === to) continue;
      const label = `${from} → ${to}`;
      if (LEGAL.has(`${from}>${to}`)) {
        test(`合法：${label}`, () => {
          expect(() => transitionOf(from, to)).not.toThrow();
        });
      } else {
        test(`非法：${label} → 409 InvalidRunTransition`, () => {
          expect(() => transitionOf(from, to)).toThrow(InvalidRunTransitionError);
        });
      }
    }
  }

  /** 把实体开到 from 再试转移 to：completed/failed 等终态用 transitionRun 直达，中间态逐站走。 */
  function transitionOf(from: string, to: string): void {
    const db = makeDb();
    const run = makeRun(db); // queued
    const path: Record<string, string[]> = {
      queued: [],
      running: ["running"],
      awaiting_approval: ["running", "awaiting_approval"],
      completed: ["running", "completed"],
      failed: ["running", "failed"],
    };
    let cur = run;
    for (const step of path[from] ?? []) {
      cur = transitionRun(db, run.id, step as RunRow["status"], CTX);
    }
    if (cur.status !== from) throw new Error(`test bug: 开不到 ${from}`);
    transitionRun(db, run.id, to as RunRow["status"], CTX);
  }
});

// ---------- 薄径 run：无 worker 无人干预跑完（验收 5）----------

describe("executeRun 薄径（alert_flow 无 worker 直 END）", () => {
  test("queued→running→completed 无人干预跑完，SSE 事件与检查点齐备", async () => {
    const db = makeDb();
    const run = makeRun(db);

    const done = await executeRun(db, run.id, { requestId: "req-run" });

    expect(done.status).toBe("completed");
    expect(done.failReason).toBeNull();
    expect(done.steps).toBe(THIN_ALERT_FLOW.length);

    // 状态机走过的两步都有审计（INV-8），queued→running 与 running→completed
    const audit = new MemoryAuditSink();
    const db2 = makeDb();
    const run2 = makeRun(db2);
    await executeRun(db2, run2.id, { audit, requestId: "req-audit" });
    const statusAudits = audit.entries.filter((e) => e.objectType === "run");
    expect(statusAudits.map((e) => e.action)).toEqual(["update", "update"]);
    expect(statusAudits[0].details).toMatchObject({ status: { from: "queued", to: "running" } });
    expect(statusAudits[1].details).toMatchObject({ status: { from: "running", to: "completed" } });

    // SSE 事件：每个节点 node_enter/node_exit 成对，且 audit 事件镜像了状态变更
    const events = eventsAfter(db2, run2.id, 0);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("audit"); // run_started 的审计镜像
    expect(types.filter((t) => t === "node_enter")).toHaveLength(2);
    expect(types.filter((t) => t === "node_exit")).toHaveLength(2);
    expect(types.at(-1)).toBe("audit"); // run_completed 的审计镜像
    expect(types).not.toContain("error");

    // 检查点：每个节点一个信封，链可验证，末态带着交接上下文（alert_id）
    const { state, envelopes } = loadRunState(db2, run2.id);
    expect(envelopes).toHaveLength(2);
    expect(state).toMatchObject({ kind: "alert_flow", alert_id: "al-5712", route: "end" });
  });

  test("不存在的 run → NotFoundError", async () => {
    const db = makeDb();
    await expect(executeRun(db, "run_nope", { requestId: "req-x" })).rejects.toThrow(NotFoundError);
  });

  test("资源兜底 token 超限：伪 LLM 节点充 50k+1 token → run 强杀 failed + 审计 FAILURE + error 事件", async () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = makeRun(db);
    // eval fixture 伪 LLM：一个充 50001 token 的节点（真 worker 里这是 LLM 回包计费点）
    const fatNode = {
      name: "triage",
      run: (ctx: { charge(t: number): void }) => ctx.charge(50_001),
    };
    const done = await executeRun(db, run.id, { nodes: [fatNode], audit, requestId: "req-budget" });

    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("budget_exceeded:token_budget");
    expect(done.tokensUsed).toBe(50_001);

    const kill = audit.entries.find((e) => e.result === "FAILURE");
    expect(kill).toBeDefined();
    expect(kill?.objectType).toBe("run");
    expect(kill?.details).toMatchObject({
      code: "budget_exceeded",
      kind: "token_budget",
      limit: 50_000,
      used: 50_001,
      status: { from: "running", to: "failed" },
    });
    const events = eventsAfter(db, run.id, 0);
    expect(events.at(-1)?.type).toBe("error");
    expect(events.at(-1)?.payload).toMatchObject({ code: "budget_exceeded", kind: "token_budget" });
  });

  test("资源兜底 max_steps 20：第 21 步强杀 failed + 审计", async () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = makeRun(db);
    const loop = Array.from({ length: 21 }, (_, i) => ({
      name: `step${i}`,
      run: () => {},
    }));
    const done = await executeRun(db, run.id, { nodes: loop, audit, requestId: "req-steps" });

    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("budget_exceeded:max_steps");
    expect(done.steps).toBe(20); // 只记成功走完的 20 步
    expect(audit.entries.some((e) => e.result === "FAILURE")).toBe(true);
  });

  test("资源兜底 LLM 超时 60s：伪 LLM 节点报 61s → 强杀 failed + 审计（per-node env 口子在 budget 单测锁）", async () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = makeRun(db);
    const slowLlmNode = {
      name: "triage",
      run: (ctx: { checkLlm(s: number, n: number): void }) => ctx.checkLlm(1_000, 61_001),
    };
    const done = await executeRun(db, run.id, { nodes: [slowLlmNode], audit, requestId: "req-llm" });

    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("budget_exceeded:llm_timeout");
    expect(audit.entries.some((e) => e.result === "FAILURE")).toBe(true);
  });

  test("节点自身抛错 → run failed + 审计 + error 事件（不吞错，PRD 异常与边界）", async () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = makeRun(db);
    const bad = {
      name: "intake",
      run: () => {
        throw new Error("boom");
      },
    };
    const done = await executeRun(db, run.id, { nodes: [bad], audit, requestId: "req-err" });
    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("node_error:intake");
    const events = eventsAfter(db, run.id, 0);
    expect(events.at(-1)?.type).toBe("error");
  });

  test("budgetFromEnv 是生产默认（env 口子真实生效）：MAX_STEPS=1 时第 2 步强杀", async () => {
    const env = { MAX_STEPS: "1", MAX_TOKENS_PER_RUN: "100", LLM_TIMEOUT_MS: "1000" };
    const db = makeDb();
    const run = makeRun(db);
    const done = await executeRun(db, run.id, {
      nodes: [
        { name: "a", run: () => {} },
        { name: "b", run: () => {} },
      ],
      budget: budgetFromEnv(env),
      requestId: "req-env",
    });
    expect(done.status).toBe("failed");
    expect(done.failReason).toBe("budget_exceeded:max_steps");
  });
});

// ---------- runs 存取（run 实体落点：m3 卡，agent 自持 SQLite）----------

describe("runs 存取", () => {
  test("createRun 落 queued，getRun 读回 camelCase 行", () => {
    const db = makeDb();
    const run = makeRun(db, { kind: "alert_flow", alertId: "al-1" });
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("queued");
    expect(getRun(db, run.id)).toMatchObject({
      id: run.id,
      kind: "alert_flow",
      alertId: "al-1",
      status: "queued",
      failReason: null,
    });
    expect(getRun(db, "run_nope")).toBeNull();
  });

  test("transitionRun 落库 + 审计（INV-8：状态变更有五要素审计）", () => {
    const db = makeDb();
    const audit = new MemoryAuditSink();
    const run = makeRun(db);
    const after = transitionRun(db, run.id, "running", {
      audit,
      requestId: "req-t",
      actor: { type: "system", id: "m3:supervisor" },
    });
    expect(after.status).toBe("running");
    expect(after.updatedAt).toBeGreaterThanOrEqual(after.createdAt);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: "update",
      actor: { type: "system", id: "m3:supervisor" },
      objectId: run.id,
      objectType: "run",
      requestId: "req-t",
      result: "SUCCESS",
      details: { status: { from: "queued", to: "running" } },
    });
  });
});
