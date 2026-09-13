// 票 73 · m2 假设实体（第七实体）：五态状态机 + 三端点 + 轮次归集段（specs/orchestration-loop.md
// 「接口定义 m2 新增」）。打真 REST（app.inject，kb.test.ts 同款），语义全在 hypotheses.ts：
// 提案 + outbox 拉起事件同事务（行为约定 1）、取消仅发起人 + hunting 态（INV-10）、
// 状态机外变更一律 409（T21）、轮次归集幂等可回放。
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";

function appAndDb() {
  const db = openDb(":memory:");
  const app = buildApp({ db });
  return { db, app };
}

const ACTOR = { "x-actor-id": "soc1", "x-actor-type": "user", "x-request-id": "req-hyp" };

async function propose(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = ACTOR,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/hypotheses",
    headers,
    payload: { template_id: "t-default", text: "内网存在可疑横向移动行为", ...body },
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

async function startHunting(
  app: ReturnType<typeof buildApp>,
  id: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/hypotheses/${id}`,
    headers: { "x-actor-id": "agent:hunt_flow", "x-actor-type": "agent", "x-request-id": "req-loop" },
    payload: { status: "hunting" },
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

async function cancel(
  app: ReturnType<typeof buildApp>,
  id: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = ACTOR,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/hypotheses/${id}/cancel`,
    headers,
    payload: { reason: "user_cancelled", ...body },
  });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

describe("POST /api/v1/hypotheses（发起假设：置 proposed + outbox 拉起事件同事务）", () => {
  test("201 proposed；audit_entries 与 outbox hypothesis.created 同事务落盘（行为约定 1 / INV-8）", async () => {
    const { db, app } = appAndDb();
    const res = await propose(app);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      status: "proposed",
      template_id: "t-default",
      proposed_by: "soc1",
    });
    expect(res.json.hypothesis_id).toBeTruthy();

    const id = res.json.hypothesis_id as string;
    const audits = db.prepare("SELECT * FROM audit_entries WHERE object_id = ?").all(id) as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");

    const outbox = db
      .prepare("SELECT * FROM outbox_events WHERE topic = 'hypothesis.created'")
      .all() as Record<string, unknown>[];
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0].payload as string)).toMatchObject({ hypothesisId: id, templateId: "t-default" });
  });

  test("text 缺失 → 400，不落库不发事件", async () => {
    const { db, app } = appAndDb();
    const res = await propose(app, { text: "" });
    expect(res.status).toBe(400);
    const outbox = db.prepare("SELECT * FROM outbox_events WHERE topic = 'hypothesis.created'").all();
    expect(outbox).toHaveLength(0);
  });
});

