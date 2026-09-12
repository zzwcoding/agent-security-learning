#!/usr/bin/env node
// m13 · B3 分发循环水位爬坡（票 65；设计源 2026-09-12-压力测试方案.md §二#1/§三 B3）。
//
// 用法
//   node b3-dispatcher.mjs              # 小量试跑（probe）+ 五档全跑（1/5/10/20/50）
//   node b3-dispatcher.mjs 10 50        # 只跑指定档（跳过 probe）
//   node b3-dispatcher.mjs probe        # 只跑小量试跑（2 条，验证拉起成功率）
//   node b3-dispatcher.mjs ttl          # 加测：审批 TTL 过期裁决延迟（见下方前置）
//
// 测什么（理论天花板 #1：run-dispatcher 100ms tick）
//   每档并发批量拉起 N 个 alert_flow（经 agent 公开正门 POST /internal/runs，202 {run_id}
//   秒回），记录 ①队列深度时间序列 ②run queued→completed 端到端延迟 P50/P95/P99
//   ③实测分发吞吐 run/s 对照理论 ~10 run/s（100ms tick 单领单假设）。
//
// 观察口（零新增，全走现有读口）
//   · run 状态/时刻真相 = M2 GET /api/v1/audit（agent HttpAuditSink 五要素汇入，createdAt
//     是 agent 记录时刻——投递延迟不污染时刻）。run 的 create/update 行带状态迁移，
//     时间序列离线重构，压测中只做终态判定的轻量轮询（1s 一发）。
//   · run_jobs 表无公开读口：队列深度用 runs 状态分布近似（start 任务 pending ↔ queued
//     run 一一对应，claimed 窗口短暂计入 running）——口径在报告如实标注。
//   · 绝不从宿主 rw 打开容器在写的 SQLite（布景纪律同 B1）。
//
// 前置（脚本只预检不代建）
//   docker compose up -d（默认九服务 + fake LLM，.env AGENT_LLM=fake）+ bash scripts/setup-openfga.sh；
//   四口 /healthz 全绿。EVENT_DRIVEN 保持默认 on（B3 口径，autorun 是同一队列的另一生产者，
//   双拉竞速由「推一条→立刻拉一条」压到单条毫秒级窗口，dup 会被对账出来，见 tierReport）。
//   观察一律走 REST。
//
// ttl 加测前置（APPROVAL_TTL 配置面：run-dispatcher approvalTtlSecondsFromEnv，缺省 86400s，
// 只在 agent 启动时读一次——compose 未透传该 env，用 /tmp override 注入，零仓库改动）：
//   cat > /tmp/b3-ttl-override.yml <<'EOF'
//   services:
//     agent:
//       environment:
//         APPROVAL_TTL_SECONDS: "5"
//   EOF
//   cd soc-demo && docker compose -f docker-compose.yml -f /tmp/b3-ttl-override.yml up -d --no-deps agent
//   node b3-dispatcher.mjs ttl          # B3_TTL_SECONDS=5 缺省，改了 override 就改这里
//   docker compose up -d --no-deps agent   # 测完还原（不带 override 重建）
//
// 实现注记
//   · 逐条「推告警 → 立刻拉 run」串行配对：M2 ingest 出 outbox 的 alert.created 会被
//     autorun（EVENT_DRIVEN=on）在 ≤2s 内消费，hasActiveRun 查到 manual run（非 failed，
//     completed 也挡）即跳过——竞速窗口只有单条 HTTP RTT，对账（runsByAlert）兜底。
//   · 告警 host 逐条唯一：同主机 24h 活跃案会触发 merge 分支，唯一 host 让每条 run 都走
//     create_case + 调查富化全链（FakeTriageLlm 对 5712 brute force 确定性判 tp）。
//   · 抢锁让路的 run（triage_skip，verdict_locked）延迟分布剔除——那是防重闸的短路面，
//     不是流水线延迟。
import { createHttpClient, waitHealthy } from "./lib/http.mjs";
import { makeAlert } from "./lib/gen-alert.mjs";
import { machineSpecLine, machineSpec } from "./lib/report.mjs";
import {
  buildRunTimelines,
  reconstructSeries,
  peakQueued,
  summarizeTier,
  B3_TABLE_HEADER,
  b3TableRow,
  seriesLine,
} from "./lib/b3.mjs";

