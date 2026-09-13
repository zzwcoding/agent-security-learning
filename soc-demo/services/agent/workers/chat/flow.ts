// m8 对话 Copilot · chat_flow 子图（PRD §6-M8：登录角色 → RBAC 可见工具 → 输入预检 →
// 意图闸 → 执行 → SSE 流式回答）。作为 FlowNode[] 挂进 m3 的 LangGraph 编排（graph.ts），
// 盖章/预算/审计镜像/信封链全由 runner 管，这里只管「追问这件事本身」。
// 复用 m3/m5 的既有正门：
//   - 只读执行面 = investigation worker 的 M2/SIEM/KB adapter（m8 卡备注：追问数据从只读面来）；
//   - 动作执行面 = ctx.executeApproved（票 11 审批回路，开卡挂起 → 批准铸 ApprovalToken → 验签执行）。
//
// 安全语义（落在代码结构上，不靠 prompt 品格）：
//   - 输入预检：用户消息先过 guards /scan/injection（user_input 通道，票 24 llm-guard 主路径），
//     block/fail_closed 一律拒答 + DENIED 审计（INV-1）；
//   - 意图闸三态（gate.ts）：deny 的原因直接念给用户听（denied 事件），绝不在拒绝后继续执行；
//   - 只读工具过 verifyTicket 任务票（INV-3：chat 票面只有只读四件，无任何 L1/L2）；
//   - INV-9：对话历史里的「已批准」文字不构成授权——执行只有一条路：审批卡 → 签名
//     ApprovalToken → 验票闸。本文件从头到尾没有一行读消息文本来判断「是否已批准」。
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { makeGatedCall } from "../../src/gated-call.js";
import { scanInjection, type ScanChannel, type ScanOptions } from "../../src/guards-client.js";
import type { AuditSink } from "../../src/audit.js";
import type { FgaChecker } from "../../src/fga-client.js";
import { relatedAlerts, type InvestigationM2 } from "../investigation/m2.js";
import type { SiemBackend } from "../investigation/siem.js";
import type { KbLookupParams, TriageKb } from "../triage/kb.js";
import { decideIntent } from "./gate.js";
import { highRiskTools, tierOf, visibleTools } from "./visible-tools.js";
import type { AnswerInput, ChatLlm, ClassifyInput } from "./llm.js";

type ScanFn = (text: string, channel: ScanChannel, opts?: ScanOptions) => Promise<
  Awaited<ReturnType<typeof scanInjection>>
>;

/** FR-M8.6 案件上下文（field-profile 白名单）：只喂办案要用的显式字段，
 *  剔除 verdict_ai 等 AI 自写字段——防「模型读自己写的东西」自引用回路。 */
export interface CaseContext {
  id: string;
  title: string;
  severity: number;
  status: string;
  primaryDate: number;
  entities: { ips: string[]; users: string[]; hosts: string[]; files: string[] };
}

export interface ChatDeps {
  runId: string;
  requestId: string;
  /** 绑定案件（全局追问为 null）；案件上下文与审批卡绑定都从这里来。 */
  caseId: string | null;
  /** 只读任务票 wire 串（m3 拉起时经 gateway 铸出，allowed_tools=CHAT_READONLY_TOOLS）。 */
  ticket: string;
  /** 验票 HMAC 密钥（与闸同口径，缺省读 env SOC_HMAC_KEY）。 */
  hmacKey?: string;
  m2: InvestigationM2;
  siem: SiemBackend;
  kb: TriageKb;
  llm: ChatLlm;
  /** OpenFGA 检查器（票 12 真容器 / 测试注入 stub——m8 卡 Seam 双脚）。 */
  fga: FgaChecker;
  /** guards 扫描出站 seam：默认 HTTP scanInjection；测试注入确定性假件。 */
  scan?: ScanFn;
  scanOpts?: ScanOptions;
  audit: AuditSink;
}

/** chat 票面的只读工具集（= intent allow 态可能执行的全部；TICKET_SPECS.chat_flow 同源）。 */
export const CHAT_READONLY_TOOLS = ["get_alert", "kb_lookup", "related_alerts", "siem_query"] as const;

const ACTOR = { type: "agent", id: "agent:chat" } as const;
const DAY_MS = 24 * 3_600_000;
const IP_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;
const TOKEN_CHUNK = 16; // SSE token 帧的切块长度（FR-M8.5 流式形态）

// 薄径（无 worker 图装配时的兜底应答）：接口活着、行为诚实——不假装会答。
export const THIN_CHAT_FLOW: FlowNode[] = [
  {
    name: "chat_thin",
    run: (ctx) => {
      ctx.emit("token", { delta: "（chat_flow 未装配 worker 图：本实例是编排薄径，生产经 index.ts makeNodes 装配）" });
    },
  },
  { name: "done", run: (ctx) => void ctx.emit("done", {}) },
];

