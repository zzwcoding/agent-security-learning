// 回放载体（CONTEXT.md「回放」；m1 卡 2026-09-04 定案的三条铁律）：
//   ① 数据绝不直接塞数据库——只 POST webhook 正门，否则 M1 的去重/映射/不可信标记演了空城计；
//   ② 推模式——跑一次推一遍，不搞定时轮询；
//   ③ 不进 compose——非运行时件，docker-compose.yml 里永远没有它。
// 本脚本扮演外部 Wazuh：读 fixtures/alerts/ 按速率把告警 POST 进 ingest。
// 用法：pnpm replay [--url http://127.0.0.1:3001] [--dir fixtures/alerts] [--rate 5]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ReplayOptions {
  url: string;
  dir: string;
  rate: number; // 每秒推几条
}

export interface ReplayRecord {
  file: string;
  status: number;
  alertId?: string;
  dedup?: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ReplayOptions {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    url: get("--url", "http://127.0.0.1:3001"),
    dir: resolve(get("--dir", fileURLToPath(new URL("../fixtures/alerts", import.meta.url)))),
    rate: Number(get("--rate", "5")),
  };
}

export async function replayOne(url: string, file: string, payload: string): Promise<ReplayRecord> {
  try {
    const res = await fetch(`${url}/api/v1/webhooks/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const body = (await res.json().catch(() => null)) as
      | { alert_id?: string; dedup?: boolean }
      | null;
    return {
      file,
      status: res.status,
      alertId: body?.alert_id,
      dedup: body?.dedup === true,
    };
  } catch (e) {
    return { file, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function replay(opts: ReplayOptions): Promise<ReplayRecord[]> {
  const files = readdirSync(opts.dir).filter((f) => f.endsWith(".json")).sort();
  const gapMs = Math.max(0, Math.round(1000 / Math.max(opts.rate, 1)));
  const out: ReplayRecord[] = [];
  for (const f of files) {
    if (out.length > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    out.push(await replayOne(opts.url, f, readFileSync(join(opts.dir, f), "utf8")));
  }
  return out;
}

// 只在直接执行时进 main（被测试 import 时不动）；pnpm replay 从仓库根调用
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`replay: ${opts.dir}/*.json -> ${opts.url} @ ${opts.rate}/s`);
  const records = await replay(opts);
  let created = 0;
  let deduped = 0;
  for (const r of records) {
    if (r.dedup) deduped += 1;
    else if (r.status === 201) created += 1;
    const note = r.error ? ` ERROR ${r.error}` : r.dedup ? " dedup" : "";
    console.log(`  ${r.file} -> ${r.status}${r.alertId ? ` alert_id=${r.alertId}` : ""}${note}`);
  }
  console.log(`replay done: ${records.length} pushed, ${created} created, ${deduped} dedup`);
}
