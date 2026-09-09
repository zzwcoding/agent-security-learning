import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb, type DB } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { createRun, transitionRun } from "./runs.js";
import { emitEvent } from "./events.js";
import { decideApproval } from "./approvals.js";
import { resumeRun, type FlowNode } from "./graph.js";
import {
  HttpTokenBurner,
  HttpUsedTokenReader,
  type MintClient,
  type MintRequest,
  type UsedTokenReader,
} from "./token-ports.js";
import { MemoryBurnRegistry, paramsHash } from "./verify-ticket.js";
import { httpJson, startCaseBackend } from "../workers/triage/testkit.js";
import { waitForRunStatus, waitForRunTerminal } from "./testkit.js";

function makeApp(over: { db?: DB; audit?: MemoryAuditSink } = {}) {
  const db = over.db ?? openDb(":memory:");
  const audit = over.audit ?? new MemoryAuditSink();
  const app = buildApp({ db, audit, dispatcher: { intervalMs: 5 } });
  return { db, audit, app };
}

// ---------- POST /internal/runs（m3 卡公开接口）----------

test("GET /healthz 返回 200 与服务名", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true, service: "agent" });
  await app.close();
});

test("POST /internal/runs {kind, alert_id} → 202 {run_id, status:queued}；等终态后薄径 run completed", async () => {
  const { db, app } = makeApp();
  const res = await app.inject({
    method: "POST",
    url: "/internal/runs",
    payload: { kind: "alert_flow", alert_id: "al-5712" },
  });
  expect(res.statusCode).toBe(202);
  expect(res.json().run_id).toMatch(/^run_/);
  // 票 47 时序契约：POST 落 queued 即秒回，不再同步跑完（执行移交后台分发循环）
  expect(res.json().status).toBe("queued");
  expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(res.json().run_id))
    .toMatchObject({ status: "queued" });

  // 等终态：消费循环捡起后 queued→running→completed，无人干预跑完（薄径）
  const done = await waitForRunTerminal(db, res.json().run_id as string);
  const row = db.prepare("SELECT status, kind, alert_id FROM runs WHERE id = ?").get(
    res.json().run_id,
  ) as { status: string; kind: string; alert_id: string };
  expect(done.status).toBe("completed");
  expect(row).toEqual({ status: "completed", kind: "alert_flow", alert_id: "al-5712" });
  await app.close();
});

test.each([
  // 票 17：kind 分两个入口（alert_flow 吃 alert_id / knowledge_flow 吃 case_id），
  // 错误码随之拆细——缺 kind 与缺入口参数分开报。
  // 票 18：chat_flow 已进白名单（吃 case_id+message，另有 message_required 校验），
  // 「未知 kind」样例换成永不入册的名字。
  // 票 36：case_flow 进白名单（吃 case_id，与 knowledge_flow 同口径）。
  ["缺 kind", { alert_id: "al-1" }, "kind_required"],
  ["缺 alert_id", { kind: "alert_flow" }, "kind_and_alert_id_required"],
  ["未知 kind", { kind: "nope_flow", alert_id: "al-1" }, "unknown_kind"],
  ["case_flow 缺 case_id", { kind: "case_flow" }, "case_id_required"],
])("%s → 400", async (_label, payload, error) => {
  const { app } = makeApp();
  const res = await app.inject({ method: "POST", url: "/internal/runs", payload });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe(error);
  await app.close();
});

// ---------- GET /api/v1/events/stream（SSE，INV-7）----------

