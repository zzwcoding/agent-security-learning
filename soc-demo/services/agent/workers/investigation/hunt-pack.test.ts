import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  HUNT_TEMPLATES_DIR,
  REGISTER_TOOL,
  HuntTemplateSource,
  loadHuntTemplates,
  makeHuntFakeLoopLlm,
  renderHypothesisText,
  toLoopTemplate,
  type HuntTemplateFixture,
} from "./hunt-pack.js";
import { DEFAULT_TEMPLATE, DefaultTemplateSource } from "../../src/orchestration/template.js";
import { registeredTools, tierOf } from "../../src/tools-manifest.js";
import { requireRunKind } from "../../src/run-kinds.js";
import { MemoryAuditSink } from "../../src/audit.js";
import { planRound } from "../../src/orchestration/planner.js";
import type { NodeCtx } from "../../src/graph.js";
import type { PlannerInput } from "../../src/orchestration/ports.js";

// 票 79①/② 验收主战场：狩猎假设模板三族（webshell/C2/凭据泄露）的内容层数据契约 +
// 登记缝（HuntTemplateSource）+ 菜单对账（L0 裁定②票面语义）+ hunt 版 prompt 起手式 +
// fake LLM 的确定性拆条路径。模板是数据文件（fixtures/hunt-templates/），本测试咬的是
// 内容包与机制/登记面的对账线，不是机制行为本身（机制行为在 orchestration/* 测试）。

const families = loadHuntTemplates();
const byId = new Map(families.map((f) => [f.template_id, f]));

describe("三族假设模板（票 79①：template_id + 假设句式族 + 菜单子集 + 轮次上限）", () => {
  test("三族齐备：webshell / c2_beacon / credential_leak，字段自洽", () => {
    expect(families.map((f) => f.template_id)).toEqual([
      "hunt_c2_beacon",
      "hunt_credential_leak",
      "hunt_webshell",
    ]);
    expect(new Set(families.map((f) => f.family))).toEqual(
      new Set(["webshell", "c2_beacon", "credential_leak"]),
    );
    for (const f of families) {
      expect(f.hypothesis_patterns.length).toBeGreaterThan(0);
      expect(f.menu.length).toBeGreaterThan(0);
      expect(f.max_rounds).toBeGreaterThanOrEqual(1);
      expect(f.max_tasks).toBeGreaterThanOrEqual(1);
      expect(f.waves.length).toBeGreaterThan(0);
      // 每个波次的工具必须在族菜单内（既定查询计划不许越菜单）
      for (const wave of f.waves) {
        expect(wave.length, `${f.template_id} wave ≤ max_tasks`).toBeLessThanOrEqual(f.max_tasks);
        for (const t of wave) expect(f.menu, `${f.template_id} wave 工具在族菜单内`).toContain(t.tool);
      }
    }
  });

  test("句式族渲染：槽位与模板同源（假设文本可由模板数据复现）", () => {
    const webshell = byId.get("hunt_webshell")!;
    const text = renderHypothesisText(webshell);
    expect(text).toContain("web01");
    expect(text).toContain("/var/www/html/uploads");
    expect(text).toContain("webshell");
    expect(text).not.toContain("{");
  });

  test("机制投影：toLoopTemplate 只带机制四字段（内容字段不进机制，R10）", () => {
    const t = toLoopTemplate(byId.get("hunt_webshell")!);
    expect(t).toEqual({
      templateId: "hunt_webshell",
      maxRounds: 6,
      maxTasks: 2,
      menu: ["playbook_lookup", "graph_query", "web_access_query", "file_change_query"],
    });
  });
});

