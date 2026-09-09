// agent 内部共享件（票 43·F1，结构-6 收敛）：工具调用验票闸的唯一拼装处。
//
// 票 43 之前，六处 gated（五个 worker flow + triage/close.ts，同款还有 m3 的审批变体
// executeApproved）各持一份闭包：paramsHash → verifyTicket → 闸拒（审计 DENIED + 抛错）
// → 放行执行。安全语义被复印了六遍，还漂移出三处微差（体检报告 结构-6）：
//   ① 闸拒错误前缀各异（triage_/investigation_/knowledge_/chat_/enrichment_/approval_）；
//   ② chat 的 tool_call 事件多一个 tier 字段；
//   ③ chat/knowledge 验票凭据多带 caseId（案件绑定校验 FR-S2.2）。
// 收进来之后，「闸拒审计长什么样」只在这一处定义：action=deny / result=DENIED /
// details{tool, reason, params_hash, ...} 与错误拼法 `${prefix}_gate_denied:${reason}`
// 都不再有第二份手抄。差异点全部参数化，闸体只有一份。
//
// 注意：闸拒抛错是 INV-1 的 fail-closed 锚——investigation flow 靠错误消息里的
// "_gate_denied:" 识别「闸拒不吞」，改拼法先过那道 string 匹配。
import { paramsHash, verifyTicket, type VerifyCtx, type VerifyResult } from "./verify-ticket.js";
import type { NodeCtx } from "./graph.js";

/** 闸拒审计条目（调用方的 record 闭包负责补 actor/requestId/createdAt 三要素）。 */
export interface GateDenyEntry {
  action: "deny";
  objectId: string;
  objectType: string;
  details: Record<string, unknown>;
  result: "DENIED";
}

export interface GateDenyInfo {
  tool: string;
  reason: string;
  paramsHash: string;
}

/** 闸拒审计的落点差异（六处的 objectId/objectType/details 增量各不相同）：
 *  worker 记 tool_call/runId+node；审批变体记 approval/approvalId 无 node。
 *  条目本体（action/result/details 骨架）仍由本件装配——落点在这里声明，拼装只有一份。 */
export interface GateDenySite {
  record: (entry: GateDenyEntry) => void;
  objectId: string;
  objectType: string;
  extraDetails?: Record<string, unknown>;
}

export interface GatedCallDeps {
  /** 差异①：闸拒错误前缀 → `${prefix}_gate_denied:${reason}`。 */
  prefix: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  /** 差异③：验票凭据——任务票 {ticket, runId[, caseId]} 或审批变体
   *  {approvalToken, caseId, used}。做成回调：凭据里的 used（票 34 焚毁读口装填）
   *  是每次调用现算的。 */
  creds: (tool: string, params: Record<string, unknown>) => VerifyCtx;
  /** 闸拒审计落点（见 GateDenySite）。 */
  deny: (info: GateDenyInfo) => GateDenySite;
  /** 差异②：放行广播。worker 在验票通过后 emit tool_call、执行成功后 emit tool_result
   *  （chat 的 tier 在这里拼）；不传 = 只验票与闸拒（审批变体的 tool_call 在验票【前】
   *  自发、tool_result 带执行结果走自己的收尾，事件顺序一动就是行为变化，不许并）。 */
  emitToolCall?: (ctx: NodeCtx, info: { tool: string; paramsHash: string }) => void;
  emitToolResult?: (ctx: NodeCtx, info: { tool: string }) => void;
  /** 验票通过后的读口（审批变体从中取 jti 做焚毁/执行标记；worker 任务票用不到）。 */
  onAllow?: (verdict: Extract<VerifyResult, { allow: true }>) => void;
}

/** 六处验票闸的共享本体：hash → verifyTicket → 闸拒（审计 DENIED + 抛错强杀）→
 *  放行执行。返回函数签名与原各 worker 的 gated 一致（ctx, tool, params, action）；
 *  泛型在返回函数上——每个调用点从自己的 action 推断返回类型，行为与原闭包相同。 */
export function makeGatedCall(deps: GatedCallDeps) {
  return async <T>(
    ctx: NodeCtx,
    tool: string,
    params: Record<string, unknown>,
    action: () => Promise<T>,
  ): Promise<T> => {
    const hash = paramsHash(params);
    const verdict = verifyTicket(
      { name: tool, params },
      deps.creds(tool, params),
      Math.floor(Date.now() / 1000),
      { hmacKey: deps.hmacKey },
    );
    if (!verdict.allow) {
      const site = deps.deny({ tool, reason: verdict.reason, paramsHash: hash });
      site.record({
        action: "deny",
        objectId: site.objectId,
        objectType: site.objectType,
        details: { tool, reason: verdict.reason, params_hash: hash, ...site.extraDetails },
        result: "DENIED",
      });
      throw new Error(`${deps.prefix}_gate_denied:${verdict.reason}`);
    }
    deps.onAllow?.(verdict);
    deps.emitToolCall?.(ctx, { tool, paramsHash: hash });
    const result = await action();
    deps.emitToolResult?.(ctx, { tool });
    return result;
  };
}
