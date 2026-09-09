// 票 31：verdict 词表契约的 M2 侧对端闸。锚 = fixtures/verdicts.json（值域表）。
//
// case-backend 与 agent 互不 import 源码（边界规则 R1，独立包/独立进程）——triage 的
// TO_M2_VERDICT 映射值是否落在本 store 放行的值域里，只能靠共读同一份样品断言：
// 样品里锁着 triage 侧的映射（agent 端测试钉它），这里锁 M2 自己的 VERDICTS ≡ 样品
// m2_verdicts。任何一端动了词表而样品/对端没跟，必有一端红。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { VERDICTS } from "./store.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../fixtures/verdicts.json", import.meta.url), "utf8"),
) as { tri_verdicts: string[]; to_m2_verdict: Record<string, string>; m2_verdicts: string[] };

describe("verdict 词表契约（M2 侧）：fixtures/verdicts.json", () => {
  test("M2 VERDICTS ≡ 样品 m2_verdicts（写回 verdict 的合法值域，store.ts includes 放行的正是它们）", () => {
    expect([...VERDICTS]).toEqual(FIXTURE.m2_verdicts);
  });

  test("值域包含：triage TO_M2_VERDICT 值域（样品映射的全部值）⊆ M2 VERDICTS", () => {
    for (const v of Object.values(FIXTURE.to_m2_verdict)) {
      expect(VERDICTS).toContain(v);
    }
  });
});
