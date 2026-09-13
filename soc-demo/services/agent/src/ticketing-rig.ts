// 票 76 · 两票制铸票测试布景（orchestration/ticketing.test.ts / ticketing-gateway.test.ts
// 共用）。测试基建位在 src/ 根（testkit.ts 同位）——机制目录（orchestration/）有 T19
// 静态闸（非 test 源码禁定时器）与 R11（禁 import 铸票客户端）两道闸，布景不该住在闸区。
//
// 本件是布景不是被测件：真注册表组图 + 假假设面假 LLM + 门走 app.inject 正门（铸票全
// 在正门内，R11 铸票唯一通道不动）。铸票客户端一概不 import——mint 由调用方注入
//（fake 腿 = 真签票假 gateway；真 gateway 腿 = HttpMintClient；椒图腿 = JiaoTuMintClient，
// 三个都在各自的测试文件里装配）。时序观察点 = 同一根 order 轴：铸票调用 /组图
//（makeNodes）/planner 出组合/dispatch 拉起（门）全在轴上可排序。
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { buildApp } from "./app.js";
import { setEventTap } from "./events.js";
import { verifyTicket } from "./verify-ticket.js";
import { requireRunKind, type RunGraphFactory, type RunKindGraphDeps } from "./run-kinds.js";
import { MemoryHuntLedger } from "./orchestration/ledger.js";
import { makeLoopEventBus } from "./orchestration/bus.js";
import { startRoundRelay } from "./orchestration/relay.js";
import { makeFakeLoopLlm } from "./orchestration/llm-stubs.js";
import { DefaultTemplateSource } from "./orchestration/template.js";
import { makeHuntLauncher } from "./orchestration/launcher.js";
import type { OrchestrationDeps } from "./orchestration/flow.js";
import type {
  CaseCreateInput,
  CasePort,
  HypothesisDetail,
  HypothesisPort,
  RoundRecord,
  ScanSeam,
} from "./orchestration/ports.js";
import type { MintClient, TaskTicketRequest } from "./token-ports.js";
import { makeTaskTicket } from "../workers/triage/testkit.js";

export const HYP = "hyp-t76";
export const MENU = [...requireRunKind("hunt_flow").ticket.allowedTools]; // planner 只读面（父票菜单）

/** guards 扫描假件（票 74 消毒缝）：全放行。 */
const scanAllow: ScanSeam = async (text) => ({ blocked: false, action: "allow", text });

