# 44-m3-kind-registry: run kind 描述符注册表 + evals scenarios 拆分（F2+F6）

**What to build:** ① kind→（票面 spec+图工厂+节点清单）单一注册表，RUN_KINDS/CASE_KINDS/TICKET_SPECS 三张平行表与 index.ts 分支收敛（新 kind 触点从 9+ 文件降到 1 处注册）；web pipeline FLOW_NODES 改由注册表派生或契约锁；② evals scenarios.ts（1040 行）按 facet 拆 rig 模块，布景声明与检查分层。

**Blocked by:** 36, 42

**Touches modules:** `m3`, `m10`, `m11`

**Belongs to spec:** specs/modules.md

**Status:** done

- [x] 新增 kind 只需注册一处（源：结构-1/2）
- [x] scenarios.ts 拆分后 eval 全绿（源：结构-5）
- [x] 全仓测试零删除零放松（源：体检口径）

## 实现记录（2026-09-09）

**基线 vs 重构后（行为零变化的证据，数字只增不减）**：agent 431+4sk → **438+4**（新增 run-kinds.test.ts 7 条注册表完整性测试，既有 431 条零删除零改动）；case-backend 60→60、evals 99→99、ingest 41+1sk→41+1sk、web 100→100、mcp-audit 14→14 全部持平；`pnpm test:eval` 34→34。`pnpm lint` / `pnpm typecheck` / `python3 tools/check_specs.py`（PASS 0 警告）/ `pnpm check:boundary`（PASS 0 越界，self-test 17/17）全过。

- **F2**：新注册表 `services/agent/src/run-kinds.ts`——kind → { intake、requiresMessage、ticket（票面 spec）、pipelineNodes（预置骨架）、makeGraph（图工厂 maker）} 一张表，五个 kind（alert_flow/knowledge_flow/chat_flow/case_flow/close_flow）各一 entry。原 app.ts 的 RUN_KINDS/CASE_KINDS/TICKET_SPECS 三张平行表删除；原 index.ts makeNodes 的 kind 分支整体搬入注册表（装配真件 = Http adapter/Llm 双 adapter/guards/FGA 由 index.ts 打包成 RunKindGraphDeps 注入——组合根仍在一个文件，注册表不碰 env/网络）。消费方各取所需：app.ts 拉起校验读 intake/requiresMessage、铸票读 ticket；index.ts makeNodes 委托 requireRunKind(kind).makeGraph；autorun 拉起 payload 按 intake 定 alert_id/case_id（原 `kind === "alert_flow"` 特判消失）。**keep 行为逐字保持**：alert_flow 三族并集票、close_flow 最小票与确认人透传（ctx.actor）、chat_flow 公开 SSE 面路由（launchChatRun 留在 app.ts——那是 app 层 wire 形态不是 kind 元数据）、TICKET_SPECS 各 kind 字段原样。**web 不派生**（边界 R6 禁 import agent 源码）：pipeline.ts FLOW_NODES 保持手抄，契约锁链 = 注册表 pipelineNodes ≡ fixtures/sse-events.json flow_nodes ≡ web FLOW_NODES（票 31 先例：两端测试各咬同一样品；agent 侧闸 = run-kinds.test.ts，web 侧闸 = pipeline.test.ts 原样未动）。注册表完整性测试 7 条：kind 全集快照、三件套齐全（intake/票面/图工厂）、INV-3 全票面无 L2、票面字段逐字保持（三族并集/最小票/只读四件）、intake 与 requiresMessage 口径、pipelineNodes ≡ fixture（双向）、图工厂产出与骨架自洽（alert_flow 六节点+链上两节点）。**新 kind 注册触点：9+ 文件 → 2 处（注册表一 entry + 该 kind 的测试/fixture 声明）**。
- **F6**：`evals/src/scenarios.ts`（1334 行）拆进 `evals/src/rigs/` 七文件——shared（ScenarioSkip/ScenarioOutcome/ScenarioDeps/skeleton/attackCheck/makeFakeMint/stubFga，断言分层底座）+ 六 facet rig：approval（票 11 五景）/replay（票 09 两景）/chat（票 18 runChatPrompt+伪造批准+登录四身份）/investigation（票 14 L2 提权+票 42 全链）/triage（票 35 金丝雀）/attack（票 17 RAG+票 16 沙箱）。scenarios.ts 只留布景声明与分发（52 行门面：runScenario switch + 公共面再出口，对外 API 逐字不变——runner.ts/scenarios.test.ts 的 import 一行没动）。布景逻辑逐字搬移零改写。
- **边界（L0 产物处置，票面授权路径）**：rigs 七文件 import services 内部，落在 ADR 0003 裁决 3 允许清单之外——**ADR 未动**，记票 45 请 L0 追认（精确清单变更单列）。边界规则表 R2 例外列按票面授权同步加了 `evals/src/rigs/{...}.ts` 花括号组（**表变更待 L0 追认**，表内已显著标注）；check_boundary.py 零改动（既有花括号展开原生解析目录级组），self-test 17/17 + 真跑 0 越界。测试文件零改动零删除；教学文档：`lessons/44-01-run-kind注册表与scenarios拆rig.md`。
