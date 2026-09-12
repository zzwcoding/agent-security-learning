#!/usr/bin/env node
// m13 · B4 SSE 扇出压测（票 67；设计源 2026-09-12-压力测试方案.md §二#4/§三 B4）。
//
// 用法
//   node b4-sse.mjs                # probe + 三档全跑（50/100/200 订阅者）
//   node b4-sse.mjs 50 200         # 只跑指定档
//   node b4-sse.mjs probe          # 只跑小量试跑（2 订阅者，全链路先验）
//
// 测什么（理论天花板 #4：SSE 每订阅者 100ms 定时器扇出预算）
//   1 个高事件率 run × N 订阅者同时挂流，三个观测量：
//     ① 订阅者滞后——首帧延迟（connect→首帧）+ 补发长度（断线重连带 Last-Event-ID，
//        服务端按 id>cursor 补发的回溯条数，逐订阅者对账「不丢不重」）；
//     ② 事件到达 e2e 延迟分布——帧到达时刻 − 帧 data.ts（agent 钟；同宿主内核钟可直接相减）；
//     ③ agent 容器 CPU——docker stats --no-stream 定期采样（多核口径可 >100%）。
//   对照组：同 N 的 1s 轮询客户端（GET M2 /api/v1/audit?objectId=<run_id>，普通 fetch）——
//   「取餐铃 vs 轮询」的延迟/错误/case-backend CPU 对照。
//
// 高事件率 run 怎么造（实测选定，全部公开面）
//   · 实况相位：M2 `POST /api/v1/cases` 裸建案 + `POST /api/v1/cases/:id/observables`
//     灌 B4_OBSERVABLES 个 tlp/pap=0 的 ip observable（60s 内唯一数据防去重合并）→
//     `POST /internal/runs {kind:"case_flow"}` → 富化 worker 对 case observables 逐项
//     analyzer（每项 tool_call+tool_result 帧对）——事件量随灌入数线性走（~13+2K+尾数），
//     run 排队→终态全程对 N 个订阅者实况推送，终态服务端收流（app.ts isTerminalRun）。
//   · 停靠相位（纯「每订阅者 100ms 定时器」代价）：knowledge_flow 到 kb_write 人审闸
//     停靠（awaiting_approval，流不收）——N 个订阅者空闲挂流 B4_HOLD_SECONDS，
//     定时器每 100ms 空查一次事件总线（agent events.ts SSE_PUSH_INTERVAL_MS），
//     这一段的 agent CPU 就是每订阅者定时器的直接代价；同轮先采 0 订阅者基线相减。
//
// 观察口（零新增，全公开面）
//   · SSE 面 `GET /api/v1/events/stream?run_id=`（Last-Event-ID/`?after=` 同游标）——被测面本体；
//   · 轮询对照 `GET M2 /api/v1/audit?objectId=<run_id>`（run 状态迁移审计行，B3 同款读口）；
//   · 容器 CPU `docker stats --no-stream`（agent=扇出面 / case-backend=轮询面）；
//   · agent run_events 表规模无公开读口：hold 期每订阅者查询的是 eventsAfter(run_id,id>cursor)
//     （(run_id,id) 索引区间扫），表规模≈本轮累计事件行数，数字只同轮内比。
//
// 前置（脚本只预检不代建）
//   docker compose up -d（默认九服务 + .env AGENT_LLM=fake，EVENT_DRIVEN 默认 on）+
//   bash scripts/setup-openfga.sh；ingest/M2/agent/guards 四口 /healthz 全绿才起压。
//
// 实现注记
//   · undici 实测坑（Node 22.22）：fetch 流式响应缺省 bodyTimeout=300s，SSE 空闲挂流必被
//     单方面掐断（UND_ERR_BODY_TIMEOUT，真踩：301s terminated）——SSE 客户端用
//     bodyTimeout:0 的 dispatcher（lib/b4.mjs createSseClient）。
//   · SSE 客户端完全自实现（fetch-stream + 帧解析 + Last-Event-ID 重连），不用 EventSource、
//     不用 autocannon——施压面是长连流，autocannon 框架红线由 B1/B2/B3 兑现，本票不适用。
//   · 布景纪律：每轮 down→清 data→up（见报告方法节）；脚本内档位串行，同轮不并行别的压测。
import { Agent } from "undici";
import { execFile } from "node:child_process";
import { createHttpClient, waitHealthy } from "./lib/http.mjs";
import { makeAlert } from "./lib/gen-alert.mjs";
import { machineSpec, machineSpecLine } from "./lib/report.mjs";
import { latencyStats } from "./lib/b2.mjs";
import {
  createSseClient,
  runPoller,
  e2eLatencies,
  planReconnects,
  parseDockerStats,
  sampleDockerStats,
  cpuStats,
  B4_SSE_TABLE_HEADER,
  B4_POLL_TABLE_HEADER,
  sseTableRow,
  pollTableRow,
} from "./lib/b4.mjs";

