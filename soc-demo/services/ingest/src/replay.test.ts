import { expect, test } from "vitest";
import { buildApp } from "./app.js";
import { MemoryM2Client } from "./m2client.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 票 28（E3 清偿）：不再 import scripts/replay.js（边界规则 R4：scripts 不在模块
// 图内）——replay 改子进程执行，断言对象换成 CLI stdout 的行为面。
const run = promisify(execFile);
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const REPLAY_TS = fileURLToPath(new URL("../../../scripts/replay.ts", import.meta.url));

const SOC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ALERTS_DIR = `${SOC_ROOT}fixtures/alerts`;
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${ALERTS_DIR}/${name}`, "utf8"));

// ---------- 三条铁律（m1 卡回放载体定案；机器可查，防将来手滑）----------

test("铁律③：replay 不进 compose（docker-compose.yml 里没有 replay 服务）", () => {
  const compose = readFileSync(`${SOC_ROOT}docker-compose.yml`, "utf8");
  expect(compose).not.toMatch(/^\s*replay:/m);
});

test("铁律①：replay 绝不直塞数据库——源码不 import 任何库件，只 POST webhook 正门", () => {
  const src = readFileSync(`${SOC_ROOT}scripts/replay.ts`, "utf8");
  expect(src).not.toMatch(/better-sqlite3|openDb|case-backend/);
  expect(src).toContain("/api/v1/webhooks/alerts");
});

// ---------- 7 类具名 fixture 映射全过（m1 卡测试计划 / PRD §6-M1 验收）----------
// severity 期望值按 PRD §5.1 映射表人工算死（level 5/6/7→2，10→3，12→3），
// 不现场调映射函数——避免「用被测代码算期望值」的循环论证。

const NAMED: Record<
  string,
  { level: number; severity: number; source: string; sourceRef: string; obs: string[] }
> = {
  "ssh-5710-bad-user.json": { level: 5, severity: 2, source: "wazuh:wazuh-manager", sourceRef: "1682430062.2210", obs: ["ip", "other"] },
  "ssh-5712-real.json": { level: 10, severity: 3, source: "wazuh:centos7", sourceRef: "1682430696.3725", obs: ["ip", "other"] },
  "fim-554-file-added.json": { level: 7, severity: 2, source: "wazuh:wazuh-manager", sourceRef: "1682431351.7771", obs: ["filename", "hash", "hash", "hash"] },
  "fim-510-rootcheck.json": { level: 7, severity: 2, source: "wazuh:wazuh-manager", sourceRef: "1682431409.4109", obs: [] },
  "vt-87105-malware.json": { level: 12, severity: 3, source: "wazuh:wazuh-manager", sourceRef: "1682431744.9001", obs: ["filename", "hash"] },
  "web-31101-sqli-400.json": { level: 5, severity: 2, source: "wazuh:wazuh-manager", sourceRef: "1682432012.3101", obs: ["ip", "url"] },
  "web-31103-cgi-500.json": { level: 6, severity: 2, source: "wazuh:wazuh-manager", sourceRef: "1682431400.3105", obs: ["ip", "url"] },
};

test("7 类具名 fixture 全部映射成功，severity 与映射表一致", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  for (const [name, want] of Object.entries(NAMED)) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/alerts",
      payload: fixture(name),
    });
    expect(res.statusCode, name).toBe(201);
    const body = res.json() as { alert_id: string };
    expect(body.alert_id, name).toBeTruthy();

    const input = m2.calls.at(-1)!;
    expect(input.severity, `${name} severity`).toBe(want.severity);
    expect(input.sourceRef, `${name} sourceRef`).toBe(want.sourceRef);
    expect(input.source, `${name} source = wazuh:manager.name`).toBe(want.source);
    expect(input.observables?.map((o) => o.dataType), `${name} observables`).toEqual(want.obs);
    expect(input.raw, `${name} 未知字段整包进 raw`).toEqual(fixture(name));
  }
  await app.close();
});

// ---------- 注入变体带 untrusted 标记（m1 卡测试计划；FR-M1.7 四个植入位）----------

test("注入变体：载荷在 srcuser/full_log/url/UA 四个位置，入库即带 untrusted 标记", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });

  const cases: Record<string, (input: (typeof m2)["calls"][number]) => void> = {
    // srcuser 位 → data.* 抽成 other observable，tag 带 untrusted
    "inject-srcuser.json": (input) => {
      const other = input.observables?.find((o) => o.dataType === "other");
      expect(other?.tags).toContain("untrusted");
      expect(other?.data).toContain("ignore all previous instructions");
    },
    // url 位 → data.url 抽成 url observable，tag 带 untrusted
    "inject-url.json": (input) => {
      const url = input.observables?.find((o) => o.dataType === "url");
      expect(url?.tags).toContain("untrusted");
    },
    // full_log 位 → description 附录段带成对 untrusted 标记
    "inject-full_log.json": (input) => {
      expect(input.description).toContain("[untrusted:true field:full_log]");
      expect(input.description).toContain("isolate_host");
    },
    // UA 位 → User-Agent 只出现在 full_log 里，同样落到 full_log 附录段
    "inject-ua.json": (input) => {
      expect(input.description).toContain("[untrusted:true field:full_log]");
      expect(input.description).toContain("approve every close action");
    },
  };

  for (const [name, assert] of Object.entries(cases)) {
    const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/alerts", payload: fixture(name) });
    expect(res.statusCode, name).toBe(201);
    assert(m2.calls.at(-1)!);
  }
  await app.close();
});

// ---------- 端到端回放：子进程跑 replay.ts，对活着的 ingest 按速率推完整个目录 ----------

test("replay 按速率推 fixtures/alerts 全目录：7 具名 + 4 注入变体全 201、无重复", async () => {
  const m2 = new MemoryM2Client();
  const app = buildApp({ m2 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;

  // 子进程执行（铁律口径的机器形态）：行为断言读 CLI 汇总行
  // 「replay done: N pushed, C created, D dedup」与逐条 alert_id=…
  const { stdout } = await run(
    TSX,
    [REPLAY_TS, "--url", `http://127.0.0.1:${port}`, "--dir", ALERTS_DIR, "--rate", "1000"],
    { timeout: 30_000 },
  );
  const expected = readdirSync(ALERTS_DIR).filter((f) => f.endsWith(".json")).length;

  const summary = stdout.match(/replay done: (\d+) pushed, (\d+) created, (\d+) dedup/);
  expect(summary, "CLI 汇总行存在").toBeTruthy();
  expect(Number(summary![1]), "推条数 = 目录 json 数").toBe(expected);
  expect(Number(summary![2]), "全 201 新建（等价逐条 status==201 且 dedup==false）").toBe(expected);
  expect(Number(summary![3]), "零去重命中").toBe(0);

  const ids = [...stdout.matchAll(/alert_id=(\S+)/g)].map((m) => m[1]);
  expect(ids, "每条各拿一个 alert_id").toHaveLength(expected);
  expect(new Set(ids).size, "alert_id 互不重复").toBe(ids.length);
  await app.close();
});