const INGEST = process.env.BENCH_INGEST_URL ?? "http://127.0.0.1:3001";
const M2 = process.env.BENCH_M2_URL ?? "http://127.0.0.1:3002";
const AGENT = process.env.BENCH_AGENT_URL ?? "http://127.0.0.1:3003";
const TIERS = [1, 5, 10, 20, 50];
const THEORY_RPS = 10; // 100ms tick 单领单（方案 §二#1）

const ingest = createHttpClient({ baseUrl: INGEST });
const m2 = createHttpClient({ baseUrl: M2 });
const agent = createHttpClient({ baseUrl: AGENT });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`[b3] ${msg}`);
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

// ---------- 布景动作（推告警 + 拉 run，正门配对） ----------

/** 推一条唯一告警（ingest webhook 正门，201 新建）→ 立刻 POST /internal/runs 拉起。
 *  返回 {alertId, runId, launchMs, pushMs}。非 201/202 一律硬失败（fail-closed，数字不带回）。 */
async function pushAndLaunch(host) {
  const body = makeAlert({ host });
  const t0 = Date.now();
  const pushed = await ingest("/api/v1/webhooks/alerts", { method: "POST", body });
  const pushMs = Date.now() - t0;
  if (pushed.status !== 201) {
    throw new Error(`ingest 非 201（=${pushed.status}，200=去重说明 sourceRef 撞了）host=${host}`);
  }
  const alertId = pushed.json?.alert_id;
  if (!alertId) throw new Error(`ingest 响应缺 alert_id host=${host}`);
  const t1 = Date.now();
  const launched = await agent("/internal/runs", {
    method: "POST",
    body: { kind: "alert_flow", alert_id: alertId },
  });
  const launchMs = Date.now() - t1;
  if (launched.status !== 202 || !launched.json?.run_id) {
    throw new Error(`/internal/runs 非 202（=${launched.status} ${JSON.stringify(launched.json)}）alert=${alertId}`);
  }
  return { alertId, runId: launched.json.run_id, pushMs, launchMs };
}

/** N 条串行配对（竞速窗口最小化，见文件头注记）。 */
async function pushAndLaunchBatch(n, tag) {
  const pairs = [];
  for (let i = 0; i < n; i++) pairs.push(await pushAndLaunch(`b3-${tag}-${i}`));
  return pairs;
}

// ---------- 观察口（M2 audit，全表拉回客户端过滤） ----------

