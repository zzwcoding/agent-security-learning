# 79-hunting-playbook-pack: 狩猎业务内容包——假设模板 + 菜单子集 + weknora 工具 stub（P1）

**What to build:** 循环的第一个用户（内容层，全票零 m14 机制代码）。① 狩猎假设模板：template_id + 假设句式族（webshell/C2/凭据泄露三族起步）+ 默认菜单子集 + 轮次上限建议；② hunt 版 investigation prompt 模板（plan 起手式按狩猎维度改写，fake LLM 的确定性 plan 覆盖三族假设的拆条路径）；③ weknora 三工具的 **Memory stub 实现**（对接票的占位件，接口形态按票 71 登记的契约）：`playbook_lookup`（查本地剧本库 fixture）、`graph_query`（查本地只读图 fixture）、`hypothesis_register`（L1 写，假设+证据关系落本地 store，人审口径预留 INV-5 对齐位）；④ 三族假设的端到端布景：fixture 假设 + 期望轮次轨迹 + 收敛结论断言（evals scenario 骨架，供票 81 扩展）。

**铁律:** 分层铁律本票兑现——**git diff 不得触及 m14 目录**（review 可查）；stub 是真接口假实现（换 HTTP 实现不换调用方，对齐 MemoryVectorStore 先例）；hypothesis_register 是写工具——票面 L1、审计五要素、走验票闸，禁绕。

**Touches modules:** `m14`（仅消费公开接口）、`m5`、`m2`（stub store）

**Belongs to spec:** specs/orchestration-loop.md（行号回填同上）


**Spec 绑定:** specs/orchestration-loop.md 验收测试表 T01/T07/T08/T22（spec 已定稿 2026-09-12）

**Blocked by:** 74, 78

**Status:** done（2026-09-13 子 agent 施工 + L0 验收通过：三族真执行体 e2e 轨迹 + weknora 三 stub + diff 零触 m14（0 文件自证）+ register 三件套）

**L0 派发前裁定（2026-09-13）：**
- ① **hunt_task 真执行体接线归本票**（78 遗留尾巴）：task-flow 的 execute 走 73 建好的 OrchestrationDeps 注入缝，本票在 index.ts 装配层注入真件（m5 的 plan/decide 循环 + 78 的 executeHuntTool 门）——**零 m14 代码改动**，铁律可守；注入后 fake LLM 端到端走真执行体（验收①的前提，81 的紫队 eval 才有真轨迹可复用）。
- ② **hypothesis_register 的票面归属（spec 票务节的空档）**：hunt_flow 父票面 = planner 菜单只读面（playbook_lookup/graph_query/kb 类）+ `hypothesis_register`（L1 写，仅供 outcome 收敛归档步使用）——INV-3 不破（L1 非 L2），INV-11 不破（register 不入 planner 组合菜单，planner 输出含 register = 菜单外拒绝；hunt_task 子票仍单工具从组合来）；写动作走验票闸 + 五要素审计（INV-8），gated 语义在注入的 register seam 实现内完成（m14 只调缝）。
- ③ **T22 测试落位**：graph/register stub 实现与测试落 m5/m2 领地（与实现同处），`orchestration/graph-stub.test.ts` 的 spec 测试标识行由 L0 授权改为实际路径（实现事实同步，记本票；m14 目录零触碰不受影响）。
- ④ **manifest 登记授权**：weknora 三工具（playbook_lookup/graph_query/hypothesis_register）进 tools.manifest（PRD §13.4b 预列、m14 卡依赖明示；不登记则 planner 永远选不到、端到端跑不通——Touches m9 为本裁定新增，属拆票洞补全非范围扩张）。

**验收：**
- [x] 三族假设 fake LLM 端到端跑通（轮次轨迹与期望一致，断言绿）
- [x] git diff 不触 m14 目录（架构分层断言，CI 可查）
- [x] 三 stub 接口契约测试绿（换真实现不换调用方的形态验证）
- [x] hypothesis_register 验票/审计/票面三件套齐（INV-3/8 断言）
- [x] 菜单子集外工具被选 100% 拒（planner 约束 + 本票菜单的对账测试）

**实现记录：**（2026-09-13，L2 编码窗）

