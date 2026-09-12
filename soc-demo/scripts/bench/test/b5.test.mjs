// m13 harness 单测 · b5.mjs：B5 防线压下实验的纯函数面。喂合成审计行（M2 GET /api/v1/audit
// 的 wire 形，lib/b3.mjs buildRunTimelines 的 run 时间线形）与合成 autocannon result，
// 不依赖真栈——三个实验的 fail-closed 断言判定器与并发锤的聚合口径全部在离线侧锁定。
// 断言语义出处（services 真码，2026-09-12 只读核对）：
//   · guards 不可达 → triage scanField（alert_field/kb 通道，缺省 failMode=block）折成
//     {blocked:true, action:"fail_closed", reason:"guards_unreachable"}（guards-client.ts
//     unreachable 分支）→ 审计 guards_block / result=DENIED（triage/flow.ts scanField），
//     原文换占位符，run 继续跑完（fake LLM 按标题定 verdict）；
//   · gateway 不可达 → approve 先铸票后裁决：铸票抛错 502 mint_failed（app.ts catch 分支），
//     卡仍 pending、run 仍 awaiting_approval（decideApproval 未执行、无 approve 审计行）；
//     start 任务铸票失败 → run failed(reason=mint_failed)（executeStartJob 强杀口径）；
//   · SQLite 锤：错误面分类沿用 b2 classifyErrors 口径（422 验型闸与过载面分开说）。
import test from "node:test";
import assert from "node:assert/strict";
import { latencyStats } from "../lib/b2.mjs";
import {
  HAMMER_TIERS,
  parseLadder,
  classifyHammer,
  B5_HAMMER_TABLE_HEADER,
  hammerRow,
  collectGuardFrames,
  assertGuardsKill,
  assertApproveFailClosed,
  assertMintFailedRun,
  KNOWN_GUARD_DOWN_REASONS,
  dockerKillArgs,
  dockerStartArgs,
  composeStopArgs,
  composeStartArgs,
  B5_GUARDS_TABLE_HEADER,
  guardsLegRow,
} from "../lib/b5.mjs";

// ---------- 合成件工厂（wire 形与真读口一致） ----------

// M2 GET /api/v1/audit 的审计行（camelCase wire，buildRunTimelines 消费同源）
const audit = (over = {}) => ({
  action: "update",
  actor: { type: "agent", id: "agent:triage" },
  objectId: "run_x",
  objectType: "run",
  details: {},
  requestId: "req",
  result: "SUCCESS",
  createdAt: 1000,
  ...over,
});
// guards_block 帧（triage/flow.ts scanField 的落账形：DENIED + reason）
const guardBlock = (runId, at, over = {}) =>
  audit({
    action: "guards_block",
    objectId: runId,
    objectType: "untrusted_field",
    details: { field: "description", channel: "alert_field", action: "fail_closed", reason: "guards_unreachable", score: null },
    result: "DENIED",
    createdAt: at,
    ...over,
  });
// run 时间线（buildRunTimelines 输出的形）
const run = (runId, createdAt, status = "completed", terminalAt = createdAt + 500, failReason = null) => ({
  runId, alertId: "a1", createdAt, status, terminalAt, failReason,
  transitions: [{ at: createdAt, to: "queued", reason: null }],
});

// ---------- 并发锤：档位解析与错误面分类 ----------

test("parseLadder：缺省全档 1/4/16/64；点名子集保序；非法档位/非数字一律抛", () => {
  assert.deepEqual(parseLadder([]), { tiers: HAMMER_TIERS });
  assert.deepEqual(parseLadder(["4", "1"]), { tiers: [4, 1] });
  assert.throws(() => parseLadder(["3"]), /未知档位/);
  assert.throws(() => parseLadder(["abc"]), /未知档位/);
  assert.deepEqual(HAMMER_TIERS, [1, 4, 16, 64]);
});

test("classifyHammer：201/200 分开计、422 与过载面（5xx/超时/网络）分开计", () => {
  const r = classifyHammer({
    errors: 2,
    timeouts: 1,
    statusCodeStats: { 201: { count: 90 }, 200: { count: 6 }, 422: { count: 5 }, 500: { count: 3 }, 503: { count: 2 } },
  });
  assert.deepEqual(
    [r.ok2xx, r.created201, r.dedup200, r.bad422, r.server5xx, r.timeouts, r.network],
    [96, 90, 6, 5, 5, 1, 2],
  );
  assert.equal(r.bad, 13); // 422+5xx+超时+网络 = 5+5+1+2
});

