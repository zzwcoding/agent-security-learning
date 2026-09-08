// m5 调查 worker · 真 LLM adapter（票 27·ADR 0002 框架回补，票 13/27 先例的 m5 侧）。
//
// m5 卡 Seam：LLM minimax-m2 经凭证代理 / eval fixture 伪 LLM。seam 接口 InvestigationLlm
// 四方法与 prompt 契约（事实接口）一字未动；本 adapter 只负责「契约文本 → gateway
// /proxy/llm/* 出站 → 自由文本回包 → 按方法契约解析」。plan/decide 的输出 JSON 形态
// （DECIDE_OUTPUT_FORMAT 等）是 adapter 的 wire 约定——prompt.ts 契约本体没动，形态
// 说明由 adapter 附在消息尾部（伪 LLM 读不懂它也不依赖它）。
//
// fail-closed 语义（验收④，与 m4 同族但按方法分流）：
//   - report：worker 有「重试 1 次 → 降级自由文本 + 标记」降级路径 → 上游病了回标记
//     回包（不裸抛），降级路径原样接管，与 Fake 版一致；
//   - plan / decide / summarize：worker 无降级路径 → 抛 LlmUpstreamError，由 m3 runner
//     强杀 run（failed + 审计 + error 事件）——绝不硬编造任务清单/finish 收工/摘要。
import { LlmUpstreamError, unwrapJsonText, type LlmChatResult } from "../../src/llm-client.js";
import type { InvestigationLlm, LoopDecision } from "./llm.js";
import type { DecideCall, PlanCall, ReportCall, SummarizeCall } from "./prompt.js";

/** adapter 依赖的窄缝（同 triage/llm-real.ts）：GatewayLlmClient 结构适配。 */
export interface ChatSeam {
  chat(content: string, opts: { node: string }): Promise<LlmChatResult>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// plan/decide 的输出 JSON 形态说明（adapter wire 约定；附在 prompt 契约文本之后）
const PLAN_OUTPUT_FORMAT =
  '只输出一个 JSON 对象：{"tasks":["任务1","任务2"]}，不要输出别的文字。';
const DECIDE_OUTPUT_FORMAT =
  '只输出一个 JSON 对象，二选一：{"action":"tool","tool":"工具名","params":{…}}（发起一次工具调用）' +
  '或 {"action":"finish"}（调查结束）。不要输出别的文字。';
const SUMMARIZE_INSTRUCTION =
  "把下面的工具输出压缩成一段摘要：只保留与调查相关的事实（实体/时间/数量/结论），" +
  "不做决策、不编造、不添加原文没有的内容，120 字以内。输出只有摘要本身。";

export class RealInvestigationLlm implements InvestigationLlm {
  private readonly seam: ChatSeam;

  constructor(seam: ChatSeam) {
    this.seam = seam;
  }

  async plan(call: PlanCall): Promise<{ tasks: string[]; tokens: number }> {
    const r = await this.mustChat(`${call.prompt}\n\n${PLAN_OUTPUT_FORMAT}`, "plan");
    const obj = this.mustJson(r.text, "plan");
    if (!Array.isArray(obj.tasks) || !obj.tasks.every((t) => typeof t === "string")) {
      throw new LlmUpstreamError("bad_shape", "plan.tasks not string[]");
    }
    return { tasks: obj.tasks as string[], tokens: r.tokens };
  }

  async decide(call: DecideCall): Promise<LoopDecision & { tokens: number }> {
    const r = await this.mustChat(`${call.prompt}\n\n${DECIDE_OUTPUT_FORMAT}`, "tool_loop");
    const obj = this.mustJson(r.text, "decide");
    if (obj.action === "finish") return { kind: "finish", tokens: r.tokens };
    if (obj.action === "tool" && typeof obj.tool === "string" && obj.tool.length > 0 && isObj(obj.params)) {
      return { kind: "tool", tool: obj.tool, params: obj.params, tokens: r.tokens };
    }
    throw new LlmUpstreamError("bad_shape", "decide neither tool nor finish");
  }

  async summarize(call: SummarizeCall): Promise<{ summary: string; tokens: number }> {
    const r = await this.mustChat(`${SUMMARIZE_INSTRUCTION}\n\n工具（${call.tool}）输出：\n${call.text}`, "tool_loop");
    const summary = r.text.trim();
    if (summary.length === 0) throw new LlmUpstreamError("bad_shape", "empty summary");
    return { summary, tokens: r.tokens };
  }

  async report(call: ReportCall): Promise<{ text: string; tokens: number }> {
    try {
      const r = await this.seam.chat(call.prompt, { node: "report_llm" });
      return { text: unwrapJsonText(r.text), tokens: r.tokens };
    } catch (e) {
      if (!(e instanceof LlmUpstreamError)) throw e;
      // 标记回包必然不合 schema（parseReport 报 unparseable）→ worker 降级路径接管；
      // 标记全文会进降级 timeline body，reason code 人可读
      return { text: `llm_upstream:${e.code}`, tokens: 0 };
    }
  }

  /** 无降级路径的方法共用：上游病了直接抛（runner 强杀，INV-1），不回编造数据。 */
  private mustChat(content: string, node: string): Promise<LlmChatResult> {
    return this.seam.chat(content, { node });
  }

  private mustJson(text: string, what: string): Record<string, unknown> {
    let obj: unknown;
    try {
      obj = JSON.parse(unwrapJsonText(text));
    } catch {
      throw new LlmUpstreamError("bad_shape", `${what} output not json`);
    }
    if (!isObj(obj)) throw new LlmUpstreamError("bad_shape", `${what} output not an object`);
    return obj;
  }
}
