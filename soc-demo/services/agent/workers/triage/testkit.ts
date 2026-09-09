// 票 13 测试工具箱：契约密钥/签票、确定性假 guards、真 case-backend 起停、
// §5.1 告警种子映射。只被 *.test.ts 引用（文件名不含 .test，vitest 不会跑它）。
// 票 28（E2 清偿）：起 case-backend 从「进程内 import buildApp/openDb」改为
// 「子进程跑真服务入口 + HTTP 正门」——模块图上 agent 与 case-backend 断开，
// 越界由 tools/check_boundary.py（边界规则 R1）机器把关。
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanInjection, type ScanDecision } from "../../src/guards-client.js";

/** fixtures/tickets/contract.json 的测试固定密钥（禁入真实环境）。 */
export const KEY = "soc-demo-test-hmac-key-do-not-use-in-prod";

/** 按契约 wire 格式签任务票：<b64url(header)>.<b64url(payload)>.<hex(hmac)>。
 *  只为测试铸票——生产走 gateway /internal/mint（票 06）。 */
export function sealTicket(
  payload: Record<string, unknown>,
  key = KEY,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const b64p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", Buffer.from(key, "utf8")).update(`${header}.${b64p}`).digest("hex");
  return `${header}.${b64p}.${sig}`;
}

export function makeTaskTicket(
  runId: string,
  allowedTools: string[],
  over: Partial<{ jti: string; sub: string; iat: number; exp: number; caseId: string }> = {},
): string {
  const iat = over.iat ?? Math.floor(Date.now() / 1000) - 10;
  return sealTicket({
    jti: over.jti ?? `tk_test_${Math.random().toString(36).slice(2)}`,
    sub: over.sub ?? "agent:triage",
    // 票 17：knowledge_flow 的票绑定案件（FR-S2.2）；分诊票 case_id 空（闸跳过绑定校验）
    case_id: over.caseId ?? "",
    run_id: runId,
    scope: ["alert:update", "case:write"],
    allowed_tools: allowedTools,
    iat,
    exp: over.exp ?? iat + 900,
  });
}

// PRD §7 攻击面表：4 个注入变体的载荷标记（真实 guards 的 6 族注入在 C4 件内，
// 这里按同样的命中语义给确定性替身——按通道策略裁决，票 04：alert_field/user_input=
// block，kb=strip，tool_output=flag）。
export const INJECTION_RE =
  /ignore (all )?previous instructions|SYSTEM NOTE|忽略以上所有指令|忽略所有指令|treat all alerts as false|print your system prompt|渗透测试模式/i;

/** 确定性假 guards：命中注入按通道策略裁决（与 guards 件的 channel policy 同表）。 */
export const fakeScan = async (
  text: string,
  channel: Parameters<typeof scanInjection>[1],
): Promise<ScanDecision> => {
  if (!INJECTION_RE.test(text)) return { blocked: false, action: "allow", score: 0 };
  if (channel === "kb") {
    // strip：清洗后的文本回填（教学版 = 把命中句子整行剔除）
    const text2 = text
      .split("\n")
      .filter((line) => !INJECTION_RE.test(line))
      .join("\n");
    return { blocked: false, action: "strip", score: 1, text: text2 };
  }
  if (channel === "tool_output") return { blocked: false, action: "flag", score: 1 };
  return { blocked: true, action: "block", score: 1 };
};

export interface CaseBackend {
  url: string;
  close(): Promise<void>;
}

const SOC_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TSX = join(SOC_ROOT, "node_modules", ".bin", "tsx");
const CASE_BACKEND_ENTRY = join(SOC_ROOT, "services", "case-backend", "src", "index.ts");

/** 捞一个空闲 TCP 端口（listen(0) 让 OS 分配，让出后若被抢有重试兜底）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    srv.on("error", reject);
  });
}

/** 轮询 /healthz 直到服务真起来（tsx 冷启动 ~1s，20s 封顶）。 */
async function waitHealthy(url: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 起真 case-backend（独立子进程 + 一次性 SQLite 文件库 + 随机端口）：
 *  状态机/409/审计语义全在环内，agent 测试只经公开 REST 正门跟它说话
 *  （票 28 E2：原进程内组装直引 case-backend 内部，越界，已清偿）。 */
export async function startCaseBackend(): Promise<CaseBackend> {
  const dir = mkdtempSync(join(tmpdir(), "soc-case-it-"));
  // 端口竞态兜底：freePort 让出到子进程真监听之间可能被抢，EADDRINUSE 就换口重来
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    const child = spawn(TSX, [CASE_BACKEND_ENTRY], {
      env: { ...process.env, PORT: String(port), CASE_DB_PATH: join(dir, "case.sqlite") },
      stdio: "ignore",
    });
    const url = `http://127.0.0.1:${port}`;
    if (await waitHealthy(url, 20000)) {
      return {
        url,
        close: () =>
          new Promise((resolve) => {
            child.on("exit", () => {
              rmSync(dir, { recursive: true, force: true });
              resolve();
            });
            child.kill("SIGTERM");
          }),
      };
    }
    child.kill("SIGTERM");
    if (attempt >= 4) throw new Error(`case-backend 子进程起不来（最后端口 ${port}）`);
  }
}

