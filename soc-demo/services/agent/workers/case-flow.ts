// m3 supervisor · case_flow 组链（票 36，B4 清偿）。
//
// 调查（m5）与富化（m6）子图票 14/15 就已存在，但生产不可达（体检 B4：PRD §4.2
// 消息旅程步骤 7-8 无入口）。本模块把它们接成一条「案件链」：
//
//   investigate_case（调查：plan → tool_loop → 报告进 timeline）
//        ↓
//   enrich_case（富化：observables 过 analyzer → TLP/PAP 闸 → 报告进 timeline）
//
// 链序依据 = 卡面：PRD §4.2 步骤 7（调查）→ 步骤 8（富化）+ §4.4 路由规则
// （verdict=TP 且 case 已建/挂 → 调查 worker；调查报告含未富化 observables →
// 富化 worker）。票面文字「enrich→investigate」与卡面冲突，按卡面执行（出入记票）。
//
// 两个入口共用这一条链，差别只在 case_id 的来源：
//   ① case_flow kind 直拉（POST /internal/runs {kind:"case_flow", case_id}）——
//     executeRun 的交接态自带 case_id（run.caseId）；
//   ② alert_flow 的 TP 建案分支后【同一 run 内】链上——case_id 是 outcome 节点
//     建案时才写进交接态的，组图时还不存在。所以 case_id 一律从 ctx.state 运行时
//     解析，worker 工厂在节点运行期才构造（m5/m6 卡「子图输入 {case_id, ticket}」
//     的合同不变——case_id 仍然经 deps 显式交给子图，本模块只是个组链器）。
//
// 粒度：链在 runner 图里是两个交接节点（CASE_FLOW_NODES，web 流水线视图按它出
// 预置骨架）；两个 worker 子图的内部节点名不进 runner 图——m5/m6 各有一个
// load_case，同名节点无法在一张 StateGraph 里共存，且 alert_flow 组图时案件还不
// 存在、也没法按已知 caseId 预组子图。子图内部照样可见：tool_call/tool_result/
// audit 帧带内部节点名，审计与 SSE 事件流全程可回放。
import type { FlowNode, NodeCtx } from "../src/graph.js";
import { makeInvestigationFlow, type InvestigationDeps } from "./investigation/flow.js";
import { makeEnrichmentFlow, type EnrichmentDeps } from "./enrichment/flow.js";

/** web 流水线视图的 case_flow 预置骨架（FR-M10.2）。名单与
 *  fixtures/sse-events.json flow_nodes.case_flow 两端契约锁
 *  （agent 侧闸 = src/case-flow.test.ts，web 侧闸 = pipeline.test.ts）。 */
export const CASE_FLOW_NODES = ["investigate_case", "enrich_case"] as const;

export interface CaseFlowDeps {
  /** 调查子图依赖（除 caseId——运行时从交接态解析）。 */
  invest: Omit<InvestigationDeps, "caseId">;
  /** 富化子图依赖（除 caseId——同上）。 */
  enrich: Omit<EnrichmentDeps, "caseId">;
}

/** 交接态里的案件 id：case_flow 直拉 = run.caseId；alert_flow 链上 = TP 建案
 *  （outcome 的 create_case 分支）写入。没有 = 本 run 没建案（FP/BTP/Uncertain、
 *  并入旧案的 merge 分支）→ 链整体空转跳过。 */
function caseIdOf(ctx: NodeCtx): string | null {
  const v = ctx.state.case_id;
  return typeof v === "string" && v !== "" ? v : null;
}

export function makeCaseFlow(deps: CaseFlowDeps): FlowNode[] {
  return [
    {
      name: "investigate_case",
      run: async (ctx) => {
        const caseId = caseIdOf(ctx);
        if (!caseId) return;
        // 子状态隔离：worker 子图按 {case_id, ticket} 交接（m5 卡）在干净状态上跑，
        // 产物以命名空间键并回主状态——不与分诊前段的 case/outcome 等键互踩。
        const sub: NodeCtx = { ...ctx, state: { case_id: caseId } };
        for (const n of makeInvestigationFlow({ ...deps.invest, caseId })) await n.run(sub);
        ctx.state.investigation = { outcome: sub.state.outcome };
      },
    },
    {
      name: "enrich_case",
      run: async (ctx) => {
        const caseId = caseIdOf(ctx);
        if (!caseId) return;
        const sub: NodeCtx = { ...ctx, state: { case_id: caseId } };
        for (const n of makeEnrichmentFlow({ ...deps.enrich, caseId })) await n.run(sub);
        ctx.state.enrichment = { outcome: sub.state.outcome };
      },
    },
  ];
}
