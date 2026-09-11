// 审批卡页（FR-M10.3）：pending 审批列表 + 批准/驳回按钮 + 审批后实时反馈。
// 数据面：GET /api/v1/approvals（m9 卡公开接口，status 走服务端参数）+
// POST .../approve|reject（批准铸 ApprovalToken → resume；驳回不铸票直接跳过动作）。
// 实时反馈两层：2 秒轮询把卡的翻面/执行标记刷回来（审计面无全局 SSE，轮询是
// PRD M10 异常与边界点名的降级正道）；裁决响应里的 run_status 即时提示。
// 并发后到者 409（审批卡是单决媒体，INV-10 仲裁）→ decideErrorText 的人话 + 列表刷新。
import { Alert, Button, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography, Input, Modal, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { decideApproval, listApprovals, type ApprovalCard } from "../api";
import { decideErrorText, mergeApprovals, statusTag } from "../approvals";
import { useAuth } from "../auth";

const POLL_MS = 2000;

function fmtTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "-";
}

export default function ApprovalsPage({ go }: { go: (route: string) => void }) {
  const { session } = useAuth();
  const [cards, setCards] = useState<ApprovalCard[]>([]);
  const [filter, setFilter] = useState<"all" | "pending">("all");
  const [loading, setLoading] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ApprovalCard | null>(null);
  const [reason, setReason] = useState("");
  // 狗粮票 58：审批口令（外部模式 = 椒图 APPROVER_TOKEN，批准人身份由椒图口令证明，
  // 随 approve/reject 走 x-approver-token 头；内部模式留空 → 头不发后端原路径）。
  // 页面级 state，一处组件改动不引状态库。
  const [approverToken, setApproverToken] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await listApprovals(filter === "pending" ? "pending" : undefined);
      setCards((prev) => mergeApprovals(prev, fresh));
    } catch (e) {
      message.error(`拉取审批卡失败：${e instanceof Error ? e.message : String(e)}（agent 未起？）`);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const decide = async (card: ApprovalCard, approve: boolean, why?: string) => {
    setDeciding(card.id);
    try {
      const r = await decideApproval(card.id, {
        approve,
        approver: session?.username ?? "unknown",
        ...(approve ? {} : { reason: why }),
        // 票 58：口令留空不发头（内部模式逐字节现状）；外部模式必填——椒图 401 时
        // decideErrorText 会透出 unauthorized 提示补口令重试
        ...(approverToken.trim() ? { approverToken: approverToken.trim() } : {}),
      });
      message.success(
        `${approve ? "已批准（ApprovalToken 已铸）" : "已驳回"}：run ${r.runId} 状态 → ${r.runStatus ?? "?"}`,
      );
    } catch (e) {
      message.error(decideErrorText(e));
    } finally {
      setDeciding(null);
      await load(); // 无论成败都刷一遍：409 后到者能看到卡已被别人裁决
    }
  };

  const columns: ColumnsType<ApprovalCard> = [
    {
      title: "工具（L2 动作）",
      dataIndex: "tool",
      width: 140,
      render: (t: string, c) => (
        <Tooltip title={`节点 ${c.node} · params_hash ${c.paramsHash}`}>
          <Typography.Text code>{t}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: "参数草稿",
      key: "params",
      ellipsis: true,
      render: (_, c) => (
        <Typography.Text code copyable={{ text: JSON.stringify(c.params) }} style={{ fontSize: 12 }}>
          {JSON.stringify(c.params)}
        </Typography.Text>
      ),
    },
    {
      title: "缘由",
      dataIndex: "reason",
      ellipsis: true,
      render: (v: string | null) => v ?? "-",
    },
    {
      title: "状态",
      key: "status",
      width: 150,
      render: (_, c) => {
        const tag = statusTag(c.status);
        return (
          <Space size={4} wrap>
            <Tag color={tag.color}>{tag.text}</Tag>
            {c.status === "approved" && (
              <Tag color={c.executed ? "green" : "gold"}>{c.executed ? "已执行" : "待执行"}</Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: "关联",
      key: "links",
      width: 200,
      render: (_, c) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => go(`pipeline?run_id=${c.runId}`)}>
            run 流水
          </Button>
          {c.caseId && (
            <Button size="small" type="link" onClick={() => go(`cases?case_id=${c.caseId}`)}>
              案件时间线
            </Button>
          )}
        </Space>
      ),
    },
    {
      title: "提出于",
      dataIndex: "createdAt",
      width: 170,
      render: fmtTime,
    },
    {
      title: "裁决",
      key: "act",
      width: 170,
      render: (_, c) =>
        c.status !== "pending" ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {c.approver ?? "-"} · {fmtTime(c.decidedAt ?? 0)}
          </Typography.Text>
        ) : (
          <Space size={4}>
            <Popconfirm
              title="批准将铸一次性 ApprovalToken 并执行该 L2 动作"
              okText="确认批准"
              cancelText="取消"
              onConfirm={() => void decide(c, true)}
            >
              <Button size="small" type="primary" loading={deciding === c.id}>
                批准
              </Button>
            </Popconfirm>
            <Button
              size="small"
              danger
              loading={deciding === c.id}
              onClick={() => {
                setRejecting(c);
                setReason("");
              }}
            >
              驳回
            </Button>
          </Space>
        ),
    },
  ];

  const pendingCount = cards.filter((c) => c.status === "pending").length;

  return (
    <div>
      <Alert
        style={{ marginBottom: 12 }}
        type={session?.role === "duty_lead" ? "info" : "warning"}
        showIcon={false}
        message={
          session?.role === "duty_lead"
            ? "你是值班长（L2 审批者）。页面上的批准/驳回只是递交决定——执行的唯一依据是 agent 为这张卡铸的一次性 ApprovalToken（INV-9：验签不信文本）。"
            : `当前角色是 ${session?.roleLabel ?? "?"}；L2 审批者是值班长（SOC2+）。按钮不拦你——后端审计会如实记下裁决人（INV-8）。`
        }
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as "all" | "pending")}
          options={[
            { label: "全部", value: "all" },
            { label: "待审批", value: "pending" },
          ]}
        />
        <Button onClick={() => void load()} loading={loading}>
          刷新
        </Button>
        {/* 狗粮票 58：审批口令。外部模式（JIAOTU_GATEWAY_URL）下必填——批准人身份由
            椒图口令证明，soc-demo 只中继不保管；内部模式留空即现状。 */}
        <Input.Password
          placeholder="审批口令（外部模式必填，内部模式留空）"
          value={approverToken}
          onChange={(e) => setApproverToken(e.target.value)}
          style={{ width: 260 }}
          autoComplete="off"
        />
        <Typography.Text type="secondary">
          待审批 {pendingCount} 张 · 每 {POLL_MS / 1000}s 轮询（卡翻面/执行标记自动刷回）
        </Typography.Text>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={loading && cards.length === 0}
        columns={columns}
        dataSource={cards}
        pagination={{ pageSize: 10, showTotal: (n) => `共 ${n} 张` }}
        expandable={{
          expandedRowRender: (c) => (
            <pre style={{ margin: 0, fontSize: 12 }}>
              {JSON.stringify({ run_id: c.runId, params_hash: c.paramsHash, params: c.params }, null, 2)}
            </pre>
          ),
        }}
      />
      <Modal
        title={`驳回 ${rejecting?.tool ?? ""}（驳回不铸票，run 将跳过该动作）`}
        open={rejecting !== null}
        okText="确认驳回"
        cancelText="取消"
        onCancel={() => setRejecting(null)}
        onOk={() => {
          const card = rejecting;
          setRejecting(null);
          if (card) void decide(card, false, reason.trim() || undefined);
        }}
      >
        <Space.Compact style={{ width: "100%" }}>
          <Input
            placeholder="驳回缘由（写进审计与审批卡，INV-8）"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onPressEnter={() => {
              const card = rejecting;
              setRejecting(null);
              if (card) void decide(card, false, reason.trim() || undefined);
            }}
          />
        </Space.Compact>
      </Modal>
    </div>
  );
}
