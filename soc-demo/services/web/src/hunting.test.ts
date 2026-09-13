// 狩猎页状态层 seam 测试（票 82）：数据源打桩（fetch stub，m10 卡 adapter 双形态的
// 打桩半边）+ 纯归约/重建函数（React 之外可单测，pipeline.ts 同款纪律）。
// 覆盖三块：
// ① api 客户端：假设 CRUD 四端点的 wire 形状（services/case-backend/src/hypotheses.ts
//    mapHypothesis/mapRound 的 snake_case 出线）与归一；
// ② 断线重建：假设详情（轮次归集段）+ m2 审计（objectType=hypothesis 条目里的父 run
//    锚）→ 每轮卡片视图——页面映射「轮次视图」行「详情读面 + 审计」两半的装配；
// ③ SSE 实时归约：INV-7 每事件恰好应用一次（同 id 重放是 no-op）+ 组合声明/子 run
//    回归/轮间接力/run 状态镜像五类帧。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelHypothesis,
  createHypothesis,
  findCaseIdByHypothesis,
  getHypothesisDetail,
  listHypotheses,
  type CaseRow,
} from "./api";
import type { SseEvent } from "./sse";
import {
  applyHuntEvent,
  HYPOTHESIS_STATUS_META,
  initHuntLive,
  rebuildRoundViews,
  roundRunAnchors,
  runAnchorOf,
  type AuditEntryLike,
  type HypothesisDetailLike,
} from "./hunting";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// wire 形状照 case-backend mapHypothesis()（snake_case 双键出线）
const HYP_WIRE = {
  id: "hyp_1",
  hypothesis_id: "hyp_1",
  template_id: "hunt_webshell",
  text: "攻击者已通过 webshell 在 dmz 主机建立驻留",
  status: "hunting",
  proposed_by: "soc1@soc.local",
  cancel_reason: null,
  created_at: 100,
  decided_at: null,
};

describe("假设 CRUD 客户端（m2 公开端点，票 73 落卡面）", () => {
  it("listHypotheses：GET /api/v1/hypotheses?status= 透传过滤，wire 归一", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { hypotheses: [HYP_WIRE] }));
    const rows = await listHypotheses("hunting");
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/hypotheses?status=hunting");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "hyp_1", templateId: "hunt_webshell", status: "hunting" });
  });

  it("listHypotheses：无过滤时不带 query", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { hypotheses: [] }));
    await listHypotheses();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/hypotheses");
  });

  it("createHypothesis：POST 正文 text/template_id，发起人走 x-actor-id 头（INV-8 取消比对锚）", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(201, HYP_WIRE));
    const row = await createHypothesis({
      text: "攻击者已建立驻留",
      templateId: "hunt_webshell",
      actorId: "soc1@soc.local",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/hypotheses");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ text: "攻击者已建立驻留", template_id: "hunt_webshell" });
    expect(init.headers).toMatchObject({ "x-actor-id": "soc1@soc.local" });
    expect(row.hypothesisId).toBe("hyp_1");
  });

  it("cancelHypothesis：POST :id/cancel 带 by/reason；409/403 抛 ApiError 原码", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { ...HYP_WIRE, status: "cancelled", cancel_reason: "user_cancelled" }),
    );
    const row = await cancelHypothesis("hyp_1", { by: "soc1@soc.local", reason: "user_cancelled" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/hypotheses/hyp_1/cancel");
    expect(JSON.parse(init.body)).toEqual({ by: "soc1@soc.local", reason: "user_cancelled" });
    expect(row.status).toBe("cancelled");

    fetchMock.mockResolvedValueOnce(jsonRes(409, { error: "InvalidTransition" }));
    await expect(cancelHypothesis("hyp_1", {})).rejects.toMatchObject({ status: 409, code: "InvalidTransition" });
  });

  it("getHypothesisDetail：GET :id 详情带轮次归集段（rounds）", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(200, {
        ...HYP_WIRE,
        rounds: [
          {
            round_no: 1,
            tasks: [{ tool: "playbook_lookup", params: { q: "webshell" }, rationale: "首轮" }],
            children: [{ run_id: "run_c1", status: "completed" }],
            judge: { sufficient: false, verdict: null, confidence: 0.4, gap_description: "证据不足" },
            gap: { gap_description: "证据不足", unknown: "驻留是否仍在", suggested_focus: ["web_access_query"] },
            created_at: 120,
          },
        ],
      }),
    );
    const detail = await getHypothesisDetail("hyp_1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/hypotheses/hyp_1");
    expect(detail.rounds).toHaveLength(1);
    expect(detail.rounds[0].children[0]).toEqual({ run_id: "run_c1", status: "completed" });
    expect((detail.rounds[0].judge as Record<string, unknown>).sufficient).toBe(false);
  });

  it("findCaseIdByHypothesis：案件列表按 hypothesisId 反查（收敛结论的 Case 链接）", () => {
    const cases = [
      { id: "case_000001", hypothesisId: null },
      { id: "case_000002", hypothesisId: "hyp_1" },
    ] as unknown as CaseRow[];
    expect(findCaseIdByHypothesis(cases, "hyp_1")).toBe("case_000002");
    expect(findCaseIdByHypothesis(cases, "hyp_none")).toBeNull();
  });
});

