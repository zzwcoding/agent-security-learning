// 5.4 教学演示：毒 analyzer 打进 microsandbox——能力探测、真跑三闸、降级口径（生产代码零改动）。
// 运行（在 soc-demo/ 下）：cd services/agent && pnpm exec tsx ../../lessons/scenario/scripts/5-4-sandbox-demo.mts
import { MemoryAuditSink } from "../../../services/agent/src/audit.js";
import { MsbAnalyzerBackend, msbProbe } from "../../../services/agent/workers/enrichment/sandbox.js";
import { fileURLToPath } from "node:url";

const ATTACK_DIR = fileURLToPath(
  new URL("../../../fixtures/attack/sandbox/01_poisoned_analyzer/", import.meta.url),
);

// ---- S0 能力探测（探测本身也是一次真拉起：msb --version + 冒烟 VM）----
const head = (t: string) => console.log(`\n━━━ ${t} ━━━`);
head("S0 · msbProbe 能力探测");
const probe = await msbProbe();
if (!probe.ok) {
  console.log(`探测未过：${probe.reason}`);
  console.log("降级口径（如实）：FixtureAnalyzerTable 照常出结果（富化不断供），");
  console.log("真跑断言显式 skip 并打印原因——skip 必须可见，不静默降级（票 16 口径）。");
  console.log("本机若未装 msb，这就是你会看到的全部——防线叙事转到「命令行拓扑」侧。");
  process.exit(0);
}
console.log("探测通过（本机有 microVM 环境）——真跑侧开演。");

// ---- S1 毒 analyzer 进沙箱：表面出正常结果，暗地三件套全被拦 ----
head("S1 · 毒 analyzer（外联 C2 / 偷宿主凭证 / 落残留）进一次性 microVM");
process.env.SOC_CANARY_SECRET = "never-leaks-5f4a"; // 金丝雀挂宿主进程 env（INV-4 同款）
const audit = new MemoryAuditSink();
const backend = new MsbAnalyzerBackend({
  audit,
  requestId: "req-5-4-demo",
  scriptFor: () => `${ATTACK_DIR}analyzer.py`, // 攻击面切真跑：沙箱执行位换上投毒 analyzer
});
const r = await backend.lookup("vt_lookup", {
  data: "c05640e21ec2b1b4b4101c1a67a1a3c8af7c7ae9b6b98f8b1b1f0e9a2d3c4b5a",
  dataType: "hash", tlp: 2, pap: 2,
});
console.log("表面结果（毒在动作里不在结果里）：", JSON.stringify(r.summary.taxonomies));
for (const e of audit.entries) {
  console.log(`审计: ${e.result.padEnd(7)} ${e.action} | ${JSON.stringify(e.details).slice(0, 110)}`);
}
const denied = audit.entries.filter((e) => e.result === "DENIED");
const ok =
  denied.some((e) => e.action === "sandbox_egress_blocked") &&
  denied.some((e) => e.action === "sandbox_env_denied") &&
  audit.entries.every((e) => !e.action.includes("breach"));
console.log(ok ? "\nS1 全绿：egress 拦截 + env 不可见 + 零 breach（审计不依赖投毒者自白）" : "\nS1 有 breach——沙箱边界被打穿（不应发生）");
if (!ok) process.exit(1);
console.log("\n（S2 一次性/残留断言见 sandbox.test.ts 验收 4：新 VM 看不到上一台的 /tmp/pwned）");

// ---- S2 降级口径与 fail-closed：探测失败长什么样、没脚本不开机 ----
head("S2 · 降级口径与 fail-closed（不依赖真 VM 也能看的行为面）");
const deadProbe = await msbProbe({ msbBin: "msb-not-exist-xyz" });
console.log("探测（msb 不在 PATH）→", JSON.stringify(deadProbe));
console.log("  读法：ok:false + 人话 reason——CI 没KVM时测试显式 skip 并打印它，绝不静默降级。");
const audit2 = new MemoryAuditSink();
const missing = new MsbAnalyzerBackend({
  audit: audit2, requestId: "req-5-4-missing",
  scriptFor: () => "/nonexistent/analyzer.py", // 脚本缺失：fail-closed 分支
});
const r2 = await missing.lookup("vt_lookup", {
  data: "aa", dataType: "hash", tlp: 2, pap: 2,
});
console.log("脚本缺失 →", JSON.stringify(r2.errorMessage));
console.log("审计:", audit2.entries.map((e) => `${e.result} ${e.action}`).join(" | "));
console.log("读法：没脚本不猜、不开 VM、拒绝执行（INV-1）；errorMessage 带 sandbox_run_failed 前缀进富化报告。");
