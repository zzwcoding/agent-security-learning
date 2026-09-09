// 流水线视图的状态归约（纯函数层，React 之外可单测）：SSE 事件流 →
// 「节点图高亮 + 每 worker 在干嘛一屏看全」（FR-M10.2）。
// 设计取向：Web 是薄客户端，节点图结构只有一个来源是可信的——SSE 事件流本身。
// 预置骨架只做纯展示的节点名单（镜像 agent 侧子图声明）：alert_flow = 分诊六节点、
// case_flow = 调查+富化链两交接节点（票 36）。名单与 fixtures/sse-events.json
// flow_nodes 共读同源（票 31 先例：两端测试各自咬住对端，agent 产出侧闸在
// services/agent/src/case-flow.test.ts）。其余 kind 的节点从 node_enter 动态追加，
// 不超前猜图。
import type { SseEvent } from "./sse";

export type { SseEvent };

export type NodeStatus = "pending" | "running" | "done";

export interface PipelineNode {
  name: string;
  status: NodeStatus;
}

export interface LogEntry {
  id: number;
  type: string;
  text: string;
  ts: number;
}

export interface PipelineState {
  nodes: PipelineNode[];
  runStatus: string | null; // 跟随 audit 镜像里的 run 状态机（CONTEXT.md 语义核心）
  failed: boolean;
  toolCalls: number;
  log: LogEntry[]; // 新到在上，封顶 200 条
  lastEventId: number;
}

const LOG_CAP = 200;

/** 预置节点骨架：alert_flow = triage 六节点；case_flow = 调查+富化链（票 36，
 *  FR-M10.2）。web 不能 import agent 源码（边界规则 R6）——本名单是手抄，与 agent
 *  侧唯一事实来源（services/agent/src/run-kinds.ts 注册表的 pipelineNodes 格，票 44）
 *  靠同一份 fixtures/sse-events.json flow_nodes 样品契约锁：两端测试各读本表咬对端
 *  （票 31 先例；agent 产出侧闸 = run-kinds.test.ts）。
 *  其余 kind（chat/knowledge）节点未知 → 空骨架动态发现（不超前猜图）。 */
export const FLOW_NODES: Record<string, string[]> = {
  alert_flow: ["load_alert", "kb_check", "merge_check", "self_audit_checkpoint", "verdict_llm", "outcome"],
  case_flow: ["investigate_case", "enrich_case"],
};

export function initPipeline(kind: string | null): PipelineState {
  return {
    nodes: (kind ? FLOW_NODES[kind] : undefined)?.map((name) => ({ name, status: "pending" })) ?? [],
    runStatus: null,
    failed: false,
    toolCalls: 0,
    log: [],
    lastEventId: 0,
  };
}

function nodeText(payload: Record<string, unknown>): string {
  return typeof payload.node === "string" ? payload.node : "?";
}

function describe(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "node_enter":
      return `进入节点 ${nodeText(payload)}`;
    case "node_exit":
      return `完成节点 ${nodeText(payload)}`;
    case "tool_call":
      return `调用工具 ${String(payload.tool ?? "?")}（节点 ${nodeText(payload)}）`;
    case "tool_result":
      return `工具返回 ${String(payload.tool ?? "?")}${payload.ok === false ? "（失败）" : ""}`;
    case "approval_required":
      return `需要审批：${String(payload.tool ?? "?")}，等值班长裁决`;
    case "approval_decided":
      return `审批已裁决：${JSON.stringify(payload.decision ?? payload)}`;
    case "denied":
      return `被拒绝：${String(payload.reason ?? "")}`;
    case "audit": {
      const status = payload.status as { from?: string; to?: string } | undefined;
      return status?.to ? `run 状态：${status.from ?? "?"} → ${status.to}` : `审计：${String(payload.action ?? "?")}`;
    }
    case "error":
      return `出错：${String(payload.message ?? payload.code ?? JSON.stringify(payload))}`;
    case "token":
      return `回答分片 +${1}`;
    case "done":
      return "流结束（done）";
    default:
      return JSON.stringify(payload);
  }
}

/** 归约一个事件 → 新状态（不可变：React 严格模式/重放安全）。 */
export function applyEvent(st: PipelineState, ev: SseEvent): PipelineState {
  const { type, payload } = ev;

  let nodes = st.nodes;
  const mark = (name: string, status: NodeStatus): PipelineNode[] => {
    const idx = nodes.findIndex((n) => n.name === name);
    if (idx < 0) return [...nodes, { name, status }]; // 未知节点动态追加
    const next = nodes.map((n) => (n.name === name ? { ...n, status } : n));
    return next;
  };
  if (type === "node_enter") nodes = mark(String(payload.node ?? "?"), "running");
  if (type === "node_exit") nodes = mark(String(payload.node ?? "?"), "done");

  const entry: LogEntry = { id: ev.id, type, text: describe(type, payload), ts: ev.ts };
  const log = [entry, ...st.log].slice(0, LOG_CAP);

  const statusTo = type === "audit" ? (payload.status as { to?: string } | undefined)?.to : undefined;
  return {
    nodes,
    log,
    lastEventId: Math.max(st.lastEventId, ev.id),
    toolCalls: st.toolCalls + (type === "tool_call" ? 1 : 0),
    runStatus: statusTo ?? st.runStatus,
    failed: st.failed || type === "error",
  };
}
