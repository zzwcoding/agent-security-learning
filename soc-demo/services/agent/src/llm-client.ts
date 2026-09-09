// 真 LLM 出站 client（票 27·ADR 0002 框架回补：四 worker 的生产 LLM adapter 地基）。
//
// 红线（ADR 0002 决策 2 / m3·m4·m5 卡 Seam）：真 LLM 调用必须经 services/gateway 的
// /proxy/llm/* 出站（占位符换真凭证 + 金丝雀断言，票 08 契约）；真凭证只活在网关进程，
// 本进程 env 里没有也不需要任何 SECRETS_*。base_url 指代理、模型走 env 可配（PRD 决策 #7
// LLM_MODEL=minimax-m2）；上游 API 形态按 OpenAI 兼容 chat/completions（m3/m4 卡口径，
// minimax 兼容该形态——票 27 执行记录有留痕）。
//
// fail-closed 纪律（INV-1·验收④）：超时/限流/上游不可达/回包坏形一律映射成带 reason code
// 的 LlmUpstreamError，绝不裸抛原始 fetch 错误；上游/代理的错误正文（provider 可控文本）
// 一个字都不进 error 消息——它不许流入我们的审计与 SSE 事件面（INV-4 邻域卫生）。
// 超时口径与 budget 三闸同一条 env 链（LLM_TIMEOUT_MS_<NODE> > LLM_TIMEOUT_MS > 60s，
// 决策 #4）：adapter 先断，budget.checkLlm 墙钟仍是最终兜底闸——对齐不抢闸。
//
// 出站 seam：fetchImpl 可注入（票 08 test_proxy.py 的 httpx.MockTransport 先例在 TS 侧的
// 等价物）——契约测试用它捕获请求形态，绝不真出网。
import { budgetFromEnv } from "./budget.js";
import { isOutboundTimeout, smokeHttpProbe, timeoutSignal, type ProbeResult } from "./outbound.js";

export type { ProbeResult };

/** adapter 依赖的窄缝（票 43·F5 收敛：triage/investigation/knowledge 三份手抄上提至此，
 *  chat 侧经 triage 再出口的引用也回到这一份）：只要会 chat——生产 GatewayLlmClient
 *  结构适配，测试注入确定性假件。 */
export interface ChatSeam {
  chat(content: string, opts: { node: string }): Promise<LlmChatResult>;
}

/** 上游病了的类型化错误：code 是稳定 reason code（审计/降级标记可读），message 只带 code。 */
export class LlmUpstreamError extends Error {
  /** timeout | unreachable | rate_limited | http_<status> | bad_shape */
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(`llm_upstream:${code}${detail ? `; ${detail}` : ""}`);
    this.name = "LlmUpstreamError";
    this.code = code;
  }
}

export interface LlmChatResult {
  /** 模型自由文本（assistant content 原文；是否合 schema 由调用方 parseVerdict/parseReport 把关） */
  text: string;
  /** usage.total_tokens（上游不报用量就记 0——计费口不编数） */
  tokens: number;
}

export interface GatewayLlmClientOpts {
  /** 代理 base（默认 env SOC_LLM_PROXY_URL，再默认 compose 服务名 http://gateway:8002/proxy/llm） */
  baseUrl?: string;
  /** 模型名（默认 env LLM_MODEL，再默认 minimax-m2——PRD 决策 #7） */
  model?: string;
  /** → x-request-id（代理审计五要素与 run 调用链关联） */
  requestId?: string;
  /** → x-actor-id（如 agent:triage / agent:investigation） */
  actor?: string;
  /** 固定超时 ms（缺省每调用读 budget 同款 env 链，见文件头） */
  timeoutMs?: number;
  /** 出站 seam：测试注入 mock 捕获请求；生产用全局 fetch */
  fetchImpl?: typeof fetch;
}

