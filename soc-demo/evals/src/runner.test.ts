import { describe, expect, test } from "vitest";
import { filterByTags, listCases } from "./loader.js";
import { runCase } from "./runner.js";
import { FixedJudge } from "./judge.js";
import type { EvalCase } from "./types.js";

// 票 19 验收③的前半：单条分诊用例在「单测级注入」快道里真跑（真 case-backend + 生产
// HttpTriageM2 + FakeTriageLlm 被测对象），证据齐全、断言可判、judge 分数不进门禁。

const TRIAGE = () => filterByTags(listCases(), ["triage"]);

describe("runCase：一条真实用例走完 快道取证 → 确定性断言 → judge 记分", () => {
  test("01_ssh_bruteforce_tp：判定 tp、断言全绿、工具面与审计证据齐全", async () => {
    const c = TRIAGE().find((x) => x.dirName === "01_ssh_bruteforce_tp")!;
    const r = await runCase(c, new FixedJudge(1));
    expect(r.ran).toBe(true);
    expect(r.passed, JSON.stringify(r.checks.filter((x) => !x.ok))).toBe(true);
    expect(r.verdict).toEqual({ expected: "tp", got: "true_positive", ok: true });
    expect(r.toolCalls).toBeGreaterThanOrEqual(3); // get_alert / kb_lookup / search_cases_by_host / create_case
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.judge).toEqual({ evaluable: true, score: 1, hit: c.spec.expected_output, missed: [], model: "fixed-stub" });
  });

  test("确定性断言真的会红：把 get_alert 塞进 forbidden_tools，用例必须失败", async () => {
    const c = TRIAGE().find((x) => x.dirName === "01_ssh_bruteforce_tp")!;
    const doctored: EvalCase = { ...c, spec: { ...c.spec, forbidden_tools: [...c.spec.forbidden_tools, "get_alert"] } };
    const r = await runCase(doctored, null);
    expect(r.passed).toBe(false);
    const ft = r.checks.find((x) => x.name === "forbidden_tools")!;
    expect(ft.ok).toBe(false);
    expect(ft.detail).toContain("get_alert");
  });

  test("分数不进门禁（决策 #7）：judge 打 0 分，用例照样通过；分数只进报告", async () => {
    const c = TRIAGE().find((x) => x.dirName === "01_ssh_bruteforce_tp")!;
    const withZero = await runCase(c, new FixedJudge(0));
    expect(withZero.passed).toBe(true);
    expect(withZero.judge).toEqual({ evaluable: true, score: 0, hit: [], missed: c.spec.expected_output, model: "fixed-stub" });
    const withBlind = await runCase(c, null);
    expect(withBlind.passed).toBe(true);
    expect(withBlind.judge).toBeNull();
  });

  test("人工标注（expected_verdict）进门禁：标注改错，用例必须失败", async () => {
    const c = TRIAGE().find((x) => x.dirName === "01_ssh_bruteforce_tp")!;
    const mislabeled: EvalCase = { ...c, spec: { ...c.spec, expected_verdict: "fp" } };
    const r = await runCase(mislabeled, null);
    expect(r.passed).toBe(false);
    expect(r.checks.find((x) => x.name === "expected_verdict")!.ok).toBe(false);
  });

  test("never_mock 用例在快道显式跳过（慢道口径，票 22），不算通过也不算失败", async () => {
    const c = TRIAGE().find((x) => x.dirName === "01_ssh_bruteforce_tp")!;
    const slowLaneOnly: EvalCase = { ...c, spec: { ...c.spec, mock_policy: "never_mock" } };
    const r = await runCase(slowLaneOnly, null);
    expect(r.ran).toBe(false);
    expect(r.passed).toBe(false);
    expect(r.skippedReason).toContain("never_mock");
  });
});
