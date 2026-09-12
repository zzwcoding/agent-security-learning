// 票 73 · L0 派发中裁决①的契约测试：hypothesis.created 的 autorun 消费支线。
//
// T01 生产路径闭合：POST /api/v1/hypotheses（真 case-backend 子进程，outbox 同事务半边）
// → pollAutorunOnce（真 HttpOutboxReader 读 GET /api/v1/events）→ 防重两道闸 →
// huntLauncher.launchRound（door 正门 + 簿记锚）→ hunt_flow queued→running → intake 节点
// 前置 hunting（经真 m2 REST PATCH，INV-10 真迁移）→ 轮 1 跑完轮次归集落账。
// 同一事件重放（游标丢失重放，autorun.test.ts 先例口径）不重复拉起——两道闸分别咬：
//   闸① runs 表 hunt kind 查重（run 在册 → run_exists）；
//   闸② hunt_run_links.findByRound（闸① 因 run failed 放行时，簿记锚仍挡 → round_exists，
//        证明缺一不可）。
// m2↔m3 的 wire 契约（outbox payload {hypothesisId, templateId}）由本测试打真出站消费
// 锁定；m2 侧「POST 与 outbox 同事务」由 case-backend hypotheses.test.ts 锁定。
import { describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { getRun } from "./runs.js";
import { buildApp } from "./app.js";
import { eventsAfter, setEventTap } from "./events.js";
import {
  AUTORUN_CURSOR,
  dbCursorStore,
  HttpOutboxReader,
  pollAutorunOnce,
  runsLookup,
  type AutorunDeps,
} from "./autorun.js";
import { requireRunKind, type RunGraphFactory, type RunKindGraphDeps } from "./run-kinds.js";
import { MemoryHuntLedger } from "./orchestration/ledger.js";
import { makeLoopEventBus } from "./orchestration/bus.js";
import { makeHuntLauncher } from "./orchestration/launcher.js";
import { makeFakeLoopLlm } from "./orchestration/llm-stubs.js";
import { DefaultTemplateSource } from "./orchestration/template.js";
import { HttpHypothesisPort } from "./orchestration/hypothesis-port.js";
import type { OrchestrationDeps } from "./orchestration/flow.js";
import type { MintClient } from "./token-ports.js";
import { makeTaskTicket, startCaseBackend, type CaseBackend } from "../workers/triage/testkit.js";
import { waitForRunTerminal } from "./testkit.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Rig {
  db: DB;
  audit: MemoryAuditSink;
  ledger: MemoryHuntLedger;
  app: ReturnType<typeof buildApp>;
  deps: (reader: AutorunDeps["events"], cursor: AutorunDeps["cursor"]) => AutorunDeps;
}

/** agent 侧生产装配：真注册表组图 + 真 m2 REST 假设面 + 真 outbox 读口；
 *  只有铸票换测试固定密钥签票（hunt 桩节点不验票，票 76 的遍历矩阵另咬）。 */
