// m4 分诊 worker · 结构化输出 schema（票 13 验收 1）。
//
// m4 卡：prompt 契约（结构化输出 schema）是这个模块的事实接口。LLM 回包是自由文本，
// 这里按 PRD §6-M4 的 JSON 契约逐字段把关；不合 schema → 上层重试 1 次 → 仍失败置
// uncertain（PRD 异常与边界：宁可升级人工不可猜）。
import type { MergeCheck, TriVerdict } from "./prompt.js";

export const VERDICT_VALUES = ["fp", "btp", "tp", "uncertain"] as const;

/** PRD §6-M4 输出 JSON 原样：self_audit 字段齐全是 FR-M4.4 的可检验 artifact。 */
export interface VerdictOutput {
  verdict: TriVerdict;
  confidence: number;
  rationale: string;
  self_audit: {
    open_cases_checked: number;
    host_searched: string;
    same_host_case_found: boolean;
  };
  recommended_action: string; // "close" | "create_case" | "merge:case_XXXXXX" | "human"
}

export type ParseResult =
  | { ok: true; verdict: VerdictOutput }
  | { ok: false; error: string };

// merge:<case_id> —— PRD 推荐动作的并案写法（M507 Decision Point）
const ACTION_RE = /^(close|create_case|merge:case_\d+|human)$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 显式验型（verify-ticket 的 reqStr 同款纪律）：LLM 回包里 undefined 参与比较会静默
 *  漏过，必须逐字段把关——fail-closed 的 schema 版。 */
export function parseVerdict(raw: unknown): ParseResult {
  try {
    const obj = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (!isObj(obj)) return { ok: false, error: "not_an_object" };

    const verdict = obj.verdict;
    if (typeof verdict !== "string" || !(VERDICT_VALUES as readonly string[]).includes(verdict)) {
      return { ok: false, error: `bad_verdict:${String(verdict)}` };
    }
    const confidence = obj.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return { ok: false, error: "bad_confidence" };
    }
    if (typeof obj.rationale !== "string" || obj.rationale.length === 0) {
      return { ok: false, error: "bad_rationale" };
    }
    const sa = obj.self_audit;
    if (!isObj(sa)) return { ok: false, error: "self_audit_missing" };
    if (typeof sa.open_cases_checked !== "number" || !Number.isInteger(sa.open_cases_checked)) {
      return { ok: false, error: "bad_self_audit.open_cases_checked" };
    }
    if (typeof sa.host_searched !== "string") return { ok: false, error: "bad_self_audit.host_searched" };
    if (typeof sa.same_host_case_found !== "boolean") {
      return { ok: false, error: "bad_self_audit.same_host_case_found" };
    }
    const action = obj.recommended_action;
    if (typeof action !== "string" || !ACTION_RE.test(action)) {
      return { ok: false, error: `bad_recommended_action:${String(action)}` };
    }
    return {
      ok: true,
      verdict: {
        verdict: verdict as TriVerdict,
        confidence,
        rationale: obj.rationale,
        self_audit: {
          open_cases_checked: sa.open_cases_checked,
          host_searched: sa.host_searched,
          same_host_case_found: sa.same_host_case_found,
        },
        recommended_action: action,
      },
    };
  } catch (e) {
    return { ok: false, error: `unparseable:${e instanceof Error ? e.message : String(e)}` };
  }
}

/** LLM 输出不合 schema 重试 1 次仍失败 → 置 uncertain + 人工待办（PRD 异常与边界）。
 *  self_audit 用 merge_check 实际值填——声明可以缺失，事实不能缺失。 */
export function uncertainFallback(reason: string, merge: MergeCheck): VerdictOutput {
  return {
    verdict: "uncertain",
    confidence: 0,
    rationale: `llm output unusable (${reason}); escalated to human`,
    self_audit: {
      open_cases_checked: merge.openCasesChecked,
      host_searched: merge.host,
      same_host_case_found: merge.sameHostCaseFound,
    },
    recommended_action: "human",
  };
}
