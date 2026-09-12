// m14 编排循环 · await_children 的事件唤醒件（票 73，spec 行为约定 7 + T19）。
//
// 铁律：只经事件唤醒（子 run 终态事件），全仓禁轮询——本文件没有定时器、没有
// while+sleep、没有对 runs 表的状态探测；「子 run 跑完了吗」这个问题的唯一答案来源
// 是落盘事件总线（run_events → eventTap → LoopEventBus）：
//   - 正常终局：子 run 末节点（report）发的 audit 事件 payload.action="hunt_task_finished"
//     （带 result_summary/params_hash，judge 的引用痕）；
//   - 异常终局：子 run 的 error 事件（runner 强杀 / 铸票失败等失败路径都会发，INV-1
//     不吞错），折成 ok:false 的终态。
// 订阅在工厂构造时即挂上（早于 dispatch 发生），先到的事件进缓冲——wait() 无论在子 run
// 结束前还是结束后调用都只认事件，同一子 run 的重复终局事件幂等折一次。
import type { ChildOutcome, ChildWaiter, LoopEventBus } from "./ports.js";

export type { ChildOutcome };

/** 终局判定（事件形态唯一来源）：hunt_task_finished 审计事件 = 正常终局；
 *  error 事件 = 失败终局（失败强杀口径与现有 run 一致，INV-1）。 */
function terminalOf(e: { runId: string; type: string; payload: Record<string, unknown> }): ChildOutcome | null {
  if (e.type === "audit" && e.payload.action === "hunt_task_finished") {
    return {
      runId: e.runId,
      ok: e.payload.ok !== false,
      resultSummary: typeof e.payload.result_summary === "string" ? e.payload.result_summary : "",
      paramsHash: typeof e.payload.params_hash === "string" ? e.payload.params_hash : "",
    };
  }
  if (e.type === "error") {
    return {
      runId: e.runId,
      ok: false,
      resultSummary: `failed:${typeof e.payload.code === "string" ? e.payload.code : "unknown"}`,
      paramsHash: "",
    };
  }
  return null;
}

export function makeChildWaiter(bus: LoopEventBus): ChildWaiter {
  // 构造即订阅：早于 wait() 的终局事件落缓冲，事件不会被错过（不靠事后查表补课）
  const seen = new Map<string, ChildOutcome>();
  const waiters: { ids: string[]; resolve: (out: ChildOutcome[]) => void }[] = [];

  const tryResolve = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.ids.every((id) => seen.has(id))) {
        waiters.splice(i, 1);
        w.resolve(w.ids.map((id) => seen.get(id) as ChildOutcome));
      }
    }
  };

  bus.subscribe((e) => {
    const t = terminalOf(e);
    if (!t) return;
    if (!seen.has(t.runId)) seen.set(t.runId, t); // 幂等：同 run 重复终局只折一次
    tryResolve();
  });

  return {
    wait(childRunIds: string[]): Promise<ChildOutcome[]> {
      if (childRunIds.every((id) => seen.has(id))) {
        return Promise.resolve(childRunIds.map((id) => seen.get(id) as ChildOutcome));
      }
      return new Promise<ChildOutcome[]>((resolve) => {
        waiters.push({ ids: [...childRunIds], resolve });
      });
    },
  };
}
