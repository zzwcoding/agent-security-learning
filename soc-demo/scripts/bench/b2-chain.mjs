#!/usr/bin/env node
// m13 · B2 链路突发与持续流（票 66；设计源 2026-09-12-压力测试方案.md §三 B2、§六）。
//
// 用法
//   node b2-chain.mjs burst [100|500 …]      # 一次性灌 N 条告警进 webhook（缺省 100+500 两档）
//   node b2-chain.mjs sustained [2|4|6|8 …]  # R alerts/s 持续灌流（缺省四档；B2_SUSTAINED_SECONDS 可调，缺省 120s）
//
// 测什么（ingest 拐点）
//   ①ingest 面：autocannon 直打 POST :3001/api/v1/webhooks/alerts 的延迟分布/吞吐/错误
//     （422 坏包与 5xx/超时/网络错分开计——前者是验型闸 fail-closed，后者才是过载面）；
//   ②消费延迟（e2e）：alert.created outbox 事件（与告警落库同事务，M2 钟）→ run create
//     （审计钟，agent HttpAuditSink 汇入 M2 audit）——两侧容器共用宿主内核钟，可直接相减；
//   ③cursor 滞后（口径如实标注）：event_cursors 表无公开读口（agent 自有 SQLite），按票 66
//     授权口径以「逐事件消费延迟 + 未消化积压曲线（未拉起告警 + 已拉起未终态 run）」近似；
//   ④积压收敛：持续流停灌后积压是否归零（分母意识：B3 实测分发水位 4.6-4.8 run/s，
//     sustained 2/4 档预期稳态、6/8 档预期积压后收敛——以实测为准，方案 §六）。
//
// 施压红线：施压面必须走 autocannon（本文件真 import 真调用，opts 由 lib/b2.mjs
// buildAutocannonOpts 构造、离线单测锁定）；lib/http 的 fetch 包装只做链路编排（probe 布景）
// 与读表观察。autocannon 实测坑（b1 头注 + 本票新增，单测钉死）：
//   · path 必须写在 requests[] 条目内——顶层 path 被条目缺省 "/" 覆盖，100 发全 404（本票首跑真踩）；
//   · 逐请求唯一 body 必须走 requests[].setupRequest（idReplacement 的 Content-Length 错账会挂死服务端）；
//   · requests 数组每连接独立从 0 迭代——全局唯一 sourceRef 靠 setupRequest；
//   · 默认百分位集无 p95，起压前向 hdr-histogram-percentiles-obj 补插 95。
//
// 前置（脚本只预检不代建）
//   docker compose up -d（默认九服务 + fake LLM，EVENT_DRIVEN 用默认 on——B2 是链路测试，
//   off 会没有 autorun 拉起，probe 会当场失败）+ bash scripts/setup-openfga.sh；三口 /healthz 全绿。
//   观察一律走 REST（GET /api/v1/events、GET /api/v1/audit），绝不 rw 打开容器在写的 SQLite。
//   每档告警 host 逐条唯一（同主机活跃案触发 merge 分支会让 run 不可比，同 B3 口径）。
import autocannon from "autocannon";
import hdrPercentiles from "hdr-histogram-percentiles-obj";
import { createHttpClient, waitHealthy } from "./lib/http.mjs";
import { makeAlert, nextId } from "./lib/gen-alert.mjs";
import { machineSpecLine, machineSpec, statusStatLine } from "./lib/report.mjs";
import { buildRunTimelines, seriesLine } from "./lib/b3.mjs";
import {
  parseModes,
  buildAutocannonOpts,
  matchAlertRuns,
  latencyStats,
  classifyErrors,
  backlogPeak,
  drainInfo,
  B2_TABLE_HEADER,
  b2Row,
  DEFAULT_SUSTAINED_SECONDS,
} from "./lib/b2.mjs";

// 真 HDR p95（同 B1；幂等：重复跑不重复插）
if (!hdrPercentiles.percentiles.includes(95)) {
  hdrPercentiles.percentiles.push(95);
  hdrPercentiles.percentiles.sort((a, b) => a - b);
}

const INGEST = process.env.BENCH_INGEST_URL ?? "http://127.0.0.1:3001";
const M2 = process.env.BENCH_M2_URL ?? "http://127.0.0.1:3002";
const AGENT = process.env.BENCH_AGENT_URL ?? "http://127.0.0.1:3003";
const POLL_MS = 2000;
const AUDIT_POLL_MS = 3000;

