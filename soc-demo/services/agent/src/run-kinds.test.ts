import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUN_KIND_IDS, requireRunKind, runKindOf, type RunKindGraphDeps } from "./run-kinds.js";
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
      expect(["alert", "case"], `${id} intake`).toContain(desc.intake);
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

  test("intake / requiresMessage 口径（票 17/18/36/39/73 原样）", () => {
    expect(requireRunKind("alert_flow").intake).toBe("alert");
    expect(requireRunKind("close_flow").intake).toBe("alert");
    for (const id of ["knowledge_flow", "chat_flow", "case_flow", "hunt_flow", "hunt_task"]) {
      expect(requireRunKind(id).intake).toBe("case");
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
