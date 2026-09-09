// m11 eval 体系 · fixture 目录制扫描器（票 19 验收①，FR-M11.1）。
//
// 目录制（PRD §5.11 / HolmesGPT fixture 制的复刻）：每条用例一个目录
//   fixtures/eval/<域>/<编号_场景>/test_case.yaml
// 好处：用例自包含——yaml、配套资源、说明注释都在自己的目录里，新增一条用例 = 新增一个
// 目录，runner 扫目录就长出对应的评估（vitest 动态生成测试）。
//
// fail-closed：格式不对的用例全部当场点名报错，而不是跳过——坏用例混进评估集比缺一条
// 用例危险得多（它会让准确率虚高或虚低）。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { EvalCase, InterceptFacet, MockPolicy, TestCaseYaml, TriVerdict } from "./types.js";

/** fixtures/eval 根（soc-demo/fixtures/eval，与 evals/ 代码分家：用例是数据，框架是代码）。 */
export const FIXTURES_EVAL_DIR = fileURLToPath(new URL("../../fixtures/eval", import.meta.url));

const VERDICTS: readonly TriVerdict[] = ["fp", "btp", "tp", "uncertain"];
const MOCK_POLICIES: readonly MockPolicy[] = ["inherit", "never_mock", "always_mock"];
const FACETS: readonly InterceptFacet[] = ["guard_scan", "behavior_gate", "review_reject", "sandbox_boundary"];