function rig(cb: CaseBackend, over: { llm?: OrchestrationDeps["llm"] } = {}): Rig {
  const db = openDb(":memory:");
  const audit = new MemoryAuditSink();
  const bus = makeLoopEventBus();
  setEventTap((e) => bus.publish(e)); // index.ts 生产同一槽位：emitEvent → tap → 扇出
  const ledger = new MemoryHuntLedger();
  const orch: OrchestrationDeps = {
    port: new HttpHypothesisPort(cb.url),
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
    llm: over.llm ?? makeFakeLoopLlm(),
  };
  // hunt 两工厂只读 audit + orchestration 两格（注册表 hunt_flow/hunt_task makeGraph）；
  // 其余格填零值——组图期不被触碰，类型上仍满足 RunKindGraphDeps。
  const kindDeps = {
    audit,
    kb: null, kbStore: null, siem: null, analyzers: null,
    fga: async () => ({ allowed: false, reason: "autorun-hunt-test" }),
    llmMode: "fake",
    orchestration: orch,
  } as unknown as RunKindGraphDeps;
  const makeNodes: RunGraphFactory = (run, ticket, ctx) =>
    requireRunKind(run.kind).makeGraph!(kindDeps)(run, ticket, ctx);
  const mint: MintClient = {
    async mintTaskTicket(req) {
      return {
        token: makeTaskTicket(req.runId, req.allowedTools, { sub: req.sub, caseId: req.caseId ?? "", jti: req.jti }),
        payload: { jti: req.jti },
      };
    },
    async mintApprovalToken() {
      throw new Error("hunt 骨架无 L2 动作（INV-3），审批铸票不该被调");
    },
  };
  const app = buildApp({ db, audit, makeNodes, mint, dispatcher: { intervalMs: 5, concurrency: 2 } });
  const huntLauncher = makeHuntLauncher(orch.door, ledger);
  // index.ts launch 的同款分支（生产装配照抄：hunt_flow → launcher 轮 1）
  const launch = async (req: Parameters<AutorunDeps["launch"]>[0]): Promise<void> => {
    if (req.kind === "hunt_flow") {
      await huntLauncher.launchRound({ hypothesisId: req.caseId as string, roundNo: 1 });
      return;
    }
    throw new Error(`本测试只消费 hunt_flow，收到 ${req.kind}`);
  };
  return {
    db, audit, ledger, app,
    deps: (reader, cursor) => ({
      events: reader,
      cursor,
      launch,
      hasActiveRun: runsLookup(db),
      hasRoundRun: (hypothesisId, roundNo) => ledger.findByRound(hypothesisId, roundNo) !== null,
      hasKbEntryForCase: async () => false,
    }),
  };
}

const huntRuns = (db: DB, hypId: string): Record<string, unknown>[] =>
  db.prepare("SELECT * FROM runs WHERE kind = 'hunt_flow' AND case_id = ? ORDER BY id").all(hypId) as Record<string, unknown>[];

async function waitUntil(fn: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await tick();
  }
}

