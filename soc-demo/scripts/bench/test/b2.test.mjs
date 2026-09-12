// m13 harness 单测 · b2.mjs：档位解析 / autocannon 速率调度映射 / outbox 事件×run 配对 /
// 错误分类 / 积压收敛判定 / 表行渲染。喂合成 wire 行（M2 GET /api/v1/events 与
// GET /api/v1/audit 的形），不依赖真栈——调度与汇总口径在离线侧锁定。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import autocannon from "autocannon";
import {
  parseModes,
  firePlan,
  buildAutocannonOpts,
  matchAlertRuns,
  latencyStats,
  classifyErrors,
  backlogPeak,
  drainInfo,
  B2_TABLE_HEADER,
  b2Row,
} from "../lib/b2.mjs";

// 合成 outbox 行（GET /api/v1/events wire：{id, topic, payload, createdAt}）
const ev = (id, alertId, sourceRef, at, topic = "alert.created") => ({
  id, topic, payload: { alertId, source: "wazuh", sourceRef }, createdAt: at,
});
// 合成 run 时间线（buildRunTimelines 输出的形）
const run = (runId, alertId, createdAt, status = "completed", terminalAt = createdAt + 500) => ({
  runId, alertId, createdAt, status, terminalAt,
});

// ---------- 档位解析 ----------

test("parseModes：burst 缺省两档 100/500；点名子集只跑点到的", () => {
  assert.deepEqual(parseModes(["burst"]), { mode: "burst", tiers: [100, 500] });
  assert.deepEqual(parseModes(["burst", "100"]), { mode: "burst", tiers: [100] });
  assert.deepEqual(parseModes(["burst", "500", "100"]), { mode: "burst", tiers: [500, 100] });
});

test("parseModes：sustained 缺省四档 2/4/6/8；点名子集保序", () => {
  assert.deepEqual(parseModes(["sustained"]), { mode: "sustained", tiers: [2, 4, 6, 8] });
  assert.deepEqual(parseModes(["sustained", "2", "6"]), { mode: "sustained", tiers: [2, 6] });
});

test("parseModes：无模式/未知模式/未知档位/超 8/s 纪律一律抛错", () => {
  assert.throws(() => parseModes([]), /burst|sustained/);
  assert.throws(() => parseModes(["nonsense"]), /burst|sustained/);
  assert.throws(() => parseModes(["burst", "300"]), /未知档位/);
  assert.throws(() => parseModes(["sustained", "10"]), /未知档位/); // sustained≤8/s 纪律
  assert.throws(() => parseModes(["sustained", "abc"]), /未知档位/);
});

// ---------- autocannon 速率调度映射（施压面红线：真 autocannon、conn≤20） ----------

test("firePlan：burst=amount 一次性真突发（无 overallRate/duration），connections=20", () => {
  const plan = firePlan({ mode: "burst", tier: 500 });
  assert.deepEqual(plan, { amount: 500, connections: 20 });
});

test("firePlan：sustained=duration×overallRate 开环恒速，默认 120s、低连接水位", () => {
  assert.deepEqual(firePlan({ mode: "sustained", tier: 2 }), {
    duration: 120, overallRate: 2, connections: 2,
  });
  assert.deepEqual(firePlan({ mode: "sustained", tier: 8, seconds: 60 }), {
    duration: 60, overallRate: 8, connections: 2,
  });
  for (const plan of [
    firePlan({ mode: "burst", tier: 100 }),
    firePlan({ mode: "sustained", tier: 8 }),
  ]) {
    assert.ok(plan.connections <= 20); // 档位红线
  }
});

// ---------- autocannon opts 构造（坑位钉死）+ 真 autocannon 冒烟 ----------

