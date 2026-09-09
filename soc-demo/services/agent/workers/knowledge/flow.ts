// m7 知识沉淀 worker · 提炼子图（票 17）。
//
// PRD §6-M7 图：case_closed(event) → knowledge_distill → human_review_gate → kb_write → END。
// 落成 FlowNode[] 挂进 m3 的 LangGraph runner（票 23 编排），两节点各管一件事：
//   - knowledge_distill：读案件（L1 get_case 过任务票闸）→ ASP 门控（无人工 verdict 的
//     案件跳过抽取，FR-M7.1；后端关案 409 已防，这里防御再拦）→ LLM 提炼（schema 把关）
//     → kb_propose（L1）在 M2 建提案（proposed 草稿）。PRD 的 human_review_gate 不是
//     独立节点——它就是 kb_write 节点里 executeApproved 开卡 interrupt 的挂起点。
//   - kb_write：executeApproved("kb_write", {提案 + 草稿全文}, …) —— L2 唯一正门：
//     值班长批准（铸 ApprovalToken → 闸验签 → 焚毁）后才执行动作：
//       ① M2 approve（proposed→approved 账面留痕）② chroma upsert（approved 进检索面，
//       INV-5）；驳回 → M2 reject + 检索面永不写入（rejected 永不检索）。
//
// 安全语义（结构保证，不靠 prompt 品格）：
//   - 任务票 allowed_tools = KNOWLEDGE_TOOLS（get_case/kb_propose）——kb_write 是 L2，
//     物理不在票面（INV-3）；它只能经审批卡铸一次性 ApprovalToken（INV-2/9）。
//   - 案件里的不可信段（timeline 内嵌告警原文）进 prompt 前 wrapUntrusted 包装（FR-S3.1）；
//     提炼产物必经人审（D8 入库闸 = RAG 投毒第一道防线，FR-M7.5），检索注入侧的不可信
//     包装由 triage kb_check 既有 guards kb 通道承担（票 13 已落）。
//   - resume 重入幂等：M2 裁决 409（已裁决）视为已完成，chroma upsert 本身幂等——
//     「action 执行后、执行标记落库前崩溃」的窗口重放不会重复入账。
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { makeGatedCall } from "../../src/gated-call.js";
import type { AuditSink } from "../../src/audit.js";
import type { UntrustedField } from "../triage/prompt.js";
import { buildKnowledgePrompt } from "./prompt.js";
import { parseDraft } from "./schema.js";
import type { KnowledgeLlm } from "./llm.js";
import type { KnowledgeM2 } from "./m2.js";
import type { VectorStore } from "./vector-store.js";

export interface KnowledgeDeps {
  runId: string;
  requestId: string;
  /** L1 任务票 wire 串（m3 拉起时经 gateway 铸，allowedTools=KNOWLEDGE_TOOLS）。 */
  ticket: string;
  /** 沉淀目标案件（knowledge_flow 的入口参数，FR-M7.1 案件关闭触发）。 */
  caseId: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  m2: KnowledgeM2;
  /** 检索面（生产 RealChromaClient → chroma 容器；测试 MemoryVectorStore）。 */
  store: VectorStore;
  llm: KnowledgeLlm;
  audit: AuditSink;
}

const ACTOR = { type: "agent", id: "agent:knowledge" } as const;
/** M2 账面 reviewed_by 的缺省留痕（真实人审身份锚在审批卡 + ApprovalToken，INV-9）。 */
const REVIEWER = "duty_lead";