// ---- 断线重建（run 行 + 审计）----

const DETAIL: HypothesisDetailLike = {
  id: "hyp_1",
  status: "hunting",
  rounds: [
    { round_no: 1, tasks: [{ tool: "kb_lookup" }], children: [{ run_id: "run_c1", status: "completed" }], judge: null, gap: { unknown: "x" } },
    { round_no: 2, tasks: [{ tool: "siem_query" }], children: [], judge: null, gap: null },
  ],
};

// 照 agent recordAudit（hunt_<run_id> 关联）+ flow.ts outcome 节点五要素条目的形状
const AUDIT: AuditEntryLike[] = [
  {
    id: "a1",
    action: "hunt_dispatch_decide",
    objectType: "run",
    objectId: "run_r1",
    details: { round_no: 1, hypothesis_id: "hyp_1", children: ["run_c1"] },
    requestId: "hunt_run_r1",
    result: "SUCCESS",
    createdAt: 10,
  },
  {
    id: "a2",
    action: "hunt_round_outcome",
    objectType: "hypothesis",
    objectId: "hyp_1",
    details: { round_no: 1, run_id: "run_r1", relayed: true },
    requestId: "hunt_run_r1",
    result: "SUCCESS",
    createdAt: 20,
  },
  {
    id: "a3",
    action: "hunt_round_outcome",
    objectType: "hypothesis",
    objectId: "hyp_1",
    details: { round_no: 2, run_id: "run_r2" },
    requestId: "hunt_run_r2",
    result: "SUCCESS",
    createdAt: 30,
  },
];

describe("断线刷新重建（轮次归集段 + 审计父 run 锚）", () => {
  it("runAnchorOf：优先五要素 details.run_id，退回 requestId hunt_<run_id> 前缀", () => {
    expect(runAnchorOf(AUDIT[1])).toBe("run_r1");
    expect(runAnchorOf(AUDIT[0])).toBe("run_r1"); // details 无 run_id → requestId 解析
    expect(runAnchorOf({ ...AUDIT[0], requestId: "req_other" })).toBeNull();
  });

  it("roundRunAnchors：hypothesis 审计按轮号归位（后到覆盖），run 对象条目不入图", () => {
    const anchors = roundRunAnchors(DETAIL, AUDIT);
    expect(anchors).toEqual({ 1: "run_r1", 2: "run_r2" });
  });

  it("rebuildRoundViews：详情轮次段 + 锚 → 每轮视图（组合/子 run/judge/gap/父 run_id）", () => {
    const views = rebuildRoundViews(DETAIL, AUDIT);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      roundNo: 1,
      runId: "run_r1",
      children: [{ run_id: "run_c1", status: "completed" }],
      hasJudge: false,
    });
    expect(views[1]).toMatchObject({ roundNo: 2, runId: "run_r2", hasJudge: false });
  });

  it("rebuildRoundViews：judge/gap 缺席如实标 null，不猜数；无锚轮 runId 为 null", () => {
    const views = rebuildRoundViews(
      { ...DETAIL, rounds: [{ round_no: 1, tasks: [], children: [], judge: { sufficient: true, verdict: "hit", confidence: 0.9, gap_description: null }, gap: null }] },
      [],
    );
    expect(views[0].runId).toBeNull();
    expect(views[0].hasJudge).toBe(true);
    expect(views[0].verdict).toBe("hit");
    expect(views[0].gap).toBeNull();
  });

  it("rebuildRoundViews：轮间接力在途轮（详情还没这轮）给出占位卡（round_relay 已知、归集未到）", () => {
    const views = rebuildRoundViews(DETAIL, AUDIT, { pendingRoundNo: 3 });
    expect(views.map((v) => v.roundNo)).toEqual([1, 2, 3]);
    expect(views[2].pending).toBe(true);
    expect(views[2].runId).toBeNull();
  });
});

