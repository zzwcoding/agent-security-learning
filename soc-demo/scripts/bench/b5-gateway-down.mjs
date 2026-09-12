#!/usr/bin/env node
// m13 · B5 实验② gateway 压下（票 69；设计源 2026-09-12-压力测试方案.md §三 B5）。
//
// 用法
//   node b5-gateway-down.mjs             # 对照腿 + 压下腿（approve/拉起双断言）+ 恢复腿（约 2 分钟）
//
// 应看到什么（保安处歇业：批准链与拉起链都不许留「悬置态」）
//   knowledge_flow 停在 kb_write 人审闸后 `docker compose stop gateway`（保安处关门），
//   预期（语义全部按 services 真码实测，app.ts 只读核对）：
//   ①approve 腿：内部模式「先铸票后裁决」——gateway 不可达 → mintApprovalToken 抛错 →
//     **502 {error:"mint_failed"}**，decideApproval 未执行：卡仍 pending（approver 空、
//     未执行）、run 仍 awaiting_approval、无 approve/execute 审计行——**不留「已批准
//     无票」悬置态**（卡可重试，等保安处回来再批）；
//   ②拉起腿：gateway 死着的时候推一条新告警，autorun 照常拉起 → executeStartJob 铸任务
//     票失败 → run 走**明确 failed 分支**（queued→running→failed，failReason=mint_failed）
//     + FAILURE kill 审计 + error 事件——**不留无票 run 悬置**；
//   ③恢复腿：`docker compose start gateway` 复绿 → 同一张卡再批 → 200 + resume →
//     run completed、卡 approved+executed；新告警链路如常 completed。
//   断言失败 = 脚本非零退出（判定器 assertApproveFailClosed / assertMintFailedRun，
//   离线单测锁定）。
//
// 选型：`docker compose stop gateway`（票面原话；SIGTERM 优雅退出，无 restart 策略不
// 自动复活）。布景动作（建案/停靠）都要在 gateway 在位时做完——拉起要铸票。
//
// 观察口（零新增，全 REST）：agent GET /api/v1/approvals（卡 wire）、M2 GET /api/v1/audit
// （run 状态迁移 + 卡的 create/approve 审计行）、M2 GET /api/v1/events（alert→run 配对）。
//
// 前置（脚本只预检不代建）：默认九服务 + fake LLM（EVENT_DRIVEN 默认 on）+
// bash scripts/setup-openfga.sh；ingest/M2/agent/guards/gateway 五口 /healthz 全绿才开跑。
// 独立轮次纪律：docker compose down → rm -rf data → up 起跑；实验内只做容器级 stop/start。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHttpClient, waitHealthy } from "./lib/http.mjs";
import { makeAlert, nextId } from "./lib/gen-alert.mjs";
import { machineSpec, machineSpecLine } from "./lib/report.mjs";
import { buildRunTimelines } from "./lib/b3.mjs";
import {
  assertApproveFailClosed,
  assertMintFailedRun,
  composeStopArgs,
  composeStartArgs,
} from "./lib/b5.mjs";

const execDocker = promisify(execFile);
const INGEST = process.env.BENCH_INGEST_URL ?? "http://127.0.0.1:3001";
const M2 = process.env.BENCH_M2_URL ?? "http://127.0.0.1:3002";
const AGENT = process.env.BENCH_AGENT_URL ?? "http://127.0.0.1:3003";
const GATEWAY = process.env.BENCH_GATEWAY_URL ?? "http://127.0.0.1:8002";
const CARD_DEADLINE_MS = 120_000; // 等 kb_write 审批卡开出（同 b4 口径放宽容忍）