test("buildAutocannonOpts：path 必须落在 requests 条目内（顶层 path 会被缺省 / 覆盖→全 404 的真坑）", () => {
  for (const mode of ["burst", "sustained"]) {
    const opts = buildAutocannonOpts({
      baseUrl: "http://127.0.0.1:3001", path: "/api/v1/webhooks/alerts",
      mode, tier: mode === "burst" ? 100 : 2, uniqueBody: () => ({ n: Math.random() }),
    });
    assert.equal(opts.requests.length, 1);
    assert.equal(opts.requests[0].path, "/api/v1/webhooks/alerts");
    assert.equal(opts.requests[0].method, "POST");
    assert.equal(opts.requests[0].headers["content-type"], "application/json");
  }
});

test("buildAutocannonOpts：setupRequest 逐请求产唯一体（防 INV-6 去重吃量）", () => {
  const opts = buildAutocannonOpts({
    baseUrl: "http://x", path: "/p", mode: "burst", tier: 10,
    uniqueBody: ((n) => () => ({ n: ++n }))(0),
  });
  const r1 = opts.requests[0].setupRequest({ method: "POST" });
  const r2 = opts.requests[0].setupRequest({ method: "POST" });
  assert.notDeepEqual(r1.body, r2.body);
  assert.equal(r1.method, "POST");
});

test("autocannon 冒烟（真施压面）：路径严格 stub 上 burst 打满 201、零 non2xx——回归 404 坑", async () => {
  let hits = 0;
  const paths = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits++;
      paths.push(req.url);
      // 严格路径：不在白名单 = 404（复刻真 Fastify 行为，stub 不再对任意路径放行）
      if (req.url === "/api/v1/webhooks/alerts" && body.includes("\"n\":")) {
        res.writeHead(201);
        res.end(JSON.stringify({ alert_id: "x" }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const opts = buildAutocannonOpts({
      baseUrl: `http://127.0.0.1:${srv.address().port}`,
      path: "/api/v1/webhooks/alerts",
      mode: "burst", tier: 8,
      uniqueBody: ((n) => () => ({ n: ++n }))(0),
    });
    const result = await autocannon({ ...opts, connections: 2 });
    assert.equal(result.non2xx, 0);
    assert.equal(result.errors, 0);
    assert.equal(result.statusCodeStats?.["201"]?.count ?? 0, 8);
    assert.ok(paths.every((p) => p === "/api/v1/webhooks/alerts"));
    assert.equal(hits, 8);
  } finally {
    srv.close();
  }
});

// ---------- outbox 事件 × run 配对（e2e/cursor 滞后的口径核心） ----------

test("matchAlertRuns：一对一配对，e2e=run.createdAt−event.createdAt；非 alert.created 行忽略", () => {
  const { matched, unmatched, dupRuns } = matchAlertRuns(
    [
      ev(1, "a1", "t-001", 1000),
      ev(2, "a2", "t-002", 1100),
      ev(3, "a3", "t-003", 1200, "case.created"), // 其他 topic 不掺和
    ],
    [run("r1", "a1", 1500), run("r2", "a2", 3200)],
  );
  assert.equal(unmatched.length, 0);
  assert.equal(dupRuns, 0);
  assert.deepEqual(
    matched.map((m) => [m.alertId, m.e2eMs]),
    [["a1", 500], ["a2", 2100]],
  );
  assert.equal(matched[0].runId, "r1");
});

test("matchAlertRuns：sourceRef 前缀过滤他轮次事件；没拉起 run 的进 unmatched（积压抓手）", () => {
  const { matched, unmatched } = matchAlertRuns(
    [
      ev(1, "a1", "b2-t8-aaa-000001", 1000),
      ev(2, "a2", "b2-t8-aaa-000002", 1100),
      ev(3, "aX", "上一轮的-000003", 1200), // 前缀不符 = 别轮的流量
    ],
    [run("r1", "a1", 1500)],
    { sourceRefPrefix: "b2-t8-aaa" },
  );
  assert.deepEqual(matched.map((m) => m.alertId), ["a1"]);
  assert.deepEqual(unmatched.map((m) => m.alertId), ["a2"]);
});

test("matchAlertRuns：同 alert 双 run 取最早拉起，dupRuns 对账计数；failed 也算已拉起", () => {
  const { matched, dupRuns } = matchAlertRuns(
    [ev(1, "a1", "p-001", 1000)],
    [run("r2", "a1", 1800), run("r1", "a1", 1400, "failed")],
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].runId, "r1"); // 最早 create 的 run 才是「拉起」时刻
  assert.equal(matched[0].runStatus, "failed");
  assert.equal(matched[0].e2eMs, 400);
  assert.equal(dupRuns, 1); // autorun 竞速双拉的对账项
});

// ---------- 分位与错误分类 ----------

test("latencyStats：空集 NaN；非空走最近邻秩分位（同 b3 口径）", () => {
  const s = latencyStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.p50, NaN);
  const t = latencyStats([300, 100, 200, 400]);
  assert.deepEqual([t.n, t.p50, t.p95, t.p99, t.max], [4, 200, 400, 400, 400]);
});

