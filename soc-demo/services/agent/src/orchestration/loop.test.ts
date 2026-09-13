// 票 77 · spec T06/T09/T10：轮次防转 + max_rounds 硬顶 + 人取消停止链（loop.test.ts 归本票，
// spec 绑定注记：人取消与预算触发共用 cancel.ts 的「节点包装层检查 + 子 run
// failed(parent_cancelled)」同一套停止机制）。
//
// T06 spin_guard：相邻两轮指纹相同（任务集 + gap 摘要，llm-stubs.spinFingerprint）→
//       dispatch 拒组合（无子 run、无接力）+ 假设 cancelled(spin)，不冒充 refuted；
//       gap 实质变化（新证据改写缺口）→ 指纹含 gap hash → 差异化重选豁免。
// T09 rounds_exhausted：20 轮未收敛 → 第 21 轮在 intake 被 max_rounds 硬顶拒
//       （BudgetExceededError(rounds) 既有强杀口径：failed + 审计 + error 事件 + SSE），
//       取消机制落假设 cancelled(budget_rounds)；跨轮计费连续（run.steps/tokensUsed 口径）。
// T10 user_cancel_children：人取消（73 建端点的循环侧 = cancel.requestCancel，m2 PATCH
//       写半边落 cancelled(user_cancelled)）→ 挂起中的父 run 停、进行中子 run 在下一个
//       节点边界安全停、未起的不干活（零取证工作量）；父链审计齐（INV-8）；终态不可
//       回退（INV-10）。
//
// 布景纪律与 flow.test.ts 同款：:memory: 库 + 记账假 port（带真状态机：终态不可回退）+
// 假 door + 真 relay/watcher。总线喂法与生产同构（setEventTap → bus.publish）；取消机制
// 在场（makeLoopCancel）——预算触发与人取消的停止链都在事件通路上，无定时轮询（T19：
// 静态半只扫机制目录非测试源码，测试内的 drive/pump 是 dispatcher 角色既定形态）。
import { afterAll, describe, expect, test } from "vitest";
import type { FlowNode } from "../graph.js";
import { openDb, type DB } from "../db.js";
import { MemoryAuditSink } from "../audit.js";
import { createRun, getRun } from "../runs.js";
import { executeRun } from "../graph.js";
import { eventsAfter, setEventTap } from "../events.js";
import { MemoryHuntLedger } from "./ledger.js";
import { makeLoopEventBus } from "./bus.js";
import { makeLoopCancel, type LoopCancel } from "./cancel.js";
import { startRoundRelay } from "./relay.js";
import { makeFakeLoopLlm } from "./llm-stubs.js";
import { MemoryHypothesisRegister } from "./register.js";
import { DefaultTemplateSource } from "./template.js";
import { makeHuntFlow, type OrchestrationDeps } from "./flow.js";
import { makeHuntTaskFlow } from "./task-flow.js";
import type { JudgeOutput } from "./ports.js";
import type {
  CaseCreateInput,
  CasePort,
  GapInput,
  GapOutput,
  HypothesisDetail,
  HypothesisPort,
  LoopLlm,
  PlannedTask,
  RoundRecord,
  ScanSeam,
} from "./ports.js";

const HYP = "hyp-t77";

const scanAllow: ScanSeam = async (text) => ({ blocked: false, action: "allow", text });

/** m2 案件实体假件（收敛分岔缝）：记账不出网。 */
class FakeCasePort implements CasePort {
  created: CaseCreateInput[] = [];
  private n = 0;
  async create(input: CaseCreateInput): Promise<string> {
    this.created.push({ ...input });
    return `case_${String(++this.n).padStart(6, "0")}`;
  }
  async addNote(): Promise<void> {}
}

/** m2 假设实体假件：带真状态机（case-backend statemachine.hypothesis 同表）——
 *  表外迁移抛 409 语义错误（INV-10 断言面）；迁移带原因留痕（cancelled 四因可查）。 */
class FakeHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  transitions: { to: string; reason: string }[] = [];
  rounds: RoundRecord[] = [];

  private static readonly LEGAL: Record<string, string[]> = {
    proposed: ["hunting"],
    hunting: ["concluded", "refuted", "cancelled"],
    concluded: [],
    refuted: [],
    cancelled: [],
  };

  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: "t-default", text: "内网横向移动待验证", rounds: [...this.rounds] };
  }
  async startHunting(id: string): Promise<void> {
    if (!(FakeHypothesisPort.LEGAL[this.status] ?? []).includes("hunting")) {
      throw new Error(`InvalidTransition:409 hypothesis ${this.status} -> hunting`);
    }
    this.status = "hunting";
    void id;
  }
  async transition(id: string, to: "concluded" | "refuted" | "cancelled", opts?: { reason?: string }): Promise<void> {
    if (!(FakeHypothesisPort.LEGAL[this.status] ?? []).includes(to)) {
      throw new Error(`InvalidTransition:409 hypothesis ${this.status} -> ${to}`);
    }
    this.status = to;
    this.transitions.push({ to, reason: opts?.reason ?? "" });
    void id;
  }
  async recordRound(id: string, round: RoundRecord): Promise<void> {
    void id;
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
  cancel: LoopCancel;
  /** dispatcher 角色：簿记内 queued 的 run 就地执行（生产 run-dispatcher 同形）。 */
  drive(): void;
  /** 等簿记内全部 run 离开 queued（含在途），循环多次给 relay/watcher 事件跟进留缝。 */
  pump(): Promise<void>;
  /** 反复 pump 直到假设离开 hunting（轮次链终局/终止）或次数耗尽。 */
  settle(): Promise<void>;
  stop(): Promise<void>;
}

function loopRig(opts: { llm?: LoopLlm; wrapChild?: (nodes: FlowNode[]) => FlowNode[] } = {}): Rig {
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
    llm: opts.llm ?? makeFakeLoopLlm(),
    scan: scanAllow,
    cases: new FakeCasePort(),
    register: (call) => new MemoryHypothesisRegister().register(call),
  };
  const cancel = makeLoopCancel({ bus, ledger, port, audit, log: () => {} });
  orch.cancel = cancel;
  setEventTap((e) => bus.publish(e));
  const relay = startRoundRelay({ bus, ledger, door, log: () => {} });
  void relay;

  const nodesFor = (runId: string): FlowNode[] => {
    const link = ledger.get(runId);
    if (link?.role !== "task") return makeHuntFlow({ runId, orch, audit });
    const child = makeHuntTaskFlow({ runId, orch, audit });
    return opts.wrapChild ? opts.wrapChild(child) : child;
  };
  const executing = new Set<string>();
  const stoppers: (() => void)[] = [];
  const tryExecute = (runId: string): void => {
    if (executing.has(runId)) return;
    const row = getRun(db, runId);
    if (!row || row.status !== "queued") return;
    executing.add(runId);
    void executeRun(db, runId, { nodes: nodesFor(runId), audit, requestId: "req-rig" })
      .catch(() => {})
      .finally(() => executing.delete(runId));
  };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    db, audit, bus, ledger, port, orch, cancel,
    drive() {
      const timer = setInterval(() => {
        for (const l of ledger.all()) tryExecute(l.runId);
      }, 5);
      stoppers.push(() => clearInterval(timer));
    },
    async pump() {
      for (let i = 0; i < 600; i++) {
        for (const l of ledger.all()) tryExecute(l.runId);
        const pending = ledger.all().filter((l) => {
          const r = getRun(db, l.runId);
          return (!!r && r.status === "queued") || executing.has(l.runId);
        });
        if (pending.length === 0) return;
        await new Promise((r) => setTimeout(r, 2));
      }
    },
    async settle() {
      // proposed（首轮未前置 hunting）与 hunting 都算「循环还在跑」——跑到终态或次数耗尽
      for (let i = 0; i < 400 && (port.status === "proposed" || port.status === "hunting"); i++) {
        await tick();
        await this.pump();
      }
      await tick();
    },
    async stop() {
      for (const s of stoppers.splice(0)) s();
    },
  };
}

/** 确定性 LLM 桩：planner 每轮固定返回同一组合（spin 场景），judge 恒不充分，gap 形态可调。 */
function fixedComboLlm(opts: { gap: (roundNo: number) => GapOutput }): LoopLlm {
  const planner = async (input: { menu: readonly string[]; hypothesis_text: string }): Promise<{ tasks: PlannedTask[]; tokens: number }> => {
    const tool = input.menu[0] ?? "kb_lookup";
    return { tasks: [{ tool, params: { q: input.hypothesis_text.slice(0, 32) }, rationale: "固定组合（spin 布景）" }], tokens: 24 };
  };
  const judge = async (): Promise<JudgeOutput & { tokens: number }> => ({
    sufficient: false, verdict: null, confidence: 0.4, gap_description: "证据不足以判定", tokens: 24,
  });
  const gap = async (input: GapInput): Promise<GapOutput & { tokens: number }> => {
    void input;
    return { ...opts.gap(0), tokens: 24 };
  };
  return { planner: planner as LoopLlm["planner"], judge, gap };
}

