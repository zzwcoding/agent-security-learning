// 票 76 · spec T13/T14：INV-11 两票制遍历矩阵（hunting rig 的布景驱动测试）。
// 票 79：矩阵随 manifest 登记三工具自动扩格（工具全集 29→32）+ 三族假设端到端骨架
//（真执行体路径上的 T07/T08，供票 81 紫队 eval 复用）。
// 票 80：第二业务 ir_host_compromise 并入端到端（架构验收件——T20 零增量的行为半边：
// 应急取证 4 轮 gap 换组合轨迹 + 遏制建议只进 note 文本 + 菜单收窄对账）。
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

describe("假设端到端（票 79④ 三族 + 票 80 第二业务：fixture 假设 + 期望轮次轨迹 + 收敛结论断言）", () => {
  test("hit 族建案挂 hypothesis_id；miss 族 refuted + register(proposed)；轨迹与期望一致", async () => {
    const { families, extraChecks } = await hunt_pack_e2e();
    expect(families.map((f) => f.templateId)).toEqual([
      "hunt_c2_beacon",
      "hunt_credential_leak",
      "hunt_webshell",
      "ir_host_compromise", // 票 80：应急取证（架构验收件）
    ]);

    // 场景专项检查逐格点名（防恒空假绿）
    expect(extraChecks.map((c) => c.name)).toEqual([
      "e2e_webshell_hit_trajectory",
      "e2e_c2_gap_pivot_hit_trajectory",
      "e2e_credential_miss_archive_trajectory",
      "e2e_ir_host_compromise_trajectory",
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

  test("票 80 第二业务：应急取证 4 轮轨迹（持久化→执行历史→外联）+ 遏制建议只进 note 文本", async () => {
    const { families } = await hunt_pack_e2e();
    const ir = families.find((f) => f.templateId === "ir_host_compromise")!;

    // 轮次轨迹与期望一致（fake LLM 确定性 plan：持久化机制→执行历史→外联，gap 换组合）
    expect(ir.status).toBe("concluded");
    expect(ir.rounds.map((r) => r.tools)).toEqual([
      ["playbook_lookup"],
      ["proc_lineage_query"],
      ["file_change_query"],
      ["outbound_conn_query", "graph_query"],
    ]);
    expect(ir.rounds[3]!.judge).toMatchObject({ sufficient: true, verdict: "hit" });

    // 收敛半边：hit 建案（挂 hypothesis_id）；register 零写入（register 只在 miss 归档步）
    expect(ir.caseHypothesisIds).toEqual([ir.hypothesisId]);
    expect(ir.registerRecords).toHaveLength(0);

    // 铁律：遏制建议（隔离主机）只以文本进 note，动作须经人工审批（INV-3/9）——
    // note structured 的 recommended_actions 是纯文本建议，无任何可执行对象。
    const note = ir.noteInputs.at(-1)!;
    expect(note.body).toContain("遏制建议（仅文本建议，动作须经人工审批）");
    expect(note.body).toContain("隔离主机 centos7");
    const actions = (note.structured as { recommended_actions?: string[] }).recommended_actions ?? [];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => typeof a === "string")).toBe(true);

    // 布景自证零 L2：全场景铸票审批口从未被调（makeRecordingMint 的 mintApprovalToken
    // 直抛）——isolate_host 不在任何族菜单（ir-template.test 遍历侧已钉），此处证执行链。
    expect(ir.childSummaries.every((s) => !s.includes("isolate_host"))).toBe(true);
  });
});
