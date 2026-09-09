import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AUTORUN_CURSOR,
  dbCursorStore,
  eventDrivenEnabled,
  HttpOutboxReader,
  makeHttpKbEntryCheck,
  pollAutorunOnce,
  runsLookup,
  startAutorun,
  type AutorunDeps,
  type CursorStore,
  type LaunchReq,
  type OutboxEvent,
  type OutboxReader,
} from "./autorun.js";
import { openDb, type DB } from "./db.js";
import { createRun, transitionRun } from "./runs.js";
import { MemoryAuditSink } from "./audit.js";
import { buildApp } from "./app.js";
import { httpJson, seedAlert, startCaseBackend } from "../workers/triage/testkit.js";
import { fileURLToPath } from "node:url";

// 票 40（G2-9 清偿）：事件驱动自动拉起的消费循环——M2 outbox（GET /api/v1/events?after）
// 的唯一消费者。alert.created → 自动拉起 alert_flow（PRD 消息旅程 step4：supervisor 认领
// 并拉起分诊）；case.closed → 自动拉起 knowledge_flow（step11，票 17 线头收口）。
// 测试打在 seam 上：事件读口/游标/拉起/防重全是注入件，绝不真出网（audit.test.ts 先例）。

const ev = (id: number, topic: string, payload: Record<string, unknown>): OutboxEvent => ({
  id, topic, payload, createdAt: 1757400000000 + id,
});

/** 假事件读口：按游标过滤（与 M2 pollEvents 的 WHERE id > ? 同语义）。 */
function arrayReader(events: OutboxEvent[]): OutboxReader {
  return { eventsAfter: async (after: number) => events.filter((e) => e.id > after) };
}

function memoryCursor(start = 0): CursorStore {
  let v = start;
  return { get: () => v, set: (_name, c) => { v = c; } };
}

interface FakeRig {
  deps: AutorunDeps;
  launched: LaunchReq[];
  setActive: (kind: string, refId: string) => void;
}

/** 全假 deps：launch 记账 + 同步把同类 run 记进「已有 run」账本（对齐生产行为：
 *  拉起成功 = agent runs 表多一行）。 */
function fakeDeps(over: Partial<AutorunDeps> = {}): FakeRig {
  const launched: LaunchReq[] = [];
  const active = new Set<string>();
  const rig: FakeRig = {
    launched,
    setActive: (kind, refId) => active.add(`${kind}:${refId}`),
    deps: {
      events: arrayReader([]),
      cursor: memoryCursor(),
      launch: async (req) => {
        launched.push(req);
        active.add(`${req.kind}:${req.alertId ?? req.caseId}`);
      },
      hasActiveRun: (kind, refId) => active.has(`${kind}:${refId}`),
      hasKbEntryForCase: async () => false,
    },
  };
  rig.deps = { ...rig.deps, ...over };
  return rig;
}

describe("票 40 · 事件 → 自动拉起（消费循环主链路）", () => {
  test("alert.created → 自动拉起 alert_flow，游标推进到该事件", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(7, "alert.created", { alertId: "a1", source: "wazuh:x", sourceRef: "r1" })]),
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([{ kind: "alert_flow", alertId: "a1" }]);
    expect(res.launched).toEqual(["alert_flow:a1"]);
    expect(res.cursor).toBe(7);
    expect(rig.deps.cursor.get(AUTORUN_CURSOR)).toBe(7);
  });

  test("case.closed → 自动拉起 knowledge_flow（票 17 线头收口）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(9, "case.closed", { caseId: "case_000001", verdict: "false_positive" })]),
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([{ kind: "knowledge_flow", caseId: "case_000001" }]);
    expect(res.cursor).toBe(9);
  });

  test("无关 topic 只推进游标不拉起（poison 不挡道）", async () => {
    const rig = fakeDeps({ events: arrayReader([ev(3, "alert.updated", { alertId: "a1" })]) });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([]);
    expect(res.skipped).toEqual([{ topic: "alert.updated", refId: "", reason: "ignored" }]);
    expect(res.cursor).toBe(3);
  });

  test("游标水位后的历史事件不重放（重启不重扫）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(7, "alert.created", { alertId: "a1" }), ev(8, "alert.created", { alertId: "a2" })]),
      cursor: memoryCursor(7),
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([{ kind: "alert_flow", alertId: "a2" }]);
    expect(res.cursor).toBe(8);
  });
});

