// guards 客户端（票 04 验收 4）：所有不可信内容进 prompt 前的唯一入口。
// PRD S3 异常与边界 + INV-1：服务不可达/扫描超时（默认 2s）一律 fail-closed——
// 不可信段不进 prompt，调用方据 blocked=true 走转人工/拒答；GUARDS_FAIL_MODE=flag
// 可切「仅标记」降级模式（演示默认 fail-closed）。
// 票 43（F3）：超时/错误分类收进共享出站件 outbound.ts——reason 判定（TimeoutError
// 与 AbortError 都算超时）与 llm/fga 同一口径，本文件不再自持一份。
import { isOutboundTimeout, outboundTimeoutReason, timeoutSignal } from "./outbound.js";

export const DEFAULT_TIMEOUT_MS = 2000;

// 通道枚举的运行时名单（票 32 形状锁；票 31 events.ts 先例：类型是编译期注记，
// 测试摸不到——数组才是能与 fixtures/guards/contract.json 对暗号的运行时事实）。
export const SCAN_CHANNELS = [
  "alert_field",
  "user_input",
  "kb",
  "tool_output",
] as const;

export type ScanChannel = (typeof SCAN_CHANNELS)[number];
export type ScanAction = "allow" | "block" | "strip" | "flag" | "fail_closed";

export interface ScanDecision {
  /** true = 不可信段不进 prompt（命中 block 策略，或 guards 不可用而 fail-closed） */
  blocked: boolean;
  action: ScanAction;
  score?: number;
  /** strip 通道的清洗后文本 */
  text?: string;
  /** fail_closed 时的原因：guards_unreachable | guards_timeout */
  reason?: string;
}

export interface ScanOptions {
  baseUrl?: string;
  timeoutMs?: number;
  failMode?: "block" | "flag";
}

export async function scanInjection(
  text: string,
  channel: ScanChannel,
  opts: ScanOptions = {},
): Promise<ScanDecision> {
  const baseUrl = opts.baseUrl ?? process.env.GUARDS_URL ?? "http://guards:8001";
  const timeoutMs = opts.timeoutMs ?? Number(process.env.GUARDS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const failMode = opts.failMode
    ?? (process.env.GUARDS_FAIL_MODE as "block" | "flag" | undefined)
    ?? "block";
  try {
    const res = await fetch(`${baseUrl}/scan/injection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, channel }),
      signal: timeoutSignal(timeoutMs),
    });
    if (!res.ok) {
      return unreachable(failMode, `guards_http_${res.status}`);
    }
    const data = (await res.json()) as {
      is_injection: boolean;
      score: number;
      action: "allow" | "block" | "strip" | "flag";
      text?: string;
    };
    return {
      blocked: data.is_injection && data.action === "block",
      action: data.action,
      score: data.score,
      text: data.text,
    };
  } catch (e) {
    return unreachable(failMode, outboundTimeoutReason("guards", isOutboundTimeout(e)));
  }
}

function unreachable(failMode: "block" | "flag", reason: string): ScanDecision {
  if (failMode === "flag") {
    return { blocked: false, action: "flag", reason };
  }
  return { blocked: true, action: "fail_closed", reason };
}

// ---- 票 49（ADR 0004-3）：PII 受控反查的 guards 出站（/pii/reveal 转发半边）----
// 与 scanInjection 同一套出站纪律（超时/错误分类收 outbound.ts，INV-1 fail-closed）：
// 任何失败都收口成 {ok:false, reason}，绝不抛异常炸端点，也绝不编造原文。

export type PiiRevealOutcome =
  | { ok: true; placeholder: string; originals: string[] }
  | { ok: false; reason: string };

export interface PiiRevealOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

/** 按占位符向 guards 反查原文。上游语义：404 = 映射表查无此人（unknown），
 *  其它非 200 = guards 病了；响应形状不对也按病了算（guards_bad_shape）。 */
export async function revealPii(
  placeholder: string,
  opts: PiiRevealOptions = {},
): Promise<PiiRevealOutcome> {
  const baseUrl = opts.baseUrl ?? process.env.GUARDS_URL ?? "http://guards:8001";
  const timeoutMs = opts.timeoutMs ?? Number(process.env.GUARDS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/pii/reveal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ placeholder }),
      signal: timeoutSignal(timeoutMs),
    });
    if (res.status === 404) return { ok: false, reason: "placeholder_unknown" };
    if (!res.ok) return { ok: false, reason: `guards_http_${res.status}` };
    const data = (await res.json()) as { placeholder?: unknown; originals?: unknown };
    if (
      !Array.isArray(data.originals) ||
      !data.originals.every((x) => typeof x === "string")
    ) {
      return { ok: false, reason: "guards_bad_shape" };
    }
    return {
      ok: true,
      placeholder: typeof data.placeholder === "string" ? data.placeholder : placeholder,
      originals: data.originals,
    };
  } catch (e) {
    return { ok: false, reason: outboundTimeoutReason("guards", isOutboundTimeout(e)) };
  }
}
