// 票 31：web 消费端契约闸。锚 = fixtures/sse-events.json + fixtures/verdicts.json。
//
// web 与 agent/case-backend 互不 import 源码（边界规则 R1/R6）——样品 ?raw 共读是唯一
// 通道（票 29 eval-report 先例：jsdom 里没有 file: URL 可读盘，?raw 在构建期原样内联）。
// 这里是「手抄第三份」的咬合处：agent 事件名单改了而 web 没跟 → SSE 节红；M2 新增
// verdict 而 web 没配色（或颜色映射里混进错别字键）→ verdict 节红。
import { describe, expect, it } from "vitest";
import fixtureSse from "../../../fixtures/sse-events.json?raw";
import fixtureVerdicts from "../../../fixtures/verdicts.json?raw";
import { VERDICT_COLORS } from "./pages/AlertsPage";
import { SSE_EVENT_TYPES } from "./sse";

const SSE_FIXTURE = JSON.parse(fixtureSse) as { event_types: string[] };
const VERDICT_FIXTURE = JSON.parse(fixtureVerdicts) as {
  tri_verdicts: string[];
  m2_verdicts: string[];
};

describe("SSE 事件类型契约（web 消费端）：与 agent 共读同一份样品", () => {
  it("web SSE_EVENT_TYPES ≡ 样品 event_types（agent 产出侧闸在 services/agent/src/sse-contract.test.ts）", () => {
    expect([...SSE_EVENT_TYPES]).toEqual(SSE_FIXTURE.event_types);
  });
});

describe("verdict 词表契约（web 颜色映射）：M2 每个结局都必须有配色", () => {
  it("VERDICT_COLORS 覆盖样品 m2_verdicts 全集——新结局没配色，页面 Tag 渲染不出", () => {
    for (const v of VERDICT_FIXTURE.m2_verdicts) {
      expect(VERDICT_COLORS).toHaveProperty(v);
    }
  });

  it("颜色映射键集恰好 = m2_verdicts + tri 短别名（多出的键 = 错别字，静默无色）", () => {
    const extra = Object.keys(VERDICT_COLORS).filter(
      (k) => !VERDICT_FIXTURE.m2_verdicts.includes(k),
    );
    expect(extra.sort()).toEqual(["btp", "fp", "tp"]); // 短别名集：verdict_ai 存 worker 原始判定对象时的短标签
    for (const a of extra) expect(VERDICT_FIXTURE.tri_verdicts).toContain(a); // 别名必须是 tri 词表里的真缩写
  });
});
