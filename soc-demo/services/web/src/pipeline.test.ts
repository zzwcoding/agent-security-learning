// 流水线视图的状态归约测试：SSE 事件流（纯数据）→ 节点高亮状态 + 事件日志。
// 纯函数层单测，不碰 React——这是流水线视图唯一值得测的逻辑。
import { describe, expect, it } from "vitest";
import { FLOW_NODES, applyEvent, initPipeline, type SseEvent } from "./pipeline";
import type { SseEventType } from "./sse";

function ev(id: number, type: SseEventType, payload: Record<string, unknown> = {}): SseEvent {
  return { id, type, payload, ts: 1700000000000 + id };
}

describe("initPipeline", () => {
  it("alert_flow 预置 triage 六节点（全 pending）——图结构镜像 worker 子图", () => {
    const st = initPipeline("alert_flow");
    expect(st.nodes.map((n) => n.name)).toEqual([
      "load_alert",
      "kb_check",
      "merge_check",
      "self_audit_checkpoint",
      "verdict_llm",
      "outcome",
    ]);
    expect(st.nodes.every((n) => n.status === "pending")).toBe(true);
  });

  it("FLOW_NODES 只收编 alert_flow（其余 kind 动态发现，不超前猜图）", () => {
    expect(Object.keys(FLOW_NODES)).toEqual(["alert_flow"]);
    expect(initPipeline("chat_flow").nodes).toEqual([]);
    expect(initPipeline(null).nodes).toEqual([]);
  });
});

describe("applyEvent", () => {
  it("node_enter 高亮当前节点，node_exit 落成已完成", () => {
    let st = initPipeline("alert_flow");
    st = applyEvent(st, ev(1, "node_enter", { node: "load_alert" }));
    expect(st.nodes[0]).toEqual({ name: "load_alert", status: "running" });
    st = applyEvent(st, ev(2, "node_exit", { node: "load_alert" }));
    st = applyEvent(st, ev(3, "node_enter", { node: "kb_check" }));
    expect(st.nodes.map((n) => n.status)).toEqual(["done", "running", "pending", "pending", "pending", "pending"]);
  });

  it("未知节点动态追加（run kind 没有预置图也能亮）", () => {
    let st = initPipeline("chat_flow");
    st = applyEvent(st, ev(1, "node_enter", { node: "input_guard" }));
    expect(st.nodes).toEqual([{ name: "input_guard", status: "running" }]);
  });

  it("audit 镜像推进 run 状态（Web 的 run 状态观察面与后端状态机同源）", () => {
    let st = initPipeline("alert_flow");
    st = applyEvent(st, ev(1, "audit", { action: "update", status: { from: "queued", to: "running" } }));
    expect(st.runStatus).toBe("running");
    st = applyEvent(st, ev(2, "audit", { action: "update", status: { from: "running", to: "completed" } }));
    expect(st.runStatus).toBe("completed");
  });

  it("error 事件置 failed 标记", () => {
    let st = initPipeline("alert_flow");
    st = applyEvent(st, ev(1, "error", { code: "budget_exceeded", kind: "steps" }));
    expect(st.failed).toBe(true);
  });

  it("tool_call 计数进总账；日志带人话文本", () => {
    let st = initPipeline("alert_flow");
    st = applyEvent(st, ev(1, "tool_call", { node: "load_alert", tool: "get_alert" }));
    st = applyEvent(st, ev(2, "tool_result", { node: "load_alert", tool: "get_alert", ok: true }));
    expect(st.toolCalls).toBe(1);
    expect(st.log[0].type).toBe("tool_result");
    expect(st.log[1].text).toContain("get_alert");
  });

  it("日志新到在上、封顶 200 条（保住最新的，甩掉最旧的）", () => {
    let st = initPipeline(null);
    for (let i = 1; i <= 250; i++) {
      st = applyEvent(st, ev(i, "audit", { action: "update", status: { to: "running" } }));
    }
    expect(st.log).toHaveLength(200);
    expect(st.log[0].id).toBe(250); // 最新在最上
    expect(st.log[199].id).toBe(51);
  });

  it("归约是纯函数：不改动旧状态（React 严格模式双调用安全）", () => {
    const st = initPipeline("alert_flow");
    const snapshot = JSON.stringify(st);
    applyEvent(st, ev(1, "node_enter", { node: "load_alert" }));
    applyEvent(st, ev(2, "audit", { status: { to: "running" } }));
    expect(JSON.stringify(st)).toBe(snapshot);
  });
});
