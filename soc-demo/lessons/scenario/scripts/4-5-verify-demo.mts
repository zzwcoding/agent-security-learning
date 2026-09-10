// 场景 4 步 4.5 教具：验票闸 verifyTicket 的七种裁决逐个实弹（六拒因 + allow），
// 外加跨进程焚毁读口（M2 used_tokens）的重放实测。
//
// 运行（栈起着时全量；M2 不可达时 S7 自动降级说明）：
//   cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/4-5-verify-demo.mts [已焚毁的 jti]
//   [jti] 可选：给出一个真在 M2 used_tokens 坟场里的 jti（如 4.4 批准主角卡烧掉的
//   ap_4a9d6e0d-…），S7 就会拿着"本地自签的同 jti 票"去问真 M2 读口——
//   焚毁真相按 jti 对账，不认签名（教具的教具）。
//
// 七幕：
//   S0  allow            —— 票真、工具对、参数对、没焚毁、没过期
//   S1  signature_invalid —— 签名被改一个 hex 位（fail-closed 大桶：一切验不过都归它）
//   S2  token_expired     —— 300 秒保质期已过（JWT 语义：now >= exp 即拒）
//   S3  token_used        —— 进程内焚毁表说已烧（INV-2 重放防线）
//   S4  params_mismatch   —— 批的是 app-01，执行时想换 db-01（批什么执行什么）
//   S5  scope_insufficient —— 拿 block_ip 的票去调 isolate_host（票只对铸造时的工具）
//   S6  require_approval / no_ticket —— 手里没票硬闯 L2 / L1
//   S7  跨进程重放实测    —— 本地铸造同 jti 的票，问真 M2 used_tokens 读口（票 34 装填语义）
import { createHash, createHmac } from "node:crypto";
import { verifyTicket, paramsHash, type BurnRegistry } from "../../../services/agent/src/verify-ticket.js";

// 密钥口径与栈一致：env 优先，缺省读 soc-demo/.env 的 SOC_HMAC_KEY 行
import { readFileSync } from "node:fs";
function loadKey(): string {
  if (process.env.SOC_HMAC_KEY) return process.env.SOC_HMAC_KEY;
  const envFile = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
  const line = envFile.split("\n").find((l) => l.startsWith("SOC_HMAC_KEY="));
  if (!line) throw new Error("SOC_HMAC_KEY 未找到（env 与 soc-demo/.env 都没有）");
  return line.slice("SOC_HMAC_KEY=".length).trim();
}
const KEY = Buffer.from(loadKey(), "utf8");

function head(title: string): void {
  console.log(`\n━━━ ${title} ━━━`);
}
const show = (r: ReturnType<typeof verifyTicket>): void => {
  if (r.allow) console.log(`→ allow=true  (${r.reason})`);
  else console.log(`→ 403 ${r.reason}`);
};

// ---- 本地铸造器：与 gateway mint.py 同票型同序列化（教学对位，不是第二真相源）----
// py json.dumps 默认分隔符是 (", ", ": ")——这里手工拼保证逐字节同形（冒号带空格）。
// 注意不能对整串 JSON 做逗号/冒号正则替换：params_hash 值里的 "sha256:…" 会被误伤。
const HEADER = Buffer.from('{"alg": "HS256", "typ": "JWT"}', "utf8").toString("base64url");
function pyJsonify(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => {
    let val: string;
    if (typeof v === "string") val = JSON.stringify(v);
    else if (Array.isArray(v)) val = JSON.stringify(v).replace(/,/g, ", "); // scope 词表无逗号，教具口径
    else val = String(v);
    return `${JSON.stringify(k)}: ${val}`;
  });
  return `{${parts.join(", ")}}`;
}
function seal(payload: Record<string, unknown>): string {
  const b64p = Buffer.from(pyJsonify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", KEY).update(`${HEADER}.${b64p}`, "utf8").digest("hex");
  return `${HEADER}.${b64p}.${sig}`;
}
function mintApproval(over: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  return seal({
    jti: `ap_${crypto.randomUUID().slice(0, 8)}`,
    approval_id: "apr_demo",
    approved_by: "duty_lead",
    tool: "isolate_host",
    params_hash: paramsHash({ host: "app-01" }),
    case_id: "case_000002",
    iat: now,
    exp: now + 300,
    used: false,
    ...over,
  });
}
const emptyBurn: BurnRegistry = { has: () => false };
const opts = { hmacKey: loadKey() };

// ---------- S0 allow ----------
head("S0 · allow：票真、工具对、参数对、未焚毁、未过期");
const good = mintApproval({});
show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } },
  { approvalToken: good, caseId: "case_000002", used: emptyBurn }, Math.floor(Date.now() / 1000), opts));

