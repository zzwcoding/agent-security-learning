// m5 调查 worker · 狩猎业务内容包（票 79①）：假设模板三族的装载、登记与菜单单一来源。
//
// 分层铁律的兑现形态：模板是数据文件（fixtures/hunt-templates/*.json——内容层位置），
// 本件只有装载/对账/渲染逻辑，零机制代码；机制目录（src/orchestration/）零触碰——
// 消费的只有 m14 公开接口（TemplateSource/LoopTemplate 格式契约，纯类型）与机制默认档
// （template.ts 的 DEFAULT_TEMPLATE 公开导出）。装配层（index.ts）经既有 template 注册缝
// 登记：HuntTemplateSource 优先回三族模板，未登记 id 落机制默认档（DefaultTemplateSource
// 的「登记面缺席 ≠ 拒跑」口径原样保留——机制测试与 INV-11 rig 不受影响）。
//
// 菜单单一来源（票 79 接管 run-kinds 注释预告的收敛点）：
//   huntFlowTicketFace() = 机制默认菜单 ∪ 三族菜单 ∪ hypothesis_register（L0 裁定②的
//   父票面语义：planner 只读面 + register 只给 outcome 收敛归档步；register 不入任何
//   planner 组合菜单——对账测试钉死，菜单外选择由 planner 契约拒（T04））。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TEMPLATE } from "../../src/orchestration/template.js";
import type { LoopLlm, LoopTemplate, TemplateSource } from "../../src/orchestration/ports.js";
import { FakeLoopGap } from "../../src/orchestration/llm-stubs.js";

/** 模板数据目录（内容层位置：fixtures/hunt-templates/，票面钦点位之一）。 */
export const HUNT_TEMPLATES_DIR = fileURLToPath(new URL("../../../../fixtures/hunt-templates/", import.meta.url));

/** L0 裁定②：register 只在父票面（outcome 收敛归档步），永不进 planner 组合菜单。 */
export const REGISTER_TOOL = "hypothesis_register";

/** 模板 fixture 形状（内容层数据契约——比机制 LoopTemplate 多内容字段：句式族/槽位/既定查询计划）。
 *  机制格式契约（templateId/maxRounds/maxTasks/menu）逐字段对齐 m14 卡模板登记面。 */
export interface HuntTemplateFixture {
  template_id: string;
  family: string;
  title: string;
  /** 假设句式族：{slot} 占位（example_slots 供给标准实例）。 */
  hypothesis_patterns: string[];
  /** planner 能力子集（菜单外选择由 planner 契约拒绝，T04）。 */
  menu: string[];
  max_rounds: number;
  max_tasks: number;
  default_time_window: { from: string; to: string };
  example_slots: Record<string, string>;
  /** 既定查询计划（wave = 一轮的任务组合；剧本库 queries 的可执行化）——fake LLM 的
   *  确定性拆条路径数据源，真 LLM（票 81）把它当 few-shot 母本。 */
  waves: { tool: string; params: Record<string, unknown>; rationale: string }[][];
}

/** 装载模板目录（*.json 逐文件；空目录 = 无内容模板，对账测试会红——内容包不能缺席）。 */
export function loadHuntTemplates(dir: string = HUNT_TEMPLATES_DIR): HuntTemplateFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as HuntTemplateFixture)
    .sort((a, b) => a.template_id.localeCompare(b.template_id));
}

/** fixture → 机制 LoopTemplate（m14 格式契约的投影：只带机制四字段，内容字段不进机制）。 */
export function toLoopTemplate(f: HuntTemplateFixture): LoopTemplate {
  return { templateId: f.template_id, maxRounds: f.max_rounds, maxTasks: f.max_tasks, menu: [...f.menu] };
}

/** 模板登记面（票 79① 的注册缝实现）：三族模板优先，未登记 id 落机制默认档。 */
export class HuntTemplateSource implements TemplateSource {
  private readonly byId: Map<string, HuntTemplateFixture>;

  constructor(
    private readonly fallback: TemplateSource,
    private readonly families: HuntTemplateFixture[] = loadHuntTemplates(),
  ) {
    this.byId = new Map(families.map((f) => [f.template_id, f]));
  }

  of(templateId: string): LoopTemplate | null {
    const hit = this.byId.get(templateId);
    if (hit) return toLoopTemplate(hit);
    return this.fallback.of(templateId);
  }

  /** 内容层全量（e2e/对账测试消费；机制层不经此）。 */
  get all(): HuntTemplateFixture[] {
    return [...this.families];
  }
}

/** hunt_flow 父票面（L0 裁定②的单一来源）：机制默认菜单 ∪ 三族菜单 ∪ register。
 *  run-kinds.ts 注册表消费——「票面 ⊆ manifest」由 tools-manifest.test 咬死。 */
