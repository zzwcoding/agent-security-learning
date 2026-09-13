// 关键组件单测（页面冒烟）：登录页四身份 + 点击走正门登录；告警列表 dedup 标记；
// 票 21 三页（审批卡/案件时间线/Eval）+ App 壳路由快照兜底。
// fetch 全部打桩——组件测试只测「组件把 seam 用对了」，不碰真后端。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, STORAGE_KEY } from "../auth";
import type { AuditEntryLike } from "../hunting";
import AlertsPage from "../pages/AlertsPage";
import ApprovalsPage from "../pages/ApprovalsPage";
import CasePage from "../pages/CasePage";
import EvalPage from "../pages/EvalPage";
import HuntingPage from "../pages/HuntingPage";
import LoginPage from "../pages/LoginPage";
import App from "../App";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

// vitest 未开 globals → RTL 的自动 cleanup 不生效，显式拆（否则 body 里 DOM 越堆越多，
// screen 全局查询会撞上上一条用例的残留）
afterEach(() => {
  cleanup();
  window.location.hash = "";
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
          // verdict_ai 的真实 wire 形状 = worker 的原始判定对象（短标签），页面要归一渲染
          id: "al_2", title: "webshell 落地", source: "wazuh", sourceRef: "554",
          severity: 4, status: "InProgress",
          verdictAi: { verdict: "tp", confidence: 0.85, rationale: "攻击证据成立" },
          tags: [], date: 1, lastSeen: 1, occurrences: 3,
        },
      ]),
    );
    const go = vi.fn();
    // 票 39 起 AlertsPage 读登录态（确认关单按钮按角色/建议显隐）——挂上 AuthProvider
    render(
      <AuthProvider>
        <AlertsPage go={go} />
      </AuthProvider>,
    );

    // dedup 标记：al_2 重复×3，al_1 首次接入
    await waitFor(() => expect(screen.getByText("重复×3")).toBeTruthy());
    expect(screen.getByText("首次接入")).toBeTruthy();
    // verdict 对象里的短标签归一渲染（不崩、不显示 [object Object]）
    expect(screen.getByText("tp")).toBeTruthy();
    // 回放按钮在（打包 fixture 正门重推）
    expect(screen.getByText("回放 fixtures（重推正门）")).toBeTruthy();

    fireEvent.click(screen.getAllByText("发起分诊")[1]);
    expect(go).toHaveBeenCalledWith("pipeline?alert_id=al_2");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/alerts");
  });
});

// ---- 票 39：SOC1 一键确认关单（FR-M4.5·G2-7）----

// ReconnectingSse 缺省工厂用全局 EventSource——测试里换 FakeES（与 sse.test.ts 同款），
// 并把实例攒下来由用例驱动「SSE 补发终态事件」。
class FakeES {
  readyState = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((ev: { data: string; lastEventId: string }) => void)[]>();

  constructor(public url: string) {
    FakeES.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: { data: string; lastEventId: string }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, id: number, payload: Record<string, unknown> = {}): void {
    this.listeners.get(type)?.forEach((cb) =>
      cb({ data: JSON.stringify({ type, ...payload }), lastEventId: String(id) }),
    );
  }
}

