// m9 · ToolManifest 登记表读口（票 48，ADR 0004-2 裁决 2）。
//
// 分级知识从此只有一份：fixtures/tools.manifest.json（name/tier/family/owner_card/
// description + policy.unregistered_tier）。票 07 之前 verify-ticket.ts 里那张手写
// 小表（siem_query/kb_search/isolate_host/kb_write 四个名字）是它的前身——表小到
// 与 PRD A.1 对不上也没人知道，这正是遗留 G2-4「机制票不存在」的病灶。
//
// 消费方与接缝：
//   verify-ticket.ts —— tierOf() 替换原 levelOf()：分级判定的唯一来源（载体变更，
//                       断言语义不变——L0 免验 / L1 需票 / L2 需审批照旧）；
//   tools-manifest.test —— 三方法律（manifest ≡ PRD A.1 ≡ worker 工具面）+
//                       未登记默认 L1 负例 + env 覆盖接缝；
//   gen-tool.mjs     —— 脚手架生成器（零依赖 node，中立层）往 manifest 追加登记行；
//   gateway py 测试 —— family/tier 与 FGA 矩阵 matrix.json 互锁。
//
// 读法照 visible-tools.ts（chat 意图闸读 matrix.json）的同款三件套：env 覆盖 +
// 模块级缓存 + 默认相对路径。env 覆盖（TOOLS_MANIFEST_FILE）不是给自己用的——
// 是 gen-tool 端到端演示测试的接缝：生成物落临时目录，闸指着临时清单验货。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ToolTier = "L0" | "L1" | "L2";

export interface ToolManifestEntry {
  name: string;
  tier: ToolTier;
  family: string;
  owner_card: string;
  description: string;
}

export interface ToolManifestPolicy {
  /** 未登记工具的默认分级——fail-closed 更严口径，只许 L1（测试钉死）。 */
  unregistered_tier: ToolTier;
  unregistered_note?: string;
}

export interface ToolManifest {
  _readme?: string;
  policy: ToolManifestPolicy;
  tools: ToolManifestEntry[];
}

const DEFAULT_MANIFEST_PATH = "../../../fixtures/tools.manifest.json";

const TIER_RANK: Record<ToolTier, 0 | 1 | 2> = { L0: 0, L1: 1, L2: 2 };

let cached: ToolManifest | null = null;

/** 读登记表（模块级缓存：登记只在开发期变，进程内读一次足够；测试换表用
 *  resetToolsManifestCache()）。文件读不到/JSON 坏 → 抛——在闸里被 INV-1 的
 *  try 兜成 403 signature_invalid：登记表病了，闸绝不放行。 */
export function loadToolsManifest(): ToolManifest {
  if (!cached) {
    const p = process.env.TOOLS_MANIFEST_FILE ?? fileURLToPath(new URL(DEFAULT_MANIFEST_PATH, import.meta.url));
    cached = JSON.parse(readFileSync(p, "utf8")) as ToolManifest;
  }
  return cached;
}

/** 测试接缝：env 覆盖或直接改文件后清缓存，下一次读取生效。 */
export function resetToolsManifestCache(): void {
  cached = null;
}

/** 工具 → 分级位（0/1/2）。未登记 → policy.unregistered_tier 的位（L1）——
 *  「未登记一律 L1」不再是注释里的一句话，是这张表自己声明的机制。 */
export function tierOf(tool: string): 0 | 1 | 2 {
  const hit = loadToolsManifest().tools.find((t) => t.name === tool);
  const tier = hit?.tier ?? loadToolsManifest().policy.unregistered_tier;
  return TIER_RANK[tier];
}

/** 在册工具名全集（登记表快照，测试与脚手架的重名检查用）。 */
export function registeredTools(): string[] {
  return loadToolsManifest().tools.map((t) => t.name);
}
