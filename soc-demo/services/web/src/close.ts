// 一键确认关单的纯逻辑层（票 39；React 之外可单测，票 21 approvals.ts 同款套路）：
// - closeAdvised：verdict_ai 里有没有"待执行的关单建议"（fp/btp + recommended_action=close）；
// - closeRunFailText：关单 run 失败的 error 事件 message → 人话（409/已关/未分诊各有人话）；
// - closeErrorText：拉起 run 的 ApiError → 人话（502 铸票失败可重试）；
// - watchCloseRun：订阅关单 run 的 SSE（INV-7 同一落盘总线），终态回调一次。
//
// 人话文案的对照表在后端具名错误上：close_flow 子图（services/agent/workers/triage/close.ts）
// 的预检三连 + M2 状态机 409，每条都有具名 message，这里逐条接住，不认识的透传不编理由。
import { ReconnectingSse, type EventSourceFactory } from "./sse";

/** verdict_ai（worker 的原始判定对象）是否表示"建议关单待确认"。
 *  老数据/字符串 verdictAi 一律 false——没建议就不给确认入口，不猜。 */
export function closeAdvised(verdictAi: unknown): boolean {
  if (typeof verdictAi !== "object" || verdictAi === null) return false;
  const v = verdictAi as { verdict?: unknown; recommended_action?: unknown };
  const closable = v.verdict === "fp" || v.verdict === "btp" ||
    v.verdict === "false_positive" || v.verdict === "benign_true_positive";
  return closable && v.recommended_action === "close";
}

/** 关单 run 失败 → 页面上直接能念的提示（error 事件的 payload.message 是输入）。 */
export function closeRunFailText(message: string): string {
  const m = String(message ?? "");
  if (m.includes("close_already_closed")) {
    return "手慢了：这条告警已经是关单状态（可能已被别人确认），无需重复操作";
  }
  if (m.includes("InvalidTransition")) {
    return "关单被状态机拒绝（409 InvalidTransition）：告警当前状态不允许关闭，列表已刷新";
  }
  if (m.includes("close_verdict_missing")) {
    return "这条告警还没有确定的分诊结论，不能直接关单——先在流水线视图发起分诊";
  }
  if (m.includes("close_advice_missing")) {
    return "这条告警没有待执行的关单建议（AI 未建议关单），不予执行";
  }
  if (m.includes("triage_gate_denied")) {
    return "关单被验票闸拒绝（任务票授权不足），已留痕审计";
  }
  return `关单执行失败：${m || "连接中断（agent 未起？）"}`;
}

/** 拉起关单 run 失败（startRun 的 ApiError）→ 人话。 */
export function closeErrorText(e: unknown): string {
  const status = typeof e === "object" && e !== null && "status" in e ? Number((e as { status: unknown }).status) : NaN;
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (status === 502) {
    return "铸任务票失败（gateway 未起？）：关单未执行，可重试";
  }
  return `关单发起失败：${code || String(e)}`;
}

/** 订阅关单 run 的事件流，终态回调一次（成功/失败 + 人话）后自收流。
 *  终态判定与全仓同源（isTerminalSseEvent）：audit 镜像 status→completed/failed，
 *  或 error 事件。factory 供测试注入替身。 */
export function watchCloseRun(
  runId: string,
  opts: { onTerminal: (ok: boolean, failText: string) => void; factory?: EventSourceFactory },
): ReconnectingSse {
  let settled = false;
  const settle = (ok: boolean, failText: string): void => {
    if (settled) return;
    settled = true;
    sse.close();
    opts.onTerminal(ok, failText);
  };
  const sse = new ReconnectingSse({
    runId,
    factory: opts.factory,
    onEvent: (ev) => {
      if (ev.type === "error") {
        settle(false, closeRunFailText(String(ev.payload.message ?? "")));
        return;
      }
      if (ev.type === "audit") {
        const to = (ev.payload.status as { to?: string } | undefined)?.to;
        if (to === "completed") settle(true, "");
        else if (to === "failed") settle(false, closeRunFailText(""));
      }
    },
    // 连着几条连接啥也没收到（run 不存在/agent 病了）：按失败收手，不空转
    onStatus: (s) => {
      if (s === "ended") settle(false, closeRunFailText(""));
    },
  });
  return sse;
}
