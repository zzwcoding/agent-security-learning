import { describe, expect, test } from "vitest";
import {
  HUNT_TEMPLATES_DIR,
  REGISTER_TOOL,
  HuntTemplateSource,
  loadHuntTemplates,
  makeHuntFakeLoopLlm,
  renderContainmentSuggestions,
  renderHypothesisText,
  toLoopTemplate,
} from "./hunt-pack.js";
import { DEFAULT_TEMPLATE, DefaultTemplateSource } from "../../src/orchestration/template.js";
import { registeredTools, tierOf } from "../../src/tools-manifest.js";
import { requireRunKind } from "../../src/run-kinds.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { planRound } from "../../src/orchestration/planner.js";
import { MemoryPlaybookLibrary, WEKNORA_FIXTURES } from "./weknora.js";
import type { NodeCtx } from "../../src/graph.js";
import type { PlannerInput } from "../../src/orchestration/ports.js";

// 票 80：应急取证假设模板（ir_host_compromise）——「一套循环五块业务」主张的架构验收
// 实验的内容层主战场。第二业务（PRD §13.3：单主机深度取证）落地只新增数据文件 + 测试，
// 零机制增量；机制层交集为零由 tools/check_zero_increment.py（T20）在 diff 面咬死，本
// 文件咬的是内容包契约与行为对账（票 79 的 hunt-pack.test.ts 同款范式）：
//   ①模板数据契约：template_id + 假设句式族（主机失陷确认类）+ 菜单子集收窄 host 维度
//     （PRD §13.4b 应急取实行：proc_lineage / file_change / outbound_conn + weknora）
//     + 轮次上限；②fake LLM 的 ir 确定性 plan：持久化机制→执行历史→外联的轮次轨迹
//     （多轮，gap 换组合）；③菜单收窄对账：host 维度外工具被 planner 选择 = 100% 拒。

const families = loadHuntTemplates();
const ir = families.find((f) => f.template_id === "ir_host_compromise");
const huntFamilies = families.filter((f) => f.template_id !== "ir_host_compromise");

/** ir 菜单（PRD §13.4b 应急取实行 = weknora 半边 + 三 host 维度工具）。 */
const IR_MENU = [
  "playbook_lookup",
  "graph_query",
  "file_change_query",
  "outbound_conn_query",
  "proc_lineage_query",
];

describe("ir_host_compromise 模板（票 80①：句式族 + host 维度菜单收窄 + 轮次上限）", () => {
  test("模板在册：第二业务与狩猎三族同落 fixtures/hunt-templates/（79 先例落点）", () => {
    expect(ir, "ir_host_compromise 模板缺失").toBeDefined();
    expect(ir!.family).toBe("ir_host_compromise");
    expect(ir!.hypothesis_patterns.length).toBeGreaterThanOrEqual(1); // 主机失陷确认类句式族
    expect(HUNT_TEMPLATES_DIR).toContain("/fixtures/hunt-templates/");
  });

  test("菜单子集收窄 host 维度：web_access_query（web 维度）不可入；三 host 维度工具齐备", () => {
    expect(ir!.menu.sort()).toEqual([...IR_MENU].sort());
    expect(ir!.menu).not.toContain("web_access_query"); // PRD §13.4b：host 维度收窄 = 剔除 web 维度
  });

  test("轮次上限与任务上限为模板自带数据（机制投影 toLoopTemplate 只带四字段）", () => {
    expect(ir!.max_rounds).toBeGreaterThanOrEqual(1);
    expect(ir!.max_tasks).toBeGreaterThanOrEqual(1);
    expect(toLoopTemplate(ir!)).toEqual({
      templateId: "ir_host_compromise",
      maxRounds: ir!.max_rounds,
      maxTasks: ir!.max_tasks,
      menu: expect.arrayContaining(IR_MENU),
    });
  });

  test("既定查询计划：多轮（≥3 波）且 gap 换组合——持久化机制 → 执行历史 → 外联", () => {
    expect(ir!.waves.length).toBeGreaterThanOrEqual(3);
    const flat = ir!.waves.flat().map((w) => w.tool);
    expect(flat).toContain("proc_lineage_query"); // 持久化机制（进程谱系维度）
    expect(flat).toContain("file_change_query"); // 执行历史（FIM 落盘维度）
    expect(flat).toContain("outbound_conn_query"); // 外联（回连 C2 维度）
    for (const wave of ir!.waves) {
      expect(wave.length, "wave ≤ max_tasks").toBeLessThanOrEqual(ir!.max_tasks);
      for (const t of wave) expect(ir!.menu, "wave 工具在模板菜单内").toContain(t.tool);
    }
  });

  test("句式族渲染：槽位与模板同源，假设文本可由模板数据复现", () => {
    const text = renderHypothesisText(ir!);
    expect(text).toContain("centos7");
    expect(text).toContain("cron");
    expect(text).toContain("/var/www/html/uploads/sh.php");
    expect(text).toContain("203.0.113.66");
    expect(text).not.toContain("{"); // 槽位零残留
  });

  test("遏制建议只出文本（INV-3/9 铁律：隔离主机类 L2 动作止于建议 + 人工审批话术）", () => {
    const suggestions = renderContainmentSuggestions(ir!);
    expect(suggestions.length).toBeGreaterThan(0);
    const joined = suggestions.join("\n");
    expect(joined).toContain("隔离主机");
    expect(joined).toContain("人工审批");
    expect(joined).toContain("centos7");
  });
});

