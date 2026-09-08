import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterByTags, listCases, selectedTags, FIXTURES_EVAL_DIR } from "./loader.js";

// 票 19 验收①（FR-M11.1）：fixtures/eval 目录制框架 + test_case.yaml 格式照 PRD §5.11。
// loader 的职责一句话：把 fixtures/eval/<域>/<编号_场景>/test_case.yaml 扫成类型化用例，
// 格式不对就当场炸（fail-closed）——坏用例混进评估比没有用例更糟。

describe("真实 fixture 目录：分诊维用例清单", () => {
  const cases = listCases();

  test("分诊维 ≥10 条（m11 卡测试计划的下限）", () => {
    const triage = cases.filter((c) => c.domain === "triage");
    expect(triage.length).toBeGreaterThanOrEqual(10);
  });

  test("每条用例：fullName 唯一、alert fixture 文件真实存在", () => {
    const names = cases.map((c) => c.fullName);
    expect(new Set(names).size).toBe(names.length);
    for (const c of cases) {
      expect(c.fullName).toMatch(/^triage\//);
      expect(existsSync(c.alertFixturePath ?? ""), `${c.fullName} 的 alert_fixture 必须解析到真实文件`).toBe(true);
    }
  });

  test("每条用例都带 §5.11 关键字段：tags/expected_output 非空、L2 在 forbidden_tools 里", () => {
    for (const c of cases) {
      expect(c.spec.tags.length, c.fullName).toBeGreaterThan(0);
      expect(c.spec.expected_output.length, `${c.fullName} judge 要点不能为空`).toBeGreaterThan(0);
      // INV-3：分诊 worker 物理无 L2——每条用例都把 L2 声明为 forbidden
      for (const l2 of ["isolate_host", "block_ip", "kb_write"]) {
        expect(c.spec.forbidden_tools, `${c.fullName} 应禁 ${l2}`).toContain(l2);
      }
      expect(["inherit", "never_mock", "always_mock"]).toContain(c.spec.mock_policy);
    }
  });

  test("根目录取自 soc-demo/fixtures/eval（m11 卡：evals 与 fixtures 分家）", () => {
    expect(FIXTURES_EVAL_DIR.replace(/\\/g, "/")).toContain("/soc-demo/fixtures/eval");
  });
});

describe("filterByTags / selectedTags（pnpm test:eval -- --tags regression 的闸门）", () => {
  test("按 tags 求交集过滤；空 = 全量", () => {
    const all = listCases();
    const regression = filterByTags(all, ["regression"]);
    expect(regression.length).toBeGreaterThan(0);
    expect(regression.length).toBeLessThan(all.length);
    for (const c of regression) expect(c.spec.tags).toContain("regression");
    expect(filterByTags(all, []).length).toBe(all.length);
  });

  test("selectedTags 读 EVAL_TAGS（逗号分隔），未设 = 空数组", () => {
    const saved = process.env.EVAL_TAGS;
    try {
      process.env.EVAL_TAGS = "regression,security";
      expect(selectedTags()).toEqual(["regression", "security"]);
      delete process.env.EVAL_TAGS;
      expect(selectedTags()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.EVAL_TAGS;
      else process.env.EVAL_TAGS = saved;
    }
  });
});

describe("坏用例当场炸（fail-closed 的 loader 版）", () => {
  const root = join(tmpdir(), "soc-eval-loader-test");

  function makeCase(dirs: string, yaml?: string): string {
    const dir = join(root, dirs);
    mkdirSync(dir, { recursive: true });
    if (yaml !== undefined) writeFileSync(join(dir, "test_case.yaml"), yaml);
    return root;
  }

  test("缺 name / 坏 verdict / fixture 文件不存在 / 缺 test_case.yaml 都要抛错", () => {
    try {
      const alert = join(root, "a.json");
      mkdirSync(root, { recursive: true });
      writeFileSync(alert, "{}");

      makeCase("triage/01_no_name", "input: {alert_fixture: ../../a.json}\nexpected_verdict: tp\nexpected_output: [x]\ntags: [t]\n");
      makeCase("triage/02_bad_verdict", "name: x\ninput: {alert_fixture: ../../a.json}\nexpected_verdict: maybe\nexpected_output: [x]\ntags: [t]\n");
      makeCase("triage/03_missing_fixture", "name: x\ninput: {alert_fixture: ../../nope.json}\nexpected_verdict: tp\nexpected_output: [x]\ntags: [t]\n");
      mkdirSync(join(root, "triage/04_no_yaml"), { recursive: true });

      // loader 一次报齐所有坏用例（不藏在第一个错后面）
      expect(() => listCases(root)).toThrow(/01_no_name/);
      expect(() => listCases(root)).toThrow(/02_bad_verdict/);
      expect(() => listCases(root)).toThrow(/03_missing_fixture/);
      expect(() => listCases(root)).toThrow(/04_no_yaml/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
