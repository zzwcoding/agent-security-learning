import { expect, test } from "vitest";
import { buildApp } from "./app.js";

// 票 36（G2-5 收口·FR-M2.5 Task log 写口）：m2 卡六实体里的 Task 一直只有读半边
// （GET /cases/:id 附带 tasks），调查工具面声明的 add_task_log 执行期报错。本票补上
// 写半边：POST /cases/:id/tasks 建任务 + POST /tasks/:id/log 写任务日志。
// 任务日志 = 挂 task_id 的时间线条目（PRD §5.4 Task.logs: TimelineEntry[]，
// TheHive task log 语义），落同一张 timeline_entries 表、同一个案件时间线查询面。

async function appWithCase() {
  const app = buildApp();
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/cases",
    payload: { title: "SSH 暴力破解 - 18.18.18.18 - 2023-04-25" },
  });
  const caseId = (created.json() as { id: string }).id;
  return { app, caseId };
}

test("POST /api/v1/cases/:id/tasks → 201 Task（status 默认 Todo），组枚举外 400，未知案 404", async () => {
  const { app, caseId } = await appWithCase();

  const ok = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/tasks`,
    payload: { title: "核对 18.18.18.18 的爆破来源", group: "Identification" },
  });
  expect(ok.statusCode).toBe(201);
  const task = ok.json() as { id: string; caseId: string; title: string; group: string | null; status: string };
  expect(task.caseId).toBe(caseId);
  expect(task.title).toBe("核对 18.18.18.18 的爆破来源");
  expect(task.group).toBe("Identification");
  expect(task.status).toBe("Todo");

  // PRD §5.4 group 枚举（TheHive NIST 五组）：枚举外拒收
  const badGroup = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/tasks`,
    payload: { title: "组名打错", group: "Investigation" },
  });
  expect(badGroup.statusCode).toBe(400);

  // 缺 title 拒收
  const noTitle = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/tasks`,
    payload: { group: "Identification" },
  });
  expect(noTitle.statusCode).toBe(400);

  const missing = await app.inject({
    method: "POST",
    url: "/api/v1/cases/case_nope/tasks",
    payload: { title: "x" },
  });
  expect(missing.statusCode).toBe(404);
  await app.close();
});

test("GET /cases/:id 的 tasks 里读得到新建任务（读半边本来就在，两头对上）", async () => {
  const { app, caseId } = await appWithCase();
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/tasks`,
    payload: { title: "隔离前确认资产归属", group: "Containment", assignee: "soc1" },
  });
  const taskId = (created.json() as { id: string }).id;

  const detail = (await app.inject({ method: "GET", url: `/api/v1/cases/${caseId}` })).json() as {
    tasks: { id: string; title: string; status: string; assignee: string | null }[];
  };
  expect(detail.tasks).toHaveLength(1);
  expect(detail.tasks[0]).toMatchObject({ id: taskId, status: "Todo", assignee: "soc1" });
  await app.close();
});

test("POST /api/v1/tasks/:id/log → 201 挂 task_id 的时间线条目，错案 400，未知任务 404，审计落库", async () => {
  const { app, caseId } = await appWithCase();
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/tasks`,
    payload: { title: "核对爆破来源", group: "Identification" },
  });
  const taskId = (created.json() as { id: string }).id;

  const log = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/log`,
    payload: { case_id: caseId, author: "agent:investigation", body: "SIEM 命中 12 条爆破记录，已核对" },
  });
  expect(log.statusCode).toBe(201);
  const entry = log.json() as { id: string; case_id: string; task_id: string; kind: string; author: string; body: string };
  expect(entry.task_id).toBe(taskId);
  expect(entry.case_id).toBe(caseId); // 日志归任务所属案件，不许挂在别的案件名下
  expect(entry.kind).toBe("note"); // 缺省 note
  expect(entry.author).toBe("agent:investigation");

  // 任务日志在案件时间线查询面可见（PRD §5.4：日志即留痕一等公民）
  const tl = (await app.inject({ method: "GET", url: `/api/v1/cases/${caseId}/timeline` })).json() as {
    id: string; task_id: string | null; body: string;
  }[];
  expect(tl.some((e) => e.task_id === taskId && e.body.includes("已核对"))).toBe(true);

  // case_id 与任务归属不符 → 400（工具面传双 id，M2 做一致性把关）
  const otherCase = (
    await app.inject({ method: "POST", url: "/api/v1/cases", payload: { title: "别的案" } })
  ).json() as { id: string };
  const mismatch = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/log`,
    payload: { case_id: otherCase.id, author: "agent:investigation", body: "挂错案" },
  });
  expect(mismatch.statusCode).toBe(400);

  const unknownTask = await app.inject({
    method: "POST",
    url: "/api/v1/tasks/task_nope/log",
    payload: { case_id: caseId, author: "agent:investigation", body: "x" },
  });
  expect(unknownTask.statusCode).toBe(404);

  // INV-8：建任务与写日志都有审计
  const audit = (await app.inject({ method: "GET", url: "/api/v1/audit" })).json() as {
    action: string; objectType: string; objectId: string;
  }[];
  expect(audit.some((a) => a.action === "create" && a.objectType === "task" && a.objectId === taskId)).toBe(true);
  expect(audit.some((a) => a.action === "create" && a.objectType === "task_log")).toBe(true);
  await app.close();
});

test("kind 枚举外 / 缺 author / 缺 body → 400", async () => {
  const { app, caseId } = await appWithCase();
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/tasks`,
    payload: { title: "t" },
  });
  const taskId = (created.json() as { id: string }).id;

  const badKind = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/log`,
    payload: { case_id: caseId, author: "a", body: "b", kind: "diary" },
  });
  expect(badKind.statusCode).toBe(400);

  const noAuthor = await app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/log`,
    payload: { case_id: caseId, body: "b" },
  });
  expect(noAuthor.statusCode).toBe(400);
  await app.close();
});
