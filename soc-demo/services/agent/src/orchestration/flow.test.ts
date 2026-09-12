// 票 73 · spec T01/T02：hunt_flow 轮次链契约（fake LLM/确定性桩，两轮轨迹）。
//
// T01 hunt_flow_start_transitions：发起假设（proposed）→ hunt_flow queued→running →
//      hypothesis hunting（行为约定 1 的首轮前置，INV-10 迁移经 m2 公开面假件核账）。
// T02 round_chain_event_order：六节点事件序与既有 run 同口径（INV-7/8）；轮次接力幂等
//      ——round_relay 事件重放不重复起 round（INV-6 同族）；SSE 事件自增 id 可补发；
//      fanout 子 run 为独立 run 行，parent/round 簿记可查。
//
// 布景纪律（与 langgraph-flow.test.ts 同款）：:memory: 库 + MemoryAuditSink + 假 port/
// 假 door。总线喂法与生产同构：setEventTap 是 index.ts 装配的同一槽位（emitEvent →
// tap → bus.publish），测试里把 tap 指到 rig 的总线；轮次接力用真 relay（startRoundRelay），
// 子 run/下一轮 run 的执行由事件订阅驱动（与生产 dispatcher 同为「事件后跟进」形态，
// 不引入任何定时轮询）。
import { afterAll, describe, expect, test } from "vitest";
import { openDb, type DB } from "../db.js";
import { MemoryAuditSink } from "../audit.js";
import { createRun, getRun } from "../runs.js";
import { executeRun } from "../graph.js";
import { emitEvent, eventsAfter, formatSse, setEventTap } from "../events.js";
import { MemoryHuntLedger } from "./ledger.js";
import { makeLoopEventBus } from "./bus.js";
import { startRoundRelay } from "./relay.js";
import { makeFakeLoopLlm } from "./llm-stubs.js";
import { DefaultTemplateSource } from "./template.js";
import { makeHuntFlow, type OrchestrationDeps } from "./flow.js";
import { makeHuntTaskFlow } from "./task-flow.js";
import type { HypothesisDetail, HypothesisPort, RoundRecord } from "./ports.js";

const HYP = "hyp-t02";

/** m2 假设实体假件：记账式 port（迁移/轮次归集全落内存，非法迁移抛 409 语义错误）。 */
class FakeHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  calls: string[] = [];
  rounds: RoundRecord[] = [];

  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: "t-default", text: "内网横向移动待验证", rounds: [...this.rounds] };
  }
  async startHunting(id: string): Promise<void> {
    this.calls.push(`startHunting:${id}`);
    if (this.status !== "proposed") throw new Error("InvalidTransition:409");
    this.status = "hunting";
  }
  async transition(id: string, to: "concluded" | "refuted" | "cancelled"): Promise<void> {
    this.calls.push(`transition:${id}:${to}`);
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
  /** dispatcher 角色：定时扫描簿记里 queued 的 run 就地执行（与生产 run-dispatcher 同形）。 */
  drive(): void;
  /** 等簿记内全部 run 离开 queued（含在途）。 */
  pump(): Promise<void>;
  stop(): Promise<void>;
}