describe("菜单对账（票 79 范式 × 第二业务：登记面/票面零增量 + L2 不可入）", () => {
  test("ir 菜单每个工具都已登记（planner 菜单是 manifest 在册表的子集）", () => {
    const universe = new Set(registeredTools());
    for (const tool of ir!.menu) {
      expect(universe.has(tool), `ir 菜单工具 ${tool} 未登记`).toBe(true);
    }
  });

  test("零登记增量：ir 菜单 ⊆ 票 79 既有登记面——hunt_flow 票面不因第二业务而扩", () => {
    // 票面铁律：host 维度工具 78 已全登记、weknora 三工具 79 已登记 → ir 收窄子集不该
    // 扩任何票面。huntFlowTicketFace 的语义在本文件重算对账（含 ir 与不含 ir 相等）。
    const faceWithIr = [...new Set([...DEFAULT_TEMPLATE.menu, ...families.flatMap((f) => f.menu), REGISTER_TOOL])];
    const faceWithoutIr = [
      ...new Set([...DEFAULT_TEMPLATE.menu, ...huntFamilies.flatMap((f) => f.menu), REGISTER_TOOL]),
    ];
    expect([...faceWithIr].sort()).toEqual([...faceWithoutIr].sort());
    // 真注册表票面（run-kinds 单一来源）与「不含 ir」的重算式逐工具相等 = 零登记增量
    expect([...requireRunKind("hunt_flow").ticket.allowedTools].sort()).toEqual(
      [...faceWithoutIr].sort(),
    );
  });

  test("register 不入 ir 菜单（L0 裁定②）；isolate_host（L2）不在任何模板菜单", () => {
    expect(ir!.menu).not.toContain(REGISTER_TOOL);
    for (const tool of ir!.menu) expect(tierOf(tool), `${tool} 不得是 L2`).toBeLessThan(2);
    expect(ir!.menu).not.toContain("isolate_host");
  });

  test("登记缝：ir template_id 回族模板投影；未登记 id 落机制默认档（原语义不回归）", () => {
    const src = new HuntTemplateSource(new DefaultTemplateSource(), families);
    expect(src.of("ir_host_compromise")).toEqual(toLoopTemplate(ir!));
    expect(src.of("hunt_no_such")).toEqual({ ...DEFAULT_TEMPLATE, templateId: "hunt_no_such" });
  });
});