test("classifyErrors：2xx/422/其他4xx/5xx/超时/网络六类分开计", () => {
  const r = classifyErrors({
    errors: 2,
    timeouts: 1,
    statusCodeStats: { 201: { count: 90 }, 422: { count: 5 }, 500: { count: 3 }, 400: { count: 1 } },
  });
  assert.deepEqual(
    [r.ok2xx, r.bad422, r.client4xx, r.server5xx, r.timeouts, r.network],
    [90, 5, 1, 3, 1, 2],
  );
  assert.equal(r.bad, 12); // 全部坏面 = 5+1+3+1+2
});

test("classifyErrors：statusCodeStats 缺失退化为 errors+timeouts；空结果全零", () => {
  assert.deepEqual(classifyErrors({ errors: 3, timeouts: 2 }), {
    ok2xx: 0, bad422: 0, client4xx: 0, server5xx: 0, timeouts: 2, network: 3, bad: 5,
  });
  assert.equal(classifyErrors({}).bad, 0);
});

// ---------- 积压收敛 ----------

test("backlogPeak/drainInfo：涨后归零 → 收敛，drainedAt=首次归零时刻", () => {
  const samples = [
    { t: 0, backlog: 0 }, { t: 1000, backlog: 5 }, { t: 2000, backlog: 8 },
    { t: 3000, backlog: 3 }, { t: 4000, backlog: 0 }, { t: 5000, backlog: 0 },
  ];
  assert.equal(backlogPeak(samples), 8);
  const d = drainInfo(samples);
  assert.equal(d.converged, true);
  assert.equal(d.drainedAt, 4000);
});

test("drainInfo：末样本未归零=不收敛；空样本=不收敛（n/a 口径）", () => {
  assert.equal(drainInfo([{ t: 0, backlog: 3 }, { t: 1000, backlog: 7 }]).converged, false);
  assert.equal(drainInfo([]).converged, false);
  assert.equal(drainInfo([]).drainedAt, null);
});

// ---------- 表行渲染 ----------

test("b2Row：13 列与表头对齐；NaN 渲染 n/a；收敛布尔渲染是/否", () => {
  const headerCols = B2_TABLE_HEADER.split("\n")[0].split("|").map((s) => s.trim()).filter(Boolean);
  const row = b2Row({
    tier: "4/s×120s", sent: 480, ok: 480,
    ingest: latencyStats([10, 20, 30]),
    e2e: latencyStats([]),
    throughput: 4.0, peak: 0, converged: true,
    err: classifyErrors({ statusCodeStats: { 201: { count: 480 } } }),
  });
  const cols = row.split("|").map((s) => s.trim()).filter((s) => s !== "");
  assert.equal(cols.length, headerCols.length);
  assert.match(row, /480\/480/);
  assert.match(row, /n\/a/); // 空 e2e 不硬造数字
  assert.match(row, / 是 /);
  assert.match(row, /\| 0 \| 0 \|/); // 422 与 5xx/超时 双零
});
