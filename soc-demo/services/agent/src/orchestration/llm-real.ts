// m14 编排循环 · planner 真 LLM adapter（票 74）。
//
// 走 m3 llm-client 既有 seam（ChatSeam，GatewayLlmClient 结构适配——出站经 gateway
// /proxy/llm/* 凭证代理，真凭证只活在网关进程，本进程 env 没有也不需要 SECRETS_*）。
// 出网开关口径与四 worker 一致（AGENT_LLM=fake → FakeLoopPlanner 确定性桩；其余 →
// 本件，装配见 llm-stubs.ts makeLoopLlm）。judge/gap 真件归票 75。
//
// schema 把关在 parsePlan（planner.ts，parseReport 同款范式）：坏形抛 LlmUpstreamError
// (bad_shape) → planner 节点的重试半边接管（行为 3）；上游 timeout/unreachable/
// rate_limited 原样上抛 → runner 强杀（INV-1，与 investigation plan/decide 同款，
// 绝不硬编造任务清单）。
import { LlmUpstreamError, unwrapJsonText, type ChatSeam } from "../llm-client.js";
import { buildPlannerPrompt, parsePlan } from "./planner.js";
import type { PlannedTask, PlannerInput } from "./ports.js";

export class RealLoopPlanner {
  private readonly seam: ChatSeam;

  constructor(seam: ChatSeam) {
    this.seam = seam;
  }

  async plan(input: PlannerInput): Promise<{ tasks: PlannedTask[]; tokens: number }> {
    const r = await this.seam.chat(buildPlannerPrompt(input), { node: "planner" });
    const parsed = parsePlan(unwrapJsonText(r.text));
    if (!parsed.ok) throw new LlmUpstreamError("bad_shape", `planner.tasks ${parsed.error}`);
    return { tasks: parsed.tasks, tokens: r.tokens };
  }
}
