# 36-m5m6-case-flow-live: case_flow 生产接线：调查+富化上线（B4+G2-5+G2-6）

**What to build:** ① RUN_KINDS 放行 case_flow：alert_flow TP 分支建案后链上 enrich→investigate（子图已有，票 15/14），web 流水线视图节点适配；② add_task_log 收口：M2 补 tasks 写口（m2 卡本有 tasks 实体）并接通调查工具面，或从工具面移除声明（二选一按 m5 卡定）；③ 调查循环 observe 接 guards tool_output 通道扫描（flag 打标）。

**Blocked by:** 28

**Touches modules:** `m2`, `m3`, `m5`, `m6`, `m10`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] TP 告警 → 建案 → 富化 → 调查报告全链在生产 RUN_KINDS 可达（源：遗留标记 15-4/27-2·B4·PRD §4.2 步骤 7-8）
- [x] add_task_log 两头一致（可用或移除）（源：遗留标记 14-2）
- [x] 调查 tool_output 过 guards（源：遗留标记 14-3·D1 防线）
- [x] web 流水线视图覆盖 case_flow 节点（源：FR-M10.2）

## 出入记录（2026-09-08 收尾窗口）

**做了什么**（接手前一窗口未提交半成品，TDD 弄红后收尾）：

1. **验收 1（B4）**：`RUN_KINDS` 放行 case_flow（吃 case_id，与 knowledge_flow 同口径，缺 case_id → 400 case_id_required）；alert_flow 的 TP 建案分支后**同一 run 内**链上调查+富化（`workers/case-flow.ts` 组链器，case_id 由 outcome 的 create_case 运行时写交接态、链上运行时解析；FP/merge 分支链空转跳过）。生产组图 `src/index.ts` 补齐：case_flow 直拉链 + alert_flow=分诊六节点+链。
2. **链序裁决**：票面文字「enrich→investigate」与卡面（PRD §4.2 步骤 7-8 + §4.4 路由规则：调查在前、富化在后）冲突，**按卡面执行**（investigate→enrich），出与入均记于此。
3. **票面（ INV-3 复核）**：alert_flow 任务票 allowed_tools 扩为分诊∪调查∪富化三族并集（拉起时铸票、verdict 中途才知道——并集是当下能证明的最小超集；无任何 L2，`workers/triage/flow.test.ts` 铸票断言同步更新）。备选「链段单独铸第二张票」要动 makeNodes 票务 seam，记出入留待真需要。
4. **验收 2（G2-5）**：走「M2 补 tasks 写口」路线——`POST /api/v1/cases/:id/tasks`（建任务）+ `POST /api/v1/tasks/:id/log`（任务日志，归属一致性把关：任务不存在 404、case 与任务归属不符 400）；调查工具面 add_task_log 接通（`HttpInvestigationM2.addTaskLog`），执行错误按证据缺口继续。与 m5 卡工具面闭合：INVESTIGATION_TOOLS 六件套在 execTool 全部有执行体。
5. **验收 3（G2-6）**：调查循环 observe 对每次工具输出过 guards tool_output 通道（票 04 策略=flag 打标不拦），打标进观察元数据（ObsEntry.flagged）+ 审计（tool_output_flagged）+ audit 帧，位置在上下文治理阈值之前；scan 为必填 seam（生产 scanInjection / 测试 fakeScan），enrichment 侧票 15 已有同款。
6. **验收 4（FR-M10.2，票 31 契约纪律）**：`flow_nodes` 进 `fixtures/sse-events.json` 样品（alert_flow 六节点 + case_flow 两节点）；web `pipeline.ts` FLOW_NODES 收编 case_flow；两端契约测试各自咬住样品（agent `src/case-flow.test.ts` ↔ web `pipeline.test.ts`）。

**对遗留半成品的处置**：

- 遗留 3 红：① case-flow 直拉测试期望 alert_id=null → 按 runs.ts「无告警 run 存空串」惯例改为 ""（测试写错）；② alert_flow 链上 run failed → 根因即验收 1 的票面缺口（链上工具被闸拒 scope_insufficient），按上第 3 条修复；③ web pipeline.test 3 红 → 实现半边（pipeline.ts FLOW_NODES）缺，补齐。另修：建案 create 审计断言改查 M2 审计查询面（原断言查 agent 侧 sink，查错门）；`llm-real.test.ts` rig 补 scan 必填入参。
- `lessons/run-01-分诊.md`：非废稿——2026-09-09 演示会话复习（run 系列体裁），内容完整有用，原名收编入库并加体裁说明行；本票教学文档另产出 `lessons/36-01-case_flow上线-调查富化链接进生产.md`。

**超范围遗留（不入本票提交，原样留工作树）**：`docker-compose.yml`（case-backend 卷挂 /data→/app/data 的持久化修复）与 `.gitignore`（+.superdesign）——均与 case_flow 接线无关，记票备查。

**边界**：票 40 的事件驱动自动拉起（case.closed 提炼、告警自动拉 run）未动——本票两条入口都是显式拉起。

**测试基线**（零删除）：agent 357+1sk（typecheck 过）/ case-backend 60 / evals 97 / ingest 37 / web 82 / mcp-audit 14；`tools/check_specs.py` PASS（0 警告）；`pnpm check:boundary` PASS（0 越界，self-test 17/17）。
