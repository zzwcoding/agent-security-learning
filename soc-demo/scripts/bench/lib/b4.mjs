// m13 · B4 SSE 扇出的工具面：SSE 帧解析（WHATWG text/event-stream 子集，增量跨块）/
// Last-Event-ID 游标推进与重连补发对账 / 事件到达 e2e 延迟聚合 / docker stats 采样解析 /
// 轮询对照客户端 / 表行渲染。只消费公开面的 wire 形（SSE 帧、M2 audit 行、docker stats
// 表输出），绝不 import services 内部（边界规则 R3）。纯函数无 IO——离线单测喂合成文本；
// IO 件（SSE 订阅客户端 / 轮询客户端）走显式注入缝（fetchImpl/agent 可换 stub）。
//
// 口径（票 67，报告同记）：
//   · 事件到达 e2e 延迟 = 客户端读块时刻 − 帧 data.ts（agent 钟写定；两侧容器与压测脚本
//     共用宿主内核钟，可直接相减；读块按批记时刻——同批帧共享到达时刻）。
//   · 订阅者滞后 = ①首帧延迟（connect 发起到首帧解析）②补发长度（重连带 Last-Event-ID
//     → 服务端按 id>cursor 补发，回溯条数对账 id 集）。
//   · agent 容器 CPU 用 docker stats --no-stream 定期采样（docker 的 CPU% 可 >100，
//     多核口径，数字只同机同轮比）。
//   · undici 实测坑（2026-09-12，Node 22.22）：fetch 流式响应默认 bodyTimeout=300s——
//     SSE 空闲挂流（无新事件不写包）300s 必被 undici 单方面掐断（UND_ERR_BODY_TIMEOUT，
//     真踩：挂流 301s 报 terminated）。SSE 客户端必须用 bodyTimeout:0 的 dispatcher。
import { fetch as undiciFetch } from "undici";
import { execFile } from "node:child_process";
import { percentile, TERMINAL_RUN_STATES } from "./b3.mjs";
import { latencyStats } from "./b2.mjs";

// ---------- SSE 帧解析（增量状态机；帧 = id/event/data 三字段 + 空行提交） ----------

/**
 * 造一个增量 SSE 解析器：push(text) → 本段凑齐的帧数组（半行/半帧悬挂到下一块）。
 * 兼容 LF/CRLF；多行 data 按 WHATWG 规则 \n 拼接后整体 JSON.parse（失败留原文）；
 * 注释行（: 开头）忽略；没有任何字段的空块不吐帧。服务端 wire 见 agent events.ts formatSse。
 */
export function createSseParser() {
  let buf = "";
  let frame = null; // { id, event, dataRaw: [] }
  const flush = (out) => {
    if (frame && (frame.id !== null || frame.event !== null || frame.dataRaw.length > 0)) {
      const raw = frame.dataRaw.join("\n");
      let data = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // 非 JSON data 原样保留（wire 契约里 data 恒为 JSON，这里只是不硬炸）
      }
      out.push({ id: frame.id, event: frame.event, data });
    }
    frame = null;
  };
  return {
    push(text) {
      const out = [];
      buf += text;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line === "") {
          flush(out);
        } else if (line.startsWith(":")) {
          // 注释/心跳行，忽略
        } else if (line.startsWith("id:")) {
          frame ??= { id: null, event: null, dataRaw: [] };
          const v = line.slice(3).trim();
          frame.id = v === "" ? null : Number(v);
        } else if (line.startsWith("event:")) {
          frame ??= { id: null, event: null, dataRaw: [] };
          frame.event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          frame ??= { id: null, event: null, dataRaw: [] };
          frame.dataRaw.push(line.slice(5).trimStart());
        }
        // 其他字段（retry 等）本压测不消费，忽略
      }
      return out;
    },
  };
}

/** Last-Event-ID 游标推进：只前进不后退（空批次/乱序小 id 不回退）。 */
export function advanceCursor(cursor, frames) {
  let next = cursor;
  for (const f of frames) {
    if (typeof f.id === "number" && Number.isFinite(f.id) && f.id > next) next = f.id;
  }
  return next;
}

// ---------- 重连补发对账（订阅者滞后的第二观测量） ----------

/**
 * 重连计划：把 N 个重连订阅者的 Last-Event-ID 铺在真实事件 id 集上（第 i 个取
 * ids[floor(i*len/N)]），期望补发数 = id 集中 >cursor 的条数——重连回来逐条对账
 * 「不丢不重」。ids 必须升序（订阅端所见全集，服务端补发严格按 id 递增）。
 */
export function planReconnects(ids, n) {
  const plan = [];
  for (let i = 0; i < n; i++) {
    const pos = Math.floor((i * ids.length) / n);
    const cursor = ids[pos];
    plan.push({ cursor, expected: expectedBackfill(ids, cursor) });
  }
  return plan;
}

/** 期望补发长度：id 集里 >cursor 的条数（cursor 在全集之前=全量补发；之后=0，均合法）。 */
export function expectedBackfill(ids, cursor) {
  return ids.reduce((m, id) => (id > cursor ? m + 1 : m), 0);
}

