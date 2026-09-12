// m14 编排循环 · 轮次接力（票 73，ADR 0005 拓扑约束：循环性在 dispatcher 层）。
//
// round k 的 outcome 节点发 round_relay 事件（父 run 的 audit 事件流上，SSE 可回放），
// 本件订阅事件总线把它折成 round k+1 的 hunt_flow run 拉起——图内永远一轮一条串行链，
// 图与图之间靠这个接力件续。幂等（INV-6 同族，spec T02 的「重放不重复起 round」）：
//   ① ledger.findByRound(hyp, k+1) 有行 = 该轮已拉起，重放/迟到事件直接跳过；
//   ② 在途集合：同一接力事件在拉起尚未落账的窗口内重复投递也只起一次。
// 拉起失败不吞：抛错交由订阅分发层记日志（事件不重试——autorun 的 at-least-once 语义
// 归 m2 outbox 消费链，本总线是 fire-and-forget 扇出；真重放由上游事件源决定）。
import type { HuntLedger, LoopEventBus, RunDoor } from "./ports.js";
import { makeHuntLauncher } from "./launcher.js";

/** round_relay 事件的 payload 形（outcome 节点 ctx.emit 的对偶；type alias 让它可赋给
 *  Record<string, unknown> 的事件 payload 索引签名）。 */
export type RoundRelayPayload = {
  action: "round_relay";
  hypothesis_id: string;
  next_round: number;
  parent_run_id: string;
};

export function isRoundRelay(e: { type: string; payload: Record<string, unknown> }): e is { type: "audit"; payload: RoundRelayPayload } {
  return e.type === "audit" && e.payload.action === "round_relay";
}

export function startRoundRelay(deps: {
  bus: LoopEventBus;
  ledger: HuntLedger;
  door: RunDoor;
  log?: (entry: Record<string, unknown>) => void;
}): { stop(): void } {
  const launcher = makeHuntLauncher(deps.door, deps.ledger);
  const inflight = new Set<string>();
  const unsub = deps.bus.subscribe((e) => {
    if (!isRoundRelay(e)) return;
    const p = e.payload;
    const key = `${p.hypothesis_id}:${p.next_round}`;
    if (deps.ledger.findByRound(p.hypothesis_id, p.next_round)) {
      deps.log?.({ info: "round_relay_dup", hypothesis_id: p.hypothesis_id, round: p.next_round });
      return;
    }
    if (inflight.has(key)) return;
    inflight.add(key);
    void launcher
      .launchRound({ hypothesisId: p.hypothesis_id, roundNo: p.next_round })
      .then((runId) => {
        deps.log?.({ info: "round_relay_launched", hypothesis_id: p.hypothesis_id, round: p.next_round, run_id: runId });
      })
      .catch((err: unknown) => {
        deps.log?.({ warn: "round_relay_failed", hypothesis_id: p.hypothesis_id, round: p.next_round, error: String(err) });
      })
      .finally(() => inflight.delete(key));
  });
  return { stop: unsub };
}
