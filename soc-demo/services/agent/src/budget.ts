// 资源兜底计数（m3 内部模块 budget；口径 = PRD 决策记录 #4/#5/#12）：
//   LLM 调用超时统一 60s（留 per-node env 口子）、max_steps 20、token 50k/run。
// Tracecat 口径：限次数挡不住推理死循环，按 token 限。这里只管「数到没数超」；
// 超限后的强杀（run→failed）+ 审计 + error 事件在 graph.ts（runner）统一处理。
// 票 77 预算双闸：kind 集合的扩展是纯增量——既有三闸（max_steps/token_budget/llm_timeout）
// 的触发条件、缺省档、env 口子逐字节不动（旧 kind 零回归是硬验收）。新增四种：
//   round_*        轮次级三闸（RoundBudget：每轮独立计步/计 token/墙钟，spec 预算档位节）
//   rounds         max_rounds 硬顶（T09：第 max_rounds+1 轮开跑前即拒）
//   parent_cancelled 取消停止机制（m14 cancel.ts）借道既有强杀路径的标记 kind——
//                  让「子 run failed(parent_cancelled)」与预算强杀同一条口径（审计 +
//                  error 事件 + SSE 同款可见），禁第二套强杀实现。
export type BudgetKind =
  | "max_steps"
  | "token_budget"
  | "llm_timeout"
  | "round_max_steps"
  | "round_token_budget"
  | "round_timeout"
  | "rounds"
  | "parent_cancelled";

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

// ---------- 预算档位（票 77，spec orchestration-loop.md「预算档位」节 / ADR 0005 收口） ----------

/** 一档的三闸数字（run 级与轮级同形；llmTimeoutMs 兼作轮级墙钟上限的缺省来源）。 */
export interface BudgetTierSpec {
  maxSteps: number;
  maxTokensPerRun: number;
  llmTimeoutMs: number;
}

/** 按 run kind 分档的预算档位表（唯一事实源，m3 领地）。不在表内的 kind——alert_flow
 *  等旧 kind 与 hunt_task 子 run——一律默认档（60s/20 步/50k，行为零变化=票 77 硬验收；
 *  hunt_task 沿用默认档故不单列）。档位数字可被 env 覆写：run 级 <KIND 大写>_MAX_STEPS /
 *  <KIND 大写>_MAX_TOKENS_PER_RUN / <KIND 大写>_LLM_TIMEOUT_MS，轮级再加 _ROUND 前缀段。 */
export const BUDGET_TIERS: Record<string, { run: BudgetTierSpec; round?: BudgetTierSpec }> = {
  hunt_flow: {
    // run 级 900s / 200 步 / 500k token；轮级 120s / 10 步 / 30k token（spec 定稿数字，
    // 票 77 首跑回测对账四天花板，偏差 >20% 记票调档）
    run: { maxSteps: 200, maxTokensPerRun: 500_000, llmTimeoutMs: 900_000 },
    round: { maxSteps: 10, maxTokensPerRun: 30_000, llmTimeoutMs: 120_000 },
  },
};

const tierWithEnv = (
  tier: BudgetTierSpec,
  env: NodeJS.ProcessEnv,
  keys: { steps: string; tokens: string; timeout: string },
): BudgetTierSpec => ({
  maxSteps: num(env[keys.steps]) ?? tier.maxSteps,
  maxTokensPerRun: num(env[keys.tokens]) ?? tier.maxTokensPerRun,
  llmTimeoutMs: num(env[keys.timeout]) ?? tier.llmTimeoutMs,
});

/** 轮次级闸（票 77 T18）：三闸口径与 RunBudget 同构，但账本单轮独立（防 planner 拆一条
 *  任务耗光父 run 预算的偏科场景）。触发错误的 kind 带 round_ 前缀——fail_reason/审计
 *  可区分轮级与 run 级；强杀仍走 BudgetExceededError 同一条 runner 路径（禁第二套实现）。 */
export class RoundBudget extends RunBudget {
  /** 每个图节点计一步（轮账独立）：第 maxSteps+1 步在计数前就被拒。 */
  step(): void {
    if (this.steps >= this.maxSteps) {
      throw new BudgetExceededError("round_max_steps", this.maxSteps, this.steps);
    }
    this.steps += 1;
  }

  /** 轮内 LLM 用量计费：先记账后判超（与 RunBudget.charge 同序，超额也留账）。 */
  charge(tokens: number): void {
    this.tokens += tokens;
    if (this.tokens > this.maxTokensPerRun) {
      throw new BudgetExceededError("round_token_budget", this.maxTokensPerRun, this.tokens);
    }
  }

  /** 轮级墙钟闸：startedAt/now 由调用方注入（轮次 run 首节点入场起表；测试注假钟——
   *  禁 wall clock 的同款纪律）。 */
  checkLlm(node: string, startedAtMs: number, nowMs: number): void {
    const elapsed = nowMs - startedAtMs;
    if (elapsed > this.llmTimeoutMs(node)) {
      throw new BudgetExceededError("round_timeout", this.llmTimeoutMs(node), elapsed);
    }
  }
}

export interface KindBudget {
  /** 该 kind 的 run 级账本（executeStartJob/resumeRun 的 ExecuteOpts.budget 装配口）。 */
  run: RunBudget;
  /** 轮级账本原型（hunt_flow 轮次链每轮一条新账；无轮档的 kind = null，机制侧不设闸）。 */
  round: RoundBudget | null;
}

/** kind → 档位账本（每次调用全新实例：账本随 run/轮走，绝不共享可变状态）。
 *  不在档位表内的 kind 返回默认档 run 账 + 无轮闸——与 budgetFromEnv 等价（零回归）。 */
export function budgetForKind(kind: string, env: NodeJS.ProcessEnv = process.env): KindBudget {
  const tier = BUDGET_TIERS[kind];
  if (!tier) return { run: new RunBudget({}, env), round: null };
  const prefix = kind.toUpperCase();
  return {
    run: new RunBudget(
      tierWithEnv(tier.run, env, {
        steps: `${prefix}_MAX_STEPS`,
        tokens: `${prefix}_MAX_TOKENS_PER_RUN`,
        timeout: `${prefix}_LLM_TIMEOUT_MS`,
      }),
      env,
    ),
    round: tier.round
      ? new RoundBudget(
          tierWithEnv(tier.round, env, {
            steps: `${prefix}_ROUND_MAX_STEPS`,
            tokens: `${prefix}_ROUND_MAX_TOKENS_PER_RUN`,
            timeout: `${prefix}_ROUND_LLM_TIMEOUT_MS`,
          }),
          env,
        )
      : null,
  };
}

/** max_rounds 硬顶（票 77 T09/行为约定 11 同族）：第 maxRounds+1 轮在开跑前就被拒。
 *  超顶轮次 run 经 BudgetExceededError 既有强杀路径收口（failed + 审计 + error 事件 +
 *  SSE 可见）；假设侧 cancelled(budget_rounds) 由 m14 取消机制消费该强杀事件落账。 */
export function assertRoundsBudget(roundNo: number, maxRounds: number): void {
  if (roundNo > maxRounds) {
    throw new BudgetExceededError("rounds", maxRounds, roundNo);
  }
}
