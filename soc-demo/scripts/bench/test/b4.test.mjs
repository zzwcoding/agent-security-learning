// m13 harness 单测 · b4.mjs：SSE 帧解析 / Last-Event-ID 游标与补发对账 / 延迟统计聚合 /
// docker stats 解析 / 表行渲染 + stub SSE 服务器打通真订阅客户端（离线，不依赖真栈）。
// 只喂公开面的 wire 形（text/event-stream 帧、M2 audit 行、docker stats 输出），
// 绝不 import services 内部（边界规则 R3）。
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createSseParser,
  advanceCursor,
  planReconnects,
  expectedBackfill,
  e2eLatencies,
  parseDockerStats,
  cpuStats,
  B4_SSE_TABLE_HEADER,
  B4_POLL_TABLE_HEADER,
  sseTableRow,
  pollTableRow,
  createSseClient,
  runPoller,
} from "../lib/b4.mjs";
import { latencyStats } from "../lib/b2.mjs";
import { percentile } from "../lib/b3.mjs";

// ---------- SSE 帧解析（增量、跨块、WHATWG 子集） ----------

test("parseSseFeed：单块多帧，id/event/data 逐字段解析，data 是 JSON", () => {
  const p = createSseParser();
  const frames = p.push(
    'id: 401\nevent: node_enter\ndata: {"type":"node_enter","run_id":"r1","node":"load_case","ts":100}\n\n' +
    'id: 402\nevent: tool_call\ndata: {"type":"tool_call","tool":"siem_query","ts":110}\n\n',
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 401);
  assert.equal(frames[0].event, "node_enter");
  assert.equal(frames[0].data.ts, 100);
  assert.equal(frames[0].data.node, "load_case");
  assert.equal(frames[1].id, 402);
  assert.equal(frames[1].data.tool, "siem_query");
});

test("parseSseFeed：帧跨块到达（半行悬挂），下一块续上不丢字段", () => {
  const p = createSseParser();
  assert.deepEqual(p.push('id: 7\nevent: audit\ndata: {"a"'), []);
  assert.deepEqual(p.push(': 1}\n'), []); // data 行没到换行——还悬着
  const frames = p.push('\n\nid: 8\nevent: done\ndata: {"ts":9}\n\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 7);
  assert.deepEqual(frames[0].data, { a: 1 });
  assert.equal(frames[1].event, "done");
});

test("parseSseFeed：CRLF 行尾与多行 data（拼接）；注释行忽略；空 data 帧不吐", () => {
  const p = createSseParser();
  const frames = p.push(
    'id: 1\r\nevent: token\r\ndata: {"part":\r\ndata: "x"}\r\n\r\n' +
    ': heartbeat comment\r\n\r\n',
  );
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data, { part: "x" });
  // 只有注释行的「帧」不算帧
  assert.deepEqual(p.push(": ping\n\n"), []);
});

test("advanceCursor：只前进不后退（Last-Event-ID 游标推进语义）", () => {
  let cursor = 400;
  cursor = advanceCursor(cursor, [{ id: 401 }, { id: 403 }]);
  assert.equal(cursor, 403);
  cursor = advanceCursor(cursor, []); // 空批次（100ms tick 空转）不动
  assert.equal(cursor, 403);
  cursor = advanceCursor(cursor, [{ id: 100 }]); // 乱序小 id 不回退
  assert.equal(cursor, 403);
});

// ---------- 重连补发对账 ----------

test("planReconnects：游标取自真实事件 id 集，期望补发数随游标递增铺满全程", () => {
  const ids = Array.from({ length: 11 }, (_, i) => 100 + i * 2); // 100..120 共 11 条
  const plan = planReconnects(ids, 5);
  assert.equal(plan.length, 5);
  for (const { cursor, expected } of plan) {
    assert.ok(ids.includes(cursor) || cursor === ids[0] - 1, `cursor ${cursor} 应来自 id 集或首 id 前一位`);
    assert.equal(expected, expectedBackfill(ids, cursor)); // 期望数=id 集>cursor 的条数
  }
  for (let i = 1; i < plan.length; i++) {
    assert.ok(plan[i].expected <= plan[i - 1].expected, "期望补发数应随订阅者序号单调不增");
  }
  assert.equal(plan[0].expected + 0, 10); // 第一个订阅者只「见过」首事件附近 → 回溯几乎全程
  assert.ok(plan.at(-1).expected >= 1 && plan.at(-1).expected <= 3);
});