const INGEST = process.env.BENCH_INGEST_URL ?? "http://127.0.0.1:3001";
const M2 = process.env.BENCH_M2_URL ?? "http://127.0.0.1:3002";
const AGENT = process.env.BENCH_AGENT_URL ?? "http://127.0.0.1:3003";
const GUARDS = process.env.BENCH_GUARDS_URL ?? "http://127.0.0.1:8001";
const TIERS = [50, 100, 200]; // 档位红线：不加码
const OBSERVABLES = Number(process.env.B4_OBSERVABLES ?? 50); // 高事件率 run 的旋钮
const HOLD_SECONDS = Number(process.env.B4_HOLD_SECONDS ?? 30); // 空闲挂流时长（≤120s）
const BASELINE_SECONDS = Number(process.env.B4_BASELINE_SECONDS ?? 12);
const POLL_BASELINE_SECONDS = Number(process.env.B4_POLL_BASELINE_SECONDS ?? 6); // 轮询面基线窗
const POLL_SECONDS = Number(process.env.B4_POLL_SECONDS ?? 20); // 轮询对照窗口
const SAMPLE_MS = Number(process.env.B4_SAMPLE_MS ?? 5000); // docker stats 采样间隔
const POLL_INTERVAL_MS = 1000; // 对照组口径：1s 轮询
const CARD_DEADLINE_MS = 90_000; // 等 kb_write 审批卡开出

const ingest = createHttpClient({ baseUrl: INGEST });
const m2 = createHttpClient({ baseUrl: M2 });
const agent = createHttpClient({ baseUrl: AGENT });
const guards = createHttpClient({ baseUrl: GUARDS });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`[b4] ${msg}`);
  process.exit(1);
};

// SSE 客户端：bodyTimeout=0（空闲挂流不被 undici 掐），连接数不设上限（N 档并发挂流）
const sseAgent = new Agent({ bodyTimeout: 0, headersTimeout: 30_000, connections: null });
const sse = createSseClient({ agent: sseAgent });

async function preflight() {
  for (const [name, client, url] of [
    ["ingest", ingest, INGEST],
    ["case-backend", m2, M2],
    ["agent", agent, AGENT],
    ["guards", guards, GUARDS],
  ]) {
    const ok = await waitHealthy(client, { tries: 3, intervalMs: 500 });
    if (!ok) fail(`${name} (${url}/healthz) 不绿——布景没起好，停下不硬压。`);
  }
}

// ---------- 容器名解析 + CPU 采样（docker stats 观察口） ----------