describe("票 40 · 防重（验收：重复事件不重复拉起）", () => {
  test("同一 alert 重放不重复拉起（游标丢失重放场景，已有 run 挡住）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(7, "alert.created", { alertId: "a1" })]),
    });
    await pollAutorunOnce(rig.deps);
    expect(rig.launched).toHaveLength(1);
    // 模拟 agent 库被删（游标丢了）：事件重放，但 runs 表里那条 alert_flow run 还在
    rig.deps.cursor = memoryCursor(0);
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toHaveLength(1); // 没有第二次拉起
    expect(res.skipped).toEqual([{ topic: "alert.created", refId: "a1", reason: "run_exists" }]);
    expect(res.cursor).toBe(7); // 游标照样推进，不再卡在旧事件上
  });

  test("同批两条同 alert 的事件只拉一次（批内去重）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(7, "alert.created", { alertId: "a1" }), ev(8, "alert.created", { alertId: "a1" })]),
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toHaveLength(1);
    expect(res.skipped).toEqual([{ topic: "alert.created", refId: "a1", reason: "dup_batch" }]);
  });

  test("knowledge：已有进行中/完成的 knowledge_flow run → 跳过", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(9, "case.closed", { caseId: "case_000001" })]),
      hasActiveRun: (kind, refId) => kind === "knowledge_flow" && refId === "case_000001",
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([]);
    expect(res.skipped).toEqual([{ topic: "case.closed", refId: "case_000001", reason: "run_exists" }]);
    expect(res.cursor).toBe(9);
  });

  test("knowledge：M2 账面已有 proposed/approved 提案 → 跳过（kb 防重）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(9, "case.closed", { caseId: "case_000001" })]),
      hasKbEntryForCase: async (caseId) => caseId === "case_000001",
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([]);
    expect(res.skipped).toEqual([{ topic: "case.closed", refId: "case_000001", reason: "kb_exists" }]);
  });

  test("knowledge：上次 run failed → 允许重拉（重试语义）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(9, "case.closed", { caseId: "case_000001" })]),
      // failed 的 run 不进 hasActiveRun 账（runsLookup 只数非 failed）
    });
    await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([{ kind: "knowledge_flow", caseId: "case_000001" }]);
  });

  test("payload 缺 id 的坏事件：跳过不拉起，游标照样推进", async () => {
    const rig = fakeDeps({ events: arrayReader([ev(5, "alert.created", {}), ev(6, "case.closed", {})]) });
    const res = await pollAutorunOnce(rig.deps);
    expect(rig.launched).toEqual([]);
    expect(res.skipped.map((s) => s.reason)).toEqual(["malformed_payload", "malformed_payload"]);
    expect(res.cursor).toBe(6);
  });
});

describe("票 40 · 拉起失败 = at-least-once（游标不动，下轮重试）", () => {
  test("launch 抛错：本批中止、游标停在失败事件之前", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(7, "alert.created", { alertId: "a1" }), ev(8, "alert.created", { alertId: "a2" })]),
      launch: async (req) => {
        if (req.alertId === "a1") throw new Error("internal/runs HTTP 502 mint_failed");
      },
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(res.failed).toEqual({ topic: "alert.created", refId: "a1", error: expect.stringContaining("502") });
    expect(res.launched).toEqual([]);
    expect(res.cursor).toBe(0); // 一动不动，a1 下轮重试
  });

  test("恢复后重试成功（不丢事件）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(7, "alert.created", { alertId: "a1" })]),
      launch: async () => { throw new Error("boom"); },
    });
    await pollAutorunOnce(rig.deps);
    rig.deps.launch = async () => { rig.launched.push({ kind: "alert_flow", alertId: "a1" }); };
    const res = await pollAutorunOnce(rig.deps);
    expect(res.launched).toEqual(["alert_flow:a1"]);
    expect(res.cursor).toBe(7);
  });

  test("kb 账面查询病了：同 launch 失败口径（本批停、游标不动）", async () => {
    const rig = fakeDeps({
      events: arrayReader([ev(9, "case.closed", { caseId: "case_000001" })]),
      hasKbEntryForCase: async () => { throw new Error("HTTP 500"); },
    });
    const res = await pollAutorunOnce(rig.deps);
    expect(res.failed).toEqual({ topic: "case.closed", refId: "case_000001", error: expect.stringContaining("500") });
    expect(res.cursor).toBe(0);
  });
});

