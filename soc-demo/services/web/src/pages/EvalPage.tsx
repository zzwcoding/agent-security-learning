// Eval 结果页（FR-M10.6）：最近一次 eval 跑分三维展示——分诊准确率 / 攻击面拦截率 /
// 成本耗时。数据源 = m11 产物 eval-results/latest.json（vite 静态面，URL 与磁盘路径
// 一致；m11 卡公开接口就是「产出这个文件」，Web 只读产物，无任何后端端点）。
// 票 22 之前的产物没有攻击面分面——页面如实标「未产出」，绝不合成数字（eval.ts）。
import { Alert, Button, Card, Space, Statistic, Table, Tag, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { fetchEvalReport, type EvalCaseRow } from "../api";
import { evalView } from "../eval";

export default function EvalPage() {
  const [view, setView] = useState<ReturnType<typeof evalView> | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setView(evalView(await fetchEvalReport()));
    } catch (e) {
      message.error(`读 eval-results/latest.json 失败：${e instanceof Error ? e.message : String(e)}（跑过 pnpm test:eval 了吗？）`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<EvalCaseRow> = [
    { title: "用例", dataIndex: "fullName", ellipsis: true },
    { title: "域", dataIndex: "domain", width: 100, render: (d: string) => <Tag>{d}</Tag> },
    {
      title: "结果",
      dataIndex: "passed",
      width: 90,
      render: (p: boolean) => (p ? <Tag color="green">PASS</Tag> : <Tag color="red">FAIL</Tag>),
    },
    { title: "工具调用", dataIndex: "toolCalls", width: 90 },
    { title: "tokens", dataIndex: "tokens", width: 90 },
    {
      title: "耗时",
      dataIndex: "durationMs",
      width: 90,
      render: (ms?: number) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "-"),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button onClick={() => void load()} loading={loading}>
          刷新（重读 latest.json）
        </Button>
        {view && (
          <Typography.Text type="secondary">
            run_at {new Date(view.runAt).toLocaleString("zh-CN", { hour12: false })} · lane {view.lane}
            {view.testedModel ? ` · 被测 ${view.testedModel}` : ""}
          </Typography.Text>
        )}
      </Space>

      {view && (
        <>
          <Space size={16} style={{ display: "flex", flexWrap: "wrap", marginBottom: 16, alignItems: "stretch" }}>
            <Card style={{ flex: "1 1 200px", minWidth: 200 }}>
              <Statistic title="分诊准确率（对照人工标注）" value={view.accuracy ?? "—"} suffix={view.accuracy ? "" : "无数据"} />
              <Typography.Text type="secondary">通过 {view.totals.passed}/{view.totals.ran}（跑 {view.totals.ran}/{view.totals.cases}，跳过 {view.totals.skipped}）</Typography.Text>
            </Card>
            <Card style={{ flex: "1 1 320px", minWidth: 320 }}>
              {view.hasAttackData ? (
                <Space size={24} wrap>
                  {view.faces.map((f) => (
                    <Statistic key={f.key} title={`${f.label}拦截率`} value={f.pct ?? "—"} />
                  ))}
                </Space>
              ) : (
                <>
                  <Statistic title="攻击面拦截率" value="未产出" />
                  <Typography.Text type="secondary">
                    attack_block_rate 分面由票 22（攻击/审批/replay/对话维）产出
                  </Typography.Text>
                </>
              )}
            </Card>
            <Card style={{ flex: "1 1 260px", minWidth: 260 }}>
              <Space size={24} wrap>
                <Statistic title="tokens 合计" value={view.cost.tokens} />
                <Statistic title="耗时合计" value={(view.cost.durationMs / 1000).toFixed(1)} suffix="s" />
                <Statistic title="工具调用合计" value={view.cost.toolCalls} />
              </Space>
              <Typography.Text type="secondary">逐用例成本口径见下表（票 22 落 cost_all.csv）</Typography.Text>
            </Card>
          </Space>

          {view.judgeNote && (
            <Alert
              style={{ marginBottom: 16 }}
              type="info"
              showIcon={false}
              message={`judge 汇总：${view.judgeNote}（avg_score 不进门禁，决策 #7）`}
            />
          )}

          <Table
            rowKey="fullName"
            size="small"
            columns={columns}
            dataSource={view.cases}
            pagination={{ pageSize: 15, showTotal: (n) => `共 ${n} 个用例` }}
          />
        </>
      )}
    </div>
  );
}