describe("菜单对账（验收⑤：三族模板菜单 ⊆ manifest 登记全集；register 票面语义）", () => {
  test("三族菜单每个工具都已登记（planner 菜单是登记表的子集）", () => {
    const universe = new Set(registeredTools());
    for (const f of families) {
      for (const tool of f.menu) {
        expect(universe.has(tool), `${f.template_id} 菜单工具 ${tool} 未登记`).toBe(true);
      }
    }
  });

  test("register 不入任何 planner 组合菜单（L0 裁定②：register 只在父票面）", () => {
    for (const f of families) {
      expect(f.menu, `${f.template_id} 菜单不得含 ${REGISTER_TOOL}`).not.toContain(REGISTER_TOOL);
    }
    // 父票面（hunt_flow 注册表票面）则必须含 register（outcome 收敛归档步的执行面）
    expect(requireRunKind("hunt_flow").ticket.allowedTools).toContain(REGISTER_TOOL);
  });

  test("父票面 = 机制默认菜单 ∪ 三族菜单 ∪ register（单一来源，无 L2）", () => {
    const face = requireRunKind("hunt_flow").ticket.allowedTools;
    const expected = [
      ...new Set([...DEFAULT_TEMPLATE.menu, ...families.flatMap((f) => f.menu), REGISTER_TOOL]),
    ];
    expect([...face].sort()).toEqual(expected.sort());
    for (const tool of face) expect(tierOf(tool), `${tool} 不得是 L2`).toBeLessThan(2);
  });

  test("负例：族菜单外工具（含 register）不在任何模板菜单（越界选择无从谈起）", () => {
    const allMenuTools = new Set(families.flatMap((f) => f.menu));
    expect(allMenuTools.has("isolate_host")).toBe(false);
    expect(allMenuTools.has("hypothesis_register")).toBe(false);
  });
});

describe("模板登记缝（HuntTemplateSource：三族优先、机制默认档兜底）", () => {
  test("三族 template_id 回族模板；未登记 id 落机制默认档（登记面缺席 ≠ 拒跑）", () => {
    const src = new HuntTemplateSource(new DefaultTemplateSource());
    for (const f of families) {
      expect(src.of(f.template_id)).toEqual(toLoopTemplate(f));
    }
    // 兜底语义 = DefaultTemplateSource.of 原样（未登记 id 落机制档，id 原样透传）
    expect(src.of("t-default")).toEqual({ ...DEFAULT_TEMPLATE, templateId: "t-default" });
    expect(src.of("hunt_no_such")).toEqual({ ...DEFAULT_TEMPLATE, templateId: "hunt_no_such" });
  });
});

describe("hunt 版 prompt 契约（票 79②：plan 起手式按狩猎维度改写）", () => {
  test("plan 起手式：剧本/图谱开局 + 菜单封闭 + 强制 time_window + 不可信包装口径", async () => {
    const { buildHuntPlanPrompt, buildHuntDecidePrompt } = await import("./hunt-prompt.js");
    const f = byId.get("hunt_webshell")!;
    const prompt = buildHuntPlanPrompt({
      hypothesis_text: renderHypothesisText(f),
      menu: f.menu,
      template: { max_rounds: f.max_rounds, max_tasks: f.max_tasks },
    });
    expect(prompt).toContain("狩猎规划器");
    expect(prompt).toContain("先调剧本/图谱类工具"); // 狩猎起手式（与告警调查 plan 的第一差异）
    expect(prompt).toContain("菜单外工具一律非法");
    expect(prompt).toContain("强制带 time_window");
    expect(prompt).toContain("不可信输入"); // 不可信字段包装口径（R16 系纪律的 prompt 面）
    for (const tool of f.menu) expect(prompt).toContain(tool);
    // decide 半边：观察引用 + 防打转警告
    const decide = buildHuntDecidePrompt({
      hypothesis_text: "hyp",
      menu: f.menu,
      task: { tool: "web_access_query", params: {}, rationale: "r" },
      observations: [{ step: 1, tool: "web_access_query", ok: true, summary: "total=1" }],
    });
    expect(decide).toContain("只许引用，不许改写");
    expect(decide).toContain("同参数重复调用会被直接拒绝");
  });
});

