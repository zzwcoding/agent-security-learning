# 42-m11-invest-eval-fixture: invest 具名 eval fixture 落 evals（G2-8）

**What to build:** fixtures/eval/investigation/ 域补齐：invest/01_ssh_tp_full 具名场景（票 14 用 ssh-5712 复现过的布景转正）+ 调查维断言（报告 schema/findings 引用真实工具输出/三条缰绳不触发）。

**Blocked by:** 36

**Touches modules:** `m5`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] investigation 域用例入 evals 且全绿（源：遗留标记 14-1·m11 卡测试计划）
- [x] eval-results 覆盖 investigation 维（源：FR-M11.4）

## 实现记录（2026-09-09）

落点 `fixtures/eval/investigation/01_ssh_tp_full/test_case.yaml`（具名场景 `invest_ssh_tp_full`）+ `evals/src/scenarios.ts`（`scenarioInvestigationFull` 布景执行器，登记进 `runScenario` 分发表）+ loader/suite 自检下限补「调查 ≥1」。布景 = 票 14 的 ssh-5712 复现（种子告警 → create-case）走**票 36 的 case_flow 生产入口**直拉（buildApp + POST /internal/runs {kind:"case_flow", case_id}，票由 TICKET_SPECS 铸、链序 investigate_case → enrich_case），不再 evals 直构子图入口（出入 #1 的"搬进 harness"按生产形态搬，B4 教训）。

- 调查维断言六件（extraChecks 进门槛，与通用确定性断言同权）：invest_report_in_timeline（timeline 有 investigation_report 条目，author=agent:investigation）/ invest_report_schema_pass（parseReport 逐字段把关 + findings ≥1 防恒绿）/ invest_findings_evidence_real（source_tool ∈ tool_call 事件面已执行集 + evidence 逐字在工具输出记录里，钉 5712 爆破日志真被 siem_query 当证据）/ invest_reins_not_triggered（structured.incomplete=false + 无 repeat_tool_call / context_spill / context_summarize 审计）/ invest_recommend_only（建议 isolate_host 只进报告，事件流零 L2 调用）/ invest_case_flow_chain（生产链序）。
- **工具输出取数走缝上记录仪**（UsageProbeLlm 同款手法，不改生产）：case_flow 组链器只把 outcome 并回主状态、循环 observations 不出子图（票 36 有意设计）——SIEM/M2 读口两个 seam 包记录层，原始输出留底供逐字比对；缰绳检查证明本 run 无治理触发，观察 payload ≡ 原始输出，语义与票 14 单测的 `JSON.stringify(loop.observations)` 比对等价。
- eval-results 覆盖：latest.json cases 带 `domain:"investigation"` 行（33 用例全绿），报告与 web 侧零改动（"有什么渲染什么"）；fixtures/eval-report/latest.json 契约样例不受影响（报告形状未变）。
- 红先绿后：loader/suite 调查 ≥1 与 scenarios.test 调查维用例先红（2 失败），落 yaml+执行器后转绿。测试基线 97→99（suite 生成用例 +1、scenarios.test 调查 describe +1），零删除。
