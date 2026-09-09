// m4 分诊 worker · 四分类子图（票 13）。
//
// PRD §6-M4 子图：load_alert → kb_check(L0) → merge_check(L0) → self_audit_checkpoint
// → verdict_llm(结构化输出) → outcome。作为 FlowNode[] 挂进 m3 的 runner（graph.ts）：
// 盖章/预算/审计/信封链全由 runner 管，这里只管「分诊这件事本身」。
//
// 安全语义（全部落在代码结构上，不靠 prompt 品格）：
//   - 每个工具调用先过 verifyTicket（L1 任务票，INV-3：票面 scope 无任何 L2），闸拒
//     = 审计 DENIED + 抛错强杀（fail-closed，INV-1）；worker 侧没有 executeApproved、
//     没有 ApprovalToken 通道——「物理无 L2 票」。
//   - 不可信段（description / 带 untrusted 标记的 observables / KB 命中）进 prompt 前
//     过 guards /scan/injection（FR-S3.2）+ wrapUntrusted 包装（FR-S3.1）；block 一律
//     换占位符，原文一个字节不进 prompt。
//   - 拾取告警先向 M2 claim verdict（FR-M4.5 条件更新锁）：抢锁失败的 run 让路，
//     「并发同告警只分诊 1 次」。
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { makeGatedCall } from "../../src/gated-call.js";
import { scanInjection, type ScanChannel, type ScanOptions } from "../../src/guards-client.js";
import type { AuditSink } from "../../src/audit.js";
import {
  buildTriagePrompt,
  TO_M2_VERDICT,
  type KbHit,
  type LlmCall,
  type MergeCheck,
  type TriageInput,
  type UntrustedField,
} from "./prompt.js";
import { parseVerdict, uncertainFallback, type VerdictOutput } from "./schema.js";
import type { TriageLlm } from "./llm.js";
import type { TriageKb } from "./kb.js";
import { toMergeCheck, type AlertDto, type TriageM2 } from "./m2.js";

type ScanFn = (text: string, channel: ScanChannel, opts?: ScanOptions) => Promise<
  Awaited<ReturnType<typeof scanInjection>>
>;

export interface TriageDeps {
  runId: string;
  requestId: string;
  /** L1 任务票 wire 串（m3 拉起 worker 时经 gateway 铸出，allowed_tools=TRIAGE_TOOLS）。 */
  ticket: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  m2: TriageM2;
  kb: TriageKb;
  llm: TriageLlm;
  /** guards 扫描出站 seam：默认 HTTP scanInjection；测试注入确定性假件。 */
  scan?: ScanFn;
  scanOpts?: ScanOptions;
  audit: AuditSink;
}

const ACTOR = { type: "agent", id: "agent:triage" } as const;

