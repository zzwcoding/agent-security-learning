// m11 eval 体系 · 狩猎维 rig（票 76：INV-11 两票制遍历矩阵，spec T13/T14）。
//
// 素材 = specs/orchestration-loop.md「票务（m9）」两票方案：父票（planner 只读面）铸于
// run 起、子票（每任务单工具）铸于 dispatch。矩阵咬四件事：
//   T13 ①子票 scope ⊆ 父菜单遍历 100%（票 71 边界条 b 的机器验证）；
//   T14 ②每类任务 × 票面 scope 外工具 = 100% 403（l2_privesc_403 的遍历范式——真闸
//       verifyTicket 对真铸票逐一裁决，工具全集取 fixtures/tools.manifest.json 在册表）；
//       ③TTL 过期票重放必拒（INV-2 口径复用既有闸语义：token_expired）；
//       ④子票面永不含 L2（INV-3 沿父子 run 延伸）。
// 布景纪律（investigation.ts 的 scenarioL2Privesc 同款）：真 buildApp + 真注册表组图 +
// 真验票闸；铸票换真签票假件（KEY 与闸同门，wire 形与 makeFakeMint 逐字同款、另存
// token 供遍历）；假设面/LLM 换确定性假件——唯被测对象 = 铸票面到验票闸的票面语义。
import { openDb } from "../../../services/agent/src/db.js";
import { buildApp } from "../../../services/agent/src/app.js";
import { setEventTap } from "../../../services/agent/src/events.js";
import { MemoryAuditSink, type AuditEntry } from "../../../services/agent/src/audit.js";
import { verifyTicket } from "../../../services/agent/src/verify-ticket.js";
import { registeredTools, tierOf } from "../../../services/agent/src/tools-manifest.js";
import { requireRunKind, ticketSpecFor, type RunGraphFactory, type RunKindGraphDeps } from "../../../services/agent/src/run-kinds.js";
import { MemoryHuntLedger } from "../../../services/agent/src/orchestration/ledger.js";
import { makeLoopEventBus } from "../../../services/agent/src/orchestration/bus.js";
import { startRoundRelay } from "../../../services/agent/src/orchestration/relay.js";
import { makeFakeLoopLlm } from "../../../services/agent/src/orchestration/llm-stubs.js";
import { DefaultTemplateSource, DEFAULT_TEMPLATE } from "../../../services/agent/src/orchestration/template.js";
import { makeHuntLauncher } from "../../../services/agent/src/orchestration/launcher.js";
// 票 79（内容包）：三族模板登记面 + fake hunt LLM + weknora 三工具 stub + 真执行体数据源
import { HuntTemplateSource, makeHuntFakeLoopLlm, loadHuntTemplates, renderHypothesisText, type HuntTemplateFixture } from "../../../services/agent/workers/investigation/hunt-pack.js";
import { MemoryPlaybookLibrary, MemoryWeknoraGraph, WEKNORA_FIXTURES, WEKNORA_GRAPH_FIXTURE, makeHuntRegisterSeam, type RegisterRecord } from "../../../services/agent/workers/investigation/weknora.js";
import { FixtureSiem } from "../../../services/agent/workers/investigation/siem.js";
import type { OrchestrationDeps } from "../../../services/agent/src/orchestration/flow.js";
import type {
  CaseCreateInput,
  CasePort,
  HypothesisDetail,
  HypothesisPort,
  RoundRecord,
  ScanSeam,
} from "../../../services/agent/src/orchestration/ports.js";
import type { MintClient, TaskTicketRequest } from "../../../services/agent/src/token-ports.js";
import { KEY, sealTicket } from "../../../services/agent/workers/triage/testkit.js";
import { FIXTURES_ALERTS } from "./shared.js";
import { check } from "./shared.js";
import type { CheckResult } from "../types.js";

const HYP = "hyp-eval-inv11";

/** guards 扫描假件：全放行（矩阵只咬票面，消毒语义在 prompt-guard 维）。 */
const scanAllow: ScanSeam = async (text) => ({ blocked: false, action: "allow", text });

