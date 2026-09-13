import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JIAOTU_WORKERS, jiaotuWorkerEnvKey, type JiaotuWorker } from "./llm-client.js";
import { RUN_KIND_IDS, requireRunKind, runKindOf, workerLlmClient, type RunKindGraphDeps } from "./run-kinds.js";
import type { RunRow } from "./runs.js";
import { MemoryAuditSink } from "./audit.js";
import { MemoryKb } from "../workers/triage/kb.js";
import { MemoryVectorStore } from "../workers/knowledge/vector-store.js";
import { FixtureSiem } from "../workers/investigation/siem.js";
import { FixtureAnalyzerTable } from "../workers/enrichment/analyzers.js";
import { INVESTIGATION_TOOLS } from "../workers/investigation/prompt.js";
import { ENRICHMENT_TOOLS } from "../workers/enrichment/tools.js";
import { CHAT_READONLY_TOOLS } from "../workers/chat/flow.js";

// 票 44：run kind 描述符注册表的完整性闸。注册表是 kind 知识的唯一事实来源——
// 原 RUN_KINDS / CASE_KINDS / TICKET_SPECS 三张平行表与 index.ts makeNodes 分支的
// 一致性不再靠人肉同步，而由本文件咬死：新 kind 注册后，票面/拉起实体/图工厂/
// 预置骨架要么都在注册表一格里齐全，要么这里红。

const L2_TOOLS = ["isolate_host", "block_ip", "kb_write", "deisolate_host", "unblock_ip"];

const runRow = (kind: string): RunRow => ({
  id: "run-registry",
  kind,
  alertId: "al-registry",
  caseId: null,
  hypothesisId: null,
  status: "running",
  failReason: null,
  steps: 0,
  tokensUsed: 0,
  createdAt: 0,
  updatedAt: 0,
});

/** 组合根替身：真 adapter 构造不碰网络（HTTP 出站都在 run 执行期），伪 LLM 确定性。 */
const DEPS: RunKindGraphDeps = {
  audit: new MemoryAuditSink(),
  kb: new MemoryKb(),
  kbStore: new MemoryVectorStore(),
  siem: new FixtureSiem(fileURLToPath(new URL("../../../fixtures/alerts/", import.meta.url))),
  analyzers: new FixtureAnalyzerTable(fileURLToPath(new URL("../../../fixtures/ti/", import.meta.url))),
  fga: async () => ({ allowed: false, reason: "registry_test_stub" }),
  llmMode: "fake",
};

