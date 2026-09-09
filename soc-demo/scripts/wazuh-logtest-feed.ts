// 票 38：Wazuh 真实模式喂数（PRD FR-M1.6 / 决策 #4，compose profile real-wazuh）。
// 与 replay.ts 的关系（回放布景两种来源）：replay 推手造 fixture（教学口径 full_log）；
// 本脚本把 fixture 的 full_log 喂进真 Wazuh manager 的 logtest（PUT /logtest，真规则
// 引擎），取回**真回包**（真实 rule/decoder/full_log 输出）原样回推 ingest webhook。
// 回放载体三条铁律（m1 卡定案，与 replay.ts 同源，机器断言在 ingest logtest-feed.test.ts）：
//   ① 数据绝不直接塞数据库——真回包只 POST webhook 正门；
//   ② 推模式——跑一次推一遍，不搞定时轮询；
//   ③ 不进 compose——非运行时件（compose 里只有 wazuh-manager 容器，永远没有本脚本）。
// 前置：docker compose --profile real-wazuh up -d wazuh-manager（点名服务，不碰默认栈）
// 用法：pnpm wazuh:feed [--wazuh https://127.0.0.1:15500] [--ingest http://127.0.0.1:3001]
//                     [--dir fixtures/alerts] [--only <文件名含此串>] [--dry-run]
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface FeedOptions {
  wazuh: string; // Wazuh manager API（https + 自签证书，compose 映射宿主 15500）
  ingest: string; // webhook 正门
  dir: string; // fixture 目录
  only?: string; // 只喂文件名含此串的 fixture
  dryRun: boolean; // 只打印将发的 logtest 请求，零出网
  user: string; // API 账号（与 compose API_USERNAME 同源的教学假值）
  pass: string;
}

export function parseArgs(argv: string[]): FeedOptions {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    wazuh: get("--wazuh", "https://127.0.0.1:15500"),
    ingest: get("--ingest", "http://127.0.0.1:3001"),
    dir: resolve(get("--dir", fileURLToPath(new URL("../fixtures/alerts", import.meta.url)))),
    only: argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined,
    dryRun: argv.includes("--dry-run"),
    user: process.env.WAZUH_API_USERNAME ?? "wazuh-wui",
    pass: process.env.WAZUH_API_PASSWORD ?? "MyS3cr37P450r.*-",
  };
}

// fixture → logtest 请求（LogtestRequest：event/log_format/location 三必填）。
// 我们的 fixture 都是单行文本日志 → log_format 恒 syslog；location 原样透传
// （真引擎按 location 选解码上下文），event 就是 full_log 原文——让真规则引擎重新判。
export function toLogtestRequest(fixture: Record<string, unknown>): {
  event: string;
  log_format: string;
  location: string;
} {
  return {
    event: String(fixture.full_log ?? ""),
    log_format: "syslog",
    location: String(fixture.location ?? "master->/var/log/syslog"),
  };
}

// Wazuh manager API 是 https + 自签证书 → 走 node:https 关掉证书校验（本地教学容器）；
// 这是脚本里唯一不用 fetch 的出站（fetch 关不掉自签校验且不引 undici 重件）。
function callApi(
  base: string,
  method: "POST" | "PUT",
  path: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const url = new URL(path, base);
  const mod = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((res, rej) => {
    const req = mod(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { "content-type": "application/json", ...headers },
        rejectUnauthorized: false,
        timeout: 15_000,
      },
      (r) => {
        let text = "";
        r.on("data", (c: Buffer) => (text += c));
        r.on("end", () => res({ status: r.statusCode ?? 0, text }));
      },
    );
    req.on("error", rej);
    req.on("timeout", () => req.destroy(new Error(`timeout ${base}${path}`)));
    req.end(body);
  });
}

// 登录取 JWT（POST /security/user/authenticate，Basic 认证）——之后每发 PUT /logtest 带 Bearer
export async function login(base: string, user: string, pass: string): Promise<string> {
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const { status, text } = await callApi(base, "POST", "/security/user/authenticate", "", {
    authorization: auth,
  });
  const json = JSON.parse(text) as { token?: string; data?: { token?: string } };
  const token = json.data?.token ?? json.token;
  if (status !== 200 || !token) throw new Error(`wazuh login ${status}: ${text.slice(0, 200)}`);
  return token;
}