afterAll(() => setEventTap(null));

describe("T06 spin_guard（行为约定 10：相邻轮同指纹拒组合，gap 差异化豁免）", () => {
  test("固定组合 + 恒定 gap → 第 3 轮 dispatch 拒组合，假设 cancelled(spin)，无子 run 无接力", async () => {
    const rig = loopRig({
      llm: fixedComboLlm({
        gap: () => ({ gap_description: "缺口原地踏步", unknown: "unknown-x", suggested_focus: ["same-focus"] }),
      }),
    });
    const round1 = createRun(rig.db, { kind: "hunt_flow", hypothesisId: HYP }, { audit: rig.audit, requestId: "req-t06" });
    rig.ledger.put({ runId: round1.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });
    await rig.settle();
    await rig.stop();

    // 假设 cancelled（原因 spin），不冒充 refuted/concluded
    expect(rig.port.status).toBe("cancelled");
    expect(rig.port.transitions).toEqual([{ to: "cancelled", reason: "spin" }]);
    // 三轮在册：轮 3 是拒组合的空轮（tasks=[]，无 judge），轮 1/2 正常归集
    expect(rig.port.rounds.map((r) => r.round_no)).toEqual([1, 2, 3]);
    expect(rig.port.rounds[2].tasks).toEqual([]);
    expect(rig.port.rounds[2].judge).toBeNull();
    // 拒组合轮：无子 run、无接力（防转 = max_repeat=1，同指纹第二次出现即掐）
    const round3 = rig.ledger.findByRound(HYP, 3);
    expect(round3).toBeTruthy();
    expect(rig.ledger.childrenOf(round3!.runId)).toHaveLength(0);
    expect(rig.ledger.rounds(HYP)).toHaveLength(3);
    // DENIED 审计可回放（INV-8）
    const spin = rig.audit.entries.find((e) => e.action === "hunt_round_spin_denied");
    expect(spin?.result).toBe("DENIED");
    expect((spin?.details as { round_no?: number }).round_no).toBe(3);
    expect((spin?.details as { max_repeat?: number }).max_repeat).toBe(1);
  });

  test("豁免：同组合但 gap 实质变化（新证据改写缺口）→ 指纹不同，循环正常收敛", async () => {
    // FakeLoopGap 的 suggested_focus 随证据条数变化 → 每轮 gap hash 不同 → 同组合不判空转；
    // FakeLoopJudge 在第 2 轮（有既往轮）收敛 → concluded 而非 cancelled(spin)。
    const rig = loopRig(); // fake 三件套默认档即此轨迹（planner 有 gap 换组合，此处靠指纹豁免语义）
    const round1 = createRun(rig.db, { kind: "hunt_flow", hypothesisId: HYP }, { audit: rig.audit, requestId: "req-t06b" });
    rig.ledger.put({ runId: round1.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });
    await rig.settle();
    await rig.stop();

    expect(rig.port.status).toBe("concluded");
    expect(rig.audit.entries.some((e) => e.action === "hunt_round_spin_denied")).toBe(false);
    // 对照组（同布景下指纹若不含 gap hash 会被误掐）：轮 2 正常起了子 run 并收敛
    const round2 = rig.ledger.findByRound(HYP, 2);
    expect(round2).toBeTruthy();
    expect(getRun(rig.db, round2!.runId)?.status).toBe("completed");
  });
});

