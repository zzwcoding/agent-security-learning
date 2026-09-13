// 路由表 + hash 路由解析（票 21 从 App.tsx 抽出，成为「页面」的唯一事实来源）。
//
// 决策 #6「路由表之外无任何路由」在代码里怎么落实？三道锁：
// ① 表唯一：ROUTES 是全应用唯一的路由清单，菜单由它生成、页面开关由它驱动——
//    想加页面只能先改这张表，而表被 routes.test.ts 的快照断言盯死（机器断言）；
// ② 名字闭合：isRouteName 之外的 hash 一律不认，Shell 兜底回告警列表（绝不渲染
//    「表外页面」——因为根本没有表外页面组件可渲染）；
// ③ 不引路由库（2026-09-08 拍板）：解析就是 20 行以内的字符串处理，够演示窗用。
//
// 票 82：第七页 hunting（狩猎页）按页面映射节（票 71 落卡）+ PRD §13.7 登记——
// 既有六页不动，数据面只走 m2 假设 CRUD/审计 + m3 SSE（页面映射六行的落点）。

/** 七页面路由表（顺序 = 菜单顺序；前六名字与 m10 卡公开接口一字不差，第七页票 82）。 */
export const ROUTES = [
  { key: "alerts", label: "告警列表" },
  { key: "pipeline", label: "流水线视图" },
  { key: "approvals", label: "审批卡" },
  { key: "cases", label: "案件时间线" },
  { key: "audit", label: "审计流" },
  { key: "eval", label: "Eval 结果" },
  { key: "hunting", label: "狩猎假设" },
] as const;

export type RouteName = (typeof ROUTES)[number]["key"];

const NAMES: readonly string[] = ROUTES.map((r) => r.key);

export function isRouteName(name: string): name is RouteName {
  return NAMES.includes(name);
}

export interface Route {
  name: string;
  params: URLSearchParams;
}

/** "#/cases?case_id=c1" → {name:"cases", params:{case_id:c1}}；空 hash → 空名。
 *  hash 参数缺省读 window.location.hash，注入即可纯函数测试。 */
export function parseHash(hash = window.location.hash): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [name, qs] = raw.split("?");
  return { name: name || "", params: new URLSearchParams(qs ?? "") };
}