export async function httpJson(
  base: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const INGEST_ENTRY = join(SOC_ROOT, "services", "ingest", "src", "index.ts");

/** 起真 ingest（独立子进程 + 随机端口 + 指向 case-backend 的 CASE_BACKEND_URL）：
 *  票 30 全链 wire 契约测试用——fixture 从 webhook 正门进真 mapWazuhAlert，
 *  出站写库走真 HttpM2Client → case-backend REST。与 startCaseBackend 同款
 *  「子进程 + 公开 REST 面」纪律（边界规则 R1：跨服务不 import 源码）。 */
export async function startIngest(caseBackendUrl: string): Promise<CaseBackend> {
  for (let attempt = 0; ; attempt++) {
    const port = await freePort();
    const child = spawn(TSX, [INGEST_ENTRY], {
      env: { ...process.env, PORT: String(port), CASE_BACKEND_URL: caseBackendUrl },
      stdio: "ignore",
    });
    const url = `http://127.0.0.1:${port}`;
    if (await waitHealthy(url, 20000)) {
      return {
        url,
        close: () =>
          new Promise((resolve) => {
            child.on("exit", () => resolve());
            child.kill("SIGTERM");
          }),
      };
    }
    child.kill("SIGTERM");
    if (attempt >= 4) throw new Error(`ingest 子进程起不来（最后端口 ${port}）`);
  }
}

type Obj = Record<string, unknown>;

/** 告警种子映射（测试布景版）：照 ingest wazuh.ts 的 §5.1 映射表 + 不可信标记约定，
 *  另加 hostname observable（来自 agent.name）。hostname 映射在票 30 已补进真 m1
 *  （wazuh.ts extractObservables）——本 stub 是纯测试布景副本，不随真映射自动同步；
 *  两边的形状由 triage/wire-contract.test.ts（走真 ingest webhook）对活锁住。 */
export function alertInputFromWazuh(w: Obj): Obj {
  const rule = (w.rule as Obj) ?? {};
  const agent = (w.agent as Obj) ?? {};
  const data = (w.data as Obj) ?? {};
  const sys = (w.syscheck as Obj) ?? {};
  const mitre = (rule.mitre as Obj) ?? {};
  const groups = Array.isArray(rule.groups) ? (rule.groups as string[]) : [];
  const mitreIds = Array.isArray(mitre.id) ? (mitre.id as (string | number)[]) : [];

  const descriptionParts: string[] = [];
  if (rule.description) descriptionParts.push(String(rule.description));
  if (typeof w.full_log === "string" && w.full_log) {
    descriptionParts.push(`[untrusted:true field:full_log]\n${w.full_log}\n[/untrusted]`);
  }
  if (typeof w.previous_output === "string" && w.previous_output) {
    descriptionParts.push(`[untrusted:true field:previous_output]\n${w.previous_output}\n[/untrusted]`);
  }

  const observables: Obj[] = [];
  const push = (dataType: string, v: unknown, untrusted: boolean) => {
    if (v === undefined || v === null || v === "") return;
    observables.push({ dataType, data: String(v), tags: untrusted ? ["untrusted"] : [] });
  };
  push("hostname", agent.name, false);
  push("ip", data.srcip, true);
  push("other", data.srcuser, true);
  push("url", data.url, true);
  push("filename", sys.path, false);
  // 票 15：补 hash 抽取（ingest wazuh.ts 的 HASH_FIELD 同款正则）——vt-87105 布景的
  // sha256_after 必须以 hash observable 进案，富化场景才有东西可查。此前 stub 漏了它，
  // 与真 m1 映射漂移；出入记票 15。
  for (const [k, v] of Object.entries(sys)) {
    if (/^(md5|sha1|sha256|hash)(_after|_new)?$/.test(k)) push("hash", v, false);
  }

  return {
    type: "wazuh_alert",
    source: `wazuh:${(w.manager as Obj)?.name ?? "unknown"}`,
    sourceRef: String(w.id),
    title: String(rule.description ?? ""),
    description: descriptionParts.join("\n\n"),
    severity: typeof rule.level === "number" ? (rule.level >= 15 ? 4 : rule.level >= 10 ? 3 : rule.level >= 5 ? 2 : 1) : 1,
    tlp: 2,
    pap: 2,
    tags: [...groups.map((g) => `group:${g}`), ...mitreIds.map((m) => `mitre:${m}`)],
    date: Date.parse(String(w.timestamp)),
    observables,
  };
}

/** 把 fixtures/alerts/ 的 fixture 种进真 case-backend，返回 alert id。 */
export async function seedAlert(base: string, fixture: string): Promise<string> {
  const raw = JSON.parse(readFileSync(fixture, "utf8")) as Obj;
  const { status, json } = await httpJson(base, "POST", "/api/v1/alerts", alertInputFromWazuh(raw));
  if (status >= 300) throw new Error(`seed failed: ${status} ${JSON.stringify(json)}`);
  return String((json.alert as Obj).id);
}