describe("假设状态机（INV-10：表外变更一律 409）", () => {
  test("T21 illegal_transition_409：proposed 直达终态 / 回退 / 终态再迁移全 409", async () => {
    const { app } = appAndDb();
    const { json } = await propose(app);
    const id = json.hypothesis_id as string;

    // proposed → concluded / refuted / cancelled 都是表外迁移（唯一合法出路是 proposed→hunting）
    for (const to of ["concluded", "refuted", "cancelled"]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/v1/hypotheses/${id}`,
        payload: { status: to },
      });
      expect(res.statusCode, `proposed→${to}`).toBe(409);
      expect((res.json() as { error: string }).error).toBe("InvalidTransition");
    }
    // hunting → proposed（回退）同样表外
    await startHunting(app, id);
    const back = await app.inject({
      method: "PATCH",
      url: `/api/v1/hypotheses/${id}`,
      payload: { status: "proposed" },
    });
    expect(back.statusCode).toBe(409);
  });

  test("合法链 proposed→hunting→concluded/refuted 200；终态再迁移 409", async () => {
    const { app } = appAndDb();
    const a = await propose(app);
    const idA = a.json.hypothesis_id as string;
    expect((await startHunting(app, idA)).status).toBe(200);
    const hit = await app.inject({
      method: "PATCH",
      url: `/api/v1/hypotheses/${idA}`,
      payload: { status: "concluded" },
    });
    expect(hit.statusCode).toBe(200);
    // 终态不可回退（INV-10）
    const again = await app.inject({
      method: "PATCH",
      url: `/api/v1/hypotheses/${idA}`,
      payload: { status: "refuted" },
    });
    expect(again.statusCode).toBe(409);

    const b = await propose(app);
    const idB = b.json.hypothesis_id as string;
    await startHunting(app, idB);
    const miss = await app.inject({
      method: "PATCH",
      url: `/api/v1/hypotheses/${idB}`,
      payload: { status: "refuted" },
    });
    expect(miss.statusCode).toBe(200);
  });

  test("未知目标状态 → 400 invalid_status（薄口先拦枚举）", async () => {
    const { app } = appAndDb();
    const { json } = await propose(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/hypotheses/${json.hypothesis_id as string}`,
      payload: { status: "wet" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/v1/hypotheses/:id/cancel（仅发起人 + 仅 hunting 态）", () => {
  test("hunting 态发起人取消 200 cancelled + 原因落账 + 审计", async () => {
    const { db, app } = appAndDb();
    const { json } = await propose(app);
    const id = json.hypothesis_id as string;
    await startHunting(app, id);
    const res = await cancel(app, id);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "cancelled", cancel_reason: "user_cancelled" });
    const audits = db
      .prepare("SELECT * FROM audit_entries WHERE object_id = ? AND action = 'cancel'")
      .all(id) as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
  });

  test("非发起人 → 403（取消权在发起人）；proposed 态 → 409（状态机无 proposed→cancelled）", async () => {
    const { app } = appAndDb();
    const { json } = await propose(app);
    const id = json.hypothesis_id as string;

    const forbidden = await cancel(app, id, {}, { ...ACTOR, "x-actor-id": "soc2" });
    expect(forbidden.status).toBe(403);

    await startHunting(app, id);
    const ok = await cancel(app, id);
    expect(ok.status).toBe(200);

    // 终态再取消 → 409（INV-10）
    const replay = await cancel(app, id);
    expect(replay.status).toBe(409);

    // proposed 态取消（绕过 hunting）→ 409
    const fresh = await propose(app);
    const premature = await cancel(app, fresh.json.hypothesis_id as string);
    expect(premature.status).toBe(409);
  });

  test("取消原因出四因枚举 → 400", async () => {
    const { app } = appAndDb();
    const { json } = await propose(app);
    const id = json.hypothesis_id as string;
    await startHunting(app, id);
    const res = await cancel(app, id, { reason: "just_because" });
    expect(res.status).toBe(400);
  });

  test("票 77（L0 裁决②）：取消与 outbox hypothesis.cancelled 同事务落盘（agent autorun 消费信号；照 hypothesis.created 同事务先例）", async () => {
    const { db, app } = appAndDb();
    const { json } = await propose(app);
    const id = json.hypothesis_id as string;
    await startHunting(app, id);

    const res = await cancel(app, id);
    expect(res.status).toBe(200);
    const outbox = db
      .prepare("SELECT * FROM outbox_events WHERE topic = 'hypothesis.cancelled'")
      .all() as Record<string, unknown>[];
    expect(outbox).toHaveLength(1);
    expect(JSON.parse(outbox[0].payload as string)).toMatchObject({ hypothesisId: id, reason: "user_cancelled" });

    // 终态重取消 → 409 不发第二事件（INV-10 语义不变：信号只在账面迁移时发出）
    const replay = await cancel(app, id);
    expect(replay.status).toBe(409);
    expect(
      db.prepare("SELECT * FROM outbox_events WHERE topic = 'hypothesis.cancelled'").all(),
    ).toHaveLength(1);
  });
});

describe("轮次归集读面（GET 列表 / 详情含轮次段）", () => {
  test("POST :id/rounds 落轮次记录；重放同轮幂等替换不重复（INV-6 同族）", async () => {
    const { db, app } = appAndDb();
    const { json } = await propose(app);
    const id = json.hypothesis_id as string;
    const round = {
      round_no: 1,
      tasks: [{ tool: "kb_lookup", params: { q: "x" }, rationale: "先查知识库" }],
      children: [{ run_id: "run-c1", status: "completed" }],
      judge: { sufficient: false, verdict: null, confidence: 0.4, gap_description: "缺主机侧证据" },
      gap: { unknown: "主机侧无覆盖", suggested_focus: ["siem_query"] },
    };
    const first = await app.inject({ method: "POST", url: `/api/v1/hypotheses/${id}/rounds`, payload: round });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: "POST", url: `/api/v1/hypotheses/${id}/rounds`, payload: round });
    expect(replay.statusCode).toBe(200);
    const rows = db.prepare("SELECT * FROM hypothesis_rounds WHERE hypothesis_id = ?").all(id);
    expect(rows).toHaveLength(1);
  });

  test("GET 列表 ?status= 过滤；GET 详情含轮次归集段（每轮 round_no/tasks/children/judge/gap）", async () => {
    const { app } = appAndDb();
    const a = await propose(app);
    const idA = a.json.hypothesis_id as string;
    await propose(app);

    const all = await app.inject({ method: "GET", url: "/api/v1/hypotheses" });
    expect((all.json() as { hypotheses: unknown[] }).hypotheses).toHaveLength(2);
    const hunting = await app.inject({ method: "GET", url: "/api/v1/hypotheses?status=hunting" });
    expect((hunting.json() as { hypotheses: unknown[] }).hypotheses).toHaveLength(0);

    await app.inject({ method: "POST", url: `/api/v1/hypotheses/${idA}/rounds`, payload: { round_no: 1, tasks: [], children: [], judge: null, gap: null } });
    const detail = await app.inject({ method: "GET", url: `/api/v1/hypotheses/${idA}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { rounds: { round_no: number; children: { run_id: string }[] }[] };
    expect(body.rounds).toHaveLength(1);
    expect(body.rounds[0].round_no).toBe(1);

    const missing = await app.inject({ method: "GET", url: "/api/v1/hypotheses/hyp-nope" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("Case.hypothesis_id 可空列（命中建案回填的锚）", () => {
  test("建案 wire 带 hypothesisId 且缺省 null（列名 hypothesis_id，wire 沿 cases 驼峰口径）", async () => {
    const { app } = appAndDb();
    const created = await app.inject({ method: "POST", url: "/api/v1/cases", payload: { title: "狩猎命中案" } });
    expect(created.statusCode).toBe(201);
    expect((created.json() as Record<string, unknown>).hypothesisId ?? null).toBeNull();
  });

  test("票 75（spec 授权的接口细化）：POST /cases 接受可空 hypothesis_id 入参并落列", async () => {
    const { app } = appAndDb();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/cases",
      payload: { title: "狩猎命中案", hypothesis_id: "hyp_abc" },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as Record<string, unknown>).hypothesisId).toBe("hyp_abc");
    // 读面同源可查（GET /cases/:id 的 detail 沿 mapCase 出线）
    const id = (created.json() as { id: string }).id;
    const detail = await app.inject({ method: "GET", url: `/api/v1/cases/${id}` });
    expect((detail.json() as Record<string, unknown>).hypothesisId).toBe("hyp_abc");
    // 不带该字段的建案行为不变（缺省 null，既有消费者零扰动）
    const plain = await app.inject({ method: "POST", url: "/api/v1/cases", payload: { title: "普通案" } });
    expect((plain.json() as Record<string, unknown>).hypothesisId ?? null).toBeNull();
  });
});
