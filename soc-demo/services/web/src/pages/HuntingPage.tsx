// 狩猎页（票 82，页面映射节「狩猎页」六行的实现页；PRD §13.7 第七页）。
//
// 页面形态：独立页（PRD §13.7 拍板「新增第七页：狩猎页」；菜单第七项，路由快照锁死）。
// 数据面 = 公开 REST + SSE，零 Web 专属接口（m10 卡零特权原则照旧）：
//   ① 假设列表（五态 Tag）     → m2 GET /api/v1/hypotheses
//   ② 发起假设（填假设句）     → m2 POST /api/v1/hypotheses（outbox 拉起 hunt_flow）
//   ③ 取消假设（hunting 态）   → m2 POST :id/cancel
//   ④ 轮次视图/judge/gap/结论  → m2 GET :id（内嵌轮次归集段）+ m3 SSE（流水线页同款）
//   ⑤ 收敛结论的 Case 链接     → 既有案件查询面按 hypothesis_id 客户端反查
//   ⑥ 断线刷新重建             → m2 GET /api/v1/audit?objectId=<hyp>（父 run 锚）
//
// 模板选择口径（票 92 收口票 82 偏差①）：模板下拉数据源 = agent 只读投影面
// GET /api/v1/templates（m14 HuntTemplateSource 登记面的公开读出，票 92 补卡）——
// 票 82 施工期的自由文本 template_id 退位。下拉留空 = 机制默认档（后端语义不变）；
// 清单为空/面不可达 = 下拉空清单如实占位、留空仍可发起（不硬造数据源，页面只降级不猜）。
//
// 实时推进分工：SSE（复用 ./sse 事件总线，INV-7 断线按游标补发）是「发生了什么」的
// 信号帧；轮次账面一律以 m2 详情读面为准——关键帧（接力/回归/终态）后重取详情与审计，
// 父 run 终态收流后按审计锚自动接上下一轮 run 的流（多轮推进）。
import { Alert, Badge, Button, Card, Empty, Input, List, Popconfirm, Select, Space, Spin, Table, Tag, Typography, message } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelHypothesis,
  createHypothesis,
  findCaseIdByHypothesis,
  getHypothesisDetail,
  listAudit,
  listCases,
  listHuntTemplates,
  listHypotheses,
  type CaseRow,
  type HuntTemplateRow,
  type HypothesisDetail,
  type HypothesisRow,
  type HuntChild,
} from "../api";
import { useAuth } from "../auth";
import {
  applyHuntEvent,
  HYPOTHESIS_STATUS_META,
  initHuntLive,
  rebuildRoundViews,
  roundRunAnchors,
  type AuditEntryLike,
  type HuntLiveState,
  type HuntRoundView,
  type HypothesisStatus,
} from "../hunting";
import type { SseEvent, SseStatus } from "../sse";
import { ReconnectingSse } from "../sse";

const SSE_STATUS_LABEL: Record<SseStatus, { text: string; color: "default" | "processing" | "success" | "warning" | "error" }> = {
  connecting: { text: "连接中", color: "processing" },
  open: { text: "已连接", color: "processing" },
  reconnecting: { text: "断线重连中（按游标补发）", color: "warning" },
  finished: { text: "本轮 run 已结束（终态收流）", color: "success" },
  ended: { text: "远端无新事件，停止重连", color: "warning" },
  closed: { text: "已关闭", color: "default" },
};

const CHILD_STATUS_COLORS: Record<string, string> = {
  completed: "green",
  failed: "red",
  running: "blue",
  queued: "default",
};

function taskTool(t: unknown): string {
  return String((t as Record<string, unknown> | null)?.tool ?? "?");
}

function gapText(gap: unknown): string | null {
  if (!gap || typeof gap !== "object") return null;
  const g = gap as Record<string, unknown>;
  const parts = [g.gap_description, g.unknown].filter((s): s is string => typeof s === "string" && !!s);
  const focus = Array.isArray(g.suggested_focus) ? (g.suggested_focus as string[]) : [];
  return [...new Set(parts)].join("｜") + (focus.length ? `（建议聚焦：${focus.join("、")}）` : "");
}

