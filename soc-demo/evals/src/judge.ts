// m11 eval 体系 · LLM judge（票 19 验收④，FR-M11.2 + PRD 决策 #7）。
//
// 职责只有一件事：对一条用例的执行记录（transcript）判 strict 要点覆盖——
// expected_output 全部命中才 1 分，有一条不命中就 0 分（ASP strict 覆盖口径）。
//
// 三条纪律全部落在代码结构上：
//   1. **与被测模型分离**（决策 #7）：judge 走独立配置 JUDGE_MODEL（缺省同 LLM_MODEL，
//      env 可换），出站走票 27 的 GatewayLlmClient → gateway /proxy/llm 凭证代理；
//      快道的被测对象是进程内注入的 FakeTriageLlm，两者没有任何共享状态。
//   2. **分数不进门禁**：本模块的返回值只被装进 CaseResult.judge 进报告；runner 的
//      passed 判定根本不读它——「judge 打 0 分用例照样过」由 runner 测试钉死。
//   3. **judge 不可用 ≠ 用例失败**（PRD 异常与边界，ASP Not-evaluable 口径）：上游病了
//      （LlmUpstreamError）或回包读不出判定 → 重试 1 次 → not_evaluable，不合成总分。
//
// 测试不真出网：seam 与 GatewayLlmClient 同构（chat 方法 + fetchImpl 可注入），
// 固定分 stub（FixedJudge）供套件/单测使用——「真网能力探测 skip 先例」（票 27）。
import { GatewayLlmClient, LlmUpstreamError, llmSmokeProbe } from "../../services/agent/src/llm-client.js";
import type { JudgeResult } from "./types.js";

/** judge 对 LLM 出站的最小依赖缝（GatewayLlmClient 结构适配；测试注入确定性假件）。 */
export interface JudgeSeam {
  chat(content: string, opts: { node: string }): Promise<{ text: string; tokens: number }>;
}

export interface JudgeInput {
  /** expected_output：strict 要点列表（PRD §5.11）。 */
  expectedOutput: string[];
  /** 执行记录渲染文本（runner.ts renderTranscript）。 */
  transcript: string;
}

const JUDGE_PROMPT = (input: JudgeInput): string => [
  "你是独立评估裁判（judge），与被测的分诊模型没有任何关系。下面给出一次 SOC 分诊执行的完整记录，",
  "以及期望要点列表。请逐条判断：执行记录是否提供了明确证据满足该要点（strict 口径——记录里",
  "找不到明确证据就算未命中，不许脑补）。只输出一个 JSON 对象，不要输出别的文字：",
  '{"points":[{"point":"要点原文","hit":true,"evidence":"记录中的依据"}]}',
  "",
  "## 期望要点",
  ...input.expectedOutput.map((p, i) => `${i + 1}. ${p}`),
  "",
  "## 执行记录",
  input.transcript,
].join("\n");

/** 解析 judge 回包；读不出判定返回 null（上层重试）。 */
function parseJudgeReply(
  text: string,
  expected: string[],
): { hit: string[]; missed: string[] } | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, "").trim());
  } catch {
    return null;
  }
  const points = (obj as { points?: unknown }).points;
  if (!Array.isArray(points)) return null;
  const byPoint = new Map<string, boolean>();
  for (const p of points) {
    if (typeof p !== "object" || p === null) return null;
    const point = (p as { point?: unknown }).point;
    if (typeof point !== "string") return null;
    byPoint.set(point, (p as { hit?: unknown }).hit === true);
  }
  // 以 expected_output 清单为准（judge 漏答的要点按未命中处理——fail-closed）
  const hit: string[] = [];
  const missed: string[] = [];
  for (const p of expected) (byPoint.get(p) === true ? hit : missed).push(p);
  return { hit, missed };
}

/** 真 judge：JUDGE_MODEL（经 GatewayLlmClient → gateway /proxy/llm，票 27 路径）。 */
export class StrictPointJudge {
  private readonly seam: JudgeSeam;
  /** 报告里展示的 judge 模型身份（与 wire 上的 model 一致，由 makeJudgeClient 落定）。 */
  readonly model: string;

