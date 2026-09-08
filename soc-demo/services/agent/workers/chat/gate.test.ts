// 票 18：意图闸三态（FR-M8.4：allow 只读直查 / require_approval 转审批 / deny 拒绝并解释）
// + RBAC 可见工具清单按角色快照 diff（FR-M8.2 / m8 卡测试计划）。
// FGA 用「静态规则表 stub」（m8 卡 Seam adapter：openfga 容器 / 静态规则表 stub 供单测）
// ——stub 与真世界同一份 matrix.json 推出来，真容器冒烟在 fga-client.test.ts。
import { describe, expect, test } from "vitest";
import { decideIntent, type FgaChecker } from "./gate.js";
import { familyOf, loadMatrix, tierOf, visibleTools } from "./visible-tools.js";

/** 静态规则表 stub：FGA allow = 该角色在 matrix 里有这个工具族的直接授权。
 *  与 services/gateway/fga/setup_openfga.py 灌进真容器的元组同源同义；deny 带
 *  reason（FgaChecker 契约，makeFgaChecker 的产出形态）。 */
function stubFga(user: string, tool: string): Promise<{ allowed: boolean; reason?: string }> {
  const role = user.replace(/^user:/, "");
  const fam = familyOf(tool);
  const roles = loadMatrix().roles as Record<string, { families: string[] }>;
  const allowed = !!fam && (roles[role]?.families ?? []).includes(fam);
  return Promise.resolve(allowed ? { allowed: true } : { allowed: false, reason: "fga_denied" });
}
const check = (role: string, tool: string) => decideIntent(role, tool, stubFga as FgaChecker);

// ---------- 可见工具清单（FR-M8.2：可见性即第一收窄；A.2 附录逐格翻译） ----------

describe("可见工具清单按角色快照 diff", () => {
  const L2_TOOLS = ["block_ip", "deisolate_host", "isolate_host", "kb_write", "unblock_ip"];

  test("快照：soc1=18 只读+案件写入；duty_lead=admin=+5 个 L2；redteam=空", () => {
    expect(visibleTools("soc1")).toEqual(
      [
        "add_observable", "add_task_log", "add_timeline_entry", "case_assign", "case_update",
        "close_alert", "create_case", "extract_knowledge", "get_alert", "ip_reputation",
        "kb_lookup", "kb_propose", "kb_verify", "merge_alert", "related_alerts",
        "search_cases_by_host", "siem_query", "vt_lookup",
      ],
    );
    const lead = visibleTools("duty_lead");
    expect(lead).toHaveLength(23);
    expect(lead.filter((t) => !visibleTools("soc1").includes(t)).sort()).toEqual(L2_TOOLS); // diff 就是 5 个 L2
    expect(visibleTools("admin")).toEqual(lead);
    expect(visibleTools("redteam")).toEqual([]);
  });

  test("soc1 对 5 个 L2 工具全部不可见（A.2：KB 入库「—」、高危「—」）", () => {
    for (const t of L2_TOOLS) expect(visibleTools("soc1")).not.toContain(t);
  });

  test("未知角色 fail-closed = 空清单；matrix 直执行族 ⊆ 可见族（stub 与真世界不打架）", () => {
    expect(visibleTools("stranger")).toEqual([]);
    const roles = loadMatrix().roles as Record<string, { families: string[] }>;
    const visibleFamiliesOf = (r: string) => new Set((visibleTools(r) as string[]).map((t) => familyOf(t)));
    for (const [role, spec] of Object.entries(roles)) {
      for (const fam of spec.families) expect(visibleFamiliesOf(role).has(fam)).toBe(true);
    }
  });

  test("familyOf/tierOf：工具→族→分级（matrix.json 单一来源）", () => {
    expect(familyOf("siem_query")).toBe("readonly_query");
    expect(tierOf("siem_query")).toBe("L0");
    expect(familyOf("close_alert")).toBe("case_write");
    expect(tierOf("close_alert")).toBe("L1");
    expect(familyOf("isolate_host")).toBe("incident_response");
    expect(tierOf("isolate_host")).toBe("L2");
    expect(tierOf("kb_write")).toBe("L2");
    expect(familyOf("no_such_tool")).toBe(null);
    expect(tierOf("no_such_tool")).toBe(null);
  });
});

// ---------- 三态裁决（验收②）----------

describe("意图闸三态（FR-M8.4，OpenFGA 裁决）", () => {
  test("allow：soc1 只读意图 → 直查 worker 只读面", async () => {
    const d = await check("soc1", "related_alerts");
    expect(d.state).toBe("allow");
    expect(d.reason).toContain("只读");
  });

  test("require_approval：duty_lead 的 isolate_host（FGA 无直接授权，A.2=需审批 → 转审批回路）", async () => {
    const d = await check("duty_lead", "isolate_host");
    expect(d.state).toBe("require_approval");
    expect(d.reason).toContain("审批");
  });

  test("deny：soc1 的 L2 动作意图（不可见）——解释里带角色与工具", async () => {
    const d = await check("soc1", "isolate_host");
    expect(d.state).toBe("deny");
    expect(d.reason).toContain("soc1");
    expect(d.reason).toContain("isolate_host");
  });

  test("soc1 发起 L2 意图 100% deny（m8 卡测试计划 / eval 遍历口径）", async () => {
    const l2 = Object.entries(loadMatrix().families as Record<string, { tier: string; tools: string[] }>)
      .filter(([, f]) => f.tier === "L2")
      .flatMap(([, f]) => f.tools);
    expect(l2.length).toBeGreaterThanOrEqual(5);
    const verdicts = await Promise.all(l2.map((t) => check("soc1", t)));
    expect(verdicts.every((v) => v.state === "deny")).toBe(true);
  });

  test("redteam 一切意图 deny；未知角色/未知工具 deny（fail-closed）", async () => {
    expect((await check("redteam", "siem_query")).state).toBe("deny");
    expect((await check("stranger", "siem_query")).state).toBe("deny");
    expect((await check("soc1", "no_such_tool")).state).toBe("deny");
  });

  test("FGA 不可达 → deny（INV-1：裁判联系不上 ≠ 无罪推定）", async () => {
    const blind: FgaChecker = () => Promise.resolve({ allowed: false, reason: "fga_unreachable" });
    const d = await decideIntent("soc1", "siem_query", blind);
    expect(d.state).toBe("deny");
    expect(d.reason).toContain("fga_unreachable");
  });
});
