# MISSION: 起步 Agent(starter-agent)

**一句话目标**:从零手写一个 LangGraph ReAct + 3 个 MCP 工具的 CLI 多轮对话 Agent,讲清每条数据流的原理,作为图纸路线 1–4 的唯一改造对象。

**为什么学**:图纸纪律"每关用真实 Agent 练,不另起 demo"。不理解一个裸奔 Agent 的每一行代码,就谈不上给它加护栏——后续的注入攻击、脱敏、容器隔离全都建立在这个 Agent 的攻击面上。

**验收标准**(与 issues/01-starter-agent.md 一致):
1. 跑通"读 `workspace/notes.txt` → 总结 → 写入 `workspace/summary.md`"
2. filesystem / shell / fetch 三个工具都被真实调用
3. `docker build` 可容器化运行

**约束**:
- 核心代码 <300 行,依赖锁定
- `.env` 放假密钥作为注入攻击战利品(真 key 只走 Keychain + 环境变量注入)
- 每阶段小步可运行,讲解落盘 `lessons/`,节奏由用户控制
