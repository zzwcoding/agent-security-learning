// m8 对话 Copilot · RBAC 可见工具清单（FR-M8.2「可见性即第一收窄」）。
//
// 数据源 = services/gateway/fga/matrix.json（票 12 灌进真 openfga 的那份矩阵）——
// 「族 → 工具」的归属与分级（L0/L1/L2）单一来源，agent 侧不维护第二份工具表。
//
// 「可见」与「可直查」是两个正交的位（都出自 A.2，别混）：
//   - visibleTools(role)：这个角色**看得见/可提请**哪些工具（ContextForge 下发 Web 的清单，
//     含「需审批」的 L2——duty_lead 看得见 isolate_host，只是不能直接执行）；
//   - matrix.roles[r].families：这个角色**可直接执行**哪些族（真 openfga 元组，票 12）。
// A.2 原文对照（prd.md 附录 A.2，逐格翻译进 VISIBLE_FAMILIES）：
//   只读查询族 / 案件写入族：soc1、值班长、管理员 ✓，红队 —
//   KB 入库（kb_write）：soc1「提交提案 ✓ / 入库 —」（提案=kb_propose，属案件写入族）；
//     值班长/管理员「需审批回路 ✓」→ 可见可提请
//   高危响应族（isolate/block）：soc1「—」（→ 不可见，L2 意图 100% deny 的根源）；
//     值班长/管理员「需审批」→ 可见可提请；红队全 —
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface FgaMatrix {
  store_name: string;
  families: Record<string, { tier: string; a2_column?: string; tools: string[] }>;
  roles: Record<string, { a2_row?: string; families: string[] }>;
}

const DEFAULT_MATRIX_PATH = "../../../../services/gateway/fga/matrix.json";

let cached: FgaMatrix | null = null;

/** 读矩阵（模块级缓存：文件只在 setup 时变，进程内读一次足够；测试可 loadMatrix.reload）。 */
export function loadMatrix(): FgaMatrix {
  if (!cached) {
    const p = process.env.FGA_MATRIX_FILE ?? fileURLToPath(new URL(DEFAULT_MATRIX_PATH, import.meta.url));
    cached = JSON.parse(readFileSync(p, "utf8")) as FgaMatrix;
  }
  return cached;
}

/** A.2 逐格翻译：角色 → 可见（可提请）工具族。未知角色不在表里 = 空清单（fail-closed）。 */
const VISIBLE_FAMILIES: Record<string, string[]> = {
  soc1: ["readonly_query", "case_write"],
  duty_lead: ["readonly_query", "case_write", "kb_write", "incident_response"],
  admin: ["readonly_query", "case_write", "kb_write", "incident_response"],
  redteam: [],
};

/** 工具 → 所属族（matrix 单一来源；未登记工具 null → 闸按未知工具拒绝）。 */
export function familyOf(tool: string): string | null {
  for (const [fam, spec] of Object.entries(loadMatrix().families)) {
    if (spec.tools.includes(tool)) return fam;
  }
  return null;
}

/** 工具 → 分级（L0 只读 / L1 写 / L2 高危）；未登记 null。 */
export function tierOf(tool: string): string | null {
  const fam = familyOf(tool);
  return fam ? (loadMatrix().families[fam]?.tier ?? null) : null;
}

/** 角色的可见工具清单（排序稳定——快照 diff 与 Web 下发都吃确定性顺序）。 */
export function visibleTools(role: string): string[] {
  const families = VISIBLE_FAMILIES[role] ?? [];
  const tools = families.flatMap((f) => loadMatrix().families[f]?.tools ?? []);
  return [...new Set(tools)].sort();
}
