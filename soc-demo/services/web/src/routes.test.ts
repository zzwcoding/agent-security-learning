// 路由快照测试（m10 卡测试计划·决策 #6「表外无路由」的机器断言；票 82：页面映射节
// （票 71 落卡）+ PRD §13.7 新增第七页狩猎页，既有六页不动）。
// 断言三层，层层把范围锁死：
// ① 快照：路由表 deep-equal 七个名字的精确数组（多一个/少一个/改名都红）；
// ② 闭合：路由表之外的名字一律不算路由（isRouteName 全拒绝）；
// ③ 解析：hash → 路由名/参数 的行为面（空 hash、未知名、带 ?k=v 传参）。
import { describe, expect, it } from "vitest";
import { isRouteName, parseHash, ROUTES } from "./routes";

describe("路由快照（决策 #6：路由表之外无任何路由）", () => {
  it("路由表恰好七个、名字与卡面/页面映射节一字不差、顺序稳定", () => {
    expect(ROUTES.map((r) => r.key)).toEqual([
      "alerts", // 告警列表（FR-M10.1）
      "pipeline", // 流水线视图（FR-M10.2）
      "approvals", // 审批卡（FR-M10.3）
      "cases", // 案件时间线（FR-M10.4）
      "audit", // 审计流（FR-M10.5）
      "eval", // Eval 结果（FR-M10.6）
      "hunting", // 狩猎页（票 71 页面映射节 / PRD §13.7 第七页，票 82）
    ]);
    // 每个路由都有菜单标签（菜单项由路由表生成，不允许表外菜单）
    for (const r of ROUTES) expect(r.label.length).toBeGreaterThan(0);
  });

  it("闭合性：表外名字一律不是路由；表内名字全部承认", () => {
    expect(ROUTES.every((r) => isRouteName(r.key))).toBe(true);
    for (const stranger of ["", "settings", "users", "kb", "alerts/extra", "../evil"]) {
      expect(isRouteName(stranger)).toBe(false);
    }
  });

  it("parseHash：#/name?k=v 拆名字与参数；空 hash 落空名（由 Shell 兜底到 alerts）", () => {
    expect(parseHash("").name).toBe("");
    expect(parseHash("#/alerts").name).toBe("alerts");
    expect(parseHash("#/cases?case_id=case_000001").name).toBe("cases");
    expect(parseHash("#/cases?case_id=case_000001").params.get("case_id")).toBe("case_000001");
    expect(parseHash("#/pipeline?alert_id=al_9&run_id=run_1").params.get("run_id")).toBe("run_1");
    // 票 82：狩猎页深链（假设详情经 ?hypothesis_id= 直达）
    expect(parseHash("#/hunting?hypothesis_id=hyp_1").name).toBe("hunting");
    expect(parseHash("#/hunting?hypothesis_id=hyp_1").params.get("hypothesis_id")).toBe("hyp_1");
    // 未知名字照原样解析出来——「算不算路由」由 isRouteName 说了算，渲染层兜底
    expect(parseHash("#/nonsense").name).toBe("nonsense");
  });
});