describe("票 73·L0 裁决①：hypothesis.created → autorun → hunt_flow（T01 生产路径）", () => {
  test("POST /api/v1/hypotheses → autorun tick → hunt_flow queued→running → hypothesis hunting（真 m2 迁移）→ 轮次归集落账", async () => {
    const cb = await startCaseBackend();
    let rig1: Rig | null = null;
    try {
      rig1 = rig(cb);
      const { db, audit, ledger, deps } = rig1;

      // m2 正门发起假设：201 proposed + outbox hypothesis.created 同事务（m2 侧半边）
      const created = await (await fetch(`${cb.url}/api/v1/hypotheses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_id: "t-default", text: "autorun 契约：横向移动待验证" }),
      })).json() as { hypothesis_id: string; status: string };
      expect(created.status).toBe("proposed");
      const hypId = created.hypothesis_id;

      // autorun 消费一轮：真 HttpOutboxReader 读真 outbox（wire：payload {hypothesisId, templateId}）
      const reader = new HttpOutboxReader(cb.url);
      const res = await pollAutorunOnce(deps(reader, dbCursorStore(db)));
      expect(res.launched).toEqual([`hunt_flow:${hypId}`]);
      expect(res.skipped).toEqual([]);
      expect(dbCursorStore(db).get(AUTORUN_CURSOR)).toBeGreaterThanOrEqual(1);

      // hunt_flow run 出现并由分发循环跑到终态
      await waitUntil(() => huntRuns(db, hypId).length === 1, "hunt_flow run 出现");
      const run = huntRuns(db, hypId)[0];
      const done = await waitForRunTerminal(db, String(run.id), { timeoutMs: 15000 });
      expect(done.status).toBe("completed");

      // intake 节点前置 hunting：真 m2 状态机迁移（proposed→hunting，INV-10 真迁移非假件记账）
      const detail = (await (await fetch(`${cb.url}/api/v1/hypotheses/${hypId}`)).json()) as {
        status: string; rounds: { round_no: number; children: { run_id: string }[] }[];
      };
      expect(detail.status).toBe("hunting");
      // 轮次归集写半边同环闭合：outcome 经真 m2 REST 落轮 1（children 即簿记的假设侧视图）
      expect(detail.rounds).toHaveLength(1);
      expect(detail.rounds[0].round_no).toBe(1);
      expect(detail.rounds[0].children.length).toBeGreaterThanOrEqual(1);

      // 六节点事件序与既有 run 同口径（与 flow.test T02 同断言口径的冒烟版）
      const evts = eventsAfter(db, String(run.id), 0);
      const enters = evts.filter((e) => e.type === "node_enter").map((e) => e.payload.node);
      expect(enters).toEqual(["intake", "planner", "dispatch", "await_children", "judge", "outcome"]);

      // 五要素审计（INV-8）：轮次 outcome 条目
      expect(audit.entries.find((e) => e.action === "hunt_round_outcome")).toMatchObject({
        objectId: hypId, objectType: "hypothesis", result: "SUCCESS",
      });

      // 同一事件重放（游标丢失重放，autorun.test.ts 同款口径）：闸① 挡（run 在册非 failed）
      const res2 = await pollAutorunOnce(deps(reader, { get: () => 0, set: () => {} }));
      expect(res2.launched).toEqual([]);
      expect(res2.skipped).toEqual([{ topic: "hypothesis.created", refId: hypId, reason: "run_exists" }]);
      expect(huntRuns(db, hypId)).toHaveLength(1); // 不重复拉起（INV-6 同族）
      // m2 侧假设状态不被重放扰动
      const after = (await (await fetch(`${cb.url}/api/v1/hypotheses/${hypId}`)).json()) as { status: string };
      expect(after.status).toBe("hunting");
      expect(ledger.findByRound(hypId, 1)?.runId).toBe(String(run.id)); // 簿记锚随 launcher 落账
    } finally {
      await rig1?.app.close();
      await cb.close();
    }
  }, 40000);

  test("闸②缺一不可：run failed（闸①放行）但簿记锚在册 → round_exists 挡重放", async () => {
    const cb = await startCaseBackend();
    let rig1: Rig | null = null;
    try {
      // planner 病了：轮 1 run 起得来（簿记锚已落）但执行失败
      rig1 = rig(cb, { llm: { ...makeFakeLoopLlm(), planner: async () => { throw new Error("planner_boom"); } } });
      const { db, ledger, deps } = rig1;

      const created = await (await fetch(`${cb.url}/api/v1/hypotheses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template_id: "t-default", text: "autorun 契约：轮 1 失败场景" }),
      })).json() as { hypothesis_id: string };
      const hypId = created.hypothesis_id;

      // 先手工走一遍生产拉起（同 launcher 路径），等 run failed（簿记锚已在册）
      const reader = new HttpOutboxReader(cb.url);
      const first = await pollAutorunOnce(deps(reader, dbCursorStore(db)));
      expect(first.launched).toEqual([`hunt_flow:${hypId}`]);
      await waitUntil(() => huntRuns(db, hypId).length === 1, "hunt_flow run 出现");
      const failed = await waitForRunTerminal(db, String(huntRuns(db, hypId)[0].id), { timeoutMs: 15000 });
      expect(failed.status).toBe("failed");
      expect(ledger.findByRound(hypId, 1)).not.toBeNull();

      // 事件重放：闸① 对 failed 放行（runsLookup 只数非 failed）→ 闸② 簿记锚挡下
      const res2 = await pollAutorunOnce(deps(reader, { get: () => 0, set: () => {} }));
      expect(res2.launched).toEqual([]);
      expect(res2.skipped).toEqual([{ topic: "hypothesis.created", refId: hypId, reason: "round_exists" }]);
      expect(huntRuns(db, hypId)).toHaveLength(1); // 不起第二轮 1（重试语义归轮次机，票 74/75）
    } finally {
      await rig1?.app.close();
      await cb.close();
    }
  }, 40000);
});
