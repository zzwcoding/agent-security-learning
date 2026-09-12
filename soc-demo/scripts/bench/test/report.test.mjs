// m13 harness 单测 · report.mjs：autocannon result → markdown 行（P50/P95/P99/req/s/错误/复现命令）
// + 机器规格行 + 状态码对账行。喂合成 result，不依赖真压测。
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { machineSpec, machineSpecLine, benchRow, statusStatLine, B1_TABLE_HEADER } from "../lib/report.mjs";

const FAKE = {
  latency: { p50: 12.34, p95: 40.56, p99: 88.9 },
  requests: { average: 432.1 },
  errors: 2,
  non2xx: 1,
  statusCodeStats: { 201: { count: 4997 }, 200: { count: 1 } },
};

test("benchRow：一行含 P50/P95/P99/req/s/错误与复现命令", () => {
  const row = benchRow({ name: "gateway-mint", profile: "conn=20·500/s", result: FAKE, repro: "node scripts/bench/b1-endpoints.mjs gateway-mint" });
  assert.match(row, /^\| gateway-mint \| conn=20·500\/s \|/);
  assert.match(row, / 12\.3 \|/); // P50
  assert.match(row, / 40\.6 \|/); // P95
  assert.match(row, / 88\.9 \|/); // P99
  assert.match(row, / 432 \|/); // req/s
  assert.match(row, / 3 \|/); // errors+non2xx=3
  assert.match(row, /`node scripts\/bench\/b1-endpoints\.mjs gateway-mint` \|$/);
});

test("benchRow：缺档位回退 n/a（不硬造数字）", () => {
  const row = benchRow({ name: "x", profile: "p", result: { latency: {}, requests: {} }, repro: "r" });
  assert.match(row, / n\/a \| n\/a \| n\/a \| n\/a \| 0 \|/);
});

test("machineSpec：带 cpus/总内存/时间戳；machineSpecLine 一行引用块", () => {
  const spec = machineSpec(new Date("2026-09-12T00:00:00Z"));
  assert.equal(spec.cpuCores, os.cpus().length);
  assert.equal(spec.totalMemGB, Math.round(os.totalmem() / 2 ** 30));
  assert.equal(spec.timestamp, "2026-09-12T00:00:00.000Z");
  const line = machineSpecLine(spec);
  assert.match(line, /^> 机器：.+ × \d+ 核 · 内存 \d+ GB ·/);
});

test("statusStatLine：状态码计数对账行（201 新建/200 去重分支可见）", () => {
  const line = statusStatLine(FAKE);
  assert.match(line, /201=4997/);
  assert.match(line, /200=1/);
});

test("B1_TABLE_HEADER：七列对账（case/档位/三百分位/req/s/错误/复现命令）", () => {
  const cols = B1_TABLE_HEADER.split("\n")[0].split("|").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(cols, ["case", "档位", "P50(ms)", "P95(ms)", "P99(ms)", "req/s", "错误", "复现命令"]);
});