test("classifyHammer：空 statusCodeStats 退化为 errors+timeouts；空结果全零", () => {
  assert.deepEqual(classifyHammer({ errors: 3, timeouts: 2 }).bad, 5);
  assert.equal(classifyHammer({}).bad, 0);
});

test("hammerRow：列数与 B5_HAMMER_TABLE_HEADER 对齐；NaN 渲染 n/a", () => {
  const headerCols = B5_HAMMER_TABLE_HEADER.split("\n")[0].split("|").map((s) => s.trim()).filter(Boolean);
  const row = hammerRow({
    tier: 16, sent: 1000, err: classifyHammer({ statusCodeStats: { 201: { count: 1000 } } }),
    lat: { p50: 5, p95: 20, p99: 40, max: 60 }, throughput: 99.4, healthzP50: NaN,
  });
  const cols = row.split("|").map((s) => s.trim()).filter((s) => s !== "");
  assert.equal(cols.length, headerCols.length);
  assert.match(row, /16 /);
  assert.match(row, /1000\/1000/);
  assert.match(row, /n\/a/); // healthz 延迟没采样就不硬造
});

// ---------- 实验①：guards 压下的 fail-closed 断言判定器 ----------

test("collectGuardFrames：只收 guards_block 帧，runId/reason/result 归一化", () => {
  const frames = collectGuardFrames([
    guardBlock("run_1", 2000),
    audit({ action: "guards_block", objectId: "run_1", objectType: "kb_hit", result: "DENIED", createdAt: 2100, details: { reason: "guards_timeout" } }),
    audit({ action: "tool_output_flagged", objectId: "run_1", result: "SUCCESS", createdAt: 2200 }), // 非 guards_block 不收
    audit({ action: "update", objectId: "run_1", objectType: "run", createdAt: 2300 }),
  ]);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((f) => f.reason), ["guards_unreachable", "guards_timeout"]);
  assert.ok(frames.every((f) => f.result === "DENIED" && f.runId === "run_1"));
});

test("KNOWN_GUARD_DOWN_REASONS：fail-closed 的两个合法 reason（guards-client unreachable/timeout）", () => {
  assert.deepEqual([...KNOWN_GUARD_DOWN_REASONS].sort(), ["guards_timeout", "guards_unreachable"]);
});

test("assertGuardsKill：kill 后创建且窗内执行完的 run 都有 DENIED 帧、恢复后零帧、reason 全合法 → ok", () => {
  const v = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000), run("run_d2", 6000, "completed", 9000)],
    recoveryRuns: [run("run_r1", 20000)],
    guardFrames: [
      guardBlock("run_d1", 5100), guardBlock("run_d1", 5110), guardBlock("run_d2", 6100),
    ],
    killAt: 4000,
    healthyAt: 20000,
    minDeniesPerRun: 1,
  });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.stats.downRuns, 2);
  assert.equal(v.stats.inWindowExecuted, 2);
  assert.equal(v.stats.deniedFrames, 3);
  assert.deepEqual(v.stats.recoveryRunIds, ["run_r1"]);
});