function primeRoleSession(role: string, username: string, roleLabel: string): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      token: "a.b",
      sessionId: "ses_1",
      username,
      role,
      roleLabel,
      visibleTools: ["close_alert"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

// fp + close 建议的一条告警（verdict_ai wire 形状照 worker outcome 写回）
const FP_ALERT = {
  id: "al_fp", title: "Web server 500 error code (CGI Error).", source: "wazuh", sourceRef: "31103",
  severity: 2, status: "New",
  verdictAi: { verdict: "fp", confidence: 0.75, rationale: "运维噪声", recommended_action: "close" },
  tags: [], date: 1, lastSeen: 1, occurrences: 1,
};

describe("AlertsPage 一键确认关单（票 39）", () => {
  beforeEach(() => {
    FakeES.instances = [];
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  });

  it("soc1 对带 close 建议的告警看到确认按钮；确认 → POST close_flow 带 x-actor-id，SSE 终态成功提示", async () => {
    primeRoleSession("soc1", "soc1@soc.local", "SOC1 分析师");
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/v1/alerts") return Promise.resolve(jsonRes2(200, [FP_ALERT]));
      if (u === "/internal/runs") {
        expect(JSON.parse(String(init!.body))).toEqual({ kind: "close_flow", alert_id: "al_fp" });
        expect(init!.headers).toMatchObject({ "x-actor-id": "soc1@soc.local" });
        return Promise.resolve(jsonRes2(202, { run_id: "run_c1" }));
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <AlertsPage go={() => {}} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("确认关单")).toBeTruthy());

    fireEvent.click(screen.getByText("确认关单"));
    fireEvent.click(await screen.findByText("确认执行关单"));

    // run 拉起后页面订阅该 run 的 SSE（INV-7 同一落盘总线）
    await waitFor(() => expect(FakeES.instances.some((es) => es.url.includes("run_id=run_c1"))).toBe(true));
    // 后端同步执行已终态：SSE 补发的 audit 镜像宣告 completed → 成功人话 + 列表刷新
    const es = FakeES.instances.find((x) => x.url.includes("run_id=run_c1"))!;
    es.onopen?.();
    es.emit("audit", 7, { action: "update", status: { from: "running", to: "completed" } });

    await screen.findByText(/关单完成/);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/v1/alerts").length).toBeGreaterThanOrEqual(2),
    );
  });

  it("run 失败路径：error 事件 → 人话提示（409/已关语义），不弹原始错误", async () => {
    primeRoleSession("soc1", "soc1@soc.local", "SOC1 分析师");
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/alerts") return Promise.resolve(jsonRes2(200, [FP_ALERT]));
      if (u === "/internal/runs") return Promise.resolve(jsonRes2(202, { run_id: "run_x" }));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <AlertsPage go={() => {}} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("确认关单")).toBeTruthy());
    fireEvent.click(screen.getByText("确认关单"));
    fireEvent.click(await screen.findByText("确认执行关单"));

    await waitFor(() => expect(FakeES.instances.some((es) => es.url.includes("run_id=run_x"))).toBe(true));
    const es = FakeES.instances.find((x) => x.url.includes("run_id=run_x"))!;
    es.onopen?.();
    es.emit("error", 3, { code: "node_error", node: "execute_close", message: "m2_close_failed:InvalidTransition" });

    await screen.findByText(/409/);
  });

  it("redteam 看不到确认按钮（A.2：close_alert 属案件写入族，红队全 —）", async () => {
    primeRoleSession("redteam", "redteam@soc.local", "红队（演示）");
    fetchMock.mockImplementation((url: string) => {
      if (String(url) === "/api/v1/alerts") return Promise.resolve(jsonRes2(200, [FP_ALERT]));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <AlertsPage go={() => {}} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("发起分诊")).toBeTruthy());
    expect(screen.queryByText("确认关单")).toBeNull();
  });

  it("没有关单建议的告警（tp/human）不出现确认按钮", async () => {
    primeRoleSession("soc1", "soc1@soc.local", "SOC1 分析师");
    fetchMock.mockImplementation((url: string) => {
      if (String(url) === "/api/v1/alerts") {
        return Promise.resolve(
          jsonRes2(200, [
            {
              ...FP_ALERT,
              id: "al_tp",
              verdictAi: { verdict: "tp", confidence: 0.85, rationale: "攻击证据", recommended_action: "create_case" },
            },
          ]),
        );
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <AlertsPage go={() => {}} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("发起分诊")).toBeTruthy());
    expect(screen.queryByText("确认关单")).toBeNull();
  });
});

// ---- 票 21：审批卡 / 案件时间线 / Eval / App 壳路由快照 ----

const enc = new TextEncoder();