const SUSTAINED_SECONDS = (() => {
  const n = Number(process.env.B2_SUSTAINED_SECONDS ?? DEFAULT_SUSTAINED_SECONDS);
  if (!Number.isFinite(n) || n < 10 || n > 600) {
    console.error(`[b2] B2_SUSTAINED_SECONDS 非法（${process.env.B2_SUSTAINED_SECONDS}），用缺省 ${DEFAULT_SUSTAINED_SECONDS}s`);
    return DEFAULT_SUSTAINED_SECONDS;
  }
  return n;
})();

const ingest = createHttpClient({ baseUrl: INGEST });
const m2 = createHttpClient({ baseUrl: M2 });
const agent = createHttpClient({ baseUrl: AGENT });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`[b2] ${msg}`);
  process.exit(1);
};

async function preflight() {
  for (const [name, client, url] of [
    ["ingest", ingest, INGEST],
    ["case-backend", m2, M2],
    ["agent", agent, AGENT],
  ]) {
    const ok = await waitHealthy(client, { tries: 3, intervalMs: 500 });
    if (!ok) fail(`${name} (${url}/healthz) 不绿——布景没起好，停下不硬压。`);
  }
}

// ---------- 观察口（全走 REST 读口；缺读口的口径见文件头注③） ----------

// outbox 事件增量游标 + 本进程见过的全部 alert.created（各档按 sourceRef 前缀自查，互不掺和）
let eventCursor = 0;
const ALL_EVENTS = [];

async function pollEvents() {
  for (let guard = 0; ; guard++) {
    const r = await m2(`/api/v1/events?after=${eventCursor}&limit=100`, { timeoutMs: 15_000 });
    if (!r.ok) throw new Error(`GET /api/v1/events HTTP ${r.status}`);
    const evs = r.json?.events ?? [];
    if (evs.length === 0) break;
    for (const e of evs) {
      eventCursor = Math.max(eventCursor, Number(e.id) || 0);
      if (e.topic === "alert.created" && typeof e.payload?.sourceRef === "string") ALL_EVENTS.push(e);
    }
    if (evs.length < 100 || guard > 2000) break;
  }
}

