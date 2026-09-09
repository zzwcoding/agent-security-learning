// 票 38：wazuh-logtest-feed.ts 的测试。R4 口径：scripts 不在模块图内——不 import 脚本，
// 静态断言读源码、行为断言走子进程（replay.test.ts 同款）。
// 真容器冒烟（FR-M1.6 验收①）走能力探测：wazuh-manager 不可达 → 显式 skip 打印原因
// （票 16/17 先例，CI 无容器不装绿）。前置：docker compose --profile real-wazuh up -d
// wazuh-manager（点名服务，不碰默认栈）。
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.js";
import { MemoryM2Client } from "./m2client.js";
import { severityFromLevel } from "./wazuh.js";

const run = promisify(execFile);
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const FEED_TS = fileURLToPath(new URL("../../../scripts/wazuh-logtest-feed.ts", import.meta.url));
const SOC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ALERTS_DIR = `${SOC_ROOT}fixtures/alerts`;
const feedSrc = (): string => readFileSync(FEED_TS, "utf8");
const WAZUH = process.env.WAZUH_SMOKE_URL ?? "https://127.0.0.1:15500";

// ---------- 三条铁律 + FR-M1.6 口径（m1 卡回放载体定案，与 replay.test.ts 同源）----------

test("铁律①：feed 绝不直塞数据库——源码不 import 库件，真回包只 POST webhook 正门", () => {
  const src = feedSrc();
  expect(src).not.toMatch(/better-sqlite3|openDb|case-backend/);
  expect(src).toContain("/api/v1/webhooks/alerts");
});

test("铁律③：喂数脚本不进 compose（回放载体非运行时件；compose 里只有 wazuh-manager 容器）", () => {
  const compose = readFileSync(`${SOC_ROOT}docker-compose.yml`, "utf8");
  expect(compose).not.toMatch(/^\s*wazuh-logtest-feed:/m);
});

test("FR-M1.6 口径：真规则引擎 = PUT /logtest（Basic 换 Bearer JWT），回包原样回推", () => {
  const src = feedSrc();
  expect(src).toContain('"PUT"');
  expect(src).toContain("/logtest");
  expect(src).toContain("/security/user/authenticate");
});

// ---------- fixture → logtest 请求映射（dry-run 零出网，确定性可断言）----------

test("dry-run：event=full_log 原文、log_format=syslog、location 原样，--only 过滤生效", async () => {
  const { stdout } = await run(
    TSX,
    [FEED_TS, "--dry-run", "--dir", ALERTS_DIR, "--only", "ssh-5710"],
    { timeout: 30_000 },
  );
  expect(stdout).toMatch(/dry-run ssh-5710-bad-user\.json/);
  expect(stdout).toContain('"log_format":"syslog"');
  expect(stdout).toContain("/var/log/secure");
  expect(stdout).toContain("Failed none for invalid user oracle");
  expect(stdout).toMatch(/wazuh-feed done: 1 fixtures, 0 pushed, 0 skipped_no_alert, 0 errors/);
});

// ---------- 真 wazuh 容器冒烟（能力探测；容器不可达显式 skip 不装绿）----------

async function wazuhProbe(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    // 401 = API 活着但没带凭证——正是「容器可服务」的信号；连不上才 skip
    const req = httpsRequest(
      {
        hostname: "127.0.0.1", port: 15500, path: "/security/user/authenticate",
        method: "POST", rejectUnauthorized: false, timeout: 3000,
      },
      (r) => {
        r.resume();
        resolve(r.statusCode === 401
          ? { ok: true }
          : { ok: false, reason: `wazuh API 回 ${r.statusCode}（预期 401），探针口径失效` });
      },
    );
    req.on("error", () => resolve({
      ok: false,
      reason: `wazuh-manager 不可达（${WAZUH}）——真容器冒烟 skip（显式留痕，不装绿）。` +
        "要跑：docker compose --profile real-wazuh up -d wazuh-manager 后重跑本文件",
    }));
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
    req.end();
  });
}

const probe = await wazuhProbe();
if (!probe.ok) console.warn(`[票 38 真容器冒烟 skip] ${probe.reason}`);

describe.skipIf(!probe.ok)("真 wazuh 容器冒烟（FR-M1.6：logtest 真回包灌 webhook 正门）", () => {
  test("全目录喂真引擎：真回包回推 webhook 201，ingest 映射真实 rule/level，正门零直塞", async () => {
    const m2 = new MemoryM2Client();
    const app = buildApp({ m2 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;

    const { stdout } = await run(
      TSX,
      [FEED_TS, "--wazuh", WAZUH, "--ingest", `http://127.0.0.1:${port}`, "--dir", ALERTS_DIR],
      { timeout: 120_000 },
    );
    const total = readdirSync(ALERTS_DIR).filter((f) => f.endsWith(".json")).length;

    const summary = stdout.match(
      /wazuh-feed done: (\d+) fixtures, (\d+) pushed, (\d+) skipped_no_alert, (\d+) errors/,
    );
    expect(summary, "CLI 汇总行存在").toBeTruthy();
    expect(Number(summary![1]), "处理条数 = 目录 json 数").toBe(total);
    expect(Number(summary![4]), "零错误").toBe(0);
    const pushed = Number(summary![2]);
    expect(pushed, "真引擎至少命中 ssh 家族规则（手造 fixture 的其余部分允许被真引擎判不出告警）")
      .toBeGreaterThanOrEqual(2);

    // 真规则引擎命中行的形态：rule=<sshd 家族> level=<数字> -> webhook 201。
    // 5712 暴力破解要同会话 8+ 次才升档，单条喂入真引擎给 5710/5711——断言家族不钉死 id
    const sshHit = stdout.match(/rule=(5710|5711|5712) level=(\d+) -> webhook 201 alert_id=\S+/);
    expect(sshHit, "至少一条真实 sshd 规则命中并从正门 201 进来").toBeTruthy();

    // 正门映射核对：真实告警在 ingest 侧被正常翻译（level → severity 沿用 PRD §5.1 映射表）
    expect(m2.calls).toHaveLength(pushed);
    const ssh = m2.calls.find((c) => /sshd|brute|non-existent|authentication/i.test(c.title));
    expect(ssh, "真实 sshd 告警进映射").toBeTruthy();
    expect(ssh!.source.startsWith("wazuh:")).toBe(true);
    expect(ssh!.sourceRef).toBeTruthy();
    expect(ssh!.severity).toBe(severityFromLevel(Number(sshHit![2])));
    await app.close();
    // 真 HTTP 往返 ×12（login + 12 次 logtest + webhook）超过 vitest 默认 5s/例——
    // 显式放宽到与 execFile 同一闸（120s），否则真容器冒烟必超时假红。
  }, 120_000);
});
