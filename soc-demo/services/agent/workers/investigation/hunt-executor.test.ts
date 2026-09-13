import { describe, expect, test } from "vitest";
import { makeHuntTaskFlow } from "../../src/orchestration/task-flow.js";
import { MemoryHuntLedger } from "../../src/orchestration/ledger.js";
import type { OrchestrationDeps, PlannedTask } from "../../src/orchestration/ports.js";
import type { FlowNode, NodeCtx } from "../../src/graph.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { paramsHash } from "../../src/verify-ticket.js";
import { KEY, sealTicket } from "../triage/testkit.js";
import { MemoryWeknoraGraph, WEKNORA_FIXTURES } from "./weknora.js";
import { MemoryPlaybookLibrary } from "./weknora.js";
import { FixtureSiem } from "./siem.js";
import { fileURLToPath } from "node:url";
import { wireHuntTaskExecutor, executeHuntPackTool, summarizeHuntObservation } from "./hunt-executor.js";

// 票 79③''（L0 裁定①）验收主战场：hunt_task 真执行体的换件语义——机制图
//（makeHuntTaskFlow 公开接口）的 execute 节点在装配层被换成真件（m5 plan/decide 执行
// 半边 + 78 executeHuntTool 门 + 79 weknora 三工具），机制目录零改动。换真实现不换
// 调用方：report/intake 节点消费的 observation/params_hash 交接态契约逐字节对齐。

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/alerts/", import.meta.url));
const DAY = { from: "2023-04-25T00:00:00.000Z", to: "2023-04-26T00:00:00.000Z" };
const HYP = "hyp-exec";
const RUN = "run_task_1";

const TASK: PlannedTask = {
  tool: "web_access_query",
  params: { url_pattern: "/uploads/sh.php", time_window: DAY },
  rationale: "按探针 URL 模式查 web 访问异常",
};

/** 机制 hunt_task 图（与生产 makeNodes 同源）+ 簿记先行（dispatch 拉起后的交接态）。 */
function mechanismGraph(orch: OrchestrationDeps, audit: MemoryAuditSink): FlowNode[] {
  return makeHuntTaskFlow({ runId: RUN, orch, audit });
}

function fakeCtx(over: Partial<NodeCtx> = {}): NodeCtx {
  return {
    runId: RUN,
    state: {} as Record<string, unknown>,
    emit: () => {},
    charge: () => {},
    checkLlm: () => {},
    awaitApproval: () => {
      throw new Error("hunt_task 无 L2 通道（INV-3）");
    },
    executeApproved: () => {
      throw new Error("hunt_task 无 L2 通道（INV-3）");
    },
    ...over,
  } as NodeCtx;
}

async function runNode(node: FlowNode, ctx: NodeCtx): Promise<void> {
  await node.run(ctx);
}

function childTicket(tool: string, runId = RUN): string {
  const iat = Math.floor(Date.now() / 1000) - 10;
  return sealTicket({
    jti: `tk_${tool}`,
    sub: "agent:hunt_task",
    case_id: HYP,
    run_id: runId,
    scope: ["case:read"],
    allowed_tools: [tool],
    iat,
    exp: iat + 900,
  });
}

function wiring(over: Record<string, unknown> = {}) {
  return {
    siem: new FixtureSiem(FIXTURES),
    playbook: new MemoryPlaybookLibrary(WEKNORA_FIXTURES),
    graph: new MemoryWeknoraGraph(),
    audit: new MemoryAuditSink(),
    hmacKey: KEY,
    runId: RUN,
    ticket: childTicket(TASK.tool),
    ...over,
  };
}

function orchWith(): OrchestrationDeps {
  const ledger = new MemoryHuntLedger();
  ledger.put({ runId: RUN, role: "task", hypothesisId: HYP, roundNo: 1, parentRunId: "run_parent", task: TASK });
  return {
    ledger,
    bus: { publish: () => {}, subscribe: () => () => {} },
    port: {} as OrchestrationDeps["port"],
    door: { post: async () => RUN },
    templates: { of: () => null },
    llm: {} as OrchestrationDeps["llm"],
  } as OrchestrationDeps;
}