const ingest = createHttpClient({ baseUrl: INGEST });
const m2 = createHttpClient({ baseUrl: M2 });
const agent = createHttpClient({ baseUrl: AGENT });
const gateway = createHttpClient({ baseUrl: GATEWAY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  console.error(`[b5-gateway] ${msg}`);
  process.exit(1);
};

async function preflight() {
  for (const [name, client, url] of [
    ["ingest", ingest, INGEST],
    ["case-backend", m2, M2],
    ["agent", agent, AGENT],
    ["gateway", gateway, GATEWAY],
    ["guards", createHttpClient({ baseUrl: "http://127.0.0.1:8001" }), "http://127.0.0.1:8001"],
  ]) {
    const ok = await waitHealthy(client, { tries: 3, intervalMs: 500 });
    if (!ok) fail(`${name} (${url}/healthz) 不绿——布景没起好，停下不做实验。`);
  }
}

async function gatewayUp() {
  try {
    const r = await gateway("/healthz", { timeoutMs: 2000 });
    return r.ok;
  } catch {
    return false;
  }
}

async function fetchAudit() {
  const r = await m2("/api/v1/audit", { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`GET /api/v1/audit HTTP ${r.status}`);
  return r.json ?? [];
}

/** 停靠 run 布景（b4 parkedKnowledgeRun 同款）：推告警 → create-case → InProgress →
 *  close（带 verdict）→ 拉 knowledge_flow → 等 kb_write 审批卡开出。返回 {alertId, runId, card}。 */
async function parkedKnowledgeRun(tag) {
  const pushed = await ingest("/api/v1/webhooks/alerts", { method: "POST", body: makeAlert({ host: `b5-gw-${tag}` }) });
  if (pushed.status !== 201) throw new Error(`停靠布景 ingest 非 201（=${pushed.status}）`);
  const alertId = pushed.json.alert_id;
  const created = await m2(`/api/v1/alerts/${encodeURIComponent(alertId)}/create-case`, {
    method: "POST", body: { title: `b5-gw park ${tag}` },
  });
  if (created.status !== 201 || !created.json?.case?.id) throw new Error(`停靠布景 create-case 非 201（=${created.status}）`);
  const caseId = created.json.case.id;
  const opened = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}`, { method: "PATCH", body: { status: "InProgress" } });
  if (!opened.ok) throw new Error(`停靠布景 patch 非 2xx（=${opened.status}）`);
  const closed = await m2(`/api/v1/cases/${encodeURIComponent(caseId)}/close`, {
    method: "POST", body: { verdict: "true_positive", verdictNote: "b5 scenery" },
  });
  if (!closed.ok) throw new Error(`停靠布景 close 非 2xx（=${closed.status}）`);
  const launched = await agent("/internal/runs", { method: "POST", body: { kind: "knowledge_flow", case_id: caseId } });
  if (launched.status !== 202 || !launched.json?.run_id) throw new Error(`knowledge_flow 非 202（=${launched.status}）`);
  const runId = launched.json.run_id;
  const deadline = Date.now() + CARD_DEADLINE_MS;
  while (Date.now() < deadline) {
    const r = await agent("/api/v1/approvals?status=pending", { timeoutMs: 10_000 });
    const card = (r.json?.approvals ?? []).find((c) => c.tool === "kb_write" && c.run_id === runId);
    if (card) return { alertId, runId, caseId, card };
    await sleep(250);
  }
  throw new Error(`${CARD_DEADLINE_MS}ms 内没等到 kb_write 审批卡——knowledge_flow 没停靠，检查布景`);
}

/** run 时间线（按 alertId 圈定）：等该 alert 的首个 run 到终态，返回 timeline。 */
async function waitRunByAlert(alertId, { deadlineMs = 120_000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const entries = await fetchAudit();
    const { runs } = buildRunTimelines(entries);
    const mine = runs.filter((r) => r.alertId === alertId).sort((a, b) => a.createdAt - b.createdAt);
    const first = mine[0];
    if (first && first.terminalAt !== null) return first;
    if (Date.now() > deadline) return first ?? null;
    await sleep(1000);
  }
}

/** 等 run 到 completed（审计钟）。 */
async function waitRunCompleted(runId, { deadlineMs = 120_000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const entries = await fetchAudit();
    const { runs } = buildRunTimelines(entries);
    const t = runs.find((r) => r.runId === runId);
    if (t && t.terminalAt !== null) return t;
    if (Date.now() > deadline) return t ?? null;
    await sleep(1000);
  }
}

const runStatusOf = async (runId) => {
  const entries = await fetchAudit();
  const { runs } = buildRunTimelines(entries);
  return runs.find((r) => r.runId === runId)?.status ?? null;
};

const cardAuditRows = async (cardId) => {
  const r = await m2(`/api/v1/audit?objectId=${encodeURIComponent(cardId)}`, { timeoutMs: 15_000 });
  if (!r.ok) throw new Error(`GET /api/v1/audit?objectId HTTP ${r.status}`);
  return r.json ?? [];
};
const getCard = async (cardId) => {
  const r = await agent(`/api/v1/approvals`, { timeoutMs: 10_000 });
  return (r.json?.approvals ?? []).find((c) => c.id === cardId) ?? null;
};

// ---------- 入口 ----------

await preflight();
const t0 = machineSpec().timestamp;
const phases = [];

console.error("[b5-gateway] 实验②：停靠 knowledge_flow → compose stop gateway → approve 断言 + 拉起断言 → 复绿重批。");

// —— 相位 A：对照腿（gateway 在位，批准链如常）——
console.error("[b5-gateway] 相位 A：对照腿（gateway 在位）……");
const parkA = await parkedKnowledgeRun(`a-${Date.now().toString(36)}`);
const approveA = await agent(`/api/v1/approvals/${encodeURIComponent(parkA.card.id)}/approve`, {
  method: "POST", body: { approver: "b5-bench" }, timeoutMs: 15_000,
});
if (approveA.status !== 200) fail(`对照腿 approve 非 200（=${approveA.status}）——布景不对（内部模式才走本地铸票）。`);
const doneA = await waitRunCompleted(parkA.runId);
if (doneA?.status !== "completed") fail(`对照腿 run 未 completed（=${doneA?.status ?? "n/a"}）——布景不对。`);
phases.push({ phase: "A 对照", gw: "在位", act: "approve", obs: `200，run ${((doneA.terminalAt - doneA.createdAt) / 1000).toFixed(1)}s 到 completed`, assert: "布景自证" });

// —— 相位 B：压下腿（停靠后 stop gateway → approve）——
console.error("[b5-gateway] 相位 B：停靠第二张卡 → docker compose stop gateway → approve ……");
const parkB = await parkedKnowledgeRun(`b-${Date.now().toString(36)}`);
await execDocker("docker", composeStopArgs("gateway"), { timeout: 30_000 });
const downAt = Date.now();
for (let i = 0; i < 20 && (await gatewayUp()); i++) await sleep(250);
if (await gatewayUp()) fail("docker compose stop gateway 后 /healthz 仍绿——压下没生效，实验作废。");
console.error(`[b5-gateway] gateway 已停（+${((Date.now() - downAt) / 1000).toFixed(1)}s）。approve 打向死掉的保安处……`);
const approveB = await agent(`/api/v1/approvals/${encodeURIComponent(parkB.card.id)}/approve`, {
  method: "POST", body: { approver: "b5-bench" }, timeoutMs: 30_000,
}).catch((e) => ({ status: null, json: null, err: e }));
await sleep(1500); // 给审计行投递留窗（HttpAuditSink fire-and-forget）
const cardB = await getCard(parkB.card.id);
const statusB = await runStatusOf(parkB.runId);
const rowsB = await cardAuditRows(parkB.card.id);
const verdictB = assertApproveFailClosed({
  approveStatus: approveB.status,
  approveBody: approveB.json,
  cardWire: cardB,
  runStatus: statusB,
  approvalAudit: rowsB,
});
phases.push({
  phase: "B 压下·approve", gw: "已停", act: "approve",
  obs: `HTTP ${approveB.status ?? "网络错"} ${JSON.stringify(approveB.json ?? approveB.err?.message ?? {})}, 卡=${cardB?.status}, run=${statusB}`,
  assert: verdictB.ok ? "通过：不留已批准无票" : `违规：${verdictB.violations.join("；")}`,
});
if (!verdictB.ok) process.exitCode = 1;

// —— 相位 C：压下腿·拉起（gateway 死着时推新告警，autorun 拉起 → 铸票失败 → 明确 failed）——
console.error("[b5-gateway] 相位 C：gateway 压下期间推新告警（autorun 拉起 → 铸票失败）……");
const pushedC = await ingest("/api/v1/webhooks/alerts", { method: "POST", body: makeAlert({ host: `b5-gw-c-${nextId()}` }) });
if (pushedC.status !== 201) fail(`拉起腿 ingest 非 201（=${pushedC.status}）`);
const alertC = pushedC.json.alert_id;
const timelineC = await waitRunByAlert(alertC);
const entriesC = await fetchAudit();
const auditRowsC = entriesC.filter((e) => e.objectType === "run" && e.objectId === timelineC?.runId);
const verdictC = timelineC
  ? assertMintFailedRun(timelineC, auditRowsC)
  : { ok: false, violations: ["压下窗拉起的告警 120s 内没有 run——autorun 没拉起或观察口失真"] };
phases.push({
  phase: "C 压下·拉起", gw: "已停", act: "autorun 拉起 alert_flow",
  // 注：kill FAILURE 审计行也带 status.to=failed 且无 failReason，会把 buildRunTimelines
  // 的 failReason 覆写成 null——权威 reason 在 failed 迁移行上，从 transitions 取。
  obs: timelineC ? `run ${timelineC.runId} → ${timelineC.status}（failReason=${(timelineC.transitions ?? []).filter((t) => t.to === "failed").map((t) => t.reason).join("/")}）` : "无 run",
  assert: verdictC.ok ? "通过：明确 failed 不留无票 run" : `违规：${verdictC.violations.join("；")}`,
});
if (!verdictC.ok) process.exitCode = 1;

// —— 相位 D：恢复腿（start gateway → 同卡重批【可重试】→ run completed；新告警如常）——
// 恢复后第一笔 mint 可能撞上压下期留下的死 keep-alive 连接（uvicorn 已换进程）→
// 再吃一个 502——这正是「卡仍 pending 可重试」设计的用武之地：重试即成，零丢失。
console.error("[b5-gateway] 相位 D：docker compose start gateway → 同一张卡重批（502 可重试）……");
await execDocker("docker", composeStartArgs("gateway"), { timeout: 30_000 });
const recStart = Date.now();
let gwHealthyAt = null;
for (let i = 0; i < 60; i++) {
  if (await gatewayUp()) {
    gwHealthyAt = Date.now();
    break;
  }
  await sleep(500);
}
if (gwHealthyAt === null) fail("docker compose start gateway 后 30s /healthz 未复绿——恢复失败，需人工检查。");
let approveD = null;
let mintRetries = 0;
for (;;) {
  approveD = await agent(`/api/v1/approvals/${encodeURIComponent(parkB.card.id)}/approve`, {
    method: "POST", body: { approver: "b5-bench" }, timeoutMs: 15_000,
  }).catch((e) => ({ status: null, json: null, err: e }));
  if (approveD.status === 200) break;
  // 502 之下必须验证「卡仍 pending 可重试」——这正是断言的一部分
  const midCard = await getCard(parkB.card.id);
  if (midCard?.status !== "pending") fail(`重试期间卡被动了（status=${midCard?.status}）——「502 不落裁决」语义被破坏`);
  mintRetries += 1;
  if (mintRetries > 6) fail(`重试 ${mintRetries} 次仍非 200（last=${approveD.status} ${JSON.stringify(approveD.json ?? "")}）`);
  await sleep(1000);
}
const doneD = await waitRunCompleted(parkB.runId);
const cardD = await getCard(parkB.card.id);
const recoverOk = doneD?.status === "completed" && cardD?.status === "approved" && cardD?.executed === true;
if (!recoverOk) {
  process.exitCode = 1;
  phases.push({ phase: "D 恢复·重批", gw: "复绿", act: `同卡重批（重试 ${mintRetries} 次后 200）`, obs: `卡=${cardD?.status}/executed=${cardD?.executed}，run=${doneD?.status ?? "n/a"}`, assert: "违规：重批后未走完批准链" });
} else {
  phases.push({ phase: "D 恢复·重批", gw: "复绿", act: `同卡重批（先吃 ${mintRetries} 个可重试 502）`, obs: `200，卡 approved+executed，run completed（+${((doneD.terminalAt - gwHealthyAt) / 1000).toFixed(1)}s）`, assert: "通过：502 可重试语义兑现，批准链如常" });
}
const pushedD = await ingest("/api/v1/webhooks/alerts", { method: "POST", body: makeAlert({ host: `b5-gw-d-${nextId()}` }) });
const timelineD = await waitRunByAlert(pushedD.json.alert_id);
const dOk = timelineD?.status === "completed";
if (!dOk) process.exitCode = 1;
phases.push({
  phase: "D 恢复·新告警", gw: "复绿", act: "autorun 拉起 alert_flow",
  obs: timelineD ? `run → ${timelineD.status}` : "无 run",
  assert: dOk ? "通过：链路如常" : "违规：恢复后新告警未 completed",
});

// ---------- 汇总 ----------
console.log(`\n### B5 实验② · gateway 压下（approve→mint 失败路径不留悬置态）`);
console.log(`> 时间：${t0}（本地，只同机比）`);
console.log(machineSpecLine());
console.log(`> 复现：\`docker compose down && rm -rf data && JIAOTU_GATEWAY_URL= JIAOTU_API_KEY= docker compose up -d && bash scripts/setup-openfga.sh\` 然后 \`node scripts/bench/b5-gateway-down.mjs\``);
console.log(`> 口径：内部模式（JIAOTU_GATEWAY_URL 空）approve = 先铸票后裁决（app.ts）；语义按源码实测——502 mint_failed 时 decideApproval 未执行，卡 pending/run awaiting_approval 即安全终态（可重试）。`);
console.log("");
console.log("| 相位 | gateway | 动作 | 观测 | 断言 |");
console.log("|---|---|---|---|---|");
for (const p of phases) console.log(`| ${p.phase} | ${p.gw} | ${p.act} | ${p.obs} | ${p.assert} |`);
console.log("");
