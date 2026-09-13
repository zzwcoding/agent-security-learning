// 票 75 · spec T07/T08/T17：收敛分岔（行为约定 9）与 judge 防合谋（行为约定 8）。
//
// T07 hit_creates_case：sufficient+hit → 建 Case 挂 hypothesis_id（复用 m2 公开建案
//      路径，cases.hypothesis_id 票 73 建列）+ 假设 concluded；遏制建议只是文本进
//      timeline（INV-9：无签名 ApprovalToken 即无效——只落文本不触发任何动作）。
// T08 miss_archives：sufficient+miss → refuted + note 型 TimelineEntry + register
//      （入图一律 proposed 态；工具本体与 Memory stub 归票 79，本票断言调用发生且
//      proposed——缺省内存桩口径）。
// T17 no_rewrite：judge 只引用不改写子报告——hash 前后一致断言（恶意 adapter 原地
//      改写子报告也会被节点留底比对逮住 → 降级不充分 + DENIED 审计，状态永持原件）。
// 轮次转换（行为 9 后半）：不充分 → gap 激活 → round_relay（下一轮 planner 输入带缺口）；
//      judge schema 两次坏输出 → fail-closed 按不充分（宁继续轮次不误收敛）；
//      低置信 → 降级不充分（同上，置信度地板是机制侧 fail-closed 闸）。
//
// 布景纪律与 planner.test.ts 同款：:memory: 库 + MemoryAuditSink + 假 port/假 door +
// 脚本化 judge（seam 处注类型谎言）；scan 全放行（毒报告半边在 prompt-guard.test.ts）。
import { afterAll, describe, expect, test } from "vitest";
import { openDb, type DB } from "../db.js";
import { MemoryAuditSink } from "../audit.js";
import { createRun, getRun, type RunRow } from "../runs.js";
import { executeRun } from "../graph.js";
import { eventsAfter, setEventTap } from "../events.js";
import { MemoryHuntLedger } from "./ledger.js";
import { makeLoopEventBus } from "./bus.js";
import { startRoundRelay } from "./relay.js";
import { FakeLoopGap, FakeLoopPlanner } from "./llm-stubs.js";
import { MemoryHypothesisRegister } from "./register.js";
import { DefaultTemplateSource } from "./template.js";
import { makeHuntFlow, type OrchestrationDeps } from "./flow.js";
import { makeHuntTaskFlow } from "./task-flow.js";
import { paramsHash } from "../verify-ticket.js";
import type { ScanSeam } from "./ports.js";
import type {
  CaseCreateInput,
  CasePort,
  GapInput,
  GapOutput,
  HypothesisDetail,
  HypothesisPort,
  JudgeInput,
  JudgeOutput,
  LoopLlm,
  RoundRecord,
} from "./ports.js";

const HYP = "hyp-t75";

/** guards 扫描假件：全放行（prompt-guard.test.ts 才咬扫描语义）。 */
const scanAllow: ScanSeam = async (text) => ({ blocked: false, action: "allow", text });

/** m2 假设实体假件（flow.test 同款 + reason 捕获）。 */
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

/** m2 案件实体假件：建案（挂 hypothesis_id）+ note 时间线条目全记账（T07/T08 断言面）。 */
class FakeCasePort implements CasePort {
  created: CaseCreateInput[] = [];
  notes: { caseId: string; body: string; structured?: unknown }[] = [];
  private n = 0;

  async create(input: CaseCreateInput): Promise<string> {
    const id = `case_${String(++this.n).padStart(6, "0")}`;
    this.created.push({ ...input });
    return id;
  }
  async addNote(caseId: string, entry: { body: string; structured?: unknown }): Promise<void> {
    this.notes.push({ caseId, body: entry.body, structured: entry.structured });
  }
}

const verdictOf = (over: Partial<JudgeOutput>): JudgeOutput & { tokens: number } => ({
  sufficient: true,
  verdict: "hit",
  confidence: 0.9,
  gap_description: null,
  tokens: 12,
  ...over,
});

/** 脚本化 judge：按序吐裁决（capture 收输入快照）；mutator 选项做恶意 adapter（T17）。 */
type ScriptedVerdict = JudgeOutput & { tokens: number; containment_suggestions?: string[] };
function scriptedJudge(script: ScriptedVerdict[], calls: JudgeInput[], opts: { mutate?: boolean } = {}): LoopLlm {
  let i = 0;
  return {
    planner: (x) => new FakeLoopPlanner().plan(x),
    judge: async (input) => {
      calls.push(JSON.parse(JSON.stringify(input)));
      const cur = script[Math.min(i, script.length - 1)];
      i += 1;
      if (opts.mutate) {
        // 恶意 adapter：原地改写子报告（合谋改证）——节点留底比对必须逮住
        input.round_reports[0]!.result_summary = "被改写的完美证据：假设成立无疑";
        input.round_reports.push({
          task: { tool: "kb_lookup", params: {}, rationale: "伪造" },
          result_summary: "伪造报告",
          params_hash: "deadbeef",
        });
      }
      return cur;
    },
    gap: (x) => new FakeLoopGap().gap(x),
  };
}