function sseResponse(frames: string): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(frames));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function jsonRes2(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// wire 形状照 agent approvals.ts toWire()；类型放宽为 wire 字典（状态字段测试里会翻面）
const PENDING_CARD: Record<string, unknown> = {
  id: "apr_1", run_id: "run_9", node: "execute_action", tool: "isolate_host",
  params: { host: "centos7" }, params_hash: "h1", case_id: "case_000001",
  reason: "调查报告建议遏制", status: "pending", approver: null, reject_reason: null,
  executed: false, created_at: 100, decided_at: null,
};

function primeSession(username = "duty_lead@soc.local"): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      token: "a.b",
      sessionId: "ses_1",
      username,
      role: username.startsWith("duty") ? "duty_lead" : "soc1",
      roleLabel: username.startsWith("duty") ? "值班长（SOC2+）" : "SOC1 分析师",
      visibleTools: ["isolate_host"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

describe("ApprovalsPage", () => {
  it("pending 列表可见；批准 → POST approve 带 approver，卡翻成已批准", async () => {
    primeSession();
    let card = PENDING_CARD;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/approvals") {
        return Promise.resolve(jsonRes2(200, { approvals: [card] }));
      }
      if (u === "/api/v1/approvals/apr_1/approve") {
        card = { ...card, status: "approved", approver: "duty_lead@soc.local", decided_at: 200 };
        return Promise.resolve(
          jsonRes2(200, { approval_id: "apr_1", approval_token: "t.b.c", run_id: "run_9", run_status: "completed" }),
        );
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <ApprovalsPage go={() => {}} />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByText("isolate_host")).toBeTruthy());
    // 「待审批」在 Segmented 选项和状态 Tag 里各出现一次，断言卡片状态 Tag 在即可
    expect(screen.getAllByText("待审批").length).toBeGreaterThanOrEqual(1);

    // antd v5 会对两字按钮文案自动插空格（批准 → "批 准"），按渲染后的文本查
    fireEvent.click(screen.getByText("批 准"));
    fireEvent.click(await screen.findByText("确认批准"));

    await waitFor(() => expect(screen.getByText("已批准")).toBeTruthy());
    const approveCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/approve"));
    expect(approveCall).toBeTruthy();
    expect(JSON.parse(approveCall![1]!.body)).toEqual({ approver: "duty_lead@soc.local" });
  });

  it("并发后到者 409：人话提示出现，列表刷新（卡被别人裁决）", async () => {
    const card = PENDING_CARD;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/approvals") return Promise.resolve(jsonRes2(200, { approvals: [card] }));
      if (u === "/api/v1/approvals/apr_1/reject") {
        // 后到者：真仲裁（statemachine INV-10）给 409
        return Promise.resolve(jsonRes2(409, { error: "InvalidTransition" }));
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <ApprovalsPage go={() => {}} />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isolate_host")).toBeTruthy());

    fireEvent.click(screen.getByText("驳 回"));
    fireEvent.change(await screen.findByPlaceholderText("驳回缘由（写进审计与审批卡，INV-8）"), {
      target: { value: "证据不足" },
    });
    fireEvent.click(screen.getByText("确认驳回"));

    // antd message 会把 decideErrorText 的 409 文案挂到 body 上
    await screen.findByText(/409/);
    // 卡保持 pending（后端没改状态），页面还在
    expect(screen.getAllByText("待审批").length).toBeGreaterThanOrEqual(1);
  });
});

describe("CasePage", () => {
  const DETAIL = {
    id: "case_000001", number: 1, title: "[ssh] - centos7 - 2026-09-01",
    description: "", severity: 3, tlp: 2, pap: 2, status: "Open",
    verdict: null, verdictNote: null, assignee: null, tags: [],
    linkedAlerts: ["al_1"], startDate: 100, endDate: null, intakeSource: "auto_pipeline",
    observables: [],
    timeline: [
      { id: "t1", case_id: "case_000001", kind: "system", author: "system", body: "case created from alert al_1", structured: null, created_at: 100 },
      {
        id: "t2", case_id: "case_000001", kind: "enrichment_report", author: "agent:enrichment",
        body: "## 富化报告", structured: { results: [{ ok: true, level: "malicious" }, { ok: false, refused: "tlp" }] },
        created_at: 300,
      },
    ],
  };

  it("详情 + 时间线装配（系统/富化四档标签/审批条目）", async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/cases") return Promise.resolve(jsonRes2(200, [DETAIL]));
      if (u === "/api/v1/cases/case_000001") return Promise.resolve(jsonRes2(200, DETAIL));
      if (u === "/api/v1/approvals") {
        return Promise.resolve(
          jsonRes2(200, {
            approvals: [
              { ...PENDING_CARD, status: "approved", approver: "duty_lead@soc.local", decided_at: 500, executed: true },
            ],
          }),
        );
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <CasePage caseId="case_000001" />
      </AuthProvider>,
    );
    // 标题同时出现在案件选择器与详情段落里，断言至少渲染出来
    await waitFor(() => expect(screen.getAllByText(/centos7 - 2026-09-01/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText(/case created from alert al_1/)).toBeTruthy();
    expect(screen.getByText(/isolate_host 已批准/)).toBeTruthy();
    expect(screen.getByText(/一次性 token 用后即焚/)).toBeTruthy();
    // 富化四档标签来自 structured.results
    expect(screen.getByText("malicious")).toBeTruthy();
    expect(screen.getByText("refused")).toBeTruthy();
  });

  it("对话追问入口：POST /api/v1/chat 带 Bearer 与 case_id，token 帧拼答案", async () => {
    primeSession();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/v1/cases") return Promise.resolve(jsonRes2(200, [DETAIL]));
      if (u === "/api/v1/cases/case_000001") return Promise.resolve(jsonRes2(200, DETAIL));
      if (u === "/api/v1/approvals") return Promise.resolve(jsonRes2(200, { approvals: [] }));
      if (u === "/api/v1/chat") {
        expect(JSON.parse(String(init!.body))).toEqual({ message: "这个案子查了什么？", case_id: "case_000001" });
        expect(init!.headers).toMatchObject({ authorization: "Bearer a.b" });
        return Promise.resolve(
          sseResponse('event: token\ndata: {"delta":"查了 ssh 爆破 "}\n\nevent: token\ndata: {"delta":"日志"}\n\nevent: done\ndata: {}\n\n'),
        );
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <CasePage caseId="case_000001" />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("对话追问（Copilot）")).toBeTruthy());
    fireEvent.click(screen.getByText("对话追问（Copilot）"));

    const input = await screen.findByPlaceholderText("追问一句（案件上下文自动带上）");
    fireEvent.change(input, { target: { value: "这个案子查了什么？" } });
    fireEvent.click(screen.getByText("发 送")); // antd 两字按钮自动插空格

    await waitFor(() => expect(screen.getByText(/查了 ssh 爆破 日志/)).toBeTruthy());
  });

  // 票 49：脱敏占位符的反查入口——文本里有 <TYPE> 占位符 + duty_lead/admin 登录，
  // 才出「反查 PII」按钮；点击带会话 Bearer 调 agent 端点，原文就地渲染。
  const PII_DETAIL = {
    ...DETAIL,
    timeline: [
      ...DETAIL.timeline,
      {
        id: "t3", case_id: "case_000001", kind: "investigation_report", author: "agent:investigation",
        body: "告警涉及邮箱 <EMAIL_ADDRESS> 与手机 <PHONE_NUMBER>，建议人工核实。",
        structured: null, created_at: 400,
      },
    ],
  };

  function mockCaseData(): void {
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/cases") return Promise.resolve(jsonRes2(200, [PII_DETAIL]));
      if (u === "/api/v1/cases/case_000001") return Promise.resolve(jsonRes2(200, PII_DETAIL));
      if (u === "/api/v1/approvals") return Promise.resolve(jsonRes2(200, { approvals: [] }));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });
  }

  it("duty_lead 对含占位符的时间线看到反查按钮；点击带 Bearer 反查并就地显示原文", async () => {
    primeRoleSession("duty_lead", "duty_lead@soc.local", "值班长（SOC2+）");
    mockCaseData();
    render(
      <AuthProvider>
        <CasePage caseId="case_000001" />
      </AuthProvider>,
    );
    const btn = await screen.findByRole("button", { name: "反查 PII" });
    expect(btn).toBeTruthy();
    // 没有占位符的普通条目不出按钮（检测驱动，不猜）
    expect(screen.getAllByRole("button", { name: "反查 PII" })).toHaveLength(1);

    const originals: Record<string, string> = {
      "<EMAIL_ADDRESS>": "zhangsan@example.com",
      "<PHONE_NUMBER>": "13812345678",
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/v1/pii/reveal") {
        expect(init!.headers).toMatchObject({ authorization: "Bearer a.b" });
        const { placeholder } = JSON.parse(String(init!.body)) as { placeholder: string };
        return Promise.resolve(jsonRes2(200, { placeholder, originals: [originals[placeholder]] }));
      }
      if (u === "/api/v1/cases") return Promise.resolve(jsonRes2(200, [PII_DETAIL]));
      if (u === "/api/v1/cases/case_000001") return Promise.resolve(jsonRes2(200, PII_DETAIL));
      if (u === "/api/v1/approvals") return Promise.resolve(jsonRes2(200, { approvals: [] }));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });
    fireEvent.click(btn);
    await screen.findByText(/<EMAIL_ADDRESS> → zhangsan@example.com/);
    expect(screen.getByText(/<PHONE_NUMBER> → 13812345678/)).toBeTruthy();
  });

  it("soc1 看不到反查按钮（可见性即第一收窄；闸兜底在 agent 端点）", async () => {
    primeRoleSession("soc1", "soc1@soc.local", "SOC1 分析师");
    mockCaseData();
    render(
      <AuthProvider>
        <CasePage caseId="case_000001" />
      </AuthProvider>,
    );
    await screen.findByText(/case created from alert al_1/);
    expect(screen.queryByRole("button", { name: "反查 PII" })).toBeNull();
  });
});

