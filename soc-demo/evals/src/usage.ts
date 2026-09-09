// m11 eval 体系 · LLM 用量取证（票 22 验收③：M507 cost_all.csv 成本口径的数据源）。
//
// M507 的经济账（~$0.18/条告警）是一份真实 usage CSV：模型 / input / cache-read /
// output token / 成本。我们的快道被测对象是确定性伪 LLM，它只报一个总 token——
// 没有输入/输出之分。做法：在 TriageLlm seam 上包一层探针，量每次调用的
// prompt 字符数与回包字符数，按 ~4 字符/token 的经验口径折算 input/output，
// cache-read 恒 0（快道无缓存；列保留对齐 M507 结构）。
// 数字全部可复核：口径在 PRICE_PER_M / CHARS_PER_TOKEN 两个常量上，换真价只改表。
import type { LlmCall, LlmReply } from "../../services/agent/workers/triage/prompt.js";
import type { TriageLlm } from "../../services/agent/workers/triage/llm.js";
import type { UsageSnapshot } from "./types.js";

/** 折算口径：~4 字符 ≈ 1 token（英文均值的常见近似；中文会低估——口径先行，换真件即换真账）。 */
export const CHARS_PER_TOKEN = 4;

export function tokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

/** TriageLlm 用量探针：行为零改动（原样转发 verdict），只多记一本账。 */
export class UsageProbeLlm implements TriageLlm {
  private inputChars = 0;
  private outputChars = 0;
  private calls = 0;

  constructor(private readonly inner: TriageLlm) {}

  async verdict(call: LlmCall): Promise<LlmReply> {
    this.inputChars += call.prompt.length;
    const reply = await this.inner.verdict(call);
    this.outputChars += reply.text.length;
    this.calls += 1;
    return reply;
  }

  snapshot(): UsageSnapshot {
    return {
      calls: this.calls,
      inputTokens: tokensFromChars(this.inputChars),
      cacheReadTokens: 0,
      outputTokens: tokensFromChars(this.outputChars),
    };
  }
}
