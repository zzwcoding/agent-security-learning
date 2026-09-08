# 13: m4 分诊 worker：四分类子图

**What to build:** 单条告警 → 四分类 verdict + 处置建议的结构化子图：wrapUntrusted 不可信包装、guards 扫描调用、KB 检索注入（内存 stub）、L1 任务票过验票闸。物理无 L2 票。

**Blocked by:** 04, 07, 10

**Touches modules:** `m2`, `m4`, `m7`, `m9`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 四分类 verdict 结构化输出 schema（prompt 契约=事实接口）（源：m4 卡职责·注意）
- [x] 标注集宏准确率 ≥80%（源：m4 卡测试计划）
- [x] 同主机 24h 两条 TP 只建 1 案；并发同告警只分诊 1 次（源：m4 卡测试计划）
- [x] 自我审计 checkpoint 100% 出现（源：m4 卡测试计划）
- [x] 全部工具调用过 verifyTicket（L1 任务票）；物理无 L2 票（源：INV-3·m9-S2）
- [x] 不可信段 wrapUntrusted 包装 + guards /scan/injection 调用（源：m4 卡 Seam·PRD FR-S3.1/S3.2）
- [x] KB 检索注入走内存 stub adapter（源：m4 卡依赖·m7 检索面 stub）

## 实现记录（2026-09-08）

落点 `services/agent/workers/triage/`：`prompt.ts`（TRIAGE_TOOLS + wrapUntrusted + buildTriagePrompt + TriageInput 契约）、`schema.ts`（VerdictOutput + parseVerdict + uncertainFallback）、`llm.ts`（TriageLlm seam + FakeTriageLlm 决策点规则版）、`kb.ts`（TriageKb + MemoryKb client_env 种子）、`m2.ts`（TriageM2 + HttpTriageM2 + toMergeCheck）、`flow.ts`（六节点子图 load_alert→kb_check→merge_check→self_audit_checkpoint→verdict_llm→outcome）。

接线改动：graph.ts 节点允许异步（出站 guards/LLM/M2）；token-ports.ts 增 `mintTaskTicket`；app.ts `POST /internal/runs` 增 `makeNodes` 每-run 工厂（先向 gateway 铸 `agent:triage` 任务票，allowed_tools=分诊六件套、run_id 绑定、TTL 900s；铸票失败 502 不放行执行）；index.ts 默认 alert_flow 接 triage（`AGENT_FLOW=approval_demo` 保留审批演示）。m2 侧按 m4 卡接口契约新增 `PATCH /api/v1/alerts/:id`：verdict 生命周期 null→in-progress（条件更新 WHERE verdict IS NULL，FR-M4.5 拾取锁）→终值（终值即终局），verdict_ai 须拾取后写，status 走 alert 状态机，全部落审计 diff。测试 47 个新增（case-backend 7 + agent 40），全仓 lint/typecheck/test 绿，spec gate PASS。

- 标注集：fixtures/alerts/ 全部 11 条具名 fixture（7 常规 + 4 注入变体），期望 verdict 按 M507 决策点独立标定（`workers/triage/accuracy.test.ts`）；实测宏准确率 = 1.000（tp 7/7、uncertain 2/2、btp 1/1、fp 1/1）≥ 0.8。注入变体期望=底层事件标注：载荷要求改判/调 isolate_host，verdict 不受影响（guards DENIED 全落审计，全程 0 次 L2 调用）。
- 伪 LLM 说明：FakeTriageLlm 按 prompt 契约里 M507 决策点的确定性版实现（KB 已知变更→攻击证据→弱信号→运维噪声），不偷看标注集；真 minimax-m2 经 gateway /proxy/llm 只换 llm adapter（票 17 接真件时同套标注集可直接复测）。

### 出入与偏差记录（不改 spec 本体）

1. **m1 映射缺 hostname observable（跨票出入，留 m1 修）**：FR-M2.4 `GET /api/v1/cases/active?host=` 按 hostname observable 归并、case 标题 primary entity 也取 hostname observable，但 ingest 的映射表（wazuh.ts extractObservables）没有抽 `agent.name → hostname`——回放流水线产生的告警/CASE 永远查不到主机，FR-M4.3 归并对真实数据面空转。本票测试按 PRD §5.1「等结构化字段」以带 hostname observable 的告警种子验证归并链路（testkit.alertInputFromWazuh）；建议 m1 补一行映射（约 1 行改动）后归并即对回放生效。
2. **FP/BTP 关单建议的后续执行（留 SOC1 确认票）**：按 FR-M4.5 演示口径，triage 对 FP/BTP 只写 verdict_ai + recommended_action=close，不执行关单。注意 alert 状态机 `New→Closed` 非法——SOC1 一键确认票执行 `close_alert` 前需先把 alert 置 InProgress（与本票 TP 并案前同款处理）。
3. **L0 读也随任务票过闸（更严不更松）**：verify-ticket 静态分级表（票 07）未登记 get_alert/kb_lookup/search_cases_by_host → 按「未登记一律 L1」fail-closed 处理，任务票 allowed_tools 覆盖六件套后放行。闸行为与 PRD A.1「L0 免验」相比更严，无安全缺口；ToolManifest 机制落地时再对表。
