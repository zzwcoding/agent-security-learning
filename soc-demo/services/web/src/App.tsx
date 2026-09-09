// Web 演示窗（m10）：薄客户端壳 = hash 路由 + 登录闸 + 布局菜单。
// 路由范围锁死（m10 卡）：本票上告警列表/流水线视图/审计流三页，审批卡/案件时间线/
// Eval 结果三页由票 21 收齐；之外不会有任何路由。不引路由库/状态库（2026-09-08 拍板）：
// hash 解析 20 行 + React context 就够，演示窗的复杂度必须留在后端。
import { Button, Layout, Menu, Space, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import AlertsPage from "./pages/AlertsPage";
import AuditPage from "./pages/AuditPage";
import LoginPage from "./pages/LoginPage";
import PipelinePage from "./pages/PipelinePage";

// ---- hash 路由：#/alerts、#/pipeline?alert_id=…、#/audit（支持 ?k=v 传参）----
interface Route {
  name: string;
  params: URLSearchParams;
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [name, qs] = raw.split("?");
  return { name: name || "", params: new URLSearchParams(qs ?? "") };
}

function useHashRoute(): { route: Route; go: (to: string) => void } {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const go = (to: string) => {
    window.location.hash = `#/${to}`;
  };
  return { route, go };
}

const MENU_KEY = { alerts: "alerts", pipeline: "pipeline", audit: "audit" } as const;

function Shell() {
  const { session, logout } = useAuth();
  const { route, go } = useHashRoute();

  if (!session) return <LoginPage onDone={() => go(MENU_KEY.alerts)} />;

  const active = route.name in MENU_KEY ? route.name : MENU_KEY.alerts;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <Typography.Text strong style={{ color: "#fff", fontSize: 16, whiteSpace: "nowrap" }}>
          SOC 数字员工
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[active]}
          onClick={(e) => go(e.key)}
          items={[
            { key: MENU_KEY.alerts, label: "告警列表" },
            { key: MENU_KEY.pipeline, label: "流水线视图" },
            { key: MENU_KEY.audit, label: "审计流" },
          ]}
          style={{ flex: 1, minWidth: 320 }}
        />
        <Space size={12} style={{ whiteSpace: "nowrap" }}>
          <Tooltip
            title={
              session.visibleTools.length
                ? `可见工具：${session.visibleTools.join("、")}`
                : "该角色无可见工具"
            }
          >
            <Typography.Text style={{ color: "#fff" }}>
              {session.roleLabel}（{session.username}）· 可见工具 {session.visibleTools.length} 件
            </Typography.Text>
          </Tooltip>
          <Button size="small" onClick={logout}>
            退出
          </Button>
        </Space>
      </Layout.Header>
      <Layout.Content style={{ padding: 16 }}>
        {active === MENU_KEY.pipeline ? (
          <PipelinePage alertId={route.params.get("alert_id") ?? undefined} />
        ) : active === MENU_KEY.audit ? (
          <AuditPage />
        ) : (
          <AlertsPage go={go} />
        )}
      </Layout.Content>
    </Layout>
  );
}

// 阶段 20.1 跑通：登录 → 告警列表 → 流水线 → 审计流，三页数据全部来自公开 REST + SSE
export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
