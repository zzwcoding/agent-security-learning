// m14 编排循环 · 取消信号机制（票 77；行为约定 11/12 + T10/T18 停止链的共用件）。
//
// 两类取消源、同一套停止机制（spec 绑定注记：人取消与预算触发共用「取消信号节点包装
// 层检查 + 子 run failed(parent_cancelled)」）：
//   预算/超时触发（行为 11）——runner 按既有口径把触发轮次 run 强杀成 failed（审计 +
//     error 事件，graph.ts 逐字节未动）；本件的订阅半边消费该 error 事件 → 信号板记账 +
//     m2 PATCH 写半边（73 建的假设状态迁移）落 cancelled（原因按触发档位映射，T09 的
//     budget_rounds 在此）→ 该假设名下所有 run 在下一个节点边界被包装层检查掐停。
//   人取消（行为 12，T10）——POST /api/v1/hypotheses/:id/cancel（73 建端点）落 m2 账面
//     后，取消请求经本件 requestCancel 进入同一条停止链（装配层把 m2→agent 的事件通路
//     接到这个口；机制内两源共用信号板，停止语义逐字节一致）。
//
// 铁律：
//   强杀不自建第二套——run 的 failed 一律由节点包装层抛 BudgetExceededError
//   (parent_cancelled) 交 runner 既有强杀路径（failed + 审计 + error 事件 + SSE 同款
//   可见，fail_reason 带 parent_cancelled 痕）；假设侧 cancelled 只走 HypothesisPort
//   （m2 状态机，INV-10：终态不可回退，信号板首写 wins 是它的进程内半边）。
//   无定时器、无轮询（T19 同纪律）：唯一信号源是落盘事件的进程内扇出（LoopEventBus）。
import { BudgetExceededError } from "../budget.js";
import type { AuditSink } from "../audit.js";
import type { HuntLedger, HypothesisPort, LoopEventBus } from "./ports.js";

/** 节点包装层取消检查所抛错误的 kind：fail_reason/审计 details.kind 里的 parent_cancelled
 *  痕（ runner 强杀口径 → fail_reason=budget_exceeded:parent_cancelled）。 */
export const PARENT_CANCELLED = "parent_cancelled" as const;

/** 取消来源：人（12）/预算或超时（11）。 */
export type LoopCancelSource = "user" | "budget";

/** 假设侧取消原因：m2 四因枚举（user_cancelled/planner_broken/spin/budget——取消端点
 *  已在源头闸过）+ 循环侧两因（time/budget_rounds——PATCH 迁移不设枚举闸，机制侧自律
 *  只用这里的口径）。requestCancel 原样转发，不猜不改写。 */
export type LoopCancelReason =
  | "user_cancelled"
  | "planner_broken"
  | "spin"
  | "budget"
  | "time"
  | "budget_rounds";

export interface CancelRecord {
  reason: LoopCancelReason;
  source: LoopCancelSource;
  at: number;
}

/** 取消信号板：hypothesis_id → 记录的进程内真相。首写 wins——终态不可回退（INV-10）
 *  的进程内半边：先到的取消源定型，后到的（含竞态的预算触发 vs 人取消）一律不再改写。 */
export class CancelBoard {
  private readonly cancelled = new Map<string, CancelRecord>();

  cancel(hypothesisId: string, record: CancelRecord): boolean {
    if (this.cancelled.has(hypothesisId)) return false;
    this.cancelled.set(hypothesisId, { ...record });
    return true;
  }

  isCancelled(hypothesisId: string): boolean {
    return this.cancelled.has(hypothesisId);
  }

  reasonOf(hypothesisId: string): CancelRecord | null {
    return this.cancelled.get(hypothesisId) ?? null;
  }
}

/** 预算触发档位 → 假设侧取消原因（行为 11 的 budget/time 与 T09 的 budget_rounds）。 */
export function cancelReasonOfBudgetKind(kind: unknown): LoopCancelReason {
  if (kind === "rounds") return "budget_rounds";
  if (kind === "llm_timeout") return "time";
  return "budget";
}

/** 节点包装层逐节点前检查（spec m3 行「子 run 取消信号的节点包装层检查」的唯一实现）：
 *  假设已取消 → 抛 BudgetExceededError(parent_cancelled)，本 run 交 runner 既有强杀
 *  路径落 failed（parent_cancelled 痕进 fail_reason/审计/error 事件）——进行中的安全停
 * （下一个节点边界即断，不再产生任何取证工作量），未起的起了也立即停（不执行任何节点体）。 */