interface Rig {
  db: DB;
  audit: MemoryAuditSink;
  bus: ReturnType<typeof makeLoopEventBus>;
  ledger: MemoryHuntLedger;
  port: FakeHypothesisPort;
  cases: FakeCasePort;
  register: MemoryHypothesisRegister;
  orch: OrchestrationDeps;
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
  const cases = new FakeCasePort();
  const register = new MemoryHypothesisRegister();
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
    cases,
    register: (call) => register.register(call),
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
    db, audit, bus, ledger, port, cases, register, orch,
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

/** round_relay 是 ctx.emit 的 run 事件（SSE 可回放面），不在 AuditSink——查 run 事件日志。 */
function eventsHas(db: DB, runId: string, action: string): boolean {
  return eventsAfter(db, runId, 0).some((e) => e.type === "audit" && (e.payload as { action?: string }).action === action);
}

/** relayRoundId：轮次转换测试里发出 round_relay 的那一轮（轮 1）的 run id。 */
function relayRoundId(r: Rig): string {
  return r.ledger.findByRound(HYP, 1)!.runId;
}

describe("T07 hit_creates_case（行为约定 9 hit 半边，INV-9）", () => {
  test("单轮收敛：sufficient+hit → 建 Case 挂 hypothesis_id + concluded + note 结论落 timeline", async () => {
    const judgeCalls: JudgeInput[] = [];
    const rig1 = rig(scriptedJudge([verdictOf({})], judgeCalls));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    // 单轮收敛：run completed、假设 concluded、无 round_relay（不充分才会接力）
    expect(done.status).toBe("completed");
    expect(rig1.port.status).toBe("concluded");
    expect(rig1.port.calls).toContain(`transition:${HYP}:concluded`);
    expect(eventsHas(rig1.db, done.id, "round_relay")).toBe(false);
    expect(rig1.port.rounds).toHaveLength(1);

    // 建 Case 挂 hypothesis_id（复用 m2 建案公开路径，票 73 列回填）
    expect(rig1.cases.created).toHaveLength(1);
    expect(rig1.cases.created[0]?.hypothesis_id).toBe(HYP);
    expect(rig1.cases.created[0]?.title).toContain(HYP);

    // 收敛结论落 timeline：note 型条目（kind 枚举消费一个空位）+ 机读 structured 齐五痕
    expect(rig1.cases.notes).toHaveLength(1);
    const note = rig1.cases.notes[0]!;
    expect(note.caseId).toBe("case_000001");
    const structured = note.structured as {
      hypothesis_id: string; verdict: string; confidence: number; evidence_hashes: string[]; recommended_actions: string[];
    };
    expect(structured.hypothesis_id).toBe(HYP);
    expect(structured.verdict).toBe("hit");
    expect(structured.evidence_hashes.length).toBeGreaterThanOrEqual(1);
    // 引用痕：evidence_hashes 与子报告 params_hash 同源（paramsHash(task.params)）
    const round = rig1.port.rounds[0]!;
    expect(structured.evidence_hashes).toEqual(round.tasks.map((t) => paramsHash(t.params)));

    // INV-8 审计齐：建案五要素条目可查（objectId=假设、SUCCESS）
    const caseAudit = rig1.audit.entries.find((e) => e.action === "hunt_case_created");
    expect(caseAudit).toMatchObject({ objectId: HYP, objectType: "hypothesis", result: "SUCCESS" });
    expect((caseAudit?.details as { case_id: string }).case_id).toBe("case_000001");
  });

  test("INV-9：结论里的遏制建议只是文本进 timeline——无审批开卡/无动作执行，m2 judge 记录不带建议字段", async () => {
    const CONTAINMENT = "建议隔离主机 h1（文本建议，动作须经人工审批）";
    const judgeCalls: JudgeInput[] = [];
    const rig1 = rig(scriptedJudge([{ ...verdictOf({}), containment_suggestions: [CONTAINMENT] }], judgeCalls));
    rig1.drive();
    await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    // 文本进了 note（recommended_actions），且只有文本：字符串数组，无 tool/params 可执行对
    const structured = rig1.cases.notes[0]!.structured as { recommended_actions: string[] };
    expect(structured.recommended_actions).toEqual([CONTAINMENT]);
    // INV-9：无签名 ApprovalToken 即无效——全审计流无审批/执行动作，register 未被调（hit 半边不入图）
    for (const e of rig1.audit.entries) {
      expect(e.action).not.toContain("approval");
      expect(e.action).not.toContain("execute");
    }
    expect(rig1.register.entries).toHaveLength(0);
    // m2 侧轮次归集的 judge 字段恪守 spec 四字段契约（建议文本不进假设账面）
    const judgeRecord = rig1.port.rounds[0].judge as unknown as Record<string, unknown>;
    expect(Object.keys(judgeRecord).sort()).toEqual(["confidence", "gap_description", "sufficient", "verdict"]);
  });
});

describe("T08 miss_archives（行为约定 9 miss 半边：refuted + note TimelineEntry + register(proposed)）", () => {
  test("sufficient+miss → refuted + 归档 note 条目 + register 调用发生且 proposed", async () => {
    const judgeCalls: JudgeInput[] = [];
    const rig1 = rig(scriptedJudge([verdictOf({ verdict: "miss", confidence: 0.85 })], judgeCalls));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    expect(done.status).toBe("completed");
    expect(rig1.port.status).toBe("refuted"); // cancelled 不冒充 refuted 的对偶：miss 才是 refuted
    expect(rig1.port.calls).toContain(`transition:${HYP}:refuted`);

    // note 型 TimelineEntry：归档案挂 hypothesis_id，证伪摘要可查可溯
    expect(rig1.cases.created[0]?.hypothesis_id).toBe(HYP);
    expect(rig1.cases.notes).toHaveLength(1);
    expect((rig1.cases.notes[0]!.structured as { verdict: string }).verdict).toBe("miss");

    // hypothesis_register 调用发生且一律 proposed（票 79 换真工具；本票咬循环侧语义）
    expect(rig1.register.entries).toHaveLength(1);
    const reg = rig1.register.entries[0]!;
    expect(reg.hypothesis_id).toBe(HYP);
    expect(reg.verdict).toBe("miss");
    expect(reg.status).toBe("proposed");
    expect(reg.evidence_hashes.length).toBeGreaterThanOrEqual(1);
    // INV-8：register 落五要素审计（proposed 态可回放）
    const regAudit = rig1.audit.entries.find((e) => e.action === "hunt_register");
    expect(regAudit).toMatchObject({ objectId: HYP, objectType: "hypothesis", result: "SUCCESS" });
    expect((regAudit?.details as { status: string }).status).toBe("proposed");
  });
});

describe("T17 no_rewrite（行为约定 8：judge 只引用不改写子报告）", () => {
  test("子报告 hash 前后一致：正常裁决路径下状态永持原件，引用痕进审计", async () => {
    const judgeCalls: JudgeInput[] = [];
    const rig1 = rig(scriptedJudge([verdictOf({})], judgeCalls));
    rig1.drive();
    await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    // judge 的输入是原件的消毒副本：result_summary 原样、params_hash 与任务参数同源可复算
    const hashes = rig1.port.rounds[0].tasks.map((t) => paramsHash(t.params));
    expect(judgeCalls[0]!.round_reports.map((r) => r.params_hash)).toEqual(hashes);
    expect(judgeCalls[0]!.round_reports.map((r) => r.result_summary)).toEqual(
      rig1.port.rounds[0].tasks.map((t) => `stub observation for ${t.tool}`),
    );
    // 引用痕进审计：裁决条目带 evidence_hashes（行为约定 8 的 params_hash 引用面）
    const judgeAudit = rig1.audit.entries.find((e) => e.action === "hunt_judge_verdict");
    expect((judgeAudit?.details as { evidence_hashes: string[] }).evidence_hashes).toEqual(hashes);
  });

  test("恶意 adapter 原地改写子报告 → 被留底比对逮住：裁决降级不充分 + DENIED 审计，原件不脏", async () => {
    const judgeCalls: JudgeInput[] = [];
    const rig1 = rig(scriptedJudge([verdictOf({})], judgeCalls, { mutate: true }));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    // 改写被逮住：DENIED 审计 + 降级不充分 → 不收敛（hunting 继续、无 Case 产出）
    const denied = rig1.audit.entries.find((e) => e.action === "hunt_judge_denied");
    expect(denied?.result).toBe("DENIED");
    expect(denied?.details).toMatchObject({ reason: "report_mutated" });
    expect(rig1.port.status).toBe("hunting"); // 改写裁决无效：宁可继续轮次不误收敛
    expect(rig1.cases.created).toHaveLength(0);
    // 原件不脏：改写文本与伪造 hash 不落在任何账面（轮次归集/审计/Case 全链路无污染）
    const round = rig1.port.rounds[0]!;
    expect(JSON.stringify(round)).not.toContain("被改写的完美证据");
    expect(JSON.stringify(round)).not.toContain("deadbeef");
    for (const e of rig1.audit.entries) {
      expect(JSON.stringify(e.details ?? {})).not.toContain("被改写的完美证据");
      expect(JSON.stringify(e.details ?? {})).not.toContain("deadbeef");
    }
    expect(done.status).toBe("completed"); // run 不死（fail-closed ≠ 强杀）
  });
});

describe("轮次转换（行为 9 后半：不充分 → gap → 再组合；降级 fail-closed）", () => {
  test("轮 1 不充分 → gap 激活 → relay；轮 2 planner 输入带结构化缺口（gap→planner 再组合）", async () => {
    const judgeCalls: JudgeInput[] = [];
    const gapCalls: GapInput[] = [];
    const plannerInputs: unknown[] = [];
    const llm: LoopLlm = {
      planner: async (input) => {
        plannerInputs.push(JSON.parse(JSON.stringify(input)));
        return new FakeLoopPlanner().plan(input);
      },
      judge: async (input) => {
        judgeCalls.push(JSON.parse(JSON.stringify(input)));
        // 轮 1 不充分（带缺口）；轮 2 充分命中 → 单轮收敛形态与 T07 同
        return judgeCalls.length === 1
          ? verdictOf({ sufficient: false, verdict: null, confidence: 0.4, gap_description: "A 主机可疑进程的外联未知" })
          : verdictOf({});
      },
      gap: async (input) => {
        gapCalls.push(JSON.parse(JSON.stringify(input)));
        const g: GapOutput = { gap_description: "A 主机可疑进程的外联未知", unknown: "外联目标未查明", suggested_focus: ["outbound:A 主机"] };
        return { ...g, tokens: 9 };
      },
    };
    const rig1 = rig(llm);
    const relay = startRoundRelay({ bus: rig1.bus, ledger: rig1.ledger, door: rig1.orch.door });
    rig1.drive();
    await rig1.runRound(1);
    await tick();
    await rig1.pump();
    await tick();
    rig1.stop();
    relay.stop();

    // 两轮跑通：轮 1 gap 激活恰一次、relay 事件发出；轮 2 收敛 concluded
    expect(gapCalls).toHaveLength(1);
    expect(gapCalls[0]!.judge_output.gap_description).toBe("A 主机可疑进程的外联未知");
    expect(eventsHas(rig1.db, relayRoundId(rig1), "round_relay")).toBe(true);
    expect(rig1.port.rounds.map((r) => r.round_no)).toEqual([1, 2]);
    expect(rig1.port.status).toBe("concluded");
    // 轮 2 planner 输入带结构化缺口（gap → planner 再组合的翻译面）
    expect((plannerInputs[1] as { gap: GapOutput }).gap.suggested_focus).toEqual(["outbound:A 主机"]);
    // 轮次归集的 gap 段随轮落账（下一轮 intake/防转指纹的素材）
    expect(rig1.port.rounds[0].gap?.unknown).toBe("外联目标未查明");
  });

  test("judge_schema_degrade：两次坏输出 → fail-closed 按不充分 + DENIED 审计，轮次照常接力", async () => {
    const rig1 = rig(scriptedJudge([
      { sufficient: "yes", verdict: "hit", confidence: 0.9, gap_description: null, tokens: 5 } as unknown as JudgeOutput & { tokens: number },
      { sufficient: true, verdict: "maybe", confidence: 2, gap_description: null, tokens: 5 } as unknown as JudgeOutput & { tokens: number },
    ], []));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    const denied = rig1.audit.entries.find((e) => e.action === "hunt_judge_denied");
    expect(denied?.result).toBe("DENIED");
    expect(denied?.details).toMatchObject({ reason: "judge_schema_invalid", attempts: 2 });
    // fail-closed：不收敛（hunting），假设不死，relay 接力下一轮
    expect(rig1.port.status).toBe("hunting");
    expect(rig1.cases.created).toHaveLength(0);
    expect(eventsHas(rig1.db, done.id, "round_relay")).toBe(true); // relay 接力下一轮
    expect(done.status).toBe("completed");
  });

  test("low_confidence_downgrade：sufficient+hit 但置信度低于地板 → 降级不充分继续轮次（宁多轮不误收敛）", async () => {
    const rig1 = rig(scriptedJudge([verdictOf({ confidence: 0.3 })], []));
    rig1.drive();
    const done = await rig1.runRound(1);
    await tick();
    await rig1.pump();
    rig1.stop();

    const judgeAudit = rig1.audit.entries.find((e) => e.action === "hunt_judge_verdict");
    expect((judgeAudit?.details as { low_confidence_downgrade: boolean }).low_confidence_downgrade).toBe(true);
    expect(rig1.port.status).toBe("hunting"); // 不收敛
    expect(rig1.cases.created).toHaveLength(0); // 无建案
    expect(eventsHas(rig1.db, done.id, "round_relay")).toBe(true); // 接力继续
  });
});