describe("fake LLM 的 ir 确定性 plan（票 80②：持久化机制→执行历史→外联的轮次轨迹）", () => {
  const llm = makeHuntFakeLoopLlm();

  const plannerInput = (over: Partial<PlannerInput> = {}): PlannerInput => ({
    hypothesis_text: renderHypothesisText(ir!),
    evidence_so_far: [],
    gap: null,
    menu: [...ir!.menu],
    template: { max_rounds: ir!.max_rounds, max_tasks: ir!.max_tasks },
    ...over,
  });

  test("四轮轨迹：剧本开局 → 持久化机制（cron 拉起）→ 执行历史落盘 → 外联 + 图谱并行", async () => {
    const r1 = await llm.planner(plannerInput());
    expect(r1.tasks.map((t) => t.tool)).toEqual(["playbook_lookup"]);
    expect(r1.tasks[0]!.params).toMatchObject({ tag: "ir_host_compromise" });

    const r2 = await llm.planner(
      plannerInput({
        gap: { gap_description: "缺取证面证据", unknown: "u", suggested_focus: ["persistence"] },
        evidence_so_far: ["round1:playbook_lookup"],
      }),
    );
    expect(r2.tasks.map((t) => t.tool)).toEqual(["proc_lineage_query"]); // 持久化机制
    expect(r2.tasks[0]!.params).toMatchObject({ process: "cron", role: "parent" });
    expect(r2.tasks[0]!.params).toHaveProperty("time_window"); // 强制时间窗缰绳

    const r3 = await llm.planner(
      plannerInput({
        gap: { gap_description: "仍不足", unknown: "u", suggested_focus: ["persistence"] },
        evidence_so_far: ["round1:playbook_lookup", "round2:proc_lineage_query"],
      }),
    );
    expect(r3.tasks.map((t) => t.tool)).toEqual(["file_change_query"]); // 执行历史（FIM）
    expect(r3.tasks[0]!.params).toMatchObject({ field: "path", value: "/var/www/html/uploads/sh.php" });

    const r4 = await llm.planner(
      plannerInput({
        gap: { gap_description: "仍不足", unknown: "u", suggested_focus: ["outbound"] },
        evidence_so_far: [
          "round1:playbook_lookup",
          "round2:proc_lineage_query",
          "round3:file_change_query",
        ],
      }),
    );
    expect(r4.tasks.map((t) => t.tool)).toEqual(["outbound_conn_query", "graph_query"]); // 外联 + 图谱佐证
    expect(r4.tasks[0]!.params).toMatchObject({ field: "dst_ip", value: "203.0.113.66" });

    // 相邻轮组合必不同（防转闸的机制保证；gap 换组合的轨迹要求）
    const fingerprint = (ts: { tool: string }[]) => ts.map((t) => t.tool).join("|");
    const prints = [r1, r2, r3, r4].map((r) => fingerprint(r.tasks));
    expect(new Set(prints).size).toBe(prints.length);
  });

  test("judge 判据：单报告轮不充分；双证轮（取证命中）→ hit 并附带遏制建议文本", async () => {
    const { tasks } = await llm.planner(plannerInput()); // currentFamily = ir（judge 无菜单输入）
    const report = (t: { tool: string; params: Record<string, unknown>; rationale: string }, total: number) => ({
      task: t,
      result_summary: `${t.tool} total=${total} hits=${total}`,
      params_hash: `h-${t.tool}`,
    });
    const round3 = await llm.judge({
      hypothesis_text: renderHypothesisText(ir!),
      round_reports: [report(tasks[0]!, 1)],
      prior_rounds: 2,
    });
    expect(round3.sufficient).toBe(false); // 单报告轮：宁继续轮次不提前收敛

    const r4 = await llm.planner(
      plannerInput({
        gap: { gap_description: "仍不足", unknown: "u", suggested_focus: ["outbound"] },
        evidence_so_far: ["r1", "r2", "r3"],
      }),
    );
    const round4 = await llm.judge({
      hypothesis_text: renderHypothesisText(ir!),
      round_reports: [report(r4.tasks[0]!, 2), report(r4.tasks[1]!, 0)],
      prior_rounds: 3,
    });
    expect(round4).toMatchObject({ sufficient: true, verdict: "hit", confidence: 0.8 });
    const containment = (round4 as { containment_suggestions?: string[] }).containment_suggestions ?? [];
    expect(containment.join("\n")).toContain("隔离主机");
    expect(containment.join("\n")).toContain("人工审批"); // INV-3/9：建议文本自带审批口径
  });

  test("judge 零命中 → miss 且不带遏制建议（建议只在确认失陷半边出现）", async () => {
    const r4 = await llm.planner(
      plannerInput({
        gap: { gap_description: "仍不足", unknown: "u", suggested_focus: ["outbound"] },
        evidence_so_far: ["r1", "r2", "r3"],
      }),
    );
    const verdict = await llm.judge({
      hypothesis_text: renderHypothesisText(ir!),
      round_reports: r4.tasks.map((t, i) => ({
        task: t,
        result_summary: `${t.tool} total=0 hits=0`,
        params_hash: `h${i}`,
      })),
      prior_rounds: 3,
    });
    expect(verdict).toMatchObject({ sufficient: true, verdict: "miss" });
    expect((verdict as { containment_suggestions?: string[] }).containment_suggestions).toBeUndefined();
  });
});

