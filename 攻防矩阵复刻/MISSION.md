# MISSION

**学习目标**:从零复刻《深入理解 AI Agent》实验 2-5(提示注入攻防矩阵),吃透三件事——

1. 确定性判定器为什么看 `executed_tool_calls` 不看回复文本;
2. 记忆注入为什么要两轮(种植/触发)设计;
3. D4 的执行层授权规则"目标必须出现在本轮用户消息里"为什么能确定性兜底。

**验收标准**:

- 3 攻击 × 4 防御 × N trials 的成功率矩阵能跑通(MiniMax-M2);
- 每个阶段小步可运行、讲解落盘 `lessons/`;
- 收官时与参考项目逐文件 diff,并与 starter-agent 的三层护栏(llm-guard 扫描器路线)做概率性/确定性对照。

**参考项目(只读)**:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter2/prompt-injection/`