// ---------- 延迟统计聚合 ----------

/**
 * 事件到达 e2e 延迟样本：帧到达时刻 − data.ts（agent 钟）。缺 ts / 早于 ts 超过
 * maxSkewMs 的样本剔除（钟差伪影护栏，不进分布）。
 */
export function e2eLatencies(frames, { maxSkewMs = 100 } = {}) {
  const out = [];
  for (const f of frames ?? []) {
    const ts = f?.data?.ts;
    if (!Number.isFinite(ts)) continue;
    const d = f.arrival - ts;
    if (d >= -maxSkewMs) out.push(d);
  }
  return out;
}

export { latencyStats };

// ---------- docker stats 采样（观察口：容器 CPU/内存） ----------

/**
 * 解析 `docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'` 输出。
 * names 是容器名子串（"agent" 匹配 soc-demo-agent-1），每个名字回一行；找不到不硬造。
 * cpuPct 保留 docker 口径原值（可 >100，多核）；memUsedMB 取 MemUsage 首段数字（MiB 记 MB）。
 */
export function parseDockerStats(raw, names) {
  const rows = [];
  for (const line of String(raw ?? "").split("\n")) {
    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 3 || parts[0] === "") continue;
    const hit = names.find((n) => parts[0].includes(n));
    if (!hit) continue;
    const cpuPct = Number.parseFloat(parts[1]);
    const memUsedMB = Number.parseFloat(parts[2]);
    if (rows.some((r) => r.name === hit)) continue;
    rows.push({
      name: hit,
      container: parts[0],
      cpuPct: Number.isFinite(cpuPct) ? cpuPct : NaN,
      memUsedMB: Number.isFinite(memUsedMB) ? memUsedMB : NaN,
    });
  }
  return rows;
}

/** CPU 采样聚合：n / 中位 / max（docker 的 CPU% 可 >100，多核口径，见头注）。 */
export function cpuStats(samples) {
  const sorted = [...(samples ?? [])].filter(Number.isFinite).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: percentile(sorted, 50),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : NaN,
  };
}

// ---------- 表渲染（B4 两张表：SSE 扇出 + 1s 轮询对照） ----------

export const B4_SSE_TABLE_HEADER =
  "| 档(订阅者) | run事件数 | 首帧P50(ms) | 首帧P99(ms) | e2e P50(ms) | e2e P95(ms) | e2e P99(ms) | 补发长度中位 | 补发长度max | 补发对账差 | hold CPU%中位 | 基线CPU%中位 |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|";

export const B4_POLL_TABLE_HEADER =
  "| 档(轮询客户端) | 窗口(s) | 轮询次数 | req/s | RTT P50(ms) | RTT P99(ms) | 终态可见延迟P50(ms) | 终态可见延迟P99(ms) | 错误 | case-backend CPU%中位 |\n" +
  "|---|---|---|---|---|---|---|---|---|---|";

const f1 = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : "n/a");
const f0 = (v) => (Number.isFinite(v) ? String(Math.round(v)) : "n/a");

/** SSE 档行（12 列，与 B4_SSE_TABLE_HEADER 对齐）。backfillMismatch≠0 = 补发对账有缺口。 */
export function sseTableRow({ tier, runEvents, firstFrame, e2e, backfill, backfillMismatch, cpu, baseline }) {
  return `| ${tier} | ${f0(runEvents)} | ${f1(firstFrame?.p50)} | ${f1(firstFrame?.p99)} | ${f1(e2e?.p50)} | ${f1(e2e?.p95)} | ${f1(e2e?.p99)} | ${f1(backfill?.p50)} | ${f1(backfill?.max)} | ${f0(backfillMismatch)} | ${f1(cpu?.median)} | ${f1(baseline?.median)} |`;
}

/** 轮询档行（10 列，与 B4_POLL_TABLE_HEADER 对齐）。 */
export function pollTableRow({ tier, windowSec, requests, rps, rtt, visibility, errors, cpu }) {
  return `| ${tier} | ${f0(windowSec)} | ${f0(requests)} | ${f0(rps)} | ${f1(rtt?.p50)} | ${f1(rtt?.p99)} | ${f1(visibility?.p50)} | ${f1(visibility?.p99)} | ${f0(errors)} | ${f1(cpu?.median)} |`;
}

// ---------- IO 缝：SSE 订阅客户端（自实现 fetch-stream） ----------

/**
 * SSE 订阅客户端：fetch 流式读 + createSseParser，带 Last-Event-ID 重连语义。
 * agent 注入 undici Agent（真跑必须 bodyTimeout:0——见头注实测坑；单测传 null 走缺省
 * dispatcher）；fetchImpl 可整体替换（stub 测试缝）。open() 解析到响应头即返回订阅句柄，
 * 帧经句柄.frames 增量可见；done 在流落地后 resolve（server=服务端收流 / client=本端断开 /
 * error=网络错——永不 reject，错误分类进 outcome）。
 */