/** 意图参数从确定性事实推导（消息里的实体 / 案件白名单上下文），LLM 只提名工具不编参数。 */
export function deriveParams(
  tool: string,
  message: string,
  caseCtx: CaseContext | null,
  nowMs: number,
): Record<string, unknown> {
  const window = () => {
    const anchor = caseCtx?.primaryDate ?? nowMs;
    return { from: new Date(anchor - DAY_MS).toISOString(), to: new Date(anchor + DAY_MS).toISOString() };
  };
  const ip = message.match(IP_RE)?.[1] ?? caseCtx?.entities.ips[0] ?? null;
  switch (tool) {
    case "related_alerts":
      return { scope: "entity", value: ip ?? caseCtx?.entities.hosts[0] ?? "", time_window: window() };
    case "siem_query":
      return { entity_type: "ip", entity: ip ?? "", time_window: window() };
    case "get_alert":
      return { alert_id: caseCtx?.id ?? "" };
    case "kb_lookup":
      return { host: caseCtx?.entities.hosts[0] ?? "", user: caseCtx?.entities.users[0] ?? "" };
    case "isolate_host":
      return { host: message.match(/(?:主机|host)\s+([\w.-]+)/i)?.[1] ?? caseCtx?.entities.hosts[0] ?? "unknown-host" };
    case "block_ip":
      return { ip: ip ?? "0.0.0.0" };
    case "kb_write":
      return { title: message.slice(0, 40), body: message, case_id: caseCtx?.id ?? "" };
    default:
      return {};
  }
}

/** L2 动作的 mock 执行体（PRD §11：响应动作一律 mock，不对接真实 EDR/防火墙）。 */
function mockAction(tool: string): (params: unknown) => Record<string, unknown> {
  return (p) => {
    const params = p as Record<string, unknown>;
    if (tool === "isolate_host") return { mock_edr: "isolated", host: params.host };
    if (tool === "block_ip") return { mock_fw: "blocked", ip: params.ip };
    if (tool === "kb_write") return { mock_kb: "written", title: params.title };
    return { mock: "ok" };
  };
}

