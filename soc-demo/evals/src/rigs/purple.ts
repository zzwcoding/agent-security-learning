// m11 eval 体系 · 紫队闭环 rig（票 81 · spec T23）：attack fixture → 假设源 → 自主发现率
//（ground truth 断言）+ 盲区报告。
//
// spec 锚点：specs/orchestration-loop.md 验收表 T23「紫队：attack fixture→假设→发现判定
// 走 ground truth 断言（不靠 LLM 自评）」→ 本件 `discovery_rate_ground_truth`。
//
// 闭环口径（CONTEXT.md「自主发现率」）：
//   发现 = 狩猎循环在预算内自主收敛 concluded ∧ 末轮 judge hit ∧ 映射表 ground truth
//   全部签名三重验通过（①轨迹执行了签名查询 ②该查询取证面 total>0 ③语料确有该痕迹）。
//   ——judge 结论只是发现的一半判据；另一半是 ground truth 机器复核，judge 评分不进门槛
//   （决策 #10 沿用），发现判定不靠 LLM 自评。
//   未发现 = 盲区报告：循环 gap_analyzer 的结构化缺口（真节点产物）+ 映射表标注的缺失
//   证据链与该补的工具维度，按假设族聚类（哪族最弱）。
//
// 预算口径（防「无上限烧 token 必发现」注水）：轮数 ≤ 机制硬顶 20（票 77 assertRoundsBudget
// 档）且 ≤ 模板 max_rounds 内容档；loop LLM token ≤ hunt_flow run 档 500k（票 77 分档）；
// cancelled（预算/防转/人停）不冒充发现也不冒充 refuted。
//
// 边界纪律（R2）：本件零 services 直引——布景组装全部收编 hunting rig 的进程内场景件
//（runHuntScene），假设源映射数据落 fixtures/eval/attack/hypothesis-map.json（loader 对
// 非目录项天然跳过，既有 33 条用例清单零扰动）。
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { EVAL_RESULTS_DIR, PRICE_PER_M } from "../report.js";
import type { CheckResult } from "../types.js";
import { check } from "./shared.js";
import {
  loadHuntTemplates,
  renderHypothesisText,
  runHuntScene,
  type HuntFamilyTrajectory,
  type HuntTemplateFixture,
} from "./hunting.js";

/** 攻击 fixture 目录制（映射表与 11 例目录都在这里）。 */
const ATTACK_DIR = fileURLToPath(new URL("../../../fixtures/eval/attack/", import.meta.url));
/** SIEM 语料（ground truth 痕迹的在场性检查面——与 FixtureSiem 同一数据源文件）。 */
const ALERTS_DIR = fileURLToPath(new URL("../../../fixtures/alerts/", import.meta.url));
export const HYPOTHESIS_MAP_PATH = join(ATTACK_DIR, "hypothesis-map.json");

// ---- 预算档（票 77 budgetForKind("hunt_flow") 分档；布景内循环上限的静态口径） ----
export const PURPLE_BUDGET = {
  /** 机制硬顶：票 77 assertRoundsBudget 档（max_rounds=20）。 */
  max_rounds_hard_cap: 20,
  /** 内容档：四族模板 max_rounds 全 6（hunt-templates 数据面）。 */
  max_rounds_template_cap: 6,
  /** hunt_flow run 级 token 档（票 77 BUDGET_TIERS：500k）。 */
  run_token_cap: 500_000,
} as const;

// ---------- 映射表（数据契约 + fail-closed 装载） ----------

export interface PurpleSignature {
  tool: string;
  /** params 里的绑定键（outbound/file_change=value、web_access=url_pattern、proc=process）。 */
  param: string;
  value: string;
  /** 语料痕迹文件名（fixtures/alerts/ 下）——ground truth 的「攻击植入痕迹在场」半边。 */
  traces: string[];
}

export interface PurpleBlindSpotSpec {
  missing_chain: string;
  tool_dimension: string;
}