describe("票 40 · 游标与防重的生产件", () => {
  let db: DB;
  afterEach(() => { db?.close(); });

  test("dbCursorStore：set 后同库新 store 可读（重启不重放）；新库缺省 0", () => {
    db = openDb(":memory:");
    expect(dbCursorStore(db).get(AUTORUN_CURSOR)).toBe(0);
    dbCursorStore(db).set(AUTORUN_CURSOR, 42);
    expect(dbCursorStore(db).get(AUTORUN_CURSOR)).toBe(42); // 新实例 = 模拟重启后重开
    dbCursorStore(db).set(AUTORUN_CURSOR, 43); // 幂等 upsert
    expect(dbCursorStore(db).get(AUTORUN_CURSOR)).toBe(43);
  });

  test("runsLookup：非 failed 的同类 run 命中；failed 不挡；对象不串", () => {
    db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const ctx = { audit, requestId: "req-40" };
    createRun(db, { kind: "alert_flow", alertId: "a1" }, ctx);
    const k1 = createRun(db, { kind: "knowledge_flow", caseId: "case_000001" }, ctx);
    const lookup = runsLookup(db);
    expect(lookup("alert_flow", "a1")).toBe(true);
    expect(lookup("knowledge_flow", "case_000001")).toBe(true);
    expect(lookup("alert_flow", "a2")).toBe(false);
    expect(lookup("alert_flow", "case_000001")).toBe(false); // 对象不串
    // failed 的 run 不挡重拉
    transitionRun(db, k1.id, "running", ctx);
    transitionRun(db, k1.id, "failed", ctx, "boom");
    expect(lookup("knowledge_flow", "case_000001")).toBe(false);
  });
});

describe("票 40 · 出站 wire 形（stubFetch，绝不真出网）", () => {
  const BASE = "http://case-backend-stub:3002";
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function stubFetch(reply: (url: string) => Response | Promise<Response>): { urls: string[] } {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url));
      void init;
      return reply(String(url));
    }) as typeof fetch);
    return { urls };
  }

  test("HttpOutboxReader：GET {base}/api/v1/events?after=N&limit=100，取 json.events", async () => {
    const { urls } = stubFetch(() =>
      jsonResponse(200, { events: [{ id: 7, topic: "alert.created", payload: { alertId: "a1" }, createdAt: 1 }] }));
    const events = await new HttpOutboxReader(BASE).eventsAfter(7);
    expect(urls).toEqual([`${BASE}/api/v1/events?after=7&limit=100`]);
    expect(events).toEqual([{ id: 7, topic: "alert.created", payload: { alertId: "a1" }, createdAt: 1 }]);
  });

  test("HttpOutboxReader：非 200 抛错（读不到真相 ≠ 真相是没有）", async () => {
    stubFetch(() => jsonResponse(500, { error: "internal_error" }));
    await expect(new HttpOutboxReader(BASE).eventsAfter(0)).rejects.toThrow(/500/);
  });

  test("makeHttpKbEntryCheck：proposed/approved 命中，rejected 不命中；非 200 抛", async () => {
    const { urls } = stubFetch(() =>
      jsonResponse(200, {
        proposals: [
          { id: "kb_1", source_case_id: "case_1", status: "approved" },
          { id: "kb_2", source_case_id: "case_2", status: "rejected" },
          { id: "kb_3", source_case_id: null, status: "proposed" },
        ],
      }));
    const check = makeHttpKbEntryCheck(BASE);
    expect(await check("case_1")).toBe(true); // approved 命中
    expect(await check("case_2")).toBe(false); // rejected 不挡（票面口径：只数 proposed/approved）
    expect(await check("case_9")).toBe(false);
    expect(urls.every((u) => u === `${BASE}/api/v1/kb/proposals`)).toBe(true);
    stubFetch(() => jsonResponse(500, {}));
    await expect(makeHttpKbEntryCheck(BASE)("case_1")).rejects.toThrow(/500/);
  });
});

