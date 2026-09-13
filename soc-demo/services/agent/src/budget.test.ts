import { afterAll, describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { createRun, getRun, type RunRow } from "./runs.js";
import { RunBudget, RoundBudget, budgetFromEnv, budgetForKind, assertRoundsBudget, BudgetExceededError } from "./budget.js";
import { executeRun } from "./graph.js";
import { eventsAfter, setEventTap } from "./events.js";
import { MemoryHuntLedger } from "./orchestration/ledger.js";
import { makeLoopEventBus } from "./orchestration/bus.js";
import { makeLoopCancel } from "./orchestration/cancel.js";
import { makeFakeLoopLlm } from "./orchestration/llm-stubs.js";
import { MemoryHypothesisRegister } from "./orchestration/register.js";
import { DefaultTemplateSource } from "./orchestration/template.js";
import { makeHuntFlow, type OrchestrationDeps } from "./orchestration/flow.js";
import { makeHuntTaskFlow } from "./orchestration/task-flow.js";
import type { HypothesisDetail, HypothesisPort, RoundRecord, ScanSeam } from "./orchestration/ports.js";

// 资源兜底口径（m3 卡·决策 #4/#5/#12）：LLM 超时统一 60s（per-node env 口子）、
// max_steps 20、token 50k/run。超限 = BudgetExceededError，强杀与审计在 runner 层测。
describe("资源兜底计数（budget）", () => {
  test("默认口径：max_steps 20 / token 50k / LLM 60s", () => {
    const b = new RunBudget();
    expect(b.maxSteps).toBe(20);
    expect(b.maxTokensPerRun).toBe(50_000);
    expect(b.llmTimeoutMs("triage")).toBe(60_000);
  });

  test("max_steps：前 20 步放行，第 21 步抛 max_steps 超限", () => {
    const b = new RunBudget();
    for (let i = 0; i < 20; i++) expect(() => b.step()).not.toThrow();
    let err: BudgetExceededError | undefined;
    try {
      b.step();
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("max_steps");
    expect(err?.limit).toBe(20);
    expect(err?.used).toBe(20); // 已走满 20 步，第 21 步被拒
  });

  test("token 50k/run：累计不超放行，超 1 token 即抛（Tracecat 口径：限次数挡不住推理死循环，按 token 限）", () => {
    const b = new RunBudget();
    b.charge(49_999);
    expect(b.tokens).toBe(49_999);
    let err: BudgetExceededError | undefined;
    try {
      b.charge(2); // 50_001 > 50_000
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("token_budget");
    expect(err?.limit).toBe(50_000);
    expect(err?.used).toBe(50_001);
  });

  test("LLM 超时 60s（决策 #4）：59_999ms 放行，60_001ms 抛 llm_timeout", () => {
    const b = new RunBudget();
    const t0 = 1_000;
    expect(() => b.checkLlm("triage", t0, t0 + 59_999)).not.toThrow();
    let err: BudgetExceededError | undefined;
    try {
      b.checkLlm("triage", t0, t0 + 60_001);
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("llm_timeout");
    expect(err?.used).toBe(60_001);
    expect(err?.limit).toBe(60_000);
  });

  test("env 口子：MAX_STEPS / MAX_TOKENS_PER_RUN / LLM_TIMEOUT_MS 全局覆盖", () => {
    const b = budgetFromEnv({ MAX_STEPS: "3", MAX_TOKENS_PER_RUN: "100", LLM_TIMEOUT_MS: "5000" });
    expect(b.maxSteps).toBe(3);
    expect(b.maxTokensPerRun).toBe(100);
    expect(b.llmTimeoutMs("triage")).toBe(5000);
    let err: BudgetExceededError | undefined;
    try {
      b.charge(101);
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("token_budget");
  });

  test("per-node env 口子：LLM_TIMEOUT_MS_<NODE 大写> 盖过全局（m3 卡：留 per-node env 口子）", () => {
    const b = budgetFromEnv({ LLM_TIMEOUT_MS: "60000", LLM_TIMEOUT_MS_TRIAGE: "1000" });
    expect(b.llmTimeoutMs("triage")).toBe(1000);
    expect(b.llmTimeoutMs("investigation")).toBe(60_000);
  });
});

// ---------- 票 77 预算档位（spec orchestration-loop.md「预算档位」节） ----------

describe("预算档位（票 77：按 kind 分档，旧 kind 零回归）", () => {
  test("旧 kind（alert_flow 等一律同）读默认档：60s/20 步/50k，无轮档——行为零变化", () => {
    for (const kind of ["alert_flow", "knowledge_flow", "chat_flow", "case_flow", "close_flow", "hunt_task"]) {
      const b = budgetForKind(kind);
      expect(b.round).toBeNull();
      expect(b.run.maxSteps).toBe(20);
      expect(b.run.maxTokensPerRun).toBe(50_000);
      expect(b.run.llmTimeoutMs("any")).toBe(60_000);
    }
  });

  test("hunt_flow 档：run 级 900s/200 步/500k；轮级 120s/10 步/30k", () => {
    const b = budgetForKind("hunt_flow");
    expect(b.run.maxSteps).toBe(200);
    expect(b.run.maxTokensPerRun).toBe(500_000);
    expect(b.run.llmTimeoutMs("planner")).toBe(900_000);
    expect(b.round).not.toBeNull();
    expect(b.round!.maxSteps).toBe(10);
    expect(b.round!.maxTokensPerRun).toBe(30_000);
    expect(b.round!.llmTimeoutMs("round")).toBe(120_000);
  });

  test("档位 env 可覆写：<KIND>_MAX_STEPS / _MAX_TOKENS_PER_RUN / _LLM_TIMEOUT_MS，轮级加 _ROUND 段", () => {
    const b = budgetForKind("hunt_flow", {
      HUNT_FLOW_MAX_STEPS: "100",
      HUNT_FLOW_MAX_TOKENS_PER_RUN: "400000",
      HUNT_FLOW_ROUND_MAX_STEPS: "3",
      HUNT_FLOW_ROUND_MAX_TOKENS_PER_RUN: "1000",
      HUNT_FLOW_ROUND_LLM_TIMEOUT_MS: "5000",
    });
    expect(b.run.maxSteps).toBe(100);
    expect(b.run.maxTokensPerRun).toBe(400_000);
    expect(b.run.llmTimeoutMs("planner")).toBe(900_000); // 未覆写的格子保持档位缺省
    expect(b.round!.maxSteps).toBe(3);
    expect(b.round!.maxTokensPerRun).toBe(1000);
    expect(b.round!.llmTimeoutMs("round")).toBe(5000);
  });

  test("轮级闸各自触发：轮步/轮 token/轮时抛 round_* kind（与 run 级 kind 可区分）", () => {
    const r = new RoundBudget({ maxSteps: 2, maxTokensPerRun: 10, llmTimeoutMs: 1000 });
    r.step();
    r.step();
    let err: BudgetExceededError | undefined;
    try { r.step(); } catch (e) { err = e as BudgetExceededError; }
    expect(err?.kind).toBe("round_max_steps");
    expect(err?.limit).toBe(2);
    expect(err?.used).toBe(2);

    const r2 = new RoundBudget({ maxSteps: 50, maxTokensPerRun: 10, llmTimeoutMs: 1000 });
    let err2: BudgetExceededError | undefined;
    try { r2.charge(11); } catch (e) { err2 = e as BudgetExceededError; }
    expect(err2?.kind).toBe("round_token_budget");
    expect(err2?.used).toBe(11); // 超额也先记账（与 RunBudget.charge 同序）

    const r3 = new RoundBudget({ maxSteps: 50, maxTokensPerRun: 10_000, llmTimeoutMs: 1000 });
    let err3: BudgetExceededError | undefined;
    try { r3.checkLlm("round", 1_000, 2_001); } catch (e) { err3 = e as BudgetExceededError; }
    expect(err3?.kind).toBe("round_timeout");
    expect(err3?.used).toBe(1_001);
  });

  test("max_rounds 硬顶：第 max_rounds+1 轮在开跑前被拒（kind=rounds），顶内轮次放行", () => {
    expect(() => assertRoundsBudget(20, 20)).not.toThrow();
    let err: BudgetExceededError | undefined;
    try { assertRoundsBudget(21, 20); } catch (e) { err = e as BudgetExceededError; }
    expect(err?.kind).toBe("rounds");
    expect(err?.limit).toBe(20);
    expect(err?.used).toBe(21);
  });
});

// ---------- 票 77 T18：预算双闸四触发（轮步/轮 token/轮时/run 总 token） ----------
// 布景纪律与 flow.test.ts 同款：:memory: 库 + 记账假 port + 假 door + 取消机制（watcher）
// 在场——轮次 run 被 BudgetExceededError 强杀（graph.ts 既有口径，零改动）后，error 事件
// 经总线到达取消机制：假设 cancelled（原因 budget）+ 停止链（子 run failed(parent_cancelled)）。

const HYP = "hyp-t18";
const scanAllow: ScanSeam = async (text) => ({ blocked: false, action: "allow", text });

class FakeHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  transitions: string[] = [];
  rounds: RoundRecord[] = [];
  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: "t-default", text: "内网横向移动待验证", rounds: [...this.rounds] };
  }
  async startHunting(): Promise<void> {
    if (this.status !== "proposed") throw new Error("InvalidTransition:409");
    this.status = "hunting";
  }
  async transition(id: string, to: "concluded" | "refuted" | "cancelled", opts?: { reason?: string }): Promise<void> {
    this.transitions.push(`${to}:${opts?.reason ?? ""}`);
    this.status = to;
  }
  async recordRound(_id: string, round: RoundRecord): Promise<void> {
    this.rounds = this.rounds.filter((r) => r.round_no !== round.round_no);
    this.rounds.push(round);
  }
}

interface BudgetRig {
  db: DB;
  audit: MemoryAuditSink;
  port: FakeHypothesisPort;
  orch: OrchestrationDeps;
  cancel: ReturnType<typeof makeLoopCancel>;
  runRound(opts?: { runBudget?: RunBudget }): Promise<RunRow>;
  pump(): Promise<void>;
}

function budgetRig(overrides: { roundBudget?: OrchestrationDeps["roundBudget"]; now?: OrchestrationDeps["now"] } = {}): BudgetRig {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const bus = makeLoopEventBus();
  const ledger = new MemoryHuntLedger();
  const port = new FakeHypothesisPort();
  const door = {
    post: async (payload: { kind: string; hypothesis_id?: string }): Promise<string> =>
      createRun(db, { kind: payload.kind, hypothesisId: payload.hypothesis_id ?? null }, { audit, requestId: "rig-door" }).id,
  };
  const orch: OrchestrationDeps = {
    port,
    ledger,
    bus,
    door,
    templates: new DefaultTemplateSource(),
    llm: makeFakeLoopLlm(),
    scan: scanAllow,
    register: (call) => new MemoryHypothesisRegister().register(call),
    ...overrides,
  };
  const cancel = makeLoopCancel({ bus, ledger, port, audit, log: () => {} });
  orch.cancel = cancel;
  setEventTap((e) => bus.publish(e));
  const nodesFor = (runId: string) => {
    const link = ledger.get(runId);
    return link?.role === "task" ? makeHuntTaskFlow({ runId, orch, audit }) : makeHuntFlow({ runId, orch, audit });
  };
  const executing = new Set<string>();
  const tryExecute = (runId: string, runBudget?: RunBudget): void => {
    if (executing.has(runId)) return;
    const row = getRun(db, runId);
    if (!row || row.status !== "queued") return;
    executing.add(runId);
    void executeRun(db, runId, { nodes: nodesFor(runId), audit, requestId: "req-rig", ...(runBudget ? { budget: runBudget } : {}) })
      .catch(() => {})
      .finally(() => executing.delete(runId));
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    db, audit, port, orch, cancel,
    async runRound(opts = {}) {
      const parent = createRun(db, { kind: "hunt_flow", hypothesisId: HYP }, { audit, requestId: "req-t18" });
      ledger.put({ runId: parent.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });
      await executeRun(db, parent.id, {
        nodes: makeHuntFlow({ runId: parent.id, orch, audit }),
        audit,
        requestId: "req-t18",
        ...(opts.runBudget ? { budget: opts.runBudget } : {}),
      });
      await tick();
      return getRun(db, parent.id)!;
    },
    async pump() {
      for (let i = 0; i < 400; i++) {
        const pending = ledger.all().filter((l) => {
          const r = getRun(db, l.runId);
          return (!!r && r.status === "queued") || executing.has(l.runId);
        });
        if (pending.length === 0) return;
        for (const l of ledger.all()) tryExecute(l.runId);
        await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
}

/** T18 共用断言：轮次 run 被预算强杀（既有口径）+ 假设 cancelled(budget)（不冒充 refuted）。 */
function assertBudgetKill(rig: BudgetRig, roundRunId: string, kind: string): void {
  const row = getRun(rig.db, roundRunId);
  expect(row?.status).toBe("failed");
  expect(row?.failReason).toBe(`budget_exceeded:${kind}`);
  // 审计（INV-8）：kill FAILURE 条目可回放
  const kill = rig.audit.entries.find((e) => e.action === "kill" && e.objectId === roundRunId);
  expect(kill?.result).toBe("FAILURE");
  expect((kill?.details as { kind?: string }).kind).toBe(kind);
  // SSE error 事件（Web 可见同款）
  const errEvt = eventsAfter(rig.db, roundRunId, 0).find((e) => e.type === "error");
  expect((errEvt?.payload as { code?: string; kind?: string }).code).toBe("budget_exceeded");
  expect((errEvt?.payload as { kind?: string }).kind).toBe(kind);
  // 假设侧：cancelled（原因 budget），不冒充 refuted/concluded
  expect(rig.port.status).toBe("cancelled");
  expect(rig.port.transitions).toEqual(["cancelled:budget"]);
}

afterAll(() => setEventTap(null));

describe("T18 dual_gate_triggers（预算双闸四触发 → cancelled + 审计 + SSE）", () => {
  test("① 轮步：轮级 max_steps 顶到 → round_max_steps 强杀轮次 run", async () => {
    const rig = budgetRig({ roundBudget: () => new RoundBudget({ maxSteps: 3, maxTokensPerRun: 1_000_000, llmTimeoutMs: 3_600_000 }) });
    const done = await rig.runRound(); // intake(1) planner(2) dispatch(3) → await_children 入场即超
    expect(done.status).toBe("failed");
    assertBudgetKill(rig, done.id, "round_max_steps");
  });

  test("①b 轮步触发的停止链：子 run failed(parent_cancelled)，未起的不干活", async () => {
    const rig = budgetRig({ roundBudget: () => new RoundBudget({ maxSteps: 3, maxTokensPerRun: 1_000_000, llmTimeoutMs: 3_600_000 }) });
    const done = await rig.runRound();
    assertBudgetKill(rig, done.id, "round_max_steps");
    await rig.pump(); // 已 dispatch 未起跑的子 run：起了也在首个节点边界被取消检查掐停
    const childKills = rig.audit.entries.filter((e) => e.action === "kill" && e.objectId !== done.id);
    expect(childKills.length).toBeGreaterThan(0);
    for (const k of childKills) {
      expect(k.result).toBe("FAILURE");
      expect((k.details as { kind?: string }).kind).toBe("parent_cancelled");
      const childEvents = eventsAfter(rig.db, k.objectId, 0);
      expect(childEvents.some((e) => e.type === "tool_call")).toBe(false); // 未干的活不干
    }
  });

  test("② 轮 token：轮级 30k 内的小档 → round_token_budget 强杀（planner 计费点）", async () => {
    const rig = budgetRig({ roundBudget: () => new RoundBudget({ maxSteps: 50, maxTokensPerRun: 10, llmTimeoutMs: 3_600_000 }) });
    const done = await rig.runRound();
    assertBudgetKill(rig, done.id, "round_token_budget");
    expect(rig.port.rounds).toHaveLength(0); // 死在 planner，无轮归集、无子 run
  });

  test("③ 轮时：注入钟推进超轮级墙钟 → round_timeout 强杀（节点入场检查）", async () => {
    let t = 0;
    const rig = budgetRig({
      now: () => (t += 2000), // 每次读钟 +2s：首轮节点入场 elapsed 2000ms > 1000ms 档
      roundBudget: () => new RoundBudget({ maxSteps: 50, maxTokensPerRun: 1_000_000, llmTimeoutMs: 1000 }),
    });
    const done = await rig.runRound();
    assertBudgetKill(rig, done.id, "round_timeout");
  });

  test("④ run 总 token：run 级 500k 档的小档覆写 → 既有 token_budget 强杀（run 级闸语义不变）", async () => {
    const rig = budgetRig();
    const done = await rig.runRound({ runBudget: new RunBudget({ maxSteps: 100, maxTokensPerRun: 10 }) });
    assertBudgetKill(rig, done.id, "token_budget");
  });
});