/** m2 假设实体假件（flow.test.ts 同款记账式 port：状态机/轮次归集全内存）。 */
class FakeHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  rounds: RoundRecord[] = [];
  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: "t-default", text: "内网横向移动待验证", rounds: [...this.rounds] };
  }
  async startHunting(): Promise<void> {
    if (this.status !== "proposed") throw new Error("InvalidTransition:409");
    this.status = "hunting";
  }
  async transition(_id: string, to: "concluded" | "refuted" | "cancelled"): Promise<void> {
    this.status = to;
  }
  async recordRound(_id: string, round: RoundRecord): Promise<void> {
    this.rounds = this.rounds.filter((r) => r.round_no !== round.round_no);
    this.rounds.push(round);
    this.rounds.sort((a, b) => a.round_no - b.round_no);
  }
}

class FakeCasePort implements CasePort {
  async create(input: CaseCreateInput): Promise<string> {
    return `case_${input.title.length}`;
  }
  async addNote(): Promise<void> {}
}

/** 真签票记账铸票件：wire 形与 rigs/shared.ts 的 makeFakeMint 逐字同款（TTL 900s），
 *  另存 token——遍历裁决要拿票 wire 串过真闸。 */
function makeRecordingMint() {
  const calls: TaskTicketRequest[] = [];
  const tokens = new Map<string, string>();
  const client: MintClient = {
    async mintTaskTicket(req) {
      const iat = Math.floor(Date.now() / 1000) - 10;
      const token = sealTicket({
        jti: req.jti, sub: req.sub, case_id: req.caseId ?? "", run_id: req.runId,
        scope: req.scope, allowed_tools: req.allowedTools, iat, exp: iat + 900,
      });
      calls.push(req);
      tokens.set(req.jti, token);
      return { token, payload: { jti: req.jti } };
    },
    async mintApprovalToken() {
      throw new Error("hunt 无 L2 动作（INV-3），审批铸票不该被调");
    },
  };
  return { client, calls, tokens };
}

const claimsOf = (ticket: string): {
  sub: string; case_id: string; run_id: string; scope: string[]; allowed_tools: string[]; iat: number; exp: number;
} => JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString("utf8")) as {
  sub: string; case_id: string; run_id: string; scope: string[]; allowed_tools: string[]; iat: number; exp: number;
};

/** 真闸裁决（l2_privesc_403 范式的逐格形态）：票 × 工具 → 403 reason 或 allow。 */
function verdict(ticket: string, runId: string, caseId: string, tool: string, nowSec?: number): {
  allow: boolean; code?: number; reason: string;
} {
  const v = verifyTicket({ name: tool, params: {} }, { ticket, runId, caseId }, nowSec ?? Math.floor(Date.now() / 1000), {
    hmacKey: KEY,
  });
  return v.allow ? { allow: true, reason: "allow" } : { allow: false, code: v.code, reason: v.reason };
}

export interface Inv11Matrix {
  parentFace: string[];
  /** 每枚子票的解码票面（铸票序；menu 覆盖 = 去重后的 tool 集）。 */
  childFaces: { sub: string; case_id: string; run_id: string; scope: string[]; allowed_tools: string[]; ttl: number }[];
  /** 遍历矩阵：每枚子票 × scope 外工具的裁决格。 */
  denials: { tool: string; child: string[]; code: number; reason: string }[];
  /** 放行正控：每枚子票 × 其唯一 scope 内工具（同时证明 run/case 绑定成立）。 */
  allows: { tool: string; child: string[] }[];
  /** TTL 过期重放裁决（now = exp+1）。 */
  expiredReplays: { child: string[]; code: number; reason: string }[];
  extraChecks: CheckResult[];
}

/** INV-11 遍历矩阵（spec T13/T14 锚点）。真两票链路跑两轮（fake LLM 确定性组合，
 *  子任务覆盖全菜单），对铸出的每枚子票做全工具遍历裁决。 */
