# 0001: 起步 Agent 开工与阶段规划

**日期**:2026-08-27

**做了什么**:读透 issues/01-starter-agent.md 规格;核实依赖生态现状(langchain-mcp-adapters 标准链路、mcp 2.0 API 变动坑、官方 fetch server 只支持 GET);核实本机环境(uv/docker/node 齐,Keychain 登记 kimi/minimax)。建立 MISSION/RESOURCES/NOTES,规划 8 个阶段。

**关键决策**:
- 三个 MCP server 全部自己手写(filesystem/shell/fetch 同一 FastMCP 模式复用三次)——官方 fetch 只支持 GET,且手写才能完全讲清攻击面
- LLM 走 OpenAI 兼容接口 + 环境变量注入,供应商在 kimi/minimax 间实测选定
- 阶段划分:骨架→LLM→MCP 链路→ReAct→补齐工具→历史+战利品→持久化→Docker

**卡在哪**:暂无。

**结论**:路线待用户确认后开跑阶段 1。