describe("run kind 注册表完整性（票 44：一处注册处处消费）", () => {
  test("在册 kind 全集 = 七个（fail-closed 名单快照；新增 kind 先进注册表，本名单随之更新）", () => {
    expect(RUN_KIND_IDS).toEqual([
      "alert_flow", "knowledge_flow", "chat_flow", "case_flow", "close_flow", "hunt_flow", "hunt_task",
    ]);
  });

  test("每个 kind 三件套齐全：intake 合法 / 票面齐全 / 图工厂在位（三张平行表一致性由单源保证）", () => {
    for (const id of RUN_KIND_IDS) {
      const desc = requireRunKind(id);
      expect(["alert", "case", "hypothesis"], `${id} intake`).toContain(desc.intake);
      expect(desc.ticket.sub, `${id} ticket.sub`).toMatch(/^agent:/);
      expect(desc.ticket.scope.length, `${id} ticket.scope`).toBeGreaterThan(0);
      expect(desc.ticket.allowedTools.length, `${id} ticket.allowedTools`).toBeGreaterThan(0);
      expect(desc.makeGraph, `${id} 图工厂`).toBeTypeOf("function");
    }
    // 不在册的 kind 查无此人（fail-closed：拉起口 400 unknown_kind 的依据）
    expect(runKindOf("nope_flow")).toBeUndefined();
    expect(() => requireRunKind("nope_flow")).toThrow(/未注册/);
  });

  test("INV-3：所有票面 allowedTools 无任何 L2 工具（票面永不含 L2，L2 走审批卡 ApprovalToken）", () => {
    for (const id of RUN_KIND_IDS) {
      const { allowedTools } = requireRunKind(id).ticket;
      expect(allowedTools.filter((t) => L2_TOOLS.includes(t)), `${id} allowedTools × L2`).toEqual([]);
    }
  });

  test("票面字段逐字保持（票 36/39 语义不动：三族并集、最小票、只读四件）", () => {
    // alert_flow = 分诊 ∪ 调查 ∪ 富化三个 L1 工具族的并集（票 36）
    const alertTicket = requireRunKind("alert_flow").ticket;
    expect(alertTicket.sub).toBe("agent:triage");
    expect(alertTicket.scope).toEqual(["alert:update", "case:write"]);
    const union = [...new Set([...INVESTIGATION_TOOLS, ...ENRICHMENT_TOOLS])];
    for (const tool of union) expect(alertTicket.allowedTools).toContain(tool);
    // case_flow = 调查 ∪ 富化两族并集，恰好等于并集（不多不少）
    expect(requireRunKind("case_flow").ticket.allowedTools).toEqual(union);
    // chat_flow = 只读四件（FR-M8.4）
    expect(requireRunKind("chat_flow").ticket.allowedTools).toEqual([...CHAT_READONLY_TOOLS]);
    // close_flow = 一键确认关单的最小票（票 39）
    expect(requireRunKind("close_flow").ticket).toEqual({
      sub: "agent:triage",
      scope: ["alert:update"],
      allowedTools: ["get_alert", "close_alert"],
    });
    // knowledge_flow = 提炼面（票 17）
    expect(requireRunKind("knowledge_flow").ticket.scope).toEqual(["case:read", "kb:propose"]);
  });

  test("intake / requiresMessage 口径（票 17/18/36/39 原样；hunt 两 kind 票 90 正名吃 hypothesis_id）", () => {
    expect(requireRunKind("alert_flow").intake).toBe("alert");
    expect(requireRunKind("close_flow").intake).toBe("alert");
    for (const id of ["knowledge_flow", "chat_flow", "case_flow"]) {
      expect(requireRunKind(id).intake).toBe("case");
    }
    // 票 90：hunt 两 kind 拉起实体 = hypothesis_id 专用列（case_id 位承载清偿，旧口径 case 位不再参与）
    for (const id of ["hunt_flow", "hunt_task"]) {
      expect(requireRunKind(id).intake).toBe("hypothesis");
    }
    // 只有 chat_flow 拉起必须带 message（没消息就没有图可跑）
    for (const id of RUN_KIND_IDS) {
      expect(requireRunKind(id).requiresMessage ?? false, `${id} requiresMessage`).toBe(id === "chat_flow");
    }
  });

  test("票 73：hunt 两 kind 不进 fixtures flow_nodes 契约锁（节点从 node_enter 动态发现）", () => {
    for (const id of ["hunt_flow", "hunt_task"]) {
      expect(requireRunKind(id).pipelineNodes).toBeUndefined();
    }
  });

  test("预置骨架节点清单 ≡ fixtures/sse-events.json flow_nodes（票 31 先例：web 侧闸在 pipeline.test.ts）", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../fixtures/sse-events.json", import.meta.url), "utf8"),
    ) as { flow_nodes: Record<string, string[]> };
    const registryNodes = RUN_KIND_IDS.filter((id) => requireRunKind(id).pipelineNodes !== undefined);
    // 双向锁：注册表有骨架的 kind 与样品的键集合一致，名单逐字一致——谁单方面改必红
    expect(registryNodes).toEqual(Object.keys(fixture.flow_nodes));
    for (const id of registryNodes) {
      expect([...requireRunKind(id).pipelineNodes!]).toEqual(fixture.flow_nodes[id]);
    }
  });

  test("图工厂产出的交接节点与注册表骨架自洽（makeNodes 与节点清单同一来源，票 36 链序原样）", () => {
    const caseNodes = requireRunKind("case_flow").makeGraph!(DEPS)(runRow("case_flow"), "tk-registry") as {
      name: string;
    }[];
    expect(caseNodes.map((n) => n.name)).toEqual([...requireRunKind("case_flow").pipelineNodes!]);

    const alertNodes = requireRunKind("alert_flow").makeGraph!(DEPS)(runRow("alert_flow"), "tk-registry") as {
      name: string;
    }[];
    // 分诊六节点（预置骨架）在前，链上两交接节点（case_flow 骨架）在后
    expect(alertNodes.slice(0, 6).map((n) => n.name)).toEqual([...requireRunKind("alert_flow").pipelineNodes!]);
    expect(alertNodes.slice(6).map((n) => n.name)).toEqual([...requireRunKind("case_flow").pipelineNodes!]);
  });
});