let STATS_NAMES = null; // agent / case-backend 的容器名，preflight 时解析
async function resolveStatNames() {
  // compose 项目前缀不硬编码：docker ps 找容器名
  const out = await new Promise((resolve) => {
    execFile("docker", ["ps", "--format", "{{.Names}}"], { timeout: 15_000 }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
  const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const agentName = names.find((n) => n.endsWith("-agent-1") || n === "agent");
  const m2Name = names.find((n) => n.includes("case-backend"));
  if (!agentName || !m2Name) fail(`docker ps 里找不到 agent/case-backend 容器（names=${names.join(",")}）`);
  STATS_NAMES = [agentName, m2Name];
}

/** 采一轮 docker stats，回 {agent: row, "case-backend": row}；失败回 {}。 */
async function sampleStatsOnce() {
  const rows = await sampleDockerStats({ names: STATS_NAMES });
  const byName = {};
  for (const row of rows) {
    const key = row.name.includes("case-backend") ? "case-backend" : "agent";
    byName[key] = row;
  }
  return byName;
}

/** 持续采样：每 SAMPLE_MS 一轮 agent/case-backend CPU，stop() 停并回样本
 *  （基线与加载段同一条采样线，按切点分账，docker stats 自身 1-2s 的采样耗时被自然吸收）。 */
function startCpuSampler() {
  const samples = [];
  let stopped = false;
  (async () => {
    while (!stopped) {
      const t = Date.now();
      const byName = await sampleStatsOnce();
      if (byName.agent || byName["case-backend"]) {
        samples.push({ t, agentCpu: byName.agent?.cpuPct ?? NaN, m2Cpu: byName["case-backend"]?.cpuPct ?? NaN });
      }
      const remain = SAMPLE_MS - (Date.now() - t);
      if (remain > 0) await sleep(remain);
    }
  })().catch(() => {});
  return {
    samples,
    stop() {
      stopped = true;
      return samples;
    },
  };
}

// ---------- 布景动作（全公开面，非 2xx 硬失败） ----------

/** 裸建案 + 灌 K 个唯一 ip observable（tlp/pap=0 必过 TLP/PAP 闸）→ 高事件率 run 的料。 */
async function highEventCase(tag, k) {
  const created = await m2("/api/v1/cases", {
    method: "POST",
    body: { title: `b4 ${tag}`, description: "b4 high-event-rate scenery" },
  });
  if (created.status !== 201 || !created.json?.id) {
    throw new Error(`POST /api/v1/cases 非 201（=${created.status} ${JSON.stringify(created.json)?.slice(0, 200)}）`);
  }
  const caseId = created.json.id;
  for (let i = 0; i < k; i++) {
    const o = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}/observables`, {
      method: "POST",
      body: { dataType: "ip", data: `10.66.${Math.floor(i / 256) % 256}.${i % 256}`, tlp: 0, pap: 0, ioc: true, message: `b4 ${tag} #${i}` },
    });
    if (o.status !== 201) throw new Error(`observable #${i} 非 201（=${o.status} ${o.text?.slice(0, 150)}）`);
  }
  return caseId;
}

/** 拉起 case_flow（公开正门 POST /internal/runs）→ 202 {run_id}。 */
async function launchCaseFlow(caseId) {
  const launched = await agent("/internal/runs", { method: "POST", body: { kind: "case_flow", case_id: caseId } });
  if (launched.status !== 202 || !launched.json?.run_id) {
    throw new Error(`/internal/runs case_flow 非 202（=${launched.status} ${JSON.stringify(launched.json)}）`);
  }
  return launched.json.run_id;
}

/** 停靠 run 布景（B3 closedCaseWithRun 同款）：关案带 verdict → 立刻手工拉 knowledge_flow
 *  （autorun 的 hasActiveRun 随即挡掉 case.closed 自动拉起）→ run 到 kb_write 人审闸停靠。 */
async function parkedKnowledgeRun(tag) {
  const pushed = await ingest("/api/v1/webhooks/alerts", { method: "POST", body: makeAlert({ host: `b4-${tag}` }) });
  if (pushed.status !== 201) throw new Error(`停靠布景 ingest 非 201（=${pushed.status}）`);
  const alertId = pushed.json.alert_id;
  const created = await m2(`/api/v1/alerts/${encodeURIComponent(alertId)}/create-case`, {
    method: "POST",
    body: { title: `b4 park ${tag}` },
  });
  if (created.status !== 201 || !created.json?.case?.id) throw new Error(`停靠布景 create-case 非 201（=${created.status}）`);
  const caseId = created.json.case.id;
  const opened = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}`, { method: "PATCH", body: { status: "InProgress" } });
  if (!opened.ok) throw new Error(`停靠布景 patch 非 2xx（=${opened.status}）`);
  const closed = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}/close`, {
    method: "POST",
    body: { verdict: "true_positive", verdictNote: "b4 scenery" },
  });
  if (!closed.ok) throw new Error(`停靠布景 close 非 2xx（=${closed.status}）`);
  const launched = await agent("/internal/runs", { method: "POST", body: { kind: "knowledge_flow", case_id: caseId } });
  if (launched.status !== 202 || !launched.json?.run_id) throw new Error(`knowledge_flow 非 202（=${launched.status}）`);
  const runId = launched.json.run_id;
  const deadline = Date.now() + CARD_DEADLINE_MS;
  while (Date.now() < deadline) {
    const r = await agent("/api/v1/approvals?status=pending", { timeoutMs: 10_000 });
    const card = (r.json?.approvals ?? []).find((c) => c.tool === "kb_write" && c.run_id === runId);
    if (card) return { runId, caseId, card };
    await sleep(250);
  }
  throw new Error(`${CARD_DEADLINE_MS}ms 内没等到 kb_write 审批卡——knowledge_flow 没停靠，检查布景`);
}

