// SSE 事件总线（m3 内部模块 events；FR-M3.6 + 决策 #9 + INV-7）。
// 关键决定：总线只有一张落盘的表，没有内存通道——「发事件」= 插一行拿自增 id，
// 「订阅」= 按 id>cursor 查表。断线补发因此和实时推送是同一段代码（都走 eventsAfter），
// 不丢不重是表结构保证的：id 唯一、单调、持久。实时 watch（run 进行中推新事件）等
// run 变异步的那张票再接——本票 run 是同步直跑，订阅者连上时事件已全部落盘。
import type { DB } from "./db.js";

// PRD §6-M3 事件类型闭合枚举（Web 消费方靠它渲染流水线视图/审批卡/审计流）。
// 票 18 追加 chat 三型（PRD §6-M8 对话 wire 契约：token/done/denied）——同一张落盘
// 总线，对话流因此同样有自增 id 与 Last-Event-ID 补发（INV-7 原样继承）。
// 票 31：枚举落成运行时数组、类型从数组推导——agent 侧值域只有这一份；web 的
// SSE_EVENT_TYPES 是手抄副本，两端由 sse-contract.test.ts 对 fixtures/sse-events.json
// 共读锁死（改名单先改样品，对端测试必红）。
export const SSE_EVENT_TYPES = [
  "node_enter", "node_exit", "tool_call", "tool_result",
  "approval_required", "approval_decided", "audit", "error",
  "token", "denied", "done",
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export interface RunEvent {
  id: number;
  runId: string;
  type: SseEventType;
  payload: Record<string, unknown>;
  createdAt: number;
}

const nowMs = () => Date.now();

// 票 37：可选旁路 tap（Langfuse 镜像用）。默认 null = emitEvent 与今日逐字节一致
// （ADR 0001 默认链路零改动的硬验收）；index.ts 只在三把 LANGFUSE_* env 钥匙齐时挂上。
// tap 病了不传染主链路：调用包在 try 里，旁路永远只是事件流的读者不是闸。
export type EventTap = (e: RunEvent) => void;
let eventTap: EventTap | null = null;
export function setEventTap(tap: EventTap | null): void {
  eventTap = tap;
}

/** 发事件 = 插一行拿全局自增 id（INV-7 的「自增 id 落盘」）。 */
export function emitEvent(
  db: DB,
  runId: string,
  type: SseEventType,
  payload: Record<string, unknown>,
): RunEvent {
  const createdAt = nowMs();
  const res = db
    .prepare("INSERT INTO run_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
    .run(runId, type, JSON.stringify(payload), createdAt);
  const event: RunEvent = { id: Number(res.lastInsertRowid), runId, type, payload, createdAt };
  if (eventTap) {
    try {
      eventTap(event);
    } catch {
      // 旁路崩了不许拖垮落库主链路：吞掉，tap 实现自己负责把错记到自己的日志里
    }
  }
  return event;
}

/** 补发查询：该 run 里 id > after 的事件，严格按 id 递增（INV-7 的「Last-Event-ID 补发」）。 */
export function eventsAfter(db: DB, runId: string, after: number): RunEvent[] {
  return (
    db
      .prepare("SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id")
      .all(runId, after) as Record<string, unknown>[]
  ).map((row) => ({
    id: row.id as number,
    runId: row.run_id as string,
    type: row.type as SseEventType,
    payload: JSON.parse(row.payload as string) as Record<string, unknown>,
    createdAt: row.created_at as number,
  }));
}

/** SSE wire 格式（WHATWG text/event-stream）：id 供 EventSource 记住游标并在重连时
 *  自动带 Last-Event-ID 头；event 是事件类型；data 是 JSON（type/run_id/ts 冗余进包，
 *  照 PRD §6-M3 的事件示例）。 */
export function formatSse(events: RunEvent[]): string {
  return events
    .map((e) => {
      const data = JSON.stringify({ type: e.type, run_id: e.runId, ...e.payload, ts: e.createdAt });
      return `id: ${e.id}\nevent: ${e.type}\ndata: ${data}\n\n`;
    })
    .join("");
}