export interface PurpleMapEntry {
  fixture: string;
  attack: string;
  objective: string;
  family: string;
  template_id: string;
  pattern_idx: number;
  slots: Record<string, string>;
  ground_truth: {
    expected: "hit" | "miss";
    note: string;
    signatures: PurpleSignature[];
    blind_spot: PurpleBlindSpotSpec | null;
  };
}

export interface PurpleMap {
  seed: string;
  mappings: PurpleMapEntry[];
}

/** 装载映射表（fail-closed：结构不对当场点名，不静默少一例）。 */
export function loadPurpleMap(path: string = HYPOTHESIS_MAP_PATH): PurpleMap {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PurpleMap> & { _note?: string };
  if (!Array.isArray(raw.mappings) || raw.mappings.length === 0) {
    throw new Error(`紫队映射表缺 mappings（${path}）`);
  }
  if (typeof raw.seed !== "string" || raw.seed.length === 0) {
    throw new Error(`紫队映射表缺 seed（${path}）`);
  }
  const problems: string[] = [];
  for (const m of raw.mappings) {
    const where = `映射 ${m.fixture ?? "?"}`;
    if (typeof m.fixture !== "string" || m.fixture.length === 0) problems.push(`${where}: 缺 fixture 名`);
    if (typeof m.template_id !== "string") problems.push(`${where}: 缺 template_id`);
    if (m.ground_truth?.expected !== "hit" && m.ground_truth?.expected !== "miss") {
      problems.push(`${where}: ground_truth.expected 必须 hit|miss`);
    }
    if (m.ground_truth?.expected === "hit" && (!Array.isArray(m.ground_truth?.signatures) || m.ground_truth.signatures.length === 0)) {
      problems.push(`${where}: expected=hit 必须带签名（发现判定的机器复核面）`);
    }
    if (m.ground_truth?.expected === "miss" && !m.ground_truth?.blind_spot) {
      problems.push(`${where}: expected=miss 必须带 blind_spot（缺失证据链 + 工具维度）`);
    }
  }
  if (problems.length > 0) throw new Error(`紫队映射表不合规：\n  - ${problems.join("\n  - ")}`);
  return { seed: raw.seed, mappings: raw.mappings as PurpleMapEntry[] };
}

/** attack 目录制目录名（hypothesis-map.json 是文件不是目录，天然不在清单）。 */
export function listAttackFixtureDirs(dir: string = ATTACK_DIR): string[] {
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort();
}

/** 槽位覆盖克隆（同 template_id，波形 params 按覆盖槽位渲染——确定性 planner 数据源）。 */
function withSlots(f: HuntTemplateFixture, slots: Record<string, string>): HuntTemplateFixture {
  return { ...f, example_slots: { ...f.example_slots, ...slots } };
}

// ---------- ground truth 三重验与发现判定 ----------

export interface PurpleSignatureResult {
  tool: string;
  param: string;
  value: string;
  traces: string[];
  /** ①轨迹执行：签名查询被 planner 组合并 dispatch（round_no 在场 = 执行过）。 */
  executedRound: number | null;
  /** ②取证面命中：该查询的子 run 报告 total=N（N>0 才算取证面有据）。 */
  reportedTotal: number | null;
  /** ③语料在场：痕迹文件存在且含签名值（攻击植入痕迹的独立复核）。 */
  corpusPresent: boolean;
  ok: boolean;
  reason: string;
}

/** 语料痕迹在场：fixtures/alerts/<trace>.json 原文含签名值（读文件不做 SIEM 语义复刻——
 *  独立复核「攻击植入痕迹确实在语料里」，与循环执行解耦）。 */
export function corpusHasTrace(trace: string, value: string, dir: string = ALERTS_DIR): boolean {
  const p = join(dir, `${trace}.json`);
  if (!statSyncSafe(p)) return false;
  return readFileSync(p, "utf8").includes(value);
}

