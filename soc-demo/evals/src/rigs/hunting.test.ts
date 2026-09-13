// 票 76 · spec T13/T14：INV-11 两票制遍历矩阵（hunting rig 的布景驱动测试）。
// 票 79：矩阵随 manifest 登记三工具自动扩格（工具全集 29→32）+ 三族假设端到端骨架
//（真执行体路径上的 T07/T08，供票 81 紫队 eval 复用）。
//
// specs/orchestration-loop.md 验收表锚点 `evals/src/rigs/hunting.ts::inv11_matrix`——
// 本文件在 seam 处驱动该 rig，钉死矩阵的预期结论（scenarios.test.ts 同款纪律：
// 布景跑出来 + 收证据 + 场景专项检查逐格必须真绿）。
import { describe, expect, test } from "vitest";
import { inv11_matrix, inv11_seam_gate_denies_offmenu, hunt_pack_e2e } from "./hunting.js";
import { registeredTools } from "../../../services/agent/src/tools-manifest.js";
import { requireRunKind } from "../../../services/agent/src/run-kinds.js";

describe("INV-11 两票制遍历矩阵（票 76：父票 planner 面 + 子票 narrow-scope）", () => {
  test("子票 ⊆ 父菜单 100%；每类任务 × 票面外工具 100% 403；过期重放必拒", async () => {
    const m = await inv11_matrix();

    // 六个矩阵专项检查逐个点名（防 extraChecks 恒空假绿）
    expect(m.extraChecks.map((c) => c.name)).toEqual([
      "inv11_parent_face",
      "inv11_child_subset_100pct",
      "inv11_child_scope_no_l2",
      "inv11_out_of_scope_403_100pct",
      "inv11_in_scope_allow",
      "inv11_expired_replay_403",
    ]);
    const bad = m.extraChecks.filter((c) => !c.ok);
    expect(bad, JSON.stringify(bad)).toEqual([]);

    // 矩阵规模再钉一道（fake LLM 两轮：kb_lookup + siem_query → related_alerts）
    const universe = registeredTools().length; // 32 在册（25 A.1 + 票 78 四工具 + 票 79 三工具）
    const parentFace = requireRunKind("hunt_flow").ticket.allowedTools.length; // 票 79：planner 面 ∪ 三族菜单 + register
    expect(m.parentFace.length).toBe(parentFace);
    expect(m.childFaces).toHaveLength(3); // 每类任务一枚子票
    expect(m.childFaces.map((f) => f.allowed_tools[0]).sort()).toEqual(["kb_lookup", "related_alerts", "siem_query"]);
    expect(m.denials.length).toBe(3 * (universe - 1)); // 3 类任务 × 票面外工具全集（INV-11 矩阵随登记自动扩格）
    expect(m.allows.length).toBe(3);
    expect(m.expiredReplays.length).toBe(3);
  });

  test("铸票缝闸负例：父菜单外工具在 ticketSpecFor 拒铸（INV-11 静态半边的缝上复证）", () => {
    expect(inv11_seam_gate_denies_offmenu()).toBe(true);
  });
});

describe("三族假设端到端（票 79④：fixture 假设 + 期望轮次轨迹 + 收敛结论断言）", () => {
  test("hit 族建案挂 hypothesis_id；miss 族 refuted + register(proposed)；轨迹与期望一致", async () => {
    const { families, extraChecks } = await hunt_pack_e2e();
    expect(families.map((f) => f.templateId)).toEqual([
      "hunt_c2_beacon",
      "hunt_credential_leak",
      "hunt_webshell",
    ]);

    // 场景专项检查逐格点名（防恒空假绿）
    expect(extraChecks.map((c) => c.name)).toEqual([
      "e2e_webshell_hit_trajectory",
      "e2e_c2_gap_pivot_hit_trajectory",
      "e2e_credential_miss_archive_trajectory",
      "e2e_real_executor_evidence",
    ]);
    const bad = extraChecks.filter((c) => !c.ok);
    expect(bad, JSON.stringify(bad)).toEqual([]);

    // T07/T08 语义在真执行体路径上的独立复证（不止于 rig 的 extraChecks）
    const byId = new Map(families.map((f) => [f.templateId, f]));
    const cred = byId.get("hunt_credential_leak")!;
    expect(cred.status).toBe("refuted");
    expect(cred.registerRecords[0]!.status).toBe("proposed"); // INV-5：入图一律 proposed
    expect(cred.registerAuditCount).toBe(1); // INV-8：五要素审计在 register seam 内
    const c2 = byId.get("hunt_c2_beacon")!;
    expect(c2.rounds.map((r) => r.tools)).toEqual([
      ["playbook_lookup"],
      ["outbound_conn_query"],
      ["outbound_conn_query", "proc_lineage_query"],
    ]); // gap 换组合的拆条轨迹
  });
});
