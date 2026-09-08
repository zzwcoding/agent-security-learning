// 资源兜底计数（m3 内部模块 budget；口径 = PRD 决策记录 #4/#5/#12）：
//   LLM 调用超时统一 60s（留 per-node env 口子）、max_steps 20、token 50k/run。
// Tracecat 口径：限次数挡不住推理死循环，按 token 限。这里只管「数到没数超」；
// 超限后的强杀（run→failed）+ 审计 + error 事件在 graph.ts（runner）统一处理。
export type BudgetKind = "max_steps" | "token_budget" | "llm_timeout";

export class BudgetExceededError extends Error {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly used: number;
  constructor(kind: BudgetKind, limit: number, used: number) {
    super(`budget_exceeded: ${kind} limit=${limit} used=${used}`);
    this.name = "BudgetExceededError";
    this.kind = kind;
    this.limit = limit;
    this.used = used;
  }
}

export interface BudgetOpts {
  maxSteps?: number;
  maxTokensPerRun?: number;
  llmTimeoutMs?: number;
}

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_TOKENS_PER_RUN = 50_000;
const DEFAULT_LLM_TIMEOUT_MS = 60_000;

const num = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : undefined;
};

/** 一个 run 一本账：步数、token 累计、LLM 墙钟。超限即抛，由 runner 强杀。 */
export class RunBudget {
  steps = 0;
  tokens = 0;

  constructor(
    private readonly fixed: BudgetOpts = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get maxSteps(): number {
    return this.fixed.maxSteps ?? num(this.env.MAX_STEPS) ?? DEFAULT_MAX_STEPS;
  }

  get maxTokensPerRun(): number {
    return this.fixed.maxTokensPerRun ?? num(this.env.MAX_TOKENS_PER_RUN) ?? DEFAULT_MAX_TOKENS_PER_RUN;
  }

  /** LLM 超时（决策 #4）：per-node env（LLM_TIMEOUT_MS_<NODE 大写>）> 全局 LLM_TIMEOUT_MS > 60s。 */
  llmTimeoutMs(node: string): number {
    return (
      this.fixed.llmTimeoutMs ??
      num(this.env[`LLM_TIMEOUT_MS_${node.toUpperCase()}`]) ??
      num(this.env.LLM_TIMEOUT_MS) ??
      DEFAULT_LLM_TIMEOUT_MS
    );
  }

  /** 每个图节点计一步：第 maxSteps+1 步在计数前就被拒（已消耗步数=used）。 */
  step(): void {
    if (this.steps >= this.maxSteps) {
      throw new BudgetExceededError("max_steps", this.maxSteps, this.steps);
    }
    this.steps += 1;
  }

  /** 每次 LLM 回包按用量计费（真 worker 接 LLM 适配器时由节点调用）。 */
  charge(tokens: number): void {
    this.tokens += tokens;
    if (this.tokens > this.maxTokensPerRun) {
      throw new BudgetExceededError("token_budget", this.maxTokensPerRun, this.tokens);
    }
  }

  /** LLM 调用的墙钟闸：startedAt/now 由调用方注入（真实现取调用前后时钟，
   *  测试/eval 伪 LLM 直接报假时长——禁 wall clock 的同款纪律）。 */
  checkLlm(node: string, startedAtMs: number, nowMs: number): void {
    const elapsed = nowMs - startedAtMs;
    if (elapsed > this.llmTimeoutMs(node)) {
      throw new BudgetExceededError("llm_timeout", this.llmTimeoutMs(node), elapsed);
    }
  }
}

/** 生产默认账本：口径全部可被 env 覆盖（docker-compose/单机跑都留调参口子）。 */
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): RunBudget {
  return new RunBudget({}, env);
}
