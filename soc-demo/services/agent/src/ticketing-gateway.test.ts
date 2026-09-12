// 票 76 · spec T11/T12 双跑的另一半：真 gateway 腿 + 椒图外接腿（两票制时序不变，
// 铸票通道换真件/外接件）。测试位在 src/ 装配层而非 orchestration/ 机制目录——
// 边界规则 R11：机制目录零铸票客户端 import（边界闸机器把关），铸票客户端
//（HttpMintClient/JiaoTuMintClient）只在装配与它的测试里出场（token-ports.test.ts 同位）。
//
// 真 gateway 腿：子进程起真 services/gateway FastAPI（/internal/mint，testkit
// startCaseBackend 同款「子进程 + 公开面 + 随机端口」纪律；fastapi/uvicorn 不可达
// 显式 skip——compose-topology 探针先例），铸出的票再过真验票闸（scope 内 allow /
// 外 403）。
// 椒图腿：JIAOTU_GATEWAY_URL 开关件（JiaoTuMintClient）下同一两票时序，wire 逐字段
// 断言（token-ports-jiaotu.test.ts 的 mockFetch 捕获口径）——窄票面走外接端口不放宽。
import { afterAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setEventTap } from "./events.js";
import { HttpMintClient } from "./token-ports.js";
import { JiaoTuMintClient } from "./jiaotu/token-ports-jiaotu.js";
import { KEY, makeTaskTicket } from "../workers/triage/testkit.js";
import {
  MENU,
  childMints,
  rig,
  verifyAllows,
} from "./ticketing-rig.js";

afterAll(() => setEventTap(null));

// ---------- T11/T12（真 gateway 腿）：同一时序打真 /internal/mint，票再过真闸 ----------

describe("T11/T12 two_tier_mint_timing（真 gateway 腿：真 /internal/mint + 真验票闸）", () => {
  test("真 gateway 铸出的父票=菜单面、子票=单工具，verifyTicket 按票面裁决", async () => {
    const gw = await startGateway();
    if (gw === null) return; // 环境缺 fastapi/uvicorn：显式 skip（原因见 startGateway）
    try {
      const rig1 = rig(new HttpMintClient(gw.url));
      const { tickets, port, order } = rig1;
      await rig1.launchRound();
      await rig1.waitUntil(() => port.status === "concluded", "两轮收敛（假设 concluded）");
      await rig1.waitAllSettled();
      await rig1.close();

      // 时序面与 fake 腿同构：子票逐任务单工具、在 planner 出组合之后
      expect(childMints(order).length).toBeGreaterThanOrEqual(2);
      for (const c of childMints(order)) {
        expect(c.slice("mint:agent:hunt_task:".length).split("+")).toHaveLength(1);
      }
      const firstPlanner = order.findIndex((o) => o.startsWith("planner:"));
      for (const c of childMints(order)) {
        expect(order.indexOf(c)).toBeGreaterThan(firstPlanner);
      }
      // 真 gateway 票 × 真闸：父票放行全菜单；子票恰放行一个菜单工具、其余全 403
      const parentTickets = tickets.filter((t) => t.kind === "hunt_flow");
      const childTickets = tickets.filter((t) => t.kind === "hunt_task");
      expect(parentTickets.length).toBeGreaterThanOrEqual(1);
      expect(childTickets.length).toBeGreaterThanOrEqual(2);
      for (const tool of MENU) {
        expect(verifyAllows(parentTickets[0]!.ticket, tool, parentTickets[0]!.runId, KEY), tool).toBe(true);
      }
      for (const c of childTickets) {
        const allowed = MENU.filter((tool) => verifyAllows(c.ticket, tool, c.runId, KEY));
        expect(allowed, "子票恰放行一个菜单工具").toHaveLength(1);
        for (const tool of MENU) {
          if (tool === allowed[0]) continue;
          expect(verifyAllows(c.ticket, tool, c.runId, KEY), `${tool} 不在子票面`).toBe(false);
        }
      }
    } finally {
      await gw.close();
    }
  }, 60000);
});

