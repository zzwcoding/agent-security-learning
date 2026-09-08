import type { Server } from "node:http";
import { createServer } from "node:http";
import { afterAll, describe, expect, test } from "vitest";
import { DEFAULT_TIMEOUT_MS, scanInjection } from "./guards-client.js";

// 本地假 guards：按路径回契约 JSON；slow 模式挂起 3s 触发超时
function startGuards(behavior: "ok" | "slow", respond: object): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (behavior === "slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(respond));
        }, 3000);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(respond));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const allow = { is_injection: false, score: 0, scanner: "PromptInjection", action: "allow" };
const block = {
  is_injection: true, score: 1, scanner: "PromptInjection",
  action: "block", hits: [{ family: "instruction_override", count: 1 }],
};

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function withServer(behavior: "ok" | "slow", respond: object, fn: (url: string) => Promise<void>) {
  const server = await startGuards(behavior, respond);
  servers.push(server);
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  await fn(url);
}

describe("guards 客户端（调用方 fail-closed，INV-1）", () => {
  test("默认超时 2s（PRD S3：扫描超时默认 2s）", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(2000);
  });

  test("绿路：服务可用且 allow → 放行", async () => {
    await withServer("ok", allow, async (url) => {
      const d = await scanInjection("normal log line", "alert_field", { baseUrl: url });
      expect(d).toEqual({ blocked: false, action: "allow", score: 0 });
    });
  });

  test("服务判定 block → 不进 prompt", async () => {
    await withServer("ok", block, async (url) => {
      const d = await scanInjection("evil", "alert_field", { baseUrl: url });
      expect(d.blocked).toBe(true);
      expect(d.action).toBe("block");
    });
  });

  test("服务不可达 → fail_closed 拒绝（不可信段不进 prompt，转人工由调用方处置）", async () => {
    const d = await scanInjection("whatever", "alert_field", {
      baseUrl: "http://127.0.0.1:1", // closed port
    });
    expect(d.blocked).toBe(true);
    expect(d.action).toBe("fail_closed");
    expect(d.reason).toBe("guards_unreachable");
  });

  test("扫描超时 → 与不可达同处理（PRD S3 异常与边界）", async () => {
    await withServer("slow", allow, async (url) => {
      const d = await scanInjection("whatever", "alert_field", { baseUrl: url, timeoutMs: 200 });
      expect(d.blocked).toBe(true);
      expect(d.action).toBe("fail_closed");
      expect(d.reason).toBe("guards_timeout");
    });
  });

  test("降级模式 GUARDS_FAIL_MODE=flag：不可达仅标记不拦截（演示可切）", async () => {
    const d = await scanInjection("whatever", "alert_field", {
      baseUrl: "http://127.0.0.1:1",
      failMode: "flag",
    });
    expect(d.blocked).toBe(false);
    expect(d.action).toBe("flag");
  });
});
