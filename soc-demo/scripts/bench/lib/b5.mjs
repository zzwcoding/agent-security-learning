// m13 · B5 防线压下实验的纯函数面（票 69；设计源 2026-09-12-压力测试方案.md §三 B5）：
// 并发锤档位解析 / autocannon 错误面分类（沿用票 66 口径）/ markdown 表行 /
// guards 压下的 fail-closed 断言判定器 / gateway 压下的「不留已批准无票」断言判定器 /
// 容器操作选型（docker 参数构造）。只消费公开读口的 wire JSON（M2 GET /api/v1/audit
// 审计行 + buildRunTimelines 的 run 时间线），绝不 import services 内部（边界规则 R3）。
// 纯函数无 IO——离线单测喂合成行；容器操作是 IO，参数构造在这里、执行在脚本里。
//
// 断言语义出处（services 真码，2026-09-12 只读核对，报告同记）：
//   · guards-client.ts unreachable()：不可达/超时按 failMode 折裁——缺省 block →
//     {blocked:true, action:"fail_closed", reason:"guards_unreachable"|"guards_timeout"}；
//   · workers/triage/flow.ts scanField()：blocked → 审计 guards_block / result=DENIED
//     （details.reason=客户端给的 reason）+ 原文换占位符，run 继续跑完（不抛错）；
//   · app.ts approve（内部模式）：先铸票后裁决——mintApprovalToken 抛错 → 502
//     mint_failed，decideApproval 未执行 → 卡仍 pending、run 仍 awaiting_approval、
//     无 approve 审计行（「不留已批准无票」的结构保证）；
//   · app.ts executeStartJob：start 任务铸票失败 → queued→running→failed(mint_failed)
//     + 审计 kill/FAILURE（code=mint_failed）+ error 事件（不留无票 run）。

/** 压下窗 reason 的合法集：guards 客户端 fail-closed 折裁只会给这两个（outbound.ts 口径：
 *  超时是「慢」、不可达是「不通」）。出现其它值 = 断言面失真，判违规。 */
export const KNOWN_GUARD_DOWN_REASONS = new Set(["guards_unreachable", "guards_timeout"]);

/** SQLite 写锤并发档（升幂爬档；上限 64——单机演示量级红线，再高是压 clients 不是压库）。 */
export const HAMMER_TIERS = [1, 4, 16, 64];

/** CLI 档位解析：缺省全档；点名子集保序；非法一律抛（同 b2 parseModes 纪律）。 */
export function parseLadder(args, { tiers = HAMMER_TIERS } = {}) {
  const picked = args.length === 0 ? [...tiers] : args.map(Number);
  for (const t of picked) {
    if (!tiers.includes(t)) {
      throw new Error(`未知档位：${args[0] ?? ""}（可选：${tiers.join("/")}）`);
    }
  }
  return { tiers: picked };
}

/**
 * autocannon result → 并发锤错误面分类。201（新建）与 200（INV-6 去重）分开计；
 * 422（验型闸 fail-closed 拒收）与过载面（5xx/超时/网络错）分开计——同票 66 口径。
 */
export function classifyHammer(result = {}) {
  const stats = result.statusCodeStats ?? {};
  let ok2xx = 0, created201 = 0, dedup200 = 0, bad422 = 0, client4xx = 0, server5xx = 0;
  for (const [code, s] of Object.entries(stats)) {
    const n = s?.count ?? s?.total ?? 0;
    const c = Number(code);
    if (c === 201) created201 += n;
    else if (c === 200) dedup200 += n;
    if (c < 300) ok2xx += n;
    else if (c === 422) bad422 += n;
    else if (c < 500) client4xx += n;
    else server5xx += n;
  }
  const timeouts = result.timeouts ?? 0;
  const network = result.errors ?? 0;
  return {
    ok2xx, created201, dedup200, bad422, client4xx, server5xx, timeouts, network,
    bad: bad422 + client4xx + server5xx + timeouts + network,
  };
}

// B5 写锤汇总表头（每档一行）
export const B5_HAMMER_TABLE_HEADER =
  "| 并发连接 | 2xx/请求数 | 201+200 | P50(ms) | P95(ms) | P99(ms) | max(ms) | req/s | 422 | 5xx | 超时 | 网络错 | /healthz P50(ms) |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const i = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "n/a");