  constructor(seam: JudgeSeam, model: string) {
    this.seam = seam;
    this.model = model;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    try {
      let parsed = await this.ask(input);
      if (parsed === null) {
        parsed = await this.ask(input); // 回包坏形重试 1 次（与 worker 的 LLM 降级节奏一致）
      }
      if (parsed === null) {
        return { evaluable: false, reason: "judge 回包两次读不出 points 判定", model: this.model };
      }
      // strict：全部命中才 1 分（FR-M11.2 原文口径）
      return {
        evaluable: true,
        score: parsed.missed.length === 0 ? 1 : 0,
        hit: parsed.hit,
        missed: parsed.missed,
        model: this.model,
      };
    } catch (e) {
      // judge 病了不是用例的错：not_evaluable 留痕，不合成总分、不影响门槛
      const reason = e instanceof LlmUpstreamError ? `judge 上游不可用:${e.code}` : `judge 故障:${e instanceof Error ? e.message : String(e)}`;
      return { evaluable: false, reason, model: this.model };
    }
  }

  private async ask(input: JudgeInput): Promise<{ hit: string[]; missed: string[] } | null> {
    const r = await this.seam.chat(JUDGE_PROMPT(input), { node: "eval_judge" });
    return parseJudgeReply(r.text, input.expectedOutput);
  }
}

/** 测试/开发用固定分 stub：不碰网络，同输入同输出（框架口径「测试用 Fake/固定分数」）。 */
export class FixedJudge {
  readonly model = "fixed-stub";
  constructor(private readonly score: 0 | 1 = 1) {}

  async judge(input: JudgeInput): Promise<JudgeResult> {
    return this.score === 1
      ? { evaluable: true, score: 1, hit: [...input.expectedOutput], missed: [], model: this.model }
      : { evaluable: true, score: 0, hit: [], missed: [...input.expectedOutput], model: this.model };
  }
}

// FixedJudge 与 StrictPointJudge 结构同型（测试按需替换），类型上收一个联合名：
export type Judge = FixedJudge | StrictPointJudge;

/** 决策 #7 的模型身份：JUDGE_MODEL > LLM_MODEL > minimax-m2（judge 先与被测同款，env 可换）。 */
export function judgeModel(): string {
  return process.env.JUDGE_MODEL ?? process.env.LLM_MODEL ?? "minimax-m2";
}

/** 生产 judge 出站件：票 27 的 GatewayLlmClient（经 gateway /proxy/llm 凭证代理），
 *  actor=eval:judge（网关审计五要素里能和分诊/调查的调用分开）。测试注入 fetchImpl
 *  捕获请求形态，绝不真出网（票 08 mock transport 先例）。 */
export function makeJudgeClient(
  opts: Partial<ConstructorParameters<typeof GatewayLlmClient>[0]> = {},
): JudgeSeam & { model: string } {
  const client = new GatewayLlmClient({ model: judgeModel(), actor: "eval:judge", ...opts });
  return { chat: (content, o) => client.chat(content, o), model: judgeModel() };
}

/** 套件选 judge（真网能力探测 skip 先例，票 27 llmSmokeProbe）：
 *  - EVAL_JUDGE=fake → FixedJudge（单测/演示确定性，不探测不出网）；
 *  - 有真凭证且 gateway /proxy/llm 可达 → StrictPointJudge(GatewayLlmClient)；
 *  - 否则 → null（套件按 not_evaluable 显式留痕，不静默跳过）。 */
export async function selectJudge(): Promise<Judge | null> {
  if (process.env.EVAL_JUDGE === "fake") return new FixedJudge(1);
  const probe = await llmSmokeProbe();
  if (!probe.ok) {
    console.log(`[eval] judge 不可用，全部用例 judge=not_evaluable（${probe.reason}）`);
    return null;
  }
  return new StrictPointJudge(makeJudgeClient(), judgeModel());
}
