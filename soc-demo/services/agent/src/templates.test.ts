// 票 92：GET /api/v1/templates —— 模板登记面的公开只读投影（m14 公开接口补卡）。
//
// seam 形态（全仓约定）：buildApp 注入 templates 提供口，生产装配（index.ts）接
// HuntTemplateSource 登记面的投影——本件只测「投影零业务分支 + 路由壳」，登记面本体
// （workers/investigation/hunt-pack.ts）与机制格式契约（orchestration/template.ts）
// 零触碰（只 import 消费）。R10：清单数据不是狩猎业务逻辑——字段名照模板文件原样，
// 数据读出即返回；未登记 = 空数组（不报错）。鉴权口径与既有公开读面 /api/v1/approvals
// 一致（无中间件，用例不带任何凭据头即断言到）。
import { test, expect } from "vitest";
import { buildApp, toTemplateListRow, type TemplateListRow } from "./app.js";
import { openDb } from "./db.js";
import { MemoryAuditSink } from "./audit.js";
import { HuntTemplateSource } from "../workers/investigation/hunt-pack.js";
import { DefaultTemplateSource } from "./orchestration/template.js";

function appWith(over: { templates?: () => TemplateListRow[] } = {}) {
  const app = buildApp({
    db: openDb(":memory:"),
    audit: new MemoryAuditSink(),
    dispatcher: false, // 只读 GET 面：不启动分发循环
    ...over,
  });
  return app;
}

test("GET /api/v1/templates 未登记（seam 未注入）→ 200 {templates: []}，不报错", async () => {
  const app = appWith();
  const res = await app.inject({ method: "GET", url: "/api/v1/templates" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ templates: [] });
  await app.close();
});

test("GET /api/v1/templates 读出即返回（零业务分支）：seam 给什么投影回什么", async () => {
  const rows: TemplateListRow[] = [
    { template_id: "hunt_x", hypothesis_patterns: ["怀疑主机 {host} 存在 X"], menu: ["siem_query", "kb_lookup"], max_rounds: 4 },
  ];
  let calls = 0;
  const app = appWith({
    templates: () => {
      calls += 1;
      return rows;
    },
  });
  const res = await app.inject({ method: "GET", url: "/api/v1/templates" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ templates: rows });
  expect(calls).toBe(1); // 每请求一取，不缓存不加工
  await app.close();
});

test("投影：字段名照模板文件原样（template_id/假设句式族/菜单子集/轮次上限），内容计划不外发", () => {
  const row = toTemplateListRow({
    template_id: "t1",
    family: "f1",
    title: "演示模板",
    hypothesis_patterns: ["怀疑 {host}…"],
    menu: ["kb_lookup"],
    max_rounds: 6,
    max_tasks: 2,
    default_time_window: { from: "2023-04-25T00:00:00.000Z", to: "2023-04-26T00:00:00.000Z" },
    example_slots: { host: "web01" },
    waves: [[{ tool: "kb_lookup", params: {}, rationale: "r" }]],
  });
  expect(Object.keys(row).sort()).toEqual(["hypothesis_patterns", "max_rounds", "menu", "template_id"]);
  expect(row).toEqual({
    template_id: "t1",
    hypothesis_patterns: ["怀疑 {host}…"],
    menu: ["kb_lookup"],
    max_rounds: 6,
  });
});

test("装配级对账：真登记面（fixtures/hunt-templates）上线即出已登记模板——票 79 三族 + 票 80 ir 同面可见", async () => {
  // 生产同款投影链（index.ts 装配的纯函数版）：HuntTemplateSource.all → toTemplateListRow
  const source = new HuntTemplateSource(new DefaultTemplateSource());
  const app = appWith({ templates: () => source.all.map(toTemplateListRow) });
  const res = await app.inject({ method: "GET", url: "/api/v1/templates" });
  expect(res.statusCode).toBe(200);
  const list = res.json().templates as TemplateListRow[];
  // 装载按 template_id 排序（loadHuntTemplates 口径）——下拉顺序稳定
  expect(list.map((t) => t.template_id)).toEqual([
    "hunt_c2_beacon",
    "hunt_credential_leak",
    "hunt_webshell",
    "ir_host_compromise",
  ]);
  for (const t of list) {
    expect(t.hypothesis_patterns.length).toBeGreaterThan(0); // 假设句式族在位
    expect(t.menu.length).toBeGreaterThan(0); // 菜单子集在位
    expect(Number.isInteger(t.max_rounds) && t.max_rounds > 0).toBe(true); // 轮次上限在位
  }
  await app.close();
});
