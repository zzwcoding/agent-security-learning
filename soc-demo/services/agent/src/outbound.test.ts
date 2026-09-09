// 票 43·F3：共享出站件 outbound 的单测——「什么叫出站超时」「smokeProbe 长什么样」
// 收敛后的唯一定义处锁在这里。超时/不可达用真实本地 HTTP 服务器制造（guards-client
// 测试先例），不 mock fetch。
import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import {
  isOutboundTimeout,
  outboundTimeoutReason,
  smokeHttpProbe,
  timeoutSignal,
} from "./outbound.js";

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function startServer(status: number, delayMs = 0): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end("{}");
      }, delayMs);
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

describe("isOutboundTimeout（票 43 统一口径：TimeoutError || AbortError 都算「没按时给话」）", () => {
  test("TimeoutError / AbortError → true；其余错误与非错误值 → false（guards 旧口径漏 AbortError，已修）", () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    expect(isOutboundTimeout(timeoutErr)).toBe(true);
    expect(isOutboundTimeout(abortErr)).toBe(true);
    expect(isOutboundTimeout(new TypeError("fetch failed"))).toBe(false);
    expect(isOutboundTimeout("boom")).toBe(false);
    expect(isOutboundTimeout(undefined)).toBe(false);
  });

  test("outboundTimeoutReason：${ns}_timeout / ${ns}_unreachable 拼法唯一（guards/fga 共用）", () => {
    expect(outboundTimeoutReason("guards", true)).toBe("guards_timeout");
    expect(outboundTimeoutReason("guards", false)).toBe("guards_unreachable");
    expect(outboundTimeoutReason("fga", true)).toBe("fga_timeout");
  });

  test("timeoutSignal：返回会按时中止的 AbortSignal", async () => {
    const signal = timeoutSignal(30);
    expect(signal).toBeInstanceOf(AbortSignal);
    await new Promise((r) => setTimeout(r, 80));
    expect(signal.aborted).toBe(true);
  });
});

describe("smokeHttpProbe（票 16/17/18/27 四个探针的共同骨架）", () => {
  test("2xx → ok:true", async () => {
    const url = await startServer(200);
    expect(await smokeHttpProbe(url, { timeoutMs: 1000, onUnreachable: () => "down" })).toEqual({ ok: true });
  });

  test("非 2xx + onHttpStatus → ok:false 且原因由调用方文案给（fga/chroma 口径）", async () => {
    const url = await startServer(503);
    const r = await smokeHttpProbe(url, {
      timeoutMs: 1000,
      onHttpStatus: (status) => `openfga /healthz HTTP ${status}`,
      onUnreachable: () => "down",
    });
    expect(r).toEqual({ ok: false, reason: "openfga /healthz HTTP 503" });
  });

  test("非 2xx 但不传 onHttpStatus → 任何回话都算可达（llm 探针口径，行为保持）", async () => {
    const url = await startServer(500);
    expect(await smokeHttpProbe(url, { timeoutMs: 1000, onUnreachable: () => "down" })).toEqual({ ok: true });
  });

  test("不可达 → ok:false + onUnreachable 文案（连不上的口子）", async () => {
    const r = await smokeHttpProbe("http://127.0.0.1:1/healthz", {
      timeoutMs: 1000,
      onUnreachable: () => "容器不可达——真容器冒烟 skip",
    });
    expect(r).toEqual({ ok: false, reason: "容器不可达——真容器冒烟 skip" });
  });

  test("服务挂起 + 短超时 → ok:false（超时也归 onUnreachable：探针只关心「有没有按时回话」）", async () => {
    const url = await startServer(200, 3000);
    const r = await smokeHttpProbe(url, { timeoutMs: 150, onUnreachable: () => "too slow" });
    expect(r).toEqual({ ok: false, reason: "too slow" });
  });
});