// ---- SSE 实时归约（INV-7）----

function ev(id: number, type: string, payload: Record<string, unknown> = {}, ts = 1000 + id): SseEvent {
  return { id, type: type as SseEvent["type"], payload, ts };
}

describe("轮次视图 SSE 归约（复用事件总线，INV-7）", () => {
  it("audit 帧：组合声明/子 run 回归/轮间接力/run 状态镜像各归其位", () => {
    let st = initHuntLive();
    st = applyHuntEvent(st, ev(1, "audit", { action: "hunt_children_declared", round_no: 1, children: ["run_c1", "run_c2"] }));
    st = applyHuntEvent(st, ev(2, "audit", {
      action: "hunt_children_joined", round_no: 1,
      children: [{ run_id: "run_c1", status: "completed" }, { run_id: "run_c2", status: "failed" }],
    }));
    st = applyHuntEvent(st, ev(3, "audit", { action: "round_relay", hypothesis_id: "hyp_1", next_round: 2, parent_run_id: "run_r1" }));
    st = applyHuntEvent(st, ev(4, "audit", { status: { from: "queued", to: "running" } }));
    expect(st.declared[1]).toEqual(["run_c1", "run_c2"]);
    expect(st.joined[1]).toEqual([{ run_id: "run_c1", status: "completed" }, { run_id: "run_c2", status: "failed" }]);
    expect(st.relayedTo).toBe(2);
    expect(st.runStatus).toBe("running");
    expect(st.failed).toBe(false);
    expect(st.lastEventId).toBe(4);
  });

  it("INV-7 恰一次：同 id 重放是 no-op，游标内的迟到帧不二次应用", () => {
    let st = initHuntLive();
    const declared = ev(5, "audit", { action: "hunt_children_declared", round_no: 1, children: ["run_c1"] });
    st = applyHuntEvent(st, declared);
    const once = st;
    st = applyHuntEvent(st, declared); // 断线补发与实时扇出的重叠窗口：同帧到达两次
    expect(st).toBe(once);
    expect(st.log.filter((l) => l.type === "audit")).toHaveLength(1);
    st = applyHuntEvent(st, ev(3, "audit", { action: "round_relay", next_round: 9 })); // 游标内乱序帧
    expect(st.relayedTo).toBeNull();
  });

  it("error 帧置 failed；日志新到在上、封顶 200", () => {
    let st = initHuntLive();
    for (let i = 1; i <= 210; i++) st = applyHuntEvent(st, ev(i, "node_enter", { node: `n${i}` }));
    expect(st.log).toHaveLength(200);
    expect(st.log[0].id).toBe(210); // 新到在上
    st = applyHuntEvent(st, ev(211, "error", { message: "boom" }));
    expect(st.failed).toBe(true);
    expect(st.log[0].type).toBe("error");
  });

  it("五态 Tag 映射：状态全集一一有档（不出现未知态白牌）", () => {
    for (const s of ["proposed", "hunting", "concluded", "refuted", "cancelled"] as const) {
      expect(HYPOTHESIS_STATUS_META[s].label.length).toBeGreaterThan(0);
      expect(HYPOTHESIS_STATUS_META[s].color.length).toBeGreaterThan(0);
    }
    expect(HYPOTHESIS_STATUS_META.hunting.label).toBe("狩猎中");
  });
});
