// 票 31：verdict 词表跨服务契约（体检结构-4「四处各持」）。锚 = fixtures/verdicts.json。
//
// 此前词表四处手抄：triage prompt.ts（TriVerdict + TO_M2_VERDICT 映射）、triage
// schema.ts（VERDICT_VALUES 把关值域）、M2 store.ts（VERDICTS 写回值域）、web
// AlertsPage.tsx（颜色映射）。本文件钉 agent 侧前两处；M2 值域的对称闸在
// services/case-backend/src/verdict-contract.test.ts、web 颜色覆盖闸在
// services/web/src/sse-verdict-contract.test.ts——三端互不 import 源码（边界规则 R1），
// 样品共读是唯一通道（fixtures/tickets 契约先例）。
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TO_M2_VERDICT } from "./prompt.js";
import { VERDICT_VALUES } from "./schema.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../../fixtures/verdicts.json", import.meta.url), "utf8"),
) as { tri_verdicts: string[]; to_m2_verdict: Record<string, string>; m2_verdicts: string[] };

describe("verdict 词表契约：fixtures/verdicts.json（triage 产出侧）", () => {
  test("缩写词表：TO_M2_VERDICT 键集 ≡ VERDICT_VALUES ≡ 样品 tri_verdicts", () => {
    expect(Object.keys(TO_M2_VERDICT).sort()).toEqual([...FIXTURE.tri_verdicts].sort());
    expect([...VERDICT_VALUES].sort()).toEqual([...FIXTURE.tri_verdicts].sort());
  });

  test("映射：TO_M2_VERDICT 逐键值 ≡ 样品 to_m2_verdict（缩写 → M2 全名，一字不差）", () => {
    expect(TO_M2_VERDICT).toEqual(FIXTURE.to_m2_verdict);
  });

  test("值域包含：TO_M2_VERDICT 值域 ⊆ 样品 m2_verdicts（写回 M2 不被 store 拒收的前提）", () => {
    for (const v of Object.values(TO_M2_VERDICT)) {
      expect(FIXTURE.m2_verdicts).toContain(v);
    }
  });
});