export interface LogtestResult {
  alert: boolean; // 引擎判这条日志会不会真出告警（rule.level 低于阈值 = false）
  output?: { rule?: { id?: string | number; level?: number }; [k: string]: unknown };
}

export async function runLogtest(
  base: string,
  token: string,
  req: { event: string; log_format: string; location: string },
): Promise<LogtestResult> {
  const { status, text } = await callApi(base, "PUT", "/logtest", JSON.stringify(req), {
    authorization: `Bearer ${token}`,
  });
  if (status !== 200) throw new Error(`logtest ${status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text) as { data?: { alert?: boolean; output?: LogtestResult["output"] } };
  return { alert: json.data?.alert === true, output: json.data?.output };
}

// 真回包才有资格回推：引擎说会出告警（alert=true）且给出了 rule.id
export function isRealAlert(res: LogtestResult): boolean {
  return res.alert === true && res.output?.rule?.id !== undefined && res.output.rule.id !== null;
}

export interface FeedRecord {
  file: string;
  kind: "pushed" | "skipped" | "dry-run" | "error";
  rule?: string | number;
  level?: number;
  status?: number;
  alertId?: string;
  dedup?: boolean;
  note?: string;
}

export async function feed(opts: FeedOptions): Promise<FeedRecord[]> {
  const files = readdirSync(opts.dir)
    .filter((f) => f.endsWith(".json") && (!opts.only || f.includes(opts.only)))
    .sort();
  const out: FeedRecord[] = [];
  let token: string | null = null;
  for (const f of files) {
    let fixture: Record<string, unknown>;
    try {
      fixture = JSON.parse(readFileSync(join(opts.dir, f), "utf8"));
    } catch (e) {
      out.push({ file: f, kind: "error", note: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const req = toLogtestRequest(fixture);
    if (opts.dryRun) {
      console.log(`  dry-run ${f} -> PUT /logtest ${JSON.stringify(req)}`);
      out.push({ file: f, kind: "dry-run" });
      continue;
    }
    try {
      token ??= await login(opts.wazuh, opts.user, opts.pass);
      const res = await runLogtest(opts.wazuh, token, req);
      if (!isRealAlert(res)) {
        const rule = res.output?.rule?.id;
        console.log(`  ${f} -> rule=${String(rule ?? "-")} alert=false -> skipped（引擎不出告警）`);
        out.push({ file: f, kind: "skipped", rule });
        continue;
      }
      // 真回包原样回推正门（data.output 就是 Wazuh 会写进 alerts.json 的告警 JSON）
      const wres = await fetch(`${opts.ingest}/api/v1/webhooks/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(res.output),
      });
      const body = (await wres.json().catch(() => null)) as { alert_id?: string; dedup?: boolean } | null;
      const rule = res.output?.rule?.id;
      const level = res.output?.rule?.level;
      console.log(
        `  ${f} -> rule=${String(rule)} level=${String(level)} -> webhook ${wres.status}` +
          `${body?.alert_id ? ` alert_id=${body.alert_id}` : ""}${body?.dedup ? " dedup" : ""}`,
      );
      out.push({
        file: f, kind: "pushed", rule, level, status: wres.status,
        alertId: body?.alert_id, dedup: body?.dedup === true,
      });
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      console.log(`  ${f} -> ERROR ${note}`);
      out.push({ file: f, kind: "error", note });
    }
  }
  return out;
}

// 只在直接执行时进 main（被测试 import 时不动）；pnpm wazuh:feed 从仓库根调用
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `wazuh-feed: ${opts.dir}${opts.only ? ` (only *${opts.only}*)` : ""} -> logtest ${opts.wazuh}` +
      `${opts.dryRun ? " [dry-run]" : ` -> webhook ${opts.ingest}`}`,
  );
  const records = await feed(opts);
  const pushed = records.filter((r) => r.kind === "pushed").length;
  const skipped = records.filter((r) => r.kind === "skipped").length;
  const errors = records.filter((r) => r.kind === "error").length;
  console.log(
    `wazuh-feed done: ${records.length} fixtures, ${pushed} pushed, ${skipped} skipped_no_alert, ${errors} errors`,
  );
}
