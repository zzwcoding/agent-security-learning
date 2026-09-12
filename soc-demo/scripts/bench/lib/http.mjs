// m13 压测工具面 · HTTP 客户端缝。布景动作（/healthz 预检、播种、读数）全走这里；
// baseUrl 显式注入 = 测试缝（specs/modules.md m13 Seam：可指向 node:http stub 做离线单测）。
// 边界规则 R3：本包只打各服务公开 HTTP 面，绝不 import services 内部。
const DEFAULT_TIMEOUT_MS = 10_000;

/** 带 status/path/body 的 HTTP 非 2xx 错误（fail-closed：调用方显式决定吞还是抛）。 */
export class HttpError extends Error {
  constructor(status, path, body) {
    super(`HTTP ${status} on ${path}${body ? `: ${JSON.stringify(body).slice(0, 200)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/**
 * 造一个绑死目标的 fetch 包装。返回 request(path, opts) → { status, ok, json, text }。
 * opts: { method, headers, body(对象自动 JSON 序列化), timeoutMs(单次覆盖), throwOnError }
 * 超时/网络错误统一抛普通 Error（cause 带原始 abort 原因）——三态（200/422/超时）在单测锁定。
 */
export function createHttpClient({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error("createHttpClient: baseUrl 必填（target 注入缝）");
  const base = baseUrl.replace(/\/+$/, "");
  return async function request(path, opts = {}) {
    const { method = "GET", headers = {}, body, timeoutMs: perCall, throwOnError = false } = opts;
    const limit = perCall ?? timeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${limit}ms`)), limit);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new Error(`request_failed ${method} ${path}: ${err?.cause?.message ?? err?.message ?? err}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null; // 非 JSON 响应体原样留在 text
    }
    if (throwOnError && !res.ok) throw new HttpError(res.status, path, json ?? text);
    return { status: res.status, ok: res.ok, json, text };
  };
}

/**
 * 轮询 /healthz 直到绿。前置检查用（B0 约定：/healthz 全绿才起压）。
 * 返回 true=绿；tries 用尽仍不绿 → false（调用方停下回报，不硬起压）。
 */
export async function waitHealthy(request, { path = "/healthz", tries = 60, intervalMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await request(path, { timeoutMs: 2000 });
      if (r.ok && r.json?.ok === true) return true;
    } catch {
      // 还没起完，继续等
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