function RoundCard({ view, live }: { view: HuntRoundView; live: HuntLiveState }) {
  // 子 run 状态：SSE 回归帧 > 详情归集段 > dispatch 声明（running）——账面以详情为准，
  // SSE 只提前/修正展示，三者都缺席就不显示（不猜）。
  const joined = live.joined[String(view.roundNo)];
  const declared = (live.declared[String(view.roundNo)] ?? []).map(
    (id): HuntChild => ({ run_id: id, status: "running" }),
  );
  const children = joined ?? (view.children.length > 0 ? view.children : declared);
  const gap = gapText(view.gap);
  const judge = view.judge as Record<string, unknown> | null;
  return (
    <Card
      size="small"
      title={view.pending ? `第 ${view.roundNo} 轮（接力中）` : `第 ${view.roundNo} 轮`}
      extra={view.runId ? <Typography.Text code copyable={false}>run: {view.runId}</Typography.Text> : null}
      style={{ marginBottom: 12 }}
    >
      {view.pending && !declared.length && (
        <Typography.Text type="secondary">轮间接力已拉起，轮次归集未到（如实占位，不猜数）</Typography.Text>
      )}
      {view.tasks.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <Typography.Text type="secondary">组合 C_k：</Typography.Text>
          <Space size={4} wrap>
            {view.tasks.map((t, i) => (
              <Tag key={i} style={{ fontFamily: "monospace" }}>{taskTool(t)}</Tag>
            ))}
          </Space>
        </div>
      )}
      {children.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <Typography.Text type="secondary">子取证 run（{children.length}）：</Typography.Text>
          <Space size={4} wrap>
            {children.map((c) => (
              <Tag key={c.run_id} color={CHILD_STATUS_COLORS[c.status] ?? "default"}>
                {c.run_id} {c.status}
              </Tag>
            ))}
          </Space>
        </div>
      )}
      {view.hasJudge && judge && (
        <div style={{ marginBottom: 6 }}>
          <Typography.Text type="secondary">judge 裁决：</Typography.Text>
          <Tag color={judge.verdict === "hit" ? "green" : judge.sufficient ? "blue" : "orange"}>
            {String(judge.verdict ?? (judge.sufficient ? "sufficient" : "insufficient"))}
          </Tag>
          {typeof judge.confidence === "number" && (
            <Typography.Text type="secondary">置信 {judge.confidence}</Typography.Text>
          )}
          {typeof judge.gap_description === "string" && judge.gap_description && (
            <Typography.Text type="secondary">· {judge.gap_description}</Typography.Text>
          )}
        </div>
      )}
      {gap && (
        <div>
          <Typography.Text type="secondary">gap 缺口：</Typography.Text>
          <Typography.Text>{gap}</Typography.Text>
        </div>
      )}
    </Card>
  );
}

