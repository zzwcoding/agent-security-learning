// Web 演示窗（m10）：薄客户端壳 = hash 路由 + 登录闸 + 布局菜单。
// 路由范围锁死（m10 卡·决策 #6）：六个路由（ROUTES 唯一事实来源，routes.ts），
// 之外不会有任何路由——菜单由表生成、页面开关由表驱动、快照断言在 routes.test.ts。
// 不引路由库/状态库（2026-09-08 拍板）：hash 解析 20 行 + React context 就够，
// 演示窗的复杂度必须留在后端。
import { Button, Layout, Menu, Space, Tooltip, Typography } from "antd";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import AlertsPage from "./pages/AlertsPage";
import ApprovalsPage from "./pages/ApprovalsPage";
import AuditPage from "./pages/AuditPage";
import CasePage from "./pages/CasePage";
import EvalPage from "./pages/EvalPage";
import LoginPage from "./pages/LoginPage";
import PipelinePage from "./pages/PipelinePage";
import { isRouteName, parseHash, ROUTES, type RouteName } from "./routes";

function useHashRoute(): { route: ReturnType<typeof parseHash>; go: (to: string) => void } {
  const [route, setRoute] = useState<ReturnType<typeof parseHash>>(parseHash);
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

const DEFAULT_ROUTE: RouteName = "alerts";

function Shell() {
  const { session, logout } = useAuth();
  const { route, go } = useHashRoute();

  if (!session) return <LoginPage onDone={() => go(DEFAULT_ROUTE)} />;

  // 表外名字一律兜底回告警列表：六页面之外无路由的渲染面最后一道锁
  const active = isRouteName(route.name) ? route.name : DEFAULT_ROUTE;
  const param = (k: string): string | undefined => route.params.get(k) ?? undefined;

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
          items={ROUTES.map((r) => ({ key: r.key, label: r.label }))}
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
        {active === "pipeline" && <PipelinePage alertId={param("alert_id")} runId={param("run_id")} />}
        {active === "approvals" && <ApprovalsPage go={go} />}
        {active === "cases" && <CasePage caseId={param("case_id")} alertId={param("alert_id")} />}
        {active === "audit" && <AuditPage />}
        {active === "eval" && <EvalPage />}
        {active === "alerts" && <AlertsPage go={go} />}
      </Layout.Content>
    </Layout>
  );
}

// 阶段 21 跑通：登录 → 六页面全齐（告警/流水线/审批卡/案件时间线/审计流/Eval），
// 数据全部来自公开 REST + SSE + 静态产物，无 Web 特权接口
export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
