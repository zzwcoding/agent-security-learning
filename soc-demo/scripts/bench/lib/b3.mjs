// m13 · B3 分发循环水位爬坡的纯函数面：审计行流 → run 时间线 / 队列深度时间序列 /
// 分位 / 吞吐。只消费 M2 GET /api/v1/audit 的 wire JSON（字段见 case-backend store.queryAudit），
// 绝不 import services 内部（边界规则 R3）。纯函数无 IO——离线单测喂合成审计行。
//
// 观察口径（票 65，报告里如实标注）：run_jobs 表无公开读口，队列深度用 runs 状态分布
// 近似——B3 只经 POST /internal/runs 拉 start 任务，pending 任务 ↔ queued run 一一对应
// （claimed 窗口短暂，计入 running）。状态与时刻的真相源 = agent 审计行 createdAt
//（agent 进程钟在记录时刻写定，HTTP 投递延迟不污染时刻，只影响可见性）。

export const TERMINAL_RUN_STATES = new Set(["completed", "failed"]);

/** 最近邻秩分位（小样本诚实口径：不插值美化）。sorted 升序数组；p∈(0,100]。空集回 NaN。 */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 审计行流（createdAt 升序，M2 queryAudit 的排序）→ 每-run 时间线。
 * 识别三件事：
 *   ① run 行（objectType=run）：create（details.created 带 kind/alertId/caseId）与
 *      update（details.status 带 from/to，失败行带 failReason）→ 状态迁移序列；
 *   ② triage_skip 行（objectType=alert，details.run_id）：抢 verdict 锁让路的 run
 *      （防重闸的最后兜底命中）——它的 queued→completed 不是流水线延迟，剔除用；
 *   ③ alertId → runId 映射（防重对账：一个 alert 冒出两个 run = autorun 竞速双拉）。
 */
export function buildRunTimelines(entries) {
  const byId = new Map();
  const skippedRunIds = new Set();
  const runsByAlert = new Map();
  for (const e of entries) {
    if (e.action === "triage_skip" && e.details?.run_id) {
      skippedRunIds.add(e.details.run_id);
      continue;
    }
    if (e.objectType !== "run") continue;
    let t = byId.get(e.objectId);
    if (!t) {
      t = {
        runId: e.objectId,
        kind: e.details?.created?.kind ?? null,
        alertId: e.details?.created?.alertId ?? null,
        caseId: e.details?.created?.caseId ?? null,
        createdAt: e.createdAt,
        status: "queued",
        transitions: [{ at: e.createdAt, to: "queued", reason: null }],
        terminalAt: null,
        failReason: null,
      };
      byId.set(e.objectId, t);
      if (t.alertId) {
        if (!runsByAlert.has(t.alertId)) runsByAlert.set(t.alertId, []);
        runsByAlert.get(t.alertId).push(e.objectId);
      }
      continue; // create 行本身不带状态迁移
    }
    const to = e.details?.status?.to;
    if (!to) continue;
    t.status = to;
    t.transitions.push({ at: e.createdAt, to, reason: e.details?.failReason ?? null });
    if (TERMINAL_RUN_STATES.has(to)) {
      t.terminalAt = e.createdAt;
      t.failReason = e.details?.failReason ?? null;
    }
  }
  return { runs: [...byId.values()], skippedRunIds, runsByAlert };
}

/**
 * 时间线集 → 队列深度时间序列（固定网格采样）。
 * 每-run 状态 = 该网格时刻之前最后一条迁移的目标态（迁移前=queued）。
 * 返回 [{t, queued, running, terminal}]，只保留队列非空的点 + 首末两个点。
 */
export function reconstructSeries(runs, { gridMs = 500 } = {}) {
  if (runs.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const r of runs) {
    min = Math.min(min, r.createdAt);
    for (const tr of r.transitions) max = Math.max(max, tr.at);
  }
  const stateOf = (run, t) => {
    let s = "queued";
    for (const tr of run.transitions) {
      if (tr.at <= t) s = tr.to;
      else break;
    }
    return s;
  };
  const samples = [];
  for (let t = min; t <= max + gridMs / 2; t += gridMs) {
    let queued = 0;
    let running = 0;
    let terminal = 0;
    for (const r of runs) {
      const s = stateOf(r, t);
      if (s === "queued") queued += 1;
      else if (s === "running" || s === "awaiting_approval") running += 1;
      else terminal += 1;
    }
    samples.push({ t, queued, running, terminal });
  }
  // 压缩：只留队列非空的点 + 首末点（曲线读数用，原始点不进报告）
  const kept = samples.filter((s, i) =>
    s.queued > 0 || i === 0 || i === samples.length - 1);
  return kept;
}

/** 序列峰值队列深度（水位爬坡要的数字）。 */
export function peakQueued(series) {
  return series.reduce((m, s) => Math.max(m, s.queued), 0);
}

/**
 * 一档的聚合：winning = 非 triage_skip 让路且终态 completed 的 run（真流水线延迟）；
 * throughput = 完成数 / (首条 create → 末条终态) 的墙钟跨度（audit 钟）。
 */
export function summarizeTier(runs, skippedRunIds) {
  const winning = runs.filter(
    (r) => r.terminalAt !== null && r.status === "completed" && !skippedRunIds.has(r.runId),
  );
  const yielded = runs.filter((r) => skippedRunIds.has(r.runId));
  const failed = runs.filter((r) => r.status === "failed");
  const latencies = winning.map((r) => r.terminalAt - r.createdAt).sort((a, b) => a - b);
  let throughput = NaN;
  if (winning.length > 0) {
    const start = Math.min(...winning.map((r) => r.createdAt));
    const end = Math.max(...winning.map((r) => r.terminalAt));
    const spanSec = (end - start) / 1000;
    if (spanSec > 0) throughput = winning.length / spanSec;
  }
  return { winning, yielded, failed, latencies, throughput };
}

const ms = (v) => (Number.isFinite(v) ? v.toFixed(0) : "n/a");
const rps = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");

/** B3 汇总表头（每档一行：档位/成败/三分位/吞吐 vs 理论/队列峰值）。 */
export const B3_TABLE_HEADER =
  "| 档（并发拉起 run 数） | completed/让路/failed | P50(ms) | P95(ms) | P99(ms) | 实测吞吐(run/s) | 理论(run/s) | 队列峰值 |\n" +
  "|---|---|---|---|---|---|---|---|";

/** 一档 → 一行 markdown（理论值 = 100ms tick 单领单 → 10 run/s，方案 §二#1）。 */
export function b3TableRow({ tier, summary, peak, theoryRps = 10 }) {
  const l = summary.latencies;
  const outcome = `${summary.winning.length}/${summary.yielded.length}/${summary.failed.length}`;
  return `| ${tier} | ${outcome} | ${ms(percentile(l, 50))} | ${ms(percentile(l, 95))} | ${ms(percentile(l, 99))} | ${rps(summary.throughput)} | ${theoryRps} | ${peak} |`;
}

/** 队列深度曲线压成一行读数（t(s):queued 点列，只留非零段）。 */
export function seriesLine(series) {
  if (series.length === 0) return "（无样本）";
  const t0 = series[0].t;
  return series
    .map((s) => `${((s.t - t0) / 1000).toFixed(1)}s:${s.queued}`)
    .join(" ");
}
