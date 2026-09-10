// 场景 7 步 7.3 教具：新工具 list_approvals 在「run 形态」里的过闸与拒绝。
// 六幕：无票闯闸 → 真网关铸票 → 持票过闸执行（真 handler 查真台账）→ 大小写戏法 →
// 摘行对照（闸认票不认表）→ 票面不含它（三态辨析收尾）。
// 需要栈起着（gateway :8002 铸票）；密钥读 env → soc-demo/.env。
// 运行：
//   cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/7-3-gate-demo.mts
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resetToolsManifestCache, tierOf } from "../../../services/agent/src/tools-manifest.js";
import { verifyTicket } from "../../../services/agent/src/verify-ticket.js";
import { makeGatedCall, type GateDenyInfo } from "../../../services/agent/src/gated-call.js";
import { list_approvals } from "../../../services/agent/src/list_approvals.js";

const REAL_MANIFEST = fileURLToPath(new URL("../../../fixtures/tools.manifest.json", import.meta.url));
const CASE_ID = "case_000001";
const RUN_ID = "run_s7_demo_" + randomUUID().slice(0, 8);

function loadKey(): string {
  if (process.env.SOC_HMAC_KEY) return process.env.SOC_HMAC_KEY;
  const envFile = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
  const line = envFile.split("\n").find((l) => l.startsWith("SOC_HMAC_KEY="));
  if (!line) throw new Error("SOC_HMAC_KEY 未找到（env 与 soc-demo/.env 都没有）");
  return line.slice("SOC_HMAC_KEY=".length).trim();
}
const KEY = loadKey();

function head(t: string): void {
  console.log(`\n━━━ ${t} ━━━`);
}
const show = (label: string, r: ReturnType<typeof verifyTicket>): string =>
  r.allow ? `${label} → allow（${r.reason}）` : `${label} → 403 ${r.reason}`;

// 闸拒审计台：makeGatedCall 的 deny 落点（INV-8 的教学缩影——闸拒不吞，留账）
let denyCount = 0;
function auditDeny(info: GateDenyInfo): { record: (e: { details: Record<string, unknown> }) => void } {
  return {
    record: (e) => {
      denyCount += 1;
      console.log(`  审计 DENIED#${denyCount}: tool=${info.tool} reason=${info.reason} result=DENIED details=${JSON.stringify(e.details)}`);
    },
  };
}
// 假 NodeCtx：只实现 emit（tool_call/tool_result 广播）
const ctx = {
  runId: RUN_ID,
  state: {} as Record<string, unknown>,
  emit(type: string, payload: Record<string, unknown>): void {
    console.log(`  SSE ${type}: ${JSON.stringify(payload)}`);
  },
  charge(): void {},
  checkLlm(): void {},
  awaitApproval(): never {
    throw new Error("demo 不走审批面");
  },
  async executeApproved(): never {
    throw new Error("demo 不走审批面");
  },
};

// ---- S1 · 无票闯闸：L1 登记了也不免验 ----
head("S1 无票闯闸（分级读登记表：tierOf）");
console.log(`list_approvals tierOf = ${tierOf("list_approvals")}（登记行 tier=L1）`);
console.log(show("list_approvals（无票）", verifyTicket({ name: "list_approvals", params: {} }, {}, Math.floor(Date.now() / 1000), { hmacKey: KEY })));
console.log(show("get_alert（无票，对照：L0 免验待遇）", verifyTicket({ name: "get_alert", params: {} }, {}, Math.floor(Date.now() / 1000), { hmacKey: KEY })));

// ---- S2 · 真网关铸票：gateway /internal/mint（票面带上新工具）----
head(`S2 真网关铸票：POST :8002/internal/mint（${RUN_ID}，绑 ${CASE_ID}）`);
const mintBody = {
  type: "task_ticket",
  jti: `tk_s7_${randomUUID().slice(0, 8)}`,
  sub: "agent:case_flow",
  case_id: CASE_ID,
  run_id: RUN_ID,
  scope: ["case:read", "case:write"],
  allowed_tools: ["get_alert", "siem_query", "list_approvals"],
};
const mintRes = await fetch("http://127.0.0.1:8002/internal/mint", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(mintBody),
});
if (!mintRes.ok) throw new Error(`铸票失败：${mintRes.status} ${await mintRes.text()}`);
const { token, payload } = (await mintRes.json()) as { token: string; payload: Record<string, unknown> };
console.log(`  网关回包 payload.exp=${payload.exp}（TTL 900s）、allowed_tools=${JSON.stringify(payload.allowed_tools)}`);
console.log(`  token（三段）：${String(token).slice(0, 40)}…`);
// 注意：网关铸票口不查登记表——allowed_tools 签什么就是什么；合法性由票面⊆manifest 的对账测试咬死