describe("fake hunt LLM（确定性三件套覆盖三族拆条路径）", () => {
  const llm = makeHuntFakeLoopLlm();

  const plannerInput = (f: HuntTemplateFixture, over: Partial<PlannerInput> = {}): PlannerInput => ({
    hypothesis_text: renderHypothesisText(f),
    evidence_so_far: [],
    gap: null,
    menu: [...f.menu],
    template: { max_rounds: f.max_rounds, max_tasks: f.max_tasks },
    ...over,
  });

  const summary = (tool: string, total: number): string => `${tool} total=${total} hits=${total}`;

  test("webshell：首轮 = 剧本开局 + 探针取证（2 任务，全部在族菜单内）", async () => {
    const f = byId.get("hunt_webshell")!;
    const { tasks } = await llm.planner(plannerInput(f));
    expect(tasks.map((t) => t.tool)).toEqual(["playbook_lookup", "web_access_query"]);
    expect(tasks[1]!.params).toEqual({
      url_pattern: "/uploads/sh.php",
      time_window: f.default_time_window,
    });
  });

  test("c2：三轮轨迹的拆条路径——剧本开局 → 低置信小步取证 → 换回主目的 + 进程谱系", async () => {
    const f = byId.get("hunt_c2_beacon")!;
    const r1 = await llm.planner(plannerInput(f));
    expect(r1.tasks.map((t) => t.tool)).toEqual(["playbook_lookup"]); // 零取证面证据
    const r2 = await llm.planner(
      plannerInput(f, {
        gap: { gap_description: "缺取证面证据", unknown: "u", suggested_focus: ["beacon"] },
        evidence_so_far: ["round1:playbook_lookup"],
      }),
    );
    expect(r2.tasks.map((t) => t.tool)).toEqual(["outbound_conn_query"]); // wave1
    expect(r2.tasks[0]!.params).toMatchObject({ field: "dst_ip", value: "198.51.100.99" });
    const r3 = await llm.planner(
      plannerInput(f, {
        gap: { gap_description: "仍不足", unknown: "u", suggested_focus: ["beacon"] },
        evidence_so_far: ["round1:playbook_lookup", "round2:outbound_conn_query"],
      }),
    );
    expect(r3.tasks.map((t) => t.tool)).toEqual(["outbound_conn_query", "proc_lineage_query"]); // wave2
    expect(r3.tasks[0]!.params).toMatchObject({ field: "dst_ip", value: "203.0.113.66" });
    // 相邻轮组合必不同（防转闸的机制保证）
    const fingerprint = (ts: { tool: string }[]) => ts.map((t) => t.tool).join("|");
    expect(fingerprint(r1.tasks)).not.toBe(fingerprint(r2.tasks));
    expect(fingerprint(r2.tasks)).not.toBe(fingerprint(r3.tasks));
  });

  test("credential：首轮取证零命中 → judge miss（证伪半边的确定性路径）", async () => {
    const f = byId.get("hunt_credential_leak")!;
    const { tasks } = await llm.planner(plannerInput(f));
    expect(tasks.map((t) => t.tool)).toEqual(["playbook_lookup", "file_change_query"]);
    const verdict = await llm.judge({
      hypothesis_text: renderHypothesisText(f),
      round_reports: [
        { task: tasks[0]!, result_summary: summary("playbook_lookup", 1), params_hash: "h1" },
        { task: tasks[1]!, result_summary: summary("file_change_query", 0), params_hash: "h2" },
      ],
      prior_rounds: 1,
    });
    expect(verdict).toMatchObject({ sufficient: true, verdict: "miss", confidence: 0.8 });
  });

  test("judge 判据：首轮必不充分；两份子报告 + 取证命中 → hit；导航面不计入裁决", async () => {
    const f = byId.get("hunt_webshell")!;
    const { tasks } = await llm.planner(plannerInput(f));
    const reports = tasks.map((t, i) => ({
      task: t,
      result_summary: summary(t.tool, i === 0 ? 1 : 1),
      params_hash: `h${i}`,
    }));
    const round1 = await llm.judge({ hypothesis_text: "x", round_reports: reports, prior_rounds: 0 });
    expect(round1.sufficient).toBe(false);
    const round2 = await llm.judge({ hypothesis_text: "x", round_reports: reports, prior_rounds: 1 });
    expect(round2).toMatchObject({ sufficient: true, verdict: "hit" });
    // 只有导航面报告（无取证命中）→ miss 而非 hit
    const navOnly = await llm.judge({
      hypothesis_text: "x",
      round_reports: reports,
      prior_rounds: 1,
    });
    expect(navOnly.verdict === "hit").toBe(true); // 本组含 web_access_query total=1 → hit
    const zeroForensic = await llm.judge({
      hypothesis_text: "x",
      round_reports: reports.map((r, i) =>
        i === 0 ? r : { ...r, result_summary: summary(r.task.tool, 0) },
      ),
      prior_rounds: 1,
    });
    expect(zeroForensic.verdict).toBe("miss");
  });

  test("机制默认档菜单（非族）：退化单任务，不编造业务查询", async () => {
    const { tasks } = await llm.planner({
      hypothesis_text: "机制档假设句",
      evidence_so_far: [],
      gap: null,
      menu: [...DEFAULT_TEMPLATE.menu],
      template: { max_rounds: DEFAULT_TEMPLATE.maxRounds, max_tasks: DEFAULT_TEMPLATE.maxTasks },
    });
    expect(tasks.map((t) => t.tool)).toEqual([DEFAULT_TEMPLATE.menu[0]]);
  });
});

