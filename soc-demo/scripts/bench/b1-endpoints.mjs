#!/usr/bin/env node
// m13 · B1 单端点微基准（specs/modules.md m13 卡公开接口 1；设计源 2026-09-12-压力测试方案.md §三 B1）。
//
// 用法
//   node b1-endpoints.mjs <ingest-webhook|m2-upsert|gateway-mint|m2-read>   单跑一卡
//   node b1-endpoints.mjs                                                   四卡全跑
//
// 档位（写死在此可调；红线：单机演示量级 connections≤20、duration≤30s）
//   全卡 connections=20 + overallRate 限速——autocannon 开环满速会把本机打挂，限速档
//   才能读出「该速率下的延迟分布」，找拐点归 B2 爬坡。
//   ingest-webhook    conn=20 · amount=5000 · rate=250/s （约 20s）
//   m2-upsert-new     conn=20 · amount=10000 · rate=500/s（约 20s）
//   m2-upsert-dedup   conn=20 · duration=20s · rate=500/s（静态体重复推，量 INV-6 去重支路）
//   gateway-mint      conn=20 · amount=10000 · rate=500/s（约 20s）
//   m2-read           conn=20 · duration=15s · rate=200/s（先播种 300 条再读）
//
// 前置（脚本只预检不代建）
//   docker compose up -d（默认九服务 + fake LLM 零出网），:3001/:3002/:8002 /healthz 全绿；
//   布景纪律（报告方法节同口径）：EVENT_DRIVEN=off 起 agent——B1 是端点微基准，关掉
//   autorun 消费以隔离下游流水线（链路影响归 B2/B3）。EVENT_DRIVEN 无公开读口可查，
//   脚本只能提醒，不硬校验。观察一律走 REST，绝不 rw 模式从宿主开容器在写的 SQLite。
//
// 实现注记（autocannon 编程 API 实测，2026-09-12 v8.0.0）
//   · 逐请求唯一 body 走 requests[].setupRequest（在 Content-Length 计算前调用）——
//     不要用 idReplacement 替换 body 里的 [<id>]：Content-Length 按每 id 27 字节硬编码，
//     本版 hyperid 实产 24 字节，短 3 字节服务端等死（真坑，踩过）。
//   · requests 数组每个连接各自从下标 0 独立迭代——想要全局唯一必须走 setupRequest。
//   · 默认百分位集无 p95；hdr-histogram-percentiles-obj 导出的 percentiles 数组是
//     addPercentiles 的唯一数据源，起压前补插 95 得真 HDR 分位（非插值估算）。
import autocannon from "autocannon";
import hdrPercentiles from "hdr-histogram-percentiles-obj";
import { createHttpClient, waitHealthy } from "./lib/http.mjs";
import { makeAlert, makeMintBody, makeUpsertBody } from "./lib/gen-alert.mjs";
import { machineSpecLine, benchRow, statusStatLine, B1_TABLE_HEADER, machineSpec } from "./lib/report.mjs";

// 真 HDR p95（见文件头注记；幂等：重复跑不重复插）
if (!hdrPercentiles.percentiles.includes(95)) {
  hdrPercentiles.percentiles.push(95);
  hdrPercentiles.percentiles.sort((a, b) => a - b);
}

const INGEST = process.env.BENCH_INGEST_URL ?? "http://127.0.0.1:3001";
const M2 = process.env.BENCH_M2_URL ?? "http://127.0.0.1:3002";
const GATEWAY = process.env.BENCH_GATEWAY_URL ?? "http://127.0.0.1:8002";
const CONN = 20; // 红线上限

const ingest = createHttpClient({ baseUrl: INGEST });
const m2 = createHttpClient({ baseUrl: M2 });
const gateway = createHttpClient({ baseUrl: GATEWAY });

// ---------- 布景预检 ----------

async function preflight({ services, seed = 0, host = "bench-seed" }) {
  for (const [name, client, url] of services) {
    const ok = await waitHealthy(client, { tries: 3, intervalMs: 500 });
    if (!ok) {
      console.error(`[preflight] ${name} (${url}/healthz) 不绿——布景没起好，停下不硬压。`);
      console.error("  布景：docker compose up -d（默认九服务）；建议 EVENT_DRIVEN=off 起 agent（见脚本头注）。");
      process.exit(1);
    }
  }
  if (seed > 0) {
    // 播种走 ingest webhook 正门（CONTEXT 回放铁律：数据绝不直接塞数据库）
    for (let i = 0; i < seed; i++) {
      const r = await ingest("/api/v1/webhooks/alerts", {
        method: "POST",
        body: makeAlert({ host }),
        throwOnError: true,
      });
      if (r.status !== 201) {
        console.error(`[preflight] 播种第 ${i + 1} 条意外状态 ${r.status}——停下。`);
        process.exit(1);
      }
    }
  }
}

// ---------- 压测执行（autocannon 编程 API，框架红线：真 import 真 调用） ----------

/**
 * 跑一轮。uniqueBody 传生成器时走 setupRequest 逐请求造唯一体（防 INV-6 去重吃流量）；
 * 不传则静态体重复推（dedup 卡专用）。
 */
function fire({ url, path, method = "POST", connections = CONN, duration, amount, rate, uniqueBody, staticBody }) {
  return autocannon({
    url,
    connections,
    overallRate: rate,
    ...(amount ? { amount } : { duration }),
    requests: [
      {
        method,
        path,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        ...(uniqueBody
          ? { setupRequest: (req) => ({ ...req, body: JSON.stringify(uniqueBody()) }) }
          : { body: staticBody === undefined ? undefined : JSON.stringify(staticBody) }),
      },
    ],
  });
}