export function makeChatFlow(deps: ChatDeps): FlowNode[] {
  const scan = deps.scan ?? scanInjection;
  const cursor = { node: "" }; // 节点名仅供审计细节；权威节点轨迹走 runner 的 node_enter 事件

  const record = (entry: {
    action: string;
    objectId: string;
    objectType: string;
    details: Record<string, unknown>;
    result: "SUCCESS" | "FAILURE" | "DENIED";
  }): void => {
    deps.audit.record({ ...entry, actor: ACTOR, requestId: deps.requestId, createdAt: Date.now() });
  };

  /** 只读工具唯一入口：广播 tool_call → verifyTicket（chat 任务票）→ 放行执行 → tool_result。
   *  闸拒 = 审计 DENIED + 抛错（runner 强杀 run；INV-1 不吞错）。这里没有 executeApproved——
   *  动作意图走 intent_gate 之后的独立分支，票面也根本没有 L2 工具（INV-3）。
   *  票 43：闸体收进共享 makeGatedCall——差异点：前缀 chat / 凭据 caseId 仅在有值时传 /
   *  tool_call 多一个 tier 字段（web 时间线的分级徽标用它）。 */
  const gated = makeGatedCall({
    prefix: "chat",
    hmacKey: deps.hmacKey,
    creds: () => ({ ticket: deps.ticket, runId: deps.runId, ...(deps.caseId ? { caseId: deps.caseId } : {}) }),
    deny: () => ({
      record,
      objectId: deps.runId,
      objectType: "tool_call",
      extraDetails: { node: cursor.node },
    }),
    emitToolCall: (ctx, { tool, paramsHash: hash }) =>
      ctx.emit("tool_call", { node: cursor.node, tool, tier: tierOf(tool), params_hash: hash }),
    emitToolResult: (ctx, { tool }) => ctx.emit("tool_result", { node: cursor.node, tool, ok: true }),
  });

  const chatFlags = (ctx: NodeCtx): { refused: boolean; clarify: boolean; denied: boolean } => {
    const chat = ctx.state.chat as { refused?: boolean; clarify?: boolean; denied?: boolean } | undefined;
    return { refused: chat?.refused === true, clarify: chat?.clarify === true, denied: chat?.denied === true };
  };

  async function execReadonly(tool: string, params: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case "related_alerts":
        return relatedAlerts(deps.m2, {
          scope: params.scope as "entity" | "rule" | "host",
          value: String(params.value ?? ""),
          time_window: params.time_window as { from: string; to: string },
        });
      case "siem_query":
        return deps.siem.query({
          entity_type: (params.entity_type ?? "ip") as "ip" | "user" | "host",
          entity: String(params.entity ?? ""),
          time_window: params.time_window as { from: string; to: string },
        });
      case "get_alert":
        return deps.m2.getAlert(String(params.alert_id ?? ""));
      case "kb_lookup": {
        const p = params as KbLookupParams;
        return deps.kb.lookup({
          host: p.host || undefined,
          path: p.path || undefined,
          user: p.user || undefined,
        });
      }
      default:
        throw new Error(`unreachable_tool:${tool}`);
    }
  }

  // ---- 子图节点（PRD §6-M8 链路顺位）----

  const nodes: FlowNode[] = [
    {
      name: "input_guard",
      run: async (ctx) => {
        cursor.node = "input_guard";
        const message = String(ctx.state.message ?? "");
        const d = await scan(message, "user_input", deps.scanOpts);
        if (!d.blocked) return;
        // FR-M8.3/PRD 异常与边界：命中注入 → 拒答 + 审计（INV-1 fail-closed）
        record({
          action: "guards_block", objectId: deps.runId, objectType: "chat_input",
          details: { channel: "user_input", action: d.action, reason: d.reason ?? null, score: d.score ?? null },
          result: "DENIED",
        });
        ctx.emit("token", { delta: "已拒答：您的消息触发了注入防护（llm-guard），本系统对不可信输入 fail-closed，原文不进任何模型。" });
        ctx.emit("denied", { reason: "input_blocked_by_guards", channel: "user_input", action: d.action });
        ctx.emit("done", {});
        ctx.state.chat = { refused: true, action: d.action };
      },
    },
    {
      name: "load_context",
      run: async (ctx) => {
        if (chatFlags(ctx).refused) return;
        cursor.node = "load_context";
        if (!deps.caseId) {
          ctx.state.case_ctx = null;
          return;
        }
        const detail = await deps.m2.getCaseDetail(deps.caseId);
        if (!detail) throw new Error(`case_not_found:${deps.caseId}`);
        // 查询窗锚点取 primary alert 的事实日期（FR-M5.1 强制时间窗从案件事实来；
        // M2 的 case.start_date 是建案墙钟，追问历史告警会永远查空——照 m5 load_case 口径）
        let primaryDate = detail.startDate;
        const primaryId = detail.linkedAlerts[0];
        if (primaryId) {
          const primary = await gated(ctx, "get_alert", { alert_id: primaryId }, () => deps.m2.getAlert(primaryId));
          if (primary && typeof primary.date === "number") primaryDate = primary.date;
        }
        // field-profile 白名单装配（FR-M8.6）：显式声明喂哪些字段
        const byType = (t: string): string[] =>
          (detail.observables ?? []).filter((o) => o.dataType === t).map((o) => o.data);
        const caseCtx: CaseContext = {
          id: detail.id,
          title: detail.title,
          severity: detail.severity,
          status: detail.status,
          primaryDate,
          entities: {
            ips: byType("ip"),
            users: byType("other"), // seed 映射口径：srcuser → dataType "other"
            hosts: byType("hostname"),
            files: byType("filename"),
          },
        };
        ctx.state.case_ctx = caseCtx;
      },
    },
    {
      name: "intent_classify",
      run: async (ctx) => {
        if (chatFlags(ctx).refused) return;
        cursor.node = "intent_classify";
        const message = String(ctx.state.message ?? "");
        const role = String(ctx.state.role ?? "");
        const caseCtx = (ctx.state.case_ctx as CaseContext | null) ?? null;
        // 票 65：分类词汇表 = 可见清单（FR-M8.2 同一份）+ 高危动作族清单（候选外高危意图
        // 可命名，识别≠授权）——意图闸按可见性三态裁决，不可见 = deny + 解释（FR-M8.4）。
        const input: ClassifyInput = {
          message, role, caseContext: caseCtx,
          candidates: visibleTools(role), highRisk: highRiskTools(),
        };
        const startedAt = Date.now();
        const c = await deps.llm.classify({ prompt: "", input });
        ctx.charge(c.tokens);
        ctx.checkLlm(startedAt, Date.now());
        record({
          action: "llm_call", objectId: deps.runId, objectType: "chat",
          details: { node: cursor.node, tool: c.tool, confidence: c.confidence },
          result: "SUCCESS",
        });
        if (c.tool === "unknown" || c.confidence < 0.5) {
          // PRD 异常与边界：置信度低 → 澄清反问而非猜
          ctx.emit("token", { delta: "想确认一下您的意图：我可以帮您查关联告警 / SIEM 日志 / 知识库（只读），或提请主机隔离、IP 封禁等审批动作，能再具体说说吗？" });
          ctx.emit("done", {});
          ctx.state.chat = { ...(ctx.state.chat as Record<string, unknown> | undefined), clarify: true };
          return;
        }
        ctx.state.intent = { tool: c.tool, confidence: c.confidence, params: deriveParams(c.tool, message, caseCtx, Date.now()) };
      },
    },
    {
      name: "intent_gate",
      run: async (ctx) => {
        const flags = chatFlags(ctx);
        if (flags.refused || flags.clarify) return;
        cursor.node = "intent_gate";
        const intent = ctx.state.intent as { tool: string };
        const role = String(ctx.state.role ?? "");
        const gate = await decideIntent(role, intent.tool, deps.fga);
        ctx.state.gate = gate;
        record({
          action: "intent_gate", objectId: deps.runId, objectType: "intent",
          details: { role, tool: gate.tool, decision: gate.state, reason: gate.reason },
          result: gate.state === "deny" ? "DENIED" : "SUCCESS",
        });
        if (gate.state !== "deny") return;
        // 越权意图：拒绝并解释（FR-M8.4；denied 事件的 reason 直接给 Web 红标）
        ctx.emit("token", { delta: `该操作已被拒绝：${gate.reason}` });
        ctx.emit("denied", { reason: gate.reason, role: gate.role, tool: gate.tool });
        ctx.emit("done", {});
        ctx.state.chat = { ...(ctx.state.chat as Record<string, unknown> | undefined), denied: true };
      },
    },
    {
      name: "execute",
      run: async (ctx) => {
        const flags = chatFlags(ctx);
        if (flags.refused || flags.clarify || flags.denied) return;
        cursor.node = "execute";
        const gate = ctx.state.gate as { state: string; reason: string };
        const intent = ctx.state.intent as { tool: string; params: Record<string, unknown> };
        if (gate.state === "allow") {
          // 只读直查：路由 worker 只读面（investigation 的 M2/SIEM/KB adapter）
          ctx.state.result = await gated(ctx, intent.tool, intent.params, () => execReadonly(intent.tool, intent.params));
          return;
        }
        // require_approval：动作意图一律转审批流程（FR-M8.4）。开卡挂起由票 11 回路接管：
        // 值班长批准 → 铸 ApprovalToken → resume 后从这里重跑 → 验签执行。
        ctx.emit("token", { delta: `${intent.tool} 属审批动作：已提交审批卡，等待值班长裁决（批准后经 ApprovalToken 验签执行）。` });
        const out = await ctx.executeApproved(
          intent.tool,
          intent.params,
          { reason: gate.reason, caseId: deps.caseId ?? undefined },
          mockAction(intent.tool),
        );
        ctx.state.execution = { executed: out.executed, tool: intent.tool, ...(out.executed ? {} : { outcome: out.outcome }) };
        ctx.state.result = out.executed ? out.result : null;
      },
    },
    {
      name: "answer_llm",
      run: async (ctx) => {
        const flags = chatFlags(ctx);
        if (flags.refused || flags.clarify || flags.denied) return;
        cursor.node = "answer_llm";
        const message = String(ctx.state.message ?? "");
        const role = String(ctx.state.role ?? "");
        const input: AnswerInput = {
          message,
          role,
          caseContext: (ctx.state.case_ctx as CaseContext | null) ?? null,
          intent: (ctx.state.intent as AnswerInput["intent"]) ?? null,
          result: (ctx.state.result as AnswerInput["result"]) ?? null,
          execution: (ctx.state.execution as AnswerInput["execution"]) ?? null,
        };
        const startedAt = Date.now();
        const a = await deps.llm.answer({ prompt: "", input });
        ctx.charge(a.tokens);
        ctx.checkLlm(startedAt, Date.now());
        record({
          action: "llm_call", objectId: deps.runId, objectType: "chat",
          details: { node: cursor.node, tool: input.intent?.tool ?? null },
          result: "SUCCESS",
        });
        // FR-M8.5：token 级流式（切片成帧；真 adapter 换流式接口时只改这里）
        for (let i = 0; i < a.text.length; i += TOKEN_CHUNK) {
          ctx.emit("token", { delta: a.text.slice(i, i + TOKEN_CHUNK) });
        }
        ctx.emit("done", {});
      },
    },
  ];
  return nodes;
}
