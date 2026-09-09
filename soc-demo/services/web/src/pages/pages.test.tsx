// 关键组件单测（页面冒烟）：登录页四身份 + 点击走正门登录；告警列表 dedup 标记；
// 票 21 三页（审批卡/案件时间线/Eval）+ App 壳路由快照兜底。
// fetch 全部打桩——组件测试只测「组件把 seam 用对了」，不碰真后端。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, STORAGE_KEY } from "../auth";
import AlertsPage from "../pages/AlertsPage";
import ApprovalsPage from "../pages/ApprovalsPage";
import CasePage from "../pages/CasePage";
import EvalPage from "../pages/EvalPage";
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

describe("App 壳（路由快照兜底）", () => {
  it("菜单恰好六项（由 ROUTES 生成）；表外 hash 兜底回告警列表", async () => {
    primeSession();
    fetchMock.mockImplementation(() => Promise.resolve(jsonRes2(200, [])));
    window.location.hash = "#/no_such_page";

    const { container } = render(
      <AuthProvider>
        <App />
      </AuthProvider>,
    );

    // 菜单六项一字不差（六页面之外无路由的 UI 面）
    const items = container.querySelectorAll<HTMLLIElement>(".ant-menu-item");
    expect(items).toHaveLength(6);
    expect([...items].map((li) => li.textContent)).toEqual([
      "告警列表", "流水线视图", "审批卡", "案件时间线", "审计流", "Eval 结果",
    ]);

    // 表外名字不是路由：渲染的是告警列表（兜底），不是 404 页、更不是别的页面
    await waitFor(() => expect(screen.getByText("回放 fixtures（重推正门）")).toBeTruthy());
  });
});
