# 路线 1 守门员落地化方案

Type: grilling
Status: open
Blocked by: 01

## Question

图纸路线 1 的四步（① 亲手注入攻击自己的 Agent → ② 引入 llm-guard 三个扫描器 + 精读 NeMo Guardrails 分层拦截思想 → ③ 自写 Docker 沙盒参数 + 精读 codex 三档沙盒 → ④ 引入 Langfuse）如何具体落在起步 Agent 上：

- 每步改动起步 Agent 的哪个组件
- 精读素材选练兵场的哪个实验（候选：chapter2/prompt-injection 攻防矩阵、chapter4/execution-tools 分层安全架构）
- 本关交付物的具体形态（攻防复盘文档的骨架）
- "攻击自己"验收的具体 payload 与通过标准
