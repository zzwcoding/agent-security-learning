import { describe, expect, test } from "vitest";
import { RunBudget, budgetFromEnv, BudgetExceededError } from "./budget.js";

// 资源兜底口径（m3 卡·决策 #4/#5/#12）：LLM 超时统一 60s（per-node env 口子）、
// max_steps 20、token 50k/run。超限 = BudgetExceededError，强杀与审计在 runner 层测。
describe("资源兜底计数（budget）", () => {
  test("默认口径：max_steps 20 / token 50k / LLM 60s", () => {
    const b = new RunBudget();
    expect(b.maxSteps).toBe(20);
    expect(b.maxTokensPerRun).toBe(50_000);
    expect(b.llmTimeoutMs("triage")).toBe(60_000);
  });

  test("max_steps：前 20 步放行，第 21 步抛 max_steps 超限", () => {
    const b = new RunBudget();
    for (let i = 0; i < 20; i++) expect(() => b.step()).not.toThrow();
    let err: BudgetExceededError | undefined;
    try {
      b.step();
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("max_steps");
    expect(err?.limit).toBe(20);
    expect(err?.used).toBe(20); // 已走满 20 步，第 21 步被拒
  });

  test("token 50k/run：累计不超放行，超 1 token 即抛（Tracecat 口径：限次数挡不住推理死循环，按 token 限）", () => {
    const b = new RunBudget();
    b.charge(49_999);
    expect(b.tokens).toBe(49_999);
    let err: BudgetExceededError | undefined;
    try {
      b.charge(2); // 50_001 > 50_000
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("token_budget");
    expect(err?.limit).toBe(50_000);
    expect(err?.used).toBe(50_001);
  });

  test("LLM 超时 60s（决策 #4）：59_999ms 放行，60_001ms 抛 llm_timeout", () => {
    const b = new RunBudget();
    const t0 = 1_000;
    expect(() => b.checkLlm("triage", t0, t0 + 59_999)).not.toThrow();
    let err: BudgetExceededError | undefined;
    try {
      b.checkLlm("triage", t0, t0 + 60_001);
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("llm_timeout");
    expect(err?.used).toBe(60_001);
    expect(err?.limit).toBe(60_000);
  });

  test("env 口子：MAX_STEPS / MAX_TOKENS_PER_RUN / LLM_TIMEOUT_MS 全局覆盖", () => {
    const b = budgetFromEnv({ MAX_STEPS: "3", MAX_TOKENS_PER_RUN: "100", LLM_TIMEOUT_MS: "5000" });
    expect(b.maxSteps).toBe(3);
    expect(b.maxTokensPerRun).toBe(100);
    expect(b.llmTimeoutMs("triage")).toBe(5000);
    let err: BudgetExceededError | undefined;
    try {
      b.charge(101);
    } catch (e) {
      err = e as BudgetExceededError;
    }
    expect(err?.kind).toBe("token_budget");
  });

  test("per-node env 口子：LLM_TIMEOUT_MS_<NODE 大写> 盖过全局（m3 卡：留 per-node env 口子）", () => {
    const b = budgetFromEnv({ LLM_TIMEOUT_MS: "60000", LLM_TIMEOUT_MS_TRIAGE: "1000" });
    expect(b.llmTimeoutMs("triage")).toBe(1000);
    expect(b.llmTimeoutMs("investigation")).toBe(60_000);
  });
});