function assertClean(result, label) {
  if (result.errors > 0 || result.non2xx > 0 || result.timeouts > 0) {
    console.error(`[${label}] 出错面非零：errors=${result.errors} non2xx=${result.non2xx} timeouts=${result.timeouts}`);
    console.error(statusStatLine(result));
    process.exitCode = 1; // 数字已打出，但标失败——带错的基准不入报告
  }
}

// ---------- 四张卡 ----------

const CASES = {
  "ingest-webhook": {
    title: "ingest-webhook",
    profile: "conn=20·5000发·250/s",
    repro: "node scripts/bench/b1-endpoints.mjs ingest-webhook",
    async run() {
      await preflight({ services: [["ingest", ingest, INGEST]] });
      const result = await fire({
        url: INGEST,
        path: "/api/v1/webhooks/alerts",
        amount: 5000,
        rate: 250,
        uniqueBody: () => makeAlert({ host: "bench-ingest" }), // sourceRef 全局唯一：量 201 新建支路
      });
      return { name: "ingest-webhook（验型+映射+转发）", result };
    },
  },

  "m2-upsert": {
    title: "m2-upsert",
    async run() {
      await preflight({ services: [["case-backend", m2, M2]] });
      // 支路一：201 新建——sourceRef 唯一，每请求落一次 SQLite 事务（upsert+审计+outbox）
      const fresh = await fire({
        url: M2,
        path: "/api/v1/alerts",
        amount: 10000,
        rate: 500,
        uniqueBody: () => makeUpsertBody({ source: "bench:upsert-new" }),
      });
      // 支路二：200 去重——静态体重复推，同 (source, sourceRef) 走 ON CONFLICT occurrences+1
      const dedup = await fire({
        url: M2,
        path: "/api/v1/alerts",
        duration: 20,
        rate: 500,
        staticBody: makeUpsertBody({ source: "bench:upsert-dedup", sourceRef: "bench-dedup-target" }),
      });
      assertClean(fresh, "m2-upsert-new");
      assertClean(dedup, "m2-upsert-dedup");
      return {
        rows: [
          { name: "m2-upsert（201 新建支路）", profile: "conn=20·10000发·500/s", result: fresh, repro: "node scripts/bench/b1-endpoints.mjs m2-upsert" },
          { name: "m2-upsert（200 去重支路）", profile: "conn=20·20s·500/s", result: dedup, repro: "node scripts/bench/b1-endpoints.mjs m2-upsert" },
        ],
      };
    },
  },

  "gateway-mint": {
    title: "gateway-mint",
    profile: "conn=20·10000发·500/s",
    repro: "node scripts/bench/b1-endpoints.mjs gateway-mint",
    async run() {
      await preflight({ services: [["gateway", gateway, GATEWAY]] });
      // 请求形态照 services/gateway/app.py 真代码：task_ticket 六字段（jti/sub/case_id/
      // run_id/scope/allowed_tools）。mint 无状态 HMAC 签名，不查 run/审批布景——无需前置。
      // jti 唯一只是对齐生产形态（焚毁查重发生在 M2/验票闸，不在此口）。
      const result = await fire({
        url: GATEWAY,
        path: "/internal/mint",
        amount: 10000,
        rate: 500,
        uniqueBody: () => makeMintBody(),
      });
      return { name: "gateway-mint（HMAC 铸票）", result };
    },
  },

  "m2-read": {
    title: "m2-read",
    profile: "conn=20·15s·200/s·播种300",
    repro: "node scripts/bench/b1-endpoints.mjs m2-read",
    async run() {
      // 播种走 ingest 正门（带 agent.name=bench-read 的 hostname observable），
      // 读口用 ?host= 过滤：EXISTS 全表扫 + 定量返回，响应体规模可控
      await preflight({ services: [["ingest", ingest, INGEST], ["case-backend", m2, M2]], seed: 300, host: "bench-read" });
      const result = await fire({
        url: M2,
        path: "/api/v1/alerts?host=bench-read",
        method: "GET",
        duration: 15,
        rate: 200,
      });
      return { name: "m2-read（GET alerts?host=）", result };
    },
  },
};

// ---------- 汇总输出（markdown，直接贴报告） ----------

async function runCase(key) {
  const kase = CASES[key];
  const out = await kase.run();
  const rows = out.rows ?? [{ name: out.name, profile: kase.profile, result: out.result, repro: kase.repro }];
  for (const row of rows) {
    assertClean(row.result, row.name);
  }
  return rows;
}

const spec = machineSpec();
const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const keys = requested.length > 0 ? requested : Object.keys(CASES);
for (const k of keys) {
  if (!CASES[k]) {
    console.error(`未知 case：${k}（可选：${Object.keys(CASES).join(" | ")}）`);
    process.exit(2);
  }
}

console.error(`[bench] 开压：${keys.join(", ")}（提醒：布景应 EVENT_DRIVEN=off 起 agent，B1 隔离下游链路）`);
const allRows = [];
for (const k of keys) {
  allRows.push(...(await runCase(k)));
}

console.log(`### B1 单端点微基准`);
console.log(`> 时间：${spec.timestamp}（本地，只同机比）`);
console.log(machineSpecLine(spec));
console.log("");
console.log(B1_TABLE_HEADER);
for (const row of allRows) console.log(benchRow(row));
console.log("");
for (const row of allRows) console.log(`- ${row.name}：${statusStatLine(row.result)}`);