function statSyncSafe(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function evalSignatures(entry: PurpleMapEntry, traj: HuntFamilyTrajectory): PurpleSignatureResult[] {
  return entry.ground_truth.signatures.map((sig) => {
    const round = traj.rounds_full.find((r) =>
      r.tasks.some((t) => t.tool === sig.tool && String(t.params[sig.param]) === sig.value),
    );
    const report = round === undefined ? undefined : traj.taskReports.find((p) => p.round_no === round.round_no && p.tool === sig.tool);
    const total = report === undefined ? null : Number(/total=(\d+)/.exec(report.result_summary)?.[1] ?? NaN);
    const corpusPresent = sig.traces.every((t) => corpusHasTrace(t, sig.value));
    const ok = round !== undefined && report !== undefined && Number.isFinite(total) && (total ?? 0) > 0 && corpusPresent;
    const reason = round === undefined
      ? `签名查询未被执行（${sig.tool} ${sig.param}=${sig.value}）`
      : report === undefined || !Number.isFinite(total)
        ? `签名查询已执行（轮 ${round.round_no}）但子 run 报告缺席`
        : (total ?? 0) <= 0
          ? `签名查询取证面零命中（轮 ${round.round_no} total=0）`
          : corpusPresent
            ? `三重验通过（轮 ${round.round_no} total=${total}，语料痕迹在场）`
            : `语料缺痕迹：${sig.traces.filter((t) => !corpusHasTrace(t, sig.value)).join(",")}`;
    return { tool: sig.tool, param: sig.param, value: sig.value, traces: [...sig.traces], executedRound: round?.round_no ?? null, reportedTotal: total, corpusPresent, ok, reason };
  });
}

/** 复现 digest（同 seed 同结果的比对面）：只含决策相关确定性字段，墙钟不在内。 */
function sceneDigest(traj: HuntFamilyTrajectory): string {
  const decision = {
    status: traj.status,
    rounds: traj.rounds_full.map((r) => ({
      round_no: r.round_no,
      tools: r.tasks.map((t) => t.tool),
      params: r.tasks.map((t) => t.params),
      judge: r.judge === null ? null : { sufficient: r.judge.sufficient, verdict: r.judge.verdict },
      gap: r.gap === null ? null : { gap_description: r.gap.gap_description, unknown: r.gap.unknown, suggested_focus: r.gap.suggested_focus },
    })),
    taskReports: traj.taskReports,
    llmTokens: traj.llmTokens,
    llmCalls: traj.llmCalls,
    caseHypothesisIds: traj.caseHypothesisIds,
    noteCount: traj.noteCount,
  };
  return JSON.stringify(decision);
}

// ---------- 报告形状（latest.json 工件族同目录：purple-team.json + purple-cost.csv） ----------

export interface PurpleBlindSpot {
  family: string;
  /** 缺失证据链（映射表标注——哪条证据链缺失）。 */
  missingChain: string;
  /** 该补的工具维度（映射表标注——哪个工具维度该补）。 */
  toolDimension: string;
  /** 循环 gap_analyzer 产物（真节点输出——循环侧自己说的缺口）。 */
  loopGap: { gap_description: string; unknown: string; suggested_focus: string[] } | null;
  /** 未满足的签名（miss 例签名缺位的具体点）。 */
  unsatisfiedSignatures: string[];
}

export interface PurpleFixtureResult {
  fixture: string;
  attack: string;
  objective: string;
  family: string;
  templateId: string;
  patternIdx: number;
  slots: Record<string, string>;
  hypothesisText: string;
  expected: "hit" | "miss";
  discovered: boolean;
  /** 发现判定不失真的自证：discovered === (expected === "hit")——映射错了这里必红。 */
  groundTruthOk: boolean;
  finalStatus: HuntFamilyTrajectory["status"];
  judgeVerdict: string | null;
  rounds: number;
  llmTokens: number;
  llmCalls: number;
  durationMs: number;
  withinBudget: boolean;
  budgetDetail: string;
  signatures: PurpleSignatureResult[];
  digest: string;
  replayDigestEqual: boolean;
  blindSpot: PurpleBlindSpot | null;
}

export interface PurpleCluster {
  family: string;
  misses: number;
  discovered: number;
  fixtures: string[];
  missing_dimensions: string[];
}

/** M507 cost_all.csv 口径的一行 + rounds 列（hunt 桩单值计费全额记 input 列，见 note）。 */
export interface PurpleCostRow {
  case: string;
  family: string;
  template_id: string;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  rounds: number;
  duration_ms: number;
  est_cost_usd: number;
}

export const PURPLE_COST_CSV_HEADER =
  "case,family,template_id,model,input_tokens,cache_read_tokens,output_tokens,total_tokens,rounds,duration_ms,est_cost_usd";

export const PURPLE_COST_NOTE =
  "成本口径续 M507 cost_all.csv（票 77 回测同源）：hunt 桩单值计费 24 tok/次（planner/judge/gap 每次调用），input/output 拆分不可得 → 全额记 input 列、cache_read/output 恒 0；rounds=收敛轮数（M507 无此列，紫队口径增量）；est_cost_usd=占位价格表同 PRICE_PER_M";

export interface PurpleReport {
  run_at: string;
  ticket: string;
  spec_anchor: string;
  seed: string;
  budget: typeof PURPLE_BUDGET & { note: string };
  totals: { fixtures: number; discovered: number; discovery_rate: number };
  by_family: Record<string, { total: number; discovered: number; rate: number | null }>;
  discovery_rate_table: PurpleFixtureResult[];
  blind_spot_clusters: PurpleCluster[];
  weakest_family: string | null;
  costs: { csv: string; rows: number; note: string };
  reproducibility: { double_run_digest_equal: boolean; seed: string; note: string };
  costRows: PurpleCostRow[];
}

export interface PurpleEvalOutcome {
  report: PurpleReport;
  extraChecks: CheckResult[];
}

// ---------- rig 本体（spec T23 锚点） ----------

/** 紫队闭环 eval：11 例 attack fixture 逐例「假设源 → 预算内狩猎循环 → ground truth
 *  发现判定（双跑复现）→ 盲区聚类」。判定全部机器可复核；LLM judge 评分不进任何门槛。 */
export async function discovery_rate_ground_truth(): Promise<PurpleEvalOutcome> {
  const map = loadPurpleMap();
  const base = loadHuntTemplates();
  const byTemplateId = new Map(base.map((t) => [t.template_id, t]));
  const fixtureDirs = listAttackFixtureDirs();

  // 映射 ↔ fixture 目录制逐例对账（yaml attack 标注同源核对——映射表是测试资产）
  const yamlAttack = new Map<string, string>();
  for (const dirName of fixtureDirs) {
    const y = parse(readFileSync(join(ATTACK_DIR, dirName, "test_case.yaml"), "utf8")) as { attack?: string | null };
    yamlAttack.set(dirName, typeof y.attack === "string" ? y.attack : "null");
  }
  const mapFixtures = map.mappings.map((m) => m.fixture).sort();
  const attackMismatches = map.mappings
    .filter((m) => yamlAttack.get(m.fixture) !== m.attack)
    .map((m) => `${m.fixture}: 映射 attack=${m.attack} ≠ fixture yaml attack=${yamlAttack.get(m.fixture) ?? "缺目录"}`);

  const rows: PurpleFixtureResult[] = [];
  for (const entry of map.mappings) {
    const tpl = byTemplateId.get(entry.template_id);
    if (!tpl) throw new Error(`紫队布景中止：模板 ${entry.template_id} 未登记（映射 ${entry.fixture}）`);
    const clone = withSlots(tpl, entry.slots);
    const families = base.map((t) => (t.template_id === entry.template_id ? clone : t));
    const hypothesisText = renderHypothesisText(clone, entry.pattern_idx);
    // 同 seed 双跑：布景零 RNG（fake LLM + fixture 语料 + 确定性 planner/judge/gap），
    // digest 相等即「同 seed 同结果」的机器证据。
    const runA = await runHuntScene({
      template: clone, families,
      hypothesisId: `hyp-purple-${entry.fixture}`, hypothesisText,
    });
    const runB = await runHuntScene({
      template: clone, families,
      hypothesisId: `hyp-purple-${entry.fixture}`, hypothesisText,
    });
    const digestA = sceneDigest(runA);
    const digestB = sceneDigest(runB);

    const signatures = evalSignatures(entry, runA);
    const lastRound = [...runA.rounds_full].sort((a, b) => b.round_no - a.round_no)[0];
    const judgeVerdict = lastRound?.judge?.verdict ?? null;
    const judgeHit = runA.status === "concluded" && judgeVerdict === "hit";
    // 发现 = judge hit ∧ ground truth 签名三重验全过（不靠 LLM 自评——签名逐格机器复核）
    const discovered = judgeHit && signatures.length > 0 && signatures.every((s) => s.ok);
    const expected = entry.ground_truth.expected;
    const cap = Math.min(PURPLE_BUDGET.max_rounds_hard_cap, tpl.max_rounds);
    const budgetDetail = `rounds=${runA.rounds.length}（硬顶 ${PURPLE_BUDGET.max_rounds_hard_cap}/模板 ${tpl.max_rounds}）、llmTokens=${runA.llmTokens}（run 档 ${PURPLE_BUDGET.run_token_cap}）、终态=${runA.status}`;
    const withinBudget = runA.status !== "cancelled" && runA.rounds.length <= cap && runA.llmTokens <= PURPLE_BUDGET.run_token_cap;

    const blindSpot: PurpleBlindSpot | null = discovered ? null : {
      family: entry.family,
      missingChain: entry.ground_truth.blind_spot?.missing_chain ?? "（映射表未标注缺失链——判定失真必红，见 groundTruthOk）",
      toolDimension: entry.ground_truth.blind_spot?.tool_dimension ?? "（映射表未标注工具维度——判定失真必红，见 groundTruthOk）",
      loopGap: (() => {
        // 盲区的循环侧来源 = 最近一次 gap_analyzer 产物（收敛轮 judge 充分 → 末轮无 gap，
        // 缺口要取「循环最后没能闭合的那个缺口」——gapRecords 末条）。
        const gap = runA.gapRecords[runA.gapRecords.length - 1]?.gap ?? null;
        return gap === null ? null : { gap_description: gap.gap_description, unknown: gap.unknown, suggested_focus: [...gap.suggested_focus] };
      })(),
      unsatisfiedSignatures: signatures.filter((s) => !s.ok).map((s) => s.reason),
    };

    rows.push({
      fixture: entry.fixture,
      attack: entry.attack,
      objective: entry.objective,
      family: entry.family,
      templateId: entry.template_id,
      patternIdx: entry.pattern_idx,
      slots: { ...entry.slots },
      hypothesisText,
      expected,
      discovered,
      groundTruthOk: discovered === (expected === "hit"),
      finalStatus: runA.status,
      judgeVerdict,
      rounds: runA.rounds.length,
      llmTokens: runA.llmTokens,
      llmCalls: runA.llmCalls,
      durationMs: runA.durationMs,
      withinBudget,
      budgetDetail,
      signatures,
      digest: digestA,
      replayDigestEqual: digestA === digestB,
      blindSpot,
    });
  }

  // 两份数字：逐例发现率表 + 盲区聚类（哪族最弱）
  const discoveredCount = rows.filter((r) => r.discovered).length;
  const familiesAll = [...new Set(rows.map((r) => r.family))].sort();
  const byFamily: PurpleReport["by_family"] = {};
  for (const f of familiesAll) {
    const sub = rows.filter((r) => r.family === f);
    const hit = sub.filter((r) => r.discovered).length;
    byFamily[f] = { total: sub.length, discovered: hit, rate: hit / sub.length };
  }
  const clusters: PurpleCluster[] = familiesAll
    .map((f) => {
      const sub = rows.filter((r) => r.family === f);
      const misses = sub.filter((r) => !r.discovered);
      return {
        family: f,
        misses: misses.length,
        discovered: sub.length - misses.length,
        fixtures: misses.map((r) => r.fixture),
        missing_dimensions: [...new Set(misses.map((r) => r.blindSpot?.toolDimension ?? ""))].filter((s) => s.length > 0),
      };
    })
    .filter((c) => c.misses > 0)
    .sort((a, b) => b.misses - a.misses || a.family.localeCompare(b.family));
  const weakest = clusters[0]?.family ?? null;

  const costRows: PurpleCostRow[] = rows.map((r) => ({
    case: r.fixture,
    family: r.family,
    template_id: r.templateId,
    model: "FakeHuntLoopLlm",
    input_tokens: r.llmTokens,
    cache_read_tokens: 0,
    output_tokens: 0,
    total_tokens: r.llmTokens,
    rounds: r.rounds,
    duration_ms: r.durationMs,
    est_cost_usd: Number(((r.llmTokens * PRICE_PER_M.input) / 1e6).toFixed(9)),
  }));

  const report: PurpleReport = {
    run_at: new Date().toISOString(),
    ticket: "81-purple-team-eval",
    spec_anchor: "evals/src/rigs/purple.ts::discovery_rate_ground_truth（specs/orchestration-loop.md T23）",
    seed: map.seed,
    budget: {
      ...PURPLE_BUDGET,
      note: "自主发现率口径：预算内 = 轮数 ≤ 机制硬顶 20（票 77 assertRoundsBudget 档）且 ≤ 模板 max_rounds 内容档；loop LLM token ≤ hunt_flow run 档 500k（票 77 分档）；cancelled 不冒充发现——防「无上限烧 token 必发现」注水",
    },
    totals: { fixtures: rows.length, discovered: discoveredCount, discovery_rate: rows.length === 0 ? 0 : discoveredCount / rows.length },
    by_family: byFamily,
    discovery_rate_table: rows,
    blind_spot_clusters: clusters,
    weakest_family: weakest,
    costs: { csv: "eval-results/purple-cost.csv", rows: costRows.length, note: PURPLE_COST_NOTE },
    reproducibility: {
      double_run_digest_equal: rows.every((r) => r.replayDigestEqual),
      seed: map.seed,
      note: "同 seed 同结果：布景零 RNG（fake LLM + fixture 语料 + 确定性 planner/judge/gap），seed=布景版本常量；逐例双跑 digest（决策字段canonical 序列化）相等为机器证据，墙钟不进 digest",
    },
    costRows,
  };

  // —— 场景专项检查（进门槛，与通用断言同权；judge 评分不在此列） ——
  const extraChecks: CheckResult[] = [];
  extraChecks.push(check(
    "purple_map_complete",
    fixtureDirs.length === map.mappings.length && mapFixtures.join(",") === fixtureDirs.join(",") && attackMismatches.length === 0,
    `映射 ${map.mappings.length}/${fixtureDirs.length} 例 attack fixture 全覆盖（fixture 目录制逐一对应）` +
      (attackMismatches.length === 0 ? "" : `；attack 标注失配：${attackMismatches.join("；")}`),
  ));
  const unregistered = map.mappings.filter((m) => !byTemplateId.has(m.template_id) || byTemplateId.get(m.template_id)!.family !== m.family);
  extraChecks.push(check(
    "purple_map_templates_registered",
    unregistered.length === 0 && map.mappings.every((m) => m.pattern_idx >= 0),
    `映射 template_id 全部在 hunt-templates 登记面且 family 对账一致（scenario 全注册的模板半边）` +
      (unregistered.length === 0 ? "" : `；未登记/失配：${unregistered.map((m) => m.template_id).join(",")}`),
  ));
  const truthOff = rows.filter((r) => !r.groundTruthOk);
  extraChecks.push(check(
    "purple_ground_truth_discovery",
    truthOff.length === 0,
    `逐例发现判定 = judge 结论 hit ∧ ground truth 签名三重验（非 LLM 自评）；expected ↔ discovered ${rows.length - truthOff.length}/${rows.length} 对账一致` +
      (truthOff.length === 0 ? "" : `；失真例：${truthOff.map((r) => `${r.fixture}(expected=${r.expected},discovered=${r.discovered})`).join("，")}`),
  ));
  const sigBad = rows.filter((r) => r.discovered && !r.signatures.every((s) => s.ok));
  extraChecks.push(check(
    "purple_hit_signatures_machine_checked",
    sigBad.length === 0,
    `发现例 ${rows.filter((r) => r.discovered).length} 个全部签名三重验（轨迹执行 total>0 语料在场）` +
      (sigBad.length === 0 ? "" : `；签名缺位：${sigBad.map((r) => r.fixture).join(",")}`),
  ));
  const blindMissing = rows.filter((r) => !r.discovered && (r.blindSpot === null || r.blindSpot.loopGap === null || r.blindSpot.missingChain.length === 0 || r.blindSpot.toolDimension.length === 0));
  extraChecks.push(check(
    "purple_miss_blind_spot_reported",
    blindMissing.length === 0,
    `未发现例 ${rows.filter((r) => !r.discovered).length} 个全部出盲区报告（gap_analyzer 产物 + 缺失证据链 + 该补工具维度）` +
      (blindMissing.length === 0 ? "" : `；报告缺席：${blindMissing.map((r) => r.fixture).join(",")}`),
  ));
  const overBudget = rows.filter((r) => !r.withinBudget);
  extraChecks.push(check(
    "purple_budget_within_caps",
    overBudget.length === 0,
    `全部例预算内（轮数 ≤ 硬顶 20 ∧ ≤ 模板档、llmTokens ≤ run 档 500k、零 cancelled——防无上限烧 token 注水）` +
      (overBudget.length === 0 ? "" : `；越界：${overBudget.map((r) => `${r.fixture}[${r.budgetDetail}]`).join("；")}`),
  ));
  const irreproducible = rows.filter((r) => !r.replayDigestEqual);
  extraChecks.push(check(
    "purple_double_run_reproducible",
    irreproducible.length === 0,
    `逐例同 seed 双跑 digest 相等（seed=${map.seed}，布景零 RNG）` +
      (irreproducible.length === 0 ? "" : `；不可复现：${irreproducible.map((r) => r.fixture).join(",")}`),
  ));
  const rateOk = report.totals.discovered === rows.filter((r) => r.discovered).length
    && Math.abs(report.totals.discovery_rate - discoveredCount / Math.max(rows.length, 1)) < 1e-12
    && (weakest === null || clusters[0]!.family === weakest)
    && clusters.every((c) => c.fixtures.length === c.misses);
  extraChecks.push(check(
    "purple_rate_and_weakest_family",
    rateOk,
    `两份数字自洽：发现率 ${discoveredCount}/${rows.length}；盲区聚类 ${clusters.map((c) => `${c.family}=${c.misses}miss`).join(" / ") || "无"}；最弱族=${weakest ?? "n/a"}`,
  ));

  return { report, extraChecks };
}

// ---------- 产物落盘（eval-results/ 工件族：latest.json 同目录，不动 latest.json 本体） ----------

/** 写 eval-results/purple-team.json + purple-cost.csv（M507 口径 + rounds 列）。
 *  latest.json 不动：票 29 双端契约把 buildReport 形状钉死在共享样例（web 消费端共读），
 *  紫队数字以同目录同口径工件族并列——并入 latest.json 属形状变更，归 L0 裁定。 */
export function writePurpleArtifacts(outcome: PurpleEvalOutcome): { json: string; csv: string } {
  mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  const json = EVAL_RESULTS_DIR + "purple-team.json";
  const csv = EVAL_RESULTS_DIR + "purple-cost.csv";
  writeFileSync(json, JSON.stringify(outcome.report, null, 2) + "\n");
  const lines = outcome.report.costRows.map((r) =>
    [r.case, r.family, r.template_id, r.model, r.input_tokens, r.cache_read_tokens, r.output_tokens, r.total_tokens, r.rounds, r.duration_ms, r.est_cost_usd].join(","),
  );
  writeFileSync(csv, [PURPLE_COST_CSV_HEADER, ...lines].join("\n") + "\n");
  return { json, csv };
}