describe("EvalPage", () => {
  it("最近一次跑分三维真渲染：准确率 / 攻击面拦截率分面 + skipped 口径 / 成本合计", async () => {
    fetchMock.mockImplementation((url: string) => {
      expect(String(url)).toBe("/eval-results/latest.json");
      return Promise.resolve(
        jsonRes2(200, {
          run_at: "2026-09-09T00:02:06.390Z",
          lane: "unit-injected",
          tested_model: "FakeTriageLlm（单测级注入，确定性）",
          totals: { cases: 11, ran: 11, passed: 11, failed: 0, skipped: 0 },
          triage_accuracy: 1,
          defense_interception: {
            by_face: {
              alert_injection: { total: 2, intercepted: 2, rate: 1 },
              chat_injection: { total: 3, intercepted: 1, rate: 1 / 3 },
            },
            by_facet: { guard_scan: 2, behavior_gate: 1, review_reject: 0, sandbox_boundary: 0 },
            skipped: ["attack/09_sandbox: msb 不可用"],
            note: "拦截率=ran 攻击用例上 intercepted 占比；环境 skip 显式留痕不计入分母",
          },
          costs: { csv: "eval-results/cost_all.csv", rows: 5, note: "口径" },
          judge: { evaluable_cases: 0, avg_score: null, note: "judge 分数不进门禁（PRD 决策 #7）" },
          cases: [
            { fullName: "triage/01_ssh_bruteforce_tp", domain: "triage", ran: true, passed: true, toolCalls: 4, tokens: 64, durationMs: 123 },
          ],
        }),
      );
    });

    render(<EvalPage />);
    // 准确率 100% 与告警注入拦截率 100% 各渲染一处
    await waitFor(() => expect(screen.getAllByText("100%").length).toBe(2));
    // 攻击面拦截率真渲染：分面率 + 拦得几次的分母 + 拦截方式计数 + skipped 留痕
    expect(screen.getByText("告警注入拦截率")).toBeTruthy();
    expect(screen.getByText("（2/2）")).toBeTruthy();
    expect(screen.getByText("对话注入拦截率")).toBeTruthy();
    expect(screen.getByText("（1/3）")).toBeTruthy();
    expect(screen.getByText("扫描拦 D2 2")).toBeTruthy();
    expect(screen.getByText("行为兜底 403/无票 1")).toBeTruthy();
    expect(screen.getByText(/skip 1 例不计入/)).toBeTruthy();
    // 成本口径与逐用例表
    expect(screen.getByText(/cost_all.csv 5 行/)).toBeTruthy();
    expect(screen.getByText("triage/01_ssh_bruteforce_tp")).toBeTruthy();
    expect(screen.getByText(/judge 分数不进门禁/)).toBeTruthy();
  });

  it("票 91：latest.json 带紫队加性段 → 页面小节展示自主发现率（5/11 形态）+ 盲区聚类摘要", async () => {
    fetchMock.mockImplementation((url: string) => {
      expect(String(url)).toBe("/eval-results/latest.json");
      return Promise.resolve(
        jsonRes2(200, {
          run_at: "2026-09-09T00:02:06.390Z",
          lane: "unit-injected",
          totals: { cases: 33, ran: 33, passed: 33, failed: 0, skipped: 0 },
          triage_accuracy: 1,
          judge: { evaluable_cases: 0, avg_score: null, note: "" },
          cases: [],
          purple: {
            discovered: 5,
            fixtures: 11,
            discovery_rate: 5 / 11,
            per_fixture: [
              { fixture: "02_inject_full_log_tp", family: "ir_host_compromise", expected: "hit", discovered: true },
            ],
            blind_spots: [
              {
                family: "credential_leak",
                misses: 4,
                discovered: 0,
                fixtures: ["01_inject_srcuser_uncertain", "05_rag_poison_rejected"],
                missing_dimensions: ["auth 探测维缺失：5710/5712 失败登录聚源查询。"],
              },
            ],
            weakest_family: "credential_leak",
          },
        }),
      );
    });
    render(<EvalPage />);
    // 自主发现率 5/11 形态 + 百分比
    await waitFor(() => expect(screen.getByText("自主发现率（紫队闭环）")).toBeTruthy());
    expect(screen.getByText("45%")).toBeTruthy();
    expect(screen.getByText("（5/11）")).toBeTruthy();
    // 盲区聚类摘要：最弱族 + 逐族 miss 数 + 未发现例 + 该补的工具维度
    expect(screen.getByText("credential_leak")).toBeTruthy();
    expect(screen.getByText(/最弱假设族/)).toBeTruthy();
    expect(screen.getByText(/盲区聚类 credential_leak/)).toBeTruthy();
    expect(screen.getByText(/4 例未发现/)).toBeTruthy();
    expect(screen.getByText(/auth 探测维缺失/)).toBeTruthy();
  });

  it("旧产物没有 defense_interception：攻击面如实标未产出，不猜数", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonRes2(200, {
          run_at: "2026-09-09T00:02:06.390Z",
          lane: "unit-injected",
          totals: { cases: 11, ran: 11, passed: 11, failed: 0, skipped: 0 },
          triage_accuracy: 1,
          judge: { evaluable_cases: 0, avg_score: null, note: "" },
          cases: [],
        }),
      ),
    );
    render(<EvalPage />);
    await waitFor(() => expect(screen.getByText("未产出")).toBeTruthy());
    expect(screen.getByText(/defense_interception 由 m11 攻击维用例产出/)).toBeTruthy();
  });
});

