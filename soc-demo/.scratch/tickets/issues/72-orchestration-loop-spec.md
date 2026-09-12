# 72-orchestration-loop-spec: 编排循环功能规格定稿（P0）

**What to build:** sdd-flow 变更路由第 ④ 步（阶段 3）。产出 `specs/orchestration-loop.md`，章节按 module-spec-format 模板：① planner/judge/gap_analyzer 三 LLM 节点的输入输出 schema（prompt 契约：菜单格式、证据充分性判据、缺口描述格式）+ fake/real 双 adapter 要求；② 轮次循环语义——C_{k+1} 依赖 C_k 证据的形式化表述、max_rounds、同组合指纹防提升到轮次级；③ 两票方案（父票 planner 面 + 子 run 按任务 narrow-scope 票，还 `run-kinds.ts:150` 欠账）；④ 预算双闸（run 级 + 轮次级）；⑤ 跨 run 等待机制（子 run 终态事件唤醒父 run，**禁轮询**，复用事件总线原语）；⑥ 触及的模块表（m14/m3/m9/m5/m2）+ 接口变化逐条；⑦ **验收测试表：每条验收标准对应一个可执行测试**；⑧ 架构杀手锏验收条：**应急取证业务落地 = 零 m14 代码增量，只允许新增模板文件 + 菜单配置**（git diff 断言不触 m14 目录）。INV-3/INV-8 引用不复述。

**铁律:** 每条验收标准必须对应可执行测试，做不到的不许写成验收；spec 涉及 LLM 输出全走 schema 校验 + 失败降级路径（现有 uncertain 先例）；`python3 tools/check_specs.py` 机器校验先于 L0 人审。

**Touches modules:** `m14`、`m3`、`m9`、`m5`、`m2`

**Belongs to spec:** specs/orchestration-loop.md（本票即其定稿票）

**Blocked by:** 71 ✅（2026-09-12 收口）

**Status:** ready

**验收：**
- [ ] spec 章节齐全，验收测试表逐条可执行（每条注明测试名/位置）
- [ ] "应急取证零 m14 增量"写进验收测试表且有对应断言设计
- [ ] 两票方案票务时序图（铸票→核验→焚毁）与 m9 卡对账无冲突
- [ ] `tools/check_specs.py` 通过
- [ ] L0 人审定稿，spec 状态翻「已定稿」；73-83 各票验收条目至此绑定本 spec 行号（回填各票）

**实现记录：**（待填）
