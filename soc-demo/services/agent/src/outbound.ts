// agent 内部共享出站件（票 43·F3，结构-8 收敛）：guards / llm / fga 三客户端与
// vector-store 的共同出站骨架——超时 signal、错误分类、ProbeResult、smokeProbe 探测模式。
//
// 为什么要有这个件：四个客户端各自手抄同一套「AbortSignal.timeout 造 signal +
// 看错误名判超时 + {ok, reason} 能力探测」，而且已经真漂移过一次——票 43 之前
// guards 只判 TimeoutError，llm/fga 判 TimeoutError||AbortError（体检报告 结构-8
// 的 reason 标签口径漂移）。收进来之后，「什么叫出站超时」只有本文件一处定义。
//
// reason 标签口径（本件定稿，漂移修正）：TimeoutError（AbortSignal.timeout 到时的
// DOMException 名）与 AbortError（调用方/运行时显式中止）都算「对方没按时给话」，
// 一律归 *_timeout；其余任何异常归 *_unreachable。语义：超时是「慢」，不可达是
// 「不通」——演示排障时两个 reason 指向两条不同的排查路径。

/** 真容器/真网冒烟能力探测的统一返回（票 16 msbProbe 先例的形状）：不可用时显式带
 *  原因返回，测试据此 skip 并打印，绝不静默装绿。 */
export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** 出站超时 signal 的唯一造口：所有出站 fetch 的 init.signal 一律从这里来——
 *  「每个出站调用都有超时」这条纪律在代码结构上可 grep（grep timeoutSignal 全命中）。 */
export function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/** 出站超时判定（唯一口径）：TimeoutError || AbortError → true。
 *  票 43 修正：guards 原本只判 TimeoutError（与 llm/fga 漂移），统一为双名判定。 */
export function isOutboundTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}

/** reason 标签拼法：`${ns}_timeout` / `${ns}_unreachable`（guards_timeout、fga_timeout…）。
 *  llm 客户端的稳定 code 是短名 timeout/unreachable（契约测试锁定），只复用
 *  isOutboundTimeout、不经过本函数。 */
export function outboundTimeoutReason(ns: string, timedOut: boolean): string {
  return timedOut ? `${ns}_timeout` : `${ns}_unreachable`;
}

/** smokeProbe 探测模式（票 16 msbProbe / 17 chromaSmokeProbe / 18 fgaSmokeProbe /
 *  27 llmSmokeProbe 的共同骨架）：GET 一个端点，按时回话才算可达；HTTP 状态码由
 *  调用方决定算不算事（llm 探针不判状态——代理有回话即算可达，行为保持）；网络错/
 *  超时一律 ok:false，原因文案由调用方给全（「要跑：docker compose up -d …」这类
 *  指路话术是各探针自己的，不收进来）。 */
export async function smokeHttpProbe(
  url: string,
  opts: {
    timeoutMs: number;
    /** 非 2xx 的原因文案；不传 = 任何 HTTP 回应都算可达（llm 探针口径）。 */
    onHttpStatus?: (status: number) => string;
    /** 网络不通/超时的原因文案。 */
    onUnreachable: (e: unknown) => string;
  },
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { signal: timeoutSignal(opts.timeoutMs) });
    if (!res.ok && opts.onHttpStatus) return { ok: false, reason: opts.onHttpStatus(res.status) };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: opts.onUnreachable(e) };
  }
}