export class GatewayLlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestId?: string;
  private readonly actor?: string;
  private readonly fixedTimeoutMs?: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GatewayLlmClientOpts = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.SOC_LLM_PROXY_URL ?? "http://gateway:8002/proxy/llm";
    this.model = opts.model ?? process.env.LLM_MODEL ?? "minimax-m2";
    this.requestId = opts.requestId;
    this.actor = opts.actor;
    this.fixedTimeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  /** budget 三闸同款 env 链（决策 #4）：per-node env > 全局 env > 60s。每次调用现读，
   *  env 改了即时生效；fixedTimeoutMs 传了就以它为准（测试/特殊节点）。 */
  timeoutMs(node: string): number {
    return this.fixedTimeoutMs ?? budgetFromEnv().llmTimeoutMs(node);
  }

  /** 一次 OpenAI 兼容 chat/completions：prompt 契约文本逐字作为唯一 user 消息出域
   *  （不拆不改——prompt 装配是 workers 的契约面，这里只管搬运与把关传输层）。 */
  async chat(content: string, opts: { node: string }): Promise<LlmChatResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.actor ? { "x-actor-id": this.actor } : {}),
          ...(this.requestId ? { "x-request-id": this.requestId } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0, // SOC 判定要稳定，不要创造性
          messages: [{ role: "user", content }],
        }),
        signal: timeoutSignal(this.timeoutMs(opts.node)),
      });
    } catch (e) {
      // 票 43：超时判定（TimeoutError||AbortError）收进共享出站件，与 guards/fga 同口径
      throw new LlmUpstreamError(isOutboundTimeout(e) ? "timeout" : "unreachable");
    }
    if (!res.ok) {
      // 只记状态码不记正文：上游错误文本是 provider 可控内容，不许进我们的审计/事件面
      throw new LlmUpstreamError(res.status === 429 ? "rate_limited" : `http_${res.status}`);
    }
    let obj: unknown;
    try {
      obj = await res.json();
    } catch {
      throw new LlmUpstreamError("bad_shape", "response not json");
    }
    const choices = (obj as { choices?: unknown }).choices;
    const content0 = Array.isArray(choices) && choices.length > 0
      ? (choices[0] as { message?: { content?: unknown } }).message?.content
      : undefined;
    if (typeof content0 !== "string") {
      throw new LlmUpstreamError("bad_shape", "missing choices[0].message.content");
    }
    const usage = (obj as { usage?: { total_tokens?: unknown } }).usage;
    const tokens = typeof usage?.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : 0;
    return { text: content0, tokens };
  }
}

/** 真 model 输出剥壳：MiniMax-M2 等推理模型会在 content 前带 `<think>…</think>` 推理段
 *  （真网实测，票 27 冒烟），markdown 代码围栏也常见——两层都无损剥掉。剥不动（未闭合）
 *  就原样交回——schema 把关在 worker，绝不硬修到合法为止。 */
export function unwrapJsonText(s: string): string {
  const noThink = s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = noThink.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : noThink).trim();
}

/** 真网冒烟能力探测（验收⑤，票 16 msbProbe 先例）：SECRETS_LLM_API_KEY 有真值且
 *  gateway /proxy/llm 可达才允许真出网；否则显式带原因返回（测试据此 skip 并打印），
 *  绝不静默。key 指真值仓的 provider key——它只该出现在网关进程，测试进程里只是
 *  「本机是否有真凭证」的探针，本身不进任何出站体。
 *  票 43（F3）：探测骨架（fetch+超时+ProbeResult）走共享 smokeHttpProbe——本探针不判
 *  HTTP 状态码（代理有回话即算可达），不传 onHttpStatus 即是这一口径。 */
export async function llmSmokeProbe(baseUrl?: string): Promise<ProbeResult> {
  if (!process.env.SECRETS_LLM_API_KEY) {
    return {
      ok: false,
      reason: "SECRETS_LLM_API_KEY 无真值——真网冒烟 skip（ADR 0002 决策 2：无 key 显式 skip 留痕。" +
        "要跑：export SECRETS_LLM_API_KEY=<真key> 并 docker compose up -d gateway 后重跑）",
    };
  }
  const base = baseUrl ?? process.env.SOC_LLM_SMOKE_URL ?? "http://127.0.0.1:8002/proxy/llm";
  return smokeHttpProbe(`${base}/v1/models`, {
    timeoutMs: 5000,
    onUnreachable: () =>
      `gateway /proxy/llm 不可达（${base}）——先 docker compose up -d gateway 再重跑`,
  });
}
