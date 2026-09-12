// m13 · B2 链路突发与持续流的纯函数面：档位解析 / autocannon 速率调度映射 /
// outbox 事件×run 配对（e2e 与 cursor 滞后的口径核心）/ 错误分类 / 积压收敛判定 /
// 表行渲染。只消费公开读口的 wire JSON（M2 GET /api/v1/events 的 outbox 行 +
// GET /api/v1/audit 的审计行，经 lib/b3.mjs buildRunTimelines 折成 run 时间线），
// 绝不 import services 内部（边界规则 R3）。纯函数无 IO——离线单测喂合成行。
//
// 口径（票 66，报告同记）：event_cursors 表无公开读口（在 agent 自有 SQLite），
// cursor 滞后按两个观测量近似——①逐事件消费延迟 e2eMs = run create（审计钟）
// − alert.created（outbox 钟，与告警落库同事务）；②未消化积压 = 未拉起告警 +
// 已拉起未终态 run 的时间序列。两侧容器共用宿主内核钟，时间戳可直接相减。
import { percentile } from "./b3.mjs";

export const BURST_TIERS = [100, 500];
export const SUSTAINED_TIERS = [2, 4, 6, 8]; // sustained≤8/s 纪律（L0 档位修正：分母=B3 实测 4.6-4.8 run/s）
export const DEFAULT_SUSTAINED_SECONDS = 120;
const MAX_CONNECTIONS = 20; // 档位红线（同 B1）：单机演示量级

/** CLI 档位解析：["burst"] → 缺省 [100,500]；["sustained","2","6"] → 点名子集。非法一律抛。 */
export function parseModes(args, { burstTiers = BURST_TIERS, sustainedTiers = SUSTAINED_TIERS } = {}) {
  const [mode, ...rest] = args;
  if (mode === "burst" || mode === "sustained") {
    const allowed = mode === "burst" ? burstTiers : sustainedTiers;
    const tiers = rest.length === 0 ? [...allowed] : rest.map(Number);
    for (const t of tiers) {
      if (!allowed.includes(t)) {
        throw new Error(`未知档位：${args[1] ?? ""}（${mode} 可选：${allowed.join("/")}）`);
      }
    }
    return { mode, tiers };
  }
  throw new Error(`用法：b2-chain.mjs <burst|sustained> [档位…]（burst=${BURST_TIERS.join("/")}，sustained=${SUSTAINED_TIERS.join("/")}）`);
}

/**
 * 档位 → autocannon 编程 API 参数（施压面红线：真 autocannon，这里只做映射不做手写压测循环）。
 * burst = amount 一次性灌入（无 overallRate/duration = 真突发满速）；
 * sustained = duration×overallRate 开环恒速。connections 都压在红线 ≤20 内。
 */
export function firePlan({ mode, tier, seconds = DEFAULT_SUSTAINED_SECONDS }) {
  if (mode === "burst") return { amount: tier, connections: Math.min(MAX_CONNECTIONS, 20) };
  if (mode === "sustained") return { duration: seconds, overallRate: tier, connections: 2 };
  throw new Error(`firePlan：未知 mode ${mode}`);
}

/**
 * autocannon 完整 opts（b2-chain 真调用形态，从这里注入 = 单测缝）。
 * 实测坑（autocannon 8.0.0，2026-09-12）：path 必须写在 requests[] **条目内**——顶层 path
 * 会被 requests 数组条目的缺省值 "/" 覆盖，压出来的全是 404（首跑真踩：100 发全 404 零告警）。
 * uniqueBody 每请求调用一次返回唯一 JSON 体（sourceRef 全局唯一防 INV-6 去重）。
 */
export function buildAutocannonOpts({ baseUrl, path, mode, tier, seconds = DEFAULT_SUSTAINED_SECONDS, uniqueBody }) {
  const plan = firePlan({ mode, tier, seconds });
  return {
    url: baseUrl,
    ...plan,
    requests: [
      {
        method: "POST",
        path, // 坑：必须在条目内，见头注
        headers: { "content-type": "application/json" },
        setupRequest: (req) => ({ ...req, body: JSON.stringify(uniqueBody()) }),
      },
    ],
  };
}

/**
 * outbox alert.created 事件 × run 时间线配对——e2e/cursor 滞后/积压三个观测量的数据源。
 *   matched   每事件配该 alertId **最早 create** 的 run（「拉起」时刻），e2eMs = runAt − eventAt；
 *   unmatched 没拉起 run 的告警（autorun 未消费——积压的第一层）；
 *   dupRuns   同 alert 冒出多个 run 的额外数（autorun 竞速双拉对账项）。
 * sourceRefPrefix 过滤他轮次流量（每档生成器前缀唯一，见 b2-chain.mjs）。
 */
