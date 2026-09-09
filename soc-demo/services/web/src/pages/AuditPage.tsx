// 审计流页（FR-M10.5）：实时滚动审计条目，可按 requestId/case 过滤。
// 数据面：GET /api/v1/audit（INV-8 五要素审计的公开查询口），requestId/objectId
// 是服务端参数（不是前端假过滤）；实时滚动 = 2 秒轮询 + mergeAudit 按 id 去重合并。
// 为什么轮询：审计真相在 M2，全局审计没有 SSE 出口（per-run 的 audit 镜像事件在
// agent 的 run 流里，流水线页已经在看）；PRD M10 异常与边界也把轮询列为降级正道。
import { Button, Input, Space, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { listAudit, type AuditRow } from "../api";
import { mergeAudit } from "../audit";

const RESULT_COLORS: Record<string, string> = {
  SUCCESS: "green",
  DENIED: "red",
  FAILURE: "red",
};

const POLL_MS = 2000;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [reqInput, setReqInput] = useState("");
  const [objInput, setObjInput] = useState("");
  const [reqFilter, setReqFilter] = useState("");
  const [objFilter, setObjFilter] = useState("");
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listAudit({
        requestId: reqFilter || undefined,
        objectId: objFilter || undefined,
      });
      setEntries((prev) => mergeAudit(prev, rows));
      setLastAt(Date.now());
    } catch (e) {
      message.error(`拉取审计失败：${e instanceof Error ? e.message : String(e)}（case-backend 未起？）`);
    } finally {
      setLoading(false);
    }
  }, [reqFilter, objFilter]);

  useEffect(() => {
    void load();
    if (!auto) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load, auto]);

  const columns: ColumnsType<AuditRow> = [
    { title: "时间", dataIndex: "createdAt", width: 180, render: fmtTime },
    {
      title: "结果",
      dataIndex: "result",
      width: 90,
      render: (r: string) => <Tag color={RESULT_COLORS[r] ?? "default"}>{r}</Tag>,
    },
    { title: "动作", dataIndex: "action", width: 140 },
    {
      title: "谁",
      key: "actor",
      width: 180,
      render: (_, r) => `${r.actor.type}:${r.actor.id}`,
    },
    {
      title: "对象",
      key: "object",
      width: 200,
      ellipsis: true,
      render: (_, r) => (
        <Tooltip title={r.objectId}>
          <span>
            {r.objectType}/{r.objectId.slice(0, 13)}
          </span>
        </Tooltip>
      ),
    },
    {
      title: "requestId",
      dataIndex: "requestId",
      width: 200,
      render: (v: string) => (
        <Typography.Text code copyable={{ text: v }} style={{ fontSize: 12 }}>
          {v.slice(0, 18)}
        </Typography.Text>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          style={{ width: 280 }}
          placeholder="按 requestId 过滤（贯穿链的 x-request-id）"
          value={reqInput}
          onChange={(e) => setReqInput(e.target.value)}
          onPressEnter={() => setReqFilter(reqInput.trim())}
          allowClear
        />
        <Input
          style={{ width: 240 }}
          placeholder="按 case/alert 对象 id 过滤"
          value={objInput}
          onChange={(e) => setObjInput(e.target.value)}
          onPressEnter={() => setObjFilter(objInput.trim())}
          allowClear
        />
        <Button
          type="primary"
          onClick={() => {
            setReqFilter(reqInput.trim());
            setObjFilter(objInput.trim());
          }}
        >
          应用过滤
        </Button>
        <Space>
          <Switch checked={auto} onChange={setAuto} size="small" /> 实时轮询（{POLL_MS / 1000}s）
        </Space>
        <Button onClick={() => void load()} loading={loading}>
          立即刷新
        </Button>
        <Typography.Text type="secondary">
          共 {entries.length} 条{lastAt ? ` · 更新于 ${new Date(lastAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
        </Typography.Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={entries}
        pagination={{ pageSize: 15, showTotal: (n) => `共 ${n} 条` }}
        expandable={{
          expandedRowRender: (r) => (
            <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(r.details, null, 2)}</pre>
          ),
        }}
      />
    </div>
  );
}