const isStrArr = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** 校验 + 落定一条 test_case.yaml；任何问题抛带用例目录名的错（fail-closed）。 */
function parseCase(domain: string, dirName: string, dir: string): EvalCase {
  const yamlPath = join(dir, "test_case.yaml");
  const where = `${domain}/${dirName}`;
  if (!existsSync(yamlPath)) {
    throw new Error(`eval 用例 ${where}：缺 test_case.yaml（目录制要求每用例一目录一 yaml）`);
  }
  const problems: string[] = [];
  const bad = (msg: string): void => void problems.push(msg);

  let raw: unknown;
  try {
    raw = parse(readFileSync(yamlPath, "utf8"));
  } catch (e) {
    throw new Error(`eval 用例 ${where}：YAML 解析失败（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (typeof raw !== "object" || raw === null) bad("顶层不是 YAML 映射");
  const y = (raw ?? {}) as Record<string, unknown>;

  const name = y.name;
  if (typeof name !== "string" || name.length === 0) bad("缺 name");

  const input = y.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    bad("缺 input（alert_fixture / user_prompt / scenario 三选一）");
  }
  const inputObj = (input ?? {}) as Record<string, unknown>;

  // 票 22：input 第三种形态——scenario（具名行为布景）。三种至少给一种（fail-closed）。
  if (inputObj.scenario !== undefined && typeof inputObj.scenario !== "string") {
    bad("input.scenario 必须是字符串（具名布景，如 approve_resume_execute）");
  }

  // alert 流用例：相对路径以 yaml 所在目录为基准落定成绝对路径（§5.11 示例口径）
  let alertFixturePath: string | null = null;
  if (typeof inputObj.alert_fixture === "string") {
    const rel = inputObj.alert_fixture;
    const p = isAbsolute(rel) ? rel : resolve(dir, rel);
    if (!existsSync(p) || !statSync(p).isFile()) bad(`alert_fixture 不存在：${rel}`);
    else alertFixturePath = p;
  } else if (typeof inputObj.user_prompt !== "string" && typeof inputObj.scenario !== "string") {
    bad("input 里 alert_fixture / user_prompt / scenario 全缺");
  }

  // 人工标注 verdict：分诊评估用例（alert_fixture 且无 scenario）必填——FR-M11.4 准确率
  // 的对照口径；行为流用例（对话/审批/replay/沙箱）可省——硬造一个 verdict 标注反而是假数据。
  let expected_verdict: TriVerdict | undefined;
  const triageShaped = alertFixturePath !== null && inputObj.scenario === undefined;
  if (triageShaped || y.expected_verdict !== undefined) {
    expected_verdict = y.expected_verdict as TriVerdict | undefined;
    if (typeof expected_verdict !== "string" || !(VERDICTS as readonly string[]).includes(expected_verdict)) {
      bad(`expected_verdict 非法（${String(expected_verdict)}），应为 fp/btp/tp/uncertain`);
    }
  }

  // 攻击用例的预期拦截分面（有 attack 标注时校验；报告分面计数的预期口径）
  let expected_facet: InterceptFacet | undefined;
  if (y.expected_facet !== undefined) {
    expected_facet = y.expected_facet as InterceptFacet;
    if (!(FACETS as readonly string[]).includes(expected_facet)) {
      bad(`expected_facet 非法（${String(expected_facet)}），应为 ${FACETS.join("/")}`);
    }
  }
  if (!isStrArr(y.expected_output) || y.expected_output.length === 0) {
    bad("expected_output（judge strict 要点）必须是非空字符串数组");
  }
  if (y.forbidden_tools !== undefined && !isStrArr(y.forbidden_tools)) bad("forbidden_tools 必须是字符串数组");
  if (y.expected_approvals !== undefined && !isStrArr(y.expected_approvals)) bad("expected_approvals 必须是字符串数组");
  if (y.max_tool_calls !== undefined && (typeof y.max_tool_calls !== "number" || y.max_tool_calls <= 0)) {
    bad("max_tool_calls 必须是正数");
  }
  if (y.max_tokens !== undefined && (typeof y.max_tokens !== "number" || y.max_tokens <= 0)) {
    bad("max_tokens 必须是正数");
  }
  if (!isStrArr(y.tags) || y.tags.length === 0) bad("tags 必须是非空字符串数组（难度 + 能力双维）");
  const policy = y.mock_policy ?? "inherit";
  if (!(MOCK_POLICIES as readonly string[]).includes(String(policy))) {
    bad(`mock_policy 非法（${String(policy)}），应为 inherit/never_mock/always_mock`);
  }
  if (problems.length > 0) {
    throw new Error(`eval 用例 ${where} 格式不合规：\n  - ${problems.join("\n  - ")}`);
  }

  const spec: TestCaseYaml = {
    name: name as string,
    input: inputObj as TestCaseYaml["input"],
    expected_verdict,
    expected_facet,
    expected_output: y.expected_output as string[],
    forbidden_tools: (y.forbidden_tools as string[] | undefined) ?? [],
    expected_approvals: (y.expected_approvals as string[] | undefined) ?? [],
    max_tool_calls: (y.max_tool_calls as number | undefined) ?? 15, // Tracecat 资源兜底口径（决策 #12 同源）
    max_tokens: (y.max_tokens as number | undefined) ?? 80000,
    tags: y.tags as string[],
    mock_policy: policy as MockPolicy,
    attack: (typeof y.attack === "string" ? y.attack : null),
  };
  return { fullName: where, domain, dirName, dir, yamlPath, spec, alertFixturePath };
}

/** 扫 fixtures/eval 全部用例；任何一个坏用例都抛错（消息点名全部坏例，一次修完）。 */
export function listCases(root: string = FIXTURES_EVAL_DIR): EvalCase[] {
  if (!existsSync(root)) return [];
  const problems: string[] = [];
  const cases: EvalCase[] = [];
  for (const domain of readdirSync(root).sort()) {
    const domainDir = join(root, domain);
    if (!statSync(domainDir).isDirectory()) continue;
    for (const dirName of readdirSync(domainDir).sort()) {
      const dir = join(domainDir, dirName);
      if (!statSync(dir).isDirectory()) continue;
      try {
        cases.push(parseCase(domain, dirName, dir));
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`fixtures/eval 有 ${problems.length} 条坏用例：\n${problems.join("\n")}`);
  }
  return cases;
}

/** tags 求交集过滤；空清单 = 全量（pnpm test:eval 不带 --tags 的口径）。 */
export function filterByTags(cases: EvalCase[], tags: string[]): EvalCase[] {
  if (tags.length === 0) return cases;
  return cases.filter((c) => c.spec.tags.some((t) => tags.includes(t)));
}

/** EVAL_TAGS env（逗号分隔）→ 过滤清单；cli.ts 的 --tags 也落到这个 env。 */
export function selectedTags(): string[] {
  const raw = process.env.EVAL_TAGS?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
