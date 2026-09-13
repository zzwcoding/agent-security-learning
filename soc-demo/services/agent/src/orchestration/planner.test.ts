// 票 74 · spec T03/T04/T05：planner 输出契约（任务上限截断 / 菜单外 fail-closed /
// schema 降级重试）+ 行为约定 3 后半：连续两轮 planner 失败 → 假设 cancelled(planner_broken)。
//
// 布景纪律与 flow.test.ts 同款：:memory: 库 + MemoryAuditSink + 假 port/假 door + 脚本化
// planner（测试只吃 seam 形状，坏输出以类型谎言直接注入 LoopLlm seam——真 adapter 的
// 出网半边在 prompt-guard.test.ts）。relay 用真 startRoundRelay（生产 dispatcher 同形）。
import { afterAll, describe, expect, test } from "vitest";
import { openDb, type DB } from "../db.js";
import { MemoryAuditSink } from "../audit.js";
import { createRun, getRun, type RunRow } from "../runs.js";
import { executeRun } from "../graph.js";
import { setEventTap } from "../events.js";
import { MemoryHuntLedger } from "./ledger.js";
import { makeLoopEventBus } from "./bus.js";
import { startRoundRelay } from "./relay.js";
import { FakeLoopGap, FakeLoopJudge } from "./llm-stubs.js";
import { MemoryHypothesisRegister } from "./register.js";
import { DefaultTemplateSource } from "./template.js";
import { makeHuntFlow, type OrchestrationDeps } from "./flow.js";
import { makeHuntTaskFlow } from "./task-flow.js";
import type { CaseCreateInput, CasePort, ScanSeam } from "./ports.js";
import type { HypothesisDetail, HypothesisPort, LoopLlm, PlannedTask, RoundRecord } from "./ports.js";

const HYP = "hyp-t74";

/** 组合积木：菜单内合法任务（schema 契约 {tool,params,rationale} 全带）。 */
const taskOf = (tool: string): PlannedTask => ({ tool, params: { q: "x" }, rationale: "机制档依据" });

/** guards 扫描假件：全放行（prompt-guard.test.ts 才咬扫描语义）。 */
const scanAllow: ScanSeam = async (text) => ({ blocked: false, action: "allow", text });

/** m2 案件实体假件（票 75 收敛分岔缝）：「仅一轮失败恢复」测试的轮 2 会走 hit 收敛——
 *  建案不出网（收敛细节断言在 judge.test.ts）。 */
class FakeCasePort implements CasePort {
  created: CaseCreateInput[] = [];
  private n = 0;
  async create(input: CaseCreateInput): Promise<string> {
    this.created.push({ ...input });
    return `case_${String(++this.n).padStart(6, "0")}`;
  }
  async addNote(): Promise<void> {}
}

/** 脚本化 planner：按序吐返回值；坏形输出以类型谎言注入 seam（真实 real adapter 会在
 *  adapter 内抛 bad_shape，节点对两条路同态——都走 schema 降级半边）。 */
function scriptedPlanner(script: unknown[], calls: unknown[]): LoopLlm {
  let i = 0;
  return {
    planner: async (input) => {
      calls.push(JSON.parse(JSON.stringify(input)));
      const cur = script[Math.min(i, script.length - 1)];
      i += 1;
      if (cur instanceof Error) throw cur;
      return { tasks: cur as PlannedTask[], tokens: 24 };
    },
    judge: (x) => new FakeLoopJudge().judge(x),
    gap: (x) => new FakeLoopGap().gap(x),
  };
}

/** m2 假设实体假件（flow.test 同款 + reason 捕获——planner_broken 的断言面）。 */
class FakeHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  calls: string[] = [];
  reasons: (string | null)[] = [];
  rounds: RoundRecord[] = [];

  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: "t-default", text: "机制档假设句（非业务内容）", rounds: [...this.rounds] };
  }
  async startHunting(id: string): Promise<void> {
    this.calls.push(`startHunting:${id}`);
    if (this.status !== "proposed") throw new Error("InvalidTransition:409");
    this.status = "hunting";
  }
  async transition(id: string, to: "concluded" | "refuted" | "cancelled", opts?: { reason?: string }): Promise<void> {
    this.calls.push(`transition:${id}:${to}`);
    this.reasons.push(opts?.reason ?? null);
    this.status = to;
  }
  async recordRound(id: string, round: RoundRecord): Promise<void> {
    this.calls.push(`recordRound:${id}:${round.round_no}`);
    this.rounds = this.rounds.filter((r) => r.round_no !== round.round_no);
    this.rounds.push(round);
    this.rounds.sort((a, b) => a.round_no - b.round_no);
  }
}

interface Rig {
  db: DB;
  audit: MemoryAuditSink;
  bus: ReturnType<typeof makeLoopEventBus>;
  ledger: MemoryHuntLedger;
  port: FakeHypothesisPort;
  orch: OrchestrationDeps;
  /** 起一轮 hunt_flow（簿记先行 + 直接 executeRun，flow.test T01/T02 同形）。 */
  runRound(roundNo: number): Promise<RunRow>;
  drive(): void;
  pump(): Promise<void>;
  stop(): void;
}

