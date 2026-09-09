// m7 知识沉淀 worker · 真 LLM adapter（票 17；票 27 同款：生产经 gateway /proxy/llm 出站）。
//
// seam 接口 KnowledgeLlm 与 prompt 契约不动——fake ↔ real 只换 deps.llm 注入物。
// fail-closed 语义（m4 RealTriageLlm 先例）：上游病了不裸抛——回一个必然不合草稿 schema
// 的标记回包，让 worker 既有「重试 1 次 → skip + 审计」降级路径接管（宁可不错提，不可
// 编造）。schema 把关仍在 worker（parseDraft），adapter 只剥围栏不硬修。
import { LlmUpstreamError, unwrapJsonText, type ChatSeam } from "../../src/llm-client.js";
import type { KnowledgeLlm } from "./llm.js";
import type { LlmCall, LlmReply } from "./prompt.js";

export class RealKnowledgeLlm implements KnowledgeLlm {
  private readonly seam: ChatSeam;

  constructor(seam: ChatSeam) {
    this.seam = seam;
  }

  async distill(call: LlmCall): Promise<LlmReply> {
    try {
      const r = await this.seam.chat(call.prompt, { node: "knowledge_distill" });
      return { text: unwrapJsonText(r.text), tokens: r.tokens };
    } catch (e) {
      if (!(e instanceof LlmUpstreamError)) throw e; // 非上游错误 = 代码 bug，照常裸抛
      return { text: JSON.stringify({ kind: `llm_upstream_${e.code}` }), tokens: 0 };
    }
  }
}
