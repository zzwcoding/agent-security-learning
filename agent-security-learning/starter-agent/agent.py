"""起步 Agent —— CLI 入口。

当前阶段(3):接入第一个 MCP server(filesystem),但不经过 LLM——
用 /tools 和 /call 调试命令手动握手、手动调工具,先把 MCP 协议链路摸透。
"""
import asyncio
import json
import sys

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, WORKSPACE_DIR

BANNER = "✅ 阶段 3 跑通:MCP 手动调通(/tools 列工具,/call <工具> <JSON参数> 调用,/quit 退出)"

SYSTEM_PROMPT = "你是一个简洁的中文助手。"

# MCP server 的启动参数:agent 作为客户端,用这个配置把 server 拉成子进程
FILESYSTEM_SERVER = StdioServerParameters(
    command=sys.executable, args=["mcp_servers/filesystem_server.py"]
)


async def with_mcp(fn):
    """连上 filesystem server,把握过手的 session 交给 fn 用,用完关掉连接。"""
    async with stdio_client(FILESYSTEM_SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()  # MCP 握手:交换协议版本与双方能力
            return await fn(session)


def main() -> None:
    if not (LLM_BASE_URL and LLM_API_KEY and LLM_MODEL):
        raise SystemExit("缺少 LLM_* 环境变量:请用 scripts/run-with-keychain.sh 启动")
    WORKSPACE_DIR.mkdir(exist_ok=True)
    llm = ChatOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)
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
            # 问 server:你有哪些工具?返回的 schema 就是将来给模型看的工具清单
            tools = asyncio.run(with_mcp(lambda s: s.list_tools()))
            for t in tools.tools:
                print(f"  {t.name}{t.inputSchema.get('required', '')} — {t.description}")
        elif user_input.startswith("/call "):
            # 绕过 LLM 直接调工具:/call write_file {"path":"a.txt","content":"hi"}
            name, _, raw = user_input[6:].partition(" ")
            result = asyncio.run(with_mcp(lambda s: s.call_tool(name, json.loads(raw or "{}"))))
            print(f"工具 > {result.content[0].text}")
        else:
            reply = llm.invoke([SystemMessage(SYSTEM_PROMPT), HumanMessage(user_input)])
            print(f"Agent > {reply.content}")


if __name__ == "__main__":
    main()