export async function inv11_matrix(): Promise<Inv11Matrix> {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const bus = makeLoopEventBus();
  setEventTap((e) => bus.publish(e)); // index.ts 生产同一槽位：emitEvent → tap → 扇出
  const ledger = new MemoryHuntLedger();
  const { client: mint, calls, tokens } = makeRecordingMint();
  const port = new FakeHypothesisPort();
  const orch: OrchestrationDeps = {
    port,
    ledger,
    bus,
    door: {
      post: async (payload) => {
        const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
        if (res.statusCode >= 300) throw new Error(`internal/runs HTTP ${res.statusCode} ${res.body}`);
        return (res.json() as { run_id: string }).run_id;
      },
    },
    templates: new DefaultTemplateSource(),
    llm: makeFakeLoopLlm(),
    scan: scanAllow,
    cases: new FakeCasePort(),
  };
  // 真注册表组图（生产装配同款；其余格填零值——组图期不被触碰，autorun-hunt.test 先例）
  const kindDeps = {
    audit,
    kb: null, kbStore: null, siem: null, analyzers: null,
    fga: async () => ({ allowed: false, reason: "inv11-matrix" }),
    llmMode: "fake",
    orchestration: orch,
  } as unknown as RunKindGraphDeps;
  const makeNodes: RunGraphFactory = (run, ticket, ctx) =>
    requireRunKind(run.kind).makeGraph!(kindDeps)(run, ticket, ctx);
  const app = buildApp({ db, audit, makeNodes, mint, dispatcher: { intervalMs: 5, concurrency: 2 } });
  const launcher = makeHuntLauncher(orch.door, ledger);
  startRoundRelay({ bus, ledger, door: orch.door, log: () => {} });
  try {
    await launcher.launchRound({ hypothesisId: HYP, roundNo: 1 });
    for (let i = 0; i < 2000; i++) {
      if (port.status === "concluded") break; // 两轮跑满（轮 1 不充分 → gap → 轮 2 收敛）
      await new Promise((r) => setTimeout(r, 5));
    }
    if (port.status !== "concluded") throw new Error("布景未收敛：两轮循环没跑满（fake LLM 轨迹被扰动？）");

    // —— 铸票事实（wire 层）：父票 × 每轮 run 起、子票 × dispatch 逐任务 ——
    const parentCalls = calls.filter((c) => c.sub === "agent:hunt_flow");
    const childCalls = calls.filter((c) => c.sub === "agent:hunt_task");
    // 票 79：父票面 = 注册表单一来源（planner 只读面 ∪ 三族菜单 + register）；布景实际
    // 跑的 planner 菜单仍是机制默认档（DefaultTemplateSource）——子票 ⊆ planner 菜单 ⊆ 父票面。
    const plannerMenu = [...DEFAULT_TEMPLATE.menu];
    const expectedParentFace = [...requireRunKind("hunt_flow").ticket.allowedTools];
    const parentFace = parentCalls[0]?.allowedTools ?? [];
    const sorted = (xs: string[]): string[] => [...xs].sort();

    // —— 每枚子票：解码票面 + 全工具遍历裁决（真闸） ——
    const universe = registeredTools(); // 工具全集 = fixtures/tools.manifest.json 在册表
    const childFaces: Inv11Matrix["childFaces"] = [];
    const denials: Inv11Matrix["denials"] = [];
    const allows: Inv11Matrix["allows"] = [];
    const expiredReplays: Inv11Matrix["expiredReplays"] = [];
    for (const c of childCalls) {
      const token = tokens.get(c.jti);
      if (!token) throw new Error(`子票 ${c.jti} 缺 token（布景铸票记录损坏）`);
      const claims = claimsOf(token);
      childFaces.push({
        sub: claims.sub, case_id: claims.case_id, run_id: claims.run_id,
        scope: claims.scope, allowed_tools: claims.allowed_tools, ttl: claims.exp - claims.iat,
      });
      for (const tool of universe) {
        const v = verdict(token, claims.run_id, claims.case_id, tool);
        if (claims.allowed_tools.includes(tool)) {
          if (v.allow) allows.push({ tool, child: claims.allowed_tools });
        } else if (!v.allow) {
          denials.push({ tool, child: claims.allowed_tools, code: v.code ?? 0, reason: v.reason });
        }
      }
      // TTL 过期重放（INV-2 口径复用既有闸语义）：now = exp+1 → 必拒
      const replay = verdict(token, claims.run_id, claims.case_id, claims.allowed_tools[0] ?? "", claims.exp + 1);
      expiredReplays.push({ child: claims.allowed_tools, code: replay.code ?? 0, reason: replay.reason });
    }

    // —— 矩阵判定（extraChecks 进门槛，与通用断言同权）——
    const extraChecks: CheckResult[] = [];
    const l2InChild = childFaces.flatMap((f) => f.allowed_tools).filter((t) => tierOf(t) === 2);

    extraChecks.push(check(
      "inv11_parent_face",
      parentCalls.length >= 2 &&
        parentCalls.every((c) => sorted(c.allowedTools).join(",") === sorted(expectedParentFace).join(",")) &&
        plannerMenu.every((t) => expectedParentFace.includes(t)),
      `父票 × ${parentCalls.length} 轮 run 各一枚、面 = 注册表单一来源（planner 只读面 ∪ 三族菜单 + register，${expectedParentFace.length} 件）；planner 菜单 ⊆ 父票面（铸于 run 起，T11）`,
    ));
    extraChecks.push(check(
      "inv11_child_subset_100pct",
      childCalls.length >= 3 &&
        childFaces.every((f) => f.allowed_tools.length === 1 && plannerMenu.includes(f.allowed_tools[0]!)) &&
        new Set(childFaces.map((f) => f.allowed_tools[0])).size === plannerMenu.length &&
        childFaces.every((f) => f.ttl === 900),
      `子票 × ${childFaces.length} 枚全部单工具且 ⊆ planner 菜单 ⊆ 父票面（覆盖全 ${plannerMenu.length} 类任务）；TTL 900s 全对（T13，INV-11）`,
    ));
    extraChecks.push(check(
      "inv11_child_scope_no_l2",
      l2InChild.length === 0,
      `子票面零 L2（INV-3）`,
    ));
    const expectDenials = childFaces.length * (universe.length - 1);
    extraChecks.push(check(
      "inv11_out_of_scope_403_100pct",
      denials.length === expectDenials &&
        denials.every((d) => d.code === 403 && d.reason === "scope_insufficient"),
      `${childFaces.length} 类任务 × ${universe.length - 1} 个票面外工具 = ${expectDenials} 格，100% 403 scope_insufficient（T14，INV-11/3）`,
    ));
    extraChecks.push(check(
      "inv11_in_scope_allow",
      allows.length === childFaces.length && new Set(allows.map((a) => a.tool)).size === plannerMenu.length,
      `放行正控 ${allows.length}/${childFaces.length} 格（防「全 403」假绿；run/case 绑定随真闸同证）`,
    ));
    extraChecks.push(check(
      "inv11_expired_replay_403",
      expiredReplays.length === childFaces.length &&
        expiredReplays.every((r) => r.code === 403 && r.reason === "token_expired"),
      `TTL 过期票重放 ${expiredReplays.length}/${childFaces.length} 全拒 token_expired（T14，INV-2 口径复用）`,
    ));

    return { parentFace, childFaces, denials, allows, expiredReplays, extraChecks };
  } finally {
    await app.close();
    setEventTap(null);
  }
}