export function makeKnowledgeFlow(deps: KnowledgeDeps): FlowNode[] {
  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    deps.audit.record({ ...entry, actor: ACTOR, requestId: deps.requestId, createdAt: Date.now() });
  };

  /** 工具调用唯一入口（L1）：广播 tool_call → verifyTicket → 放行 → tool_result。
   *  闸拒 = 审计 DENIED + 抛错（runner 强杀；INV-1 不吞错）。票 43：闸体收进共享
   *  makeGatedCall——差异点：前缀 knowledge / 凭据带 caseId（案件绑定校验 FR-S2.2：
   *  沉淀票只对本 run 的 case 有效）。 */
  const cursor = { node: "" };

  const gated = makeGatedCall({
    prefix: "knowledge",
    hmacKey: deps.hmacKey,
    creds: () => ({ ticket: deps.ticket, runId: deps.runId, caseId: deps.caseId }),
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

  const skipped = (ctx: NodeCtx): boolean =>
    (ctx.state.knowledge as { skipped?: boolean } | undefined)?.skipped === true;

  const nodes: FlowNode[] = [
    {
      name: "knowledge_distill",
      run: async (ctx) => {
        cursor.node = "knowledge_distill";
        // 读案件详情（L1 get_case，案件绑定过闸）
        const detail = await gated(ctx, "get_case", { case_id: deps.caseId }, () =>
          deps.m2.getCase(deps.caseId));
        if (!detail) throw new Error(`case_not_found:${deps.caseId}`);

        // ASP 门控（FR-M7.1）：无人工 verdict 的案件跳过抽取（后端关案 409 已防，防御再拦）
        if (!detail.verdict) {
          ctx.state.knowledge = { skipped: true, reason: "no_verdict" };
          record({
            action: "knowledge_skip",
            objectId: deps.caseId,
            objectType: "case",
            details: { reason: "no_verdict", run_id: deps.runId },
            result: "SUCCESS",
          });
          return;
        }

        // 不可信段：案件描述 + timeline 正文（内嵌告警原文）——wrapUntrusted 标记包装
        const untrusted: UntrustedField[] = [];
        if (detail.description) {
          untrusted.push({ field: "case:description", content: detail.description });
        }
        (detail.timeline ?? []).forEach((t, i) => {
          if (t.body) untrusted.push({ field: `timeline:${i}`, content: t.body });
        });
        const host = detail.observables?.find((o) => o.dataType === "hostname")?.data ?? "";
        const input = {
          kase: {
            id: detail.id,
            title: detail.title,
            description: detail.description,
            severity: detail.severity,
            verdict: detail.verdict,
            verdict_note: detail.verdictNote,
            tags: detail.tags,
            host,
            timeline: detail.timeline ?? [],
          },
          untrusted: untrusted.map((f) => ({ field: f.field, content: f.content })),
        };
        const call = { prompt: buildKnowledgePrompt(input), input };

        // LLM 提炼 + 预算计费/墙钟（m3 预算闸在 worker 侧的真实消费点）
        const startedAt = Date.now();
        let reply = await deps.llm.distill(call);
        ctx.charge(reply.tokens);
        let parsed = parseDraft(reply.text);
        if (!parsed.ok) {
          // 不合 schema 重试 1 次，仍失败 → skip（宁可不错提，不可编造）
          record({
            action: "llm_retry",
            objectId: deps.runId,
            objectType: "knowledge",
            details: { error: parsed.error },
            result: "FAILURE",
          });
          reply = await deps.llm.distill(call);
          ctx.charge(reply.tokens);
          parsed = parseDraft(reply.text);
        }
        ctx.checkLlm(startedAt, Date.now());
        if (!parsed.ok || parsed.skip) {
          const reason = parsed.ok ? parsed.reason : parsed.error;
          ctx.state.knowledge = { skipped: true, reason };
          record({
            action: "knowledge_skip",
            objectId: deps.caseId,
            objectType: "case",
            details: { reason, run_id: deps.runId },
            result: "SUCCESS",
          });
          return;
        }

        // kb_propose（L1）：M2 建档（proposed 草稿——此时检索面不可见，INV-5）
        const draft = parsed.draft;
        const proposal = await gated(ctx, "kb_propose", {
          kind: draft.kind, title: draft.title, source_case_id: deps.caseId,
        }, () =>
          deps.m2.createProposal({
            kind: draft.kind, title: draft.title, body: draft.body, tags: draft.tags,
            source_case_id: deps.caseId, proposed_by: "agent:knowledge",
          }));
        ctx.state.proposal = { id: proposal.id, ...draft, source_case_id: deps.caseId };
      },
    },
    {
      name: "kb_write",
      // PRD 图里的 human_review_gate：executeApproved 开卡 interrupt（审批卡 tool=kb_write，
      // params 带草稿全文——值班长在卡上看到要入库的东西，D8 投毒防线）。批准：闸验签 →
      // 焚毁 → 执行体（M2 approve 账面 + chroma upsert 检索面）；驳回：M2 reject 账面，
      // 检索面永不写入。
      run: async (ctx) => {
        if (skipped(ctx)) return;
        cursor.node = "kb_write";
        const proposal = ctx.state.proposal as {
          id: string; kind: string; title: string; body: string; tags: string[];
          source_case_id: string;
        };
        const params = {
          proposal_id: proposal.id,
          kind: proposal.kind,
          title: proposal.title,
          body: proposal.body,
          tags: proposal.tags,
          source_case_id: proposal.source_case_id,
        };
        const out = await ctx.executeApproved(
          "kb_write",
          params,
          { caseId: deps.caseId, reason: "KBEntry 人审入库闸（D8）：批准 → approved 进 chroma 检索面" },
          async (p) => {
            const q = p as typeof params;
            // ① 账面：proposed→approved（已裁决 409 = resume 重入，幂等放行）
            const approve = await deps.m2.approveProposal(q.proposal_id, REVIEWER);
            if (!approve.ok && approve.reason !== "InvalidTransition") {
              throw new Error(`m2_kb_approve_failed:${approve.reason}`);
            }
            // ② 检索面：approved 进 chroma（upsert 幂等）。这一步只会在这条已验签的
            //    执行路径上发生——INV-5 的结构保证。
            await deps.store.upsert({
              id: q.proposal_id,
              text: `${q.title}\n${q.body}`,
              metadata: {
                kind: q.kind,
                title: q.title,
                source_case_id: q.source_case_id,
                tags: q.tags,
              },
            });
            return { kb_id: q.proposal_id, proposal_id: q.proposal_id, status: "approved" };
          },
        );
        if (!out.executed) {
          // 值班长驳回：账面 proposed→rejected（已裁决 409 幂等放行）；检索面零写入
          const rej = await deps.m2.rejectProposal(params.proposal_id, REVIEWER, "审批卡驳回");
          if (!rej.ok && rej.reason !== "InvalidTransition") {
            throw new Error(`m2_kb_reject_failed:${rej.reason}`);
          }
          ctx.state.kb_write = { executed: false, proposal_id: params.proposal_id, status: "rejected" };
          return;
        }
        ctx.state.kb_write = { executed: true, ...out.result };
      },
    },
  ];
  return nodes;
}
