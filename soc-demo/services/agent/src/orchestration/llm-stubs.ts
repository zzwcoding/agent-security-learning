// m14 编排循环 · planner/judge/gap 的确定性最小桩（票 73 建，票 74/75 补真件）。
//
// m14 卡 Seam：三处 LLM adapter fake/real 双件——本件是 fake（确定性，测试可复算）；
// 真 adapter（经凭证代理，m3 llm-client 口径）在 llm-real.ts，两档经 makeLoopLlm 切换。
// 桩的判定规则写在注释里，与 FakeInvestigationLlm 同款纪律：只吃输入结构，不偷看 fixture。
//   planner：无 gap → 菜单首选工具组合；有 gap → 换下一件菜单工具 + 带缺口焦点参数
//     （相邻轮组合必不同，即 fake LLM 两轮 C₂≠C₁ 的机制保证）。
//   judge：本轮子报告全 ok 且已有既往轮 → sufficient + hit；否则不充分（第一轮必不充分
//     → 走 gap → 换组合再来一轮）。
//   gap：从 judge 的 gap_description 直翻缺口（unknown/suggested_focus 是机制壳）。
import { createHash } from "node:crypto";
import { paramsHash } from "../verify-ticket.js";
import { GatewayLlmClient } from "../llm-client.js";
import { RealLoopGap, RealLoopJudge, RealLoopPlanner } from "./llm-real.js";
import type {
  GapInput,
  GapOutput,
  JudgeInput,
  JudgeOutput,
  LoopLlm,
  PlannedTask,
  PlannerInput,
} from "./ports.js";

const TOKENS_PER_CALL = 24;

export class FakeLoopPlanner {
  async plan(input: PlannerInput): Promise<{ tasks: PlannedTask[]; tokens: number }> {
    const { menu, gap, template } = input;
    if (menu.length === 0) return { tasks: [], tokens: TOKENS_PER_CALL };
    const cap = Math.max(1, Math.min(template.max_tasks, 2));
    if (!gap) {
      const first = menu[0];
      const tasks: PlannedTask[] = [
        { tool: first, params: { q: input.hypothesis_text.slice(0, 64) }, rationale: "首轮：按假设句直查首选面" },
      ];
      if (cap > 1 && menu[1]) {
        tasks.push({ tool: menu[1], params: { q: input.hypothesis_text.slice(0, 64) }, rationale: "首轮补一个旁证面" });
      }
      return { tasks, tokens: TOKENS_PER_CALL };
    }
    // 有缺口 → 换组合（C₂≠C₁）：主工具用菜单下一件，参数带缺口焦点
    const idx = menu.indexOf("kb_lookup") === 0 ? 1 : 0;
    const pivot = menu[Math.min(idx + 1, menu.length - 1)];
    const focus = gap.suggested_focus[0] ?? gap.unknown;
    return {
      tasks: [
        {
          tool: pivot,
          params: { q: focus, focus: gap.suggested_focus },
          rationale: `换组合补缺口：${gap.gap_description.slice(0, 64)}`,
        },
      ],
      tokens: TOKENS_PER_CALL,
    };
  }
}

export class FakeLoopJudge {
  async judge(input: JudgeInput): Promise<JudgeOutput & { tokens: number }> {
    const allOk = input.round_reports.length > 0 && input.round_reports.every((r) => r.result_summary !== "");
    const sufficient = allOk && (input.prior_rounds ?? 0) >= 1;
    return {
      sufficient,
      verdict: sufficient ? "hit" : null,
      confidence: sufficient ? 0.7 : 0.4,
      gap_description: sufficient ? null : "本轮证据不足以判定，需要换角度补查",
      tokens: TOKENS_PER_CALL,
    };
  }
}

export class FakeLoopGap {
  async gap(input: GapInput): Promise<GapOutput & { tokens: number }> {
    const desc = input.judge_output.gap_description ?? "证据缺口未指明";
    return {
      gap_description: desc,
      unknown: desc,
      suggested_focus: input.evidence_so_far.length > 0 ? [`followup:${input.evidence_so_far.length}`] : ["initial"],
      tokens: TOKENS_PER_CALL,
    };
  }
}

/** fake 三件套的默认装配（测试用；index.ts 票 73 装配暂持——production 切换见 makeLoopLlm）。 */
export function makeFakeLoopLlm(): LoopLlm {
  return {
    planner: (i) => new FakeLoopPlanner().plan(i),
    judge: (i) => new FakeLoopJudge().judge(i),
    gap: (i) => new FakeLoopGap().gap(i),
  };
}

/** loop LLM 装配总口（票 74 建口，票 75 三件齐）：出网开关与四 worker 同一口径——
 *  AGENT_LLM=fake → 确定性桩（测试可复算）；其余值 → planner/judge/gap 全走 llm-client
 *  seam + 凭证代理（RealLoopPlanner/RealLoopJudge/RealLoopGap）。默认不显式传 mode 时
 *  读 AGENT_LLM env（缺省 fake——与 index.ts LLM_MODE 的 env 链同源，生产装配显式传）。 */
export function makeLoopLlm(mode: string = process.env.AGENT_LLM ?? "fake"): LoopLlm {
  if (mode === "fake") return makeFakeLoopLlm();
  const seam = new GatewayLlmClient({ actor: "agent:hunt_flow" });
  const planner = new RealLoopPlanner(seam);
  const judge = new RealLoopJudge(seam);
  const gap = new RealLoopGap(seam);
  return {
    planner: (i) => planner.plan(i),
    judge: (i) => judge.judge(i),
    gap: (i) => gap.gap(i),
  };
}

/** 任务集指纹原料（防转的输入面，票 74/75 消费；本票先随轮次归集落 details 可回放）。 */
export function taskFingerprint(tasks: PlannedTask[]): string {
  return tasks
    .map((t) => `${t.tool}:${paramsHash(t.params)}`)
    .sort()
    .join("|");
}

/** 防转指纹（票 77 行为约定 10/T06）：hash(排序后任务集 + gap 摘要)。gap hash 在指纹内
 *  即表达「gap 实质变化豁免」——组合相同但缺口输入不同（新证据改写了缺口）→ 指纹不同
 *  → 不判空转；组合与缺口双双原地踏步 → 相邻轮指纹相同 → 拒组合（max_repeat=1）。 */
export function spinFingerprint(tasks: PlannedTask[], gap: GapOutput | null): string {
  return "sha256:" + createHash("sha256")
    .update(`${taskFingerprint(tasks)}#${gap ? paramsHash({ gap }) : ""}`)
    .digest("hex");
}
