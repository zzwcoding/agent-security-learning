#!/usr/bin/env node
// 工具脚手架生成器（票 48，ADR 0004-2 裁决 2 的演示半边）。
//
// 「新增一个工具」在过去=全仓摸 6+ 处：worker 工具面常量、票面 allowedTools、
// manifest 登记、handler、测试……漏一处就静默漂移。本生成器把最小闭环变成一条命令：
//
//   pnpm gen:tool demo_echo --tier L0
//   ⇒ 生成空壳工具（handler 输出一句话）+ 测试骨架 + 往 fixtures/tools.manifest.json
//     追加登记行（登记=过闸身份的唯一来源，票 48）。
//
// 纪律：
//   - 零依赖 node 脚本，不 import 工程内部任何模块（边界规则 R3：中立层保持可独立执行）；
//   - 生成物是演示产物，不入库：默认输出目录 generated-tools/ 在 .gitignore；
//   - 重名拒绝（退出码 2）——登记行是安全面，绝不静默覆盖；
//   - 端到端演示（生成→登记→过闸可用；删行→闸拒）由
//     services/agent/src/gen-tool.test.ts 在临时目录验证，用 TOOLS_MANIFEST_FILE
//     env 把闸指向演示清单（visible-tools.ts 读 FGA_MATRIX_FILE 的同款先例）。
//
// 用法：
//   node tools/gen-tool.mjs <name> [--tier L0|L1|L2] [--family <fam>]
//                           [--owner <m1-m12>] [--desc <一句话>]
//                           [--out <dir>] [--manifest <path>]
//   name       工具名，^[a-z][a-z0-9_]*_$（与登记表既有口径一致：小写下划线）
//   --tier     分级，默认 L1（fail-closed 默认级，与登记表 policy 同口径）
//   --family   A.2 四族之一，默认：L0 → readonly_query，其余 → case_write
//   --owner    owner_card，默认 m3（编排面收编新工具；正式归属定下后改登记行）
//   --desc     登记行 description，默认注明脚手架空壳
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // tools/.. = 仓库根
const TIER_DEFAULT = "L1";
const FAMILIES = new Set(["readonly_query", "case_write", "kb_write", "incident_response"]);
const TIERS = new Set(["L0", "L1", "L2"]);
const NAME_RE = /^[a-z][a-z0-9_]*$/;

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function die(code, msg) {
  console.error(`gen-tool: ${msg}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("--"));
if (!name) die(1, "用法：node tools/gen-tool.mjs <name> [--tier L1] [--out <dir>] [--manifest <path>]");
if (!NAME_RE.test(name)) die(1, `工具名 ${name} 不合口径（须匹配 ${NAME_RE}，与登记表既有小写下划线一致）`);

const tier = argValue(argv, "--tier") ?? TIER_DEFAULT;
if (!TIERS.has(tier)) die(1, `--tier 只许 L0|L1|L2，得到 ${tier}`);
const family = argValue(argv, "--family") ?? (tier === "L0" ? "readonly_query" : "case_write");
if (!FAMILIES.has(family)) die(1, `--family 须是 A.2 四族之一，得到 ${family}`);
const ownerCard = argValue(argv, "--owner") ?? "m3";
if (!/^m\d+$/.test(ownerCard)) die(1, `--owner 须是模块卡号（如 m3），得到 ${ownerCard}`);
const desc = argValue(argv, "--desc") ?? `gen:tool 脚手架空壳工具（${new Date().toISOString().slice(0, 10)} 生成，替换本描述）`;

const outDir = path.resolve(argValue(argv, "--out") ?? path.join(ROOT, "generated-tools"));
const manifestPath = path.resolve(argValue(argv, "--manifest") ?? path.join(ROOT, "fixtures", "tools.manifest.json"));

// ① 登记行：重名拒绝——登记面是安全面，覆盖=静默改分级，绝对不行
let raw;
try {
  raw = readFileSync(manifestPath, "utf8");
} catch {
  die(1, `登记表不存在：${manifestPath}（--manifest 要指着一份已存在的 tools.manifest.json）`);
}
const manifest = JSON.parse(raw);
if (manifest.tools.some((t) => t.name === name)) {
  die(2, `${name} 已登记于 ${manifestPath}（重名拒绝，不静默覆盖；要改分级直接编辑登记行）`);
}
manifest.tools.push({ name, tier, family, owner_card: ownerCard, description: desc });

// ② 空壳工具：handler 只输出一句话——演示「登记→过闸→可调用」的链路，逻辑后补
const shell = `// gen:tool 脚手架空壳（票 48）：先登记、过闸、能调用，再把一句话换成真逻辑。
// 登记行在 ${path.relative(ROOT, manifestPath)}（tier=${tier}）——分级与过闸行为都由它决定。
export async function ${name}(params: Record<string, unknown> = {}): Promise<string> {
  return \`[${name}] 空壳工具被调用。参数：\${JSON.stringify(params)}\`;
}
`;

// ③ 测试骨架：冒烟 + 指路（进 workspace 包才会被 pnpm test 收编）
const skeleton = `// gen:tool 生成的测试骨架（票 48）：把本文件与 ${name}.ts 一起挪进 workspace 包
// （如 services/agent/src/）后由 pnpm test 收编；闸的正/负例仿
// services/agent/src/verify-ticket.test.ts 与 tools-manifest.test.ts 写。
import { describe, expect, test } from "vitest";
import { ${name} } from "./${name}.js";

describe("${name}（gen:tool 脚手架）", () => {
  test("空壳 handler 输出一句话", async () => {
    expect(await ${name}({ demo: 1 })).toContain("[${name}]");
  });
});
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `${name}.ts`), shell);
writeFileSync(path.join(outDir, `${name}.test.ts`), skeleton);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`gen-tool: 已登记 ${name}（tier=${tier} family=${family} owner=${ownerCard}）`);
console.log(`  工具空壳   ${path.join(outDir, `${name}.ts`)}`);
console.log(`  测试骨架   ${path.join(outDir, `${name}.test.ts`)}`);
console.log(`  登记行追加 ${manifestPath}`);