export function createSseClient({ agent, fetchImpl = undiciFetch } = {}) {
  return {
    async open({ url, lastEventId }) {
      const connectStart = Date.now();
      const ctrl = new AbortController();
      const headers = lastEventId !== undefined && lastEventId !== null
        ? { "last-event-id": String(lastEventId) }
        : {};
      const res = await fetchImpl(url, {
        headers,
        signal: ctrl.signal,
        ...(agent ? { dispatcher: agent } : {}),
      });
      if (res.status !== 200) {
        const body = await res.text().catch(() => "");
        throw new Error(`SSE 连接非 200（=${res.status}）url=${url} body=${body.slice(0, 200)}`);
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new Error(`SSE 响应 content-type 异常：${contentType} url=${url}`);
      }

      const parser = createSseParser();
      const sub = {
        frames: [],
        connectStart,
        _firstFrameAt: null,
        _closedAt: null,
        firstFrameLatencyMs() {
          return this._firstFrameAt === null ? null : this._firstFrameAt - this.connectStart;
        },
        lastEventId() {
          return this.frames.length > 0 ? this.frames[this.frames.length - 1].id : null;
        },
        closedAtMs() {
          return this._closedAt === null ? null : this._closedAt - this.connectStart;
        },
        close() {
          ctrl.abort();
        },
      };

      sub.done = (async () => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              sub._closedAt = Date.now();
              return { closed: "server" };
            }
            const now = Date.now();
            const frames = parser.push(dec.decode(value, { stream: true }));
            if (frames.length > 0) {
              if (sub._firstFrameAt === null) sub._firstFrameAt = now;
              for (const f of frames) sub.frames.push({ ...f, arrival: now });
            }
          }
        } catch (err) {
          sub._closedAt = Date.now();
          if (ctrl.signal.aborted) return { closed: "client" };
          return { closed: "error", error: err };
        }
      })();

      return sub;
    },
  };
}

// ---------- IO 缝：1s 轮询对照客户端 ----------

/**
 * 轮询对照客户端：每 intervalMs 发一次 GET（读 M2 audit 读口），记账
 *   ①RTT 分布 ②新行可见延迟（行 createdAt（agent/M2 钟）→ 首次出现在轮询响应的时刻）
 *   ③终态行（run update 到 completed/failed）可见延迟 ④请求/错误计数。
 * stop() 停轮并回聚合。rowId 用 audit 行 id 去重（同轮重复轮询不重复记可见延迟）。
 */
export function runPoller({ url, intervalMs = 1000, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const state = {
    stopped: false,
    requests: 0,
    errors: 0,
    rtt: [],
    rowsSeen: [],
    visibility: [],
    terminalSeen: [],
    seen: new Set(),
    _inflight: 0,
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    let nextAt = Date.now();
    while (!state.stopped) {
      const now = Date.now();
      if (now < nextAt) {
        await sleep(Math.min(nextAt - now, 50));
        continue;
      }
      nextAt = now + intervalMs;
      const t0 = Date.now();
      state._inflight += 1;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetchImpl(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const rtt = Date.now() - t0;
        if (!res.ok) {
          state.errors += 1;
        } else {
          const rows = await res.json();
          state.requests += 1;
          state.rtt.push(rtt);
          for (const row of Array.isArray(rows) ? rows : []) {
            if (row?.id === undefined || state.seen.has(row.id)) continue;
            state.seen.add(row.id);
            const visibleAt = Date.now();
            state.rowsSeen.push({ rowId: row.id, createdAt: row.createdAt, visibleAt });
            const vis = visibleAt - row.createdAt;
            if (Number.isFinite(vis)) state.visibility.push(vis);
            const to = row?.details?.status?.to;
            if (row.action === "update" && TERMINAL_RUN_STATES.has(to)) {
              state.terminalSeen.push(vis);
            }
          }
        }
      } catch {
        state.errors += 1;
      } finally {
        state._inflight -= 1;
      }
    }
  })();
  return {
    stop() {
      state.stopped = true;
      return {
        requests: state.requests,
        errors: state.errors,
        rtt: state.rtt,
        rowsSeen: state.rowsSeen,
        visibility: state.visibility,
        terminalSeen: state.terminalSeen,
      };
    },
  };
}

/** docker stats 一次性采样（异步 spawn，不堵事件循环；失败回 [] 由调用方决定口径）。 */
export function sampleDockerStats({ names } = {}) {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) resolve([]);
        else resolve(parseDockerStats(stdout, names));
      },
    );
  });
}

/** 采样循环：每 everyMs 采一次直到 deadline，回 [{t, rows}]。 */
export async function sampleCpuLoop({ names, deadline, everyMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const samples = [];
  while (Date.now() < deadline) {
    const t = Date.now();
    const rows = await sampleDockerStats({ names });
    if (rows.length > 0) samples.push({ t, rows });
    const remain = everyMs - (Date.now() - t);
    await sleep(remain > 0 ? remain : 500);
  }
  return samples;
}