// ---- 票 82：狩猎页（假设 CRUD + 轮次视图实时推进 + 断线重建）----

// wire 照 case-backend mapHypothesis/mapRound + orchestration/audit-log 五要素条目
const HYP_LIST = [
  {
    id: "hyp_p", hypothesis_id: "hyp_p", template_id: "", text: "占位：新提出的假设", status: "proposed",
    proposed_by: "soc1@soc.local", cancel_reason: null, created_at: 10, decided_at: null,
  },
  {
    id: "hyp_h", hypothesis_id: "hyp_h", template_id: "hunt_webshell", text: "攻击者已建立 webshell 驻留", status: "hunting",
    proposed_by: "soc1@soc.local", cancel_reason: null, created_at: 20, decided_at: null,
  },
  {
    id: "hyp_c", hypothesis_id: "hyp_c", template_id: "hunt_c2_beacon", text: "C2 信标外连", status: "concluded",
    proposed_by: "soc1@soc.local", cancel_reason: null, created_at: 30, decided_at: 90,
  },
];

const HYP_DETAIL_HUNTING = {
  ...HYP_LIST[1],
  rounds: [
    {
      round_no: 1,
      tasks: [{ tool: "playbook_lookup", params: { q: "webshell" }, rationale: "首轮" }],
      children: [{ run_id: "run_c1", status: "completed" }],
      judge: { sufficient: false, verdict: null, confidence: 0.4, gap_description: "证据不足" },
      gap: { gap_description: "证据不足", unknown: "驻留是否仍在", suggested_focus: ["web_access_query"] },
      created_at: 40,
    },
  ],
};

