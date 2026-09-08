import { describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDb } from "./db.js";
import { createAlert } from "./store.js";

// 票 13 新增的 alert 写入口：m4 卡接口契约「产出写回 M2：PATCH /api/v1/alerts/:id
// {verdict_ai:{...}}」+ FR-M4.5 verdict 锁（拾取即置 in-progress，防重复拾取）。
// verdict 生命周期（PRD §5.1）：null → in-progress（锁定，条件更新 WHERE verdict IS NULL）→ 终值。

function makeApp() {
  const db = openDb(":memory:");
  const app = buildApp({ db });
  return { db, app };
}

let seq = 0;
function seedAlert(db: ReturnType<typeof openDb>) {
  seq += 1;
  return createAlert(db, {
    type: "wazuh_alert",
    source: "wazuh:soc-demo",
    sourceRef: `patch-${seq}`,
    title: "Multiple failed logins for user root",
    severity: 3,
    tags: ["mitre:T1110"],
    date: Date.now(),
  }) as { id: string };
}

async function patch(app: FastifyInstance, id: string, body: object) {
  const res = await app.inject({ method: "PATCH", url: `/api/v1/alerts/${id}`, payload: body });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe("PATCH /api/v1/alerts/:id（m4 写回 + FR-M4.5 verdict 锁）", () => {
  test("拾取：verdict null → in-progress，条件更新放行；verdict_ai 随后可写", async () => {
    const { db, app } = makeApp();
    const { id } = seedAlert(db);
    const claim = await patch(app, id, { verdict: "in-progress" });
    expect(claim.status).toBe(200);
    expect(claim.body.verdict).toBe("in-progress");

    const outcome = await patch(app, id, {
      verdict: "true_positive",
      verdict_ai: { verdict: "tp", confidence: 0.9, rationale: "brute force", agent_run_id: "run_1" },
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.verdict).toBe("true_positive");
    expect(outcome.body.verdictAi).toMatchObject({ verdict: "tp", confidence: 0.9 });
    await app.close();
  });

  test("并发防重复拾取：已 in-progress 再 claim → 409 verdict_locked（WHERE verdict IS NULL）", async () => {
    const { db, app } = makeApp();
    const { id } = seedAlert(db);
    await patch(app, id, { verdict: "in-progress" });
    const second = await patch(app, id, { verdict: "in-progress" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("verdict_locked");
    await app.close();
  });

  test("生命周期门：null 直接写终值 → 409 verdict_locked（必须先拾取）", async () => {
    const { db, app } = makeApp();
    const { id } = seedAlert(db);
    const r = await patch(app, id, { verdict: "false_positive" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("verdict_locked");
    await app.close();
  });

  test("终值不能再改：true_positive 后改 uncertain → 409（终值即终局）", async () => {
    const { db, app } = makeApp();
    const { id } = seedAlert(db);
    await patch(app, id, { verdict: "in-progress" });
    await patch(app, id, { verdict: "true_positive" });
    const r = await patch(app, id, { verdict: "uncertain" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("verdict_locked");
    await app.close();
  });

  test("未知 alert → 404；非法 verdict 枚举 → 409 verdict_required", async () => {
    const { db, app } = makeApp();
    const missing = await patch(app, "al_nope", { verdict: "in-progress" });
    expect(missing.status).toBe(404);

    const { id } = seedAlert(db);
    await patch(app, id, { verdict: "in-progress" });
    const bad = await patch(app, id, { verdict: "totally_wrong" });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("verdict_required");
    await app.close();
  });

  test("uncertain 人工待办同 PATCH 内带 status：New→InProgress 合法转移放行；非法转移 409", async () => {
    const { db, app } = makeApp();
    const a = seedAlert(db);
    await patch(app, a.id, { verdict: "in-progress" });
    const r = await patch(app, a.id, {
      verdict: "uncertain",
      status: "InProgress",
      verdict_ai: { verdict: "uncertain", recommended_action: "human" },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("InProgress");

    // Imported 只能从 InProgress 来；New 状态的 alert 直接 patch 成 Imported → 409
    const b = seedAlert(db);
    const bad = await patch(app, b.id, { status: "Imported" });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe("InvalidTransition");
    await app.close();
  });

  test("任意写操作落审计 diff（INV-8）：claim 与终值各一条，diff 只含变更字段", async () => {
    const { db, app } = makeApp();
    const { id } = seedAlert(db);
    await patch(app, id, { verdict: "in-progress" });
    await patch(app, id, { verdict: "true_positive", verdict_ai: { verdict: "tp" } });
    const res = await app.inject({ method: "GET", url: `/api/v1/audit?objectId=${id}` });
    const entries = res.json() as { action: string; details: Record<string, unknown> }[];
    const patches = entries.filter((e) => e.action === "patch");
    expect(patches).toHaveLength(2);
    expect(patches[0].details).toMatchObject({ verdict: { from: null, to: "in-progress" } });
    expect(patches[1].details).toMatchObject({
      verdict: { from: "in-progress", to: "true_positive" },
    });
    await app.close();
  });
});