function rig(): Rig {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const bus = makeLoopEventBus();
  const ledger = new MemoryHuntLedger();
  const port = new FakeHypothesisPort();
  const door = {
    // 假门：与真门同形（建 run 行返回 run_id；铸票/入队细节归 app.ts，测试不覆盖）
    post: async (payload: { kind: string; case_id?: string }): Promise<string> =>
      createRun(db, { kind: payload.kind, caseId: payload.case_id ?? null }, { audit, requestId: "rig-door" }).id,
  };
  const orch: OrchestrationDeps = {
    port,
    ledger,
    bus,
    door,
    templates: new DefaultTemplateSource(),
    llm: makeFakeLoopLlm(),
  };
  // emitEvent → tap → bus：与 index.ts 生产装配同一个槽位（emitEvent 落盘真相 + 进程内扇出）
  setEventTap((e) => bus.publish(e));

  const nodesFor = (runId: string) => {
    const link = ledger.get(runId);
    return link?.role === "task" ? makeHuntTaskFlow({ runId, orch, audit }) : makeHuntFlow({ runId, orch, audit });
  };
  const executing = new Set<string>();
  // 子 run 不嵌进父图 invoke 里同步执行：嵌套 graph.invoke 会继承父图的 LangGraph 检查点
  // 命名空间（checkpoint_ns），信封检查点 fail-closed 拒收（checkpointer.ts threadOf）。
  // 「dispatch 只声明、机器在图外执行」是拓扑事实——生产由 run-dispatcher 定时消化队列，
  // 测试的 drive/pump 扮演同一个角色（dispatcher 角色的定时器只活在测试里，不犯 T19：
  // 静态半只扫机制目录的非测试源码）。
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
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
afterAll(() => setEventTap(null));

describe("T01 hunt_flow_start_transitions（行为约定 1：首轮前置 hunting，INV-10）", () => {
  test("发起假设 proposed → hunt_flow queued→running → hypothesis hunting → 轮次跑完归集", async () => {
    const rig1 = rig();
    const { db, audit, port, orch } = rig1;
    rig1.drive();
    const parent = createRun(db, { kind: "hunt_flow", caseId: HYP }, { audit, requestId: "req-t01" });
    expect(parent.status).toBe("queued"); // m3 标准入口：落 queued

    const done = await executeRun(db, parent.id, {
      nodes: makeHuntFlow({ runId: parent.id, orch, audit }),
      audit,
      requestId: "req-t01",
    });
    await tick();

    // run 状态机与既有 run 同口径：queued→running→completed（迁移审计可回放）
    expect(done.status).toBe("completed");
    const transitions = audit.entries.filter(
      (e) => e.objectId === parent.id && e.action === "update" && (e.details as { status?: unknown }).status,
    );
    expect(transitions.map((e) => (e.details as { status: { from: string; to: string } }).status)).toEqual([
      { from: "queued", to: "running" },
      { from: "running", to: "completed" },
    ]);

    // 首轮前置 hunting：intake 第一件事经 m2 公开面把 proposed→hunting（先于 planner 组合）
    expect(port.calls[0]).toBe(`startHunting:${HYP}`);
    expect(port.status).toBe("hunting"); // 无 relay 消费者 → 轮 1 停在 hunting，不冒充终局
    expect(port.rounds).toHaveLength(1);
    expect(port.rounds[0].round_no).toBe(1);

    // 审计五要素（INV-8）：轮次 outcome 落五要素条目
    const outcomeAudit = audit.entries.find((e) => e.action === "hunt_round_outcome");
    expect(outcomeAudit).toMatchObject({
      actor: { id: "agent:hunt_flow" },
      objectId: HYP,
      objectType: "hypothesis",
      result: "SUCCESS",
    });
    expect(outcomeAudit?.requestId).toBeTruthy();
    expect(outcomeAudit?.createdAt).toBeGreaterThan(0);
  });

  test("假设不在 proposed（如已 cancelled）→ 首轮 fail-closed 不开跑（INV-1 强杀口径）", async () => {
    const rig1 = rig();
    const { db, audit, port, orch } = rig1;
    port.status = "cancelled";
    const parent = createRun(db, { kind: "hunt_flow", caseId: HYP }, { audit, requestId: "req-t01b" });
    const done = await executeRun(db, parent.id, {
      nodes: makeHuntFlow({ runId: parent.id, orch, audit }),
      audit,
      requestId: "req-t01b",
    });
    expect(done.status).toBe("failed"); // 不吞错：强杀口径与现有 run 一致
    expect(done.failReason).toBe("node_error:intake");
    const kill = audit.entries.find((e) => e.action === "kill" && e.objectId === parent.id);
    expect(kill?.result).toBe("FAILURE");
    expect(port.calls).toEqual([]); // 连 hunting 都没请求过
  });
});

describe("T02 round_chain_event_order（六节点序 + 接力幂等 + SSE 可回放）", () => {
  test("fake LLM 两轮跑通：C2≠C1、子 run 独立行、relay 重放不重复起 round、事件自增 id 可补发", async () => {
    const rig1 = rig();
    const { db, audit, bus, ledger, port, orch, drive } = rig1;
    // 生产形态：relay 常驻订阅（dispatcher 层），消费 outcome 的 round_relay 事件拉起下一轮
    const relayLog: Record<string, unknown>[] = [];
    const relay = startRoundRelay({ bus, ledger, door: orch.door, log: (e) => relayLog.push(e) });
    drive();

    const round1 = createRun(db, { kind: "hunt_flow", caseId: HYP }, { audit, requestId: "req-t02" });
    ledger.put({ runId: round1.id, role: "round", hypothesisId: HYP, roundNo: 1, parentRunId: null, task: null });

    await executeRun(db, round1.id, { nodes: makeHuntFlow({ runId: round1.id, orch, audit }), audit, requestId: "req-t02" });
    await tick();
    await rig1.pump(); // relay 拉起的 round 2 已落账 queued → 就地跑完（子 run 由 drive 订阅接管）
    await tick();

    // ---- 两轮跑通：假设 concluded，轮 2 组合 ≠ 轮 1（C2≠C1）----
    expect(port.status).toBe("concluded");
    expect(port.rounds.map((r) => r.round_no)).toEqual([1, 2]);
    expect(JSON.stringify(port.rounds[1].tasks)).not.toBe(JSON.stringify(port.rounds[0].tasks));
    const round2Run = ledger.findByRound(HYP, 2);
    expect(round2Run).toBeTruthy();
    expect(getRun(db, round2Run!.runId)?.status).toBe("completed");

    // ---- fanout 子 run：独立 run 行 + parent/round 簿记可查 ----
    const round1Children = ledger.childrenOf(round1.id);
    expect(round1Children.length).toBeGreaterThanOrEqual(1);
    for (const child of round1Children) {
      const row = getRun(db, child.runId);
      expect(row?.kind).toBe("hunt_task"); // 独立 run 行（不是父图内节点）
      expect(row?.status).toBe("completed");
      expect(child.parentRunId).toBe(round1.id); // parent_run_id 簿记
      expect(child.roundNo).toBe(1); // round 簿记
    }
    // 轮次归集的假设侧视图（m2 假 port）与 agent 簿记同源
    expect(port.rounds[0].children.map((c) => c.run_id).sort())
      .toEqual(round1Children.map((c) => c.runId).sort());

    // ---- 六节点事件序与既有 run 同口径（node_enter/exit 成对、按链序）----
    const evts = eventsAfter(db, round1.id, 0);
    const nodeSeq = evts
      .filter((e) => e.type === "node_enter" || e.type === "node_exit")
      .map((e) => `${e.type}:${e.payload.node}`);
    expect(nodeSeq).toEqual([
      "node_enter:intake", "node_exit:intake",
      "node_enter:planner", "node_exit:planner",
      "node_enter:dispatch", "node_exit:dispatch",
      "node_enter:await_children", "node_exit:await_children",
      "node_enter:judge", "node_exit:judge",
      "node_enter:outcome", "node_exit:outcome",
    ]);

    // ---- SSE 自增 id 可补发（INV-7）：全 run 事件 id 严格递增、游标补发不丢不重 ----
    const allRunIds = [round1.id, round2Run!.runId, ...round1Children.map((c) => c.runId)];
    for (const runId of allRunIds) {
      const all = eventsAfter(db, runId, 0);
      expect(all.length).toBeGreaterThan(0);
      const ids = all.map((e) => e.id);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      const mid = Math.max(0, Math.floor(ids.length / 2) - 1);
      const replayed = eventsAfter(db, runId, ids[mid] as number);
      expect(replayed.map((e) => e.id)).toEqual(ids.slice(mid + 1)); // after 游标补发恰为余下全部
      expect(formatSse(replayed)).toContain(`id: ${ids[ids.length - 1]}`);
    }
    // round_relay 事件在父 run 事件流上可回放
    expect(evts.some((e) => e.type === "audit" && e.payload.action === "round_relay")).toBe(true);

    // ---- 轮次接力幂等（INV-6 同族）：同 relay 事件重放不重复起 round ----
    const relayEvent = evts.find((e) => e.type === "audit" && e.payload.action === "round_relay");
    expect(relayEvent).toBeTruthy();
    emitEvent(db, round1.id, "audit", relayEvent!.payload); // 重放：同一事件再投一次
    await tick();
    await tick();
    expect(ledger.rounds(HYP)).toHaveLength(2); // 没有 round 3 被拉起
    expect(port.rounds).toHaveLength(2);
    expect(relayLog.some((l) => l.info === "round_relay_dup")).toBe(true);
    relay.stop();
  });
});
