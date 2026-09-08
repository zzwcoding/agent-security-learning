import type { FastifyInstance } from "fastify";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { createAlert } from "./store.js";

type DB = ReturnType<typeof openDb>;
type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;
type InjectMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

function makeApp() {
  const db = openDb(":memory:");
  const app = buildApp({ db });
  return { db, app };
}

let seq = 0;
function seedAlert(db: DB, over: Record<string, unknown> = {}) {
  seq += 1;
  return createAlert(db, {
    type: "wazuh_alert",
    source: "wazuh:soc-demo",
    sourceRef: `wazuh-${seq}`,
    title: "Multiple failed logins for user root",
    description: "SSHD brute force attempt",
    severity: 3,
    tags: ["mitre:T1110", "group:authentication_failed"],
    date: Date.now(),
    observables: [
      { dataType: "hostname", data: "web-01" },
      { dataType: "ip", data: "10.0.0.5" },
    ],
    ...over,
  }) as { id: string };
}

async function inject(
  app: FastifyInstance,
  method: InjectMethod,
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    payload,
    headers: { "x-actor-id": "agent:triage", "x-request-id": "req-test", ...headers },
  });
}

// ---------- 状态机迁移表全组合（INV-10）----------
// 每格 = 「把实体开到 from，再试一个指向 to 的动作」。没有任何动作能把实体变成
// New，所以 to=New 的格子无事可试，跳过。

const ALERT_STATES = ["New", "InProgress", "Imported", "Closed"] as const;
const ALERT_LEGAL: Record<string, string[]> = {
  New: ["InProgress"],
  InProgress: ["Imported", "Closed"],
  Imported: [],
  Closed: ["InProgress"],
};
const CASE_STATES = ["New", "InProgress", "Closed"] as const;
const CASE_LEGAL: Record<string, string[]> = {
  New: ["InProgress"],
  InProgress: ["Closed"],
  Closed: [],
};

async function alertToState(app: FastifyInstance, id: string, state: string) {
  if (state === "New") return;
  if (state === "InProgress") {
    const r = await inject(app, "POST", `/api/v1/alerts/${id}/create-case`, {
      title: "[wazuh_alert] - web-01 - 2026",
    });
    if (r.statusCode !== 201) throw new Error(`drive to InProgress failed: ${r.body}`);
    return;
  }
  if (state === "Imported") {
    await alertToState(app, id, "InProgress");
    const c = await inject(app, "POST", "/api/v1/cases", { title: "target case" });
    const caseId = c.json().id;
    const r = await inject(app, "POST", `/api/v1/alerts/${id}/merge/${caseId}`);
    if (r.statusCode !== 200) throw new Error(`drive to Imported failed: ${r.body}`);
    return;
  }
  // Closed
  await alertToState(app, id, "InProgress");
  const r = await inject(app, "POST", `/api/v1/alerts/${id}/close`, { verdict: "false_positive" });
  if (r.statusCode !== 200) throw new Error(`drive to Closed failed: ${r.body}`);
}

describe("状态机迁移表全组合：alert（非法转移 100% 409）", () => {
  for (const from of ALERT_STATES) {
    for (const to of ALERT_STATES) {
      if (to === "New") continue; // 没有动作能把 alert 变回 New
      const legal = ALERT_LEGAL[from].includes(to);
      test(`${from}→${to} ${legal ? "放行" : "409 InvalidTransition"}`, async () => {
        const { db, app } = makeApp();
        const alert = seedAlert(db);
        await alertToState(app, alert.id, from);
        const action = {
          InProgress: () => inject(app, "POST", `/api/v1/alerts/${alert.id}/create-case`, {}),
          Imported: async () => {
            const c = await inject(app, "POST", "/api/v1/cases", { title: "t" });
            return inject(app, "POST", `/api/v1/alerts/${alert.id}/merge/${c.json().id}`);
          },
          Closed: () => inject(app, "POST", `/api/v1/alerts/${alert.id}/close`, { verdict: "false_positive" }),
        }[to];
        const r = await (action
          ? action()
          : inject(app, "POST", `/api/v1/alerts/${alert.id}/reopen`));
        if (legal) {
          expect(r.statusCode).toBeLessThan(300);
          expect(r.json().status ?? r.json().alert?.status).toBe(to);
        } else {
          expect(r.statusCode, r.body).toBe(409);
          expect(r.json().error).toBe("InvalidTransition");
        }
        await app.close();
      });
    }
  }
});

