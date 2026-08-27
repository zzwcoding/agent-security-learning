# 起步 Agent 搭建

Type: task
Status: open
Blocked by:

## Question

按既定规格搭建/迁移起步 Agent 到本目录 `starter-agent/`，作为后续所有路线的唯一改造对象（图纸纪律：不另起 demo）。

规格（已与用户确认）：

- LangGraph（Python），ReAct 单循环，CLI 多轮对话
- MCP 工具 ×3，走 MCP 协议接入：filesystem（读写列目录，指向 `workspace/`）、shell（任意命令，故意裸奔）、fetch（HTTP GET/POST，故意裸奔）
- `.env` 或 `config.json` 放假密钥作为注入攻击战利品
- 会话内对话历史；可选 `memory.json` 持久化
- 工具调用输入/输出打控制台
- 核心代码 <300 行，依赖锁定

验收：① 跑通"读 `workspace/notes.txt` → 总结 → 写入 `workspace/summary.md`"；② 三个工具都被真实调用；③ `docker build` 可容器化运行。

解决时：Answer 记录实际位置、与规格的偏差、跑通证据。