describe("wireHuntTaskExecutor（装配层换件：execute 桩 → 真执行体）", () => {
  test("真执行：验票放行 → executeHuntTool 真查语料 → 观察/计费/报告全链路真值", async () => {
    const audit = new MemoryAuditSink();
    const w = wiring({ audit });
    const nodes = wireHuntTaskExecutor(mechanismGraph(orchWith(), audit), w);
    expect(nodes.map((n) => n.name)).toEqual(["intake", "plan", "execute", "report"]); // 桩形结构不变

    const ctx = fakeCtx();
    for (const n of nodes) await runNode(n, ctx);

    // 真观察（非 stub）：探针 URL 在 fixture 语料命中 1 条，摘要为确定性格式
    const obs = ctx.state.observation as { ok: boolean; summary: string; params_hash: string };
    expect(obs.ok).toBe(true);
    expect(obs.summary).toBe("web_access_query total=1 hits=1");
    expect(obs.params_hash).toBe(paramsHash(TASK.params));
    expect(ctx.state.params_hash).toBe(obs.params_hash);
    // report 节点消费同一摘要（await_children 的 result_summary 引用痕）
    const report = audit.entries.find((e) => e.action === "hunt_task_report");
    expect(report?.details).toMatchObject({ tool: "web_access_query", result_summary: "web_access_query total=1 hits=1" });
    expect(report?.result).toBe("SUCCESS");
  });

  test("weknora 工具走同一执行体（playbook_lookup 真查剧本库）", async () => {
    const audit = new MemoryAuditSink();
    const task: PlannedTask = {
      tool: "playbook_lookup",
      params: { tag: "webshell" },
      rationale: "开局先调剧本库",
    };
    const ledger = new MemoryHuntLedger();
    ledger.put({ runId: RUN, role: "task", hypothesisId: HYP, roundNo: 1, parentRunId: "run_parent", task });
    const orch = { ledger } as unknown as OrchestrationDeps;
    const w = wiring({ audit, ticket: childTicket("playbook_lookup") });
    const nodes = wireHuntTaskExecutor(makeHuntTaskFlow({ runId: RUN, orch, audit }), w);
    const ctx = fakeCtx();
    for (const n of nodes) await runNode(n, ctx);
    expect((ctx.state.observation as { summary: string }).summary).toBe("playbook_lookup total=1 hits=1");
  });

  test("闸拒（票面外工具）：scope_insufficient + DENIED 审计 + 观察不落（fail-closed）", async () => {
    const audit = new MemoryAuditSink();
    const w = wiring({ audit, ticket: childTicket("kb_lookup") }); // 子票不含本任务工具
    const nodes = wireHuntTaskExecutor(mechanismGraph(orchWith(), audit), w);
    const ctx = fakeCtx();
    for (const n of nodes.slice(0, 2)) await runNode(n, ctx); // intake/plan 照常
    await expect(runNode(nodes[2]!, ctx)).rejects.toThrow("hunt_task_gate_denied:scope_insufficient");
    expect(ctx.state.observation).toBeUndefined();
    const deny = audit.entries.find((e) => e.action === "deny");
    expect(deny?.result).toBe("DENIED");
    expect(deny?.details).toMatchObject({ tool: TASK.tool, reason: "scope_insufficient", node: "execute" });
  });

  test("闸拒（L1 register 无票）：403 no_ticket 语义，写动作到不了 store（INV-1/8）", async () => {
    const graph = new MemoryWeknoraGraph();
    const audit = new MemoryAuditSink();
    const task: PlannedTask = {
      tool: "hypothesis_register",
      params: { hypothesis_id: HYP, verdict: "miss", confidence: 0.8, evidence_hashes: ["sha256:x"] },
      rationale: "收敛归档步",
    };
    const ledger = new MemoryHuntLedger();
    ledger.put({ runId: RUN, role: "task", hypothesisId: HYP, roundNo: 1, parentRunId: "run_parent", task });
    const orch = { ledger } as unknown as OrchestrationDeps;
    // 类型谎言注入口径（planner.test 坏形注入同款）：无票 = creds.ticket 为 undefined
    const w = wiring({ audit, graph, ticket: undefined as unknown as string });
    const nodes = wireHuntTaskExecutor(makeHuntTaskFlow({ runId: RUN, orch, audit }), w);
    const ctx = fakeCtx();
    for (const n of nodes.slice(0, 2)) await runNode(n, ctx);
    await expect(runNode(nodes[2]!, ctx)).rejects.toThrow("hunt_task_gate_denied:no_ticket");
    expect(graph.entries).toHaveLength(0); // 写动作被闸在 store 之外（fail-closed）
  });

  test("签名违约不执行（契约先行于闸与后端）：缺 time_window 直接 fail-closed", async () => {
    const w = wiring();
    await expect(
      executeHuntPackTool(w, "web_access_query", { url_pattern: "/x" }),
    ).rejects.toThrow("hunt_tool_signature:time_window_required");
    await expect(executeHuntPackTool(w, "siem_query", {})).rejects.toThrow("unreachable_tool:siem_query");
  });

  test("取消信号前置检查保留（T10：换件不丢停止链）", async () => {
    const { CancelBoard } = await import("../../src/orchestration/cancel.js");
    const board = new CancelBoard();
    board.cancel(HYP, { reason: "user_cancelled", source: "user", at: 1 });
    const audit = new MemoryAuditSink();
    const w = wiring({ audit, cancelBoard: board });
    const nodes = wireHuntTaskExecutor(mechanismGraph(orchWith(), audit), w);
    const ctx = fakeCtx({ state: { case_id: HYP } as Record<string, unknown> });
    await expect(runNode(nodes[2]!, ctx)).rejects.toThrow(/cancel/i);
  });
});

describe("summarizeHuntObservation（judge 引用痕的确定性格式）", () => {
  test("查询类 total/hits 与 register proposal 痕", () => {
    expect(summarizeHuntObservation("outbound_conn_query", { total: 3, hits: [1, 2, 3] })).toBe(
      "outbound_conn_query total=3 hits=3",
    );
    expect(
      summarizeHuntObservation("hypothesis_register", { hypothesis_id: "hyp-1", status: "proposed" }),
    ).toBe("hypothesis_register proposal=hyp-1 status=proposed");
    expect(summarizeHuntObservation("no_shape_tool", null)).toBe("no_shape_tool ok");
  });
});
