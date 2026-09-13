// API client 测试：fetch 用 vi.stubGlobal 打桩，断言「方法 → 正确的路径/方法/参数体」
// 与错误传播。Web 是薄客户端，它的 seam 就是这几个公开 REST 面（M2/M3/ingest）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, decideApproval, fetchEvalReport, findCaseIdByAlert, listAlerts, listApprovals,
  listAudit, listHuntTemplates, login, replayAlert, startRun,
} from "./api";

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

  it("startRun 带 actorId：x-actor-id 头随行（票 39 确认人进审计，INV-8）", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(202, { run_id: "run_c1" }));
    await startRun("close_flow", "al_1", { actorId: "soc1@soc.local" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ kind: "close_flow", alert_id: "al_1" });
    expect(init.headers).toMatchObject({ "x-actor-id": "soc1@soc.local" });
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

describe("api client · 审批卡/案件/Eval（票 21）", () => {
  it("listApprovals：GET /api/v1/approvals?status=pending，wire snake → 卡片命名", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        approvals: [
          {
            id: "apr_1", run_id: "run_1", node: "execute_action", tool: "isolate_host",
            params: { host: "centos7" }, params_hash: "h1", case_id: "case_000001",
            reason: "建议遏制", status: "pending", approver: null, reject_reason: null,
            executed: false, created_at: 100, decided_at: null,
          },
        ],
      }),
    );
    const cards = await listApprovals("pending");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/approvals?status=pending");
    expect(cards[0]).toMatchObject({ id: "apr_1", runId: "run_1", caseId: "case_000001", executed: false });
    // 不带 status：拉全量（时间线页要把案件的已裁决卡也拼进时间线）
    fetchMock.mockResolvedValueOnce(jsonRes(200, { approvals: [] }));
    await listApprovals();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/approvals");
  });

  it("decideApproval：approve/reject 两路 POST，approver 必填进 body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { approval_id: "apr_1", approval_token: "tok", run_id: "run_1", run_status: "completed" }),
    );
    const ok = await decideApproval("apr_1", { approve: true, approver: "duty_lead@soc.local" });
    let [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/approvals/apr_1/approve");
    expect(JSON.parse(init.body)).toEqual({ approver: "duty_lead@soc.local" });
    expect(ok).toMatchObject({ runId: "run_1", runStatus: "completed", approvalToken: "tok" });

    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { approval_id: "apr_1", decision: "rejected", run_id: "run_1", run_status: "completed" }),
    );
    await decideApproval("apr_1", { approve: false, approver: "duty_lead@soc.local", reason: "证据不足" });
    [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/v1/approvals/apr_1/reject");
    expect(JSON.parse(init.body)).toEqual({ approver: "duty_lead@soc.local", reason: "证据不足" });
  });

  it("decideApproval 带 approverToken：x-approver-token 头随行；留空则头不发（狗粮票 58）", async () => {
    // 外部模式：口令进头不进体（椒图 g4 只认 X-Approver-Token 头）；api 层原样透传
    //（trim 是 ApprovalsPage 的职责）
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { approval_id: "apr_1", approval_token: "tok", run_id: "run_1", run_status: "awaiting_approval" }),
    );
    await decideApproval("apr_1", { approve: true, approver: "duty_lead@soc.local", approverToken: "demo-pass" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "x-approver-token": "demo-pass",
    });
    expect(JSON.parse(init.body)).toEqual({ approver: "duty_lead@soc.local" }); // 口令不进 body

    // 内部模式：留空 → 头不发（后端原路径不变）
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { approval_id: "apr_1", decision: "rejected", run_id: "run_1", run_status: "completed" }),
    );
    await decideApproval("apr_1", { approve: false, approver: "duty_lead@soc.local" });
    const [, plain] = fetchMock.mock.calls[1];
    expect(plain.headers).toEqual({ "content-type": "application/json" });
  });

  it("findCaseIdByAlert：在 linkedAlerts 里反查案件 id；找不到返回 null", () => {
    const cases = [
      { id: "case_000001", number: 1, title: "t", severity: 2, status: "Open", linkedAlerts: ["al_1"], startDate: 1, hypothesisId: null },
      { id: "case_000002", number: 2, title: "t", severity: 3, status: "Open", linkedAlerts: ["al_2", "al_3"], startDate: 2, hypothesisId: null },
    ];
    expect(findCaseIdByAlert(cases, "al_3")).toBe("case_000002");
    expect(findCaseIdByAlert(cases, "al_404")).toBeNull();
  });

  it("fetchEvalReport：读 vite 静态面 /eval-results/latest.json（与磁盘路径同 URL）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        run_at: "2026-09-09T00:00:00Z", lane: "unit-injected",
        totals: { cases: 11, ran: 11, passed: 11, failed: 0, skipped: 0 },
        triage_accuracy: 1,
        defense_interception: {
          by_face: { alert_injection: { total: 1, intercepted: 1, rate: 1 } },
          by_facet: { guard_scan: 1, behavior_gate: 0, review_reject: 0, sandbox_boundary: 0 },
          skipped: [], note: "口径",
        },
        costs: { csv: "eval-results/cost_all.csv", rows: 1, note: "口径" },
        judge: { evaluable_cases: 0, avg_score: null, note: "" }, cases: [],
      }),
    );
    const report = await fetchEvalReport();
    expect(fetchMock.mock.calls[0][0]).toBe("/eval-results/latest.json");
    expect(report.triage_accuracy).toBe(1);
    // 票 29 契约形状（旧幽灵键 attack_block_rate 已删）：防线拦截率 + 成本口径可读
    expect(report.defense_interception?.by_face.alert_injection.rate).toBe(1);
    expect(report.costs?.csv).toBe("eval-results/cost_all.csv");
  });
});

// ---- 票 92：模板清单只读面（services/agent GET /api/v1/templates）----
// 狩猎页模板下拉的数据源；wire = 登记面投影行（字段名照模板文件原样，薄客户端零加工）。

describe("api client · 模板清单（票 92）", () => {
  it("listHuntTemplates：GET /api/v1/templates，投影行字段名照模板文件原样透传", async () => {
    const rows = [
      {
        template_id: "hunt_c2_beacon",
        hypothesis_patterns: ["怀疑主机 {host} 存在 C2 心跳：外联目的 {dst_ip} 出现周期性信标。"],
        menu: ["playbook_lookup", "graph_query"],
        max_rounds: 6,
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonRes(200, { templates: rows }));
    const out = await listHuntTemplates();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/templates");
    expect(out).toEqual(rows); // 零加工：读出即透传（薄客户端）
  });

  it("listHuntTemplates：响应缺 templates 键 → 空数组（未登记 = 空清单口径，不报错）", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, {}));
    expect(await listHuntTemplates()).toEqual([]);
  });

  it("listHuntTemplates：面病了原样抛 ApiError（降级决策在页面，不在客户端吞错）", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(500, { error: "internal_error" }));
    await expect(listHuntTemplates()).rejects.toBeInstanceOf(ApiError);
  });
});