// ---- S3 · 持票过闸执行：makeGatedCall（worker 同款闸体）→ 真 handler 查真台账 ----
head("S3 持票过闸执行（run 形态：广播 tool_call → 验票 → 执行 → tool_result）");
const gated = makeGatedCall({
  prefix: "scenario7",
  hmacKey: KEY,
  creds: () => ({ ticket: token, runId: RUN_ID, caseId: CASE_ID }),
  deny: (info) => auditDeny(info),
  emitToolCall: (c, info) => c.emit("tool_call", { tool: info.tool, params_hash: info.paramsHash }),
  emitToolResult: (c, info) => c.emit("tool_result", { tool: info.tool, ok: true }),
});
const ledger = await gated(ctx, "list_approvals", { status: "approved", limit: 3 }, () => list_approvals({ status: "approved", limit: 3 }));
console.log(`  台账读口返回：total=${ledger.total}（approved 总数），吐出 ${ledger.approvals.length} 行：`);
for (const a of ledger.approvals) console.log(`   - ${a.id} ${a.tool} ${a.status} case=${a.case_id}`);

// ---- S4 · 大小写戏法：票面是小写，闸收到大写 → scope_insufficient（闸拒不吞）----
head("S4 大小写戏法：List_Approvals ≠ list_approvals");
try {
  await gated(ctx, "List_Approvals", {}, () => list_approvals({}));
  console.log("  （不该到这里：大写名字居然放行了）");
} catch (e) {
  console.log(`  run 被强杀，错误：${(e as Error).message}`);
}

// ---- S5 · 摘行对照：摘掉登记行（临时副本 + env 接缝），同一张票两问 ----
head("S5 摘行对照（TOOLS_MANIFEST_FILE → 摘了行的临时副本）");
const dir = mkdtempSync(path.join(tmpdir(), "s73-strip-"));
const stripped = path.join(dir, "stripped.manifest.json");
copyFileSync(REAL_MANIFEST, stripped);
{
  const m = JSON.parse(readFileSync(REAL_MANIFEST, "utf8")) as { tools: { name: string }[] };
  m.tools = m.tools.filter((t) => t.name !== "list_approvals");
  writeFileSync(stripped, JSON.stringify(m, null, 2) + "\n");
}
try {
  process.env.TOOLS_MANIFEST_FILE = stripped;
  resetToolsManifestCache();
  console.log(show("  ① 无票再问", verifyTicket({ name: "list_approvals", params: {} }, {}, Math.floor(Date.now() / 1000), { hmacKey: KEY })));
  console.log("     （与健康表同答案：登记 L1 与未登记默认 L1 在闸眼里是同一个数字）");
  const r2 = verifyTicket(
    { name: "list_approvals", params: {} },
    { ticket: token, runId: RUN_ID, caseId: CASE_ID },
    Math.floor(Date.now() / 1000),
    { hmacKey: KEY },
  );
  console.log(`  ② 持同一张票再问 → ${r2.allow ? "allow（闸认票不认表：验票闸不看登记表，票面 allowed_tools 说了算）" : `403 ${r2.reason}`}`);
  if (r2.allow) {
    const again = await gated(ctx, "list_approvals", { status: "rejected" }, () => list_approvals({ status: "rejected", limit: 2 }));
    console.log(`     handler 照常执行：total=${again.total}，首行=${again.approvals[0]?.id ?? "无"}`);
  }
} finally {
  delete process.env.TOOLS_MANIFEST_FILE;
  resetToolsManifestCache();
  rmSync(dir, { recursive: true, force: true });
}

// ---- S6 · 票面不含它：no_ticket / scope_insufficient / allow 三态辨析 ----
head("S6 三态辨析：铸一张【不含】list_approvals 的票再问同一工具");
const mint2 = await fetch("http://127.0.0.1:8002/internal/mint", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...mintBody, jti: `tk_s7_${randomUUID().slice(0, 8)}`, allowed_tools: ["get_alert", "siem_query"] }),
});
if (!mint2.ok) throw new Error(`铸票失败：${mint2.status}`);
const { token: token2 } = (await mint2.json()) as { token: string };
const now = Math.floor(Date.now() / 1000);
console.log(show("  手里没票", verifyTicket({ name: "list_approvals", params: {} }, {}, now, { hmacKey: KEY })));
console.log(show("  票里没这个工具", verifyTicket({ name: "list_approvals", params: {} }, { ticket: token2, runId: RUN_ID, caseId: CASE_ID }, now, { hmacKey: KEY })));
console.log(show("  票里恰好有（S2 那张）", verifyTicket({ name: "list_approvals", params: {} }, { ticket: token, runId: RUN_ID, caseId: CASE_ID }, now, { hmacKey: KEY })));

console.log("\n（六幕完毕）摘行的真正执法者：对账测试（A.1 有它/manifest 没它 → 红）+ 铸票上游（票面 ⊆ manifest 由测试咬死）。");
console.log("INV-3 对号：list_approvals 是 L1 只读——审批卡台账 tool='list_approvals' 的行数恒 0，物理上没有审批卡产生。");