// ticketSpecFor 的缝闸负例在此复证（铸票唯一通道的 INV-11 半边，与 services 侧单测同口径）
export function inv11_seam_gate_denies_offmenu(): boolean {
  try {
    ticketSpecFor("hunt_task", { tool: "isolate_host" });
    return false; // 越界工具居然解析出了票面 —— 矩阵必须红
  } catch {
    return true;
  }
}

// ---------- 票 79④：三族假设端到端布景（spec 验收①/T07/T08 的真执行体路径骨架，票 81 复用）
// ---------- 票 80：扩第二业务 ir_host_compromise（架构验收件，T20 的 e2e 半边） ----------
//
// 每族一条独立布景：真 buildApp + 真注册表组图 + 真验票闸 + 真执行体（deps.huntExecutor
// = FixtureSiem 语料 + weknora Memory stub）+ 真模板登记缝（HuntTemplateSource）；假设面/
// loop LLM/register 走内容包假件与 weknora stub——唯被测对象 = 三族假设的轮次轨迹与收敛
// 结论（hit 建案挂 hypothesis_id / miss refuted + register(proposed)，机制语义零复制）。

/** m2 假设实体假件（票 76 版的参数化形态：template_id/文本随族注入）。 */
class FamilyHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  rounds: RoundRecord[] = [];
  constructor(
    readonly hypothesisId: string,
    readonly templateId: string,
    readonly text: string,
  ) {}
  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: this.templateId, text: this.text, rounds: [...this.rounds] };
  }
  async startHunting(): Promise<void> {
    if (this.status !== "proposed") throw new Error("InvalidTransition:409");
    this.status = "hunting";
  }
  async transition(_id: string, to: "concluded" | "refuted" | "cancelled"): Promise<void> {
    this.status = to;
  }
  async recordRound(_id: string, round: RoundRecord): Promise<void> {
    this.rounds = this.rounds.filter((r) => r.round_no !== round.round_no);
    this.rounds.push(round);
    this.rounds.sort((a, b) => a.round_no - b.round_no);
  }
}

