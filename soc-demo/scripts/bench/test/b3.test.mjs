// m13 harness 单测 · b3.mjs：审计行流 → run 时间线 / 队列深度时间序列 / 分位 / 档行渲染。
// 喂合成审计行（M2 GET /api/v1/audit 的 wire 形），不依赖真服务——观察口径在离线侧锁定。
import test from "node:test";
import assert from "node:assert/strict";
import {
  percentile,
  buildRunTimelines,
  reconstructSeries,
  peakQueued,
  summarizeTier,
  B3_TABLE_HEADER,
  b3TableRow,
  seriesLine,
} from "../lib/b3.mjs";

// 合成审计行工厂（字段名照 case-backend store.queryAudit 的 wire：objectType/details…）
const create = (runId, at, kind = "alert_flow", alertId = "a1") => ({
  id: 1, action: "create", objectId: runId, objectType: "run",
  details: { created: { kind, alertId, caseId: null } }, createdAt: at,
});
const update = (runId, at, to, extra = {}) => ({
  id: 2, action: "update", objectId: runId, objectType: "run",
  details: { status: { from: "x", to }, ...extra }, createdAt: at,
});
const triageSkip = (runId, at) => ({
  id: 3, action: "triage_skip", objectId: "alert-x", objectType: "alert",
  details: { run_id: runId, reason: "verdict_locked" }, createdAt: at,
});

test("percentile：最近邻秩（不插值美化），空集 NaN", () => {
  assert.equal(percentile([], 50), NaN);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2); // ceil(0.5*4)-1 = 1
  assert.equal(percentile([1, 2, 3, 4], 95), 4); // ceil(0.95*4)-1 = 3
  assert.equal(percentile([10, 20, 30], 99), 30);
});

test("buildRunTimelines：create/update 折成状态迁移，终态时刻与失败原因就位", () => {
  const { runs } = buildRunTimelines([
    create("r1", 1000),
    update("r1", 1100, "running"),
    update("r1", 1500, "completed"),
  ]);
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(r.kind, "alert_flow");
  assert.equal(r.alertId, "a1");
  assert.equal(r.status, "completed");
  assert.equal(r.terminalAt, 1500);
  assert.deepEqual(r.transitions.map((t) => t.to), ["queued", "running", "completed"]);
});

test("buildRunTimelines：failed 带 failReason；triage_skip 让路进 skippedRunIds + alert 映射", () => {
  const { runs, skippedRunIds, runsByAlert } = buildRunTimelines([
    create("r1", 1000, "alert_flow", "alert-1"),
    update("r1", 1200, "failed", { failReason: "mint_failed" }),
    triageSkip("r2", 1300),
    create("r2", 1005, "alert_flow", "alert-1"), // 同告警第二个 run = autorun 双拉
  ]);
  const r1 = runs.find((r) => r.runId === "r1");
  assert.equal(r1.failReason, "mint_failed");
  assert.ok(skippedRunIds.has("r2"));
  assert.deepEqual(runsByAlert.get("alert-1"), ["r1", "r2"]); // 双拉对账的抓手
});

test("reconstructSeries：queued→running→completed 的水位先涨后落，峰值可读", () => {
  const mk = (id, cAt, rAt, dAt) => ({
    runId: id, createdAt: cAt,
    transitions: [
      { at: cAt, to: "queued", reason: null },
      { at: rAt, to: "running", reason: null },
      { at: dAt, to: "completed", reason: null },
    ],
  });
  // 单领单：r1 跑完 r2 才跑（queue: 2→1→0）
  const runs = [mk("r1", 0, 100, 1000), mk("r2", 0, 1100, 2000)];
  const series = reconstructSeries(runs, { gridMs: 500 });
  assert.ok(series[0].queued >= 2);
  assert.equal(peakQueued(series), 2);
  assert.equal(series.at(-1).terminal, 2);
  assert.ok(series.every((s) => s.running <= 1)); // 并发上限 1 的形状
});

test("reconstructSeries：awaiting_approval 计入 running（非终态占用执行位口径）", () => {
  const runs = [{
    runId: "r1", createdAt: 0,
    transitions: [
      { at: 0, to: "queued", reason: null },
      { at: 100, to: "running", reason: null },
      { at: 200, to: "awaiting_approval", reason: null },
    ],
  }];
  // 网格 100ms：t=0 queued → t=100 running → t=200 awaiting（网格只到 max+grid/2）
  const series = reconstructSeries(runs, { gridMs: 100 });
  assert.equal(series[0].queued, 1);
  const last = series.at(-1); // 末点（压缩保留首末）：awaiting_approval 算 running 不算终态
  assert.equal(last.running, 1);
  assert.equal(last.terminal, 0);
});

test("summarizeTier：让路 run 剔除出延迟分布；吞吐=完成数/首末墙钟跨度", () => {
  const mk = (id, cAt, dAt, status = "completed") => ({
    runId: id, status, createdAt: cAt, terminalAt: dAt,
    transitions: [{ at: cAt, to: "queued", reason: null }, { at: dAt, to: status, reason: null }],
    failReason: null,
  });
  const runs = [mk("r1", 0, 1000), mk("r2", 0, 2000), mk("r3", 0, 5, "completed")];
  const { winning, yielded, latencies, throughput, failed } = summarizeTier(runs, new Set(["r3"]));
  assert.deepEqual(winning.map((r) => r.runId), ["r1", "r2"]);
  assert.equal(yielded.length, 1);
  assert.deepEqual(latencies, [1000, 2000]);
  assert.equal(failed.length, 0);
  assert.ok(Math.abs(throughput - 2 / 2) < 1e-9); // 2 条 / 2s
});

test("b3TableRow：一行含档位/成败/三分位/吞吐 vs 理论/峰值", () => {
  const summary = {
    winning: [1, 2, 3], yielded: [], failed: [],
    latencies: [100, 200, 300], throughput: 4.567,
  };
  const row = b3TableRow({ tier: 10, summary, peak: 7 });
  assert.match(row, /^\| 10 \| 3\/0\/0 \| 200 \| 300 \| 300 \| 4\.57 \| 10 \| 7 \|$/);
  const cols = B3_TABLE_HEADER.split("\n")[0].split("|").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(cols, ["档（并发拉起 run 数）", "completed/让路/failed", "P50(ms)", "P95(ms)", "P99(ms)", "实测吞吐(run/s)", "理论(run/s)", "队列峰值"]);
});

test("seriesLine：压缩成 t(s):queued 点列", () => {
  assert.equal(seriesLine([]), "（无样本）");
  const line = seriesLine([
    { t: 1000, queued: 5 },
    { t: 2000, queued: 3 },
    { t: 3000, queued: 0 },
  ]);
  assert.equal(line, "0.0s:5 1.0s:3 2.0s:0");
});