async function fetchAudit() {
  const r = await m2("/api/v1/audit", { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`GET /api/v1/audit HTTP ${r.status}`);
  return r.json ?? [];
}

/** 轮询 audit 直到 myRunIds 全终态（或超时）。返回最后一份全量 dump。 */
async function waitForTerminal(runIds, { timeoutMs, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let dump = [];
  while (Date.now() < deadline) {
    dump = await fetchAudit();
    const { runs } = buildRunTimelines(dump);
    const mine = new Map(runs.filter((r) => runIds.includes(r.runId)).map((r) => [r.runId, r]));
    const pending = runIds.filter((id) => !mine.get(id)?.terminalAt);
    if (pending.length === 0) return dump;
    await sleep(pollMs);
  }
  return dump; // 超时：返回手头 dump，由调用方对账缺口
}

/** 对账一档：延迟/吞吐/队列曲线 + 防重对账（autorun 双拉、让路、失败清单）。 */
function tierReport(tier, tag, pairs, dump) {
  const runIds = pairs.map((p) => p.runId);
  const { runs, skippedRunIds, runsByAlert } = buildRunTimelines(dump);
  const mine = runs.filter((r) => runIds.includes(r.runId));
  const missing = runIds.filter((id) => !mine.some((r) => r.runId === id));

  // 防重对账：我的 alert 是否冒出了不是我拉的 run（autorun 竞速双拉）
  const dups = [];
  for (const p of pairs) {
    const all = runsByAlert.get(p.alertId) ?? [];
    for (const rid of all) if (!runIds.includes(rid)) dups.push({ alertId: p.alertId, extraRunId: rid });
  }

  const summary = summarizeTier(mine, skippedRunIds);
  const series = reconstructSeries(mine, { gridMs: 500 });
  const peak = peakQueued(series);

  console.log(`\n#### 档 ${tier}（tag=${tag}）`);
  console.log(B3_TABLE_HEADER);
  console.log(b3TableRow({ tier, summary, peak, theoryRps: THEORY_RPS }));
  console.log(`- 队列深度曲线（t(s):queued，500ms 网格）：${seriesLine(series)}`);
  console.log(
    `- 拉起全部 202（否则已硬失败）；launch RTT max=${Math.max(...pairs.map((p) => p.launchMs))}ms；` +
    `审计对账缺口=${missing.length}${missing.length ? `（runId=${missing.join(",")}）` : ""}`,
  );
  if (dups.length > 0) {
    console.log(
      `- ⚠ 防重对账：${dups.length} 条告警出现双 run（autorun 竞速）：${dups.map((d) => d.alertId).join(", ")}——受影响档建议重跑`,
    );
  }
  if (summary.failed.length > 0) {
    for (const f of summary.failed) console.log(`- ⚠ failed run ${f.runId} reason=${f.failReason}`);
  }
  return { tier, summary, peak, series, dups, missing };
}

// ---------- probe：小量试跑（先验证拉起成功率再上量） ----------

async function probe() {
  console.error("[b3] probe：2 条小量试跑，验证推→拉→跑通全链，再上量。");
  // host 带时间戳：probe host 撞了旧案例会触发 merge 分支（同主机活跃案），污染试跑判定
  const pairs = await pushAndLaunchBatch(2, `probe-${Date.now().toString(36)}`);
  const dump = await waitForTerminal(pairs.map((p) => p.runId), { timeoutMs: 180_000 });
  const { runs } = buildRunTimelines(dump);
  const mine = runs.filter((r) => pairs.some((p) => p.runId === r.runId));
  const done = mine.filter((r) => r.status === "completed").length;
  const failedRuns = mine.filter((r) => r.status === "failed");
  console.log(`### B3 probe（2 条试跑）`);
  console.log(`- 拉起 202=2/2，终态 completed=${done}/2，failed=${failedRuns.length}`);
  for (const f of failedRuns) console.log(`- ⚠ probe run ${f.runId} failed reason=${f.failReason}`);
  if (done < 2) fail("probe 未全绿——先修布景再上量（查 agent 容器日志 warn=audit_ingest_failed / run_job_failed）。");
  console.log("- probe 全绿，可以上量。");
}

// ---------- 五档爬坡 ----------

async function tiers(requested) {
  const spec = machineSpec();
  const rows = [];
  for (const tier of requested) {
    const tag = `t${tier}-${Date.now().toString(36)}`;
    console.error(`[b3] 档 ${tier}：推+拉 ${tier} 条 alert_flow……`);
    const pairs = await pushAndLaunchBatch(tier, tag);
    const dump = await waitForTerminal(pairs.map((p) => p.runId), {
      timeoutMs: 120_000 + tier * 10_000,
    });
    rows.push(tierReport(tier, tag, pairs, dump));
  }

  console.log(`\n### B3 分发循环水位爬坡（理论 ~10 run/s = 100ms tick 单领单）`);
  console.log(`> 时间：${spec.timestamp}（本地，只同机比）`);
  console.log(machineSpecLine(spec));
  console.log(`> 复现：\`node scripts/bench/b3-dispatcher.mjs ${requested.join(" ")}\`（默认布景 EVENT_DRIVEN=on + fake LLM，观察全走 REST）`);
  console.log(`> 口径：run_jobs 无公开读口，队列深度=runs 状态分布近似（start pending↔queued 一一对应）；`);
  console.log(`> 延迟=审计钟 queued→completed，让路（triage_skip 抢锁失败）的 run 已剔除。`);
  return rows;
}

// ---------- ttl 加测（深队列中 awaiting_approval 的过期裁决延迟） ----------

/** 布景一条「已关闭且有 verdict」的案件（knowledge_flow 的 ASP 门控要求 verdict）：
 *  推新告警 → 立刻 M2 create-case（抢在 autorun 的 run 之前把状态机推走）→ 关案（带
 *  verdict，发 case.closed）→ 马上手工拉 knowledge_flow（autorun 的 hasActiveRun 随即
 *  挡掉 case.closed 的自动拉起）。返回 caseId 与 knowledgeFlow runId。 */
async function closedCaseWithRun(tag) {
  const pushed = await ingest("/api/v1/webhooks/alerts", { method: "POST", body: makeAlert({ host: `b3-${tag}` }) });
  if (pushed.status !== 201) throw new Error(`ttl 布景 ingest 非 201（=${pushed.status}）`);
  const alertId = pushed.json.alert_id;
  const created = await m2(`/api/v1/alerts/${encodeURIComponent(alertId)}/create-case`, {
    method: "POST",
    body: { title: `b3 ttl scenery ${tag}` },
  });
  if (created.status !== 201) throw new Error(`ttl 布景 create-case 非 201（=${created.status} ${JSON.stringify(created.json)}）`);
  const caseId = created.json.case?.id;
  // 状态机 New→InProgress→Closed（CONTEXT 语义核心）：关案前置一步 InProgress
  const opened = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}`, {
    method: "PATCH",
    body: { status: "InProgress" },
  });
  if (!opened.ok) throw new Error(`ttl 布景 patch 非 2xx（=${opened.status} ${JSON.stringify(opened.json)}）`);
  const closed = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}/close`, {
    method: "POST",
    body: { verdict: "true_positive", verdictNote: "b3 ttl scenery" },
  });
  if (!closed.ok) throw new Error(`ttl 布景 close 非 2xx（=${closed.status} ${JSON.stringify(closed.json)}）`);
  const launched = await agent("/internal/runs", {
    method: "POST",
    body: { kind: "knowledge_flow", case_id: caseId },
  });
  if (launched.status !== 202) throw new Error(`ttl knowledge_flow 非 202（=${launched.status}）`);
  return { alertId, caseId, runId: launched.json.run_id };
}

