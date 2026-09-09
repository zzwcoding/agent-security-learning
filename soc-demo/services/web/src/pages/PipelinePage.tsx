// 流水线实时视图（FR-M10.2）：SSE 推送 run 节点图高亮 + 每 worker 在干嘛一屏看全。
// 数据面：POST /internal/runs 拿 run_id（m3 卡公开接口）→ GET /api/v1/events/stream
// 订阅（INV-7：断线自动重连 + Last-Event-ID 补发，封装在 ../sse）。
// 现实口径：当前 run 是后端同步执行，拉起返回时事件已全部落盘——本页看到的推送是
// SSE 按 id 补发（与实时同一通道、同一补发语义）；run 异步化后本页自动成为实时视图。
import { Alert, Badge, Button, Input, Select, Space, Spin, Steps, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, listAlerts, startRun } from "../api";
import type { AlertRow } from "../api";
import { useAuth } from "../auth";
import { applyEvent, initPipeline, type PipelineState } from "../pipeline";
import { ReconnectingSse, type SseStatus } from "../sse";

const STATUS_LABEL: Record<SseStatus, { text: string; color: "default" | "processing" | "success" | "warning" | "error" }> = {
  connecting: { text: "连接中", color: "processing" },
  open: { text: "已连接", color: "processing" },
  reconnecting: { text: "断线重连中（按游标补发）", color: "warning" },
  finished: { text: "run 已结束（终态收流）", color: "success" },
  ended: { text: "远端无新事件，停止重连", color: "warning" },
  closed: { text: "已关闭", color: "default" },
};

const RUN_STATUS_COLORS: Record<string, string> = {
  queued: "default",
  running: "blue",
  awaiting_approval: "gold",
  completed: "green",
  failed: "red",
};

function stepStatus(s: "pending" | "running" | "done"): "wait" | "process" | "finish" | "error" {
  return s === "pending" ? "wait" : s === "running" ? "process" : "finish";
}

export default function PipelinePage({ alertId, runId: deepRunId }: { alertId?: string; runId?: string }) {
  const { session } = useAuth();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [selected, setSelected] = useState<string | undefined>(alertId);
  const [runIdInput, setRunIdInput] = useState("");
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [pipeline, setPipeline] = useState<PipelineState>(() => initPipeline("alert_flow"));
  const [sseStatus, setSseStatus] = useState<SseStatus | null>(null);
  const sseRef = useRef<ReconnectingSse | null>(null);
  const kindRef = useRef<string | null>("alert_flow");

  useEffect(() => {
    listAlerts()
      .then(setAlerts)
      .catch(() => setAlerts([]));
  }, []);

  // 订阅一条 run 的 SSE；换 run / 卸载时把旧连接关干净（组件不引状态库，全靠这把 ref）
  const subscribe = useCallback((id: string) => {
    sseRef.current?.close();
    setActiveRun(id);
    setPipeline(initPipeline(kindRef.current));
    const sse = new ReconnectingSse({
      runId: id,
      onEvent: (ev) => setPipeline((st) => applyEvent(st, ev)),
      onStatus: (s) => setSseStatus(s),
    });
    sseRef.current = sse;
    sse.open();
  }, []);

  useEffect(() => () => sseRef.current?.close(), []);

  // 审批卡页「run 流水」深链（#/pipeline?run_id=…）：进来直接接上那条 run。
  // 来路是审批 resume 的 run，图未知 → 不猜骨架，节点从事件流动态发现。
  useEffect(() => {
    if (deepRunId) {
      kindRef.current = null;
      subscribe(deepRunId);
    }
  }, [deepRunId, subscribe]);

  const launch = async () => {
    if (!selected) return;
    setLaunching(true);
    try {
      kindRef.current = "alert_flow";
      // 注意：当前后端同步执行——这个 POST 会跑到 run 终态才返回 run_id
      const { runId: id } = await startRun("alert_flow", selected);
      subscribe(id);
    } catch (e) {
      const hint = e instanceof ApiError && e.status === 502 ? "（铸任务票失败：gateway 未起？）" : "";
      message.error(`发起 run 失败：${e instanceof Error ? e.message : String(e)}${hint}`);
    } finally {
      setLaunching(false);
    }
  };

  const attach = () => {
    const id = runIdInput.trim();
    if (!id) return;
    kindRef.current = null; // 来路不明的 run：不猜图，节点从事件流动态发现
    subscribe(id);
  };

  const status = sseStatus ? STATUS_LABEL[sseStatus] : null;

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          showSearch
          style={{ minWidth: 320 }}
          placeholder="选择一条告警"
          value={selected}
          onChange={setSelected}
          optionFilterProp="label"
          options={alerts.map((a) => ({
            value: a.id,
            label: `#${a.title}（${a.status}${a.occurrences > 1 ? `，重复×${a.occurrences}` : ""}）`,
          }))}
        />
        <Button type="primary" disabled={!selected} loading={launching} onClick={launch}>
          发起分诊 run（alert_flow）
        </Button>
        <Input
          style={{ width: 260 }}
          placeholder="或粘贴 run_id 接上"
          value={runIdInput}
          onChange={(e) => setRunIdInput(e.target.value)}
          onPressEnter={attach}
        />
        <Button onClick={attach}>接上这条 run</Button>
      </Space>

      {status && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Badge status={status.color} text={status.text} />
          {activeRun && <Typography.Text code>run: {activeRun}</Typography.Text>}
          {pipeline.runStatus && (
            <Tag color={RUN_STATUS_COLORS[pipeline.runStatus] ?? "default"}>{pipeline.runStatus}</Tag>
          )}
          <Tag>工具调用 {pipeline.toolCalls} 次</Tag>
          {pipeline.failed && <Tag color="red">run 出错（看审计与 error 事件）</Tag>}
          {session && <Tag>观察者：{session.roleLabel}</Tag>}
        </Space>
      )}

      {launching && (
        <div style={{ margin: "24px 0" }}>
          <Spin tip="run 同步执行中（跑完才回 run_id，随后 SSE 补发全程）…">
            <div style={{ minHeight: 60 }} />
          </Spin>
        </div>
      )}

      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon={false}
        message="节点图与事件全部来自 SSE 推送（/api/v1/events/stream，INV-7 落盘总线 + 补发）；断线会按最后事件 id 自动重连续传。"
      />

      {pipeline.nodes.length > 0 && (
        <Steps
          direction="vertical"
          size="small"
          items={pipeline.nodes.map((n) => ({ title: n.name, status: stepStatus(n.status) }))}
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        事件流（新到在上，封顶 200 条）
      </Typography.Title>
      <div style={{ maxHeight: 320, overflow: "auto" }}>
        {pipeline.log.map((e) => (
          <div key={e.id} style={{ padding: "2px 0", borderBottom: "1px solid #f0f0f0" }}>
            <Tag style={{ fontFamily: "monospace" }}>{e.type}</Tag>
            <span>{e.text}</span>
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
              {new Date(e.ts).toLocaleTimeString("zh-CN", { hour12: false })} · id {e.id}
            </Typography.Text>
          </div>
        ))}
      </div>
    </div>
  );
}