test("expectedBackfill：空集与全量边界（重连语义不丢不重的账面）", () => {
  const ids = [5, 7, 9];
  assert.equal(expectedBackfill(ids, 4), 3); // cursor 在首事件前 → 全量补发
  assert.equal(expectedBackfill(ids, 7), 1);
  assert.equal(expectedBackfill(ids, 9), 0); // 全见过 → 补发 0（合法读数）
  assert.equal(expectedBackfill([], 0), 0);
});

// ---------- 延迟统计聚合 ----------

test("e2eLatencies：到达时刻−事件 ts；缺 ts/负漂移的样本剔除（钟差护栏）", () => {
  const frames = [
    { arrival: 1100, data: { ts: 1000 } }, // 100ms
    { arrival: 1250, data: { ts: 1200 } }, // 50ms
    { arrival: 1300, data: {} }, // 缺 ts → 剔
    { arrival: 1000, data: { ts: 1200 } }, // 早于 ts 100ms+（钟差伪影）→ 剔
  ];
  assert.deepEqual(e2eLatencies(frames, { maxSkewMs: 50 }), [100, 50]);
  const s = latencyStats(e2eLatencies(frames, { maxSkewMs: 50 }));
  assert.equal(s.n, 2);
  assert.equal(s.p50, 50);
  assert.equal(s.max, 100);
});

test("latencyStats/percentile 口径与 b3 一致（空集 NaN 不美化）", () => {
  assert.equal(percentile([], 50), NaN);
  const s = latencyStats([30, 10, 20]);
  assert.equal(s.n, 3);
  assert.equal(s.p99, 30);
});

// ---------- docker stats 解析与 CPU 聚合 ----------

test("parseDockerStats：--format 表输出 → 名称/CPU%/内存 MB（名称子串过滤）", () => {
  const raw = [
    "soc-demo-agent-1\t1.57%\t141.7MiB / 7.75GiB",
    "soc-demo-case-backend-1\t0.12%\t108.1MiB / 7.75GiB",
    "soc-demo-web-1\t0.10%\t243.8MiB / 7.75GiB",
    "", // 尾随空行
  ].join("\n");
  const rows = parseDockerStats(raw, ["agent", "case-backend"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "agent");
  assertAlmostEqual(rows[0].cpuPct, 1.57);
  assertAlmostEqual(rows[0].memUsedMB, 141.7);
  assert.equal(rows[1].name, "case-backend");
  assertAlmostEqual(rows[1].cpuPct, 0.12);
  // 找不到的容器不硬造
  assert.equal(parseDockerStats(raw, ["guards"]).length, 0);
});

test("cpuStats：中位/max 聚合（最近邻秩口径同 b3.percentile；docker 的 CPU% 可 >100）", () => {
  const s = cpuStats([1.0, 5.0, 9.0, 3.0]);
  assert.equal(s.n, 4);
  assertAlmostEqual(s.median, 3.0); // 最近邻秩：ceil(0.5*4)-1=1 → 排序后第 2 个
  assertAlmostEqual(s.max, 9.0);
  assert.equal(cpuStats([]).n, 0);
});

// ---------- 表行渲染 ----------

test("B4 表头与行渲染列数对齐（SSE 表 + 轮询对照表）", () => {
  const sseCols = headerCols(B4_SSE_TABLE_HEADER);
  const sseRow = sseTableRow({
    tier: 200, runEvents: 113, firstFrame: { p50: 5, p99: 30 },
    e2e: { p50: 60, p95: 120, p99: 200 }, backfill: { p50: 56, max: 112 },
    backfillMismatch: 0, cpu: { median: 22.5 }, baseline: { median: 1.2 },
  });
  assert.equal(sseRow.split("|").length - 2, sseCols.length);
  assert.match(sseRow, /^\| 200 \| 113 \| 5 \| 30 \| 60 \| 120 \| 200 \| 56 \| 112 \| 0 \| 22\.5 \| 1\.2 \|$/);

  const pollCols = headerCols(B4_POLL_TABLE_HEADER);
  const pRow = pollTableRow({
    tier: 200, windowSec: 20, requests: 3954, rps: 197.7,
    rtt: { p50: 12, p99: 80 }, visibility: { p50: 500, p99: 990 },
    errors: 0, cpu: { median: 8.1 },
  });
  assert.equal(pRow.split("|").length - 2, pollCols.length);
  assert.match(pRow, /^\| 200 \| 20 \| 3954 \| 198 \| 12 \| 80 \| 500 \| 990 \| 0 \| 8\.1 \|$/);
});

// ---------- stub SSE 服务器 × 真订阅客户端（离线全链路） ----------

test("createSseClient：挂流收帧、游标推进、服务端收流干净落地；重连带 Last-Event-ID 头", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, lastEventId: req.headers["last-event-id"] ?? null });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    if (!req.headers["last-event-id"]) {
      // 半行两写（帧本身 wire 完整）：验证解析端跨块拼接
      res.write('id: 1\nevent: node_enter\ndata: {"ts":1000}\n\nid: 2\nev');
      setTimeout(() => {
        res.write('ent: node_exit\ndata: {"ts":1050}\n\n');
        res.end();
      }, 20);
    } else {
      // 补发两帧后收流（服务端终态语义）
      res.write('id: 3\nevent: audit\ndata: {"ts":2000}\n\nid: 4\nevent: done\ndata: {"ts":2100}\n\n');
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createSseClient({ agent: null });

  const sub = await client.open({ url: `${base}/stream?run_id=r1` });
  assert.equal(seen[0].lastEventId, null);
  assert.equal(sub.lastEventId(), null); // 还没帧
  const outcome = await sub.done;
  assert.equal(outcome.closed, "server");
  assert.deepEqual(sub.frames.map((f) => f.id), [1, 2]);
  assert.deepEqual(sub.frames[1].data, { ts: 1050 }); // 跨块拼接成功（"…\nev"+"ent:…"）
  assert.ok(sub.firstFrameLatencyMs() >= 0);
  assert.equal(sub.lastEventId(), 2);
  assert.ok(sub.closedAtMs() >= 0);

  // 重连：带上游标 → 服务端补发 → 干净收流
  const sub2 = await client.open({ url: `${base}/stream?run_id=r1`, lastEventId: sub.lastEventId() });
  await sub2.done;
  assert.equal(seen[1].lastEventId, "2");
  assert.deepEqual(sub2.frames.map((f) => f.id), [3, 4]);
  assert.equal(sub2.lastEventId(), 4);

  await closeServer(server);
});

