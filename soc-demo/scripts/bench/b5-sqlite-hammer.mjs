#!/usr/bin/env node
// m13 · B5 实验③ SQLite 写锤（票 69；设计源 2026-09-12-压力测试方案.md §三 B5/§二#3）。
//
// 用法
//   node b5-sqlite-hammer.mjs            # 并发档 1/4/16/64 爬梯（每档 10s，共约 1.5 分钟）
//   B5_HAMMER_SECONDS=10 B5_HAMMER_TIERS="1 4 16 64" 可调
//
// 应看到什么（理论天花板 #3：SQLite 单写者水位线——db.ts WAL + busy_timeout=5000）
//   只走 REST 公开写口（POST :3002/api/v1/alerts，M2 upsert）并发锤 case-backend——
//   **绝不以 rw 模式从宿主打开容器在写的 SQLite 文件**（跨界开柜 = 翻墙，红线）。
//   并发连接数爬档（closed-loop，每档饱和），预期曲线：
//   ①低档（C≤4）：零错误、延迟毫秒级——better-sqlite3 同步写 + 单进程单连接，写在本
//     进程内天然串行，低并发根本排不起队；
//   ②高档（C=64）：延迟抬升（HTTP 排队 + 同步写占用事件循环），req/s 出现吞吐平台；
//   ③busy 边界（5s 忙等水位线）：**默认拓扑下从公开面不可达**——M2 的库只有 M2 进程
//    一个写者（ingest/agent 的写全走 REST 汇入同一进程），busy_timeout 兜底的是「跨
//    进程写者」场景，本仓默认九服务里不存在第二个进程直接开这个库文件。所以实测给出
//    的水位线读数是「延迟陡升/超时起跳的并发档」，busy 5s 错误面预期为零——这是结论
//    不是失效（对照方案 §二#3 的理论机制，报告同记）。
//   422（验型闸拒收）与 5xx/超时/网络错分开计（同票 66 错误面口径）。
//
// 观察口（零新增，全 REST）：autocannon 直读 + 同窗 GET /healthz RTT 采样（写压下
// 健康口是否仍responsive—— shed/存活旁证）。写正确性对账：sourceRef 逐请求唯一
// （lib/gen-alert makeUpsertBody + setupRequest）→ 应 201 全量、200=0（INV-6 去重
// 没吃到任何一发）、无重复行。
//
// 施压面走 autocannon（框架红线；body 形态同 B1 m2-upsert 卡，可与其数字直接对表）。
//
// 前置（脚本只预检不代建）：默认九服务 + fake LLM；**本轮 EVENT_DRIVEN=off 起 agent**
// （同 B1 口径：写面微基准隔离 autorun 下游——autorun 若开着，每条 upsert 都会拉起
// alert_flow，锤的就不是 SQLite 写面了）。独立轮次纪律：down → rm -rf data →
// EVENT_DRIVEN=off up 起跑。
import autocannon from "autocannon";
import hdrPercentiles from "hdr-histogram-percentiles-obj";
import { createHttpClient, waitHealthy } from "./lib/http.mjs";
import { makeUpsertBody, nextId } from "./lib/gen-alert.mjs";
import { machineSpec, machineSpecLine, statusStatLine } from "./lib/report.mjs";
import { latencyStats } from "./lib/b2.mjs";
import {
  parseLadder,
  classifyHammer,
  hammerRow,
  B5_HAMMER_TABLE_HEADER,
} from "./lib/b5.mjs";

// 真 HDR p95（幂等，同 b1/b2）
if (!hdrPercentiles.percentiles.includes(95)) {
  hdrPercentiles.percentiles.push(95);
  hdrPercentiles.percentiles.sort((a, b) => a - b);
}

const M2 = process.env.BENCH_M2_URL ?? "http://127.0.0.1:3002";
const SECONDS = Math.max(5, Math.min(60, Number(process.env.B5_HAMMER_SECONDS ?? 10)));

const m2 = createHttpClient({ baseUrl: M2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`[b5-hammer] ${msg}`);
  process.exit(1);
};

async function preflight() {
  const ok = await waitHealthy(m2, { tries: 3, intervalMs: 500 });
  if (!ok) fail(`case-backend (${M2}/healthz) 不绿——布景没起好，停下不硬压。`);
}

/** 同窗 /healthz RTT 采样：写压下健康口的 responsive 旁证。 */
async function sampleHealthz({ seconds }) {
  const rtts = [];
  let errors = 0;
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const t = Date.now();
    try {
      const r = await m2("/healthz", { timeoutMs: 10_000 });
      if (r.ok) rtts.push(Date.now() - t);
      else errors += 1;
    } catch {
      errors += 1;
    }
    const remain = 500 - (Date.now() - t);
    if (remain > 0) await sleep(remain);
    if (Date.now() > deadline) break;
  }
  return { stats: latencyStats(rtts), errors };
}