describe("SSE 流端点", () => {
  test("缺 run_id → 400；未知 run → 404（都是 JSON 错误，流开始前）", async () => {
    const { app } = makeApp();
    const noId = await app.inject({ method: "GET", url: "/api/v1/events/stream" });
    expect(noId.statusCode).toBe(400);
    expect(noId.json().error).toBe("run_id_required");

    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/events/stream?run_id=run_nope",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("not_found");
    await app.close();
  });

  test("Last-Event-ID 补发端到端：真端口 SSE，从游标后逐条补齐、wire 格式正确、终态收流", async () => {
    const { db, app } = makeApp();
    // 手工布景：一个已完成的 run + 3 条事件（真 run 的执行细节在 graph/envelope 单测锁）
    const sseCtx = { audit: new MemoryAuditSink(), requestId: "req-sse" };
    const run = createRun(db, { kind: "alert_flow", alertId: "al-1" }, sseCtx);
    transitionRun(db, run.id, "running", sseCtx);
    transitionRun(db, run.id, "completed", sseCtx); // 开到终态，服务端才会收流
    const e1 = emitEvent(db, run.id, "node_enter", { node: "intake" });
    const e2 = emitEvent(db, run.id, "node_exit", { node: "intake" });
    emitEvent(db, run.id, "audit", { action: "update" });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    // 客户端收到过 e1，断线重连带 Last-Event-ID → 恰好补 e2、e3
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/events/stream?run_id=${run.id}`, {
      headers: { "last-event-id": String(e1.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text(); // run 已终态 → 服务端收流，fetch 能读完整
    const blocks = text.split("\n\n").filter((b) => b.trim());
    expect(blocks).toHaveLength(2);
    const parsed = blocks.map((b) => {
      const lines = b.split("\n");
      return {
        id: Number(lines.find((l) => l.startsWith("id:"))?.slice(4)),
        event: lines.find((l) => l.startsWith("event:"))?.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data:"))?.slice(6) ?? "{}"),
      };
    });
    expect(parsed.map((p) => p.id)).toEqual([e2.id, e2.id + 1]); // 不丢不重、严格递增
    expect(parsed.map((p) => p.event)).toEqual(["node_exit", "audit"]);
    expect(parsed[0].data).toMatchObject({ type: "node_exit", run_id: run.id, node: "intake" });

    // 游标已到末尾：200 + 空流（EventSource 挂着等新事件；终态则立刻收流）
    const caught = await fetch(
      `http://127.0.0.1:${port}/api/v1/events/stream?run_id=${run.id}`,
      { headers: { "last-event-id": String(e2.id + 1) } },
    );
    expect(caught.status).toBe(200);
    expect(await caught.text()).toBe("");
    await app.close();
  });
});

// ---------- 焚毁表跨进程读口（票 34：G2-1 遗留清偿，INV-2 生产接通）----------
//
// 票 11 遗留：BurnRegistry seam 是进程内同步读口，生产 used 不传（闸不查焚毁表），
// 跨进程 ApprovalToken 重放只靠 executed_at 单次执行 + 300s TTL 兜底。本票接通：
// usedReader（M2 GET /internal/used-tokens/:jti）在进闸前把跨进程焚毁真相装给闸
// ——闸本体保持同步（票 07 契约 + interrupt 同步抛出契约都不动）。
// 测试形态 = 票 30「子进程起真 case-backend」× 票 11「两个全新 buildApp 实例」：
// 实例 A/B 各持独立内存库（互为陌生进程），唯一共享真相是真 case-backend 的 used_tokens；
// 跨服务零源码 import，全走公开 REST（边界规则 R1）。

const CONTRACT = JSON.parse(
  readFileSync(new URL("../../../fixtures/tickets/contract.json", import.meta.url), "utf8"),
) as { hmac_key: { value: string } };
const LIVE_KEY = CONTRACT.hmac_key.value;

// 带一个 L2 动作的最小图（approval-loop.test.ts l2Flow 同款精简）：execute_action 过闸执行。
// async 节点先例 = knowledge flow 的 kb_write（票 17/23 后 interrupt 在 async 节点同样同步抛出）。
function leakFlow(executions: Record<string, unknown>[]): FlowNode[] {
  return [
    { name: "response_advice", run: (ctx) => { ctx.state.ready = true; } },
    {
      name: "execute_action",
      run: async (ctx) => {
        ctx.state.execution = await ctx.executeApproved(
          "isolate_host",
          { host: "centos7" },
          { reason: "票 34 跨进程布景" },
          (p) => {
            const q = p as { host: string };
            executions.push({ host: q.host });
            return { mock_edr: "isolated", host: q.host };
          },
        );
      },
    },
  ];
}

// 可预测 jti 的假铸票（审批票）：闸验签只认 KEY 一致 + wire 形同 fixtures/tickets 契约，
// jti 序列化在本测试内自增——「往本地表预烧哪枚票」的测试要提前知道 jti。
function makeSequencedMint(over: { iatShift?: number } = {}) {
  const calls: { jti: string }[] = [];
  let seq = 0;
  const client: MintClient = {
    async mintApprovalToken(req: MintRequest) {
      const jti = `ap_t34_${String(++seq).padStart(3, "0")}`;
      calls.push({ jti });
      const iat = Math.floor(Date.now() / 1000) + (over.iatShift ?? 0);
      const payload = {
        jti,
        approval_id: req.approvalId,
        approved_by: req.approvedBy,
        tool: req.tool,
        params_hash: paramsHash(req.params),
        case_id: req.caseId ?? "",
        iat,
        exp: iat + 300,
        used: false,
      };
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const b64p = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = createHmac("sha256", Buffer.from(LIVE_KEY, "utf8")).update(`${header}.${b64p}`).digest("hex");
      return { token: `${header}.${b64p}.${sig}`, payload };
    },
    async mintTaskTicket() {
      throw new Error("mintTaskTicket not expected in this test");
    },
  };
  return { client, calls };
}