export default function HuntingPage({ hypothesisId, go }: { hypothesisId?: string; go?: (to: string) => void }) {
  const { session } = useAuth();
  const [rows, setRows] = useState<HypothesisRow[]>([]);
  const [text, setText] = useState("");
  const [templateId, setTemplateId] = useState("");
  // 票 92：模板下拉数据源 = 只读面（GET /api/v1/templates）；空清单/面不可达 = 空下拉
  const [templates, setTemplates] = useState<HuntTemplateRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<HypothesisDetail | null>(null);
  const [views, setViews] = useState<HuntRoundView[]>([]);
  const [caseId, setCaseId] = useState<string | null>(null);
  const [live, setLive] = useState<HuntLiveState>(() => initHuntLive());
  const [sseStatus, setSseStatus] = useState<SseStatus | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);

  const sseRef = useRef<ReconnectingSse | null>(null);
  const selectedRef = useRef<string | null>(null);
  const subscribedRef = useRef<string | null>(null);

  const refreshList = useCallback(() => {
    listHypotheses()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // 票 92：模板清单拉取（只读面）。面病了/未登记 = 空下拉如实降级，页面不炸不猜数。
  useEffect(() => {
    listHuntTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  useEffect(() => () => sseRef.current?.close(), []);

  /** 订阅一条父 run 的 SSE（流水线页同款事件总线客户端；INV-7 补发语义在 ./sse）。 */
  const subscribe = useCallback((runId: string) => {
    sseRef.current?.close();
    subscribedRef.current = runId;
    setActiveRun(runId);
    setLive(initHuntLive());
    const sse = new ReconnectingSse({
      runId,
      retryMs: 300, // 演示窗快退避；补发语义与流水线页同一封装（INV-7）
      onEvent: (ev: SseEvent) => setLive((st) => applyHuntEvent(st, ev)),
      onStatus: (s) => setSseStatus(s),
    });
    sseRef.current = sse;
    sse.open();
  }, []);

  /** 详情 + 审计重建：轮次归集段（权威账面）+ 父 run 锚 → 轮次卡；锚即 SSE 订阅点。
   *  pendingRoundNo：SSE 已见 round_relay 的下一轮（详情归集段未到 → 占位卡）。
   *  opts.resubscribe = 打开详情时强制接流；否则锚变了（多轮推进）才换订阅点。 */
  const reload = useCallback(async (
    id: string,
    opts: { resubscribe?: boolean; pendingRoundNo?: number | null } = {},
  ): Promise<void> => {
    const [d, auditRes] = await Promise.all([
      getHypothesisDetail(id),
      listAudit({ objectId: id }).catch((): AuditEntryLike[] => []),
    ]);
    const entries = auditRes as AuditEntryLike[];
    const anchors = roundRunAnchors(d, entries);
    setDetail(d);
    setViews(rebuildRoundViews(d, entries, { pendingRoundNo: opts.pendingRoundNo ?? null }));
    // 收敛结论（页面映射「收敛结论」行）：Case 挂 hypothesis_id，既有案件查询面反查
    if (d.status === "concluded") {
      listCases()
        .then((cases: CaseRow[]) => setCaseId(findCaseIdByHypothesis(cases, d.id)))
        .catch(() => setCaseId(null));
    } else {
      setCaseId(null);
    }
    // 最新轮锚（轮号最大）= 当前在跑的父 run
    const roundNos = Object.keys(anchors).map(Number).sort((a, b) => a - b);
    const latest = roundNos.length ? anchors[roundNos[roundNos.length - 1]!] ?? null : null;
    if (latest && (opts.resubscribe || subscribedRef.current !== latest)) subscribe(latest);
  }, [subscribe]);

  const openDetail = useCallback((id: string) => {
    selectedRef.current = id;
    setDetail(null);
    setViews([]);
    setCaseId(null);
    sseRef.current?.close();
    sseRef.current = null;
    subscribedRef.current = null;
    setActiveRun(null);
    setSseStatus(null);
    lastSeenIdRef.current = 0;
    setLive(initHuntLive());
    void reload(id, { resubscribe: true }).catch((e) =>
      message.error(`假设详情拉取失败：${e instanceof Error ? e.message : String(e)}`),
    );
  }, [reload]);

  // 案件时间线页「假设」深链（#/hunting?hypothesis_id=…）：进来直接打开该假设
  useEffect(() => {
    if (hypothesisId) openDetail(hypothesisId);
  }, [hypothesisId, openDetail]);

  // 关键帧（账面帧：声明/回归/接力/终态/error）后重取 m2 账面——SSE 只当信号，
  // 轮次数字以详情读面为准；终态收流后按审计锚重建，新轮 run 自动接流（多轮推进，
  // INV-7 恰一次由归约游标保证：重放帧不进 live，lastEventId 不动即不重触发）。
  const lastSeenIdRef = useRef(0);
  useEffect(() => {
    if (!detail || !selectedRef.current) return;
    const id = live.lastEventId;
    if (id === lastSeenIdRef.current) return;
    const prev = lastSeenIdRef.current;
    lastSeenIdRef.current = id;
    const hit = live.log.some((l) => l.id > prev && l.ledger);
    if (!hit) return;
    void reload(selectedRef.current, { pendingRoundNo: live.relayedTo }).catch(() => undefined);
  }, [live, detail, reload]);

  const create = async () => {
    if (!text.trim()) return;
    setCreating(true);
    try {
      const row = await createHypothesis({
        text: text.trim(),
        ...(templateId.trim() ? { templateId: templateId.trim() } : {}),
        actorId: session?.username,
      });
      message.success(`假设已登记（${row.hypothesisId}），编排循环将拉起狩猎 run`);
      setText("");
      setTemplateId("");
      refreshList();
      openDetail(row.hypothesisId);
    } catch (e) {
      message.error(`发起假设失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  /** 人取消（行为约定 12）：仅发起人 + 仅 hunting 态，四因枚举里的 user_cancelled。
   *  409/403（状态机/发起人闸）人话提示——闸的真相方在 m2 端点，页面只如实转述。 */
  const cancel = async (row: HypothesisRow) => {
    try {
      const updated = await cancelHypothesis(row.id, {
        by: session?.username,
        reason: "user_cancelled",
        actorId: session?.username,
      });
      message.success(`已取消（${updated.cancelReason ?? "user_cancelled"}）`);
      refreshList();
      if (selectedRef.current === row.id) void reload(row.id);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : "";
      message.error(`取消失败${status ? `（${status}）` : ""}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const statusMeta = detail ? (HYPOTHESIS_STATUS_META[detail.status as HypothesisStatus] ?? null) : null;
  const lastJudgeVerdict = [...views].reverse().find((v) => v.verdict)?.verdict ?? null;
  const sseLabel = sseStatus ? SSE_STATUS_LABEL[sseStatus] : null;

  return (
    <div>
      {/* ---- ① 发起假设（页面映射「发起假设」行）---- */}
      <Card size="small" title="发起假设" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input.TextArea
            placeholder="假设句（例：攻击者已在 dmz 主机建立 webshell 驻留）"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <Space wrap>
            {/* 票 92：模板选择 = 下拉（数据源 GET /api/v1/templates 只读面），自由文本退位。
                留空 = 机制默认档；下拉项如实带登记面投影的轮次上限，句式族作悬浮提示。 */}
            <Select
              style={{ width: 340 }}
              allowClear
              placeholder="选择模板（可选，留空 = 机制默认档）"
              value={templateId || undefined}
              onChange={(v) => setTemplateId(v ?? "")}
              options={templates.map((t) => ({
                value: t.template_id,
                label: `${t.template_id}（上限 ${t.max_rounds} 轮）`,
                title: t.hypothesis_patterns[0],
              }))}
              notFoundContent="模板清单不可用（未登记/面不可达）— 留空走机制默认档"
            />
            <Button type="primary" disabled={!text.trim()} loading={creating} onClick={create}>
              发起狩猎
            </Button>
            <Typography.Text type="secondary">
              模板下拉走 m14 只读面（票 92）：template_id/句式族/菜单子集/轮次上限由登记面投影；留空 = 机制默认档。
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      {/* ---- 假设列表（页面映射「假设列表」行：五态 Tag）---- */}
      <Table
        size="small"
        style={{ marginBottom: 16 }}
        rowKey="id"
        loading={rows.length === 0 && !detail}
        dataSource={rows}
        pagination={{ pageSize: 5, hideOnSinglePage: true }}
        columns={[
          { title: "假设", dataIndex: "text", ellipsis: true },
          { title: "模板", dataIndex: "templateId", width: 160, render: (v: string) => v || "默认档" },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (s: HypothesisStatus) => {
              const meta = HYPOTHESIS_STATUS_META[s];
              return meta ? <Tag color={meta.color}>{meta.label}</Tag> : <Tag>{s}</Tag>;
            },
          },
          { title: "发起人", dataIndex: "proposedBy", width: 180 },
          {
            title: "操作",
            width: 200,
            render: (_: unknown, row: HypothesisRow) => (
              <Space size={4}>
                <Button size="small" onClick={() => openDetail(row.id)}>查看详情</Button>
                {row.status === "hunting" && (
                  <Popconfirm
                    title="取消这条假设的狩猎？"
                    description="仅发起人可取消、仅狩猎中可取消（INV-10）；停止链会掐停父 run 与在跑子 run。"
                    okText="确认取消"
                    cancelText="再想想"
                    onConfirm={() => void cancel(row)}
                  >
                    <Button size="small" danger>取消狩猎</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />

      {/* ---- ②③④⑤ 详情 + 轮次实时视图 ---- */}
      {detail && (
        <Card size="small" title="假设详情" style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: "100%" }} size={8}>
            <Space wrap>
              {statusMeta && <Tag color={statusMeta.color}>{statusMeta.label}</Tag>}
              <Typography.Text strong>{detail.text}</Typography.Text>
              <Typography.Text type="secondary">
                {detail.templateId ? `模板 ${detail.templateId}` : "默认档"} · 发起人 {detail.proposedBy || "—"}
              </Typography.Text>
              <Typography.Text code>{detail.id}</Typography.Text>
            </Space>

            {detail.status === "cancelled" && detail.cancelReason && (
              <Alert type="warning" showIcon message={`取消原因：${detail.cancelReason}`} />
            )}
            {detail.status === "concluded" && caseId && (
              <Alert
                type="success"
                showIcon
                message={
                  <Space>
                    <span>证据收敛，命中建案：</span>
                    <Button size="small" onClick={() => go?.(`cases?case_id=${caseId}`)}>
                      查看命中案件 {caseId}
                    </Button>
                  </Space>
                }
              />
            )}
            {detail.status === "refuted" && (
              <Alert
                type="info"
                showIcon
                message={`证伪摘要：${lastJudgeVerdict ?? "证据不足以支持假设"}${detail.decidedAt ? `（${new Date(detail.decidedAt).toLocaleString("zh-CN", { hour12: false })} 归档）` : ""}`}
              />
            )}

            <Space wrap>
              {sseLabel && <Badge status={sseLabel.color} text={sseLabel.text} />}
              {activeRun && <Typography.Text code>订阅 run: {activeRun}</Typography.Text>}
              {live.runStatus && <Tag color={live.runStatus === "running" ? "blue" : "default"}>{live.runStatus}</Tag>}
              {live.failed && <Tag color="red">run 出错（看审计与 error 事件）</Tag>}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                实时推进 = SSE 信号帧 + m2 轮次归集读面（账面以详情为准）；断线按游标补发（INV-7）。
              </Typography.Text>
            </Space>

            {views.length === 0 && detail.status === "proposed" && (
              <Empty description="尚未开跑：编排循环拉起 hunt_flow 后，轮次卡会在这里出现" />
            )}
            {views.length > 0 && views.map((v) => <RoundCard key={v.roundNo} view={v} live={live} />)}

            <Typography.Title level={5} style={{ marginBottom: 4 }}>
              事件流（新到在上，封顶 200 条）
            </Typography.Title>
            <div style={{ maxHeight: 240, overflow: "auto" }}>
              <List
                size="small"
                dataSource={live.log}
                locale={{ emptyText: "订阅父 run 后，编排事件在这里滚动" }}
                renderItem={(e) => (
                  <List.Item style={{ padding: "2px 0" }}>
                    <Tag style={{ fontFamily: "monospace" }}>{e.type}</Tag>
                    <span>{e.text}</span>
                    <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      id {e.id}
                    </Typography.Text>
                  </List.Item>
                )}
              />
            </div>
          </Space>
        </Card>
      )}

      {!detail && rows.length === 0 && (
        <Spin tip="加载假设列表…">
          <div style={{ minHeight: 60 }} />
        </Spin>
      )}
    </div>
  );
}
