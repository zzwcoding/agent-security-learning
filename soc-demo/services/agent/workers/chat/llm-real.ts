// m8 对话 Copilot · 真 LLM adapter（照票 27 fake/real 双 adapter 先例：AGENT_LLM 切换，
// 生产默认 real——minimax-m2 经 gateway /proxy/llm/* 凭证代理出站，本进程不持凭证）。
//
// fail-closed 语义与 triage/llm-real 同款：上游病了不裸抛——分类回 unknown + 低置信
// （走「澄清反问」降级路径，绝不猜意图），回答错误原样上抛由 runner 强杀（不吞错，
// INV-1）。schema 把关在本 adapter（分类要 JSON），adapter 只剥围栏不硬修。
import { LlmUpstreamError, unwrapJsonText } from "../../src/llm-client.js";
import type { ChatSeam } from "../triage/llm-real.js";
import {
  buildAnswerPrompt,
  buildClassifyPrompt,
  type AnswerCall,
  type ChatLlm,
  type ClassifyCall,
  type ClassifyOutput,
} from "./llm.js";

export class RealChatLlm implements ChatLlm {
  private readonly seam: ChatSeam;

  constructor(seam: ChatSeam) {
    this.seam = seam;
  }

  async classify(call: ClassifyCall): Promise<ClassifyOutput & { tokens: number }> {
    try {
      const r = await this.seam.chat(buildClassifyPrompt(call.input), { node: "chat_classify" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(unwrapJsonText(r.text));
      } catch {
        parsed = null;
      }
      const obj = parsed as { tool?: unknown; confidence?: unknown } | null;
      if (obj && typeof obj.tool === "string" && typeof obj.confidence === "number") {
        return { tool: obj.tool, confidence: obj.confidence, tokens: r.tokens };
      }
      // 回包坏形 → unknown 低置信（澄清反问，不猜）；计费照记
      return { tool: "unknown", confidence: 0, tokens: r.tokens };
    } catch (e) {
      if (!(e instanceof LlmUpstreamError)) throw e; // 非上游错误 = 代码 bug，照常裸抛
      return { tool: "unknown", confidence: 0, tokens: 0 };
    }
  }

  async answer(call: AnswerCall): Promise<{ text: string; tokens: number }> {
    const r = await this.seam.chat(buildAnswerPrompt(call.input), { node: "chat_answer" });
    return { text: r.text, tokens: r.tokens };
  }
}