// 审计锚：audit-log.ts requestId = hunt_<run_id>，outcome 五要素 details.run_id
const HYP_AUDIT_R1: AuditEntryLike[] = [
  {
    id: "a2", action: "hunt_round_outcome", actor: { type: "agent", id: "agent:hunt_flow" },
    objectType: "hypothesis", objectId: "hyp_h",
    details: { round_no: 1, run_id: "run_r1", relayed: false },
    requestId: "hunt_run_r1", result: "SUCCESS", createdAt: 50,
  },
];

function mockHuntBase(overrides: {
  list?: unknown[];
  detail?: unknown;
  audit?: unknown[];
  detailUrl?: string;
} = {}): void {
  const list = overrides.list ?? HYP_LIST;
  const detail = overrides.detail ?? HYP_DETAIL_HUNTING;
  const audit = overrides.audit ?? HYP_AUDIT_R1;
  fetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u === "/api/v1/hypotheses") return Promise.resolve(jsonRes2(200, { hypotheses: list }));
    if (u.startsWith("/api/v1/hypotheses/")) return Promise.resolve(jsonRes2(200, detail));
    if (u.startsWith("/api/v1/audit?")) return Promise.resolve(jsonRes2(200, audit));
    return Promise.resolve(jsonRes2(404, { error: "not_found" }));
  });
}