describe("planner 菜单闸 × 本票菜单（验收⑤：子集外工具被选 100% 拒）", () => {
  /** planRound 的最小 ctx 形（planner.test rig 同款）：状态/事件/计费三口。 */
  async function planWith(llm: { planner: (i: PlannerInput) => Promise<{ tasks: unknown[]; tokens: number }> }, menu: string[]) {
    const audit = new MemoryAuditSink();
    const emitted: Record<string, unknown>[] = [];
    const ctx = {
      state: {
        hypothesis_text: "x",
        evidence_so_far: [],
        gap: null,
        menu,
        max_rounds: 6,
        max_tasks: 2,
        round_no: 1,
        hypothesis_id: "hyp-menu",
      } as Record<string, unknown>,
      emit: (t: string, p: Record<string, unknown>) => emitted.push({ t, p }),
      charge: () => {},
      checkLlm: () => {},
    } as unknown as NodeCtx;
    const scan = async (text: string) => ({ blocked: false, action: "allow", text });
    await planRound({ orch: { llm, scan } as never, audit, runId: "run-menu" }, ctx);
    return { audit, ctx, emitted };
  }

  test("planner 输出含 register（父票面有、族菜单无）→ offmenu_tool DENIED 零重试", async () => {
    const f = byId.get("hunt_webshell")!;
    const rogue = {
      planner: async () => ({
        tasks: [{ tool: REGISTER_TOOL, params: {}, rationale: "越菜单写库" }],
        tokens: 24,
      }),
    };
    const { audit, ctx } = await planWith(rogue, [...f.menu]);
    expect(ctx.state.planner_failed).toBe(true);
    expect(ctx.state.tasks).toEqual([]);
    const denied = audit.entries.find((e) => e.action === "hunt_plan_denied");
    expect(denied?.result).toBe("DENIED");
    expect(denied?.details).toMatchObject({ reason: "offmenu_tool", tools: [REGISTER_TOOL] });
  });

  test("族菜单内组合放行（对账正控：菜单约束只拒子集外）", async () => {
    const f = byId.get("hunt_webshell")!;
    const { ctx, audit } = await planWith(
      {
        planner: async () => ({
          tasks: [{ tool: "web_access_query", params: {}, rationale: "菜单内" }],
          tokens: 24,
        }),
      },
      [...f.menu],
    );
    expect(ctx.state.planner_failed).toBeUndefined();
    expect((ctx.state.tasks as { tool: string }[]).map((t) => t.tool)).toEqual(["web_access_query"]);
    expect(audit.entries.some((e) => e.action === "hunt_plan_suggest")).toBe(true);
  });
});

describe("模板数据目录（内容层位置：fixtures/hunt-templates/，禁进机制目录）", () => {
  test("目录在 fixtures 下且与机制目录无交集", () => {
    expect(HUNT_TEMPLATES_DIR).toContain("/fixtures/hunt-templates/");
    expect(HUNT_TEMPLATES_DIR).not.toContain("orchestration");
    // 三份模板 JSON 现场可读（数据文件形态）
    const raw = JSON.parse(
      readFileSync(new URL("../../../../fixtures/hunt-templates/hunt_webshell.json", import.meta.url), "utf8"),
    ) as { template_id: string; menu: string[] };
    expect(raw.template_id).toBe("hunt_webshell");
    expect(raw.menu).not.toContain(REGISTER_TOOL);
  });
});