test("assertGuardsKill：kill 前创建的 run（扫描可能赶在 kill 前跑完）零 DENIED 不算违规——归因看创建时刻在 kill 后", () => {
  const v = assertGuardsKill({
    downRuns: [
      run("run_pre", 3000, "completed", 8000),  // kill 前创建、窗内跑完——扫描时刻不可辨，不装违规定罪
      run("run_d1", 5000, "completed", 9000),
    ],
    recoveryRuns: [],
    guardFrames: [guardBlock("run_d1", 5100)],
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.deepEqual(v.stats.preKillCreated, ["run_pre"]);
  assert.equal(v.stats.inWindowExecuted, 1);
});

test("assertGuardsKill：窗内创建、复绿后才执行完的 run（跨恢复）零 DENIED 不算违规——fail-closed 看执行时刻不是到达时刻", () => {
  const v = assertGuardsKill({
    downRuns: [
      run("run_in", 5000, "completed", 8000),
      run("run_cross", 7000, "completed", 25000), // 压下窗创建，复绿（20000）后执行完
    ],
    recoveryRuns: [],
    guardFrames: [guardBlock("run_in", 5100)],
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.deepEqual(v.stats.crossRecovered, ["run_cross"]);
});

test("assertGuardsKill：kill 后创建且窗内执行完但零 DENIED 帧 = 绕过扫描 → 违规点名", () => {
  const v = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000), run("run_d2", 6000, "completed", 9000)],
    recoveryRuns: [],
    guardFrames: [guardBlock("run_d1", 5100)], // run_d2 kill 后创建、窗内跑完却一帧都没有
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((s) => s.includes("run_d2")), JSON.stringify(v.violations));
});

test("assertGuardsKill：非 DENIED 的 guards_block（理论上不该存在）与非法 reason 都算违规", () => {
  const badResult = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000)],
    recoveryRuns: [],
    guardFrames: [guardBlock("run_d1", 5100, { result: "SUCCESS" })],
    killAt: 4000,
    healthyAt: 9000,
  });
  assert.equal(badResult.ok, false);
  assert.ok(badResult.violations.some((s) => /DENIED/.test(s)));

  const badReason = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000)],
    recoveryRuns: [],
    guardFrames: [guardBlock("run_d1", 5100, { details: { reason: "guards_something_else" } })],
    killAt: 4000,
    healthyAt: 9000,
  });
  assert.equal(badReason.ok, false);
  assert.ok(badReason.violations.some((s) => /guards_something_else/.test(s)));
});

test("assertGuardsKill：恢复窗合法 reason 的偶发 DENIED = fail-closed 对「慢」的保守裁决（注记不违规）；非法 reason/未终态才是违规", () => {
  const tolerated = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000)],
    recoveryRuns: [run("run_r1", 20000)],
    guardFrames: [guardBlock("run_d1", 5100), guardBlock("run_r1", 20100)],
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(tolerated.ok, true, JSON.stringify(tolerated.violations));
  assert.equal(tolerated.stats.recoveryDeniedFrames, 1); // 脚本作健康注记

  const illegal = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000)],
    recoveryRuns: [run("run_r1", 20000)],
    guardFrames: [guardBlock("run_d1", 5100), guardBlock("run_r1", 20100, { details: { reason: "guards_hiccup" } })],
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(illegal.ok, false);

  const unfinishedRec = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 8000)],
    recoveryRuns: [run("run_r1", 20000, "running", null)],
    guardFrames: [guardBlock("run_d1", 5100)],
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(unfinishedRec.ok, false);
  assert.ok(unfinishedRec.violations.some((s) => s.includes("run_r1")));

  const unfinishedDown = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "running", null)],
    recoveryRuns: [],
    guardFrames: [guardBlock("run_d1", 5100)],
    killAt: 4000,
    healthyAt: 9000,
  });
  assert.equal(unfinishedDown.ok, false);
  assert.ok(unfinishedDown.violations.some((s) => /未到终态/.test(s)));
});

test("assertGuardsKill：压下窗零 run 或窗内零执行完的 run = 布景坏了，不装绿", () => {
  const noRuns = assertGuardsKill({ downRuns: [], recoveryRuns: [], guardFrames: [], killAt: 4000, healthyAt: 9000 });
  assert.equal(noRuns.ok, false);
  assert.ok(noRuns.violations.some((s) => /没有可断言的/.test(s)));
  const createdOnly = assertGuardsKill({
    downRuns: [run("run_d1", 5000, "completed", 25000)], // 窗内创建但复绿后才执行完——窗内执行集为空
    recoveryRuns: [],
    guardFrames: [],
    killAt: 4000,
    healthyAt: 20000,
  });
  assert.equal(createdOnly.ok, false);
  assert.ok(createdOnly.violations.some((s) => /压下窗内没有窗内执行完的 run/.test(s)), JSON.stringify(createdOnly.violations));
});

// ---------- 实验②：gateway 压下的「已批准无票」断言判定器 ----------

