import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterByTags, listCases, selectedTags, FIXTURES_EVAL_DIR } from "./loader.js";

// 票 19 验收①（FR-M11.1）：fixtures/eval 目录制框架 + test_case.yaml 格式照 PRD §5.11。
// loader 的职责一句话：把 fixtures/eval/<域>/<编号_场景>/test_case.yaml 扫成类型化用例，
// 格式不对就当场炸（fail-closed）——坏用例混进评估比没有用例更糟。
// 票 22 扩维：分诊之外的 attack/approval/replay/chat 五个目录进場；行为流用例可用
// input.scenario 指名布景（§5.11 的第三种 input——eval 格式归 m11 管，扩展记本票）。

describe("真实 fixture 目录：六维用例清单（m11 卡测试计划的分维下限 + 票 42 investigation）", () => {
  const cases = listCases();
  const byDomain = (d: string): number => cases.filter((c) => c.domain === d).length;

  test("总量 ≥30：分诊 ≥10 / 攻击 ≥10 / 审批 ≥3 / replay ≥2 / 对话 ≥3 / 调查 ≥1", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(byDomain("triage")).toBeGreaterThanOrEqual(10);
    expect(byDomain("attack")).toBeGreaterThanOrEqual(10);
    expect(byDomain("approval")).toBeGreaterThanOrEqual(3);
    expect(byDomain("replay")).toBeGreaterThanOrEqual(2);
    expect(byDomain("chat")).toBeGreaterThanOrEqual(3);
    // 票 42（G2-8 清偿）：调查维具名用例入 evals——票 14 遗留标记 14-1 的收口
    expect(byDomain("investigation")).toBeGreaterThanOrEqual(1);
  });

  test("攻击维四面齐全：告警注入(A1)/RAG(A2)/提权(A3)/沙箱(第四面)各至少一条", () => {
    const kinds = new Set(cases.filter((c) => c.domain === "attack").map((c) => c.spec.attack));
    for (const face of ["alert_injection", "rag", "privesc", "sandbox"]) {
      expect(kinds.has(face), `攻击面 ${face} 缺用例`).toBe(true);
    }
  });

  test("每条用例：fullName 唯一；alert 流用例的 fixture 文件真实存在", () => {
    const names = cases.map((c) => c.fullName);
    expect(new Set(names).size).toBe(names.length);
    for (const c of cases) {
      if (c.spec.input.alert_fixture !== undefined) {
        expect(existsSync(c.alertFixturePath ?? ""), `${c.fullName} 的 alert_fixture 必须解析到真实文件`).toBe(true);
      }
    }
  });

  test("每条用例都带 §5.11 关键字段：tags/expected_output 非空；分诊评估用例必须有人工标注 verdict", () => {
    for (const c of cases) {
      expect(c.spec.tags.length, c.fullName).toBeGreaterThan(0);
      expect(c.spec.expected_output.length, `${c.fullName} judge 要点不能为空`).toBeGreaterThan(0);
      expect(["inherit", "never_mock", "always_mock"]).toContain(c.spec.mock_policy);
      // 分诊评估用例 = alert_fixture 且无 scenario（FR-M11.4 准确率的对照口径）
      if (c.spec.input.alert_fixture !== undefined && c.spec.input.scenario === undefined) {
        expect(c.spec.expected_verdict, `${c.fullName} 分诊用例必须带 expected_verdict`).toBeTruthy();
      }
    }
  });

  test("分诊维：L2 三件全在 forbidden_tools（INV-3 物理无 L2 的 eval 断言）", () => {
    for (const c of cases.filter((x) => x.domain === "triage")) {
      for (const l2 of ["isolate_host", "block_ip", "kb_write"]) {
        expect(c.spec.forbidden_tools, `${c.fullName} 应禁 ${l2}`).toContain(l2);
      }
    }
  });

  test("攻击维：每条都标 expected_facet（拦截率分面的预期口径），scenario 用例必须有 scenario 名", () => {
    for (const c of cases.filter((x) => x.domain === "attack")) {
      expect(c.spec.attack, `${c.fullName} 必须标 attack`).toBeTruthy();
      expect(c.spec.expected_facet, `${c.fullName} 必须标 expected_facet`).toBeTruthy();
      if (c.spec.input.alert_fixture === undefined && c.spec.input.user_prompt === undefined) {
        expect(c.spec.input.scenario, `${c.fullName} 必须标 input.scenario`).toBeTruthy();
      }
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

  function makeCase(dirs: string, yaml?: string): void {
    const dir = join(root, dirs);
    mkdirSync(dir, { recursive: true });
    if (yaml !== undefined) writeFileSync(join(dir, "test_case.yaml"), yaml);
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

  test("票 22 新格式：坏 expected_facet / 三种 input 全缺 / scenario 非字符串都要抛错", () => {
    try {
      const alert = join(root, "a.json");
      mkdirSync(root, { recursive: true });
      writeFileSync(alert, "{}");

      makeCase("attack/01_bad_facet", "name: x\ninput: {scenario: s}\nattack: privesc\nexpected_facet: magic\nexpected_output: [x]\ntags: [t]\n");
      makeCase("attack/02_no_input", "name: x\ninput: {}\nexpected_output: [x]\ntags: [t]\n");
      makeCase("approval/03_bad_scenario", "name: x\ninput: {scenario: 42}\nexpected_output: [x]\ntags: [t]\n");

      expect(() => listCases(root)).toThrow(/01_bad_facet/);
      expect(() => listCases(root)).toThrow(/02_no_input/);
      expect(() => listCases(root)).toThrow(/03_bad_scenario/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("票 22 新格式：scenario 用例合法——expected_verdict 可省（准确率对照只对告警流有意义）", () => {
    try {
      makeCase("approval/01_ok", "name: ok\ninput: {scenario: approve_resume_execute}\nexpected_output: [x]\ntags: [t]\n");
      const cases = listCases(root);
      expect(cases).toHaveLength(1);
      expect(cases[0].spec.expected_verdict).toBeUndefined();
      expect(cases[0].spec.input.scenario).toBe("approve_resume_execute");
      expect(cases[0].alertFixturePath).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