describe("T09 rounds_exhausted（max_rounds=20 硬顶 → cancelled(budget_rounds)，强杀口径与预算一致）", () => {
  test("judge 恒不充分 → 20 轮跑满，第 21 轮 intake 被 rounds 闸拒：run failed + 审计 + error 事件，假设 cancelled(budget_rounds)", async () => {
    // 恒不充分桩：每轮 planner/judge/gap 各 24 token、六节点——跨轮计费连续性的对照数。
    // gap 随证据条数演化（指纹含 gap hash → 每轮指纹不同，不触发防转）——20 轮跑满是本
    // 测试的前提，防转路径归 T06。
    const rig = loopRig({
      llm: {
        planner: async () => ({ tasks: [{ tool: "kb_lookup", params: { q: "x" }, rationale: "r" }], tokens: 24 }),
        judge: async (): Promise<JudgeOutput & { tokens: number }> => ({
          sufficient: false, verdict: null, confidence: 0.4, gap_description: "证据不足", tokens: 24,
        }),
        gap: async (input: GapInput): Promise<GapOutput & { tokens: number }> => ({
          gap_description: "证据不足",
          unknown: "unknown",
          suggested_focus: [`focus-${input.evidence_so_far.length}`],
          tokens: 24,
        }),
      },
    });
    const round1 = createRun(rig.db, { kind: "hunt_flow", hypothesisId: HYP }, { audit: rig.audit, requestId: "req-t09" });
    rig.ledger.put({ runId: round1.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });
    await rig.settle();
    await rig.stop();

    // 20 轮全部归集；第 21 轮在 intake 被硬顶拒（无第 21 份归集、无第 22 轮接力）
    expect(rig.port.rounds.map((r) => r.round_no)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rig.ledger.rounds(HYP)).toHaveLength(21);
    const round21 = rig.ledger.findByRound(HYP, 21)!;
    const row21 = getRun(rig.db, round21.runId);
    expect(row21?.status).toBe("failed");
    expect(row21?.failReason).toBe("budget_exceeded:rounds");
    // 强杀口径与 BudgetExceededError 一致（审计 + error 事件 + SSE 可见）
    const kill = rig.audit.entries.find((e) => e.action === "kill" && e.objectId === round21.runId);
    expect(kill?.result).toBe("FAILURE");
    expect((kill?.details as { kind?: string }).kind).toBe("rounds");
    const errEvt = eventsAfter(rig.db, round21.runId, 0).find((e) => e.type === "error");
    expect((errEvt?.payload as { kind?: string }).kind).toBe("rounds");
    // 假设侧：取消机制消费强杀事件 → cancelled(budget_rounds)，不冒充 refuted
    expect(rig.port.status).toBe("cancelled");
    expect(rig.port.transitions).toEqual([{ to: "cancelled", reason: "budget_rounds" }]);

    // 计费连续性（票面第 5 条）：跨轮每轮独立记账、run.steps/tokensUsed 口径不回退——
    // 每轮 planner/judge/gap 各 24 token → 72；六节点 → 6 步；子 run 各自 8 token/4 步。
    const round5 = rig.ledger.findByRound(HYP, 5)!;
    const row5 = getRun(rig.db, round5.runId);
    expect(row5?.steps).toBe(6);
    expect(row5?.tokensUsed).toBe(72);
    const child5 = rig.ledger.childrenOf(round5.runId)[0]!;
    const childRow5 = getRun(rig.db, child5.runId);
    expect(childRow5?.tokensUsed).toBe(8);
    expect(childRow5?.steps).toBe(4);
  }, 20000);
});

