// 关键组件单测（页面冒烟）：登录页四身份 + 点击走正门登录；告警列表 dedup 标记。
// fetch 全部打桩——组件测试只测「组件把 seam 用对了」，不碰真后端。
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, STORAGE_KEY } from "../auth";
import AlertsPage from "../pages/AlertsPage";
import LoginPage from "../pages/LoginPage";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LoginPage", () => {
  it("渲染四预置身份；点击即正门登录，会话落 localStorage 并回调 onDone", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        session_id: "ses_1",
        token: "a.b",
        username: "soc1@soc.local",
        role: "soc1",
        role_label: "SOC1 分析师",
        visible_tools: ["get_alert"],
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const onDone = vi.fn();
    render(
      <AuthProvider>
        <LoginPage onDone={onDone} />
      </AuthProvider>,
    );
    // 四张脸都在（文案镜像 services/agent/workers/chat/session.ts）
    expect(screen.getByText("SOC1 分析师")).toBeTruthy();
    expect(screen.getByText("值班长（SOC2+）")).toBeTruthy();
    expect(screen.getByText("安全工程师（管理员）")).toBeTruthy();
    expect(screen.getByText("红队（演示）")).toBeTruthy();

    // 第一张卡 = soc1（IDENTITIES 顺序），卡内按钮文案统一是「以此身份登录」
    fireEvent.click(screen.getAllByRole("button", { name: "以此身份登录" })[0]);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/login");
    expect(JSON.parse(init.body)).toEqual({ username: "soc1@soc.local" });
    expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();
  });
});

describe("AlertsPage", () => {
  it("告警表：occurrences>1 显示去重标记；操作列跳流水线带 alert_id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, [
        {
          id: "al_1", title: "ssh 非法用户", source: "wazuh", sourceRef: "168",
          severity: 2, status: "New", verdictAi: null, tags: [], date: 1, lastSeen: 1, occurrences: 1,
        },
        {
          id: "al_2", title: "webshell 落地", source: "wazuh", sourceRef: "554",
          severity: 4, status: "InProgress", verdictAi: "true_positive", tags: [], date: 1, lastSeen: 1, occurrences: 3,
        },
      ]),
    );
    const go = vi.fn();
    render(<AlertsPage go={go} />);

    // dedup 标记：al_2 重复×3，al_1 首次接入
    await waitFor(() => expect(screen.getByText("重复×3")).toBeTruthy());
    expect(screen.getByText("首次接入")).toBeTruthy();
    // verdict_ai 可见
    expect(screen.getByText("true_positive")).toBeTruthy();
    // 回放按钮在（打包 fixture 正门重推）
    expect(screen.getByText("回放 fixtures（重推正门）")).toBeTruthy();

    fireEvent.click(screen.getAllByText("发起分诊")[1]);
    expect(go).toHaveBeenCalledWith("pipeline?alert_id=al_2");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/alerts");
  });
});
