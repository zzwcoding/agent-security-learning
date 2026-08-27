# RESOURCES: 起步 Agent 信源清单

## 知识(官方文档 / 源码)

- LangGraph `create_react_agent`(prebuilt):https://langchain-ai.github.io/langgraph/reference/prebuilt/
- langchain-mcp-adapters(`MultiServerMCPClient`,MCP↔LangChain 工具桥):https://github.com/langchain-ai/langchain-mcp-adapters
- MCP Python SDK(server/client):https://github.com/modelcontextprotocol/python-sdk
- MCP 协议规范:https://modelcontextprotocol.io
- OpenAI 兼容接口(Chat Completions):各供应商平台文档
  - MiniMax:https://platform.minimaxi.com/docs
  - Moonshot/Kimi:https://platform.moonshot.cn/docs

## 已核实的关键事实(2026-08)

- `langchain-mcp-adapters` 标准用法:`MultiServerMCPClient({...})` → `await client.get_tools()` → 喂给 `create_react_agent`(来源:LangChain 论坛、官方集成示例,多处一致)
- **坑预警**:`mcp` 包 2.0.0(2026-07-28 发布)改了 in-SDK FastMCP 的 API;另有独立 `fastmcp` 包同名不同物。阶段 3 动手前必须先核实实际装到的版本和导入路径,讲解以实际安装版本为准
- 官方 fetch MCP server 只支持 GET;规格要求 GET+POST → fetch server 自己手写
- 本机环境:uv、docker、node 可用;`agent-key list` 已登记 `kimi`、`minimax` 两家(均有 OpenAI 兼容端点,均支持 tool calling)

## 智慧(社区 / 实践者)

- MCP 教程生态混乱的两个 FastMCP 辨析:https://mcpcat.io/guides/building-mcp-server-python-fastmcp/
