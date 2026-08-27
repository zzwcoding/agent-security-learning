"""起步 Agent —— CLI 入口。

当前阶段(4):LangGraph ReAct 接管工具调用。自然语言不再直接问模型,
而是进入 ReAct 循环:模型自己决定调不调工具、调哪个、调几次。
阶段 3 的 /tools、/call 保留——可以对照:模型走的就是你手动走过的那条路。
"""
import asyncio
import json
import sys

from langchain.agents import create_agent  # 原 langgraph.prebuilt.create_react_agent,v1.0 起迁居于此
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, WORKSPACE_DIR

BANNER = "✅ 阶段 4 跑通:LangGraph ReAct 接管(自然语言直接使唤工具,/quit 退出)"

SYSTEM_PROMPT = "你是一个简洁的中文助手。需要操作文件时,主动使用工具。"

# 同一个 filesystem server 的两种描述:StdioServerParameters 给阶段 3 的手动调试,
# 字典格式给 MultiServerMCPClient(多一个 transport 字段)
FILESYSTEM_SERVER = StdioServerParameters(
    command=sys.executable, args=["mcp_servers/filesystem_server.py"]
)
MCP_SERVERS = {
    "filesystem": {
        "command": sys.executable,
        "args": ["mcp_servers/filesystem_server.py"],
        "transport": "stdio",
    }
}


async def with_mcp(fn):
    """连上 filesystem server,把握过手的 session 交给 fn 用,用完关掉连接。"""
    async with stdio_client(FILESYSTEM_SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(session)


def build_agent(llm):
    """连上所有 MCP server,把工具清单交给 create_agent 组装成 ReAct 图。"""
    client = MultiServerMCPClient(MCP_SERVERS)
    tools = asyncio.run(client.get_tools())  # 对每个 server:拉起子进程→握手→list_tools
    print(f"已加载 {len(tools)} 个 MCP 工具: {[t.name for t in tools]}")
    return create_agent(llm, tools)


def _text(content) -> str:
    """消息 content 可能是字符串,也可能是 MCP 带回来的 content block 列表,统一成文本。"""
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))


async def ask(agent, text: str) -> str:
    """跑一轮 ReAct 循环,沿途把每次工具调用的输入/输出打印出来。"""
    answer = ""
    async for chunk in agent.astream({"messages": [HumanMessage(text)]}, stream_mode="values"):
        msg = chunk["messages"][-1]  # 每一步只看最新冒出来的那条消息
        if isinstance(msg, AIMessage) and msg.tool_calls:
            # 模型决定调工具:name + args 就是它生成的 JSON,还没执行
            for tc in msg.tool_calls:
                print(f"工具调用 > {tc['name']}({json.dumps(tc['args'], ensure_ascii=False)})")
        elif isinstance(msg, ToolMessage):
            # 工具执行结果,这条会回喂给模型继续推理
            print(f"工具返回 > {_text(msg.content)[:200]}")
        elif isinstance(msg, AIMessage) and msg.content:
            answer = msg.content
    return answer


def main() -> None:
    if not (LLM_BASE_URL and LLM_API_KEY and LLM_MODEL):
        raise SystemExit("缺少 LLM_* 环境变量:请用 scripts/run-with-keychain.sh 启动")
    WORKSPACE_DIR.mkdir(exist_ok=True)
    llm = ChatOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)
    agent = build_agent(llm)
    print(BANNER)
    while True:
        try:
            user_input = input("你 > ").strip()
        except (EOFError, KeyboardInterrupt):  # Ctrl+D / Ctrl+C 都干净退出
            print("\n再见")
            break
        if user_input in ("/quit", "/exit"):
            break
        if not user_input:
            continue
        if user_input == "/tools":
            tools = asyncio.run(with_mcp(lambda s: s.list_tools()))
            for t in tools.tools:
                print(f"  {t.name}{t.inputSchema.get('required', '')} — {t.description}")
        elif user_input.startswith("/call "):
            name, _, raw = user_input[6:].partition(" ")
            result = asyncio.run(with_mcp(lambda s: s.call_tool(name, json.loads(raw or "{}"))))
            print(f"工具 > {result.content[0].text}")
        else:
            print(f"Agent > {asyncio.run(ask(agent, user_input))}")


if __name__ == "__main__":
    main()
