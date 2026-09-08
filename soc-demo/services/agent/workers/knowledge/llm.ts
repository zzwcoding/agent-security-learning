// m7 知识沉淀 worker · LLM seam + fixture 伪 LLM（票 17）。
//
// m7 卡依赖 m9 的 LLM 面（票 27 地基）：adapter 双实现同 m4 先例——Fake（测试确定性）
// / Real（生产经 gateway /proxy/llm 出站），子图与闸一行不动。
//
// FakeKnowledgeLlm 的提炼规则 = 按人工 verdict 的确定性版（ASP 门控的思想：verdict 是
// 人给的，提炼只是把人的结论结构化成可复用知识）：
//   false_positive          → fp_pattern（误报模式：触发特征 + 判定依据 + 复核要点）
//   benign_true_positive    → env_fact（内网环境事实：演练/变更/资产登记）
//   true_positive           → runbook（处置经验：取证与遏制步骤）
//   uncertain / 无 verdict  → skip（无可沉淀的确证结论——不编造）
import type { LlmCall, LlmReply } from "./prompt.js";

export interface KnowledgeLlm {
  distill(call: LlmCall): Promise<LlmReply>;
}

export class FakeKnowledgeLlm implements KnowledgeLlm {
  private readonly tokensPerCall: number;

  constructor(tokensPerCall = 96) {
    this.tokensPerCall = tokensPerCall;
  }

  async distill(call: LlmCall): Promise<LlmReply> {
    const { kase } = call.input;
    const text = JSON.stringify(this.decide(kase));
    return { text, tokens: this.tokensPerCall };
  }

  private decide(kase: LlmCall["input"]["kase"]): Record<string, unknown> {
    // ASP 门控的 Fake 版：uncertain / 无 verdict → skip（没有可沉淀的确证结论）
    if (!kase.verdict || kase.verdict === "uncertain") {
      return { skip: true, reason: `verdict=${kase.verdict ?? "(无)"}：无可沉淀的确证结论` };
    }
    const hostTag = kase.host ? [kase.host] : [];
    if (kase.verdict === "false_positive") {
      return {
        kind: "fp_pattern",
        title: `FP 模式：${kase.host || kase.id} ${kase.title}`,
        body: [
          "## 触发特征",
          `- 场景：${kase.title}`,
          "- 同类告警无攻击证据，属运维噪声/已知无害模式",
          "",
          "## 判定依据（人工结论）",
          `- SOC1 复核 verdict=false_positive${kase.verdict_note ? `：${kase.verdict_note}` : ""}`,
          "",
          "## 复核要点",
          "- 下次同类告警先比对上述特征，命中即可按误报建议关单",
        ].join("\n"),
        tags: [...hostTag, "fp_pattern"],
      };
    }
    if (kase.verdict === "benign_true_positive") {
      return {
        kind: "env_fact",
        title: `环境事实：${kase.host || kase.id} ${kase.title}（经人工核验为授权/计划内行为）`,
        body: [
          "## 事实",
          `- 主机：${kase.host || "(未知)"}；场景：${kase.title}`,
          "- 人工核验结论：授权/计划内行为（benign_true_positive）",
          kase.verdict_note ? `- 登记：${kase.verdict_note}` : "- 登记：（未附）",
          "",
          "## 用法",
          "- 同主机同类告警先查本条环境事实，命中即按良性真实事件建议关单，不再升级",
        ].join("\n"),
        tags: [...hostTag, "env_fact"],
      };
    }
    // true_positive → runbook（处置经验）
    return {
      kind: "runbook",
      title: `处置 runbook：${kase.host || kase.id} ${kase.title}`,
      body: [
        "## 确认的攻击场景",
        `- 主机：${kase.host || "(未知)"}；场景：${kase.title}`,
        "",
        "## 处置步骤",
        "1. 按时间线取证（登录来源、落盘文件、外联目标）；",
        "2. 建议遏制动作（isolate/block）走 L2 审批，不自行动手；",
        "3. 关单时把 IOC 落 observables，供后续检索。",
      ].join("\n"),
      tags: [...hostTag, "runbook"],
    };
  }
}
