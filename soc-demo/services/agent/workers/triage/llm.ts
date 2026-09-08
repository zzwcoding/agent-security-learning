// m4 分诊 worker · LLM seam + fixture 伪 LLM（票 13）。
//
// m4 卡 Seam：LLM 调用 adapter = minimax-m2 经凭证代理（票 17+ 接真件，base_url 指
// gateway /proxy/llm/*） / eval fixture 伪 LLM。本票按 tracer-bullet 打法先落伪 LLM：
// 阶段 5 的目标是把「prompt 契约 → 结构化 verdict → 写回 M2」这条数据流一次打通，
// LLM 换真件时只换 adapter，图与闸一行不动。
//
// 伪 LLM 的判定规则 = prompt 契约里那串 M507 决策点的确定性版（KB 已知变更优先 →
// 攻击证据 → 弱信号 → 运维噪声），不偷看 fixture 名、不抄标注集——标注集（accuracy
// 测试）是独立于规则写好的第三方裁判，规则与标注对不上就是 pipeline 的锅。
import type { LlmCall, LlmReply, TriageInput } from "./prompt.js";

export interface TriageLlm {
  verdict(call: LlmCall): Promise<LlmReply>;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// 攻击证据（R2）：与具体 fixture 无关的内容信号——标题语义 / 日志关键词 / URL 探测特征
const ATTACK_TITLE = /brute force|malicious file|rootkit|anomaly detection/i;
const ATTACK_LOG = /rootkit|illegal user|failed password/i;
const ATTACK_URL = /(union\s+select|<script|whoami\.cgi|\/etc\/passwd)/i;
// 弱信号（R3）：孤立的无效用户登录试探——真试探也可能是口令笔误，交人工
const WEAK_TITLE = /non-existent user/i;
// 运维噪声（R4）：Web 服务器 4xx/5xx（无 R2 信号时）
const NOISE_TITLE = /error code|file added/i;

export class FakeTriageLlm implements TriageLlm {
  /** 每次回包报一个固定小用量——graph 预算的 charge 口有真实计费路径可走。 */
  private readonly tokensPerCall: number;

  constructor(tokensPerCall = 64) {
    this.tokensPerCall = tokensPerCall;
  }

  async verdict(call: LlmCall): Promise<LlmReply> {
    const { alert, kbHits, merge, untrusted } = call.input;
    // FR-M4.4 自我审计 checkpoint 的声明段：伪 LLM 照实转抄 merge_check 实际结果
    // （谎报的情形由测试注入说谎 LLM 验证，见 flow.test.ts「自我审计矛盾强制降级」）
    const self_audit = {
      open_cases_checked: merge.openCasesChecked,
      host_searched: merge.host,
      same_host_case_found: merge.sameHostCaseFound,
    };

    const text = JSON.stringify(this.decide(alert, kbHits, untrusted, merge, self_audit));
    return { text, tokens: this.tokensPerCall };
  }

  private decide(
    alert: TriageInput["alert"],
    kbHits: TriageInput["kbHits"],
    untrusted: TriageInput["untrusted"],
    merge: TriageInput["merge"],
    self_audit: {
      open_cases_checked: number;
      host_searched: string;
      same_host_case_found: boolean;
    },
  ): Record<string, unknown> {
    // R1（FR-M4.2 KB 优先）：内部事实说这是已知变更 → 良性真实事件，建议关单。
    // 票 17：真检索面（chroma）的条目 kind 是 PRD §5.10 三值——env_fact（内网环境
    // 事实：资产/账号/变更/演练登记）与 MemoryKb 的 known_change 同属「内部事实核验」，
    // 同享 KB 优先；fp_pattern/runbook 是模式与处置经验，不参与本规则。
    const knownChange = kbHits.find((h) => h.kind === "known_change" || h.kind === "env_fact");
    if (knownChange) {
      return {
        verdict: "btp",
        confidence: 0.9,
        rationale: `KB 已知变更命中：${knownChange.title}`,
        self_audit,
        recommended_action: "close",
      };
    }
    // R2 攻击证据：高危 severity / 标题语义 / 日志关键词 / URL 探测特征
    const urlish = untrusted
      .filter((f) => f.field.startsWith("observable:url"))
      .map((f) => decode(f.content))
      .join("\n");
    const logish = untrusted.map((f) => f.content).join("\n");
    if (
      alert.severity >= 3 ||
      ATTACK_TITLE.test(alert.title) ||
      ATTACK_LOG.test(logish) ||
      ATTACK_URL.test(urlish)
    ) {
      return {
        verdict: "tp",
        confidence: 0.85,
        rationale: `攻击证据成立（title=${alert.title} severity=${alert.severity}）`,
        self_audit,
        // FR-M4.3 归并优先：同主机 24h 有活跃 case 就并案，不新建
        recommended_action: merge.sameHostCaseFound && merge.candidateCaseId
          ? `merge:${merge.candidateCaseId}`
          : "create_case",
      };
    }
    // R3 弱信号：孤立登录试探，宁可升级人工不可猜
    if (WEAK_TITLE.test(alert.title)) {
      return {
        verdict: "uncertain",
        confidence: 0.4,
        rationale: "孤立的无效用户登录试探，无法排除口令笔误或低强度探测",
        self_audit,
        recommended_action: "human",
      };
    }
    // R4 运维噪声
    if (NOISE_TITLE.test(alert.title)) {
      return {
        verdict: "fp",
        confidence: 0.75,
        rationale: "Web/文件事件无攻击特征，按运维噪声处理",
        self_audit,
        recommended_action: "close",
      };
    }
    return {
      verdict: "uncertain",
      confidence: 0.3,
      rationale: "无匹配决策点，默认升级人工",
      self_audit,
      recommended_action: "human",
    };
  }
}