/** m2 假设实体假件（flow.test.ts 同款记账式 port）。 */
export class FakeHypothesisPort implements HypothesisPort {
  status: HypothesisDetail["status"] = "proposed";
  rounds: RoundRecord[] = [];
  async getDetail(id: string): Promise<HypothesisDetail | null> {
    return { id, status: this.status, template_id: "t-default", text: "内网横向移动待验证", rounds: [...this.rounds] };
  }
  async startHunting(): Promise<void> {
    if (this.status !== "proposed") throw new Error("InvalidTransition:409");
    this.status = "hunting";
  }
  async transition(id: string, to: "concluded" | "refuted" | "cancelled"): Promise<void> {
    this.status = to;
  }
  async recordRound(id: string, round: RoundRecord): Promise<void> {
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

/** 真签票的假 gateway（fake 腿默认底座）：verifyTicket 可真验。 */
export const fakeGatewayMint: MintClient = {
  async mintTaskTicket(req) {
    return {
      token: makeTaskTicket(req.runId, req.allowedTools, { sub: req.sub, caseId: req.caseId ?? "", jti: req.jti }),
      payload: { jti: req.jti },
    };
  },
  async mintApprovalToken() {
    throw new Error("hunt 无 L2 动作（INV-3），审批铸票不该被调");
  },
};

export interface Rig {
  db: DB;
  audit: MemoryAuditSink;
  ledger: MemoryHuntLedger;
  port: FakeHypothesisPort;
  order: string[];
  /** makeNodes 捕获的每 run 票（真 gateway 腿的取证面：kind + 组图时拿到的票 wire 串）。 */
  tickets: { kind: string; runId: string; ticket: string }[];
  launchRound(): Promise<string>;
  post(payload: Record<string, unknown>): Promise<{ statusCode: number; json: Record<string, unknown> }>;
  /** 等假设到指定终态（轮间 relay 跑完的确定性锚）。 */
  waitUntil(fn: () => boolean, what: string): Promise<void>;
  waitAllSettled(): Promise<void>;
  close(): Promise<void>;
}

export function rig(base: MintClient, opts: { failSub?: string } = {}): Rig {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const bus = makeLoopEventBus();
  setEventTap((e) => bus.publish(e)); // index.ts 生产同一槽位：emitEvent → tap → 扇出
  const ledger = new MemoryHuntLedger();
  const order: string[] = [];
  const tickets: Rig["tickets"] = [];
  // 记账包装：铸票成功才进 order（失败即无记录——无票即无时序位次）
  const mint: MintClient = {
    async mintTaskTicket(req: TaskTicketRequest) {
      if (req.sub === opts.failSub) throw new Error("gateway mint failed: HTTP 503（注入的铸票故障）");
      const out = await base.mintTaskTicket(req);
      order.push(`mint:${req.sub}:${req.allowedTools.join("+")}`);
      return out;
    },
    async mintApprovalToken(req) {
      return base.mintApprovalToken(req);
    },
  };
  const port = new FakeHypothesisPort();
  const orch: OrchestrationDeps = {
    port,
    ledger,
    bus,
    door: {
      post: async (payload) => {
        order.push(`door:${payload.kind}${payload.task ? `:${payload.task.tool}` : ""}`);
        const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
        if (res.statusCode >= 300) throw new Error(`internal/runs HTTP ${res.statusCode} ${res.body}`);
        return (res.json() as { run_id: string }).run_id;
      },
    },
    templates: new DefaultTemplateSource(),
    llm: (() => {
      const fake = makeFakeLoopLlm();
      let n = 0;
      return {
        ...fake,
        planner: async (input) => {
          const out = await fake.planner(input);
          order.push(`planner:${++n}:${out.tasks.map((t) => t.tool).join("+")}`);
          return out;
        },
      };
    })(),
    scan: scanAllow,
    cases: new FakeCasePort(),
  };
  // 真注册表组图（autorun-hunt.test.ts 生产装配同款）；非 hunt kind 回空图即刻终态
  //（本票不测分诊行为，只咬铸票时序——空图 = 旧 kind 时序断言的最小布景）。
  const kindDeps = {
    audit,
    kb: null, kbStore: null, siem: null, analyzers: null,
    fga: async () => ({ allowed: false, reason: "ticketing-test" }),
    llmMode: "fake",
    orchestration: orch,
  } as unknown as RunKindGraphDeps;
  const makeNodes: RunGraphFactory = (run, ticket, ctx) => {
    tickets.push({ kind: run.kind, runId: run.id, ticket });
    order.push(`graph:${run.kind}`);
    if (run.kind !== "hunt_flow" && run.kind !== "hunt_task") return [];
    return requireRunKind(run.kind).makeGraph!(kindDeps)(run, ticket, ctx);
  };
  const app = buildApp({ db, audit, makeNodes, mint, dispatcher: { intervalMs: 5, concurrency: 2 } });
  const launcher = makeHuntLauncher(orch.door, ledger);
  startRoundRelay({ bus, ledger, door: orch.door, log: () => {} }); // 轮间接力（生产装配同款）
  return {
    db, audit, ledger, port, order, tickets,
    launchRound: () => launcher.launchRound({ hypothesisId: HYP, roundNo: 1 }),
    post: async (payload) => {
      const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
      return { statusCode: res.statusCode, json: res.json() as Record<string, unknown> };
    },
    async waitUntil(fn, what) {
      for (let i = 0; i < 2000; i++) {
        if (fn()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`等待超时：${what}`);
    },
    async waitAllSettled() {
      for (let i = 0; i < 2000; i++) {
        const rows = db.prepare("SELECT status FROM runs").all() as { status: string }[];
        if (rows.length > 0 && rows.every((r) => r.status !== "queued" && r.status !== "running")) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("runs 未全部落定（10s 超时）");
    },
    close: () => app.close(),
  };
}

export const childMints = (order: string[]): string[] =>
  order.filter((o) => o.startsWith("mint:agent:hunt_task:"));
export const plannedRounds = (order: string[]): string[][] =>
  order.filter((o) => o.startsWith("planner:")).map((o) => o.split(":")[2]!.split("+"));

/** 真闸裁决 helper（真 gateway 腿取证用）：票 × 工具 → 是否放行。
 *  票 90 正名：hunt 两票不绑案件（case_id claim 随承载清偿为空）——验票 ctx 不再
 *  钉 caseId（此前钉 HYP 是借位承载的布景残留），按票面裁决只咬工具 scope + run 绑定。 */
export function verifyAllows(ticket: string, tool: string, runId: string, key: string): boolean {
  return verifyTicket(
    { name: tool, params: {} },
    { ticket, runId },
    Math.floor(Date.now() / 1000),
    { hmacKey: key },
  ).allow;
}