/** 一档 → 一行 markdown（13 列，与 B5_HAMMER_TABLE_HEADER 对齐）。 */
export function hammerRow({ tier, sent, err, lat, throughput, healthzP50 }) {
  const e = err ?? { bad422: NaN, server5xx: 0, timeouts: 0, network: 0 };
  return `| ${tier} | ${i(err?.ok2xx)}/${i(sent)} | ${i(err?.created201)}+${i(err?.dedup200)} | ${i(lat?.p50)} | ${i(lat?.p95)} | ${i(lat?.p99)} | ${i(lat?.max)} | ${i(throughput)} | ${i(e.bad422)} | ${i(e.server5xx)} | ${i(e.timeouts)} | ${i(e.network)} | ${i(healthzP50)} |`;
}

// B5 实验① guards 三腿汇总表头
export const B5_GUARDS_TABLE_HEADER =
  "| 腿 | 发/201 | runs | completed/failed | guards_block DENIED 帧 | flag 帧 | run P50(ms) | P99(ms) |\n" +
  "|---|---|---|---|---|---|---|---|";

/** 实验①一腿 → 一行 markdown（8 列，与 B5_GUARDS_TABLE_HEADER 对齐）。 */
export function guardsLegRow({ leg, sent, ok, runs, completed, failed, deniedFrames, flaggedFrames, lat }) {
  return `| ${leg} | ${i(ok)}/${i(sent)} | ${i(runs)} | ${i(completed)}/${i(failed)} | ${i(deniedFrames)} | ${i(flaggedFrames)} | ${i(lat?.p50)} | ${i(lat?.p99)} |`;
}

// ---------- 实验①：guards 压下的 fail-closed 断言判定器 ----------

/**
 * 审计行流 → guards_block 帧的归一化视图（triage scanField 的落账形）：
 * {t, runId, objectType, scanAction, reason, result}。其它审计行（含
 * tool_output_flagged——那是票 50 的 flag 降级支路，不进本判定）不收。
 */
export function collectGuardFrames(entries) {
  return (entries ?? [])
    .filter((e) => e.action === "guards_block")
    .map((e) => ({
      t: e.createdAt,
      runId: e.objectId,
      objectType: e.objectType ?? null,
      scanAction: e.details?.action ?? null,
      reason: e.details?.reason ?? null,
      result: e.result ?? null,
    }));
}

function denyCountByRun(frames) {
  const m = new Map();
  for (const f of frames) {
    if (f.result === "DENIED") m.set(f.runId, (m.get(f.runId) ?? 0) + 1);
  }
  return m;
}

/**
 * 实验①的总断言（判定器纯函数，脚本负责喂数）。归因口径（2026-09-12 两跑修正）：
 * ①fail-closed 看**执行时刻**不看到达时刻——压下窗创建、复绿后才执行完的 run 扫描发生在
 *   复绿后，零 DENIED 是合法读数（stats.crossRecovered 记账），不算绕过；
 * ②kill 前创建的 run 扫描可能赶在 kill 前跑完（扫描时刻从公开面不可辨），零 DENIED
 *   不定罪（stats.preKillCreated 记账）——必须带 DENIED 的是 **kill 后创建且窗内执行完**
 *   的 run：它的一切扫描只能发生在压下窗内。
 *   downRuns     压下窗（kill→复绿之间灌入的批次）创建的 run 时间线（脚本按批前缀圈定）
 *   recoveryRuns 复绿后创建的 run 时间线
 *   guardFrames  全实验的审计行流（内部先过 collectGuardFrames 归一化）
 *   killAt       docker kill 确认生效时刻（ms；压下窗起点）
 *   healthyAt    guards 就绪时刻（ms；脚本用「healthz 绿 + 首次真扫描成功」双闸——
 *                healthz 绿 ≠ 扫描就绪，guards 冷启动装载模型可让首扫超时被拒）
 *   minDeniesPerRun 每个「窗内执行完」的 run 至少应有的 DENIED 帧数（缺省 1——本实验
 *                   的告警必带 untrusted 段，verdict_llm 必扫；零帧 = 扫描被绕过）
 * fail-closed 语义四条（INV-1 的压下版）：
 *   ①kill 后创建、窗内执行完的每个 run 都被扫描罩住（≥minDeniesPerRun 条 DENIED 帧）——
 *     零「绕过扫描的成功出站」；
 *   ②guards_block 帧全数 DENIED（该帧只该以拒绝形态存在）；
 *   ③reason 全在 fail-closed 合法集（guards_unreachable/guards_timeout）；
 *   ④恢复窗零 DENIED 帧 + 压下窗 run 全到终态（压下不挂死、恢复不留污染）。
 * 违规 = {ok:false, violations:[可读条目]}；压下窗零 run 或窗内零执行完 = 布景坏了，不装绿。
 */
