// SSE 重连/补发封装的 seam 测试：EventSource 用测试替身（FakeES）注入，
// 驱动「断线 → 按游标重连 → 补发不丢不重」（INV-7 / 决策 #9 的浏览器侧一半）。
import { describe, expect, it, vi } from "vitest";
import {
  ReconnectingSse,
  isTerminalSseEvent,
  type EventSourceFactory,
  type EventSourceLike,
  type SseMessageLike,
} from "./sse";

class FakeES implements EventSourceLike {
  readyState = 0; // CONNECTING
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((ev: SseMessageLike) => void)[]>();

  constructor(public url: string) {}

  addEventListener(type: string, cb: (ev: SseMessageLike) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  // ---- 测试驱动口（真实浏览器里由网络事件触发）----
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(type: string, id: number, payload: Record<string, unknown> = {}): void {
    const ev: SseMessageLike = {
      data: JSON.stringify({ type, ...payload }),
      lastEventId: String(id),
    };
    this.listeners.get(type)?.forEach((cb) => cb(ev));
  }

  fail(readyState = 2): void {
    this.readyState = readyState;
    this.onerror?.();
  }
}

function makeFactory() {
  const instances: FakeES[] = [];
  const factory: EventSourceFactory = (url) => {
    const es = new FakeES(url);
    instances.push(es);
    return es;
  };
  return { instances, factory };
}

function makeSse(factory: EventSourceFactory) {
  const events: { id: number; type: string }[] = [];
  const statuses: string[] = [];
  const sse = new ReconnectingSse({
    runId: "run_1",
    factory,
    retryMs: 1000,
    onEvent: (ev) => events.push({ id: ev.id, type: ev.type }),
    onStatus: (s) => statuses.push(s),
  });
  return { sse, events, statuses };
}

describe("isTerminalSseEvent", () => {
  it("done/error 是终态", () => {
    expect(isTerminalSseEvent("done", {})).toBe(true);
    expect(isTerminalSseEvent("error", {})).toBe(true);
  });

  it("audit 镜像 status.to = completed/failed 是终态，running 不是", () => {
    expect(isTerminalSseEvent("audit", { status: { from: "running", to: "completed" } })).toBe(true);
    expect(isTerminalSseEvent("audit", { status: { from: "queued", to: "failed" } })).toBe(true);
    expect(isTerminalSseEvent("audit", { status: { from: "queued", to: "running" } })).toBe(false);
    expect(isTerminalSseEvent("audit", {})).toBe(false);
  });

  it("过程事件不是终态", () => {
    expect(isTerminalSseEvent("node_enter", { node: "load_alert" })).toBe(false);
    expect(isTerminalSseEvent("tool_call", { tool: "get_alert" })).toBe(false);
  });
});

describe("ReconnectingSse", () => {
  it("首连 URL 带 run_id 与 after=0，open 后状态 connecting→open", () => {
    const { instances, factory } = makeFactory();
    const { sse, statuses } = makeSse(factory);
    sse.open();
    expect(instances[0].url).toBe("/api/v1/events/stream?run_id=run_1&after=0");
    expect(statuses).toEqual(["connecting"]);
    instances[0].fireOpen();
    expect(statuses).toEqual(["connecting", "open"]);
    sse.close();
  });

  it("事件按 lastEventId 推进游标并交付给 onEvent", () => {
    const { instances, factory } = makeFactory();
    const { sse, events } = makeSse(factory);
    sse.open();
    instances[0].emit("node_enter", 3, { node: "load_alert" });
    expect(events).toEqual([{ id: 3, type: "node_enter" }]);
    sse.close();
  });

  it("终态事件后关流置 finished，之后断线不再重连", () => {
    const { instances, factory } = makeFactory();
    const { sse, statuses } = makeSse(factory);
    sse.open();
    instances[0].emit("audit", 9, { status: { from: "running", to: "completed" } });
    expect(instances[0].closed).toBe(true);
    expect(statuses.at(-1)).toBe("finished");
    instances[0].fail(); // 终态后就算再报错也不许重连
    expect(instances).toHaveLength(1);
  });

  it("done 事件同样终态收流", () => {
    const { instances, factory } = makeFactory();
    const { sse, statuses } = makeSse(factory);
    sse.open();
    instances[0].emit("done", 4);
    expect(statuses.at(-1)).toBe("finished");
    expect(instances[0].closed).toBe(true);
  });

  it("断线后按游标重连：新连接 URL 带 after=<最后事件 id>", () => {
    vi.useFakeTimers();
    const { instances, factory } = makeFactory();
    const { sse, statuses } = makeSse(factory);
    sse.open();
    instances[0].emit("node_enter", 7, { node: "kb_check" });
    instances[0].fail(); // 断线
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toBe("/api/v1/events/stream?run_id=run_1&after=7");
    expect(statuses).toContain("reconnecting");
    sse.close();
    vi.useRealTimers();
  });

  it("跨重连事件续传不丢不重：游标连续", () => {
    vi.useFakeTimers();
    const { instances, factory } = makeFactory();
    const { sse, events } = makeSse(factory);
    sse.open();
    instances[0].emit("node_enter", 1);
    instances[0].emit("node_exit", 2);
    instances[0].fail();
    vi.advanceTimersByTime(1000);
    instances[1].emit("node_enter", 3);
    instances[1].emit("node_exit", 4);
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    sse.close();
    vi.useRealTimers();
  });

  it("close() 后断线不再重连，状态 closed", () => {
    vi.useFakeTimers();
    const { instances, factory } = makeFactory();
    const { sse, statuses } = makeSse(factory);
    sse.open();
    sse.close();
    instances[0].fail();
    vi.advanceTimersByTime(5000);
    expect(instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe("closed");
    vi.useRealTimers();
  });

  it("保险丝：连续 3 条零事件连接后停止重连置 ended（防对已结束 run 空转）", () => {
    vi.useFakeTimers();
    const { instances, factory } = makeFactory();
    const { sse, statuses } = makeSse(factory);
    sse.open();
    for (let i = 0; i < 3; i++) {
      instances[i].fail(); // 每条连接都没收到任何事件就断
      vi.advanceTimersByTime(1000);
    }
    expect(instances).toHaveLength(3); // 第 3 次空连接后不再开第 4 条
    expect(statuses.at(-1)).toBe("ended");
    instances[2].fail();
    vi.advanceTimersByTime(5000);
    expect(instances).toHaveLength(3);
    vi.useRealTimers();
  });

  it("收到事件会重置保险丝计数（长 run 中途多次断线仍持续重连）", () => {
    vi.useFakeTimers();
    const { instances, factory } = makeFactory();
    const { sse } = makeSse(factory);
    sse.open();
    instances[0].fail(); // 空 1
    vi.advanceTimersByTime(1000);
    instances[1].emit("node_enter", 1); // 这条有事件
    instances[1].fail();
    vi.advanceTimersByTime(1000);
    instances[2].fail(); // 空——但计数从有事件的那条重新起算
    vi.advanceTimersByTime(1000);
    expect(instances).toHaveLength(4);
    sse.close();
    vi.useRealTimers();
  });
});
