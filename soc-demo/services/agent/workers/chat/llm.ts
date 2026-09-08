// m8 对话 Copilot · LLM seam + fixture 伪 LLM（照票 13/14 先例：fake 先行，真件只换 adapter）。
//
// m8 卡 Seam：意图分类/回答 = minimax-m2 经凭证代理（llm-real.ts，AGENT_LLM 切换）/
// eval fixture 伪 LLM。伪件的规则 = 对话面的确定性最简版（关键词→意图、模板+查询结果→回答），
// 不偷看 fixture 名。两条纪律：
//   - 分类器只产「意图 + 置信度」，产不出就低置信——澄清反问而非猜（PRD M8 异常与边界）；
//   - 回答里的数字一律来自工具查询结果（input.result），LLM 不负责编数（chat/01 验收的 judge 口径）。
import type { CaseContext } from "./flow.js";

// ---- prompt 契约（真 adapter 的输入形态；fake 不吃 prompt 只吃结构化 input）----

export interface ClassifyInput {
  message: string;
  role: string;
  caseContext: CaseContext | null;
  /** 可判工具面 = 本角色可见清单（Web 下发的同一份；分类器不许发明清单外的工具）。 */
  candidates: string[];
}

export interface ClassifyOutput {
  tool: string;
  confidence: number;
}

export interface AnswerInput {
  message: string;
  role: string;
  caseContext: CaseContext | null;
  intent: { tool: string; params: Record<string, unknown> } | null;
  /** 只读工具的原始查询结果（allow 态）。 */
  result: unknown | null;
  /** 审批动作的执行结果（require_approval 态 resume 后）。 */
  execution: { executed: boolean; tool: string; outcome?: string } | null;
}

export interface ClassifyCall {
  prompt: string;
  input: ClassifyInput;
}
export interface AnswerCall {
  prompt: string;
  input: AnswerInput;
}

export interface ChatLlm {
  classify(call: ClassifyCall): Promise<ClassifyOutput & { tokens: number }>;
  answer(call: AnswerCall): Promise<{ text: string; tokens: number }>;
}

export function buildClassifyPrompt(input: ClassifyInput): string {
  const caseLine = input.caseContext
    ? `当前案件：${input.caseContext.id}「${input.caseContext.title}」（severity=${input.caseContext.severity}，实体 IP=${input.caseContext.entities.ips.join("、") || "无"}，主机=${input.caseContext.entities.hosts.join("、") || "无"}）`
    : "当前没有绑定案件（全局追问）";
  return [
    "你是 SOC 对话助手的城市意图分类器。把用户消息分类成下面清单中的一个工具意图，输出 JSON：",
    '{"tool":"<工具名>","confidence":<0~1>}',
    `可选工具清单：${input.candidates.join("、") || "（空）"}。清单外一律输出 {"tool":"unknown","confidence":0}。`,
    caseLine,
    `用户角色：${input.role}`,
    `用户消息：${input.message}`,
    "只输出 JSON，不要解释。",
  ].join("\n");
}

export function buildAnswerPrompt(input: AnswerInput): string {
  return [
    "你是 SOC 对话助手。用大白话回答用户，只依据给定的工具结果，不许编造数字。",
    `用户角色：${input.role}`,
    input.caseContext
      ? `当前案件：${input.caseContext.id}「${input.caseContext.title}」`
      : "当前没有绑定案件",
    `用户消息：${input.message}`,
    input.intent ? `已执行工具：${input.intent.tool}，参数：${JSON.stringify(input.intent.params)}` : "未执行工具",
    input.result !== null ? `工具结果：${JSON.stringify(input.result)}` : "",
    input.execution
      ? `审批动作执行结果：${input.execution.executed ? "已执行" : "被驳回未执行"}（${input.execution.tool}）`
      : "",
    "直接给用户的一段话回答。",
  ].filter(Boolean).join("\n");
}

// ---- 伪 LLM：确定性规则版 ----

export class FakeChatLlm implements ChatLlm {
  private readonly tokensPerCall: number;

  constructor(tokensPerCall = 48) {
    this.tokensPerCall = tokensPerCall;
  }

  async classify(call: ClassifyCall): Promise<ClassifyOutput & { tokens: number }> {
    const { message } = call.input;

    // 动作意图（L2 族）优先识别——它们是权限演示的主角，关键词明确
    if (/隔离|isolate/i.test(message)) return { tool: "isolate_host", confidence: 0.9, tokens: this.tokensPerCall };
    if (/封(禁|掉)?\s*(ip|IP)?|block/i.test(message) && /ip|IP|\d{1,3}\.\d{1,3}/.test(message)) {
      return { tool: "block_ip", confidence: 0.9, tokens: this.tokensPerCall };
    }
    if (/入库|写进知识库|写知识库|kb_write/i.test(message)) return { tool: "kb_write", confidence: 0.9, tokens: this.tokensPerCall };
    // 只读意图
    if (/还出现在|出现过|关联.*告警|哪些告警|related/i.test(message)) {
      return { tool: "related_alerts", confidence: 0.9, tokens: this.tokensPerCall };
    }
    if (/siem|日志|full_log|检索日志/i.test(message)) return { tool: "siem_query", confidence: 0.85, tokens: this.tokensPerCall };
    if (/知识库|知识条目|kb\b/i.test(message)) return { tool: "kb_lookup", confidence: 0.85, tokens: this.tokensPerCall };
    // 低置信 → 澄清反问而非猜（PRD M8 异常与边界）
    return { tool: "unknown", confidence: 0.2, tokens: this.tokensPerCall };
  }

  async answer(call: AnswerCall): Promise<{ text: string; tokens: number }> {
    const { intent, result, execution } = call.input;
    let text: string;
    if (execution) {
      text = execution.executed
        ? `已执行 ${execution.tool}（经值班长审批、ApprovalToken 验签通过）。结果：${JSON.stringify(call.input.result ?? {})}`
        : `动作 ${execution.tool} 未执行：审批被驳回，工单已留痕。`;
    } else if (intent && intent.tool === "related_alerts" && result !== null) {
      const r = result as { total: number; alerts: { id: string; title: string }[] };
      const value = String(intent.params.value ?? "");
      const ids = r.alerts.map((a) => `${a.id}（${a.title}）`).join("、") || "无";
      text = `IP ${value} 在查询时间窗内共出现在 ${r.total} 条告警：${ids}。`;
    } else if (intent && intent.tool === "siem_query" && result !== null) {
      const r = result as { total: number; hits: { id: string }[] };
      text = `SIEM 检索 ${String(intent.params.entity ?? "")} 共 ${r.total} 条命中${r.total ? `（如 ${r.hits[0]?.id}）` : ""}。`;
    } else if (intent && result !== null) {
      text = `${intent.tool} 查询完成：${JSON.stringify(result)}`;
    } else {
      text = "本次追问没有产生工具调用。";
    }
    return { text, tokens: this.tokensPerCall };
  }
}