describe("菜单收窄 × planner 菜单闸（票 80 验收④：host 维度外工具被 planner 选择 = 100% 拒）", () => {
  /** planRound 的最小 ctx 形（hunt-pack.test.ts 同款 rig）：状态/事件/计费三口。 */
  async function planWith(llm: { planner: (i: PlannerInput) => Promise<{ tasks: unknown[]; tokens: number }> }, menu: string[]) {
    const audit = new MemoryAuditSink();
    const emitted: Record<string, unknown>[] = [];
    const ctx = {
      state: {
        hypothesis_text: "x",
        evidence_so_far: [],
        gap: null,
        menu,
        max_rounds: ir!.max_rounds,
        max_tasks: ir!.max_tasks,
        round_no: 1,
        hypothesis_id: "hyp-ir-menu",
      } as Record<string, unknown>,
      emit: (t: string, p: Record<string, unknown>) => emitted.push({ t, p }),
      charge: () => {},
      checkLlm: () => {},
    } as unknown as NodeCtx;
    const scan = async (text: string) => ({ blocked: false, action: "allow", text });
    await planRound({ orch: { llm, scan } as never, audit, runId: "run-ir-menu" }, ctx);
    return { audit, ctx, emitted };
  }

  const offMenu = registeredTools().filter((t) => !IR_MENU.includes(t));

  test(`全工具遍历：${offMenu.length} 个菜单外工具（含 web 维度 web_access_query）100% offmenu_tool DENIED`, async () => {
    expect(offMenu.length, "host 维度收窄后确实存在菜单外工具").toBeGreaterThan(0);
    expect(offMenu).toContain("web_access_query"); // 被收窄剔除的 web 维度工具必须出现在遍历里
    expect(offMenu).toContain(REGISTER_TOOL); // register 只在父票面（L0 裁定②）
    expect(offMenu).toContain("isolate_host"); // L2 遏制动作物理不在任何 planner 菜单

    for (const tool of offMenu) {
      const { audit, ctx } = await planWith(
        { planner: async () => ({ tasks: [{ tool, params: {}, rationale: "越菜单" }], tokens: 24 }) },
        [...IR_MENU],
      );
      expect(ctx.state.planner_failed, tool).toBe(true);
      expect(ctx.state.tasks, `${tool} 不产生任务`).toEqual([]);
      const denied = audit.entries.find((e) => e.action === "hunt_plan_denied");
      expect(denied?.result, tool).toBe("DENIED");
      expect(denied?.details, tool).toMatchObject({ reason: "offmenu_tool", tools: [tool] });
    }
  });

  test("正控：ir 菜单内组合放行（菜单约束只拒子集外，不误伤收窄面内取证）", async () => {
    const { ctx, audit } = await planWith(
      {
        planner: async () => ({
          tasks: [{ tool: "proc_lineage_query", params: {}, rationale: "菜单内" }],
          tokens: 24,
        }),
      },
      [...IR_MENU],
    );
    expect(ctx.state.planner_failed).toBeUndefined();
    expect((ctx.state.tasks as { tool: string }[]).map((t) => t.tool)).toEqual(["proc_lineage_query"]);
    expect(audit.entries.some((e) => e.action === "hunt_plan_suggest")).toBe(true);
  });
});

describe("fixture 语料补条（票 80③：ir 剧本入库 + 复用既有告警语料的取证面）", () => {
  test("剧本库补条：tag=ir_host_compromise 命中应急取证剧本（playbook 开局不是空查）", async () => {
    const lib = new MemoryPlaybookLibrary(WEKNORA_FIXTURES);
    const hit = await lib.lookup({ tag: "ir_host_compromise" });
    expect(hit.total).toBe(1);
    expect(hit.hits[0]!.id).toBe("pb-ir-host-compromise-001");
    expect(hit.hits[0]!.queries.length).toBeGreaterThan(0);
  });
});