// ---------- 票 18（狗粮 Q4 分账）：四 worker real LLM client 的装配契约 ----------

describe("workerLlmClient（票 18：分账装配唯一口，各 worker 出站 Bearer 各吃各的分账键）", () => {
  // env 保存/恢复（llm-client.test.ts 同款纪律：绝不漏出测试进程）
  const savedEnv: Record<string, string | undefined> = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete savedEnv[k];
    }
    vi.unstubAllGlobals();
  });
  const setEnv = (k: string, v: string | undefined): void => {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  /** stub global fetch（GatewayLlmClient 缺省 fetchImpl 惰性引全局——构造后 stub 仍拦得住）：
   *  捕获出站头，回 OpenAI 形态固定包。 */
  const stubFetch = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    vi.stubGlobal("fetch", (async (_url: unknown, init?: RequestInit) => {
      for (const [k, v] of new Headers(init?.headers).entries()) headers[k] = v;
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { total_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
    return headers;
  };

  test("四 worker 各取各的分账键；actor/requestId 口径不变（agent:<worker> / launch_<runId>）", async () => {
    const keys: Record<JiaotuWorker, string> = {
      triage: "ajt_tri18",
      investigation: "ajt_inv18",
      knowledge: "ajt_kb18",
      chat: "ajt_chat18",
    };
    for (const w of JIAOTU_WORKERS) setEnv(jiaotuWorkerEnvKey(w), keys[w]);
    for (const w of JIAOTU_WORKERS) {
      const headers = stubFetch();
      await workerLlmClient(w, "launch_run-18").chat("hi", { node: "verdict_llm" });
      expect(headers.authorization, `${w} 的分账 Bearer`).toBe(`Bearer ${keys[w]}`);
      expect(headers["x-actor-id"], `${w} 的代理审计 actor`).toBe(`agent:${w}`);
      expect(headers["x-request-id"]).toBe("launch_run-18");
    }
  });

  test("分账键缺省 → 回落单键 JIAOTU_API_KEY（run-kinds 装配面的回落回归）", async () => {
    setEnv("JIAOTU_API_KEY", "jt-single18");
    for (const w of JIAOTU_WORKERS) setEnv(jiaotuWorkerEnvKey(w), undefined);
    const headers = stubFetch();
    await workerLlmClient("triage", "launch_run-18").chat("hi", { node: "verdict_llm" });
    expect(headers.authorization).toBe("Bearer jt-single18");
  });

  test("构造点唯一：run-kinds 内 real client 只经 workerLlmClient 装配（图工厂不得绕过分账声明；hunt loop 归 orchestration 单键）", () => {
    const src = readFileSync(new URL("./run-kinds.ts", import.meta.url), "utf8");
    expect(src.match(/new GatewayLlmClient\(/g)).toHaveLength(1); // 唯一构造点在 workerLlmClient 内
    for (const w of JIAOTU_WORKERS) {
      expect(src).toContain(`workerLlmClient("${w}"`); // 四 worker 全走唯一口
    }
  });
});