describe("状态机迁移表全组合：case", () => {
  async function caseToState(app: FastifyInstance, id: string, state: string) {
    if (state === "New") return;
    if (state === "InProgress") {
      const r = await inject(app, "PATCH", `/api/v1/cases/${id}`, { status: "InProgress" });
      if (r.statusCode !== 200) throw new Error(`drive failed: ${r.body}`);
      return;
    }
    await caseToState(app, id, "InProgress");
    const r = await inject(app, "POST", `/api/v1/cases/${id}/close`, {
      verdict: "true_positive",
      verdictNote: "confirmed",
    });
    if (r.statusCode !== 200) throw new Error(`drive failed: ${r.body}`);
  }

  for (const from of CASE_STATES) {
    for (const to of CASE_STATES) {
      if (to === "New") continue; // 没有动作能把 case 变回 New
      const legal = CASE_LEGAL[from].includes(to);
      test(`${from}→${to} ${legal ? "放行" : "409"}`, async () => {
        const { app } = makeApp();
        const c = await inject(app, "POST", "/api/v1/cases", { title: "matrix case" });
        const id = c.json().id;
        await caseToState(app, id, from);
        const r =
          to === "InProgress"
            ? await inject(app, "PATCH", `/api/v1/cases/${id}`, { status: "InProgress" })
            : await inject(app, "POST", `/api/v1/cases/${id}/close`, { verdict: "true_positive" });
        if (legal) {
          expect(r.statusCode).toBeLessThan(300);
          expect(r.json().status).toBe(to);
        } else {
          expect(r.statusCode, r.body).toBe(409);
        }
        await app.close();
      });
    }
  }
});

// ---------- 三结局具名 fixture（FR-M2.3）----------

