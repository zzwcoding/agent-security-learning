# 起步 Agent 搭建

Type: task
Status: resolved
Blocked by:

## Answer(2026-08-27)

**实际位置**:`.scratch/agent-security-learning/starter-agent/`(`agent.py` + `config.py` + `mcp_servers/`×3 + `workspace/` + `Dockerfile`),核心代码 244 行 < 300。

**与规格的偏差**:
- LLM 供应商:Keychain 中 `kimi` 是 OAuth token 不能当 API key 用,实测选定 MiniMax-M2(OpenAI 兼容端点),经 `scripts/run-with-keychain.sh` 注入
- fetch server 未用官方实现(官方只支持 GET,规格要 GET+POST),三个 MCP server 全部手写、同一 FastMCP 模式
- `create_agent` 取 langchain 1.x 新位置(`langgraph.prebuilt.create_react_agent` 已弃用),底层仍是 LangGraph ReAct 图
- 依赖锁定两档:`requirements.txt`(直接依赖)+ `requirements-lock.txt`(63 包全量,Docker 用)

**跑通证据**:
- 验收①:本地与容器内均跑通"读 notes.txt → 总结三点 → 写 summary.md",summary.md 经挂卷宿主可见
- 验收②:一句话触发 `list_dir`/`run_command`/`http_get` 三工具真实调用,`http_post` 经 httpbin.org 回显验证
- 验收③:`docker build -t starter-agent .` 成功,容器内跑通上述流程
- 分阶段教学记录见 `issues/01-starter-agent/lessons/0001–0008`,过程证据见 `learning-records/`

---

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