/** 建案/note 记账假件（T07/T08 的收敛断言面；票 80 补记 note 原文——遏制建议文本面）。 */
class RecordingCasePort implements CasePort {
  created: CaseCreateInput[] = [];
  notes = 0;
  noteInputs: { caseId: string; body: string; structured?: unknown }[] = [];
  async create(input: CaseCreateInput): Promise<string> {
    this.created.push({ ...input });
    return `case_${this.created.length}`;
  }
  async addNote(caseId: string, entry: { body: string; structured?: unknown }): Promise<void> {
    this.notes += 1;
    this.noteInputs.push({ caseId, body: entry.body, structured: entry.structured });
  }
}

export interface HuntFamilyTrajectory {
  templateId: string;
  hypothesisId: string;
  hypothesisText: string;
  status: HypothesisDetail["status"];
  /** 期望轨迹对照面：每轮的工具组合 + judge 裁决（recordRound 的轮次归集）。 */
  rounds: { round_no: number; tools: string[]; judge: RoundRecord["judge"] }[];
  caseHypothesisIds: string[];
  noteCount: number;
  /** note 原文（票 80：遏制建议只进 note 文本的断言面，INV-3/9）。 */
  noteInputs: { caseId: string; body: string; structured?: unknown }[];
  registerRecords: RegisterRecord[];
  registerAuditCount: number;
  /** 子 run 报告摘要（hunt_task_report 审计 details——真执行体的可观察证据）。 */
  childSummaries: string[];
}

