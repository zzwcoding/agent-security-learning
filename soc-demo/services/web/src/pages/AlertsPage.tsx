// 告警列表页（FR-M10.1）：接入/去重可见（dedup 标记、severity、状态）+ fixture 回放按钮。
// 回放 = 把打包进前端的 fixture 从 webhook 正门重推一遍（与 scripts/replay.ts 同一动作），
// 第二次点同一个按钮就能看到 occurrences +1 的去重标记——INV-6 的现场演示。
import { Button, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { findCaseIdByAlert, listAlerts, listCases, replayAlert, type AlertRow } from "../api";
import { FIXTURE_ALERTS } from "../fixtures";

const SEVERITY = [
  { value: 1, text: "低", color: "default" },
  { value: 2, text: "中", color: "blue" },
  { value: 3, text: "高", color: "orange" },
  { value: 4, text: "严重", color: "red" },
] as const;

const STATUS_COLORS: Record<string, string> = {
  New: "blue",
  InProgress: "gold",
  Imported: "green",
  Closed: "default",
};

// 票 31：导出供 sse-verdict-contract.test.ts 锁键集——覆盖 fixtures/verdicts.json 的
// m2_verdicts 全集 + tri 短别名（新结局没配色、或混进错别字键，契约测试必红）。
export const VERDICT_COLORS: Record<string, string> = {
  false_positive: "default",
  benign_true_positive: "green",
  true_positive: "red",
  uncertain: "orange",
  // 短别名：M2 verdict_ai 存的是 worker 的原始判定对象（verdict 字段是短标签）
  tp: "red",
  btp: "green",
  fp: "default",
};

/** verdict_ai 的真实 wire 形状是 worker 的原始判定对象（{verdict:"tp",...}），
 *  老数据/下游也可能给字符串——两态都归一成可渲染的标签，页面不吃 Object 崩溃。 */
function verdictLabel(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "verdict" in v) {
    return String((v as { verdict: unknown }).verdict);
  }
  return null;
}

function fmtTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "-";
}

export default function AlertsPage({ go }: { go: (route: string) => void }) {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAlerts(await listAlerts());
    } catch (e) {
      message.error(`拉取告警失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const replay = async () => {
    setReplaying(true);
    try {
      let created = 0;
      let deduped = 0;
      for (const f of FIXTURE_ALERTS) {
        const r = await replayAlert(f.payload);
        if (r.dedup) deduped += 1;
        else created += 1;
        await new Promise((ok) => setTimeout(ok, 200)); // 与 replay.ts 同款节奏（~5 条/秒）
      }
      message.success(`回放完成：新建 ${created} 条，去重命中 ${deduped} 条`);
      await load();
    } catch (e) {
      message.error(`回放失败：${e instanceof Error ? e.message : String(e)}（ingest 未起？）`);
    } finally {
      setReplaying(false);
    }
  };

  // 时间线页入口（FR-M10.4）：告警 → 案件反查（linkedAlerts 里找它）。
  // 没建案就明说，不猜——案件是分诊 TP 后由 outcome 节点自动建的。
  const openCase = async (alertId: string) => {
    try {
      const found = findCaseIdByAlert(await listCases(), alertId);
      if (found) go(`cases?case_id=${found}`);
      else message.info("这条告警还没有案件（分诊判 TP 后自动建案，或先在流水线视图发起分诊）");
    } catch (e) {
      message.error(`查案件失败：${e instanceof Error ? e.message : String(e)}（case-backend 未起？）`);
    }
  };

  const columns: ColumnsType<AlertRow> = [
    {
      title: "标题",
      dataIndex: "title",
      ellipsis: true,
      render: (_, r) => (
        <Tooltip title={`${r.source}/${r.sourceRef}`}>
          <span>{r.title}</span>
        </Tooltip>
      ),
    },
    {
      title: "severity",
      dataIndex: "severity",
      width: 110,
      filters: SEVERITY.map((s) => ({ text: s.text, value: s.value })),
      onFilter: (v, r) => r.severity === v,
      render: (sev: number) => {
        const s = SEVERITY.find((x) => x.value === sev);
        return <Tag color={s?.color}>{s ? `${s.text}(${sev})` : sev}</Tag>;
      },
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      filters: ["New", "InProgress", "Imported", "Closed"].map((s) => ({ text: s, value: s })),
      onFilter: (v, r) => r.status === v,
      render: (st: string) => <Tag color={STATUS_COLORS[st] ?? "default"}>{st}</Tag>,
    },
    {
      title: "AI 分诊",
      dataIndex: "verdictAi",
      width: 150,
      render: (v: unknown) => {
        const label = verdictLabel(v);
        return label ? <Tag color={VERDICT_COLORS[label] ?? "default"}>{label}</Tag> : <Tag>未分诊</Tag>;
      },
    },
    {
      title: "去重",
      dataIndex: "occurrences",
      width: 110,
      render: (n: number) =>
        n > 1 ? <Tag color="orange">重复×{n}</Tag> : <Tag>首次接入</Tag>,
    },
    {
      title: "最后_seen",
      dataIndex: "lastSeen",
      width: 180,
      render: fmtTime,
    },
    {
      title: "操作",
      key: "act",
      width: 170,
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" onClick={() => go(`pipeline?alert_id=${r.id}`)}>
            发起分诊
          </Button>
          <Button size="small" type="link" onClick={() => void openCase(r.id)}>
            查案件
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Tooltip
          title={`把打包的 ${FIXTURE_ALERTS.length} 条 fixture 从 webhook 正门重推（同 scripts/replay.ts；再点一次看去重）`}
        >
          <Button type="primary" loading={replaying} onClick={replay}>
            回放 fixtures（重推正门）
          </Button>
        </Tooltip>
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        <Typography.Text type="secondary">
          回放走 ingest webhook 正门——不直接塞库，去重/映射/不可信标记全程有效（m1 三铁律）。
        </Typography.Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={alerts}
        pagination={{ pageSize: 20, showTotal: (n) => `共 ${n} 条` }}
      />
    </div>
  );
}