test("assertApproveFailClosed：502 mint_failed + 卡 pending 未执行 + run 仍挂起 + 无 approve 审计 → ok", () => {
  const v = assertApproveFailClosed({
    approveStatus: 502,
    approveBody: { error: "mint_failed" },
    cardWire: { id: "apr_1", status: "pending", approver: null, executed: false, run_id: "run_k" },
    runStatus: "awaiting_approval",
    approvalAudit: [
      audit({ action: "create", objectId: "apr_1", objectType: "approval", createdAt: 4000 }),
    ],
  });
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test("assertApproveFailClosed：任何一处「其实批成了」都点名——状态/执行标/approve 审计/挂起态", () => {
  const base = {
    approveStatus: 502,
    approveBody: { error: "mint_failed" },
    cardWire: { status: "pending", approver: null, executed: false, run_id: "run_k" },
    runStatus: "awaiting_approval",
    approvalAudit: [],
  };
  assert.equal(assertApproveFailClosed({ ...base, approveStatus: 200 }).ok, false);
  assert.equal(assertApproveFailClosed({ ...base, approveBody: { error: "gateway_failed" } }).ok, false);
  const approvedCard = assertApproveFailClosed({
    ...base, cardWire: { status: "approved", approver: "x", executed: false, run_id: "run_k" },
  });
  assert.equal(approvedCard.ok, false);
  assert.ok(approvedCard.violations.length >= 2); // status + approver 两处点名
  assert.equal(assertApproveFailClosed({ ...base, cardWire: { status: "pending", approver: null, executed: true, run_id: "run_k" } }).ok, false);
  assert.equal(assertApproveFailClosed({ ...base, runStatus: "running" }).ok, false);
  const audited = assertApproveFailClosed({
    ...base, approvalAudit: [audit({ action: "approve", objectId: "apr_1", objectType: "approval", createdAt: 5000 })],
  });
  assert.equal(audited.ok, false);
  assert.ok(audited.violations.some((s) => /approve 审计/.test(s)));
});

test("assertMintFailedRun：queued→running→failed(mint_failed) + FAILURE kill 审计 → ok；缺强杀行 → 违规", () => {
  const good = assertMintFailedRun(
    {
      runId: "run_m", createdAt: 100, status: "failed", terminalAt: 800, failReason: "mint_failed",
      transitions: [
        { at: 100, to: "queued", reason: null },
        { at: 700, to: "running", reason: null },
        { at: 800, to: "failed", reason: "mint_failed" },
      ],
    },
    [audit({
      action: "kill", objectId: "run_m", objectType: "run", result: "FAILURE", createdAt: 800,
      details: { code: "mint_failed", status: { from: "queued", to: "failed" } },
    })],
  );
  assert.equal(good.ok, true, JSON.stringify(good.violations));

  const noKillRow = assertMintFailedRun(
    {
      runId: "run_m", createdAt: 100, status: "failed", terminalAt: 800, failReason: "mint_failed",
      transitions: [{ at: 100, to: "queued", reason: null }, { at: 800, to: "failed", reason: "mint_failed" }],
    },
    [],
  );
  assert.equal(noKillRow.ok, false);
  assert.ok(noKillRow.violations.some((s) => /FAILURE/.test(s)));
});

// ---------- 容器操作选型（选型钉在纯函数里，脚本只执行） ----------

test("docker 参数构造：guards 用 kill/start（无 restart 策略，死了不会自己爬起来）；gateway 用 compose stop/start", () => {
  assert.deepEqual(dockerKillArgs("soc-demo-guards-1"), ["kill", "soc-demo-guards-1"]);
  assert.deepEqual(dockerStartArgs("soc-demo-guards-1"), ["start", "soc-demo-guards-1"]);
  assert.deepEqual(composeStopArgs("gateway"), ["compose", "stop", "gateway"]);
  assert.deepEqual(composeStartArgs("gateway"), ["compose", "start", "gateway"]);
});

// ---------- 实验①表行 ----------

test("guardsLegRow：列数与 B5_GUARDS_TABLE_HEADER 对齐；腿名/帧数/分位如实渲染", () => {
  const headerCols = B5_GUARDS_TABLE_HEADER.split("\n")[0].split("|").map((s) => s.trim()).filter(Boolean);
  const row = guardsLegRow({
    leg: "压下窗（guards 死亡）", sent: 24, ok: 24, runs: 24, completed: 24, failed: 0,
    deniedFrames: 72, flaggedFrames: 12, lat: latencyStats([300, 100, 200]),
  });
  const cols = row.split("|").map((s) => s.trim()).filter((s) => s !== "");
  assert.equal(cols.length, headerCols.length);
  assert.match(row, /压下窗/);
  assert.match(row, /24\/24/);
  assert.match(row, /24\/0/); // completed/failed
  assert.match(row, /\| 72 \|/); // DENIED 帧
  assert.match(row, /200/); // P50
});
