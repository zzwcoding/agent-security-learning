import { describe, expect, test } from "vitest";
import { openDb, type DB } from "./db.js";
import { emitEvent, eventsAfter, formatSse, type RunEvent } from "./events.js";

function makeDb(): DB {
  return openDb(":memory:");
}

// INV-7：SSE 事件自增 id 落盘；断线重连按 Last-Event-ID 补发，不丢不重
describe("事件总线：自增 id 落盘 + 按游标补发", () => {
  test("emit 落盘拿全局自增 id；两个 run 交错也各自保序", () => {
    const db = makeDb();
    const r1e1 = emitEvent(db, "run_1", "node_enter", { node: "intake" });
    const r2e1 = emitEvent(db, "run_2", "node_enter", { node: "intake" });
    const r1e2 = emitEvent(db, "run_1", "node_exit", { node: "intake" });

    expect(r1e1.id).toBeLessThan(r2e1.id);
    expect(r2e1.id).toBeLessThan(r1e2.id); // 全局自增，交错不串号

    const r1 = eventsAfter(db, "run_1", 0);
    expect(r1.map((e) => e.id)).toEqual([r1e1.id, r1e2.id]); // 别的 run 的事件不掺进来
    expect(r1.map((e) => e.type)).toEqual(["node_enter", "node_exit"]);
  });

  test("Last-Event-ID 补发：恰好是游标之后的那段——不丢（全集=已发∪补发）不重（交集空）", () => {
    const db = makeDb();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(emitEvent(db, "run_1", "node_exit", { step: i }).id);
    }
    const cursor = ids[1]; // 客户端收到过前两条，断线，带着 Last-Event-ID 回来
    const replayed = eventsAfter(db, "run_1", cursor);

    expect(replayed.map((e) => e.id)).toEqual([ids[2], ids[3], ids[4]]); // 严格递增、一条不少
    // 不重：换个游标再取，两段并起来是全集、交起来是空
    const first = eventsAfter(db, "run_1", 0).filter((e) => e.id <= cursor);
    expect(new Set([...first, ...replayed]).size).toBe(5);
    // 游标已到末尾 → 补发空（EventSource 正常挂着重连）
    expect(eventsAfter(db, "run_1", ids[4])).toEqual([]);
  });

  test("formatSse：id/event/data 三行 + 空行结束，data 带 type/run_id/ts（PRD §6-M3 示例）", () => {
    const ev: RunEvent = {
      id: 7,
      runId: "run_01J",
      type: "tool_call",
      payload: { node: "triage", tool: "search_cases_by_host" },
      createdAt: 1757000001000,
    };
    const wire = formatSse([ev]);
    expect(wire).toBe(
      `id: 7\n` +
        `event: tool_call\n` +
        `data: {"type":"tool_call","run_id":"run_01J","node":"triage","tool":"search_cases_by_host","ts":1757000001000}\n\n`,
    );
    expect(formatSse([])).toBe("");
  });
});
