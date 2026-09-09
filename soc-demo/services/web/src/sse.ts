// SSE 客户端封装（INV-7 / 决策 #9 的浏览器侧一半）：断线自动重连 + 游标续传。
//
// 为什么不裸用 EventSource？三个坑，都收进这 20 行封装里：
// ① 浏览器对「服务端正常关流」的默认反应是悄悄重连（EventSource 语义：clean close
//    也走 retry）——对已终态的 run 会每几秒空转重连一次。所以终态事件（done/error/
//    audit 镜像里的 completed/failed）一到必须主动 close()。
// ② 原生断线重连只在「同一个 EventSource 实例」内自动带 Last-Event-ID 头；实例一旦
//    进入 CLOSED（如服务端 404/500），新建实例从头开始，会重复收全量事件。所以游标
//    自己记账，重连时用 ?after=<id> 显式续传（agent /events/stream 的同名参数，
//    与 Last-Event-ID 头是同一游标的两种写法）。
// ③ 重连策略（退避、放弃时机）要可控、可测——factory 注入测试替身（sse.test.ts）。
//
// SSE wire 格式（agent services/agent/src/events.ts formatSse）：每个事件带
// `event: <type>` + `id: <自增id>` + `data: {type, run_id, ...payload, ts}`。
// 注意：带 event 名的帧不会进 onmessage，必须按类型 addEventListener。

/** 与后端 SseEventType 全集对齐（services/agent/src/events.ts）——新增类型两端同步。 */
export const SSE_EVENT_TYPES = [
  "node_enter", "node_exit", "tool_call", "tool_result",
  "approval_required", "approval_decided", "audit", "error",
  "token", "denied", "done",
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

export type SseStatus = "connecting" | "open" | "reconnecting" | "finished" | "ended" | "closed";

export interface SseEvent {
  id: number;
  type: SseEventType;
  payload: Record<string, unknown>;
  ts: number;
}

export interface SseMessageLike {
  data: string;
  lastEventId: string;
}

/** EventSource 最小切片（测试替身照此实现；缺省工厂 = 浏览器原生 EventSource）。 */
export interface EventSourceLike {
  readyState: number;
  close(): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, cb: (ev: SseMessageLike) => void): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** 终态判定：done/error 事件，或 audit 镜像里 run 状态进 completed/failed
 *  （transitionAndMirror 每次状态迁移都会广播 status {from,to}——run 状态机见
 *  CONTEXT.md 语义核心）。终态一到就收流，见文件头坑①。 */
export function isTerminalSseEvent(type: string, payload: Record<string, unknown>): boolean {
  if (type === "done" || type === "error") return true;
  if (type === "audit") {
    const to = (payload.status as { to?: string } | undefined)?.to;
    return to === "completed" || to === "failed";
  }
  return false;
}

const EMPTY_STREAK_LIMIT = 3; // 连续 N 条连接零事件就收手（保险丝，防对坏 run_id 空转）

export class ReconnectingSse {
  private cursor = 0;
  private es: EventSourceLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private delivered = 0; // 当前这条连接已收到的事件数（保险丝计数用）
  private emptyStreak = 0;

  constructor(
    private opts: {
      runId: string;
      onEvent: (ev: SseEvent) => void;
      onStatus: (s: SseStatus) => void;
      /** 缺省 = new EventSource(url)。测试注入 FakeES。 */
      factory?: EventSourceFactory;
      /** 重连退避毫秒，默认 2000。 */
      retryMs?: number;
    },
  ) {}

  open(): void {
    this.connect();
  }

  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.es?.close();
    this.opts.onStatus("closed");
  }

  private url(): string {
    return `/api/v1/events/stream?run_id=${encodeURIComponent(this.opts.runId)}&after=${this.cursor}`;
  }

  private finish(status: SseStatus): void {
    this.stopped = true;
    this.es?.close();
    this.opts.onStatus(status);
  }

  private connect(): void {
    if (this.stopped) return;
    this.opts.onStatus(this.cursor === 0 ? "connecting" : "reconnecting");
    const factory: EventSourceFactory =
      this.opts.factory ?? ((u) => new EventSource(u) as unknown as EventSourceLike);
    const es = factory(this.url());
    this.es = es;
    this.delivered = 0;

    es.onopen = () => {
      if (!this.stopped) this.opts.onStatus("open");
    };

    for (const type of SSE_EVENT_TYPES) {
      es.addEventListener(type, (m) => {
        if (this.stopped) return;
        const id = Number(m.lastEventId);
        if (Number.isFinite(id) && id > this.cursor) this.cursor = id;
        this.delivered += 1;
        let payload: Record<string, unknown> = {};
        let ts = Date.now();
        try {
          const data = JSON.parse(m.data) as Record<string, unknown>;
          payload = data;
          if (typeof data.ts === "number") ts = data.ts;
          delete payload.type;
        } catch {
          /* data 非 JSON：留空 payload，事件本身照样交付 */
        }
        this.opts.onEvent({ id: Number.isFinite(id) ? id : 0, type: type as SseEventType, payload, ts });
        if (isTerminalSseEvent(type, payload)) this.finish("finished");
      });
    }

    es.onerror = () => {
      if (this.stopped) return;
      es.close(); // 接管重连（文件头坑①②：不给原生静默重连机会）
      this.emptyStreak = this.delivered === 0 ? this.emptyStreak + 1 : 0;
      if (this.emptyStreak >= EMPTY_STREAK_LIMIT) {
        this.finish("ended"); // 连着几条连接啥也没收到：run 多半已结束/不存在，收手
        return;
      }
      this.timer = setTimeout(() => this.connect(), this.opts.retryMs ?? 2000);
    };
  }
}
