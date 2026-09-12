// m14 编排循环 · 进程内事件扇出（票 73）。agent 落盘事件总线（run_events）只有一张表，
// 实时扇出唯一入口是 events.ts 的模块级 eventTap（票 37 为 Langfuse 预留的单槽）——
// index.ts 装配把该槽变成扇出点：tap 里既喂 Langfuse 镜像也喂本总线。
//
// 本文件只是「订阅者名单 + 同步分发」：没有任何定时器、没有任何落盘（落盘真相源仍是
// run_events 单表），await_children 的事件唤醒与轮次接力都从这里拿信号。
import type { LoopEvent, LoopEventBus, LoopListener, Unsubscribe } from "./ports.js";

export function makeLoopEventBus(): LoopEventBus {
  const listeners = new Set<LoopListener>();
  return {
    publish(e: LoopEvent): void {
      // 分发在 publish 的调用栈内同步完成（emitEvent → tap → publish）：
      // 订阅者的 resolve/handler 在同一轮宏任务里被调度，事件不会漂
      for (const fn of [...listeners]) {
        try {
          fn(e);
        } catch {
          // 订阅者（唤醒/接力）抛错不许传染 emitEvent 主链路——与 eventTap 同款纪律
        }
      }
    },
    subscribe(fn: LoopListener): Unsubscribe {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