// ---------- 椒图形态：外接开关件下两票时序不变，窄票面走外接 wire ----------

describe("椒图狗粮形态（JIAOTU_GATEWAY_URL 开关件）：两票走外接铸票端口", () => {
  test("JiaoTuMintClient 通道：父票/子票 wire 逐字段（agent_identity/allowed_tools 单工具）", async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const jiaotu = new JiaoTuMintClient({
      baseUrl: "http://jiaotu-stub:8080",
      apiKey: "jt-key-76",
      fetchImpl: (async (url: unknown, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        seen.push({ url: String(url), headers, body });
        const tools = (body.allowed_tools as string[]) ?? [];
        const sub = String(body.agent_identity ?? "");
        return new Response(
          JSON.stringify({
            token: makeTaskTicket(`run_${String(body.jti)}`, tools, { sub, caseId: String(body.case_id ?? ""), jti: String(body.jti) }),
            jti: body.jti,
            exp: Math.floor(Date.now() / 1000) + 900,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const rig1 = rig(jiaotu);
    const { order, port } = rig1;
    await rig1.launchRound();
    await rig1.waitUntil(() => port.status === "concluded", "两轮收敛（假设 concluded）");
    await rig1.waitAllSettled();
    await rig1.close();

    // 同一两票时序：父票一枚于 run 起、子票逐任务单工具于 dispatch
    const children = childMints(order);
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const c of children) expect(c.slice("mint:agent:hunt_task:".length).split("+")).toHaveLength(1);
    // 外接 wire：POST /internal/tickets/mint + Bearer api_key；子票 agent_identity=agent:hunt_task
    const childWires = seen.filter((s) => s.body.agent_identity === "agent:hunt_task");
    expect(childWires).toHaveLength(children.length);
    for (const w of childWires) {
      expect(w.url).toBe("http://jiaotu-stub:8080/internal/tickets/mint");
      expect(w.headers.authorization).toBe("Bearer jt-key-76");
      expect((w.body.allowed_tools as string[])).toHaveLength(1); // narrow-scope 走外接端口不放宽
    }
  });
});

// ---------- 真 gateway 子进程（testkit startCaseBackend 同款「子进程 + 正门 + 随机端口」） ----------

interface GatewayProc {
  url: string;
  close(): Promise<void>;
}

/** 起真 services/gateway FastAPI（uvicorn 子进程 + fixtures 契约测试密钥）。
 *  fastapi/uvicorn 不可达 → 返回 null（显式 skip，不静默不误报——compose-topology 探针先例）。 */
async function startGateway(): Promise<GatewayProc | null> {
  const SOC_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
  let py: string | null = null;
  for (const c of [join(SOC_ROOT, ".venv/bin/python"), "python3"]) {
    const probe = spawn(c, ["-c", "import fastapi, uvicorn"], { stdio: "ignore" });
    const ok = await new Promise<boolean>((resolve) => {
      probe.on("error", () => resolve(false));
      probe.on("exit", (code) => resolve(code === 0));
    });
    if (ok) {
      py = c;
      break;
    }
  }
  if (py === null) {
    console.warn("[票 76 真 gateway 腿 skip] fastapi/uvicorn 不可达——fake 腿已覆盖时序，真机验证归 scripts/gateway-smoke-12.sh");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "soc-gw-76-"));
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => (p ? resolve(p) : reject(new Error("no free port"))));
    });
    srv.on("error", reject);
  });
  const child = spawn(py, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: join(SOC_ROOT, "services", "gateway"),
    env: { ...process.env, SOC_HMAC_KEY: KEY, SOC_LLM_UPSTREAM: "http://127.0.0.1:1", SECRETS_LLM_API_KEY: "" },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) break;
    } catch {
      /* 还没起来，继续等 */
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
      throw new Error("真 gateway 子进程起不来（20s 超时）");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        child.on("exit", () => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