describe("三结局具名 fixture", () => {
  test("成新案：create-case 建 case，observables 归案，linkedAlerts 建立，alert 置 InProgress", async () => {
    const { db, app } = makeApp();
    const alert = seedAlert(db);
    const r = await inject(app, "POST", `/api/v1/alerts/${alert.id}/create-case`, {});
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.alert.status).toBe("InProgress");
    expect(body.case.linkedAlerts).toContain(alert.id);
    expect(body.case.number).toBeGreaterThan(0);
    const detail = await inject(app, "GET", `/api/v1/cases/${body.case.id}`);
    expect(detail.json().observables.map((o: { data: string }) => o.data).sort())
      .toEqual(["10.0.0.5", "web-01"]);
    expect(detail.json().timeline.length).toBeGreaterThan(0);
    await app.close();
  });

  test("并入旧案：observables 复制进目标，tags 并入，源 alert 置 Imported 记 importedDate", async () => {
    const { db, app } = makeApp();
    const first = seedAlert(db);
    const created = await inject(app, "POST", `/api/v1/alerts/${first.id}/create-case`, {});
    const caseId = (created.json() as { case: { id: string } }).case.id; // 目标旧案
    // 并入旧案要求源 alert 已 InProgress（状态机 New→Imported 非法），先给 second 走一次成新案
    const second = seedAlert(db, { tags: ["mitre:T1110", "extra:tag"] });
    await inject(app, "POST", `/api/v1/alerts/${second.id}/create-case`, {});
    const r = await inject(app, "POST", `/api/v1/alerts/${second.id}/merge/${caseId}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().alert.status).toBe("Imported");
    expect(r.json().alert.importedDate).toBeGreaterThan(0);
    const detail = await inject(app, "GET", `/api/v1/cases/${caseId}`);
    const hostObs = detail.json().observables.filter((o: { data: string }) => o.data === "web-01");
    expect(hostObs.length).toBe(2); // 原 alert 的 + 复制来的
    expect(detail.json().tags).toContain("extra:tag");
    expect(detail.json().linkedAlerts).toContain(second.id);
    await app.close();
  });

  test("关案缺 verdict 409 verdict_required；带 verdict 关案 Closed+endDate", async () => {
    const { app } = makeApp();
    const c = await inject(app, "POST", "/api/v1/cases", { title: "verdict case" });
    const id = c.json().id;
    await inject(app, "PATCH", `/api/v1/cases/${id}`, { status: "InProgress" });
    const missing = await inject(app, "POST", `/api/v1/cases/${id}/close`, { verdict: null });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toBe("verdict_required");
    const ok = await inject(app, "POST", `/api/v1/cases/${id}/close`, {
      verdict: "true_positive",
      verdictNote: "确认暴力破解，已隔离",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("Closed");
    expect(ok.json().verdict).toBe("true_positive");
    expect(ok.json().endDate).toBeGreaterThan(0);
    await app.close();
  });

  test("merge 目标 case 已 Closed → 409", async () => {
    const { db, app } = makeApp();
    const alert = seedAlert(db);
    const c = await inject(app, "POST", "/api/v1/cases", { title: "closed target" });
    const caseId = c.json().id;
    await inject(app, "PATCH", `/api/v1/cases/${caseId}`, { status: "InProgress" });
    await inject(app, "POST", `/api/v1/cases/${caseId}/close`, { verdict: "false_positive" });
    await inject(app, "POST", `/api/v1/alerts/${alert.id}/create-case`, {});
    const r = await inject(app, "POST", `/api/v1/alerts/${alert.id}/merge/${caseId}`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("merge_target_closed");
    await app.close();
  });
});

// ---------- 审计（INV-8）----------

test("任意写操作后 audit_entries 存在对应 diff 条目，PATCH 只记变更字段", async () => {
  const { app } = makeApp();
  const c = await inject(app, "POST", "/api/v1/cases", {
    title: "audit case",
    severity: 2,
    assignee: "soc1",
  });
  const id = c.json().id;
  await inject(
    app,
    "PATCH",
    `/api/v1/cases/${id}`,
    { title: "renamed", severity: 2, assignee: "duty_lead" },
    { "x-request-id": "req-42" },
  );
  const audit = await inject(app, "GET", `/api/v1/audit?objectId=${id}`);
  expect(audit.statusCode).toBe(200);
  const entries = audit.json();
  expect(entries.length).toBeGreaterThanOrEqual(2);
  const patchEntry = entries.find((e: { requestId: string }) => e.requestId === "req-42");
  expect(patchEntry.action).toBe("update");
  expect(patchEntry.actor.id).toBe("agent:triage");
  expect(patchEntry.result).toBe("SUCCESS");
  expect(patchEntry.details).toEqual({
    title: { from: "audit case", to: "renamed" },
    assignee: { from: "soc1", to: "duty_lead" },
  });
  const byRequest = await inject(app, "GET", "/api/v1/audit?requestId=req-42");
  expect(byRequest.json().length).toBe(1);
  await app.close();
});

// ---------- used_tokens 焚毁表（m9 依赖）----------

test("used_tokens 焚毁表：登记可查、jti 重复 409", async () => {
  const { app } = makeApp();
  const first = await inject(app, "POST", "/internal/used-tokens", {
    jti: "ap_01J9X7Q0TEST0000009",
    source: "approval_token",
  });
  expect(first.statusCode).toBe(201);
  const dup = await inject(app, "POST", "/internal/used-tokens", {
    jti: "ap_01J9X7Q0TEST0000009",
    source: "approval_token",
  });
  expect(dup.statusCode).toBe(409);
  const hit = await inject(app, "GET", "/internal/used-tokens/ap_01J9X7Q0TEST0000009");
  expect(hit.statusCode).toBe(200);
  expect(hit.json().burned).toBe(true);
  const miss = await inject(app, "GET", "/internal/used-tokens/tk_absent");
  expect(miss.statusCode).toBe(404);
  await app.close();
});

// ---------- outbox 事件出口（EventBus seam）----------

test("alert.created 写后事件可从 outbox 轮询消费，after 游标不重放", async () => {
  const { db, app } = makeApp();
  seedAlert(db);
  const poll1 = await inject(app, "GET", "/api/v1/events?after=0");
  expect(poll1.statusCode).toBe(200);
  const events = poll1.json().events;
  expect(events.length).toBe(1);
  expect(events[0].topic).toBe("alert.created");
  expect(events[0].payload.sourceRef).toMatch(/^wazuh-/);
  seedAlert(db);
  const poll2 = await inject(app, "GET", `/api/v1/events?after=${events[0].id}`);
  expect(poll2.json().events.length).toBe(1);
  expect(poll2.json().events[0].id).toBeGreaterThan(events[0].id);
  await app.close();
});

// ---------- REST 面：查询与 FR-M2.4 同主机归并 ----------

test("GET /alerts 过滤 status 与 host（经 hostname observable）", async () => {
  const { db, app } = makeApp();
  seedAlert(db);
  seedAlert(db, { observables: [{ dataType: "hostname", data: "db-01" }] });
  const all = await inject(app, "GET", "/api/v1/alerts");
  expect(all.json().length).toBe(2);
  const byHost = await inject(app, "GET", "/api/v1/alerts?host=db-01");
  expect(byHost.json().length).toBe(1);
  expect(byHost.json()[0].observables.some((o: { data: string }) => o.data === "db-01")).toBe(true);
  const byStatus = await inject(app, "GET", "/api/v1/alerts?status=New");
  expect(byStatus.json().length).toBe(2);
  await app.close();
});

test("GET /cases/active?host=&within_hours= 命中同主机活跃 case（FR-M2.4）", async () => {
  const { db, app } = makeApp();
  const alert = seedAlert(db);
  await inject(app, "POST", `/api/v1/alerts/${alert.id}/create-case`, {});
  const hit = await inject(app, "GET", "/api/v1/cases/active?host=web-01&within_hours=24");
  expect(hit.json().length).toBe(1);
  const miss = await inject(app, "GET", "/api/v1/cases/active?host=ghost-99&within_hours=24");
  expect(miss.json().length).toBe(0);
  await app.close();
});

test("timeline 读写：POST 后 GET 可见，kind/author 落位", async () => {
  const { app } = makeApp();
  const c = await inject(app, "POST", "/api/v1/cases", { title: "timeline case" });
  const id = c.json().id;
  const post = await inject(app, "POST", `/api/v1/cases/${id}/timeline`, {
    kind: "note",
    author: "soc1",
    body: "人工备注：主机已隔离",
  });
  expect(post.statusCode).toBe(201);
  const tl = await inject(app, "GET", `/api/v1/cases/${id}/timeline`);
  expect(tl.json().length).toBe(1);
  expect(tl.json()[0]).toMatchObject({ kind: "note", author: "soc1" });
  await app.close();
});

test("健康检查保持原样（骨架测试不回退）", async () => {
  const { app } = makeApp();
  const r = await inject(app, "GET", "/healthz");
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ ok: true, service: "case-backend" });
  await app.close();
});
