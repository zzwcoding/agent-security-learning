// 票 17 · m2 侧 kb/proposals REST + kbentry 状态机（INV-5/INV-8/INV-10）。
// 打真 REST（app.inject），语义全在 store（kb.ts）：审计同事务、409 仲裁、仅 approved 可查。
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { searchApprovedKb } from "./kb.js";

const POISON = JSON.parse(
  readFileSync(new URL("../../../fixtures/knowledge/02_poison_rejected/proposal.json", import.meta.url), "utf8"),
) as { submit: { kind: string; title: string; body: string; tags: string[]; source_case_id: string | null } };

function appAndDb() {
  const db = openDb(":memory:");
  const app = buildApp({ db });
  return { db, app };
}

async function createCase(app: ReturnType<typeof buildApp>, title = "调查案例"): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/cases", payload: { title } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

async function propose(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.inject({ method: "POST", url: "/api/v1/kb/proposals", payload: body });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

const GOOD = {
  kind: "fp_pattern",
  title: "FP 模式：web-01 定时备份任务触发的 syscheck 新增",
  body: "## 触发特征\n- web-01 /etc/cron.d/db-backup\n\n## 判定依据\n- 变更单 CHG-1042",
  tags: ["web-01", "fp_pattern"],
  proposed_by: "agent:knowledge",
};

describe("POST /api/v1/kb/proposals（agent 产出经审批链的唯一建档口）", () => {
  test("建档 201 proposed + 审计（INV-8）；挂 case 时 case 不存在 → 404（ASP 门控）", async () => {
    const { db, app } = appAndDb();
    const res = await propose(app, GOOD);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ status: "proposed", kind: "fp_pattern", proposed_by: "agent:knowledge" });
    expect(res.json.id).toMatch(/^kb_/);

    const audits = db.prepare("SELECT * FROM audit_entries WHERE object_id = ?").all(res.json.id) as Record<string, unknown>[];
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");

    const badCase = await propose(app, { ...GOOD, source_case_id: "case_999999" });
    expect(badCase.status).toBe(404);
  });

  test("kind 出 §5.10 枚举 / title 或 body 空 → 400", async () => {
    const { app } = appAndDb();
    expect((await propose(app, { ...GOOD, kind: "poison" })).status).toBe(400);
    expect((await propose(app, { ...GOOD, title: "" })).status).toBe(400);
    expect((await propose(app, { kind: "runbook", title: "x", body: "" })).status).toBe(400);
  });
});