export function makeTriageFlow(deps: TriageDeps): FlowNode[] {
  const scan = deps.scan ?? scanInjection;

  // ---- worker 内共用小件 ----

  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    deps.audit.record({ ...entry, actor: ACTOR, requestId: deps.requestId, createdAt: Date.now() });
  };

  const hostOf = (alert: AlertDto): string =>
    alert.observables?.find((o) => o.dataType === "hostname")?.data ?? alert.sourceRef;
  const pathOf = (alert: AlertDto): string | undefined =>
    alert.observables?.find((o) => o.dataType === "filename")?.data;
  const userOf = (alert: AlertDto): string | undefined =>
    alert.observables?.find((o) => o.dataType === "other")?.data;

  /** 工具调用唯一入口：广播 tool_call → verifyTicket（L1 任务票）→ 放行执行 →
   *  tool_result。闸拒 = 审计 DENIED + 抛错（runner 强杀 run；INV-1 不吞错）。
   *  注意 worker 里没有 awaitApproval/executeApproved——L2 的正门不在它的能力面内。
   *  票 43：闸体收进共享 makeGatedCall（本文件只声明差异点：前缀/凭据/审计落点）。 */
  const cursor = { node: "" }; // 节点名仅供审计细节；权威节点轨迹走 runner 的 node_enter 事件

  const gated = makeGatedCall({
    prefix: "triage",
    hmacKey: deps.hmacKey,
    creds: () => ({ ticket: deps.ticket, runId: deps.runId }),
    deny: () => ({
      record,
      objectId: deps.runId,
      objectType: "tool_call",
      extraDetails: { node: cursor.node },
    }),
    emitToolCall: (ctx, { tool, paramsHash: hash }) =>
      ctx.emit("tool_call", { node: cursor.node, tool, params_hash: hash }),
    emitToolResult: (ctx, { tool }) => ctx.emit("tool_result", { node: cursor.node, tool, ok: true }),
  });

  /** 一个不可信段进 prompt 前的完整安检：guards 扫描 → 按裁决清洗。block/fail_closed
   *  → 占位符 + 审计 DENIED（原文不进 prompt，INV-1）；wrapUntrusted 包装在
   *  buildTriagePrompt 里统一做。 */
  async function scanField(field: string, content: string, channel: ScanChannel): Promise<UntrustedField> {
    const d = await scan(content, channel, deps.scanOpts);
    if (!d.blocked) {
      return { field, content: d.action === "strip" && d.text ? d.text : content };
    }
    record({
      action: "guards_block",
      objectId: deps.runId,
      objectType: "untrusted_field",
      details: { field, channel, action: d.action, reason: d.reason ?? null, score: d.score ?? null },
      result: "DENIED",
    });
    return { field, content: `[removed by guards: ${d.action}${d.reason ? `:${d.reason}` : ""}]` };
  }

  const skipped = (ctx: NodeCtx): boolean =>
    (ctx.state.triage as { skipped?: boolean } | undefined)?.skipped === true;

  // ---- 子图节点（PRD §6-M4）----

  const nodes: FlowNode[] = [
    {
      name: "load_alert",
      run: async (ctx) => {
        cursor.node = "load_alert";
        const alertId = ctx.state.alert_id as string;
        const alert = await gated(ctx, "get_alert", { alert_id: alertId }, () => deps.m2.getAlert(alertId));
        if (!alert) throw new Error(`alert_not_found:${alertId}`);
        ctx.state.alert = alert;
        // FR-M4.5 拾取即锁（M2 条件更新 WHERE verdict IS NULL）。抢锁失败 = 另一个
        // run 已拾取同一条告警：本 run 让路（completed + skipped），绝不重复分诊。
        const claim = await deps.m2.claimVerdict(alertId);
        if (!claim.ok) {
          ctx.state.triage = { skipped: true, reason: claim.reason };
          record({
            action: "triage_skip",
            objectId: alertId,
            objectType: "alert",
            details: { reason: claim.reason, run_id: deps.runId },
            result: "SUCCESS",
          });
        }
      },
    },
    {
      name: "kb_check",
      run: async (ctx) => {
        if (skipped(ctx)) return;
        cursor.node = "kb_check";
        const alert = ctx.state.alert as AlertDto;
        const params = { host: hostOf(alert), path: pathOf(alert) ?? "", user: userOf(alert) ?? "" };
        const hits = await gated(ctx, "kb_lookup", params, () =>
          deps.kb.lookup({
            host: params.host || undefined,
            path: params.path || undefined,
            user: params.user || undefined,
          }),
        );
        // m7 卡备注：检索注入内容同样过不可信包装（guards kb 通道：命中 strip 清洗，
        // block 剔除该条）——知识库内容对 LLM 仍是数据不是指令。
        const cleaned: KbHit[] = [];
        for (const hit of hits) {
          const d = await scan(`${hit.title}\n${hit.body}`, "kb", deps.scanOpts);
          if (d.blocked) {
            record({
              action: "guards_block",
              objectId: deps.runId,
              objectType: "kb_hit",
              details: { title: hit.title, action: d.action, reason: d.reason ?? null },
              result: "DENIED",
            });
            continue;
          }
          cleaned.push(d.action === "strip" && d.text ? { ...hit, body: d.text } : hit);
        }
        ctx.state.kb = cleaned;
      },
    },
    {
      name: "merge_check",
      run: async (ctx) => {
        if (skipped(ctx)) return;
        cursor.node = "merge_check";
        const alert = ctx.state.alert as AlertDto;
        const host = hostOf(alert);
        // FR-M2.4 / FR-M4.3：同主机 24h 活跃 case（L0 读，照样过闸）
        const cases = await gated(ctx, "search_cases_by_host", { host, within_hours: 24 }, () =>
          deps.m2.findActiveCases(host, 24));
        const merge: MergeCheck = toMergeCheck(host, 24, cases);
        ctx.state.merge = merge;
      },
    },
    {
      name: "self_audit_checkpoint",
      run: (ctx) => {
        if (skipped(ctx)) return;
        const merge = ctx.state.merge as MergeCheck;
        // FR-M4.4：建案前输出结构化声明——软约束变可检验 artifact（验收：100% 出现）
        const declaration = {
          open_cases_checked: merge.openCasesChecked,
          host_searched: merge.host,
          same_host_case_found: merge.sameHostCaseFound,
        };
        ctx.state.self_audit = declaration;
        record({
          action: "self_audit_checkpoint",
          objectId: deps.runId,
          objectType: "triage",
          details: declaration,
          result: "SUCCESS",
        });
        ctx.emit("audit", { action: "self_audit_checkpoint", ...declaration });
      },
    },
    {
      name: "verdict_llm",
      run: async (ctx) => {
        if (skipped(ctx)) return;
        cursor.node = "verdict_llm";
        const alert = ctx.state.alert as AlertDto;
        const merge = ctx.state.merge as MergeCheck;
        // FR-S3.1/S3.2：不可信段逐段过 guards（alert_field 通道）再包装进 prompt
        const untrusted: UntrustedField[] = [];
        if (alert.description) {
          untrusted.push(await scanField("description", alert.description, "alert_field"));
        }
        for (const o of alert.observables ?? []) {
          if (o.tags?.includes("untrusted")) {
            untrusted.push(await scanField(`observable:${o.dataType}`, o.data, "alert_field"));
          }
        }
        const input: TriageInput = {
          alert: {
            id: alert.id,
            title: alert.title,
            severity: alert.severity,
            tags: alert.tags,
            host: hostOf(alert),
          },
          untrusted,
          kbHits: (ctx.state.kb as KbHit[]) ?? [],
          merge,
        };
        const call: LlmCall = { prompt: buildTriagePrompt(input), input };

        // LLM 调用 + 资源兜底计费/墙钟（m3 预算闸在 worker 侧的真实消费点）
        const startedAt = Date.now();
        let reply = await deps.llm.verdict(call);
        ctx.charge(reply.tokens);
        let parsed = parseVerdict(reply.text);
        if (!parsed.ok) {
          // PRD 异常与边界：不合 schema 重试 1 次，仍失败置 uncertain（宁可升级人工不可猜）
          record({
            action: "llm_retry",
            objectId: deps.runId,
            objectType: "triage",
            details: { error: parsed.error },
            result: "FAILURE",
          });
          reply = await deps.llm.verdict(call);
          ctx.charge(reply.tokens);
          parsed = parseVerdict(reply.text);
        }
        ctx.checkLlm(startedAt, Date.now());
        const out: VerdictOutput = parsed.ok ? parsed.verdict : uncertainFallback(parsed.error, merge);

        // 自我审计声明 vs merge_check 实际结果矛盾 → 强制降级 uncertain（PRD 异常与边界）
        let final = out;
        if (out.verdict !== "uncertain" && out.self_audit.same_host_case_found !== merge.sameHostCaseFound) {
          record({
            action: "self_audit_mismatch",
            objectId: deps.runId,
            objectType: "triage",
            details: { declared: out.self_audit.same_host_case_found, actual: merge.sameHostCaseFound },
            result: "FAILURE",
          });
          final = {
            ...out,
            verdict: "uncertain",
            confidence: 0,
            rationale: `self_audit 与 merge_check 矛盾（声明 same_host_case_found=${out.self_audit.same_host_case_found}，实际=${merge.sameHostCaseFound}）`,
            recommended_action: "human",
          };
        }
        ctx.state.verdict = final;
      },
    },
    {
      name: "outcome",
      run: async (ctx) => {
        if (skipped(ctx)) return;
        cursor.node = "outcome";
        const alert = ctx.state.alert as AlertDto;
        const merge = ctx.state.merge as MergeCheck;
        const verdict = ctx.state.verdict as VerdictOutput;
        let action = verdict.recommended_action;

        // 三结局动词（m4 卡「输出写回 M2：verdict_ai + 三结局动词」）：
        //   TP → merge（同主机 24h 有活跃 case，FR-M4.3）/ create_case（L1，过闸）；
        //   FP/BTP → 只落 verdict_ai + close 建议（演示模式关单需 SOC1 确认，FR-M4.5）；
        //   Uncertain → Alert 置 InProgress 挂人工待办（PRD 消息旅程 6）。
        if (verdict.verdict === "tp") {
          if (merge.sameHostCaseFound && merge.candidateCaseId) {
            action = `merge:${merge.candidateCaseId}`;
            const target = merge.candidateCaseId;
            // alert 状态机（CONTEXT.md）：New 不能直达 Imported，先把拾取落成 InProgress
            const st = await deps.m2.patchOutcome(alert.id, { status: "InProgress" });
            if (!st.ok) throw new Error(`m2_patch_failed:${st.reason}`);
            await gated(ctx, "merge_alert", { alert_id: alert.id, case_id: target }, () =>
              deps.m2.mergeAlert(alert.id, target));
          } else {
            const created = await gated(ctx, "create_case", { alert_id: alert.id }, () =>
              deps.m2.createCase(alert.id));
            action = "create_case";
            ctx.state.case_id = created.caseId;
          }
        }

        const patch: { verdict: string; verdict_ai: unknown; status?: string } = {
          verdict: TO_M2_VERDICT[verdict.verdict],
          verdict_ai: { ...verdict, recommended_action: action, agent_run_id: deps.runId },
        };
        if (verdict.verdict === "uncertain") patch.status = "InProgress";
        const res = await deps.m2.patchOutcome(alert.id, patch);
        if (!res.ok) throw new Error(`m2_patch_failed:${res.reason}`);
        ctx.state.outcome = { action, m2_verdict: patch.verdict };
      },
    },
  ];
  return nodes;
}
