# 14: m5 调查 worker：工具循环 + 三条缰绳

**What to build:** TP 案件关联调查：多步工具循环产出结构化调查报告进 Timeline。三条缰绳（max_steps/防打转/上下文治理）+ siem_query fixture adapter。只提建议不动手。

**Blocked by:** 13

**Touches modules:** `m2`, `m5`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] siem_query 强制 time_window 等工具签名契约（源：m5 卡公开接口·PRD §6-M5）
- [x] invest/01_ssh_tp_full：报告 schema 过 + findings 引用真实工具输出（源：m5 卡测试计划）
- [x] max_steps=20 超限截断（源：m3 资源兜底·决策 #5）
- [x] 防打转：同参数重复调用直接返回错误（源：m5 卡测试计划）
- [x] 超大结果 spill 落盘且上下文未超窗（源：m5 卡测试计划）

## 实现记录（2026-09-08）

落点 `services/agent/workers/investigation/`：`prompt.ts`（INVESTIGATION_TOOLS + TOOL_SCHEMAS + validateToolCall 签名契约 + CaseView/ObsEntry/Plan·Decide·ReportCall LLM 契约 + prompt 装配）、`siem.ts`（SiemBackend seam + FixtureSiem：fixtures/alerts 语料的实体字段+全文检索，强制时间窗过滤、max_results 截断）、`m2.ts`（InvestigationM2 + HttpInvestigationM2：案件详情/告警读/timeline 写 + relatedAlerts 同实体/同规则/同主机聚合）、`llm.ts`（InvestigationLlm 四方法 seam：plan/decide/summarize/report + FakeInvestigationLlm 确定性规则版）、`schema.ts`（InvestigationReport + parseReport 逐字段把关 + renderReportMarkdown 渲染体）、`flow.ts`（五节点子图 load_case→plan→tool_loop→report_llm→write_timeline，三条缰绳全部落在这里）。

- 工具签名契约（验收 1）：siem_query required 里显式含 `time_window`（无默认值，缺 = `time_window_required`）；related_alerts 同强制（FR-M5.5「查询强制过滤窗口」）；entity_type/scope/kind 枚举、max_results 正整数逐一把关。循环里每次调用先过 validateToolCall 再过 verifyTicket（gated 唯一入口，票 13 先例）——违约调用不执行、不烧后端，错误作为观察返回 LLM 并落审计 `tool_signature_rejected`。
- 调查任务票：`INVESTIGATION_TOOLS` = §6-M5 五件套 + A.1 共用读 `get_alert`（A.1 一字不差 get_alert 属分诊/调查），allowed_tools 全覆盖、run_id 绑定；L2 遍历 100% 403（INV-3 测试）。
- max_steps（验收 3）：`LOOP_MAX_STEPS=20`（决策 #5），env `MAX_STEPS` 同口径可覆盖。与 m3 runner budget 的关系：决策 #5 的 M5 语义是**工具循环步数**（HolmesGPT `ToolCallingLLM.call()` 范式），不是图节点数；用尽 → 循环截断 → 照常出报告并标注「调查不完整」（PRD 异常与边界），run 不强杀。runner 的节点级 budget.step()/token 闸（ctx.charge）继续兜底——双保险各管一半。
- 防打转（验收 4）：`tool + paramsHash(params)` 规范化指纹，重复即返回 `repeated_tool_call` 错误观察 + 审计 FAILURE，不再打到后端。
- 上下文治理（验收 5）：工具输出 JSON >`SPILL_THRESHOLD_CHARS`(50000) → 落盘 `<spillDir>/<runId>/qN.json`（默认 `workspace/spill/`），观察只留 `{total, truncated:true, hits_ref}`；>`LLM_SUMMARIZE_THRESHOLD_CHARS`(10000) → llm_summarize 小模型摘要（seam 方法，伪 LLM 确定性替身），观察留 `{total, truncated:false, summary}`。测试断言 60KB 原文逐字不进 LLM 对话、磁盘文件含全文、报告仍可引用 hits_ref 作 evidence。
- 「findings 引用真实工具输出」两层：flow 内确定性半边 = finding.source_tool 必须真被调用过（违例视同 schema 失败，走重试 1 次→降级自由文本+标记，审计 `report_degraded`）；逐字证据比对（evidence ⊆ 本 run 观察记录）= 测试层断言，编造即红。
- m2 侧改动：`POST /api/v1/cases/:id/timeline` 透传 `structured` 机读负载（PRD §5.5 TimelineEntry.structured 本就在表结构里，REST 补上映射，FR-M5.4 落库形态）；store.addTimelineEntry 无需改。
- 只提建议不动手：报告 `recommended_actions` 可建议 isolate_host，但调查票 scope 无任何 L2、worker 无 awaitApproval/executeApproved 通道——测试断言事件流 0 次 L2 调用。

### 出入与偏差记录（不改 spec 本体）

1. **`invest/01_ssh_tp_full` 具名 eval fixture 属 evals/（m11 范围）**：m5 卡测试计划引用该 fixture，但 evals/ 目录与用例集是 m11 的产物。本票按票 13 先例用既有 fixture（ssh-5712-real）+ 种子/建案复现同一布景（TP 告警 → 建案 → 关联调查），测试名与断言按该场景对表；m11 落 evals/ 时可直接把布景搬进 harness。
2. **`add_task_log` 声明在工具面但执行期报错**：A.1/§6-M5 工具面含 add_task_log（L1），票面 scope 覆盖它；但 M2 无 tasks 写 API（timeline_entries 表无 task_id 挂载、无 /tasks REST）。执行体按 PRD「工具报错 → 证据缺口并继续」路径返回错误，不假装修成。后续票给 M2 补 tasks 写口或从工具面移除该声明时再收口。
3. **调查循环上下文未接 guards tool_output 通道扫描**：SIEM 命中的 full_log、关联告警标题属攻击者可影响内容，进 LLM 上下文前本票未过 guards（m5 卡 Seam/测试计划未列、票面验收不含；FR-S3.2 的全 worker 口径接线留攻击面/集成票）。channel `tool_output` 的策略（flag）与 guards-client 已就绪，接入只差 flow.observe 一处。
4. **L0 读也随任务票过闸（更严不更松）**：get_alert/siem_query 在 verify-ticket 静态表是 L0，但调查票 allowed_tools 全覆盖六工具后逐工具验票（票 13 出入 #3 同一更严口径）；ToolManifest 机制落地时再对表。
5. **SIEM adapter 数据面 = fixtures/alerts 语料文件（非 M2 告警库）**：FR-M5.1「后端为 fixture 告警集的全文/字段检索」按字面实现；related_alerts（FR-M5.2）走 M2 告警库聚合——两个工具两个数据源互补，与 PRD 的 SIEM/案件后端分工一致。fixture 时间戳（2023-04）与建案时间（now）不同域，时间窗锚点取 primary alert 日期（get_alert，A.1 调查共用 L0），不是 case.startDate。