// ---------- 入口 ----------

let ladder;
try {
  ladder = parseLadder(
    (process.argv.slice(2).filter((a) => !a.startsWith("-"))),
    { tiers: (process.env.B5_HAMMER_TIERS ?? "1 4 16 64").split(/\s+/).map(Number) },
  );
} catch (err) {
  fail(err.message);
}

await preflight();
console.error(`[b5-hammer] 实验③：POST :3002/api/v1/alerts 并发锤，档=${ladder.tiers.join("/")}，每档 ${SECONDS}s（布景口径 EVENT_DRIVEN=off，隔离 autorun）——`);

const rows = [];
const notes = [];
for (const tier of ladder.tiers) {
  const healthz = sampleHealthz({ seconds: SECONDS }); // 同窗采样，不 await 开跑
  const result = await autocannon({
    url: M2,
    connections: tier,
    duration: SECONDS,
    requests: [
      {
        method: "POST",
        path: "/api/v1/alerts",
        headers: { "content-type": "application/json" },
        setupRequest: (req) => ({
          ...req,
          body: JSON.stringify(makeUpsertBody({ source: "bench:hammer", sourceRef: `b5-hammer-${nextId()}` })),
        }),
      },
    ],
  });
  const hz = await healthz;
  const err = classifyHammer(result);
  const rl = result.latency ?? {};
  const lat = { p50: rl.p50, p95: rl.p95, p99: rl.p99, max: rl.max ?? NaN };
  const sent = result.requests?.total ?? result.requests?.count ?? NaN;
  rows.push({
    tier, sent, err, lat,
    throughput: result.requests?.average ?? NaN,
    healthzP50: hz.stats.p50,
  });
  notes.push(
    `- 档 C=${tier}：${statusStatLine(result)}；/healthz 同窗 RTT P50=${Number.isFinite(hz.stats.p50) ? `${hz.stats.p50.toFixed(1)}ms` : "n/a"}（errors=${hz.errors}），P99=${Number.isFinite(hz.stats.p99) ? `${hz.stats.p99.toFixed(1)}ms` : "n/a"}`,
  );
  if (err.bad > 0) process.exitCode = 1;
}

console.log(`\n### B5 实验③ · SQLite 写锤（REST 公开写口并发爬档）`);
console.log(`> 时间：${machineSpec().timestamp}（本地，只同机比）`);
console.log(machineSpecLine());
console.log(`> 复现：\`docker compose down && rm -rf data && JIAOTU_GATEWAY_URL= JIAOTU_API_KEY= EVENT_DRIVEN=off docker compose up -d\` 然后 \`node scripts/bench/b5-sqlite-hammer.mjs\``);
console.log(`> 口径：autocannon closed-loop connections=C 每档 ${SECONDS}s 饱和；POST /api/v1/alerts 逐请求唯一 sourceRef（201=新建，200=INV-6 去重——唯一化下应 200=0）；`);
console.log(`> 被测写路 = M2 单进程 better-sqlite3 同步写（WAL + busy_timeout=5000，db.ts 实测源码），无第二写者进程 → busy 错误面预期为零（结论见头注③）；`);
console.log(`> /healthz 同窗 RTT = 写压下健康口 responsive 旁证（同进程路由，不是 shed 语义）。`);
console.log("");
console.log(B5_HAMMER_TABLE_HEADER);
for (const r of rows) console.log(hammerRow(r));
console.log("");
for (const n of notes) console.log(n);
const wm = rows.find((r) => Number.isFinite(r.lat.p99) && r.lat.p99 >= 5000);
console.log(`- 5s 忙等水位线读数：${wm ? `档 C=${wm.tier} 的 p99 首次越过 5000ms` : "全档 p99 未越过 5000ms——busy 超时边界在默认拓扑的公开面上不可达（单写者进程内串行），实测水位线以延迟陡升档形式记录"}；`);
const firstSlow = rows.find((r) => Number.isFinite(r.lat.p99) && r.lat.p99 >= 1000);
console.log(`- 延迟陡升（p99≥1s）${firstSlow ? `首现在档 C=${firstSlow.tier}` : "未出现"}；吞吐平台 = 最高档 req/s ${Number.isFinite(rows.at(-1).throughput) ? Math.round(rows.at(-1).throughput) : "n/a"}/s（对照 B1 m2-upsert 限速档 500/s）。`);