/** 停靠 run 收摊：驳回审批卡让 run 走终态（流全收，不留悬置审批）。失败只告警。 */
async function cleanupPark(card) {
  try {
    const r = await agent(`/api/v1/approvals/${encodeURIComponent(card.id)}/reject`, {
      method: "POST",
      body: { approver: "b4-bench", reason: "b4 scenery cleanup" },
    });
    if (!r.ok) console.error(`[b4] ⚠ 审批卡 ${card.id} 驳回非 2xx（=${r.status}）——布景残留，不影响读数`);
  } catch (e) {
    console.error(`[b4] ⚠ 审批卡驳回失败：${e.message}`);
  }
}

// ---------- SSE 相位动作 ----------

/** N 个订阅者同时挂流，等全部落地（服务端终态收流）。返回订阅句柄数组。 */
async function connectAndDrain(runId, n) {
  const subs = await Promise.all(
    Array.from({ length: n }, () => sse.open({ url: streamUrl(runId) })),
  );
  await Promise.all(subs.map((s) => s.done));
  return subs;
}

function streamUrl(runId) {
  return `${AGENT}/api/v1/events/stream?run_id=${encodeURIComponent(runId)}`;
}

// ---------- 三相位的一档 ----------

async function tier({ n, tag, holdSeconds, pollSeconds, observables, withProbeEcho }) {
  const t0 = Date.now();

  // —— 相位 A：高事件率 run 实况扇出 ——
  const caseId = await highEventCase(`${tag}-live`, observables);
  const liveRunId = await launchCaseFlow(caseId);
  const liveSubs = await connectAndDrain(liveRunId, n);

  // 对账：N 个订阅者所见 id 序列必须一致（同一张落盘总线的扇出一致性）
  const idSets = liveSubs.map((s) => s.frames.map((f) => f.id));
  const idSet = idSets[0] ?? [];
  let fanoutMismatch = 0;
  for (let i = 1; i < idSets.length; i++) {
    if (idSets[i].length !== idSet.length || idSets[i].some((v, j) => v !== idSet[j])) fanoutMismatch += 1;
  }
  if (idSet.length === 0) throw new Error(`实况相位 0 帧——run=${liveRunId} 没产生事件，布景坏了`);

  // —— 相位 A'：断线重连补发（Last-Event-ID 回溯，逐订阅者对账不丢不重） ——
  const plan = planReconnects(idSet, n);
  const reconnectSubs = await Promise.all(
    plan.map(({ cursor }) => sse.open({ url: streamUrl(liveRunId), lastEventId: cursor })),
  );
  await Promise.all(reconnectSubs.map((s) => s.done));
  let backfillMismatch = 0;
  const backfillLens = [];
  for (let i = 0; i < reconnectSubs.length; i++) {
    const got = reconnectSubs[i].frames.map((f) => f.id);
    const expect = plan[i].expected;
    backfillLens.push(got.length);
    // 不丢：条数=期望且逐条>cursor 严格递增到末事件；不重：无重复（严格递增已蕴含）。
    // expect=0（cursor=末事件，全部见过）是合法读数：空补发即对，不拿「末事件」硬卡。
    const strictRising = got.every((v, j) => (j === 0 ? v > plan[i].cursor : v === got[j - 1] + 1));
    const ok = expect === 0
      ? got.length === 0
      : got.length === expect && strictRising && got[got.length - 1] === idSet[idSet.length - 1];
    if (!ok) backfillMismatch += 1;
  }

  // —— 相位 B：停靠 run 空闲挂流（每订阅者 100ms 定时器的纯代价） ——
  const park = await parkedKnowledgeRun(`${tag}-park`);
  const sampler = startCpuSampler();
  await sleep(BASELINE_SECONDS * 1000); // 基线：0 订阅者（agent 常驻循环的底噪）
  const baselineCut = sampler.samples.length;
  const holdSubs = await connectAndHold(park.runId, n);
  await sleep(holdSeconds * 1000);
  for (const s of holdSubs) s.close();
  await Promise.allSettled(holdSubs.map((s) => s.done));
  await cleanupPark(park.card);
  const allSamples = sampler.stop();
  const baselineSamples = allSamples.slice(0, baselineCut);
  const holdSamples = allSamples.slice(baselineCut);

  // —— 相位 C：同 N 的 1s 轮询对照 ——
  // 顺序纪律：布景→基线采样（无轮询无 run）→立刻 launch→立刻开轮——轮询客户端必须
  // 赶在 run 的审计行落地之前挂上，否则可见延迟全被基线窗污染（首跑真踩：6s 基线
  // 夹在 launch 与开轮之间，终态可见延迟虚高成基线窗长）。
  const pollCaseId = await highEventCase(`${tag}-poll`, observables);
  const pollSampler = startCpuSampler();
  await sleep(POLL_BASELINE_SECONDS * 1000); // 轮询面基线（无轮询流量、run 未 launch）
  const pollBaselineCut = pollSampler.samples.length;
  const pollRunId = await launchCaseFlow(pollCaseId);
  const pollers = Array.from({ length: n }, () =>
    runPoller({ url: `${M2}/api/v1/audit?objectId=${encodeURIComponent(pollRunId)}`, intervalMs: POLL_INTERVAL_MS }),
  );
  await sleep(pollSeconds * 1000);
  const pollStats = pollers.map((p) => p.stop());
  const pollAllSamples = pollSampler.stop();
  const pollBaseline = pollAllSamples.slice(0, pollBaselineCut);
  const pollSamples = pollAllSamples.slice(pollBaselineCut);

  // —— 聚合 ——
  const firstFrames = liveSubs.map((s) => s.firstFrameLatencyMs()).filter(Number.isFinite);
  const e2e = latencyStats(liveSubs.flatMap((s) => e2eLatencies(s.frames)));
  const firstFrame = latencyStats(firstFrames);
  const backfill = latencyStats(backfillLens);
  const holdCpu = cpuStats(holdSamples.map((s) => s.agentCpu));
  const baselineCpu = cpuStats(baselineSamples.map((s) => s.agentCpu));

  const requests = pollStats.reduce((m, s) => m + s.requests, 0);
  const pollErrors = pollStats.reduce((m, s) => m + s.errors, 0);
  const rtts = pollStats.flatMap((s) => s.rtt);
  const rtt = latencyStats(rtts);
  const terminal = latencyStats(pollStats.flatMap((s) => s.terminalSeen));
  const pollCpu = cpuStats(pollSamples.map((s) => s.m2Cpu));
  const pollBaselineCpu = cpuStats(pollBaseline.map((s) => s.m2Cpu));
  const pollSecondsActual = pollSeconds;
  const rps = requests / pollSecondsActual;
  // 在途连接（Little's law）：N 客户端 × 1 req/s × 平均 RTT
  const inflightConns = n * ((Number.isFinite(rtt.p50) ? rtt.p50 : 0) / 1000);

  const row = {
    sse: sseTableRow({
      tier: n, runEvents: idSet.length, firstFrame, e2e, backfill, backfillMismatch,
      cpu: holdCpu, baseline: baselineCpu,
    }),
    poll: pollTableRow({
      tier: n, windowSec: pollSecondsActual, requests, rps, rtt, visibility: terminal,
      errors: pollErrors, cpu: pollCpu,
    }),
    raw: { n, idSet: idSet.length, fanoutMismatch, backfillMismatch, holdCpu, baselineCpu, rtt, terminal, requests, pollErrors, rps, inflightConns },
  };

  console.log(`\n#### 档 ${n}（tag=${tag}，${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  console.log(`- 高事件率 run=${liveRunId}（case=${caseId}，observables=${observables}）：事件 ${idSet.length} 条 × ${n} 订阅者，扇出序列不一致=${fanoutMismatch}`);
  const firstIds = idSet.slice(0, 3).join(",");
  console.log(`- 实况首帧 P50=${firstFrame.p50?.toFixed(1) ?? "n/a"}ms / e2e P50=${e2e.p50?.toFixed(1) ?? "n/a"}ms P99=${e2e.p99?.toFixed(1) ?? "n/a"}ms（事件 id ${firstIds}…${idSet.at(-1)}）`);
  console.log(`- 重连补发：中位 ${backfill.p50?.toFixed(0) ?? "n/a"} 条 / max ${backfill.max?.toFixed(0) ?? "n/a"} 条，对账差（不丢不重破坏）=${backfillMismatch}`);
  console.log(`- 停靠挂流 ${holdSeconds}s：agent CPU 中位 ${holdCpu.median?.toFixed(2) ?? "n/a"}%（基线 0 订阅者 ${baselineCpu.median?.toFixed(2) ?? "n/a"}%，样本 hold=${holdCpu.n}/base=${baselineCpu.n}）`);
  console.log(`- 轮询对照：${requests} 次（${rps.toFixed(1)} req/s）错误=${pollErrors}，RTT P50=${rtt.p50?.toFixed(1) ?? "n/a"}ms，终态可见延迟 P50=${terminal.p50?.toFixed(0) ?? "n/a"}ms（在途连接≈${inflightConns.toFixed(1)}），case-backend CPU 中位 ${pollCpu.median?.toFixed(2) ?? "n/a"}%（基线 ${pollBaselineCpu.median?.toFixed(2) ?? "n/a"}%）`);
  if (withProbeEcho) console.log("-（probe 口径：小参数验链路，数字不入报告）");
  return row;
}

/** N 个订阅者挂流并等首帧（停靠 run 不收流——hold 到点由调用方 close）。 */
async function connectAndHold(runId, n) {
  const subs = await Promise.all(
    Array.from({ length: n }, () => sse.open({ url: streamUrl(runId) })),
  );
  // 等每个订阅者拿到补发首帧（hold 计时从「已挂上」起算）；提前落地/超 30s 不再等
  await Promise.all(subs.map(async (s) => {
    let done = false;
    s.done.then(() => { done = true; }, () => { done = true; });
    const deadline = Date.now() + 30_000;
    while (s.frames.length === 0 && !done && Date.now() < deadline) await sleep(20);
  }));
  return subs;
}

// ---------- probe：2 订阅者全链路先验 ----------

async function probe() {
  console.error("[b4] probe：2 订阅者小参数全链路（实况→重连补发→停靠挂流→轮询对照）。");
  const r = await tier({
    n: 2, tag: `probe-${Date.now().toString(36)}`,
    holdSeconds: Number(process.env.B4_HOLD_SECONDS ?? 6),
    pollSeconds: Number(process.env.B4_POLL_SECONDS ?? 8),
    observables: 5, withProbeEcho: true,
  });
  if (r.raw.fanoutMismatch > 0 || r.raw.backfillMismatch > 0) {
    fail("probe 对账有缺口（扇出序列不一致/补发不丢不重破坏）——先修布景再上量。");
  }
  console.log("- probe 全绿，可以上量。");
  return r;
}

// ---------- 入口 ----------

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const arg = args[0] ?? "";
await preflight();
await resolveStatNames();
if (arg === "probe") {
  await probe();
} else {
  const requested = (arg === "" ? TIERS : args).map(Number);
  for (const t of requested) {
    if (!TIERS.includes(t)) fail(`未知档位：${t}（可选：${TIERS.join("/")}，或 probe）`);
  }
  await probe();
  const rows = [];
  for (const n of requested) {
    rows.push(await tier({
      n, tag: `t${n}-${Date.now().toString(36)}`,
      holdSeconds: HOLD_SECONDS, pollSeconds: POLL_SECONDS, observables: OBSERVABLES,
    }));
  }
  const spec = machineSpec();
  console.log(`\n### B4 · SSE 扇出（1 高事件率 run × N 订阅者 + 1s 轮询对照）`);
  console.log(`> 时间：${spec.timestamp}（本地，只同机比）`);
  console.log(machineSpecLine(spec));
  console.log(`> 复现：\`node scripts/bench/b4-sse.mjs ${requested.join(" ")}\`（默认布景 EVENT_DRIVEN=on + fake LLM；B4_OBSERVABLES/B4_HOLD_SECONDS/B4_POLL_SECONDS 可调）`);
  console.log(`\n**SSE 扇出（每档一行）**\n`);
  console.log(B4_SSE_TABLE_HEADER);
  for (const r of rows) console.log(r.sse);
  console.log(`\n**1s 轮询对照（每档一行）**\n`);
  console.log(B4_POLL_TABLE_HEADER);
  for (const r of rows) console.log(r.poll);
  console.log(`\n> 口径：首帧延迟=connect→首帧；e2e=帧到达−data.ts（同宿主内核钟）；补发=重连带 Last-Event-ID 服务端回溯条数（对账差≠0=不丢不重破坏）；`);
  console.log(`> hold CPU=knowledge_flow 停靠 run 上 N 订阅者空闲挂流期 agent 容器 CPU（docker stats 多核口径可 >100），基线=同 run 0 订阅者；`);
  console.log(`> 轮询终态可见延迟=audit 终态行 createdAt→轮询响应首见时刻；在途连接=N×RTT/1s（Little's law）。`);
}