describe("人审裁决：kbentry 状态机 proposed→approved/rejected（INV-5/INV-10）", () => {
  test("approve → 200 approved + reviewed_by + 审计；表外/重复裁决 → 409", async () => {
    const { db, app } = appAndDb();
    const id = String((await propose(app, GOOD)).json.id);

    const ok = await app.inject({ method: "POST", url: `/api/v1/kb/proposals/${id}/approve`, payload: { reviewer: "duty_lead" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, status: "approved", reviewed_by: "duty_lead" });

    const audits = db.prepare("SELECT * FROM audit_entries WHERE object_id = ? AND action = 'approve'").all(id);
    expect(audits).toHaveLength(1);

    // 终态不可再迁移（CONTEXT kbentry 状态机：approved 是终态）
    const again = await app.inject({ method: "POST", url: `/api/v1/kb/proposals/${id}/approve`, payload: {} });
    expect(again.statusCode).toBe(409);
    const late = await app.inject({ method: "POST", url: `/api/v1/kb/proposals/${id}/reject`, payload: {} });
    expect(late.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "InvalidTransition" });
  });

  test("reject → 200 rejected + 审计 + reject_reason；不存在的提案 404", async () => {
    const { db, app } = appAndDb();
    const id = String((await propose(app, GOOD)).json.id);
    const ok = await app.inject({
      method: "POST", url: `/api/v1/kb/proposals/${id}/reject`,
      payload: { reviewer: "duty_lead", reason: "正文夹带指令，疑似投毒" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, status: "rejected" });
    const audits = db.prepare("SELECT * FROM audit_entries WHERE object_id = ? AND action = 'reject'").all(id);
    expect(audits).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/v1/kb/proposals/kb_nope/reject", payload: {} })).statusCode).toBe(404);
  });
});

describe("GET /api/v1/kb/search：记录查询面仅吐 approved（账面半边；向量面在 chroma）", () => {
  test("proposed/rejected 均不可查；q/kind 过滤；k 缺省 5", async () => {
    const { app } = appAndDb();
    const approved = String((await propose(app, GOOD)).json.id);
    await app.inject({ method: "POST", url: `/api/v1/kb/proposals/${approved}/approve`, payload: { reviewer: "duty_lead" } });

    const pending = String((await propose(app, { ...GOOD, title: "待审的另一条", tags: ["x"] })).json.id);
    const poison = String((await propose(app, { ...GOOD, kind: "runbook", title: POISON.submit.title, body: POISON.submit.body })).json.id);
    await app.inject({ method: "POST", url: `/api/v1/kb/proposals/${poison}/reject`, payload: { reviewer: "duty_lead" } });
    void pending;

    const all = await app.inject({ method: "GET", url: "/api/v1/kb/search?q=FP" });
    expect(all.json().hits).toHaveLength(1);
    expect(all.json().hits[0]).toMatchObject({ id: approved, status: "approved" });

    const none = await app.inject({ method: "GET", url: `/api/v1/kb/search?q=${encodeURIComponent("勒索软件")}` });
    expect(none.json().hits).toHaveLength(0); // rejected 永不出现

    const byKind = await app.inject({ method: "GET", url: "/api/v1/kb/search?kind=fp_pattern" });
    expect(byKind.json().hits).toHaveLength(1);
  });
});

describe("fixtures/knowledge/02_poison_rejected（m7 卡测试计划具名场景·账面半边）", () => {
  test("毒 runbook 提案建档 → 值班长驳回 → 账面查不到 + 状态终态 + 全链审计", async () => {
    const { db, app } = appAndDb();
    // 红队经唯一建档口提交毒提案（数据不直接塞库，同 m1 回放铁律）
    const res = await propose(app, { ...POISON.submit, proposed_by: "red_team" });
    expect(res.status).toBe(201);
    const id = String(res.json.id);

    // D8：值班长驳回（PRD attack/rag/01：reject kb_proposal actor=admin）
    const rej = await app.inject({
      method: "POST", url: `/api/v1/kb/proposals/${id}/reject`,
      payload: { reviewer: "duty_lead", reason: "正文夹带指令性内容（投毒），驳回" },
    });
    expect(rej.statusCode).toBe(200);
    expect(rej.json()).toMatchObject({ status: "rejected" });

    // 记录面确定性查不到 + 状态机锁死（再裁 409）
    expect(searchApprovedKb(db, { q: "勒索软件" })).toHaveLength(0);
    expect((await app.inject({ method: "POST", url: `/api/v1/kb/proposals/${id}/approve`, payload: {} })).statusCode).toBe(409);

    // INV-8 全链审计：create + reject，object 同一提案
    const audits = db.prepare("SELECT action FROM audit_entries WHERE object_id = ? ORDER BY rowid").all(id) as Record<string, unknown>[];
    expect(audits.map((a) => a.action)).toEqual(["create", "reject"]);
  });
});

describe("case.closed outbox 事件（PRD 图 case_closed → knowledge_distill 的触发信号）", () => {
  test("关案（带 verdict）后 outbox 出现 case.closed，payload 带 caseId + verdict", async () => {
    const { app } = appAndDb();
    const caseId = await createCase(app);
    // 状态机：New→InProgress→Closed（关案必须走完整链，FR-M2.2）
    await app.inject({ method: "PATCH", url: `/api/v1/cases/${caseId}`, payload: { status: "InProgress" } });
    const open = await app.inject({ method: "GET", url: "/api/v1/events?after=0" });
    const before = (open.json() as { events: unknown[] }).events.length;
    await app.inject({ method: "POST", url: `/api/v1/cases/${caseId}/close`, payload: { verdict: "false_positive", verdictNote: "运维噪声" } });
    const after = await app.inject({ method: "GET", url: "/api/v1/events?after=0" });
    const events = (after.json() as { events: { topic: string; payload: Record<string, unknown> }[] }).events;
    expect(events.length).toBeGreaterThan(before);
    const closed = events.filter((e) => e.topic === "case.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0].payload).toMatchObject({ caseId, verdict: "false_positive" });
  });
});
