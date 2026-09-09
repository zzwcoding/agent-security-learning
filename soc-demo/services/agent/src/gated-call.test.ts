// 票 43·F1：共享验票闸 makeGatedCall 的单测——六处 gated 收敛后的「闸拒长什么样」
// 就锁在这里。票据用真实 wire 串（测试内自铸，签名三段式与 verify-ticket.test.ts
// 的 unseal 同一口径），不 mock 闸本体。
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { makeGatedCall, type GateDenyEntry, type GatedCallDeps } from "./gated-call.js";
import type { NodeCtx } from "./graph.js";

const KEY = "test-hmac-key-gated-call";

/** 测试内自铸任务票（unseal 的逆操作）：payload = TicketClaims 最小集。 */
function mintTaskTicket(claims: {
  jti: string;
  case_id: string;
  run_id: string;
  allowed_tools: string[];
  exp: number;
}): string {
  const payload = { sub: "worker:test", scope: ["task"], iat: claims.exp - 900, ...claims };
  const b64h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b64p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", KEY).update(`${b64h}.${b64p}`, "utf8").digest("hex");
  return `${b64h}.${b64p}.${sig}`;
}

const TICKET = mintTaskTicket({
  jti: "jti-gated-1",
  case_id: "case-1",
  run_id: "run-1",
  allowed_tools: ["get_alert", "kb_lookup"],
  exp: Math.floor(Date.now() / 1000) + 600,
});

/** 最小 NodeCtx 替身：只实现 emit（记账），闸与广播用不到其余能力。 */
function fakeCtx(events: { type: string; payload: Record<string, unknown> }[]): NodeCtx {
  return {
    runId: "run-test",
    state: {},
    emit: (type: string, payload: Record<string, unknown>) => events.push({ type, payload }),
    charge: () => {},
    checkLlm: () => {},
    awaitApproval: () => ({ approved: false, approvalId: "" }),
    executeApproved: () => ({ executed: false, outcome: "rejected", approvalId: "" }),
  } as unknown as NodeCtx;
}

/** 组装被测件 + 观察面（audit 逐条留、事件按序留）。over 覆盖差异点声明。 */
function makeHarness(over: Partial<GatedCallDeps> = {}) {
  const audit: GateDenyEntry[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const deps: GatedCallDeps = {
    prefix: "testflow",
    hmacKey: KEY,
    creds: () => ({ ticket: TICKET, runId: "run-1", caseId: "case-1" }),
    deny: () => ({
      record: (entry) => audit.push(entry),
      objectId: "run-1",
      objectType: "tool_call",
      extraDetails: { node: "verdict_llm" },
    }),
    emitToolCall: (ctx, { tool, paramsHash: hash }) =>
      ctx.emit("tool_call", { node: "verdict_llm", tool, params_hash: hash }),
    emitToolResult: (ctx, { tool }) => ctx.emit("tool_result", { node: "verdict_llm", tool, ok: true }),
    ...over,
  };
  return { audit, events, gated: makeGatedCall(deps), ctx: fakeCtx(events) };
}

describe("makeGatedCall（票 43·F1：闸拒审计与错误拼法的唯一定义处）", () => {
  test("放行路径：tool_call → action → tool_result 顺序广播，返回 action 结果", async () => {
    const { gated, events, ctx } = makeHarness();
    const r = await gated(ctx, "get_alert", { alert_id: "a-1" }, async () => ({ id: "a-1", ok: true }));
    expect(r).toEqual({ id: "a-1", ok: true });
    expect(events.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect(events[0].payload).toMatchObject({ node: "verdict_llm", tool: "get_alert" });
    expect(String(events[0].payload.params_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(events[1].payload).toEqual({ node: "verdict_llm", tool: "get_alert", ok: true });
  });

  test("闸拒路径：scope 外工具 → DENIED 审计（details 含 tool/reason/params_hash/node）+ 前缀化抛错", async () => {
    const { gated, audit, events, ctx } = makeHarness();
    const err = await gated(ctx, "close_alert", { alert_id: "a-1" }, async () => ({ hacked: true }))
      .catch((e: unknown) => e);
    // INV-1 fail-closed：不执行、不广播放行事件
    expect((err as Error).message).toBe("testflow_gate_denied:scope_insufficient");
    expect(events).toEqual([]);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("deny");
    expect(audit[0].result).toBe("DENIED");
    expect(audit[0].objectId).toBe("run-1");
    expect(audit[0].objectType).toBe("tool_call");
    expect(audit[0].details).toMatchObject({
      tool: "close_alert",
      reason: "scope_insufficient",
      node: "verdict_llm",
    });
    expect(String(audit[0].details.params_hash)).toMatch(/^sha256:/);
  });

  test("差异点①前缀可参数化（六处前缀各异是收敛动机）", async () => {
    const h = makeHarness({ prefix: "investigation" });
    const err = await h.gated(h.ctx, "nope", {}, async () => ({})).catch((e: unknown) => e);
    expect((err as Error).message).toBe("investigation_gate_denied:scope_insufficient");
  });

  test("差异点③凭据进闸：run 绑定不匹配 → scope_insufficient（票面只对本 run 有效）", async () => {
    // creds 报了另一个 runId，票面 run_id=run-1 → 闸按 run 绑定拒（FR-S2.2 同族）
    const h = makeHarness({ creds: () => ({ ticket: TICKET, runId: "run-other" }) });
    const err = await h.gated(h.ctx, "get_alert", { alert_id: "a-1" }, async () => ({}))
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("testflow_gate_denied:scope_insufficient");
    expect(h.audit[0]?.details.reason).toBe("scope_insufficient");
  });

  test("审批变体（graph executeApproved 形态）：不传 emit 钩子 = 只验票+闸拒；onAllow 交出 jti", async () => {
    const seenCreds: unknown[] = [];
    const h_audit: GateDenyEntry[] = [];
    let jti = "";
    const h = makeHarness({
      creds: (tool, params) => {
        seenCreds.push({ tool, params });
        return { ticket: TICKET, runId: "run-1", caseId: "case-1" };
      },
      deny: () => ({
        record: (entry) => h_audit.push(entry),
        objectId: "approval-1",
        objectType: "approval",
      }),
      emitToolCall: undefined,
      emitToolResult: undefined,
      onAllow: (v) => {
        jti = (v.payload as { jti: string }).jti;
      },
    });
    const r = await h.gated(h.ctx, "get_alert", { alert_id: "a-1" }, async () => ({ done: true }));
    // 事件广播完全交给调用方（审批变体的 tool_call 在验票前自发，顺序不许并）
    expect(h.events).toEqual([]);
    expect(r).toEqual({ done: true });
    expect(jti).toBe("jti-gated-1");
    expect(seenCreds).toEqual([{ tool: "get_alert", params: { alert_id: "a-1" } }]);
    expect(h_audit).toHaveLength(0);
  });

  test("闸拒不吞错：action 根本不被调用（闸在执行之前）", async () => {
    const { gated, ctx } = makeHarness();
    let ran = false;
    await gated(ctx, "close_alert", {}, async () => {
      ran = true;
      return {};
    }).catch(() => undefined);
    expect(ran).toBe(false);
  });
});
