# MISSION — 实验 4-4 复刻:带 LLM 事前审批的执行工具

## 学习目标(为什么学)

理解"模型式执行闸":在工具内部用【确定性规则先筛 + 独立 LLM 事前审批】的两段式拦截,
把安全决策嵌入执行链路本身,而不是依赖 agent 外置护栏。

区别于:
- starter-agent(裸奔工具,攻击面教具)
- 攻防矩阵实验 D4 的"目标须在本轮用户消息"**规则式**校验——本实验是**模型式**裁决

## 验收标准

1. ~~`python cli.py demo` 离线端到端跑通~~(用户决定跳过阶段 10;改为:每道闸经 cli 子命令
   单独实跑验证,证据见 learning-records/0002-0009)
2. 同一攻击提示:裸奔 starter-agent 上执行成功 → 换入带闸工具后被二级 LLM 拦下(前后对比截图/日志)
3. 产出对照分析文档:模型式闸 vs 规则式闸(vs D4)的取舍;挂回 starter-agent 能补上路线 1 的哪些缺口

## 参考项目(只读)

`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter4/execution-tools/`

## 节奏

用户说"下一步"推进,"提交"才 commit。
