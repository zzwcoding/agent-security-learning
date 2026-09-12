# 71-orchestration-loop-architecture: 编排循环架构层——m14 卡 + 边界规则 + 架构图 v5（P0）

**What to build:** sdd-flow 变更路由第 ③ 步（阶段 2 补卡）。① `specs/modules.md` 新增 **m14 编排循环卡**：职责一句话（假设进、轮次机器跑、结论出）；公开接口按通用形定——`run_hypothesis(template_id, hypothesis, menu_subset)`，狩猎/应急取证是调用方不是卡的内容；seam（LLM adapter/子 run 簿记/票务口）与测试计划逐条填。② `## 边界规则` 节加三条：a) m14 循环卡**不含任何业务分支**（出现 if hunting/if ir 即违界，边界闸可查的表述）；b) 子 run 票 scope 严格 ⊆ 父 run 菜单（INV-3 延伸）；c) 循环卡不持 L2 通道（沿用 M9-S6 口径）。③ 能力菜单一次摆全：按票 70 工具位清单把五业务所需工具维度在 tools.manifest 登记面留位（含 weknora 三工具 playbook_lookup/graph_query/hypothesis_register 的 Memory stub 位）。④ 架构图 v5：增补编排循环子图（planner→fanout→judge→gap 回路 + 父子 run 关系 + 票务两票流向），**图过审当场记 ADR 0005**。⑤ `## 页面映射` 节补狩猎入口页/轮次视图行，逐行追到 m14 公开接口，追不到当场补卡。

**铁律:** 架构图用户逐节点过完才算过审（guided-review 纪律），没有过审记录 = 没有过审；过审前禁编码；循环拓扑落 dispatcher 层不动 compileFlowGraph 的串行链模型（这条进卡的设计约束节）。

**Touches modules:** `m14`（新）、`m3`、`m9`

**Belongs to spec:** specs/modules.md（m14 卡 + 边界规则 + 页面映射）；docs/adr/0005-编排循环架构过审.md

**Blocked by:** 70 ✅（2026-09-12 收口）

**Status:** done

**验收：**
- [x] m14 卡四要素齐全（职责/公开接口/seam/测试计划），接口无业务名词
- [x] 边界规则三条落「## 边界规则」节，例外列空表也落
- [x] 能力菜单工具位清单与票 70 产物逐条对账无遗漏（13.4b 五业务子集 ↔ 卡面模板契约）
- [x] 架构图 v5 增补完成且**用户过审，ADR 0005 落盘**（2026-09-12 用户拍板：源 JSON 即收敛形态，HTML 渲染砍掉）
- [x] 页面映射新增行逐行可追到 m14 公开接口
- [x] `tools/check_boundary.py` 对新边界条消费正常（机制先于内容；R10-R12 三新检查器，自测 22/22）

**实现记录：**（2026-09-12 收口）m14 正式卡落 specs/modules.md（接口五件/依赖/seam 四件/备注三约束）；边界规则加 R10（机制层禁业务分支，内容型检查器，模板格式类型单文件例外）/R11（铸票唯一通道，INV-11 静态半边）/R12（审批内部禁触，M9-S6 沿用）；闸扩到 12 检查器（self-test 22/22，红样本必抓/豁免必绿/基线全绿/两向锁全验）；页面映射节六行（两条新查询面标票 73）；架构 v5 源 JSON（26 组件/31 连接/4 卡片，m14-loop+loopback+weknora 外部件）——**用户两次中断后拍板：不渲染 HTML、源 JSON 冻结**，ADR 0005 记录此裁决；弹窗 notes 随 HTML 一并砍。双闸绿：spec gate PASS、boundary PASS（12/12）。偏差：无（HTML 砍记 ADR 属用户裁决非偏差）。