async function fetchRuns() {
  const r = await m2("/api/v1/audit", { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`GET /api/v1/audit HTTP ${r.status}`);
  return buildRunTimelines(r.json ?? []).runs;
}

const eventsByPrefix = (prefix) => ALL_EVENTS.filter((e) => e.payload.sourceRef.startsWith(prefix));

/** 采一个样：未拉起（autorun 未消费）+ 已拉起未终态（分发队列）= 未消化积压。 */
async function sample(prefix) {
  await pollEvents();
  const runs = await fetchRuns();
  const myEvents = eventsByPrefix(prefix);
  const myAlertIds = new Set(myEvents.map((e) => e.payload.alertId));
  const myRuns = runs.filter((r) => r.alertId !== null && myAlertIds.has(r.alertId));
  const { matched, unmatched, dupRuns } = matchAlertRuns(myEvents, runs);
  const inFlight = myRuns.filter((r) => r.terminalAt === null).length;
  return { t: Date.now(), backlog: unmatched.length + inFlight, matched, unmatched, myRuns, dupRuns };
}

// ---------- probe：2 条链路试跑（先验证推→拉→跑通再上量） ----------

async function probe() {
  console.error("[b2] probe：2 条小量试跑，验证 webhook→autorun→run 全链，再上量。");
  const prefix = `b2-probe-${Date.now().toString(36)}`;
  for (let i = 0; i < 2; i++) {
    const r = await ingest("/api/v1/webhooks/alerts", {
      method: "POST",
      body: makeAlert({ id: `${prefix}-${nextId()}`, host: `b2-probe-${nextId()}` }),
    });
    if (r.status !== 201) fail(`probe ingest 非 201（=${r.status}）——先修布景再上量。`);
  }
  const deadline = Date.now() + 180_000;
  for (;;) {
    const s = await sample(prefix);
    const done = s.matched.filter((m) => m.runStatus === "completed").length;
    if (done >= 2) {
      console.error("[b2] probe 全绿，可以上量。");
      return;
    }
    if (s.matched.length >= 2) {
      const bad = s.matched.find((m) => m.runStatus === "failed");
      if (bad) fail(`probe run failed（${bad.runId}）——查 agent 日志 warn=audit_ingest_failed/run_job_failed。`);
    }
    if (Date.now() > deadline) {
      fail("probe 180s 内没等到 2 条 completed run——若布景用了 EVENT_DRIVEN=off（B1 口径），B2 必须默认 on。");
    }
    await sleep(POLL_MS);
  }
}

// ---------- 开压（autocannon 编程 API，框架红线）+ 并行观察 ----------

/**
 * 一档：开压 + 观察到排干（或超时，如实出表）。
 * 返回 { row, notes, tierLabel }——markdown 聚合在入口统一打印。
 */
async function runTier({ mode, tier }) {
  const seconds = mode === "sustained" ? SUSTAINED_SECONDS : undefined;
  const sent = mode === "burst" ? tier : tier * seconds;
  const tag = `b2-${mode === "burst" ? `b${tier}` : `s${tier}-${seconds}s`}-${Date.now().toString(36)}`;
  const tierLabel = mode === "burst" ? `一次性灌${tier}条` : `${tier}/s×${seconds}s`;

  // 先把事件游标推进到当前头（probe 等布景事件不计入本档），再起压
  await pollEvents();
  const t0 = Date.now();
  const timeoutMs =
    t0 + (mode === "sustained" ? seconds * 1000 : 30_000) + 90_000 + Math.ceil(sent / 3) * 1000;

  console.error(`[b2] 档 ${tierLabel}：开压（共 ${sent} 条，sourceRef 前缀 ${tag}）……`);
  let firingDone = false;
  const resultP = autocannon(
    buildAutocannonOpts({
      baseUrl: INGEST,
      path: "/api/v1/webhooks/alerts",
      mode,
      tier,
      seconds,
      uniqueBody: () => makeAlert({ id: `${tag}-${nextId()}`, host: `b2-${nextId()}` }),
    }),
  ).then((r) => {
    firingDone = true;
    return r;
  });

  const samples = [];
  let last = null;
  let timedOut = false;
  for (;;) {
    await sleep(mode === "burst" && !firingDone ? 500 : POLL_MS); // burst 灌入窗口短，采密一点
    try {
      last = await sample(tag);
    } catch (err) {
      fail(`观察读表失败：${err.message}`);
    }
    samples.push({ t: last.t, backlog: last.backlog });
    const allTerminal = last.myRuns.every((r) => r.terminalAt !== null);
    if (firingDone && last.backlog === 0 && allTerminal && last.myRuns.length > 0) break;
    if (Date.now() > timeoutMs) {
      timedOut = true;
      console.error(`[b2] 档 ${tierLabel}：观察超时（积压=${last.backlog}，未终态 run=${last.myRuns.filter((r) => r.terminalAt === null).length}）——按手头读数出表。`);
      break;
    }
  }
  const result = await resultP;
  const elapsed = (Date.now() - t0) / 1000;

  // 汇总（autocannon 直读 + 读口重建时间线）
  const rl = result.latency ?? {};
  const ingestStats = {
    n: sent, p50: rl.p50, p95: rl.p95, p99: rl.p99, max: rl.max ?? NaN,
  };
  const e2eStats = latencyStats(last.matched.map((m) => m.e2eMs));
  const err = classifyErrors(result);
  const peak = backlogPeak(samples);
  const conv = drainInfo(samples);
  const failedRuns = last.myRuns.filter((r) => r.status === "failed");
  const launchDrainSec = conv.drainedAt !== null ? (conv.drainedAt - t0) / 1000 : null;
  const terminals = last.myRuns.filter((r) => r.terminalAt !== null).map((r) => r.terminalAt);
  const execDrainSec = terminals.length === last.myRuns.length && last.myRuns.length > 0
    ? (Math.max(...terminals) - t0) / 1000
    : null;

  if (err.bad > 0) process.exitCode = 1; // 错误面非零：表照出，但标失败（带错的档不入报告结论）

  const notes = [
    `- 档 ${tierLabel}：发送耗时 ${Number(result.duration ?? 0).toFixed(1)}s，观察全程 ${elapsed.toFixed(1)}s${timedOut ? "（**观察超时，读数不完整**）" : ""}；${statusStatLine(result)}`,
    `- 积压：峰值 ${peak} 条，收敛=${conv.converged ? "是" : "否"}，拉起+执行排干 ${launchDrainSec !== null ? `${launchDrainSec.toFixed(1)}s` : "未排干"}/${execDrainSec !== null ? `${execDrainSec.toFixed(1)}s` : "未排干"}；`,
    `  曲线（t(s):backlog）：${seriesLine(samples.map((s) => ({ t: s.t, queued: s.backlog })))}`,
    `- 消费延迟配对 ${e2eStats.n}/${sent}（unmatched 残余 ${last.unmatched.length}）；autorun 竞速双拉=${last.dupRuns}；failed run=${failedRuns.length}${failedRuns.length > 0 ? `（${failedRuns.map((f) => `${f.runId}:${f.failReason}`).join(", ")}）` : ""}`,
  ];

  return {
    row: b2Row({
      tier: tierLabel, sent, ok: err.ok2xx,
      ingest: ingestStats, e2e: e2eStats,
      throughput: result.requests?.average ?? NaN,
      peak, converged: conv.converged, err,
    }),
    notes,
    tierLabel,
    stats: { ingestStats, e2eStats, err, peak, conv, throughput: result.requests?.average },
  };
}

/** 拐点自动提示（报告结论的人肉判读素材）：错误率起跳档与延迟陡升档分开说。 */
function inflectionHints(tierLabels, statsList) {
  const errJump = statsList.findIndex((s) => s.err.bad > 0);
  let latJump = -1;
  for (let i = 1; i < statsList.length; i++) {
    const prev = statsList[i - 1].ingestStats.p99;
    const cur = statsList[i].ingestStats.p99;
    if (Number.isFinite(prev) && Number.isFinite(cur) && cur > prev * 2) {
      latJump = i;
      break;
    }
  }
  return [
    `- 错误率起跳档（422+5xx/超时>0）：${errJump === -1 ? "无——本量级未达 ingest 错误拐点" : `「${tierLabels[errJump]}」`}`,
    `- ingest P99 陡升档（>2×前一档）：${latJump === -1 ? "无" : `「${tierLabels[latJump]}」`}`,
  ];
}

// ---------- 入口 ----------

let args;
try {
  args = parseModes(process.argv.slice(2).filter((a) => !a.startsWith("-")));
} catch (err) {
  fail(err.message);
}

console.error(`[b2] 模式=${args.mode} 档位=${args.tiers.join("/")}（sustained 时长 ${SUSTAINED_SECONDS}s；布景默认口径 EVENT_DRIVEN=on + fake LLM）`);
await preflight();
await probe();

const rows = [];
const notesPerTier = [];
const tierLabels = [];
const statsList = [];
for (const tier of args.tiers) {
  const out = await runTier({ mode: args.mode, tier });
  rows.push(out.row);
  notesPerTier.push(out.notes);
  tierLabels.push(out.tierLabel);
  statsList.push(out.stats);
}

const spec = machineSpec();
const repro = args.mode === "burst"
  ? `node scripts/bench/b2-chain.mjs burst${args.tiers.length === 2 ? "" : ` ${args.tiers.join(" ")}`}`
  : `node scripts/bench/b2-chain.mjs sustained${args.tiers.length === 4 && SUSTAINED_SECONDS === DEFAULT_SUSTAINED_SECONDS ? "" : ` ${args.tiers.join(" ")}`}`;
const title = args.mode === "burst"
  ? `### B2 · 链路突发（一次性灌 webhook）`
  : `### B2 · 持续流（R alerts/s × ${SUSTAINED_SECONDS}s）`;
console.log(`\n${title}`);
console.log(`> 时间：${spec.timestamp}（本地，只同机比）`);
console.log(machineSpecLine(spec));
console.log(`> 复现：\`${repro}\`${args.mode === "sustained" ? "（B2_SUSTAINED_SECONDS 可调时长）" : ""}`);
console.log(`> 口径：消费延迟 = alert.created（outbox 钟，与落库同事务）→ run create（审计钟），两侧容器共用宿主内核钟；`);
console.log(`> event_cursors 无公开读口，cursor 滞后以「消费延迟 + 未消化积压（未拉起 + 已拉起未终态 run）」近似（票 66 授权口径）；`);
console.log(`> 积压收敛 = 停灌后未消化积压归零（分发水位分母见 B3：4.6-4.8 run/s）。`);
console.log("");
console.log(B2_TABLE_HEADER);
for (const row of rows) console.log(row);
console.log("");
for (const notes of notesPerTier) for (const n of notes) console.log(n);
console.log("");
console.log(`**拐点提示（自动判读，报告结论以数据为准）**`);
for (const line of inflectionHints(tierLabels, statsList)) console.log(line);