export function huntFlowTicketFace(families: HuntTemplateFixture[] = loadHuntTemplates()): string[] {
  return [...new Set([...DEFAULT_TEMPLATE.menu, ...families.flatMap((f) => f.menu), REGISTER_TOOL])];
}

// ---------- fake hunt LLM（确定性三件套，覆盖三族假设的拆条路径） ----------

/** 取证面工具（hit/miss 判定只认取证维度的 total；剧本/图谱是导航面不参与裁决）。 */
const FORENSIC_TOOLS = new Set([
  "file_change_query",
  "outbound_conn_query",
  "web_access_query",
  "proc_lineage_query",
]);

const TOKENS_PER_CALL = 24;

/** 槽位渲染：{slot} → example_slots；{time_window} → default_time_window（JSON 值直替）。 */
function renderWaveParams(
  params: Record<string, unknown>,
  fixture: HuntTemplateFixture,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      if (v === "{time_window}") {
        out[k] = { ...fixture.default_time_window };
        continue;
      }
      const slot = /^\{(.+)\}$/.exec(v)?.[1];
      out[k] = slot !== undefined && fixture.example_slots[slot] !== undefined ? fixture.example_slots[slot]! : v;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** 族识别（fake 纪律：只吃输入结构）：planner 输入的菜单 = 模板菜单原样注入，按集合
 *  相等签名回族。机制默认档菜单不属任何族 → 退化单任务（FakeLoopPlanner 的保守形态）。 */
function familyOfMenu(menu: readonly string[], families: HuntTemplateFixture[]): HuntTemplateFixture | null {
  const key = [...menu].sort().join("|");
  return families.find((f) => [...f.menu].sort().join("|") === key) ?? null;
}

/** 确定性 hunt 三件套（测试/e2e 用；真 adapter 票 81）：
 *  · planner：族签名 → 模板既定查询计划。无 gap → wave[0]（剧本开局 + 首轮取证）；
 *    有 gap → waves[min(evidence_so_far.length, waves.length-1)]（换维度补查——相邻轮
 *    组合必不同，防转闸的机制保证）。
 *  · judge：sufficient = 已有既往轮且本轮 ≥2 份子报告（证据充分性的确定性代理判据）；
 *    verdict = hit 当且仅当取证面报告有 total>0（剧本/图谱导航面不计入裁决）。
 *  · gap：judge 缺口直翻（FakeLoopGap 同款）。 */
export function makeHuntFakeLoopLlm(families: HuntTemplateFixture[] = loadHuntTemplates()): LoopLlm {
  return {
    async planner(input) {
      const family = familyOfMenu(input.menu, families);
      if (!family || family.waves.length === 0) {
        // 非族菜单（机制默认档）：单任务退化形态——只吃菜单结构，不编造业务查询
        const first = input.menu[0];
        return {
          tasks: first
            ? [{ tool: first, params: { q: input.hypothesis_text.slice(0, 64) }, rationale: "机制档首轮：按假设句直查首选面" }]
            : [],
          tokens: TOKENS_PER_CALL,
        };
      }
      const waveIdx = input.gap
        ? Math.min(input.evidence_so_far.length, family.waves.length - 1)
        : 0;
      const tasks = family.waves[waveIdx]!.map((w) => ({
        tool: w.tool,
        params: renderWaveParams(w.params, family),
        rationale: w.rationale,
      }));
      return { tasks, tokens: TOKENS_PER_CALL };
    },

    async judge(input) {
      const reports = input.round_reports;
      const forensicHit = reports.some(
        (r) =>
          FORENSIC_TOOLS.has(r.task.tool) &&
          Number(/total=(\d+)/.exec(r.result_summary)?.[1] ?? "0") > 0,
      );
      const sufficient = (input.prior_rounds ?? 0) >= 1 && reports.length >= 2;
      if (sufficient) {
        return {
          sufficient: true,
          verdict: forensicHit ? "hit" : "miss",
          confidence: 0.8,
          gap_description: null,
          tokens: TOKENS_PER_CALL,
        };
      }
      return {
        sufficient: false,
        verdict: null,
        confidence: 0.4,
        gap_description: `取证面证据不足（既往 ${input.prior_rounds ?? 0} 轮、本轮 ${reports.length} 份子报告），按剧本换维度补查`,
        tokens: TOKENS_PER_CALL,
      };
    },

    async gap(input) {
      return { ...(await new FakeLoopGap().gap(input)), tokens: TOKENS_PER_CALL };
    },
  };
}

/** 假设句实例（e2e 布景用）：句式族 + 标准槽位 → 假设文本（与模板数据同源）。 */
export function renderHypothesisText(f: HuntTemplateFixture, patternIdx = 0): string {
  const pattern = f.hypothesis_patterns[patternIdx];
  if (!pattern) throw new Error(`template ${f.template_id} 缺句式 #${patternIdx}`);
  let text = pattern;
  for (const [k, v] of Object.entries(f.example_slots)) {
    text = text.split(`{${k}}`).join(v);
  }
  return text;
}
