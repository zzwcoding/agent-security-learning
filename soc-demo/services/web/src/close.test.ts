// 票 39：SOC1 一键确认关单的纯逻辑层（React 之外可单测）。
// - closeAdvised：verdict_ai 里有没有"待执行的关单建议"（fp/btp + recommended_action=close）；
// - closeRunFailText：关单 run 失败的 error 事件 → 人话（409/已关/无建议各有人话）；
// - closeErrorText：startRun 的 ApiError → 人话（502 铸票失败可重试）；
// - watchCloseRun：订阅关单 run 的 SSE，终态回调一次（成败二值 + 人话）。
import { describe, expect, it } from "vitest";
import {
  closeAdvised,
  closeErrorText,
  closeRunFailText,
  watchCloseRun,
} from "./close";
import { ApiError } from "./api";
import type { EventSourceFactory, EventSourceLike, SseMessageLike } from "./sse";

describe("closeAdvised", () => {
  it("worker 的原始判定对象：fp/btp + recommended_action=close 才算有建议", () => {
    expect(closeAdvised({ verdict: "fp", recommended_action: "close" })).toBe(true);
    expect(closeAdvised({ verdict: "btp", recommended_action: "close" })).toBe(true);
    expect(closeAdvised({ verdict: "tp", recommended_action: "create_case" })).toBe(false);
    expect(closeAdvised({ verdict: "uncertain", recommended_action: "human" })).toBe(false);
    expect(closeAdvised({ verdict: "fp", recommended_action: "human" })).toBe(false);
  });

  it("老数据/字符串 verdictAi：一律不算有建议（不猜）", () => {
    expect(closeAdvised("fp")).toBe(false);
    expect(closeAdvised(null)).toBe(false);
    expect(closeAdvised(undefined)).toBe(false);
    expect(closeAdvised({ verdict: "fp" })).toBe(false);
  });
});

describe("closeRunFailText（error 事件 message → 人话）", () => {
  it("重复确认（已 Closed）→ 手慢了文案", () => {
    expect(closeRunFailText("close_already_closed:al_1")).toContain("已经是关单状态");
  });

  it("状态机拒绝（M2 409 InvalidTransition）→ 点名 409 与状态不允许", () => {
    const t = closeRunFailText("m2_close_failed:InvalidTransition");
    expect(t).toContain("409");
    expect(t).toContain("InvalidTransition");
  });

  it("未分诊/verdict 未定 → 指路先分诊", () => {
    expect(closeRunFailText("close_verdict_missing:al_1")).toContain("分诊");
  });

  it("AI 未建议关单 → 不予执行", () => {
    expect(closeRunFailText("close_advice_missing:al_1")).toContain("不予执行");
  });

  it("未知失败 → 原样透传 message，不编理由", () => {
    expect(closeRunFailText("boom:xyz")).toContain("boom:xyz");
  });
});

describe("closeErrorText（startRun 的 ApiError → 人话）", () => {
  it("502 铸票失败 → 可重试", () => {
    expect(closeErrorText(new ApiError(502, "mint_failed"))).toContain("可重试");
  });

  it("其它错误 → 带上后端 code", () => {
    expect(closeErrorText(new ApiError(400, "kind_and_alert_id_required"))).toContain("kind_and_alert_id_required");
  });
});

// ---- watchCloseRun：FakeES 驱动（与 sse.test.ts 同款替身）----

class FakeES implements EventSourceLike {
  readyState = 0;
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

  emit(type: string, id: number, payload: Record<string, unknown> = {}): void {
    this.listeners.get(type)?.forEach((cb) =>
      cb({ data: JSON.stringify({ type, ...payload }), lastEventId: String(id) }),
    );
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

describe("watchCloseRun", () => {
  it("audit 镜像 status→completed = 成功终态，回调一次并收流", () => {
    const { instances, factory } = makeFactory();
    const seen: { ok: boolean; text: string }[] = [];
    const sse = watchCloseRun("run_1", { onTerminal: (ok, text) => seen.push({ ok, text }), factory });
    sse.open();

    instances[0]!.emit("node_enter", 1, { node: "load_close_target" });
    instances[0]!.emit("audit", 2, { action: "update", status: { from: "running", to: "completed" } });

    expect(seen).toEqual([{ ok: true, text: "" }]);
    expect(instances[0]!.closed).toBe(true);
  });

  it("error 事件 = 失败终态，人话文案来自 closeRunFailText", () => {
    const { instances, factory } = makeFactory();
    const seen: { ok: boolean; text: string }[] = [];
    const sse = watchCloseRun("run_1", { onTerminal: (ok, text) => seen.push({ ok, text }), factory });
    sse.open();

    instances[0]!.emit("error", 1, { code: "node_error", node: "execute_close", message: "m2_close_failed:InvalidTransition" });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok).toBe(false);
    expect(seen[0]!.text).toContain("409");
    expect(instances[0]!.closed).toBe(true);
  });

  it("audit 镜像 status→failed = 失败终态", () => {
    const { instances, factory } = makeFactory();
    const seen: { ok: boolean }[] = [];
    const sse = watchCloseRun("run_1", { onTerminal: (ok) => seen.push({ ok }), factory });
    sse.open();

    instances[0]!.emit("audit", 1, { action: "kill", status: { from: "running", to: "failed" } });
    expect(seen).toEqual([{ ok: false }]);
  });

  it("URL 指向 /api/v1/events/stream 且带 run_id（INV-7 同一落盘总线）", () => {
    const { instances, factory } = makeFactory();
    const sse = watchCloseRun("run_9", { onTerminal: () => {}, factory });
    sse.open();
    expect(instances[0]!.url).toContain("/api/v1/events/stream?run_id=run_9");
  });
});
