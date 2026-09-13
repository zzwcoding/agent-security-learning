// 票 93② · fake 栈收敛语义：judge 判据排除 failed 子报告（防御纵深半边）。
//
// 缺陷形态（票 84 附录②实测证据）：FakeLoopJudge 的 allOk 判据只查 result_summary 非空
// ——failed 子 run 的报告折成 `failed:node_error`（await-children.ts 的 error 终局折账
// 口径，params_hash=""）恰好非空 → 轮 2 照判 sufficient+hit → 零有效证据的 hit 建案。
//
// 修后判据：failed 子报告（failed:* / params_hash 空 / result_summary 空）不是证据——
// 不充分进 gap 接力（fail-closed：宁可多轮，绝不带病收敛）。既有 ok 形态的判据零放松
// （all-ok + 有既往轮 → sufficient+hit 的确定性轨迹原样，loop.test 等桩消费面不变）。
import { describe, expect, test } from "vitest";
import { FakeLoopJudge, isFailedReport, makeFakeLoopLlm } from "./llm-stubs.js";
import type { RoundReport } from "./ports.js";

const report = (over: Partial<RoundReport> = {}): RoundReport => ({
  task: { tool: "kb_lookup", params: { q: "x" }, rationale: "r" },
  result_summary: "kb_lookup total=3 hits=3",
  params_hash: "hash-abc",
  ...over,
});

const judgeInput = (reports: RoundReport[], priorRounds = 1) => ({
  hypothesis_text: "假设句",
  round_reports: reports,
  prior_rounds: priorRounds,
});

describe("isFailedReport（failed 子报告形态判别：await-children 折账口径）", () => {
  test("error 终局折账形（failed:<code> + params_hash 空）= failed；ok 观察形 = 非 failed", () => {
    expect(isFailedReport(report({ result_summary: "failed:node_error", params_hash: "" }))).toBe(true);
    expect(isFailedReport(report({ result_summary: "failed:parent_cancelled", params_hash: "" }))).toBe(true);
    expect(isFailedReport(report({ result_summary: "", params_hash: "hash" }))).toBe(true);
    expect(isFailedReport(report({ result_summary: "stub observation for kb_lookup" }))).toBe(false);
    expect(isFailedReport(report({ result_summary: "web_access_query total=1 hits=1" }))).toBe(false);
  });
});

describe("FakeLoopJudge 判据（票 93②：failed 子报告不是有效证据）", () => {
  test("既有行为不放松：子报告全 ok + 有既往轮 → sufficient+hit（确定性收敛轨迹原样）", async () => {
    const verdict = await new FakeLoopJudge().judge(
      judgeInput([report(), report({ task: { tool: "siem_query", params: {}, rationale: "r" }, params_hash: "hash-2" })]),
    );
    expect(verdict).toMatchObject({ sufficient: true, verdict: "hit", confidence: 0.7 });
  });

  test("failed 子报告（票 84 附录②缺陷形）→ 不充分：verdict=null 进 gap 接力，不收敛", async () => {
    // 票 84 附录②同款：子 run 全部 failed(node_error:execute)，报告折成 failed:node_error
    const verdict = await new FakeLoopJudge().judge(
      judgeInput([
        report({ result_summary: "failed:node_error", params_hash: "" }),
        report({ result_summary: "failed:node_error", params_hash: "" }),
      ]),
    );
    expect(verdict.sufficient).toBe(false);
    expect(verdict.verdict).toBeNull();
    expect(verdict.gap_description).not.toBeNull();
  });

  test("旧判据的「恰好非空」漏洞钉死：failed:* 摘要单独出现也不算证据（含混排 ok/failed）", async () => {
    const mixed = await new FakeLoopJudge().judge(
      judgeInput([report(), report({ result_summary: "failed:node_error", params_hash: "" })]),
    );
    expect(mixed.sufficient).toBe(false);
    const emptySummary = await new FakeLoopJudge().judge(
      judgeInput([report({ result_summary: "" }), report({ params_hash: "hash-2" })]),
    );
    expect(emptySummary.sufficient).toBe(false);
  });

  test("首轮（无既往轮）依旧不充分——守卫只加严 failed 半边，轮次语义零变化", async () => {
    const verdict = await new FakeLoopJudge().judge(judgeInput([report(), report()], 0));
    expect(verdict.sufficient).toBe(false);
    expect(verdict.verdict).toBeNull();
  });
});

describe("makeLoopLlm 装配总口（机制层缺省：fake → 机制桩三件套）", () => {
  test("fake 档回机制确定性桩（测试消费面不变；生产 fake 的狩猎换件在内容层 makeHuntLoopLlm）", async () => {
    const llm = makeFakeLoopLlm();
    const { tasks } = await llm.planner({
      hypothesis_text: "假设句",
      evidence_so_far: [],
      gap: null,
      menu: ["kb_lookup", "siem_query", "related_alerts"],
      template: { max_rounds: 20, max_tasks: 2 },
    });
    // 机制桩口径：菜单前两件、盲发 {q:假设句}——与 DefaultTemplateSource 配对的机制缺省形态
    expect(tasks.map((t) => t.tool)).toEqual(["kb_lookup", "siem_query"]);
    expect(tasks[0]!.params).toEqual({ q: "假设句" });
  });
});