test("createSseClient：客户端主动断开（close）标记为 client，不抛未处理错误", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('id: 1\nevent: a\ndata: {"ts":1}\n\n');
    // 故意不 end——挂流
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const client = createSseClient({ agent: null });
  const sub = await client.open({ url: `http://127.0.0.1:${server.address().port}/s` });
  await new Promise((r) => setTimeout(r, 30));
  sub.close();
  const outcome = await sub.done;
  assert.equal(outcome.closed, "client");
  assert.equal(sub.frames.length, 1);
  await closeServer(server);
});

// ---------- 轮询客户端（1s 轮询对照的观测件） ----------

test("runPoller：RTT/可见延迟/新行记账齐全，stop 后干净退出", async () => {
  let t0 = Date.now();
  const server = http.createServer((req, res) => {
    const elapsed = Date.now() - t0;
    const rows = elapsed < 150 ? [] : [
      { id: 1, action: "create", objectId: "r1", objectType: "run", createdAt: t0 + 10 },
      { id: 2, action: "update", objectId: "r1", objectType: "run", createdAt: t0 + 220 },
    ];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t0 = Date.now();
  const poller = runPoller({ url: `http://127.0.0.1:${server.address().port}/api/v1/audit?objectId=r1`, intervalMs: 100 });
  await new Promise((r) => setTimeout(r, 450));
  const stats = poller.stop();
  assert.ok(stats.requests >= 3, `至少轮了 3 次（实际 ${stats.requests}）`);
  assert.equal(stats.errors, 0);
  assert.ok(stats.rtt.length === stats.requests);
  assert.ok(stats.rtt.every((x) => x >= 0));
  // 行 1（createdAt=t0+10）第一次见就该在；行 2 要等 150ms 后的轮次
  assert.deepEqual(stats.rowsSeen.map((r) => r.rowId), [1, 2]);
  for (const v of stats.visibility) {
    assert.ok(v >= -20, `可见延迟非负（钟差护栏内）：${v}`);
  }
  assert.ok(Array.isArray(stats.terminalSeen) && stats.terminalSeen.length === 0); // stub 无终态行
  await closeServer(server);
});

// ---------- 工具 ----------

function headerCols(header) {
  return header.split("\n")[0].split("|").map((s) => s.trim()).filter(Boolean);
}

/** stub 服务器收摊：close + 强断 keep-alive 空闲连接（fetch 客户端连接池会挂住进程）。 */
function closeServer(server) {
  server.closeAllConnections?.();
  const closed = new Promise((r) => server.close(r));
  return Promise.race([closed, new Promise((r) => setTimeout(r, 200))]);
}

function assertAlmostEqual(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) < eps, `期望 ≈${expected}，实际 ${actual}`);
}
