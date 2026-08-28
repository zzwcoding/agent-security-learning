# RESOURCES —— 信源清单

## 知识(官方/源码)

- 参考项目源码:`/Users/divh/Downloads/深入理解agent 实验/ai-agent-book/chapter2/prompt-injection/`
  - `README.md` —— 实验目的、三类攻击、四层防御、真实矩阵结果、弱基线模型的理由
  - `attacks.py`(129 行)—— Attack dataclass + 确定性判定器
  - `agent.py`(411 行)—— DefenseConfig D1–D4、execute_tool 的 D4 校验(268-277)、隔离工作区(280-307)
  - `demo.py`(323 行)—— 3×4×N 矩阵跑批 + CLI
- OpenAI Python SDK(tool calling / chat.completions):https://platform.openai.com/docs/api-reference/chat

## 智慧(社区/自己的实践)

- 我的精读笔记:`.scratch/agent-security-learning/issues/07-route1-execution/lessons/0016-精读chapter2攻防矩阵.md`
- starter-agent(三层护栏,llm-guard 路线):`.scratch/agent-security-learning/starter-agent/` —— 收官对照对象
- key 约定:`agent-key minimax` 从 Keychain 取;base_url `https://api.minimaxi.com/v1`,模型 `MiniMax-M2`(偏强,可能抹平矩阵对比——观察点不是 bug)
