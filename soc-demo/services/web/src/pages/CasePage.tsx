// 案件时间线页（FR-M10.4）：Case 详情 + timeline（调查报告/富化四档标签/审批/执行条目）
// + 对话追问入口。
// 数据面两路（timeline.ts 装配）：GET /api/v1/cases/:id（详情 + timeline_entries）+
// GET /api/v1/approvals（case_id 对得上的审批卡 → 审批/执行条目）。
// 追问入口 = m8 对话正门 POST /api/v1/chat（chat.ts 流式读，Bearer 会话；
// case_id 交给后端按 field-profile 白名单装配上下文，FR-M8.6）——Copilot 没有写手，
// 动作意图会在对话里转审批卡，回流到本页时间线。
import { Button, Drawer, Empty, Input, List, Select, Space, Spin, Tag, Timeline, Typography, message } from "antd";
import { useCallback, useEffect, useState } from "react";
import { findCaseIdByAlert, getCaseDetail, listApprovals, listCases, type CaseDetail, type CaseRow } from "../api";
import { useAuth } from "../auth";
import { applyChatFrame, EMPTY_TURN, streamChat, type ChatTurn } from "../chat";
import { assembleTimeline } from "../timeline";

const LEVEL_COLORS: Record<string, string> = {
  info: "default",
  safe: "green",
  suspicious: "orange",
  malicious: "red",
  refused: "default",
};

interface ChatExchange {
  question: string;
  turn: ChatTurn;
  error?: string;
}

export default function CasePage({ caseId, alertId }: { caseId?: string; alertId?: string }) {
  const { session } = useAuth();
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [selected, setSelected] = useState<string | undefined>(caseId);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [rows, setRows] = useState<ReturnType<typeof assembleTimeline>>([]);
  const [loading, setLoading] = useState(false);

  const [askOpen, setAskOpen] = useState(false);
  const [exchanges, setExchanges] = useState<ChatExchange[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // 深链没带 case_id 时（#/cases 直接进 / 告警页 alert_id 反查）：拉案件列表兜底
  useEffect(() => {
    listCases()
      .then(async (cs) => {
        setCases(cs);
        if (!caseId && alertId) {
          const found = findCaseIdByAlert(cs, alertId);
          if (found) setSelected(found);
        }
      })
      .catch(() => setCases([]));
  }, [caseId, alertId]);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const [d, cards] = await Promise.all([getCaseDetail(id), listApprovals()]);
      setDetail(d);
      setRows(assembleTimeline(d, cards));
    } catch (e) {
      message.error(`拉取案件失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) void load(selected);
  }, [selected, load]);

  const send = async () => {
    const q = input.trim();
    if (!q || !session || !selected) return;
    setInput("");
    setExchanges((prev) => [...prev, { question: q, turn: EMPTY_TURN }]);
    setSending(true);
    try {
      await streamChat({
        token: session.token,
        message: q,
        caseId: selected,
        onFrame: (f) =>
          setExchanges((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, turn: applyChatFrame(last.turn, f) };
            return next;
          }),
      });
    } catch (e) {
      const hint = e instanceof Error && e.message.includes("401") ? "（会话过期？重新登录）" : "";
      setExchanges((prev) => {
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], error: `${e instanceof Error ? e.message : String(e)}${hint}` };
        return next;
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          showSearch
          style={{ minWidth: 360 }}
          placeholder="选择案件"
          value={selected}
          optionFilterProp="label"
          onChange={(id) => setSelected(id)}
          options={cases.map((c) => ({ value: c.id, label: `#${c.number} ${c.title}（${c.status}）` }))}
        />
        <Button onClick={() => selected && void load(selected)} loading={loading}>
          刷新
        </Button>
        <Button type="primary" disabled={!selected} onClick={() => setAskOpen(true)}>
          对话追问（Copilot）
        </Button>
      </Space>

      {loading && !detail && <Spin />}
      {!selected && <Empty description="从上表选一个案件（告警列表「查案件」也会跳进来）" />}

      {detail && (
        <Typography.Paragraph>
          <Space size={8} wrap>
            <Typography.Text strong>
              #{detail.number} {detail.title}
            </Typography.Text>
            <Tag color="blue">{detail.status}</Tag>
            <Tag>severity {detail.severity}</Tag>
            <Tag>TLP {detail.tlp} / PAP {detail.pap}</Tag>
            {detail.verdict && <Tag color="red">结案判定 {detail.verdict}</Tag>}
            <Typography.Text type="secondary">
              关联告警 {detail.linkedAlerts.join("、") || "-"} · observables {detail.observables.length} 条
            </Typography.Text>
          </Space>
        </Typography.Paragraph>
      )}

      {detail && rows.length > 0 && (
        <Timeline
          items={rows.map((r) => ({
            key: r.key,
            color: r.color === "default" ? "gray" : r.color,
            children: (
              <div>
                <Space size={6} wrap>
                  <Tag color={r.color}>{r.label}</Tag>
                  <Typography.Text strong={r.kind === "approval"}>{r.title}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(r.ts).toLocaleString("zh-CN", { hour12: false })}
                  </Typography.Text>
                  {r.levels?.map((lv, i) => (
                    <Tag key={i} color={LEVEL_COLORS[lv] ?? "default"}>
                      {lv}
                    </Tag>
                  ))}
                </Space>
                {r.body && (
                  <pre style={{ margin: "4px 0 0", fontSize: 12, whiteSpace: "pre-wrap", maxWidth: 860 }}>
                    {r.body}
                  </pre>
                )}
              </div>
            ),
          }))}
        />
      )}
      {detail && rows.length === 0 && !loading && <Empty description="这个案件还没有时间线条目" />}

      <Drawer
        title={`对话追问 · ${detail?.title ?? ""}（案件上下文由后端白名单装配，FR-M8.6）`}
        open={askOpen}
        onClose={() => setAskOpen(false)}
        width={520}
      >
        {exchanges.length === 0 && (
          <Typography.Text type="secondary">
            试试问：「这个案子关联了哪些告警？」「帮我把 centos7 隔离了」（动作意图会转审批卡）
          </Typography.Text>
        )}
        <List
          dataSource={exchanges}
          renderItem={(ex) => (
            <List.Item style={{ display: "block" }}>
              <Typography.Paragraph style={{ marginBottom: 4 }}>
                <Tag color="blue">你</Tag>
                {ex.question}
              </Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 4 }}>
                <Tag color="green">Copilot</Tag>
                {ex.turn.answer || (ex.turn.steps.length === 0 && !ex.turn.done ? "…" : "")}
              </Typography.Paragraph>
              {ex.turn.steps.map((s) => (
                <div key={s.id} style={{ fontSize: 12 }}>
                  <Tag style={{ fontFamily: "monospace" }}>{s.type}</Tag>
                  {s.text}
                </div>
              ))}
              {ex.error && <Typography.Text type="danger">出错：{ex.error}</Typography.Text>}
            </List.Item>
          )}
        />
        <Space.Compact style={{ width: "100%", marginTop: 12 }}>
          <Input
            placeholder="追问一句（案件上下文自动带上）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => void send()}
            disabled={sending}
          />
          <Button type="primary" loading={sending} onClick={() => void send()}>
            发送
          </Button>
        </Space.Compact>
      </Drawer>
    </div>
  );
}