async function ttl() {
  const ttlSeconds = Number(process.env.B3_TTL_SECONDS ?? 5);
  if (!(Number.isFinite(ttlSeconds) && ttlSeconds > 0)) fail(`B3_TTL_SECONDS 非法：${process.env.B3_TTL_SECONDS}`);
  console.error(`[b3] ttl 加测：假设 agent 已以 APPROVAL_TTL_SECONDS=${ttlSeconds} 重启（脚本无读口可验，靠布景纪律）。`);

  // 深队列布景：前 4 条垫队 → knowledge_flow（第 5 位执行，开审批卡）→ 后 30 条压队
  //（按五档实测周期 ~210ms/run，30 条 ≈ 6.3s 队列工作 > TTL 5s——过期裁决发生时队里
  // 仍有 pending，验证扫描不被饿死；量小了队列先排干，「深队列」前提就不成立）
  console.error("[b3] ttl：垫队 4 条 alert_flow……");
  const before = await pushAndLaunchBatch(4, `ttlB-${Date.now().toString(36)}`);
  console.error("[b3] ttl：布景关案 + 拉 knowledge_flow……");
  const scene = await closedCaseWithRun(`ttlCase-${Date.now().toString(36)}`);
  console.error("[b3] ttl：压队 30 条 alert_flow……");
  const after = await pushAndLaunchBatch(30, `ttlA-${Date.now().toString(36)}`);

  // 盯审批卡：第一张 kb_write pending 卡出现 → 记 created_at（agent 钟）→ 等它离场
  const cardDeadline = Date.now() + 300_000;
  let card = null;
  while (Date.now() < cardDeadline) {
    const r = await agent("/api/v1/approvals?status=pending", { timeoutMs: 10_000 });
    if (r.ok) {
      const hit = (r.json?.approvals ?? []).find((c) => c.tool === "kb_write");
      if (hit) { card = hit; break; }
    }
    await sleep(250);
  }
  if (!card) fail("ttl：300s 内没等到 kb_write 审批卡——knowledge_flow 没走到人审闸，检查布景（案件 verdict）。");
  const kbCards = [];
  const listAll = await agent("/api/v1/approvals", { timeoutMs: 10_000 });
  // 只数本 run 的卡（审批卡清单是全量的，历史轮次的卡混在里面会误报双拉）
  for (const c of listAll.json?.approvals ?? []) {
    if (c.tool === "kb_write" && c.run_id === scene.runId) kbCards.push(c);
  }
  console.log(`### B3 加测：审批 TTL 过期裁决（深队列）`);
  console.log(`- 假设 TTL=${ttlSeconds}s（APPROVAL_TTL_SECONDS env，agent 启动时读一次）；布景 run=${scene.runId} case=${scene.caseId}`);
  console.log(`- kb_write 卡=${card.id}，卡 created_at=${card.created_at}（agent 钟）；kb_write 卡总数=${kbCards.length}（>1 = autorun 对 case.closed 竞速双拉）`);
  if (kbCards.length > 1) console.log("- ⚠ 出现多张 kb_write 卡——竞速双拉成立，本轮数字仅供参考，建议重跑。");

  // 等卡离场（expired 预期）+ 队列排干，然后拉全量审计对时刻
  const dump = await waitForTerminal(
    [...before, scene, ...after].map((p) => p.runId).filter(Boolean),
    { timeoutMs: 600_000 },
  );
  const { runs } = buildRunTimelines(dump);
  const sceneRun = runs.find((r) => r.runId === scene.runId);
  const expireEntries = dump.filter(
    (e) => e.action === "expire" && e.objectType === "approval" && e.objectId === card.id,
  );
  const expireAt = expireEntries.at(-1)?.createdAt ?? null;
  const expected = card.created_at + ttlSeconds * 1000;
  const delayMs = expireAt !== null ? expireAt - expected : NaN;

  // 过期裁决时刻的队列水位（近似口径同五档）
  let queuedAtExpire = null;
  if (expireAt !== null) {
    const flowRuns = runs.filter((r) => [...before, ...after].some((p) => p.runId === r.runId));
    const series = reconstructSeries(flowRuns, { gridMs: 250 });
    let best = series[0];
    for (const s of series) if (s.t <= expireAt) best = s;
    queuedAtExpire = best?.queued ?? null;
  }

  console.log(`- 期望过期时刻 = created_at + TTL = ${expected}；审计 expire 时刻 = ${expireAt ?? "（审计缺 expire 行！）"}`);
  console.log(`- 裁决延迟 = 实际 - 期望 = ${Number.isFinite(delayMs) ? delayMs.toFixed(0) + "ms" : "n/a"}（正值=晚于 TTL，含 tick 对齐 + 审计写入抖动）`);
  console.log(`- 过期时刻 alert_flow 队列深度（近似）= ${queuedAtExpire ?? "n/a"} —— >0 即「扫描没被深队列饿死」的直接证据`);
  console.log(`- run 终态：${sceneRun ? `${sceneRun.status}${sceneRun.failReason ? `(${sceneRun.failReason})` : ""}` : "审计缺口"}`);
  if (sceneRun && sceneRun.failReason !== "approval_expired") {
    console.log(`- ⚠ run 失败原因不是 approval_expired——卡可能被人审走了或竞速，数字作废。`);
  }
}

// ---------- 入口 ----------

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const arg = args[0] ?? "";
await preflight();
if (arg === "probe") {
  await probe();
} else if (arg === "ttl") {
  await ttl();
} else {
  const requested = (arg === "" ? TIERS : args).map(Number);
  for (const t of requested) {
    if (!TIERS.includes(t)) fail(`未知档位：${t}（可选：${TIERS.join("/")}，或 probe / ttl）`);
  }
  await probe();
  await tiers(requested);
}
