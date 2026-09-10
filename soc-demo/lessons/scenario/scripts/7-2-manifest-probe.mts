// 场景 7 步 7.2 教具：登记表（fixtures/tools.manifest.json）的三种身体状态，
// 验票闸分别怎么应对——健康 / 病了 / 摘行。不碰真表，全程临时副本。运行：
//   cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/7-2-manifest-probe.mts
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetToolsManifestCache, tierOf } from "../../../services/agent/src/tools-manifest.js";
import { verifyTicket } from "../../../services/agent/src/verify-ticket.js";

const REAL_MANIFEST = fileURLToPath(new URL("../../../fixtures/tools.manifest.json", import.meta.url));
const KEY = "soc-demo-test-hmac-key-do-not-use-in-prod";
const NOW = 1757000100;

function head(t: string): void {
  console.log(`\n━━━ ${t} ━━━`);
}

// ---- S1 · 健康表：登记行说什么，闸信什么 ----
head("S1 健康表：真登记表（25 行 = A.1 的 24 + get_case 点名偏差）");
console.log(`list_approvals tierOf = ${tierOf("list_approvals")}（L1：无票 no_ticket）`);
console.log(`get_alert      tierOf = ${tierOf("get_alert")}（L0：无票 allow）`);
console.log(`kb_write       tierOf = ${tierOf("kb_write")}（L2：无票 require_approval）`);
console.log(JSON.stringify(verifyTicket({ name: "list_approvals", params: {} }, {}, NOW, { hmacKey: KEY })));

const dir = mkdtempSync(path.join(tmpdir(), "s72-probe-"));

// ---- S2 · 病表：登记表 JSON 坏了，闸 fail-closed（INV-1）----
head("S2 病表：JSON 被剪坏（收尾 ] 被吞）→ tierOf 抛 → 闸收进 403 signature_invalid");
const sick = path.join(dir, "sick.manifest.json");
writeFileSync(sick, readReal().replace(/\]\s*}\s*$/, "}"));
try {
  process.env.TOOLS_MANIFEST_FILE = sick;
  resetToolsManifestCache();
  try {
    tierOf("list_approvals");
    console.log("（不该到这里：病表居然读成功了）");
  } catch (e) {
    console.log(`tierOf 抛错：${(e as Error).constructor.name}（登记表病了，读口直接炸，不猜）`);
  }
  console.log(
    `verifyTicket → ${JSON.stringify(verifyTicket({ name: "get_alert", params: {} }, {}, NOW, { hmacKey: KEY }))}`,
  );
} finally {
  delete process.env.TOOLS_MANIFEST_FILE;
  resetToolsManifestCache();
}

// ---- S3 · 摘行副本：同一工具名，摘掉登记行 → 默认级 L1 ----
head("S3 摘行副本：真表拷贝摘掉 list_approvals 行 → 未登记 → policy 默认级 L1");
const stripped = path.join(dir, "stripped.manifest.json");
copyFileSync(REAL_MANIFEST, stripped);
{
  const m = JSON.parse(readReal()) as { tools: { name: string }[] };
  m.tools = m.tools.filter((t) => t.name !== "list_approvals");
  writeFileSync(stripped, JSON.stringify(m, null, 2) + "\n");
}
try {
  process.env.TOOLS_MANIFEST_FILE = stripped;
  resetToolsManifestCache();
  console.log(`摘行后 list_approvals tierOf = ${tierOf("list_approvals")}（未登记 → policy.unregistered_tier=L1）`);
  console.log(
    `verifyTicket → ${JSON.stringify(verifyTicket({ name: "list_approvals", params: {} }, {}, NOW, { hmacKey: KEY }))}`,
  );
} finally {
  delete process.env.TOOLS_MANIFEST_FILE;
  resetToolsManifestCache();
  rmSync(dir, { recursive: true, force: true });
}

function readReal(): string {
  return readFileSync(REAL_MANIFEST, "utf8");
}
console.log("\n（三幕完毕：闸的粮草=登记表——表说什么闸信什么，表病了闸绝不放行）");
