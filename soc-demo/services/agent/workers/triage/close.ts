// m4 分诊 worker · SOC1 一键确认关单子图（票 39，FR-M4.5 演示口径·G2-7 清偿）。
//
// 分诊对 FP/BTP 只产出关闭建议（票 13 偏差②留的口子），这里补上"有人确认后真执行"
// 的下半场：web 告警页 SOC1 点确认 → m3 拉起 close_flow run（/internal/runs 同一张
// 拉起面，铸最小任务票）→ 本子图两节点 → 审计/时间线留痕。
//
// 安全语义与分诊子图同款（落在代码结构上，不靠 prompt 品格）：
//   - close_alert 是 A.1 的 L1 工具——执行前过 verifyTicket（L1 任务票，票面只有
//     get_alert + close_alert 两件，INV-3：无任何 L2）；闸拒 = 审计 DENIED + 抛错强杀。
//   - 闸先于一切写：先置 InProgress（票 13 偏差②的状态机前置）放在【闸内的动作】里，
//     票面缺 close_alert 时告警一个字节不动（fail-closed：无票不落地）。
//   - 预检三连（建议在不在 / verdict 定没定 / 是不是已关）都给具名错误——failReason
//     与 error 事件带出去，web 侧逐条映射成人话（409/已关/未分诊各有话术）。
//   - 确认人（deps.actor）进审计五要素（INV-8：确认动作要记是谁按的按钮）。
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { paramsHash, verifyTicket } from "../../src/verify-ticket.js";
import type { AuditSink } from "../../src/audit.js";
import type { TriageM2 } from "./m2.js";

export interface CloseFlowDeps {
  runId: string;
  requestId: string;
  /** L1 任务票 wire 串（m3 拉起时经 gateway 铸，allowed_tools=[get_alert, close_alert]）。 */
  ticket: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  m2: TriageM2;
  audit: AuditSink;
  /** 确认人（web 请求头 x-actor-id 随拉起传入）；缺省按执行体 agent:triage 记。 */
  actor?: { type: string; id: string };
}

/** M2 verdict 终值全集（PRD §5.1）——in-progress/null 都不算定，不能拿去关单。 */
const M2_FINAL_VERDICTS = new Set(["false_positive", "benign_true_positive", "true_positive", "uncertain"]);

export function makeCloseFlow(deps: CloseFlowDeps): FlowNode[] {
  const actor = deps.actor ?? { type: "agent", id: "agent:triage" };
  const cursor = { node: "" }; // 节点名仅供审计细节；权威节点轨迹走 runner 的 node_enter 事件

  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    deps.audit.record({ ...entry, actor, requestId: deps.requestId, createdAt: Date.now() });
  };

  /** 工具调用唯一入口：广播 tool_call → verifyTicket（L1 任务票）→ 放行执行 →
   *  tool_result。闸拒 = 审计 DENIED + 抛错（runner 强杀 run；INV-1 不吞错）。
   *  与 triage flow 的 gated 同款——各 worker 自持一份闭包是本仓既有形态。 */
  async function gated<T>(
    ctx: NodeCtx,
    tool: string,
    params: Record<string, unknown>,
    action: () => Promise<T>,
  ): Promise<T> {
    const hash = paramsHash(params);
    const verdict = verifyTicket(
      { name: tool, params },
      { ticket: deps.ticket, runId: deps.runId },
      Math.floor(Date.now() / 1000),
      { hmacKey: deps.hmacKey },
    );
    if (!verdict.allow) {
      record({
        action: "deny",
        objectId: deps.runId,
        objectType: "tool_call",
        details: { tool, reason: verdict.reason, params_hash: hash, node: cursor.node },
        result: "DENIED",
      });
      throw new Error(`triage_gate_denied:${verdict.reason}`);
    }
    ctx.emit("tool_call", { node: cursor.node, tool, params_hash: hash });
    const result = await action();
    ctx.emit("tool_result", { node: cursor.node, tool, ok: true });
    return result;
  }

  // ---- 子图（两节点：先看清楚，再动手）----

  const nodes: FlowNode[] = [
    {
      name: "load_close_target",
      run: async (ctx) => {
        cursor.node = "load_close_target";
        const alertId = ctx.state.alert_id as string;
        const alert = await gated(ctx, "get_alert", { alert_id: alertId }, () => deps.m2.getAlert(alertId));
        if (!alert) throw new Error(`alert_not_found:${alertId}`);

        // 预检三连（具名错误 → failReason/error 事件 → web 人话）：
        // ① 分诊结论定了没有（verdict null/in-progress = 没分诊完，不猜）；
        // ② AI 建议是不是关单（确认按钮执行的是"建议"，不是自由关单权）；
        // ③ 是不是已经关了（重复确认/并发先到者——M2 状态机也会拦，这里给更早的人话）。
        if (!alert.verdict || !M2_FINAL_VERDICTS.has(alert.verdict)) {
          throw new Error(`close_verdict_missing:${alertId}`);
        }
        const advice = alert.verdictAi as { recommended_action?: unknown } | null;
        if (!advice || advice.recommended_action !== "close") {
          throw new Error(`close_advice_missing:${alertId}`);
        }
        if (alert.status === "Closed") {
          throw new Error(`close_already_closed:${alertId}`);
        }
        ctx.state.close_target = { alert_id: alert.id, verdict: alert.verdict, from_status: alert.status };
      },
    },
    {
      name: "execute_close",
      run: async (ctx) => {
        cursor.node = "execute_close";
        const target = ctx.state.close_target as { alert_id: string; verdict: string; from_status: string };
        // close_alert 整个动作（含状态机前置）都在闸内：票面缺 close_alert 时，
        // 先置 InProgress 也不许发生——「无票不落地」。
        await gated(ctx, "close_alert", { alert_id: target.alert_id, verdict: target.verdict }, async () => {
          // 状态机合法路径（票 13 偏差②）：New→Closed 非法，先置 InProgress 再关。
          // PATCH 幂等（M2 侧 status 不变即 no-op），Closed→InProgress 重开过的场景也合法。
          const pickup = await deps.m2.patchOutcome(target.alert_id, { status: "InProgress" });
          if (!pickup.ok) throw new Error(`m2_patch_failed:${pickup.reason}`);
          const closed = await deps.m2.closeAlert(target.alert_id, target.verdict);
          if (!closed.ok) throw new Error(`m2_close_failed:${closed.reason}`);
          return { alert: target.alert_id };
        });
        // 审批式留痕（INV-8 五要素）：确认动作记到确认人头上 + 镜像进时间线（SSE）
        record({
          action: "close_confirm",
          objectId: target.alert_id,
          objectType: "alert",
          details: {
            alert_id: target.alert_id,
            verdict: target.verdict,
            status: { from: target.from_status, to: "Closed" },
            run_id: deps.runId,
          },
          result: "SUCCESS",
        });
        ctx.emit("audit", { action: "close_confirm", alert_id: target.alert_id, verdict: target.verdict, to: "Closed" });
        ctx.state.close_result = { alert_id: target.alert_id, status: "Closed" };
      },
    },
  ];
  return nodes;
}
