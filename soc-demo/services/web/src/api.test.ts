// API client 测试：fetch 用 vi.stubGlobal 打桩，断言「方法 → 正确的路径/方法/参数体」
// 与错误传播。Web 是薄客户端，它的 seam 就是这几个公开 REST 面（M2/M3/ingest）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, listAlerts, listAudit, login, replayAlert, startRun } from "./api";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  it("login：POST /api/v1/auth/login {username}，解析会话字段", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        session_id: "ses_x",
        token: "a.b",
        username: "soc1@soc.local",
        role: "soc1",
        role_label: "SOC1 分析师",
        visible_tools: ["get_alert"],
        expires_at: 1234,
      }),
    );
    const session = await login("soc1@soc.local");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ username: "soc1@soc.local" });
    // api 层只透传 wire 命名（snake_case）；wire → Session 的映射在 auth.toSession
    expect(session.role).toBe("soc1");
    expect(session.visible_tools).toEqual(["get_alert"]);
    expect(session.expires_at).toBe(1234);
  });

  it("listAlerts：无参 GET /api/v1/alerts；带 status/host 时拼查询串", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, []));
    await listAlerts();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/alerts");

    fetchMock.mockResolvedValueOnce(jsonRes(200, []));
    await listAlerts({ status: "New", host: "web-01" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/alerts?status=New&host=web-01");
  });

  it("listAudit：requestId/objectId 走服务端参数（FR-M10.5 过滤）", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, []));
    await listAudit({ requestId: "rq_1", objectId: "case_1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/audit?requestId=rq_1&objectId=case_1");
  });

  it("startRun：POST /internal/runs {kind, alert_id}，返回 run_id", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(202, { run_id: "run_9" }));
    const out = await startRun("alert_flow", "al_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/internal/runs");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ kind: "alert_flow", alert_id: "al_1" });
    expect(out.runId).toBe("run_9");
  });

  it("replayAlert：把 Wazuh payload POST 进 ingest webhook 正门，回传 dedup", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { alert_id: "al_2", dedup: true }));
    const out = await replayAlert({ rule: { id: "5710" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/webhooks/alerts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ rule: { id: "5710" } });
    expect(out).toEqual({ alertId: "al_2", dedup: true });
  });

  it("非 2xx 抛 ApiError，带 status 与后端 error code", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(404, { error: "not_found" }));
    await expect(startRun("alert_flow", "missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    fetchMock.mockResolvedValueOnce(jsonRes(404, { error: "not_found" }));
    await expect(startRun("alert_flow", "missing")).rejects.toBeInstanceOf(ApiError);
  });
});