function rig(llm: LoopLlm, scan: ScanSeam = scanAllow): Rig {
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
    llm,
    scan,
    cases: new FakeCasePort(), // 票 75 收敛缝：假件不出网
    register: (call) => new MemoryHypothesisRegister().register(call),
  };
  setEventTap((e) => bus.publish(e));

  const nodesFor = (runId: string) => {
    const link = ledger.get(runId);
    return link?.role === "task" ? makeHuntTaskFlow({ runId, orch, audit }) : makeHuntFlow({ runId, orch, audit });
  };
  const executing = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tryExecute = (runId: string): void => {
    if (executing.has(runId)) return;
    const row = getRun(db, runId);
    if (!row || row.status !== "queued") return;
    executing.add(runId);
    void executeRun(db, runId, { nodes: nodesFor(runId), audit, requestId: "req-rig" })
      .catch(() => {})
      .finally(() => executing.delete(runId));
  };
  return {
    db, audit, bus, ledger, port, orch,
    async runRound(roundNo) {
      const parent = createRun(db, { kind: "hunt_flow", hypothesisId: HYP }, { audit, requestId: `req-r${roundNo}` });
      ledger.put({ runId: parent.id, role: "round", hypothesisId: HYP, roundNo, parentRunId: null, task: null });
      return executeRun(db, parent.id, { nodes: nodesFor(parent.id), audit, requestId: `req-r${roundNo}` });
    },
    drive() {
      timer = setInterval(() => {
        for (const l of ledger.all()) tryExecute(l.runId);
      }, 5);
    },
    async pump() {
      for (;;) {
        const pending = ledger.all().filter((l) => {
          const r = getRun(db, l.runId);
          return (!!r && r.status === "queued") || executing.has(l.runId);
        });
        if (pending.length === 0) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
afterAll(() => setEventTap(null));

describe("T03 task_cap_truncates（行为约定超限截断：不拒整轮）", () => {
  test("输出 3 任务 > max_tasks=2 → 截断执行 2 个 + 建议审计带 truncated，轮次照常收敛路径", async () => {
    const calls: unknown[] = [];
    const rig1 = rig(scriptedPlanner([[taskOf("kb_lookup"), taskOf("siem_query"), taskOf("related_alerts")]], calls));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    expect(done.status).toBe("completed"); // 截断不是拒绝：轮次照常走完
    expect(calls).toHaveLength(1); // 截断不重试
    // 只执行截断后的组合：子 run 与轮次归集都是 2 个（非法的第三件从未执行）
    expect(rig1.ledger.childrenOf(done.id)).toHaveLength(2);
    expect(rig1.port.rounds[0].tasks).toHaveLength(2);

    // 审计分痕 A（建议，INV-8 五要素）：建议条目带 truncated/tasks_returned
    const suggest = rig1.audit.entries.find((e) => e.action === "hunt_plan_suggest");
    expect(suggest).toMatchObject({
      actor: { id: "agent:hunt_flow" },
      objectId: done.id,
      objectType: "run",
      result: "SUCCESS",
    });
    expect(suggest?.requestId).toBe(`hunt_${done.id}`);
    expect(suggest?.details).toMatchObject({ truncated: true, tasks_returned: 3 });
    expect(rig1.audit.entries.some((e) => e.action === "hunt_plan_denied")).toBe(false);
    // 审计分痕 B（决定）：dispatch 实际执行的组合——与 A 两个 action 可区分可查
    const decide = rig1.audit.entries.find((e) => e.action === "hunt_dispatch_decide");
    expect(decide).toMatchObject({ objectId: done.id, objectType: "run", result: "SUCCESS" });
    expect((decide?.details as { children: string[] }).children.slice().sort()).toEqual(
      rig1.ledger.childrenOf(done.id).map((c) => c.runId).sort(),
    );
    // 两个 action 名同帧可查：建议 ≠ 决定
    expect(new Set([suggest?.action, decide?.action]).size).toBe(2);
  });
});

describe("T04 offmenu_rejected（行为约定 4：菜单外 fail-closed，INV-11/INV-3）", () => {
  test("菜单外工具（isolate_host，L2）→ 不 retry 本轮终止 + DENIED 审计，不产出子 run", async () => {
    const calls: unknown[] = [];
    const rig1 = rig(
      scriptedPlanner([[taskOf("kb_lookup"), { tool: "isolate_host", params: { host: "h1" }, rationale: "越权拆条" }]], calls),
    );
    const done = await rig1.runRound(1);

    expect(done.status).toBe("completed"); // run 不死（fail-closed ≠ 强杀）
    expect(calls).toHaveLength(1); // 菜单外无重试价值：恰一次调用
    expect(rig1.ledger.childrenOf(done.id)).toHaveLength(0); // 非法输出不产出子 run
    expect(rig1.audit.entries.some((e) => e.action === "hunt_dispatch_decide")).toBe(false); // 无决定即无 B 半边

    const denied = rig1.audit.entries.find((e) => e.action === "hunt_plan_denied");
    expect(denied).toMatchObject({ objectId: done.id, objectType: "run", result: "DENIED" });
    expect(denied?.details).toMatchObject({ reason: "offmenu_tool", tools: ["isolate_host"] });

    // 本轮终止：空轮归集（无 judge），假设仍 hunting——单轮失败不取消（连续两轮才 planner_broken）
    expect(rig1.port.rounds[0]).toMatchObject({ round_no: 1, judge: null });
    expect(rig1.port.rounds[0].tasks).toHaveLength(0);
    expect(rig1.port.status).toBe("hunting");
  });
});

describe("T05 schema_degrade（行为约定 3：schema 失败重试 1 次 → 再败本轮终止 run 不死）", () => {
  test("两次坏输出 → 恰重试一次（同一输入重放）+ DENIED 审计 + 空轮归集", async () => {
    const calls: unknown[] = [];
    const rig1 = rig(scriptedPlanner([{ tasks: "garbage" }, { tasks: [] }], calls));
    const done = await rig1.runRound(1);

    expect(done.status).toBe("completed"); // run 不死
    expect(calls).toHaveLength(2); // 重试恰一次
    expect(calls[0]).toEqual(calls[1]); // 同一输入重放（消毒后的同一份）

    const denied = rig1.audit.entries.find((e) => e.action === "hunt_plan_denied");
    expect(denied?.result).toBe("DENIED");
    expect(denied?.details).toMatchObject({ reason: "schema_invalid", attempts: 2 });

    expect(rig1.ledger.childrenOf(done.id)).toHaveLength(0); // 坏输出不产出子 run
    expect(rig1.port.rounds[0]).toMatchObject({ round_no: 1, judge: null });
    expect(rig1.port.status).toBe("hunting"); // 单轮失败不取消
  });

  test("schema_retry_recovers：第一次坏 → 重试合法 → 轮次照常出子 run（重试半边的另一面）", async () => {
    const calls: unknown[] = [];
    const rig1 = rig(scriptedPlanner([{ tasks: 42 }, [taskOf("siem_query")]], calls));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    expect(done.status).toBe("completed");
    expect(calls).toHaveLength(2); // 重试了一次
    expect(rig1.ledger.childrenOf(done.id)).toHaveLength(1);
    expect(rig1.audit.entries.some((e) => e.action === "hunt_plan_denied")).toBe(false);
    const suggest = rig1.audit.entries.find((e) => e.action === "hunt_plan_suggest");
    expect(suggest?.details).toMatchObject({ attempts: 2, truncated: false });
  });
});

describe("行为约定 3 后半：连续两轮 planner 失败 → 假设 cancelled(planner_broken)", () => {
  test("轮 1、轮 2 连续 schema 失败 → cancelled 原因 planner_broken，不再接力轮 3", async () => {
    const rig1 = rig(scriptedPlanner([[{ nope: true }]], [])); // 每轮都坏
    const relay = startRoundRelay({ bus: rig1.bus, ledger: rig1.ledger, door: rig1.orch.door });
    rig1.drive();
    await rig1.runRound(1);
    await tick();
    await rig1.pump();
    await tick();
    rig1.stop();
    relay.stop();

    // 两轮都跑了、都失败；m2 PATCH 写半边收到 cancelled + reason=planner_broken
    expect(rig1.port.rounds.map((r) => r.round_no)).toEqual([1, 2]);
    expect(rig1.port.calls).toContain(`transition:${HYP}:cancelled`);
    expect(rig1.port.reasons).toContain("planner_broken");
    expect(rig1.ledger.rounds(HYP)).toHaveLength(2); // 没有轮 3 被拉起
    expect(rig1.audit.entries.filter((e) => e.action === "hunt_plan_denied")).toHaveLength(2);
  });

  test("仅一轮失败（轮 2 恢复）→ 不取消，照常收敛路径（连续性判定不误伤）", async () => {
    // 轮 1 两次调用都坏（重试也救不回）→ 本轮终止；轮 2 恢复合法组合 → 照常收敛
    const rig1 = rig(scriptedPlanner([{ nope: true }, { nope: true }, [taskOf("kb_lookup")], [taskOf("siem_query")]], []));
    const relay = startRoundRelay({ bus: rig1.bus, ledger: rig1.ledger, door: rig1.orch.door });
    rig1.drive();
    await rig1.runRound(1);
    await tick();
    await rig1.pump();
    await tick();
    rig1.stop();
    relay.stop();

    expect(rig1.port.calls).not.toContain(`transition:${HYP}:cancelled`);
    expect(rig1.audit.entries.filter((e) => e.action === "hunt_plan_denied")).toHaveLength(1); // 只有轮 1
  });
});