export function matchAlertRuns(events, runs, { sourceRefPrefix = "" } = {}) {
  const rel = events.filter(
    (e) => e.topic === "alert.created" &&
      (!sourceRefPrefix || String(e.payload?.sourceRef ?? "").startsWith(sourceRefPrefix)),
  );
  const firstRun = new Map();
  const extraRuns = new Map();
  for (const r of runs) {
    if (!r.alertId) continue;
    const prev = firstRun.get(r.alertId);
    if (!prev) firstRun.set(r.alertId, r);
    else if (r.createdAt < prev.createdAt) {
      firstRun.set(r.alertId, r);
      extraRuns.set(r.alertId, (extraRuns.get(r.alertId) ?? 0) + 1);
    } else extraRuns.set(r.alertId, (extraRuns.get(r.alertId) ?? 0) + 1);
  }
  const inScope = new Set(rel.map((e) => e.payload?.alertId).filter(Boolean));
  const matched = [];
  const unmatched = [];
  for (const e of rel) {
    const alertId = e.payload?.alertId;
    const r = alertId ? firstRun.get(alertId) : undefined;
    const base = { alertId: alertId ?? null, sourceRef: e.payload?.sourceRef ?? null, eventId: e.id, eventAt: e.createdAt };
    if (r) {
      matched.push({ ...base, runId: r.runId, runAt: r.createdAt, runStatus: r.status, e2eMs: r.createdAt - e.createdAt });
    } else {
      unmatched.push(base);
    }
  }
  let dupRuns = 0;
  for (const [alertId, n] of extraRuns) if (inScope.has(alertId)) dupRuns += n;
  return { matched, unmatched, dupRuns };
}

/** 延迟分位（最近邻秩，同 b3.percentile 口径；空集 NaN 不美化）。 */
export function latencyStats(msArr) {
  const sorted = [...(msArr ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : NaN,
  };
}

/**
 * autocannon result → 错误面分类（票 66：422 坏包与 5xx/超时分开说——
 * 422=验型闸 fail-closed 拒收；5xx/超时/网络错=过载面）。
 */
export function classifyErrors(result = {}) {
  const stats = result.statusCodeStats ?? {};
  let ok2xx = 0, bad422 = 0, client4xx = 0, server5xx = 0;
  for (const [code, s] of Object.entries(stats)) {
    const n = s?.count ?? s?.total ?? 0;
    const c = Number(code);
    if (c < 300) ok2xx += n;
    else if (c === 422) bad422 += n;
    else if (c < 500) client4xx += n;
    else server5xx += n;
  }
  const timeouts = result.timeouts ?? 0;
  const network = result.errors ?? 0;
  return {
    ok2xx, bad422, client4xx, server5xx, timeouts, network,
    bad: bad422 + client4xx + server5xx + timeouts + network,
  };
}

/** 积压序列峰值。samples: [{t, backlog}]。 */
export function backlogPeak(samples) {
  return (samples ?? []).reduce((m, s) => Math.max(m, s.backlog), 0);
}

/**
 * 积压收敛判定：末样本归零=收敛；drainedAt=首次归零时刻——积起来过的从峰值后首次
 * 归零算，从没积起来的（峰值 0）取首样本时刻（「没积压」是合法读数）。
 * 空样本=不收敛（n/a 口径）。
 */
export function drainInfo(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return { converged: false, drainedAt: null };
  const rose = samples.findIndex((s) => s.backlog > 0);
  if (rose === -1) return { converged: samples[samples.length - 1].backlog === 0, drainedAt: samples[0].t };
  const firstZero = samples.slice(rose).find((s) => s.backlog === 0);
  return {
    converged: samples[samples.length - 1].backlog === 0,
    drainedAt: firstZero ? firstZero.t : null,
  };
}

// B2 汇总表头（burst 与 sustained 共用一套列；burst 档列写「一次性 N 条」，sustained 写「R/s×Ss」）
export const B2_TABLE_HEADER =
  "| 档 | 201/发 | ingest P50(ms) | P95(ms) | P99(ms) | req/s | 消费延迟 P50(ms) | P95(ms) | P99(ms) | 积压峰(条) | 收敛 | 422 | 5xx/超时 |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|";

const i = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "n/a");

/** 一档 → 一行 markdown（13 列，与 B2_TABLE_HEADER 对齐）。 */
export function b2Row({ tier, sent, ok, ingest, e2e, throughput, peak, converged, err }) {
  const e = err ?? { bad422: NaN, server5xx: 0, timeouts: 0, network: 0 };
  const overload = (e.server5xx ?? 0) + (e.timeouts ?? 0) + (e.network ?? 0);
  const rps = Number.isFinite(throughput) ? throughput.toFixed(0) : "n/a";
  return `| ${tier} | ${i(ok)}/${i(sent)} | ${i(ingest?.p50)} | ${i(ingest?.p95)} | ${i(ingest?.p99)} | ${rps} | ${i(e2e?.p50)} | ${i(e2e?.p95)} | ${i(e2e?.p99)} | ${i(peak)} | ${converged ? "是" : "否"} | ${i(e.bad422)} | ${overload} |`;
}