- ① 模板三族（数据文件，内容层落 `fixtures/hunt-templates/`：hunt_webshell / hunt_c2_beacon / hunt_credential_leak.json——template_id + 句式族 + 槽位/既定查询计划(waves) + 菜单子集 + max_rounds=6/max_tasks=2）。登记经既有 TemplateSource 缝：`services/agent/workers/investigation/hunt-pack.ts` 的 `HuntTemplateSource`（三族优先、机制默认档兜底），index.ts 装配注入；**orchestration/ 零改动**。
- ② hunt 版 prompt：`workers/investigation/hunt-prompt.ts`（buildHuntPlanPrompt 起手式=剧本/图谱开局+菜单封闭+强制 time_window；buildHuntDecidePrompt）；确定性拆条路径 = `hunt-pack.ts` 的 `makeHuntFakeLoopLlm`（菜单签名回族→wave 计划；judge 判据 sufficient=prior≥1 且 ≥2 份子报告、hit=取证面 total>0）。
- ③ weknora 三工具 Memory stub：`workers/investigation/weknora.ts`（MemoryPlaybookLibrary / MemoryWeknoraGraph / executeWeknoraTool / makeHuntRegisterSeam）+ fixtures（`fixtures/weknora/playbooks.json`、`graph.json`）。T22 实际落位（L0 裁定③授权改 spec 标识行）：`workers/investigation/weknora.test.ts::proposed_only_unlisted`（register 只写 proposed / graph_query 只回 approved）。
- ③' manifest 登记（L0 裁定④）：`fixtures/tools.manifest.json` +playbook_lookup/graph_query(L0)/hypothesis_register(L1)；互锁同步 `tools-manifest.test.ts` KNOWN_NOT_IN_A1 与 `services/gateway/test_fga_matrix.py` 点名例外（收编记票，票 78 先例）。
- ③'' hunt_task 真执行体（L0 裁定①）：真件 = `workers/investigation/hunt-executor.ts`（execute 节点换件 wireHuntTaskExecutor：签名契约→makeGatedCall 验票闸→executeHuntTool/executeWeknoraTool→观察/计费，取消前置检查保留）；换件缝 = `run-kinds.ts` 注册表 hunt_task makeGraph（deps.huntExecutor 注入才换、缺省=73 桩）；真件供给 = index.ts（huntExecutor + register 缝 = makeHuntRegisterSeam）。**orchestration/ 零改动**（git diff --name-only 0 文件）。
- ④ 三族端到端：`evals/src/rigs/hunting.ts::hunt_pack_e2e`（真 buildApp/真注册表/真执行体/真闸/FixtureSiem 语料；假 port/假 cases/weknora register 缝）+ `hunting.test.ts`；INV-11 矩阵随登记自动扩格（工具全集 29→32，父票面=注册表单一来源 10 件，3×31=93 格全 403 scope_insufficient）。
- 菜单对账（验收⑤）：`hunt-pack.test.ts`——三族菜单 ⊆ manifest 全集；register 不入任何 planner 组合菜单且在父票面；planRound 实测输出含 register → offmenu_tool DENIED 零重试。未登记 fail-closed 同 78 范式由 `hunt-pack.test`/`weknora.test` 的分级断言覆盖（register L1 无票 403 no_ticket，L0 两件免验）。
- 偏差备案：①T22 测试落 `workers/investigation/`（m5 领地，stub 与实现同处；"m2"侧为纯数据 store 形态无独立服务内文件——跨服务 import 禁令 R1 下 agent 无法引 case-backend 源码，spec 标识行改路径时按此落）。②register 的验票闸走**工具面**（hunt_task 执行体内 makeGatedCall，L1 无票 403、越票面 403、写动作到不了 store）；循环缝面（converge 调 seam 无票可验）由 seam 实现内五要素审计+proposed-only 承担——L0 裁定②"gated 在 seam 实现内完成"的两面落法，票 83 对接真 weknora 时可整体换 HTTP 实现不换调用方。③`pnpm lint` 基线本就 3 处既有 error（orchestration/judge.test.ts、prompt-guard.test.ts、case-backend/app.ts——本票未触，票面外未清）；本票新增文件 lint 零 error。

- **L0 验收（主窗口，2026-09-13）**：亲跑双闸 PASS + agent 673|3skip 全绿 + 零触 m14 复核（git status 含 orchestration/ 条目数=0）；spec T22 测试标识行按裁定③同步（orchestration/graph-stub.test.ts → workers/investigation/weknora.test.ts，spec gate 复跑 PASS）。偏差①（T22 落位）即裁定③兑现；偏差②（register 验票两面落法：工具面 makeGatedCall 真闸 + 循环缝面审计+proposed-only）**接受**——工具面有票才是真闸，缝面无票可验是结构事实，审计兜底合规。偏差③既有 lint 挂账阶段 E。收尾五样齐（模板落点 fixtures/hunt-templates/ 为内容数据层，R10 例外条款覆盖）。