describe("T10 user_cancel_children（行为约定 12：人取消 → 同 11 停止语义，原因 user_cancelled）", () => {
  test("挂起中的父 run 停、未起的子 run 不干活，父链审计齐（INV-8），终态不可回退（INV-10）", async () => {
    const rig = loopRig(); // fake planner 首轮出 2 个任务 → 2 个子 run
    const round1 = createRun(rig.db, { kind: "hunt_flow", hypothesisId: HYP }, { audit: rig.audit, requestId: "req-t10" });
    rig.ledger.put({ runId: round1.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });
    // 不 await、不开 drive：父 run 停在 await_children（parksOnEvents 放行形态的进程内
    // 等价物），子 run 已声明、保持 queued（未起）
    const parentDone = executeRun(rig.db, round1.id, {
      nodes: makeHuntFlow({ runId: round1.id, orch: rig.orch, audit: rig.audit }),
      audit: rig.audit,
      requestId: "req-t10",
    });
    // 等父 run 真正挂起（await_children 入场），此刻子 run 已存在、尚未起跑
    for (let i = 0; i < 500; i++) {
      const evts = eventsAfter(rig.db, round1.id, 0);
      if (evts.some((e) => e.type === "node_enter" && e.payload.node === "await_children")) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    const childIds = rig.ledger.childrenOf(round1.id).map((l) => l.runId);
    expect(childIds.length).toBe(2);
    expect(childIds.every((id) => getRun(rig.db, id)?.status === "queued")).toBe(true);

    // 人取消（POST /hypotheses/:id/cancel 的循环侧入口；m2 PATCH 写半边落账）
    await rig.cancel.requestCancel(HYP, "user_cancelled", "user");
    expect(rig.port.status).toBe("cancelled");
    expect(rig.port.transitions).toEqual([{ to: "cancelled", reason: "user_cancelled" }]);

    // 未起的子 run 起了也在首个节点边界被取消检查掐停；父 run 被子 run 终局事件唤醒后
    // 同口径停（pump 兼任 dispatcher：执行子 run → error 事件唤醒父 run → 父 run 停）
    await rig.pump();
    await parentDone;
    await rig.stop();

    expect(getRun(rig.db, round1.id)?.status).toBe("failed");
    expect(getRun(rig.db, round1.id)?.failReason).toContain("parent_cancelled");
    for (const id of childIds) {
      const row = getRun(rig.db, id);
      expect(row?.status).toBe("failed");
      expect(row?.failReason).toContain("parent_cancelled");
      expect(eventsAfter(rig.db, id, 0).some((e) => e.type === "tool_call")).toBe(false); // 零取证工作量
    }
    // 父链审计齐（INV-8）：取消决定 + 父/子强杀 FAILURE 条目可回放
    expect(rig.audit.entries.some((e) => e.action === "hunt_cancel" && e.objectId === HYP && e.result === "SUCCESS")).toBe(true);
    expect(rig.audit.entries.some((e) => e.action === "kill" && e.objectId === round1.id && e.result === "FAILURE")).toBe(true);
    expect(childIds.every((id) => rig.audit.entries.some((e) => e.action === "kill" && e.objectId === id && e.result === "FAILURE"))).toBe(true);
    // SSE error 事件可见（父 + 子）
    expect(eventsAfter(rig.db, round1.id, 0).some((e) => e.type === "error")).toBe(true);

    // 终态不可回退（INV-10）：cancelled 之后的任何迁移/重开都是 409
    await expect(rig.port.transition(HYP, "refuted")).rejects.toThrow(/InvalidTransition:409/);
    await expect(rig.port.startHunting(HYP)).rejects.toThrow(/InvalidTransition:409/);
  });

  test("进行中的子 run 收信号安全停：执行中途被掐，不产出终态报告", async () => {
    let releaseChild!: () => void;
    const barrier = new Promise<void>((r) => { releaseChild = r; });
    let childInFlight!: () => void;
    const inFlight = new Promise<void>((r) => { childInFlight = r; });
    const rig = loopRig({
      llm: {
        planner: async () => ({ tasks: [{ tool: "kb_lookup", params: { q: "x" }, rationale: "r" }], tokens: 24 }),
        judge: async (): Promise<JudgeOutput & { tokens: number }> => ({
          sufficient: true, verdict: "hit", confidence: 0.9, gap_description: null, tokens: 24,
        }),
        gap: async (): Promise<GapOutput & { tokens: number }> => ({
          gap_description: "g", unknown: "u", suggested_focus: ["f"], tokens: 24,
        }),
      },
      wrapChild: (nodes) =>
        nodes.map((n) =>
          n.name === "execute"
            ? { ...n, run: async (ctx) => { childInFlight(); await barrier; await n.run(ctx); } }
            : n,
        ),
    });
    rig.drive();
    const round1 = createRun(rig.db, { kind: "hunt_flow", hypothesisId: HYP }, { audit: rig.audit, requestId: "req-t10b" });
    rig.ledger.put({ runId: round1.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });
    const parentDone = executeRun(rig.db, round1.id, {
      nodes: makeHuntFlow({ runId: round1.id, orch: rig.orch, audit: rig.audit }),
      audit: rig.audit,
      requestId: "req-t10b",
    });
    await inFlight; // 子 run 执行到一半（execute 节点体挂起）
    const childId = rig.ledger.childrenOf(round1.id)[0]!.runId;

    await rig.cancel.requestCancel(HYP, "user_cancelled", "user");
    releaseChild();
    await parentDone;
    await rig.stop();

    // 子 run：节点边界取消检查掐停 → 无 tool_call/tool_result、无 hunt_task_finished 报告
    const row = getRun(rig.db, childId);
    expect(row?.status).toBe("failed");
    expect(row?.failReason).toContain("parent_cancelled");
    const childEvts = eventsAfter(rig.db, childId, 0);
    expect(childEvts.some((e) => e.type === "tool_call")).toBe(false);
    expect(rig.audit.entries.some((e) => e.action === "hunt_task_finished" || e.action === "hunt_task_report")).toBe(false);
    // 父 run 被唤醒后在下一个节点边界同口径停
    expect(getRun(rig.db, round1.id)?.failReason).toContain("parent_cancelled");
    expect(rig.port.transitions).toEqual([{ to: "cancelled", reason: "user_cancelled" }]);
  });
});
