"""起步 Agent —— CLI 入口。

当前阶段(12):输入护栏——llm-guard PromptInjection 扫描器挂在用户输入进图之前,
带注入特征的文本直接拦下:不送进 ReAct 循环,也进不了记忆。
"""
import asyncio
import json
import sys

from langchain.agents import create_agent  # 原 langgraph.prebuilt.create_react_agent,v1.0 起迁居于此
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage, messages_from_dict, messages_to_dict
from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.checkpoint.memory import InMemorySaver
from llm_guard.input_scanners import PromptInjection  # 输入护栏:注入分类模型
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, MEMORY_FILE, WORKSPACE_DIR

BANNER = "✅ 阶段 12 跑通:输入护栏 llm-guard PromptInjection 上线(/quit 退出)"

SYSTEM_PROMPT = "你是一个简洁的中文助手。需要操作文件时,主动使用工具。"

# checkpointer 按 thread_id 区分会话;整个 CLI 用同一个线程 = 同一个连续对话
THREAD = {"configurable": {"thread_id": "cli-session"}}

# 同一个 filesystem server 的两种描述:StdioServerParameters 给阶段 3 的手动调试,
# 字典格式给 MultiServerMCPClient(多一个 transport 字段)
FILESYSTEM_SERVER = StdioServerParameters(
    command=sys.executable, args=["mcp_servers/filesystem_server.py"]
)
# 三个 MCP server 聚合进一张工具表;shell 与 fetch 故意裸奔(攻击面教具)
MCP_SERVERS = {
    name: {"command": sys.executable, "args": [f"mcp_servers/{name}_server.py"], "transport": "stdio"}
    for name in ("filesystem", "shell", "fetch")
}


async def with_mcp(fn):
    """连上 filesystem server,把握过手的 session 交给 fn 用,用完关掉连接。"""
    async with stdio_client(FILESYSTEM_SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await fn(session)


def build_agent(llm):
    """连上所有 MCP server,把工具清单交给 create_agent 组装成 ReAct 图。

    checkpointer:每步状态自动存档,同一 thread_id 下历史自动带上——
    模型"记得"之前聊了什么,靠的就是它。
    """
    client = MultiServerMCPClient(MCP_SERVERS)
    tools = asyncio.run(client.get_tools())  # 对每个 server:拉起子进程→握手→list_tools
    print(f"已加载 {len(tools)} 个 MCP 工具: {[t.name for t in tools]}")
    return create_agent(llm, tools, system_prompt=SYSTEM_PROMPT, checkpointer=InMemorySaver())


def _text(content) -> str:
    """消息 content 可能是字符串,也可能是 MCP 带回来的 content block 列表,统一成文本。"""
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content if isinstance(b, dict))


async def ask(agent, text: str) -> str:
    """跑一轮 ReAct 循环,沿途把每次工具调用的输入/输出打印出来。

    只发本轮新消息;历史由 checkpointer 按 THREAD 自动补进 messages。
    """
    answer = ""
    async for chunk in agent.astream({"messages": [HumanMessage(text)]}, config=THREAD, stream_mode="values"):
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


def load_memory(agent) -> None:
    """启动时:若 memory.json 存在且非空,把历史消息回灌进 checkpointer 的当前线程。

    空文件直接跳过——docker-run.sh 为了挂卷会 touch 出一个 0 字节的占位文件。
    """
    if MEMORY_FILE.exists() and MEMORY_FILE.stat().st_size:
        msgs = messages_from_dict(json.loads(MEMORY_FILE.read_text()))
        agent.update_state(THREAD, {"messages": msgs})  # 走 add_messages reducer 追加
        print(f"已从 memory.json 恢复 {len(msgs)} 条历史消息")


def save_memory(agent) -> None:
    """退出时:从 checkpointer 取出当前线程的全部消息,序列化成 JSON 落盘。"""
    msgs = agent.get_state(THREAD).values.get("messages", [])
    MEMORY_FILE.write_text(json.dumps(messages_to_dict(msgs), ensure_ascii=False, indent=2))
    print(f"对话已存入 memory.json({len(msgs)} 条)")


def main() -> None:
    if not (LLM_BASE_URL and LLM_API_KEY and LLM_MODEL):
        raise SystemExit("缺少 LLM_* 环境变量:请用 scripts/run-with-keychain.sh 启动")
    WORKSPACE_DIR.mkdir(exist_ok=True)
    llm = ChatOpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, model=LLM_MODEL)
    # 护栏模型与 LLM 相互独立:首次运行从 HuggingFace 下载 deberta 分类模型,
    # 加载一次全程复用;它在本机跑(Apple Silicon 上走 MPS),不消耗 LLM 额度
    print("正在加载输入护栏模型……")
    input_scanner = PromptInjection()
    agent = build_agent(llm)
    load_memory(agent)
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
            # 输入护栏:扫描器打回 (清洗后文本, 是否安全, 注入分数);不安全则拒答且
            # continue——这条输入不会进 ReAct 图,也不会被 checkpointer 写进记忆
            _, safe, score = input_scanner.scan(user_input)
            if not safe:
                print(f"🛡️ 输入护栏拦截:检测到提示注入(分数 {score})")
                continue
            print(f"Agent > {asyncio.run(ask(agent, user_input))}")
    save_memory(agent)


if __name__ == "__main__":
    main()
