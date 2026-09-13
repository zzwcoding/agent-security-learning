# 90-runs-hypothesis-id-column: runs 表 hypothesis_id 正名——case_id 位承载清偿（体检候选①）（P3）

**What to build:** 票 73 受控接受的"hypothsis_id 经 runs.case_id 位承载"正名（交接包阶段 E 候选清单①）。① m3 runs 表加可空 `hypothesis_id` 列（migrate 补列，存量行零影响）；② `POST /internal/runs` payload 接受可选 `hypothesis_id`；hunt_flow/hunt_task 的 intake 校验改要求 hypothesis_id（不再吃 case_id 位）；③ orchestration/launcher 与 ports 的 RunDoor payload 同步改发 hypothesis_id（case_id 不再超载）；④ autorun 两分支与 round_relay 拉起链路同步；⑤ specs/modules.md m14 卡"拉起实体承载"备注行改写（正名完成）+ m3 卡如涉及则同步。hunt_run_links 簿记与既有 kind（alert/case/knowledge/chat/close）的 case_id 语义零变化。

**铁律:** 纯正名无行为变更——所有既有测试语义保持（hunt 行为断言不动，只改承载字段）；m2 状态机/端点零改动；INV 零变化。

**Touches modules:** `m3`、`m14`

**Belongs to spec:** specs/modules.md（m14 卡备注承载行正名）

**Blocked by:** 无

**Status:** done

**验收：**
- [x] hunt run 行 hypothesis_id 专用列在位、case_id 为空（正名完成，簿记/审计/轮次归集读面口径不变）——证据：`app.test.ts` 正名测试（真门 POST → 行三列 `{kind, hypothesis_id, case_id:null}`）+ `autorun-hunt.test.ts` T01 生产路径断言（`run.hypothesis_id === hypId` 且 `run.case_id` 为空，真 m2 子进程全环）
- [x] 旧 kind 与既有测试零回归（全量绿只增不减；语义断言零改动）——全量 `pnpm test` 六 workspace 全绿（evals 33 场景+108、mcp-audit 14、agent 700 passed|3 skip 既有、case-backend 76、ingest 44|1 skip 既有、web 134）；旧 kind 行为断言逐字未动，只改的读的字段
- [x] modules.md m14 卡承载备注行同步正名——「拉起实体承载」行改写为票 90 正名收口（专用列在位、case_id 位承载清偿、交接信封键位口径注明）

**实现记录：**（2026-09-13，L2 编码窗）

