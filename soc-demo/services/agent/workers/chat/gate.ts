// m8 对话 Copilot · 意图闸三态裁决（FR-M8.4；PRD §6-M8「Tracecat 三态对齐」）。
//
//   allow            = 只读意图且 OpenFGA allow → 路由 worker 只读面直查（L0 免票族）
//   require_approval = 动作意图（L1/L2，角色可见可提请）→ 转审批回路（票 11 铸 ApprovalToken）
//   deny             = 不可见 / 未知角色工具 / 裁判不可达 → 拒绝并解释（fail-closed，INV-1）
//
// 裁决的两个数据源都是真件：
//   - 可见性 = A.2 矩阵（visible-tools.ts，与真 openfga 世界同一份 matrix.json）；
//   - 可直查 = 真 OpenFGA check（fga-client.ts，user:<角色> can_execute tool:<工具>）。
// 三条硬语义：
//   1. soc1 发起 L2 意图 100% deny——A.2 里 soc1 对 KB 入库/高危响应两族的格子是「—」，
//      不可见在 FGA 之前就拒了（m8 卡测试计划/eval 遍历口径）。
//   2. 动作意图一律转审批（FR-M8.4 原文）——哪怕 FGA 对 L1 有直接授权（soc1 能 close_alert），
//      对话面也只提请、不直执行：Copilot 没有写手，只有建议与提请。
//   3. 裁判联系不上 ≠ 无罪推定（INV-1）：FGA 超时/不可达/ids 不可读一律 deny 并解释。
import type { FgaChecker } from "../../src/fga-client.js";
export type { FgaChecker } from "../../src/fga-client.js";
import { familyOf, tierOf, visibleTools } from "./visible-tools.js";

export type GateState = "allow" | "require_approval" | "deny";

export interface GateDecision {
  state: GateState;
  role: string;
  tool: string;
  /** 人读解释：deny 必须能直接念给用户听（验收⑤「deny 且解释」）；allow/approval 是裁判依据留痕。 */
  reason: string;
}

export async function decideIntent(role: string, tool: string, fga: FgaChecker): Promise<GateDecision> {
  const knownRoles = ["soc1", "duty_lead", "admin", "redteam"];
  if (!knownRoles.includes(role)) {
    return { state: "deny", role, tool, reason: `未知角色「${role}」：不在四种预置身份内，fail-closed 拒绝（INV-1）` };
  }
  const fam = familyOf(tool);
  const tier = tierOf(tool);
  if (!fam || !tier) {
    return { state: "deny", role, tool, reason: `未知工具「${tool}」：不在 A.2 工具族清单内，fail-closed 拒绝` };
  }
  // 可见性 = 第一收窄（FR-M8.2）：清单上看不见的工具，意图直接拒绝并解释
  if (!visibleTools(role).includes(tool)) {
    return {
      state: "deny",
      role, tool,
      reason: `角色 ${role} 对 ${tool}（${fam} 族，${tier}）不可见：A.2 权限矩阵该格为「—」，无权发起该操作`,
    };
  }
  // 真 OpenFGA check（票 12 容器）：问「这个角色能不能直接执行这个工具」
  const verdict = await fga(`user:${role}`, tool);
  if (!verdict.allowed) {
    // 裁判病了/说不行。可见 + L2 = 「需审批」格子，deny 是预期答案 → 转审批回路；
    // 其余（L0 被拒、裁判不可达）一律拒绝并解释，deny 覆盖 allow（INV-1）。
    if (verdict.reason === "fga_denied" && tier !== "L0") {
      return {
        state: "require_approval",
        role, tool,
        reason: `${tool} 属 ${fam} 族（${tier}）：动作意图一律转审批流程（FR-M8.4），已提请值班长裁决`,
      };
    }
    const why = verdict.reason === "fga_denied"
      ? `OpenFGA 裁决 deny：角色 ${role} 无 ${tool} 的直接执行权`
      : `授权裁决不可用（${verdict.reason}）：fail-closed 拒绝（INV-1），deny 覆盖 allow`;
    return { state: "deny", role, tool, reason: why };
  }
  if (tier === "L0") {
    return { state: "allow", role, tool, reason: `${tool} 属只读查询族（L0），OpenFGA allow：路由 worker 只读面直查` };
  }
  // FGA allow 的写族（如 soc1 的 close_alert）在对话面同样只提请不直执行（语义 2）
  return {
    state: "require_approval",
    role, tool,
    reason: `${tool} 属 ${fam} 族（${tier}）：动作意图一律转审批流程（FR-M8.4），已提请值班长裁决`,
  };
}
