# 72-orchestration-loop-spec: 编排循环功能规格定稿（P0）

**What to build:** sdd-flow 变更路由第 ④ 步（阶段 3）。产出 `specs/orchestration-loop.md`，章节按 module-spec-format 模板：① planner/judge/gap_analyzer 三 LLM 节点的输入输出 schema（prompt 契约：菜单格式、证据充分性判据、缺口描述格式）+ fake/real 双 adapter 要求；② 轮次循环语义——C_{k+1} 依赖 C_k 证据的形式化表述、max_rounds、同组合指纹防提升到轮次级；③ 两票方案（父票 planner 面 + 子 run 按任务 narrow-scope 票，还 `run-kinds.ts:150` 欠账）；④ 预算双闸（run 级 + 轮次级）；⑤ 跨 run 等待机制（子 run 终态事件唤醒父 run，**禁轮询**，复用事件总线原语）；⑥ 触及的模块表（m14/m3/m9/m5/m2）+ 接口变化逐条；⑦ **验收测试表：每条验收标准对应一个可执行测试**；⑧ 架构杀手锏验收条：**应急取证业务落地 = 零 m14 代码增量，只允许新增模板文件 + 菜单配置**（git diff 断言不触 m14 目录）。INV-3/INV-8 引用不复述。

**铁律:** 每条验收标准必须对应可执行测试，做不到的不许写成验收；spec 涉及 LLM 输出全走 schema 校验 + 失败降级路径（现有 uncertain 先例）；`python3 tools/check_specs.py` 机器校验先于 L0 人审。

**Touches modules:** `m14`、`m3`、`m9`、`m5`、`m2`

**Belongs to spec:** specs/orchestration-loop.md（本票即其定稿票）

**Blocked by:** 71 ✅（2026-09-12 收口）

**Status:** done

**验收：**
- [x] spec 章节齐全，验收测试表逐条可执行（每条注明测试名/位置）
- [x] "应急取证零 m14 增量"写进验收测试表且有对应断言设计（T20 / tools/check_zero_increment.py）
- [x] 两票方案票务时序与 m9 卡对账无冲突（行为约定 6 + 接口定义票务节；父票 planner 只读面/子票单工具/TTL 900 同口径）
- [x] `tools/check_specs.py` 通过（0 警告——INV-1~11 全部有非草稿 spec 回指验收行，v1 存量警告随本 spec 一并关闭）
- [x] L0 人审定稿，spec 状态翻「已定稿」；73-83 各票验收条目至此绑定本 spec 行号（回填各票）

**实现记录：**（2026-09-12 收口）`specs/orchestration-loop.md` 定稿：目标/不做什么六条/触及模块五/接口定义（m2 假设实体五端点 + planner/judge/gap schema + 防转指纹 + 两票票面 + 预算三档数字）/行为约定 15 条/验收测试 23 行（T01-T23，每条绑测试标识）/依赖与风险三。预算档位收口（ADR 0005 遗留）：hunt_task 60s/20步/50k 沿用默认档；hunt_flow run 级 900s/200步/500k、轮级 120s/10步/30k、20 轮/单轮 2 任务/防转 1——env 可覆写，票 77 首跑回测压测四天花板。机检磨合两处：触及模块首列裸名（反引号会进解析值）、INV 引用须反引号形态（顺带给 v1 全部 11 条 INV 补了非草稿引用方，存量警告清零）。73-83 十一票已回填 Spec 绑定行（T 编号对照）。偏差：无。