describe("票 40 · 开关与循环", () => {
  test("eventDrivenEnabled：缺省 on（PRD 消息旅程主链路），EVENT_DRIVEN=off 才关", () => {
    expect(eventDrivenEnabled({})).toBe(true);
    expect(eventDrivenEnabled({ EVENT_DRIVEN: "on" })).toBe(true);
    expect(eventDrivenEnabled({ EVENT_DRIVEN: "off" })).toBe(false);
  });

  test("startAutorun：立即轮询 + 周期续轮；poll 抛错不中断；stop 后不再轮", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const rig = fakeDeps({
        events: {
          eventsAfter: async () => {
            polls += 1;
            throw new Error("m2 down");
          },
        },
      });
      const loop = startAutorun(rig.deps, { intervalMs: 100 });
      await vi.advanceTimersByTimeAsync(1); // 第一轮立即跑（抛错只记日志）
      expect(polls).toBe(1);
      await vi.advanceTimersByTimeAsync(100); // 下个周期再来
      expect(polls).toBe(2);
      loop.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(polls).toBe(2); // stop 后不再轮
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("票 40 · 全链路集成（真 case-backend 子进程 + agent 正门，票 28 同款纪律）", () => {
  // 生产装配的逐件复刻（index.ts 同款接线）：事件读口 = HttpOutboxReader 打真 M2 REST；
  // 拉起 = app.inject 打自家 /internal/runs 正门；游标/防重 = agent sqlite 真表。
  // 唯一替身 = 不接 worker 图（薄径直跑终态）， mint 不进环（无 makeNodes 就不铸票）。
  function productionWiring(m2Url: string, adb: DB) {
    const app = buildApp({ db: adb }); // 薄径：/internal/runs 拉起的 run 直达终态
    return {
      events: new HttpOutboxReader(m2Url),
      cursor: dbCursorStore(adb),
      launch: async (req: LaunchReq) => {
        const payload = req.kind === "alert_flow"
          ? { kind: req.kind, alert_id: req.alertId }
          : { kind: req.kind, case_id: req.caseId };
        const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
        if (res.statusCode >= 300) throw new Error(`internal/runs HTTP ${res.statusCode} ${res.body}`);
      },
      hasActiveRun: runsLookup(adb),
      hasKbEntryForCase: makeHttpKbEntryCheck(m2Url),
    };
  }

  test("alert.created → 自动拉起 alert_flow（薄径 run completed）；游标丢失重放不重复拉起", async () => {
    const cb = await startCaseBackend();
    try {
      const alertId = await seedAlert(
        cb.url,
        fileURLToPath(new URL("../../../fixtures/alerts/ssh-5712-real.json", import.meta.url)),
      );
      const adb = openDb(":memory:");
      const deps = productionWiring(cb.url, adb);
      const res = await pollAutorunOnce(deps);
      expect(res.launched).toEqual([`alert_flow:${alertId}`]);
      // run 真的在 agent 库里：kind/对象对、薄径已到终态
      const runs = adb.prepare("SELECT * FROM runs").all() as Record<string, unknown>[];
      expect(runs).toHaveLength(1);
      expect(runs[0].kind).toBe("alert_flow");
      expect(runs[0].alert_id).toBe(alertId);
      expect(runs[0].status).toBe("completed");
      // 游标丢了（换一块新库存游标）：事件重放，但已有 run 挡住，不重复拉起（INV-6）
      const res2 = await pollAutorunOnce({ ...deps, cursor: memoryCursor(0) });
      expect(res2.launched).toEqual([]);
      expect(res2.skipped).toEqual([{ topic: "alert.created", refId: alertId, reason: "run_exists" }]);
    } finally {
      await cb.close();
    }
  }, 40000);

  test("case.closed → 自动拉起 knowledge_flow（真 M2 kb 账面查重：空 → 放行）", async () => {
    const cb = await startCaseBackend();
    try {
      // 手工建案 + 置 InProgress + 带 verdict 关案（状态机 New→InProgress→Closed，
      // 全走公开 REST 正门，outbox 得到 case.closed）
      const created = await httpJson(cb.url, "POST", "/api/v1/cases", { title: "票40 集成案" });
      const caseId = String(created.json.id); // POST /cases 直接回案件对象（无 {case} 包裹）
      const progressed = await httpJson(cb.url, "PATCH", `/api/v1/cases/${caseId}`, { status: "InProgress" });
      expect(progressed.status).toBeLessThan(300);
      const closed = await httpJson(cb.url, "POST", `/api/v1/cases/${caseId}/close`, {
        verdict: "false_positive",
      });
      expect(closed.status).toBeLessThan(300);
      const adb = openDb(":memory:");
      const deps = productionWiring(cb.url, adb);
      const res = await pollAutorunOnce(deps);
      expect(res.launched).toEqual([`knowledge_flow:${caseId}`]);
      const runs = adb.prepare("SELECT * FROM runs").all() as Record<string, unknown>[];
      expect(runs[0].kind).toBe("knowledge_flow");
      expect(runs[0].case_id).toBe(caseId);
    } finally {
      await cb.close();
    }
  }, 40000);
});
