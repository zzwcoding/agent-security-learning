// 登录页（FR-M8.1）：系统不设用户管理（PRD §11 边界），登录 = 四张预置脸选一张。
// 登录响应里的 visible_tools（FR-M8.2 可见性即第一收窄）在头部常驻展示。
import { Alert, Button, Card, Space, Typography, message } from "antd";
import { useState } from "react";
import { useAuth } from "../auth";

// 四预置身份镜像 services/agent/workers/chat/session.ts PRESET_IDENTITIES（演示窗
// 不设用户管理，这张表是它的展示面；后端才是身份真源，陌生脸一律 401）
const IDENTITIES = [
  { username: "soc1@soc.local", label: "SOC1 分析师", desc: "看分诊结果、确认/驳回关单建议" },
  { username: "duty_lead@soc.local", label: "值班长（SOC2+）", desc: "L2 高危动作的审批人" },
  { username: "admin@soc.local", label: "安全工程师（管理员）", desc: "系统管理" },
  { username: "redteam@soc.local", label: "红队（演示）", desc: "越权尝试从正门走，看闸怎么拦" },
];

export default function LoginPage({ onDone }: { onDone: () => void }) {
  const { login } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (username: string) => {
    setBusy(username);
    setError(null);
    try {
      const s = await login(username);
      message.success(`已登录：${s.roleLabel}（可见工具 ${s.visibleTools.length} 件）`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ maxWidth: 960, margin: "48px auto", padding: "0 16px" }}>
      <Typography.Title level={3}>SOC 数字员工 · 选脸登录</Typography.Title>
      <Typography.Paragraph type="secondary">
        教学版会话：不设密码，身份由预置种子给定；登录响应即下发按角色收窄的可见工具清单。
      </Typography.Paragraph>
      {error && (
        <Alert type="error" showIcon message="登录失败" description={error} style={{ marginBottom: 16 }} />
      )}
      <Space wrap size={16}>
        {IDENTITIES.map((it) => (
          <Card
            key={it.username}
            title={it.label}
            style={{ width: 220 }}
            styles={{ body: { minHeight: 120 } }}
          >
            <p style={{ color: "#888", minHeight: 44 }}>{it.desc}</p>
            <Button
              type="primary"
              block
              loading={busy === it.username}
              disabled={busy !== null && busy !== it.username}
              onClick={() => pick(it.username)}
            >
              以此身份登录
            </Button>
          </Card>
        ))}
      </Space>
    </div>
  );
}