export function assertGuardsKill({ downRuns, recoveryRuns, guardFrames, killAt, healthyAt, minDeniesPerRun = 1 }) {
  const violations = [];
  const frames = collectGuardFrames(guardFrames);
  const denied = denyCountByRun(frames);
  const createdAfterKill = (downRuns ?? []).filter((r) => (r.createdAt ?? 0) >= killAt);
  const inWindowExecuted = createdAfterKill.filter((r) => r.terminalAt !== null && r.terminalAt <= healthyAt);
  const stats = {
    downRuns: (downRuns ?? []).length,
    preKillCreated: (downRuns ?? []).filter((r) => (r.createdAt ?? 0) < killAt).map((r) => r.runId),
    inWindowExecuted: inWindowExecuted.length,
    crossRecovered: createdAfterKill.filter((r) => r.terminalAt !== null && r.terminalAt > healthyAt).map((r) => r.runId),
    deniedFrames: frames.filter((f) => f.result === "DENIED").length,
    reasons: [...new Set(frames.map((f) => f.reason))],
    recoveryRunIds: (recoveryRuns ?? []).map((r) => r.runId),
  };

  if (stats.downRuns === 0) violations.push("压下窗没有可断言的 run——布景坏了（负载没压进压下窗），不装绿");
  else if (stats.inWindowExecuted === 0) {
    violations.push("压下窗内没有窗内执行完的 run——压下窗太短（没等到排队 run 执行）或布景坏了，不装绿");
  }
  for (const r of inWindowExecuted) {
    const n = denied.get(r.runId) ?? 0;
    if (n < minDeniesPerRun) {
      violations.push(`run ${r.runId} kill 后创建、窗内执行完却只有 ${n} 条 DENIED 帧（<${minDeniesPerRun}）——存在绕过扫描的出站`);
    }
  }
  for (const r of downRuns ?? []) {
    if (r.terminalAt === null) {
      violations.push(`run ${r.runId} 压下窗创建后未到终态——压下不应挂死流水线（fail-closed ≠ 挂起）`);
    }
  }
  for (const f of frames) {
    if (f.result !== "DENIED") {
      violations.push(`guards_block 帧 result=${f.result}（objectId=${f.runId}）——该帧只应以 DENIED 存在`);
    }
    if (!KNOWN_GUARD_DOWN_REASONS.has(f.reason)) {
      violations.push(`guards_block 帧 reason=${f.reason}（objectId=${f.runId}）不在 fail-closed 合法集`);
    }
  }
  const recoveryIds = new Set((recoveryRuns ?? []).map((r) => r.runId));
  const recoveryDeniedLegal = [];
  for (const f of frames) {
    if (recoveryIds.has(f.runId) || (f.t ?? 0) >= healthyAt) {
      // 恢复窗的合法 reason DENIED 帧 = 扫描偶发超时被拒（fail-closed 对「慢」的保守裁决，
      // 是防线在工作不是放行）——记入 stats 由脚本作健康注记；非法 reason/非 DENIED 仍违规。
      if (f.result === "DENIED" && KNOWN_GUARD_DOWN_REASONS.has(f.reason)) recoveryDeniedLegal.push(f);
      else violations.push(`恢复窗仍有异常 guards 帧（run ${f.runId}，t=${f.t}，result=${f.result}，reason=${f.reason}）——就绪后扫描不应再异常`);
    }
  }
  stats.recoveryDeniedFrames = recoveryDeniedLegal.length;
  for (const r of recoveryRuns ?? []) {
    if (r.terminalAt === null) {
      violations.push(`run ${r.runId} 恢复窗创建后未到终态——恢复后行为应如常（压下不留污染）`);
    }
  }
  return { ok: violations.length === 0, violations, stats };
}

// ---------- 实验②：gateway 压下的「不留已批准无票」断言判定器 ----------