// ---------- S1 signature_invalid ----------
head("S1 · signature_invalid：签名改一个 hex 位（验签在解析之前，fail-closed 大桶）");
const parts = good.split(".");
const tamperedSig = parts[2]!.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } },
  { approvalToken: `${parts[0]}.${parts[1]}.${tamperedSig}`, caseId: "case_000002", used: emptyBurn },
  Math.floor(Date.now() / 1000), opts));

// ---------- S2 token_expired ----------
head("S2 · token_expired：保质期 300 秒已过（JWT 语义 now >= exp 即拒）");
const stale = mintApproval({ iat: Math.floor(Date.now() / 1000) - 400, exp: Math.floor(Date.now() / 1000) - 100 });
show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } },
  { approvalToken: stale, caseId: "case_000002", used: emptyBurn }, Math.floor(Date.now() / 1000), opts));

// ---------- S3 token_used（进程内）----------
head("S3 · token_used：进程内焚毁表说已烧（INV-2：重放必 403）");
show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } },
  { approvalToken: good, caseId: "case_000002", used: { has: (j) => j === JSON.parse(Buffer.from(good.split(".")[1]!, "base64url").toString()).jti } },
  Math.floor(Date.now() / 1000), opts));

// ---------- S4 params_mismatch ----------
head("S4 · params_mismatch：批的是 app-01，执行时想换 db-01（批什么执行什么）");
show(verifyTicket({ name: "isolate_host", params: { host: "db-01" } },
  { approvalToken: good, caseId: "case_000002", used: emptyBurn }, Math.floor(Date.now() / 1000), opts));

// ---------- S5 scope_insufficient（票错工具）----------
head("S5 · scope_insufficient：拿 block_ip 的票去调 isolate_host（票只对铸造时的工具）");
const blockTicket = mintApproval({ tool: "block_ip", params_hash: paramsHash({ ip: "198.51.100.23" }) });
show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } },
  { approvalToken: blockTicket, caseId: "case_000002", used: emptyBurn }, Math.floor(Date.now() / 1000), opts));

// ---------- S6 require_approval / no_ticket（手里没票）----------
head("S6 · 手里没票硬闯：L2 → require_approval；L1 → no_ticket（登记表分级说话）");
show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } }, {}, Math.floor(Date.now() / 1000), opts));
show(verifyTicket({ name: "add_timeline_entry", params: {} }, {}, Math.floor(Date.now() / 1000), opts));

// ---------- S7 跨进程重放实测（真 M2 used_tokens 读口，票 34 装填语义）----------
head("S7 · 跨进程重放实测：本地自签同 jti 的票，问真 M2 used_tokens 读口");
const burnedJti = process.argv[2];
if (!burnedJti) {
  console.log("→ 未提供已焚毁 jti，本幕跳过。用法：tsx 4-5-verify-demo.mts <已焚毁的jti>");
  console.log("  （4.4 批准主角卡时烧掉的那枚：agent 库 used_tokens 表里挑一个 ap_ 开头的 jti）");
} else {
  const replay = mintApproval({ jti: burnedJti });
  // 票 34 的装填语义（graph.ts resolveUsed）：读口 200=已焚 / 404=未焚 / 其他与网络错=抛错。
  // 查询在进闸【前】完成；失败折成"哑读口"，闸内 has() 抛异常 → verifyTicket 整体收进
  // signature_invalid（INV-1：查不到真相 ≠ 真相是没有，拒绝执行而不是放行）。
  let burned: boolean | null = null;
  let readFailure: unknown = null;
  try {
    const res = await fetch(`http://127.0.0.1:3002/internal/used-tokens/${encodeURIComponent(burnedJti)}`);
    burned = res.status === 200 ? true : res.status === 404 ? false : null;
    if (burned === null) readFailure = new Error(`used_tokens 读口 HTTP ${res.status}`);
    else console.log(`M2 GET /internal/used-tokens/${burnedJti.slice(0, 12)}… → HTTP ${res.status} → used=${burned}`);
  } catch (e) {
    readFailure = e;
  }
  const registry: BurnRegistry = readFailure !== null
    ? { has: () => { throw readFailure; } }
    : { has: () => burned === true };
  if (readFailure !== null) console.log(`读口病了（${String(readFailure)}）→ 闸内 has() 将抛异常：`);
  show(verifyTicket({ name: "isolate_host", params: { host: "app-01" } },
    { approvalToken: replay, caseId: "case_000002", used: registry },
    Math.floor(Date.now() / 1000), opts));
  if (readFailure !== null) console.log("→ INV-1：读口病了闸必须病——归 signature_invalid 拒绝，绝不放行");
  if (burned === false) {
    // 对照组：读口说未焚 → 票其余条件全过 → allow（演示"未焚 ≠ 拒"）
    console.log("→ 该 jti 不在坟场：本地票其余条件全过 → 放行（焚毁真相只认 M2）");
  }
}
console.log("\n（完）闸的裁决顺序：签名 → 时效 → 焚毁 → 工具 → 参数 → 案件绑定，fail-closed 短路。");