- **① runs 表加列（migrate 照票 73 `cases.hypothesis_id` 先例形态）**：`db.ts` DDL runs 表加 `hypothesis_id TEXT`（可空，旧 kind 恒 NULL）+ `migrate()` 查缺补列 `ALTER TABLE runs ADD COLUMN hypothesis_id TEXT`（存量行零影响）；`runs.ts` RunRow/mapRun/createRun 同步（createRun 入参 `hypothesisId`、INSERT 带列、审计 details 加性带 hypothesisId）。
- **② intake 正名（注册表单一来源，票 44 口径不吃手抄特判）**：`run-kinds.ts` RunKindDescriptor.intake 枚举扩 `"hypothesis"`，hunt_flow/hunt_task 两描述符改 `intake: "hypothesis"`（注释同步正名）；`app.ts` /internal/runs 校验三分支：hypothesis 缺 → 400 `hypothesis_id_required`（与既有 intake 400 口径一致；只带 case_id 也拒——承载位清偿），case/alert 分支逐字节不动；payload 接受可选 `hypothesis_id`；createRun 按 intake 三向落列（hunt 行 case_id 恒空）。
- **③ door wire 正名（机制目录仅此两件，票面授权面）**：`ports.ts` RunDoor payload `{ kind, hypothesis_id?, task? }`（不再超载 case_id）；`launcher.ts` launchRound/launchTask 两处 door.post 发 `hypothesis_id`。relay.ts 零改动（launchRound seam 本就吃 hypothesisId）。
- **④ autorun 传参同步**：`autorun.ts` LaunchReq 加 `hypothesisId?`、hypothesis.created 分支传 `{kind:"hunt_flow", hypothesisId}`；`runsLookup` 防重查询加 `OR hypothesis_id = ?`（hunt 防重读专用列，旧 kind 两列语义零变化——其 hypothesis_id 恒 NULL 不误命中）；`index.ts` launch 回调读 `req.hypothesisId`（④ 传参链的生产半边，见偏差①）。
- **交接信封（行为零变化的关键）**：机制目录 flow.ts/hunt-executor.ts 读 `state.case_id` 作 hunt 拉起实体/取消板键（本票禁触，读面契约不动）——`graph.ts` executeRun 的「run 行 → 交接信封」派生（该职责既有唯一落点）补 hypothesis 支：`caseId` 空且 `hypothesisId` 在 → 信封 `{kind, case_id: run.hypothesisId}`，值源换专用列、键位不变，行为逐字节等价。
- **测试**（测试先行，红灯→绿灯）：`app.test.ts` intake 矩阵增 3 行（hunt_flow/hunt_task 缺 hypothesis_id、只带 case_id 也拒）+ 新增正名测试（真门 POST → 行三列断言）；`autorun-hunt.test.ts` huntRuns 寻址键改 hypothesis_id 列 + T01 增 `hypothesis_id` 在位/`case_id` 为空断言（生产路径）；`run-kinds.test.ts` intake 口径断言改 hunt=hypothesis（承载字段本身即票面正名对象）+ runRow 夹具加性补字段；机制 rig 门/夹具随 RunDoor 契约同步（flow/loop/planner/judge/budget 五处：door 签名 hypothesis_id + createRun 夹具 hypothesisId——断言语句零改动）；`ticketing-rig.ts` verifyAllows 不再钉 `caseId: HYP`（布景侧借位承载残留，正名后 hunt 票不绑案件、验票只咬工具 scope+run 绑定）。
- **specs/modules.md**：m14 卡「拉起实体承载」行改写为票 90 正名收口；m3 卡不涉及（kind 清单从未列 hunt、intake 细节注 cites 注册表单一来源）。
- **测试与闸**：全量 `pnpm test` 六 workspace 全绿：evals 33/33 场景 + 108、mcp-audit 14、agent 700 passed|3 skip（既有 skip）、case-backend 76、ingest 44|1 skip（既有）、web 134——只增不减（app.test +4，其余同数全过）；typecheck 全 workspace 绿；`pnpm lint` 0 error。双闸：check_specs PASS(0 警告)、check_boundary PASS(0 越界) + self-test 22/22。
- **偏差备案**：①`index.ts` launch 回调一行（`req.caseId`→`req.hypothesisId`）——④「autorun 两 hunt 分支传参」生产装配半边，不改则 LaunchReq 正名后生产拉起空 hypothesis，属传参链必要延伸。②`graph.ts` executeRun 派生补 hypothesis 支——不在票面六项清单内，但它是「交接信封按 run 行拼齐」的唯一既有责任点（runs 行读面 = ①的自然延伸），且是机制目录 flow.ts/hunt-executor.ts 禁触前提下唯一不改行为的落点（备选：app.ts executeStartJob 注入 initialState + 机制测试 12+ 处 executeRun 调用点补 initialState——机制目录 diff 反而放大，弃）。③`run-kinds.ts` intake 枚举扩 `"hypothesis"`——②「intake 校验」的注册表面（票 44 单一来源口径，手抄 kind 特判被票 44 明确废弃）；随之 `run-kinds.test.ts` 两处断言换正名值。④零增量闸对本票 diff 报红 6 文件（ports.ts/launcher.ts + 机制 rig 测试 flow/loop/planner/judge.test.ts）——**L0 预批范围内**：ports/launcher 是本票③授权面，四个 rig 测试是⑤相关测试文件随 RunDoor 契约的必要同步（门签名不改则 typecheck 炸）；机制业务件（flow/task-flow/planner/judge/dispatch/relay/cancel/ledger）零触碰，hunt_run_links 簿记零改动，m2/case-backend 零改动。

- **L0 验收（主窗口，2026-09-13）**：双闸 PASS + agent 700|3skip 全绿（行为断言零改动只换读字段）；零增量闸红=预批授权面（ports/launcher+4 rig 测试随 RunDoor 契约同步，机制票不适用内容层闸）；偏差①②③④均预批/接受；**flow.ts:76 过期注释由 L0 亲手清偿**（本票唯一挂账销账）。收尾五样齐。