describe("HuntingPage（票 82）", () => {
  beforeEach(() => {
    FakeES.instances = [];
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    primeRoleSession("soc1", "soc1@soc.local", "SOC1 分析师");
  });

  it("假设列表五态 Tag 渲染；发起假设 → POST 正门带发起人头，落表刷新并打开详情", async () => {
    const afterCreate = [...HYP_LIST, {
      id: "hyp_new", hypothesis_id: "hyp_new", template_id: "hunt_webshell",
      text: "新假设", status: "proposed", proposed_by: "soc1@soc.local",
      cancel_reason: null, created_at: 40, decided_at: null,
    }];
    let list = HYP_LIST;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === "/api/v1/hypotheses" && init?.method === "POST") {
        expect(init.headers).toMatchObject({ "x-actor-id": "soc1@soc.local" });
        expect(JSON.parse(String(init.body))).toEqual({ text: "新假设句", template_id: "hunt_webshell" });
        list = afterCreate;
        return Promise.resolve(jsonRes2(201, afterCreate.at(-1)));
      }
      if (u === "/api/v1/hypotheses") return Promise.resolve(jsonRes2(200, { hypotheses: list }));
      if (u.startsWith("/api/v1/hypotheses/hyp_new")) return Promise.resolve(jsonRes2(200, { ...afterCreate.at(-1), rounds: [] }));
      if (u.startsWith("/api/v1/audit?")) return Promise.resolve(jsonRes2(200, []));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });

    render(
      <AuthProvider>
        <HuntingPage />
      </AuthProvider>,
    );
    // 五态里的三态如实成牌（五态全集映射在 hunting.test.ts 锁）
    await waitFor(() => expect(screen.getByText("狩猎中")).toBeTruthy());
    expect(screen.getByText("待开跑")).toBeTruthy();
    expect(screen.getByText("已命中")).toBeTruthy();

    fireEvent.change(await screen.findByPlaceholderText(/假设句/), { target: { value: "新假设句" } });
    fireEvent.change(screen.getByPlaceholderText(/template_id/), { target: { value: "hunt_webshell" } });
    fireEvent.click(screen.getByText("发起狩猎"));

    await waitFor(() => expect(screen.getByText("占位：新提出的假设")).toBeTruthy()); // 列表已刷新
    await waitFor(() => expect(screen.getByText("假设详情")).toBeTruthy()); // 详情已打开
  });

  it("轮次视图：详情轮次归集段装配成卡（组合/子 run/judge/gap）；SSE 按审计锚订阅", async () => {
    mockHuntBase();
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_h" />
      </AuthProvider>,
    );
    await screen.findByText("假设详情");
    // 轮次卡：组合 C_k（工具名）、子 run 状态、judge、gap、父 run 锚
    await waitFor(() => expect(screen.getByText("第 1 轮")).toBeTruthy());
    expect(screen.getByText("playbook_lookup")).toBeTruthy();
    expect(screen.getByText("run_c1 completed")).toBeTruthy();
    expect(screen.getAllByText(/证据不足/).length).toBeGreaterThanOrEqual(1); // judge/gap 双处如实渲染
    // SSE 复用事件总线：按审计锚找到父 run（run 行+审计重建的实时半边）
    await waitFor(() => expect(FakeES.instances.some((es) => es.url.includes("run_id=run_r1"))).toBe(true));
  });

  it("SSE 实时推进：declared/joined/relay 帧落卡；INV-7 同 id 重放恰一次", async () => {
    mockHuntBase();
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_h" />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(FakeES.instances.some((x) => x.url.includes("run_id=run_r1"))).toBe(true),
    );
    const es = FakeES.instances.find((x) => x.url.includes("run_id=run_r1"))!;
    es.onopen?.();
    // 轮间接力：下一轮占位卡（详情归集段未到，如实标 pending）
    es.emit("audit", 5, { action: "round_relay", hypothesis_id: "hyp_h", next_round: 2, parent_run_id: "run_r1" });
    await screen.findByText("第 2 轮（接力中）");
    // 组合声明 → 占位卡出现声明中的子 run（running）
    es.emit("audit", 6, { action: "hunt_children_declared", round_no: 2, children: ["run_c9"] });
    await screen.findByText("run_c9 running");
    // 子 run 回归 → 状态翻面
    es.emit("audit", 7, { action: "hunt_children_joined", round_no: 2, children: [{ run_id: "run_c9", status: "completed" }] });
    await waitFor(() => expect(screen.getByText("run_c9 completed")).toBeTruthy());
    // INV-7 恰一次：同 id 重放不二次应用（日志/卡不重复翻面）
    es.emit("audit", 6, { action: "hunt_children_declared", round_no: 2, children: ["run_c9"] });
    await waitFor(() => expect(screen.getAllByText("run_c9 completed")).toHaveLength(1));
    expect(screen.getAllByText(/组合已扇出/)).toHaveLength(1);
  });

  it("断线补发（INV-7）：断线后按游标重连，URL 带 after=<最后事件 id>", async () => {
    mockHuntBase();
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_h" />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(FakeES.instances.some((x) => x.url.includes("run_id=run_r1&after=0"))).toBe(true),
    );
    const es = FakeES.instances.find((x) => x.url.includes("run_id=run_r1&after=0"))!;
    es.onopen?.();
    es.emit("audit", 5, { action: "round_relay", hypothesis_id: "hyp_h", next_round: 2, parent_run_id: "run_r1" });
    es.onerror?.(); // 断线（页面 retryMs=300，快退避只为演示窗；补发语义在 ./sse 单测锁）
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    expect(FakeES.instances[1].url).toBe("/api/v1/events/stream?run_id=run_r1&after=5");
  });

  it("多轮推进：父 run 终态收流后按审计重建，发现新轮锚自动接上新 run 的流", async () => {
    let audit = HYP_AUDIT_R1;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/hypotheses") return Promise.resolve(jsonRes2(200, { hypotheses: HYP_LIST }));
      if (u.startsWith("/api/v1/hypotheses/hyp_h")) return Promise.resolve(jsonRes2(200, HYP_DETAIL_HUNTING));
      if (u.startsWith("/api/v1/audit?")) return Promise.resolve(jsonRes2(200, audit));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_h" />
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(FakeES.instances.some((x) => x.url.includes("run_id=run_r1"))).toBe(true),
    );
    const es1 = FakeES.instances.find((x) => x.url.includes("run_id=run_r1"))!;
    es1.onopen?.();
    // round 2 的 run 已起（审计重建源更新）但旧流未关；旧 run 终态 → 页面重取审计 → 接上 run_r2
    audit = [
      ...audit,
      { id: "a3", action: "hunt_round_outcome", actor: { type: "agent", id: "agent:hunt_flow" },
        objectType: "hypothesis", objectId: "hyp_h", details: { round_no: 2, run_id: "run_r2" },
        requestId: "hunt_run_r2", result: "SUCCESS", createdAt: 60 },
    ];
    es1.emit("audit", 9, { status: { from: "running", to: "completed" } });
    await waitFor(() => expect(FakeES.instances.some((x) => x.url.includes("run_id=run_r2"))).toBe(true));
  });

  it("取消狩猎（仅 hunting 态出按钮）：确认 → POST :id/cancel 带发起人；409 人话提示", async () => {
    mockHuntBase();
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_h" />
      </AuthProvider>,
    );
    await screen.findByText("假设详情");
    fireEvent.click(screen.getByText("取消狩猎"));
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/cancel")) {
        expect(JSON.parse(String(init!.body))).toEqual({ by: "soc1@soc.local", reason: "user_cancelled" });
        return Promise.resolve(jsonRes2(409, { error: "InvalidTransition" }));
      }
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });
    fireEvent.click(await screen.findByText("确认取消"));
    // 断言点名本页的文案（审批页 409 message 的 DOM 残留不参与匹配）
    await screen.findByText(/取消失败（409）/);
  });

  it("收敛结论：concluded 反查 Case 链接（既有案件查询面，按 hypothesis_id）", async () => {
    mockHuntBase({
      detail: { ...HYP_LIST[2], rounds: [{
        round_no: 2,
        tasks: [{ tool: "graph_query" }],
        children: [{ run_id: "run_c5", status: "completed" }],
        judge: { sufficient: true, verdict: "hit", confidence: 0.8, gap_description: null },
        gap: null,
        created_at: 80,
      }] },
    });
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u === "/api/v1/cases") {
        return Promise.resolve(jsonRes2(200, [
          { id: "case_000002", number: 2, title: "C2 外连案", severity: 3, status: "Open", linkedAlerts: [], startDate: 90, hypothesisId: "hyp_c" },
        ]));
      }
      if (u === "/api/v1/hypotheses") return Promise.resolve(jsonRes2(200, { hypotheses: HYP_LIST }));
      if (u.startsWith("/api/v1/hypotheses/hyp_c")) {
        return Promise.resolve(jsonRes2(200, { ...HYP_LIST[2], rounds: [{
          round_no: 2, tasks: [{ tool: "graph_query" }], children: [{ run_id: "run_c5", status: "completed" }],
          judge: { sufficient: true, verdict: "hit", confidence: 0.8, gap_description: null }, gap: null, created_at: 80,
        }] }));
      }
      if (u.startsWith("/api/v1/audit?")) return Promise.resolve(jsonRes2(200, HYP_AUDIT_R1));
      return Promise.resolve(jsonRes2(404, { error: "not_found" }));
    });
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_c" />
      </AuthProvider>,
    );
    await screen.findByText("假设详情");
    await screen.findByText("第 2 轮");
    expect(screen.getByText("hit")).toBeTruthy();
    await screen.findByText(/case_000002/); // Case 链接（复用既有查询面，无新端点）
  });

  it("非 hunting 态不出取消按钮（状态机口径在页面如实呈现）", async () => {
    // 列表里也不放 hunting 行：取消按钮只挂在 hunting 态行上（proposed 不能取消）
    mockHuntBase({ list: [HYP_LIST[0]], detail: { ...HYP_LIST[0], rounds: [] }, audit: [] });
    render(
      <AuthProvider>
        <HuntingPage hypothesisId="hyp_p" />
      </AuthProvider>,
    );
    await screen.findByText("假设详情");
    expect(screen.queryByText("取消狩猎")).toBeNull();
  });
});

describe("App 壳（路由快照兜底）", () => {
  it("菜单恰好七项（由 ROUTES 生成；表外 hash 兜底回告警列表）", async () => {
    primeSession();
    fetchMock.mockImplementation(() => Promise.resolve(jsonRes2(200, [])));
    window.location.hash = "#/no_such_page";

    const { container } = render(
      <AuthProvider>
        <App />
      </AuthProvider>,
    );

    // 菜单七项一字不差（路由表之外无路由的 UI 面；第七页狩猎页 = 票 71 页面映射节/票 82）
    const items = container.querySelectorAll<HTMLLIElement>(".ant-menu-item");
    expect(items).toHaveLength(7);
    expect([...items].map((li) => li.textContent)).toEqual([
      "告警列表", "流水线视图", "审批卡", "案件时间线", "审计流", "Eval 结果", "狩猎假设",
    ]);

    // 表外名字不是路由：渲染的是告警列表（兜底），不是 404 页、更不是别的页面
    await waitFor(() => expect(screen.getByText("回放 fixtures（重推正门）")).toBeTruthy());
  });
});