/**
 * 实验② approve 腿断言。语义出处 app.ts approve（内部模式）：先铸票后裁决——
 * gateway 不可达时 mintApprovalToken 抛错 → 502 {error:"mint_failed"}，decideApproval
 * 未执行。安全终态 = 卡仍 pending（approver 空、未执行）+ run 仍 awaiting_approval
 * （可观察、可重试）+ 无 approve/execute 审计行（INV-8：没发生的裁决不留痕）。
 *   approveStatus/approveBody  POST approve 的实际应答
 *   cardWire                   GET /api/v1/approvals（toWire 形）断言时刻的卡
 *   runStatus                  run 时间线折出的当前状态
 *   approvalAudit              objectId=卡 id 的审计行流
 */
export function assertApproveFailClosed({ approveStatus, approveBody, cardWire, runStatus, approvalAudit }) {
  const violations = [];
  if (approveStatus !== 502) violations.push(`approve 应答 HTTP ${approveStatus}（预期 502）`);
  if (approveBody?.error !== "mint_failed") {
    violations.push(`approve 应答体 error=${approveBody?.error}（预期 mint_failed）`);
  }
  if (cardWire?.status !== "pending") violations.push(`裁决后卡 status=${cardWire?.status}（预期仍 pending）`);
  if (cardWire?.approver != null) violations.push(`裁决后卡 approver=${cardWire?.approver}（预期空——裁决未落卡）`);
  if (cardWire?.executed !== false) violations.push(`裁决后卡 executed=${cardWire?.executed}（预期 false——一次性密令未铸未用）`);
  if (runStatus !== "awaiting_approval") {
    violations.push(`run 状态=${runStatus}（预期 awaiting_approval——批准未生效，run 应仍挂起可观察）`);
  }
  for (const e of approvalAudit ?? []) {
    if (e.action === "approve") violations.push("出现 approve 审计行——502 之下裁决不应留痕（INV-8）");
    if (e.action === "execute") violations.push("出现 execute 审计行——无票不应有执行");
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 实验② start 腿断言：gateway 压下期间拉起的 run 走明确 failed 分支——
 * queued→running→failed(failReason=mint_failed)（executeStartJob 强杀口径）+
 * 审计 kill/FAILURE（details.code=mint_failed）。任何一缺 = 「无票 run」悬置 → 违规。
 */
export function assertMintFailedRun(timeline, auditEntries) {
  const violations = [];
  const toFailed = (timeline?.transitions ?? []).find((tr) => tr.to === "failed");
  if (!toFailed) violations.push("run 没有 failed 迁移——铸票失败的 run 必须有明确 failed 终态");
  else if (toFailed.reason !== "mint_failed") {
    violations.push(`failed 迁移 failReason=${toFailed.reason}（预期 mint_failed）`);
  }
  const sawRunning = (timeline?.transitions ?? []).some((tr) => tr.to === "running");
  if (!sawRunning) violations.push("没有 running 迁移——强杀口径是 queued→running→failed 两步合法迁移");
  const killRow = (auditEntries ?? []).find(
    (e) => e.action === "kill" && e.result === "FAILURE" && e.details?.code === "mint_failed",
  );
  if (!killRow) violations.push("缺 FAILURE kill 审计行（code=mint_failed）——INV-8 兜底强杀必须留痕");
  return { ok: violations.length === 0, violations };
}

// ---------- 容器操作选型（参数构造在这里钉死，执行在脚本里） ----------

// 选型（脚本头注同记）：guards 压下用 docker kill/start——compose 未配 restart 策略
// （docker inspect RestartPolicy=no 实测），kill 后容器停在 exited、不会自己爬起来，
// 恢复动作显式可控；kill（SIGKILL）= 真实故障形态「进程崩溃」，出站 fetch 立刻
// ECONNREFUSED → guards_unreachable 分支。不用 pause：挂起进程会走 2s 超时分支
//（guards_timeout），那是另一条已单测锁定的路径，本实验钉 unreachable 分支。
export const dockerKillArgs = (name) => ["kill", name];
export const dockerStartArgs = (name) => ["start", name];
// gateway 压下用 compose stop/start（票面原话；stop=SIGTERM 优雅退出，同样无 restart 策略）。
export const composeStopArgs = (service) => ["compose", "stop", service];
export const composeStartArgs = (service) => ["compose", "start", service];