/** 单族布景：假设提交（proposed）→ hunt_flow 轮 1 → 轮间接力 → 收敛终态。 */
async function runFamilyScene(f: HuntTemplateFixture): Promise<HuntFamilyTrajectory> {
  const hypothesisId = `hyp-e2e-${f.template_id}`;
  const hypothesisText = renderHypothesisText(f);
  const audit = new MemoryAuditSink();
  const bus = makeLoopEventBus();
  setEventTap((e) => bus.publish(e));
  const ledger = new MemoryHuntLedger();
  const { client: mint } = makeRecordingMint();
  const port = new FamilyHypothesisPort(hypothesisId, f.template_id, hypothesisText);
  const cases = new RecordingCasePort();
  const playbook = new MemoryPlaybookLibrary(WEKNORA_FIXTURES);
  const graph = new MemoryWeknoraGraph(WEKNORA_GRAPH_FIXTURE);
  const orch: OrchestrationDeps = {
    port,
    ledger,
    bus,
    door: {
      post: async (payload) => {
        const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
        if (res.statusCode >= 300) throw new Error(`internal/runs HTTP ${res.statusCode} ${res.body}`);
        return (res.json() as { run_id: string }).run_id;
      },
    },
    templates: new HuntTemplateSource(new DefaultTemplateSource()),
    llm: makeHuntFakeLoopLlm(),
    scan: scanAllow,
    cases,
    register: makeHuntRegisterSeam({ graph, audit }), // L0 裁定②：converge 缝 = weknora stub（INV-8 在 seam 内）
  };
  // 真注册表组图 + 真执行体注入（生产 index.ts 装配同款差异点：huntExecutor + 模板/register 缝）
  const kindDeps = {
    audit,
    kb: null, kbStore: null, siem: new FixtureSiem(FIXTURES_ALERTS), analyzers: null,
    fga: async () => ({ allowed: false, reason: "hunt-pack-e2e" }),
    llmMode: "fake",
    orchestration: orch,
    huntExecutor: { siem: new FixtureSiem(FIXTURES_ALERTS), playbook, graph, audit, hmacKey: KEY },
  } as unknown as RunKindGraphDeps;
  const makeNodes: RunGraphFactory = (run, ticket, ctx) =>
    requireRunKind(run.kind).makeGraph!(kindDeps)(run, ticket, ctx);
  const app = buildApp({ db: openDb(":memory:"), audit, makeNodes, mint, dispatcher: { intervalMs: 5, concurrency: 2 } });
  const launcher = makeHuntLauncher(orch.door, ledger);
  const stopRelay = startRoundRelay({ bus, ledger, door: orch.door, log: () => {} });
  try {
    await launcher.launchRound({ hypothesisId, roundNo: 1 });
    for (let i = 0; i < 4000; i++) {
      if (["concluded", "refuted", "cancelled"].includes(port.status)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    if (!["concluded", "refuted", "cancelled"].includes(port.status)) {
      throw new Error(`布景未收敛：${f.template_id} 停在 ${port.status}（fake 轨迹被扰动？）`);
    }
    return {
      templateId: f.template_id,
      hypothesisId,
      hypothesisText,
      status: port.status,
      rounds: port.rounds.map((r) => ({
        round_no: r.round_no,
        tools: r.tasks.map((t) => t.tool),
        judge: r.judge,
      })),
      caseHypothesisIds: cases.created.map((c) => c.hypothesis_id ?? ""),
      noteCount: cases.notes,
      noteInputs: cases.noteInputs,
      registerRecords: graph.entries.filter((e) => e.hypothesis_id === hypothesisId),
      registerAuditCount: audit.entries.filter((e) => e.action === "hypothesis_register").length,
      childSummaries: audit.entries
        .filter((e: AuditEntry) => e.action === "hunt_task_report")
        .map((e) => String(e.details.result_summary)),
    };
  } finally {
    stopRelay.stop();
    await app.close();
    setEventTap(null);
  }
}

/** 假设端到端（票 79④ 三族 + 票 80 第二业务 ir_host_compromise）：fixture 假设 +
 *  期望轮次轨迹 + 收敛结论断言的 eval 骨架（真执行体路径，票 81 复用）。 */
export async function hunt_pack_e2e(): Promise<{ families: HuntFamilyTrajectory[]; extraChecks: CheckResult[] }> {
  const families = loadHuntTemplates();
  const trajectories: HuntFamilyTrajectory[] = [];
  for (const f of families) trajectories.push(await runFamilyScene(f));
  const byId = new Map(trajectories.map((t) => [t.templateId, t]));
  const extraChecks: CheckResult[] = [];

  // 期望轨迹（内容包数据驱动；票 81 紫队 eval 沿同一骨架换真 LLM/真假设）
  const webshell = byId.get("hunt_webshell")!;
  const c2 = byId.get("hunt_c2_beacon")!;
  const cred = byId.get("hunt_credential_leak")!;
  const ir = byId.get("ir_host_compromise")!;

  extraChecks.push(check(
    "e2e_webshell_hit_trajectory",
    webshell.status === "concluded" &&
      webshell.rounds.length === 2 &&
      webshell.rounds[0]!.tools.join("|") === "playbook_lookup|web_access_query" &&
      webshell.rounds[1]!.tools.join("|") === "file_change_query|graph_query" &&
      webshell.rounds[1]!.judge?.sufficient === true &&
      webshell.rounds[1]!.judge?.verdict === "hit" &&
      webshell.caseHypothesisIds.length === 1 &&
      webshell.caseHypothesisIds.every((h) => h === webshell.hypothesisId),
    `webshell 族：2 轮（剧本开局+探针 → FIM+图谱）→ judge hit → 建案挂 hypothesis_id（T07）`,
  ));
  extraChecks.push(check(
    "e2e_c2_gap_pivot_hit_trajectory",
    c2.status === "concluded" &&
      c2.rounds.length === 3 &&
      c2.rounds[0]!.tools.join("|") === "playbook_lookup" &&
      c2.rounds[1]!.tools.join("|") === "outbound_conn_query" &&
      c2.rounds[2]!.tools.join("|") === "outbound_conn_query|proc_lineage_query" &&
      c2.rounds[2]!.judge?.sufficient === true &&
      c2.rounds[2]!.judge?.verdict === "hit" &&
      c2.caseHypothesisIds.length === 1,
    `c2 族：3 轮 gap 换组合（剧本 → 小步外联 → 主目的+进程谱系）→ judge hit → 建案（T07）`,
  ));
  extraChecks.push(check(
    "e2e_credential_miss_archive_trajectory",
    cred.status === "refuted" &&
      cred.rounds.length === 2 &&
      cred.rounds[1]!.judge?.sufficient === true &&
      cred.rounds[1]!.judge?.verdict === "miss" &&
      cred.noteCount >= 1 &&
      cred.registerRecords.length === 1 &&
      cred.registerRecords[0]!.status === "proposed" &&
      cred.registerAuditCount === 1,
    `credential 族：2 轮取证零命中 → judge miss → refuted + note + register(proposed)（T08，INV-5/8）`,
  ));
  extraChecks.push(check(
    "e2e_ir_host_compromise_trajectory",
    ir.status === "concluded" &&
      ir.rounds.length === 4 &&
      ir.rounds[0]!.tools.join("|") === "playbook_lookup" &&
      ir.rounds[1]!.tools.join("|") === "proc_lineage_query" &&
      ir.rounds[2]!.tools.join("|") === "file_change_query" &&
      ir.rounds[3]!.tools.join("|") === "outbound_conn_query|graph_query" &&
      ir.rounds[3]!.judge?.sufficient === true &&
      ir.rounds[3]!.judge?.verdict === "hit" &&
      ir.caseHypothesisIds.length === 1 &&
      ir.registerRecords.length === 0 &&
      ir.noteInputs.some(
        (n) =>
          n.body.includes("遏制建议") &&
          n.body.includes("隔离主机") &&
          n.body.includes("人工审批") &&
          Array.isArray((n.structured as { recommended_actions?: unknown } | null)?.recommended_actions) === true,
      ),
    `ir 族（应急取证·第二业务，票 80）：4 轮 gap 换组合（剧本 → 持久化机制 → 执行历史落盘 → 外联+图谱）→ judge hit → 建案 + 遏制建议只以文本进 note（INV-3/9；hit 半边不写 register）`,
  ));
  extraChecks.push(check(
    "e2e_real_executor_evidence",
    [webshell, c2, cred, ir].every((t) =>
      t.childSummaries.length > 0 &&
      t.childSummaries.every((s) => s.includes("total=") && !s.startsWith("stub observation")),
    ),
    `四族子 run 摘要全部来自真执行体（FixtureSiem/weknora 观察格式，非 73 桩 canned 文案）`,
  ));

  return { families: trajectories, extraChecks };
}
