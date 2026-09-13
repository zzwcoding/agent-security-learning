// 票 76 · spec T13/T14：INV-11 两票制遍历矩阵（hunting rig 的布景驱动测试）。
//
// specs/orchestration-loop.md 验收表锚点 `evals/src/rigs/hunting.ts::inv11_matrix`——
// 本文件在 seam 处驱动该 rig，钉死矩阵的预期结论（scenarios.test.ts 同款纪律：
// 布景跑出来 + 收证据 + 场景专项检查逐格必须真绿）。
import { describe, expect, test } from "vitest";
import { inv11_matrix, inv11_seam_gate_denies_offmenu } from "./hunting.js";

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
    expect(m.parentFace.length).toBe(3); // 父票面 = planner 只读菜单三件
    expect(m.childFaces).toHaveLength(3); // 每类任务一枚子票
    expect(m.childFaces.map((f) => f.allowed_tools[0]).sort()).toEqual(["kb_lookup", "related_alerts", "siem_query"]);
    expect(m.denials.length).toBe(3 * 28); // 3 类任务 × 28 个票面外工具（29 在册工具全集 = 25 + 票 78 四工具）
    expect(m.allows.length).toBe(3);
    expect(m.expiredReplays.length).toBe(3);
  });

  test("铸票缝闸负例：父菜单外工具在 ticketSpecFor 拒铸（INV-11 静态半边的缝上复证）", () => {
    expect(inv11_seam_gate_denies_offmenu()).toBe(true);
  });
});
