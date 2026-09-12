# ADR 0005：架构图 v5 增补——假设驱动编排循环（m14）过审记录

- 状态：已接受（2026-09-12，票 71 收口；阶段 2 补卡的过审记录，guided-review 纪律落盘）
- 背景：票 70 需求定稿（PRD v1.2 §13，假设驱动编排循环：planner→扇出→judge→gap 轮次机器 + 五业务复用规划）后，票 71 走阶段 2 补卡：m14 卡、边界规则、页面映射、架构图增补。

## 过审内容与用户拍板

1. **m14 卡定稿**（specs/modules.md）：公开接口五件——`POST /internal/runs {kind:"hunt_flow"}`、`run_hypothesis(template_id, hypothesis_text, actor)`、模板格式契约（template_id+句式族+菜单子集+轮次数字改写）、子 run 契约（kind=hunt_task 经 m3 标准机器）、假设 CRUD 归 m2 卡面。拓扑约束落卡备注：循环性在 dispatcher 层（outbox 拉 round k+1），compileFlowGraph 串行链模型禁改。
2. **边界规则新增三条**（R10/R11/R12，12/12 检查器两向锁，自测 22/22）：R10 m14 机制目录禁业务分支（内容型检查器，模板格式类型单文件例外）；R11 铸票唯一通道（worker/m14 禁 import 铸票客户端，INV-11 静态半边）；R12 worker/m14 禁 import 审批内部（M9-S6 沿用，L2 只经 m3 executeApproved 正门）。
3. **页面映射节新增**（六行）：狩猎页数据需求逐条追到接口；两条"新查询面"（假设 CRUD 读面 + 轮次归集段）标给票 73；"需要新采集"为零。
4. **架构图 v5**：源文件 `docs/architecture-v5.architecture.json`（26 组件 / 31 连接 / 4 卡片，含 m14-loop、planner、judge、gap、weknora 外部件与 loopback 回边）。
5. **用户拍板砍 HTML 渲染**（2026-09-12，两次中断后明确）：v5 **不生成/不注入 HTML**，`architecture-v5.architecture.json` 即图的最终收敛形态，冻结不再改；弹窗 notes（arch-notes.json 增补）随 HTML 一并砍掉。导览验收改为对本 ADR + 源 JSON 走查。**遗留：若将来教学/汇报需要可交互图，重开一票从冻结源重渲染（inject 脚本与 archify 链仍在），不算本票欠账。**

## 后果

- 好：机制/内容分层从 PRD 口号落成三张可执行闸门（R10 内容型检查 + 票 80 diff 断言 + spec 零增量验收条）；INV-11 有静态+遍历双半边。
- 代价：图的可交互性暂缺（源 JSON 可读但无弹窗）；票 82（Web 页）不受此影响（页面映射节是接口契约，非图）。
- 拆票衔接：72（spec 定稿，含预算按 kind 分档数字与两票时序图）已 ready；73 起实现票仍 blocked 到 bench 收尾链。

## 遗留问题

- 预算档位具体数字（单轮 2 任务/20 轮已定，run 级/轮级 token 与步数档位未定）——票 72 定，定稿后回测压测四天花板。
- hypothesis_register 的 L1 票面与人审口径细节——票 72 spec 定。