// 拉起 L2 run（挂起在审批处）并取 pending 卡。票 47 时序：POST 秒回后由分发循环
// 异步执行，挂起态要等（等不到 = 执行链路坏了，测试就该红）
async function startSuspendedRun(app: ReturnType<typeof buildApp>, db: DB): Promise<{ runId: string; cardId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/internal/runs",
    payload: { kind: "alert_flow", alert_id: "al-t34" },
  });
  expect(res.statusCode).toBe(202);
  const runId = res.json().run_id as string;
  await waitForRunStatus(db, runId, "awaiting_approval");
  const card = (
    (await app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" })).json() as {
      approvals: { id: string }[];
    }
  ).approvals[0];
  return { runId, cardId: card.id };
}

// fire-and-forget 烧票登记落库的时序兜底：轮询真 M2 直到该 jti 可查（5s 封顶）
async function waitForBurned(base: string, jti: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { status } = await httpJson(base, "GET", `/internal/used-tokens/${jti}`);
    if (status === 200) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`used_tokens 未落库：${jti}`);
}

describe("焚毁表跨进程读口（票 34·INV-2）", () => {
  test("跨进程重放：实例 A 执行过的 ApprovalToken，实例 B（陌生进程）再执行必 403 token_used", async () => {
    const cb = await startCaseBackend();
    try {
      const reader = new HttpUsedTokenReader(cb.url);
      // —— 实例 A：生产装配形态（burn = M2 登记、usedReader = M2 读口、无本地焚毁表）——
      const dbA = openDb(":memory:");
      const execA: Record<string, unknown>[] = [];
      const mintA = makeSequencedMint();
      const appA = buildApp({
        db: dbA,
        audit: new MemoryAuditSink(),
        nodes: leakFlow(execA),
        mint: mintA.client,
        burn: new HttpTokenBurner(cb.url),
        usedReader: reader,
        hmacKey: LIVE_KEY,
      });
      const { cardId: cardA } = await startSuspendedRun(appA, dbA);
      const apr = await appA.inject({
        method: "POST",
        url: `/api/v1/approvals/${cardA}/approve`,
        payload: { approver: "duty_lead" },
      });
      expect(apr.statusCode).toBe(200);
      // 票 47 时序契约：批准秒回（resume 还在队列里），等终态后再取证
      expect(apr.json().run_status).toBe("awaiting_approval");
      await waitForRunTerminal(dbA, apr.json().run_id as string);
      const leaked = apr.json().approval_token as string; // ← 泄露面：审批响应里的票
      const jti = mintA.calls[0]!.jti;
      await waitForBurned(cb.url, jti); // jti 已进真 M2 used_tokens
      await appA.close(); // 实例 A 进程消失——它的一切进程内状态对 B 不可见

      // —— 实例 B：全新进程（独立内存库：无本地焚毁记录、无 executed 卡可兜底）——
      const dbB = openDb(":memory:");
      const auditB = new MemoryAuditSink();
      const execB: Record<string, unknown>[] = [];
      const appB = buildApp({
        db: dbB,
        audit: auditB,
        nodes: leakFlow(execB),
        mint: makeSequencedMint().client,
        burn: new HttpTokenBurner(cb.url),
        usedReader: reader,
        hmacKey: LIVE_KEY,
      });
      const { runId: runB, cardId: cardB } = await startSuspendedRun(appB, dbB);
      // 泄露票进场：卡被塞进实例 A 铸的同一枚票（INV-9：闸只信票本身，闸无从知晓审批来源）
      decideApproval(dbB, cardB, {
        approve: true, approver: "attacker", token: leaked, tokenJti: jti,
      }, { audit: auditB, requestId: "req-t34", actor: { type: "user", id: "attacker" } });
      await resumeRun(dbB, runB, {
        nodes: leakFlow(execB),
        audit: auditB,
        requestId: "req-t34",
        usedReader: reader,
        hmacKey: LIVE_KEY,
      });

      // 唯一能拦住它的是 M2 真相：B 本地一切干净，拒了 = 跨进程读口查到了已焚 jti
      expect(dbB.prepare("SELECT status FROM runs WHERE id = ?").get(runB)).toMatchObject({ status: "failed" });
      const deny = auditB.entries.find((e) => e.result === "DENIED");
      expect(deny).toMatchObject({
        action: "deny",
        objectType: "approval",
        objectId: cardB,
        details: { tool: "isolate_host", reason: "token_used" },
      });
      expect(execB).toEqual([]); // 动作没再执行（INV-2 一次性跨进程成立）
      await appB.close();
    } finally {
      await cb.close();
    }
  }, 30_000);

  test("读口不可达 fail-closed：M2 查询失败 → 拒绝执行 + DENIED 审计（INV-1），绝不放行", async () => {
    // 死端口 = M2 不可达。fail-closed 桶名 = signature_invalid（契约 reasons_note：
    // 闸体自身异常的收口名）；关键断言是「拒绝执行」而不是 reason 字面。
    const deadReader = new HttpUsedTokenReader("http://127.0.0.1:1");
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const executions: Record<string, unknown>[] = [];
    const app = buildApp({
      db,
      audit,
      nodes: leakFlow(executions),
      mint: makeSequencedMint().client,
      usedReader: deadReader,
      hmacKey: LIVE_KEY,
    });
    const { cardId } = await startSuspendedRun(app, db);
    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${cardId}/approve`,
      payload: { approver: "duty_lead" },
    });
    expect(apr.statusCode).toBe(200);
    // 票 47 时序契约：批准秒回，等终态后强杀结果可查（强杀不吞错）
    expect(apr.json().run_status).toBe("awaiting_approval");
    await waitForRunTerminal(db, apr.json().run_id as string);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(apr.json().run_id))
      .toMatchObject({ status: "failed" });
    const deny = audit.entries.find((e) => e.result === "DENIED");
    expect(deny).toMatchObject({ action: "deny", objectType: "approval", details: { reason: "signature_invalid" } });
    expect(executions).toEqual([]);
    await app.close();
  });

  test("读口接通不误伤：M2 查无此票（404 未焚）→ 正常审批照常放行执行", async () => {
    const cb = await startCaseBackend();
    try {
      const db = openDb(":memory:");
      const audit = new MemoryAuditSink();
      const executions: Record<string, unknown>[] = [];
      const app = buildApp({
        db,
        audit,
        nodes: leakFlow(executions),
        mint: makeSequencedMint().client,
        burn: new HttpTokenBurner(cb.url),
        usedReader: new HttpUsedTokenReader(cb.url),
        hmacKey: LIVE_KEY,
      });
      const { cardId } = await startSuspendedRun(app, db);
      const apr = await app.inject({
        method: "POST",
        url: `/api/v1/approvals/${cardId}/approve`,
        payload: { approver: "duty_lead" },
      });
      expect(apr.statusCode).toBe(200);
      // 票 47 时序契约：批准秒回，等终态后取证（未焚票一路绿灯）
      expect(apr.json().run_status).toBe("awaiting_approval");
      await waitForRunTerminal(db, apr.json().run_id as string);
      expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(apr.json().run_id))
        .toMatchObject({ status: "completed" });
      expect(executions).toEqual([{ host: "centos7" }]);
      expect(audit.entries.some((e) => e.result === "DENIED")).toBe(false);
      await app.close();
    } finally {
      await cb.close();
    }
  }, 30_000);

  test("读口与本地焚毁表取或：M2 未焚但本地表已焚 → 照样 token_used（任一真相命中即拒）", async () => {
    // 合并语义锁：装填是叠加不是替换——既有 MemoryBurnRegistry 测试替身与 M2 读口共存时，
    // 任何一路说「已焚」都必须拒（写反了 = 本地真相被 M2 的 404 屏蔽，重放防线开洞）。
    const fakeM2 = new Map<string, boolean>(); // 恒未焚的假 M2
    const reader: UsedTokenReader = { lookup: async (jti) => fakeM2.get(jti) ?? false };
    const local = new MemoryBurnRegistry();
    local.burn("ap_t34_001"); // 预知首枚 jti（makeSequencedMint 序列）
    const db = openDb(":memory:");
    const audit = new MemoryAuditSink();
    const executions: Record<string, unknown>[] = [];
    const app = buildApp({
      db,
      audit,
      nodes: leakFlow(executions),
      mint: makeSequencedMint().client,
      burn: local,
      used: local,
      usedReader: reader,
      hmacKey: LIVE_KEY,
    });
    const { cardId } = await startSuspendedRun(app, db);
    const apr = await app.inject({
      method: "POST",
      url: `/api/v1/approvals/${cardId}/approve`,
      payload: { approver: "duty_lead" },
    });
    // 票 47 时序契约：批准秒回，等终态后取证
    await waitForRunTerminal(db, apr.json().run_id as string);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(apr.json().run_id))
      .toMatchObject({ status: "failed" });
    expect(audit.entries.find((e) => e.result === "DENIED"))
      .toMatchObject({ details: { reason: "token_used" } });
    expect(executions).toEqual([]);
    await app.close();
  });
});
