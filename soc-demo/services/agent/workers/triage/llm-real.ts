// m4 分诊 worker · 真 LLM adapter（票 27·ADR 0002 框架回补：生产装配默认它）。
//
// m4 卡 Seam 的另一只脚落地：minimax-m2 经 gateway /proxy/llm/* 凭证代理（票 08 契约，
// 占位符换真凭证 + 金丝雀断言在代理层；本进程不持任何凭证）。seam 接口 TriageLlm 与
// prompt 契约（事实接口）一字未动——fake ↔ real 只换 deps.llm 注入物（index.ts 按
// AGENT_LLM env 选），子图与闸一行不动（票 13 打下的桩今天兑现）。
//
// fail-closed 语义（验收③④）：上游病了（限流/不可达/超时/5xx）不裸抛——回一个必然不合
// schema 的标记回包（reason code 藏在 verdict 位，parseVerdict 报 bad_verdict:llm_upstream_*），
// 让 worker 既有「重试 1 次 → uncertain + 人工」降级路径原样接管，与 Fake 版行为完全一致
// （宁可升级人工不可猜）。schema 把关仍在 worker（parseVerdict），adapter 只剥围栏不硬修。
import { LlmUpstreamError, unwrapJsonText, type LlmChatResult } from "../../src/llm-client.js";
import type { TriageLlm } from "./llm.js";
import type { LlmCall, LlmReply } from "./prompt.js";

/** adapter 依赖的窄缝：只要会 chat（GatewayLlmClient 结构适配；测试注入确定性假件）。 */
export interface ChatSeam {
  chat(content: string, opts: { node: string }): Promise<LlmChatResult>;
}

export class RealTriageLlm implements TriageLlm {
  private readonly seam: ChatSeam;

  constructor(seam: ChatSeam) {
    this.seam = seam;
  }

  async verdict(call: LlmCall): Promise<LlmReply> {
    try {
      const r = await this.seam.chat(call.prompt, { node: "verdict_llm" });
      return { text: unwrapJsonText(r.text), tokens: r.tokens };
    } catch (e) {
      if (!(e instanceof LlmUpstreamError)) throw e; // 非上游错误 = 代码 bug，照常裸抛
      return { text: JSON.stringify({ verdict: `llm_upstream_${e.code}` }), tokens: 0 };
    }
  }
}