export function throwIfCancelled(board: CancelBoard | undefined, hypothesisId: string): void {
  if (!board || !hypothesisId) return;
  if (board.isCancelled(hypothesisId)) {
    throw new BudgetExceededError(PARENT_CANCELLED, 0, 0);
  }
}

const CANCEL_ACTOR = { type: "agent", id: "agent:hunt_flow" } as const;

/** 取消机制注入面（flow/task-flow 只消费 board；装配层消费 requestCancel）。 */
export interface LoopCancel {
  board: CancelBoard;
  /** 落取消：信号板首写 + m2 PATCH 写半边（hypothesis cancelled）+ 五要素审计（INV-8）。
   *  返回 false = 该假设已有在先取消（首写 wins，幂等）。 */
  requestCancel(
    hypothesisId: string,
    reason: LoopCancelReason,
    source: LoopCancelSource,
  ): Promise<boolean>;
  /** 撤销总线订阅（进程退出前）。 */
  stop(): void;
}

/** 取消机制总成：信号板 + 预算强杀事件订阅（行为 11 的消费半边）。
 *  订阅是同步挂上的（工厂构造即生效），预算强杀的 error 事件不会漏接。 */
export function makeLoopCancel(deps: {
  bus: LoopEventBus;
  ledger: HuntLedger;
  port: HypothesisPort;
  /** 五要素审计 sink（缺省丢弃——与 graph.ts 的测试便利口径同款）。 */
  audit?: AuditSink;
  /** 结构化日志（缺省静默；生产打 console）。 */
  log?(entry: Record<string, unknown>): void;
}): LoopCancel {
  const board = new CancelBoard();

  const requestCancel = async (
    hypothesisId: string,
    reason: LoopCancelReason,
    source: LoopCancelSource,
  ): Promise<boolean> => {
    if (!hypothesisId) return false;
    // 首写 wins：竞态（人取消先到 vs 预算触发后到）不再改写原因与账面
    if (!board.cancel(hypothesisId, { reason, source, at: Date.now() })) return false;
    try {
      // 生产通路（票 77 L0 裁决②）：m2 取消端点已把账面落成 cancelled（hypothesis.cancelled
      // 同事务先行）——账面已是终态就不再重复 PATCH（远端 409 原样上抛的 adapter 契约不动），
      // 机制侧只补停止链；循环侧取消（预算触发/循环终局）账面仍在 hunting，照走 PATCH。
      const detail = await deps.port.getDetail(hypothesisId);
      if (detail?.status !== "cancelled") {
        await deps.port.transition(hypothesisId, "cancelled", { reason });
      }
    } catch (err) {
      // INV-1 不吞错：竞态终态（对端已终局）也留 FAILURE 审计痕；信号板状态保持
      deps.audit?.record({
        action: "hunt_cancel_transition_denied",
        actor: CANCEL_ACTOR,
        objectId: hypothesisId,
        objectType: "hypothesis",
        details: { reason, source, error: String(err) },
        requestId: `hunt_cancel_${hypothesisId}`,
        result: "FAILURE",
        createdAt: Date.now(),
      });
      deps.log?.({ warn: "hunt_cancel_transition_failed", hypothesis_id: hypothesisId, reason, error: String(err) });
    }
    // 五要素审计（INV-8）：取消决定条目（谁/为何/何时可回放）——父链审计的一段
    deps.audit?.record({
      action: "hunt_cancel",
      actor: CANCEL_ACTOR,
      objectId: hypothesisId,
      objectType: "hypothesis",
      details: { reason, source },
      requestId: `hunt_cancel_${hypothesisId}`,
      result: "SUCCESS",
      createdAt: Date.now(),
    });
    deps.log?.({ info: "hunt_cancelled", hypothesis_id: hypothesisId, reason, source });
    return true;
  };

  const unsub = deps.bus.subscribe((e) => {
    if (e.type !== "error" || e.payload.code !== "budget_exceeded") return;
    if (e.payload.kind === PARENT_CANCELLED) return; // 停止痕不是新取消源（防自激）
    const link = deps.ledger.get(e.runId);
    if (!link || link.role !== "round") return; // 只认轮次 run 的预算强杀；子 run 预算归子 run
    void requestCancel(link.hypothesisId, cancelReasonOfBudgetKind(e.payload.kind), "budget").catch(
      (err: unknown) => deps.log?.({ warn: "hunt_cancel_watch_failed", error: String(err) }),
    );
  });

  return { board, requestCancel, stop: unsub };
}
