// 路由快照测试（m10 卡测试计划·决策 #6「六页面之外无任何路由」的机器断言）。
// 断言三层，层层把范围锁死：
// ① 快照：路由表 deep-equal 六个名字的精确数组（多一个/少一个/改名都红）；
// ② 闭合：路由表之外的名字一律不算路由（isRouteName 全拒绝）；
// ③ 解析：hash → 路由名/参数 的行为面（空 hash、未知名、带 ?k=v 传参）。
import { describe, expect, it } from "vitest";
import { isRouteName, parseHash, ROUTES } from "./routes";

describe("路由快照（决策 #6：六页面之外无任何路由）", () => {
  it("路由表恰好六个、名字与 m10 卡公开接口一字不差、顺序稳定", () => {
    expect(ROUTES.map((r) => r.key)).toEqual([
      "alerts", // 告警列表（FR-M10.1）
      "pipeline", // 流水线视图（FR-M10.2）
      "approvals", // 审批卡（FR-M10.3）
      "cases", // 案件时间线（FR-M10.4）
      "audit", // 审计流（FR-M10.5）
      "eval", // Eval 结果（FR-M10.6）
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
    // 未知名字照原样解析出来——「算不算路由」由 isRouteName 说了算，渲染层兜底
    expect(parseHash("#/nonsense").name).toBe("nonsense");
  });
});
